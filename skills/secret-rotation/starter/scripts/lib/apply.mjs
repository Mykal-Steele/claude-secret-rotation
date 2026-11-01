import { SECRETS } from '../secrets.manifest.mjs';
import { formatStamp } from './envfile.mjs';

const message = (error) => (error instanceof Error ? error.message : String(error));

// Pushes each value to GitHub, retrying with a growing delay. A failure on one key
// does not stop the others, the keys that still failed are returned.
async function pushToGithub(entries, { github, sleep }, tries) {
  const pending = [];
  for (const { key, value } of entries) {
    let lastError;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        await github.set(key, value);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (error?.permanent || attempt === tries) break;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    if (lastError) pending.push({ key, error: message(lastError) });
  }
  return pending;
}

// Applies changed secrets in an order that can be undone:
//   snapshot, externals, Azure, restart, health check, local files, GitHub.
// Externals are things outside the app platform that check a value and have to change
// first, such as a VM that holds a token. If anything before GitHub fails, everything
// done so far is put back. GitHub is last because a failure there cannot break the
// running site, so it is retried and reported instead of rolled back. All side effects
// go through `adapters`.
export async function applyRotation(allItems, adapters, options = {}) {
  const { azure, files, journal, shouldStop, onStep } = adapters;
  const githubTries = options.githubRetries ?? 3;
  const items = allItems.filter((item) => item.status === 'changed');
  if (!items.length) return { status: 'nothing', githubPending: [] };
  if (shouldStop?.()) return { status: 'aborted', githubPending: [] };

  const externals = (adapters.externals ?? []).filter((external) => external.applies(items));
  const usesAzure = items.some((item) => item.spec.azure);
  const restartNeeded = items.some((item) => item.spec.azure?.secret);
  const saved = items.map(({ key, old, value }) => ({ key, old, value }));
  const save = (phase, extra = {}) => journal.save({ phase, items: saved, ...extra });
  const step = (id, state, detail) => onStep?.({ id, state, detail });

  let azureSnapshot;
  let filesBackup;
  const externalSnapshots = {};
  step('snapshot', 'start');
  try {
    if (usesAzure) azureSnapshot = await azure.snapshot(items);
    filesBackup = await files.backup(items);
    for (const external of externals)
      externalSnapshots[external.id] = await external.snapshot(items);
    await save('snapshotted', {
      azure: azureSnapshot,
      files: filesBackup,
      externals: externalSnapshots,
    });
  } catch (error) {
    step('snapshot', 'fail', message(error));
    return { status: 'aborted', error: message(error), githubPending: [] };
  }
  step('snapshot', 'ok');

  const touchedExternals = [];
  let azureTouched = false;

  // Puts back only what was started, newest first: files, then Azure with a restart
  // and a health check, then the externals.
  async function rollBack(cause, { restoreFiles }) {
    step('rollback', 'start', message(cause));
    try {
      if (restoreFiles) await files.restore(filesBackup);
      if (azureTouched) {
        await azure.restore(azureSnapshot);
        if (restartNeeded) await azure.restart();
        await azure.waitHealthy();
      }
      for (const external of [...touchedExternals].reverse()) {
        await external.restore(externalSnapshots[external.id], items);
      }
      await save('rolled-back', { error: message(cause) });
      step('rollback', 'ok');
      return { status: 'rolled-back', error: message(cause), githubPending: [] };
    } catch (rollbackError) {
      const error = `${message(cause)}. Rolling back also failed: ${message(rollbackError)}`;
      await save('failed', { error }).catch(() => {});
      step('rollback', 'fail', message(rollbackError));
      return {
        status: 'failed',
        needsAttention: true,
        error,
        cause: message(cause),
        rollbackError: message(rollbackError),
        githubPending: [],
      };
    }
  }

  for (const external of externals) {
    step(external.id, 'start');
    touchedExternals.push(external);
    try {
      await external.apply(items, externalSnapshots[external.id]);
    } catch (error) {
      step(external.id, 'fail', message(error));
      return rollBack(error, { restoreFiles: false });
    }
    step(external.id, 'ok');
  }
  if (externals.length) await save('externals-applied');

  if (usesAzure) {
    step('azure', 'start');
    azureTouched = true;
    try {
      await azure.apply(items);
    } catch (error) {
      step('azure', 'fail', message(error));
      return rollBack(error, { restoreFiles: false });
    }
    step('azure', 'ok');
    await save('azure-applied');

    if (restartNeeded) {
      step('restart', 'start');
      try {
        await azure.restart();
      } catch (error) {
        step('restart', 'fail', message(error));
        return rollBack(error, { restoreFiles: false });
      }
      step('restart', 'ok');
    }

    step('health', 'start');
    try {
      await azure.waitHealthy();
    } catch (error) {
      step('health', 'fail', message(error));
      return rollBack(error, { restoreFiles: false });
    }
    step('health', 'ok');
  }

  const when = (adapters.now ?? (() => new Date()))();
  step('files', 'start');
  try {
    await files.write(items, { stamp: formatStamp(when) });
  } catch (error) {
    step('files', 'fail', message(error));
    return rollBack(error, { restoreFiles: true });
  }
  step('files', 'ok');
  await save('files-written');

  // Recording the time in Azure is bookkeeping, so a failure here is only a warning.
  if (usesAzure && azure.markRotated) {
    step('stamp', 'start');
    try {
      await azure.markRotated(items, when.toISOString());
      step('stamp', 'ok');
    } catch (error) {
      step('stamp', 'warn', message(error));
    }
  }

  let githubPending = [];
  const githubItems = items.filter((item) => item.spec.github);
  if (githubItems.length) {
    step('github', 'start');
    githubPending = await pushToGithub(githubItems, adapters, githubTries);
    step(
      'github',
      githubPending.length ? 'warn' : 'ok',
      githubPending.map((p) => p.key).join(', '),
    );
  }

  await save('done', { githubPending });
  return { status: 'done', githubPending };
}

// Puts back what a saved run changed: local files, Azure (with a restart and a
// health check), the externals and the old GitHub values. Used by `--rollback`.
export async function rollbackFromJournal(state, adapters, { secrets = SECRETS } = {}) {
  const { azure, files } = adapters;
  const items = state.items ?? [];
  const restartNeeded = items.some((item) => secrets[item.key]?.azure?.secret);
  if (!state.files && !state.azure && !state.externals) {
    return {
      status: 'failed',
      error: 'This saved run holds no old values, so there is nothing to restore.',
      githubPending: [],
    };
  }
  try {
    if (state.files) await files.restore(state.files);
    if (state.azure) {
      await azure.restore(state.azure);
      if (restartNeeded) await azure.restart();
      await azure.waitHealthy();
    }
    for (const [id, snapshot] of Object.entries(state.externals ?? {}).reverse()) {
      const external = (adapters.externals ?? []).find((candidate) => candidate.id === id);
      if (!external)
        throw new Error(`No adapter is configured for "${id}", so it cannot be restored.`);
      await external.restore(snapshot, items);
    }
  } catch (error) {
    return { status: 'failed', error: message(error), githubPending: [] };
  }
  const old = items.filter((item) => secrets[item.key]?.github && item.old !== undefined);
  const githubPending = await pushToGithub(
    old.map(({ key, old: value }) => ({ key, value })),
    adapters,
    3,
  );
  return { status: 'rolled-back', githubPending };
}
