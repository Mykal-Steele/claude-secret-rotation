import { SECRETS } from '../secrets.manifest.mjs';
import { CONFIG } from '../secrets.config.mjs';
import { rollbackFromJournal } from './apply.mjs';
import { createAzureAdapter, createGithubAdapter } from './cloud.mjs';
import { buildExternals } from './externals/index.mjs';
import { createFilesAdapter } from './files.mjs';
import { explainFailure } from './explain.mjs';
import { forgetBackups, listBackups, loadBackup } from './journal.mjs';
import { preflight } from './preflight.mjs';
import { verifyValues } from './verify.mjs';
import { confirm, line, print, printBox, spinner, style as c, symbols } from './tui.mjs';
import { Fatal, readCurrent, root, scrub, sleep, stateDir, track } from './session.mjs';

function latestBackup() {
  const entry = listBackups(stateDir).find((backup) => backup.phase !== 'unreadable');
  if (!entry) throw new Fatal(`No saved run found in ${stateDir}.`);
  return { entry, state: loadBackup(entry.file) };
}

// Sets each key on GitHub from the local files, which are the record of what is current.
async function pushKeys(keys) {
  const github = createGithubAdapter();
  let failed = 0;
  for (const key of keys) {
    const value = readCurrent(key);
    track(value);
    const spin = spinner(`Setting ${key} on GitHub`);
    try {
      if (!value) throw new Error(`${key} is empty in your local files`);
      await github.set(key, value);
      spin.succeed(`${key} set on GitHub`);
    } catch (error) {
      failed += 1;
      spin.fail(`${key}: ${scrub(error.message)}`);
    }
  }
  return failed ? 1 : 0;
}

export async function rollbackMode(args) {
  const { entry, state } = latestBackup();
  printBox({
    title: 'Roll back the last run',
    tone: 'yellow',
    lines: [
      `Run ${entry.id}, started ${entry.startedAt}, ended as "${entry.phase}".`,
      `Values: ${(state.items ?? []).map((item) => item.key).join(', ')}`,
      'This puts the local files, Azure, anything outside Azure that was changed, and GitHub back to the values from before that run.',
    ],
  });
  if (!args.yes && !(await confirm('Roll back now?', { defaultYes: false }))) return 0;
  await preflight();
  const spin = spinner('Putting the old values back and waiting for a healthy app');
  const result = await rollbackFromJournal(state, {
    azure: CONFIG.azure ? createAzureAdapter() : undefined,
    files: createFilesAdapter({ root }),
    github: createGithubAdapter(),
    externals: buildExternals(),
    sleep,
  });
  if (result.status === 'failed') {
    spin.fail('Rolling back failed');
    const { what, fix } = explainFailure(scrub(result.error));
    printBox({
      title: 'ATTENTION',
      tone: 'red',
      lines: [
        `${c.bold('What went wrong:')} ${what}`,
        `${c.bold('What to do:')} ${fix}`,
        c.gray(`The old values are in ${entry.file}`),
      ],
    });
    return 3;
  }
  spin.succeed('The old values are back');
  if (result.githubPending.length) {
    line(
      'warn',
      `GitHub still has the new value for: ${result.githubPending.map((p) => p.key).join(', ')}`,
    );
  }
  return 0;
}

export async function resumeMode() {
  const { state } = latestBackup();
  const pending = (state.githubPending ?? []).map((entry) => entry.key);
  if (!pending.length) {
    print(`\n  ${symbols.ok} Nothing is waiting for GitHub.`);
    return 0;
  }
  await preflight({ azure: false });
  return pushKeys(pending);
}

export async function syncGithubMode(args) {
  if (CONFIG.github === false) throw new Fatal('GitHub is switched off in secrets.config.mjs.');
  await preflight({ azure: false });
  const existing = await createGithubAdapter().list();
  const missing = Object.entries(SECRETS)
    .filter(([key, spec]) => spec.github && !existing.has(key) && readCurrent(key))
    .map(([key]) => key);
  if (!missing.length) {
    print(`\n  ${symbols.ok} GitHub already has every secret that exists locally.`);
    return 0;
  }
  line('info', `Missing on GitHub: ${missing.join(', ')}`);
  if (!args.yes && !(await confirm('Push them from the local files?', { defaultYes: true })))
    return 0;
  return pushKeys(missing);
}

// Tries the old values. One that still works has not been revoked.
export async function checkRevokedMode() {
  const { entry, state } = latestBackup();
  const old = Object.fromEntries(
    (state.items ?? [])
      .filter((item) => item.old !== undefined)
      .map((item) => [item.key, item.old]),
  );
  Object.values(old).forEach(track);
  if (!Object.keys(old).length)
    throw new Fatal('The last run did not keep any old values to test.');
  printBox({
    title: 'Are the old credentials dead?',
    tone: 'cyan',
    lines: [
      `Testing the old values from run ${entry.id}. Each one is only sent to its own provider.`,
      c.gray(
        'A credential that still works needs revoking. A database login that still works gets the same small read and write test.',
      ),
    ],
  });
  const spin = spinner('Trying the old values');
  const results = await verifyValues(old, (key) => old[key]);
  spin.stop();
  let alive = 0;
  let untested = 0;
  let revoked = 0;
  for (const result of results) {
    if (result.state === 'fail') {
      revoked += 1;
      line('ok', `${c.bold(result.title)}  ${c.gray('rejected, so it is revoked')}`);
    } else if (result.state === 'ok') {
      alive += 1;
      line('fail', `${c.bold(result.title)}  ${c.red('still works, revoke it')}`);
    } else if (result.state === 'skip') {
      line(
        'skip',
        `${c.bold(result.title)}  ${c.gray('no online check, it was a local value that is now replaced')}`,
      );
    } else {
      untested += 1;
      line('warn', `${c.bold(result.title)}  ${c.gray(result.detail)}`);
    }
  }
  if (alive) {
    printBox({
      title: `${alive} old credential(s) still work`,
      tone: 'red',
      lines: ['Revoke them at the provider, then run this again.'],
    });
    return 1;
  }
  if (untested) {
    printBox({
      title: 'Could not test everything',
      tone: 'yellow',
      lines: [`${untested} credential(s) could not be tested. Run this again when you are online.`],
    });
    return 1;
  }
  printBox({
    title: revoked
      ? `All ${revoked} tested credential(s) are revoked`
      : 'Nothing here can be tested online',
    tone: revoked ? 'green' : 'gray',
    lines: ['You can delete the saved old values now.'],
  });
  if (
    process.stdin.isTTY &&
    (await confirm('Delete the saved old values now?', { defaultYes: true }))
  ) {
    line('ok', `Deleted ${forgetBackups(stateDir)} saved run(s)`);
  }
  return 0;
}

export async function forgetMode(args) {
  const backups = listBackups(stateDir);
  if (!backups.length) {
    print(`\n  ${symbols.ok} No saved old values in ${stateDir}.`);
    return 0;
  }
  line(
    'warn',
    `${backups.length} saved run(s) hold the old values. After this you cannot roll back.`,
  );
  if (!args.yes && !(await confirm('Delete them?', { defaultYes: false }))) return 0;
  line('ok', `Deleted ${forgetBackups(stateDir)} saved run(s), overwritten first`);
  return 0;
}
