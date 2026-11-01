#!/usr/bin/env node
// Rotates the repository's secrets in one guided run:
//
//   npm run secrets                  the wizard
//   npm run secrets -- --dry-run     everything except the final write
//   npm run secrets -- --help        all options
//
// New values are tested with their providers before anything changes. Then the old
// values are saved privately, anything outside the app platform that checks a value is
// updated, Azure is updated and restarted, and the app has to report healthy before the
// local files and GitHub are touched. If anything before GitHub fails, everything is put
// back. The steps are in docs/secret-rotation.md.
import { SECRETS, NOT_MANAGED } from './secrets.manifest.mjs';
import { CONFIG } from './secrets.config.mjs';
import { buildPlan } from './lib/plan.mjs';
import {
  checkRevokedMode,
  forgetMode,
  resumeMode,
  rollbackMode,
  syncGithubMode,
} from './lib/modes.mjs';
import { preflight } from './lib/preflight.mjs';
import { runApply, showOutcome } from './lib/run.mjs';
import {
  Fatal,
  Usage,
  ensureStateDir,
  readCurrent,
  scrub,
  stateDir,
  track,
  unlock,
} from './lib/session.mjs';
import {
  NoTerminalError,
  confirm,
  heading,
  onInterrupt,
  print,
  printBox,
  style as c,
  symbols,
} from './lib/tui.mjs';
import { collectScripted, collectWizard, review, verifyAndFix } from './lib/wizard.mjs';

function parseArgs(argv) {
  const out = { mode: 'rotate', dryRun: false, yes: false, gen: [], set: [] };
  const needKey = (key) => {
    if (!key || !SECRETS[key]) {
      throw new Usage(
        `${key ?? 'A key'} is not a managed secret. Known keys: ${Object.keys(SECRETS).join(', ')}`,
      );
    }
    return key;
  };
  const modes = {
    '--rollback': 'rollback',
    '--forget': 'forget',
    '--resume': 'resume',
    '--sync-github': 'sync-github',
    '--check-revoked': 'check-revoked',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.mode = 'help';
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg === '--ask' || arg === '--apply') continue;
    else if (arg === '--gen') out.gen.push(needKey(argv[++i]));
    else if (arg === '--set') {
      const next = argv[++i];
      if (next?.includes('=')) {
        throw new Usage(
          '--set no longer takes a value. It would end up in your shell history and in the process list. Use --set KEY and paste the value when asked.',
        );
      }
      out.set.push(needKey(next));
    } else if (modes[arg]) out.mode = modes[arg];
    else throw new Usage(`Unknown option ${arg}. Try --help.`);
  }
  return out;
}

function printHelp() {
  const option = (flag, text) => `${c.bold(flag.padEnd(16))}${text}`;
  printBox({
    title: 'npm run secrets',
    tone: 'cyan',
    lines: [
      'Rotates credentials in Azure, GitHub and the env files, and keeps them in step.',
      '',
      option('(no options)', 'the wizard'),
      option('--dry-run', 'everything except the final write'),
      option('--gen KEY', 'generate a value for KEY'),
      option('--set KEY', 'ask for the value of KEY (hidden)'),
      option('--yes', 'skip the final confirmation'),
      option('--rollback', 'undo the last run'),
      option('--resume', 'push GitHub secrets that failed'),
      option('--sync-github', 'push GitHub secrets that are missing'),
      option('--check-revoked', 'test if the old credentials still work'),
      option('--forget', 'delete the saved old values'),
      '',
      c.gray(`Old values are kept in ${stateDir}`),
      c.gray('(owner-only, outside the repository).'),
      '',
      c.bold('Not managed here, set by hand:'),
      ...Object.entries(NOT_MANAGED).map(([names, how]) => `${names}: ${c.gray(how)}`),
    ],
  });
}

async function rotateMode(args) {
  const interactive = !args.gen.length && !args.set.length;
  if (interactive && !process.stdin.isTTY) {
    throw new Fatal(
      'The wizard needs an interactive terminal. Run it directly in a terminal, or use --gen KEY.',
    );
  }
  printBox({
    title: `${CONFIG.name} secret rotation`,
    tone: 'cyan',
    lines: [
      'Rotates credentials in Azure, GitHub and the env files.',
      c.gray(
        'Nothing is written until you confirm the review. If a step fails, everything is put back.',
      ),
    ],
  });
  await preflight();

  let values = interactive ? await collectWizard() : await collectScripted(args, args.gen);
  if (!Object.keys(values).length) {
    print(`\n  ${symbols.skip} Nothing selected, nothing changed.`);
    return 0;
  }
  values = await verifyAndFix(values, { interactive });

  const plan = buildPlan({ values, current: readCurrent });
  if (plan.errors.length) throw new Fatal(plan.errors.join('\n'));
  plan.items.forEach((item) => {
    track(item.value);
    track(item.old);
  });
  review(plan);
  if (!plan.changed.length) {
    print(`\n  ${symbols.skip} Every value is the same as the current one, nothing to do.`);
    return 0;
  }
  if (args.dryRun) {
    printBox({
      title: 'Dry run',
      tone: 'gray',
      lines: ['Nothing was changed. The checks above used the real providers.'],
    });
    return 0;
  }
  if (!args.yes && !(await confirm('Apply these changes?', { defaultYes: false }))) {
    print(`\n  ${symbols.skip} Stopped, nothing changed.`);
    return 0;
  }
  heading('Applying');
  const outcome = await runApply(plan.items);
  return showOutcome(outcome, plan.items, args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') return printHelp();
  onInterrupt(unlock);
  process.on('exit', unlock);
  const modes = {
    rotate: rotateMode,
    rollback: rollbackMode,
    resume: resumeMode,
    'sync-github': syncGithubMode,
    'check-revoked': checkRevokedMode,
    forget: forgetMode,
  };
  if (args.mode === 'forget' || args.mode === 'check-revoked') ensureStateDir();
  process.exitCode = await modes[args.mode](args);
}

main().catch((error) => {
  const message = scrub(error.message ?? String(error));
  if (error instanceof Usage) {
    print(`\n  ${symbols.fail} ${message}`);
  } else if (error instanceof Fatal || error instanceof NoTerminalError) {
    printBox({ title: 'Stopped', tone: 'red', lines: message.split('\n') });
  } else {
    printBox({
      title: 'Something unexpected went wrong',
      tone: 'red',
      lines: [
        message,
        '',
        c.gray(
          'Nothing is half changed unless a step above says so. npm run secrets:check shows where things stand.',
        ),
      ],
    });
  }
  process.exit(error instanceof Usage ? 2 : 1);
});
