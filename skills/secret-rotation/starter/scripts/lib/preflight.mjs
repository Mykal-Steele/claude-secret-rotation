import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { SECRETS } from '../secrets.manifest.mjs';
import { CONFIG } from '../secrets.config.mjs';
import { compareWithAzure } from './checks.mjs';
import {
  azureLogin,
  azureStatus,
  checkTools,
  createAzureAdapter,
  defaultRun,
  githubLogin,
  githubStatus,
} from './cloud.mjs';
import { backupAgeDays, listBackups } from './journal.mjs';
import { canEnforcePermissions } from './safety.mjs';
import {
  choose,
  confirm,
  heading,
  line,
  print,
  printBox,
  spinner,
  style as c,
  symbols,
} from './tui.mjs';
import { Fatal, lock, readCurrent, readFile, root, stateDir } from './session.mjs';

// Logs in again when a login is missing or expired, instead of stopping.
async function ensureLogin({ name, status, login, describe }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const spin = spinner(`Checking the ${name} login`);
    const result = await status();
    if (result.state === 'ok') {
      spin.succeed(`${name}  ${c.gray(describe(result))}`);
      return result;
    }
    if (result.state === 'login') {
      spin.warn(`${name} is not logged in, or the login expired`);
      if (!process.stdin.isTTY)
        throw new Fatal(`${name} is not logged in. Log in, then run this again.`);
      if (!(await confirm(`Log in to ${name} now?`, { defaultYes: true }))) {
        throw new Fatal(`${name} is not logged in. Log in yourself, then run this again.`);
      }
      print(c.gray(`  Starting the ${name} login. Come back here when it finishes.`));
      const done = await login();
      if (
        done.code !== 0 &&
        name === 'Azure' &&
        (await confirm('That did not work. Try the device code login?', { defaultYes: true }))
      ) {
        await azureLogin({ deviceCode: true });
      }
      continue;
    }
    spin.fail(`${name}: ${result.detail ?? 'something went wrong'}`);
    if (result.state === 'target' || result.state === 'repo') throw new Fatal(result.detail);
    if (result.state === 'access') {
      if (
        await confirm('Add the repo permission to your GitHub login now?', { defaultYes: true })
      ) {
        await defaultRun('gh', ['auth', 'refresh', '-s', 'repo'], {
          inherit: true,
          timeoutMs: 600_000,
        });
        continue;
      }
      throw new Fatal(
        `${name} cannot manage secrets in ${result.repo}. You need admin access to the repository.`,
      );
    }
    const choice = await choose(`Could not reach ${name}.`, [
      { key: 'r', label: 'retry' },
      { key: 'q', label: 'quit' },
    ]);
    if (choice === 'q') throw new Fatal(`Could not reach ${name}.`);
  }
  throw new Fatal(`Could not get a working ${name} login after three tries.`);
}

function permissionWarning(present) {
  const loose = present.filter((file) => statSync(path.join(root, file)).mode & 0o077);
  if (!loose.length) return undefined;
  const fix = canEnforcePermissions(root)
    ? 'Run chmod 600 on them.'
    : 'This drive ignores permissions, so move the repo to a normal Linux filesystem to fix it.';
  return `${loose.length} env file(s) can be read by other users on this machine. ${fix}`;
}

async function driftWarning() {
  try {
    const current = await createAzureAdapter().current();
    const drifted = compareWithAzure({ secrets: SECRETS, local: readCurrent, azure: current })
      .filter((result) => result.state !== 'ok')
      .map((result) => result.key);
    if (!drifted.length) return undefined;
    return `Azure and ${CONFIG.productionFile} disagree on: ${drifted.join(', ')}. Rotating these fixes it, otherwise find out which side is right.`;
  } catch {
    return 'Could not compare Azure with your local files.';
  }
}

export async function preflight({
  azure = Boolean(CONFIG.azure),
  github = CONFIG.github !== false,
} = {}) {
  heading('Checking your setup');

  const spin = spinner('Looking for the command line tools');
  const needed = (tool) =>
    tool.name === 'node' || (tool.name === 'az' && azure) || (tool.name === 'gh' && github);
  const tools = (await checkTools()).filter(needed);
  spin.stop();
  for (const tool of tools) line(tool.ok ? 'ok' : 'fail', `${tool.name}  ${c.gray(tool.detail)}`);
  const missing = tools.filter((tool) => !tool.ok);
  if (missing.length) throw new Fatal(missing.map((tool) => tool.detail).join('\n'));

  lock();
  line('ok', `Private folder for old values  ${c.gray(stateDir)}`);

  if (azure) {
    await ensureLogin({
      name: 'Azure',
      status: () => azureStatus(),
      login: () => azureLogin(),
      describe: (s) => `${s.user}, ${s.subscription}, ${CONFIG.azure.app}`,
    });
  }
  if (github) {
    await ensureLogin({
      name: 'GitHub',
      status: () => githubStatus(),
      login: () => githubLogin(),
      describe: (s) => s.repo,
    });
  }

  if (readFile(CONFIG.productionFile) === undefined) {
    throw new Fatal(
      `${CONFIG.productionFile} was not found. It is the record of the current values, so create it first.`,
    );
  }
  const files = [...new Set(Object.values(SECRETS).flatMap((spec) => spec.files))];
  const present = files.filter((file) => existsSync(path.join(root, file)));
  line('ok', `Env files  ${c.gray(present.join(', '))}`);

  const warnings = [permissionWarning(present)];
  const old = listBackups(stateDir).filter(
    (entry) => entry.startedAt && backupAgeDays(entry) > CONFIG.oldBackupDays,
  );
  if (old.length) {
    warnings.push(
      `Old secrets from ${old.length} earlier run(s) are still saved. After revoking them run npm run secrets -- --forget.`,
    );
  }
  if (azure) warnings.push(await driftWarning());
  const shown = warnings.filter(Boolean);
  if (shown.length)
    printBox({
      title: 'Heads up',
      tone: 'yellow',
      lines: shown.map((w) => `${symbols.warn} ${w}`),
    });
}
