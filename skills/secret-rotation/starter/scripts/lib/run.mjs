import { CONFIG } from '../secrets.config.mjs';
import { applyRotation } from './apply.mjs';
import { collectChecks } from './checks.mjs';
import { copyToClipboard } from './clipboard.mjs';
import { createAzureAdapter, createGithubAdapter, defaultRun } from './cloud.mjs';
import { buildExternals } from './externals/index.mjs';
import { createFilesAdapter } from './files.mjs';
import { explainFailure } from './explain.mjs';
import { createJournal } from './journal.mjs';
import { revokeChecklist, secondaryCopyBlock } from './plan.mjs';
import { confirm, heading, line, print, printBox, spinner, style as c, symbols } from './tui.mjs';
import { root, sleep, stateDir } from './session.mjs';

const LABELS = {
  snapshot: 'Saving the old values in a private backup',
  azure: 'Updating the Azure secrets',
  restart: 'Restarting the app',
  health: 'Waiting for the app to be healthy',
  files: 'Writing the local env files',
  stamp: 'Recording the rotation time in Azure',
  github: 'Updating the GitHub secrets',
  rollback: 'Putting the old values back',
};

export async function runApply(items) {
  const journal = createJournal({ dir: stateDir });
  const externals = buildExternals();
  const labelOf = (id) =>
    LABELS[id] ?? externals.find((external) => external.id === id)?.label ?? id;
  let active;
  let interrupted = false;

  const onSigint = () => {
    if (interrupted) {
      print(
        `\n  ${symbols.fail} Forced exit. Run npm run secrets -- --rollback, then npm run secrets:check.`,
      );
      process.exit(130);
    }
    interrupted = true;
    print(
      `\n  ${symbols.warn} Finishing the run so nothing is left half changed. Press Ctrl-C again to force quit.`,
    );
  };
  process.on('SIGINT', onSigint);

  const onStep = ({ id, state, detail }) => {
    if (state === 'start') {
      active?.stop();
      if (id === 'rollback') line('warn', `Something failed: ${explainFailure(detail).what}`);
      active = spinner(labelOf(id));
      return;
    }
    const label = labelOf(id);
    if (state === 'ok') active?.succeed(label);
    else if (state === 'warn')
      active?.warn(id === 'github' ? `${label}: ${detail} not updated yet` : `${label}: ${detail}`);
    else active?.fail(`${label}: ${explainFailure(detail).what}`);
    active = undefined;
  };

  const azure = CONFIG.azure
    ? createAzureAdapter({
        onTick: (attempt, total, last) =>
          active?.update(`${LABELS.health} (try ${attempt} of ${total}, last answer ${last})`),
      })
    : undefined;
  try {
    const result = await applyRotation(items, {
      azure,
      files: createFilesAdapter({ root }),
      github: createGithubAdapter(),
      externals,
      journal,
      sleep,
      now: () => new Date(),
      shouldStop: () => interrupted,
      onStep,
    });
    return { result, journal, azure };
  } finally {
    active?.stop();
    process.removeListener('SIGINT', onSigint);
  }
}

// Only names what is actually checked, so a repository without Azure or GitHub is not
// told that they agree.
function checkedTargets() {
  return [
    CONFIG.azure && 'Azure',
    CONFIG.github !== false && 'GitHub',
    (CONFIG.azure || CONFIG.health.publicUrl) && 'the site',
  ].filter(Boolean);
}

const joinNames = (names) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];

async function finalCheck(azure) {
  const targets = checkedTargets();
  if (!targets.length) return [];
  const spin = spinner(`Final check of ${joinNames(targets)}`);
  const { rows } = await collectChecks({
    root,
    stateDir,
    azure: CONFIG.azure ? azure : null,
    github: CONFIG.github === false ? null : createGithubAdapter(),
    verifyMongo: async () => ({ state: 'skip', detail: 'Checked before the change.' }),
  });
  const problems = rows.filter(
    (row) => row.state !== 'ok' && ['azure', 'github', 'health'].includes(row.section),
  );
  if (!problems.length) spin.succeed(`${joinNames(targets)} all agree with the new values`);
  else spin.warn(`${problems.length} thing(s) to look at`);
  const backup = CONFIG.health.backupHeader;
  for (const row of problems) {
    line(row.state === 'fail' ? 'fail' : 'warn', `${c.bold(row.label)}  ${c.gray(row.detail)}`);
    if (backup?.note && backup.value && row.detail.includes(backup.value))
      print(c.gray(`    ${backup.note}`));
  }
  return problems;
}

async function yourTurn(items, journal, args) {
  const interactive = process.stdin.isTTY && !args.yes;
  heading('Your turn');

  const second = CONFIG.secondaryCopy;
  const block = second ? secondaryCopyBlock(items) : '';
  if (block) {
    const keys = block
      .trim()
      .split('\n')
      .map((entry) => entry.split('=')[0]);
    printBox({
      title: `${second.name} (this one is yours)`,
      tone: 'yellow',
      lines: [
        `Set these ${keys.length} value${keys.length > 1 ? 's' : ''} in ${second.name}, or ${second.reason} will break:`,
        keys.join(', '),
      ],
    });
    if (interactive && (await confirm('Copy them to the clipboard now?', { defaultYes: true }))) {
      const copied = await copyToClipboard(block);
      if (!copied.ok) line('warn', `${copied.reason} The values are in ${CONFIG.productionFile}.`);
      else if (copied.hidden)
        line('ok', 'Copied as KEY=VALUE lines. Your clipboard manager was asked not to keep them.');
      else
        line(
          'warn',
          `Copied with ${copied.tool}, which cannot stop a clipboard history from keeping them.`,
        );
    }
  }

  const revoke = revokeChecklist(items);
  if (revoke.length) {
    printBox({
      title: 'Revoke the old credentials',
      tone: 'yellow',
      lines: [
        ...revoke.map((entry) => `${c.bold(entry.title)}: ${entry.text}`),
        '',
        c.gray('Then check they are really dead: npm run secrets -- --check-revoked'),
      ],
    });
  }

  for (const followUp of CONFIG.followUps ?? []) {
    if (!items.some((item) => item.key === followUp.key && item.status === 'changed')) continue;
    if (interactive && (await confirm(followUp.ask, { defaultYes: true }))) {
      const [command, ...commandArgs] = followUp.command;
      const done = await defaultRun(command, commandArgs, { inherit: true });
      line(done.code === 0 ? 'ok' : 'fail', done.code === 0 ? followUp.done : followUp.failed);
    } else {
      line('warn', followUp.manual);
    }
  }
  line('info', `Old values are saved in ${c.gray(journal.file)}`);
  line('info', `Delete them once everything is revoked: ${c.bold('npm run secrets -- --forget')}`);
}

export async function showOutcome({ result, journal, azure }, items, args) {
  const rotated = items.filter((item) => item.status === 'changed');
  const usedAzure = rotated.some((item) => item.spec.azure);
  if (result.status === 'done') {
    const problems = await finalCheck(azure);
    const pending = result.githubPending;
    const lines = [
      `Rotated ${rotated.length} value${rotated.length === 1 ? '' : 's'}.` +
        (usedAzure ? ' The app restarted and reported healthy on the new values.' : ''),
    ];
    if (problems.length)
      lines.push(`${symbols.warn} The final check found ${problems.length} thing(s), see above.`);
    if (pending.length) {
      lines.push(
        `${symbols.warn} GitHub still has the old value for: ${pending.map((p) => p.key).join(', ')}`,
        '  Push them with: npm run secrets -- --resume',
      );
    }
    printBox({
      title: 'Done',
      tone: pending.length || problems.length ? 'yellow' : 'green',
      lines,
    });
    await yourTurn(items, journal, args);
    return 0;
  }
  if (result.status === 'rolled-back') {
    const { what, fix } = explainFailure(result.error);
    printBox({
      title: 'Rolled back, nothing changed',
      tone: 'red',
      lines: [
        `${c.bold('What went wrong:')} ${what}`,
        `${c.bold('What to do:')} ${fix}`,
        '',
        ...(usedAzure ? ['Azure is on the old values again and the app is healthy.'] : []),
        'Your local env files are as they were, and GitHub was not touched.',
        c.gray(`The full error is saved in ${journal.file}`),
      ],
    });
    return 2;
  }
  if (result.status === 'failed') {
    const cause = explainFailure(result.cause ?? result.error);
    const undo = result.rollbackError ? explainFailure(result.rollbackError) : undefined;
    printBox({
      title: 'ATTENTION: the app may be down',
      tone: 'red',
      lines: [
        `${c.bold('What went wrong:')} ${cause.what}`,
        ...(undo ? [`${c.bold('Putting things back failed too:')} ${undo.what}`] : []),
        `${c.bold('What to do:')} ${(undo ?? cause).fix}`,
        '',
        ...(CONFIG.azure
          ? [
              `Look at the logs: az containerapp logs show -g ${CONFIG.azure.resourceGroup} -n ${CONFIG.azure.app} --tail 50`,
            ]
          : []),
        'Try putting the old values back again: npm run secrets -- --rollback',
        c.gray(`The old values and the full error are in ${journal.file}`),
      ],
    });
    return 3;
  }
  printBox({
    title: result.status === 'nothing' ? 'Nothing to change' : 'Stopped',
    tone: 'gray',
    lines: [result.error ?? 'Nothing was changed.'],
  });
  return 1;
}
