import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CONFIG_ONLY, SECRETS } from '../secrets.manifest.mjs';
import { CONFIG } from '../secrets.config.mjs';
import { fileKeyOf } from './current.mjs';
import { countKey, parseEnvValue, parseStamp, readRotationStamp } from './envfile.mjs';
import { backupAgeDays, listBackups } from './journal.mjs';
import { tagName } from './cloud.mjs';
import { canEnforcePermissions as canEnforceReal } from './safety.mjs';
import { verifyMongo as verifyMongoLive } from './verify.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);
const daysBetween = (from, to) => Math.floor((to.getTime() - from.getTime()) / 86_400_000);

// Compares the local value of every key that has an Azure target with what Azure
// holds. Differences are described by hash, never by value.
export function compareWithAzure({ secrets, local, azure }) {
  const results = [];
  for (const [key, spec] of Object.entries(secrets)) {
    if (!spec.azure) continue;
    const mine = local(key);
    if (mine === undefined) continue;
    const name = spec.azure.secret ?? spec.azure.env;
    const remote = spec.azure.secret ? azure.secrets[name] : azure.env[name];
    if (remote === undefined || remote === null) results.push({ key, state: 'missing' });
    else if (remote === mine) results.push({ key, state: 'ok' });
    else results.push({ key, state: 'differs', localHash: hash(mine), azureHash: hash(remote) });
  }
  return results;
}

// Read-only look at every managed secret. One section failing becomes one warning row
// and the other sections still run.
export async function collectChecks({
  root,
  stateDir,
  now = new Date(),
  secrets = SECRETS,
  configOnly = CONFIG_ONLY,
  config = {},
  azure,
  github,
  fetch = globalThis.fetch,
  verifyMongo = verifyMongoLive,
  canEnforcePermissions = canEnforceReal,
}) {
  const settings = { ...CONFIG, ...config, health: { ...CONFIG.health, ...config.health } };
  const production = settings.productionFile;
  const rows = [];
  const add = (section, state, label, detail = '') => rows.push({ section, state, label, detail });
  const guard = async (section, label, fn) => {
    try {
      await fn();
    } catch (error) {
      add(
        section,
        'warn',
        label,
        `Could not run this check: ${String(error.message).split('\n')[0]}`,
      );
    }
  };

  const contents = new Map();
  const read = (relative) => {
    if (!contents.has(relative)) {
      const file = path.join(root, relative);
      contents.set(relative, existsSync(file) ? readFileSync(file, 'utf8') : undefined);
    }
    return contents.get(relative);
  };
  const productionText = read(production);
  const local = (key) =>
    productionText === undefined
      ? undefined
      : parseEnvValue(productionText, fileKeyOf(secrets[key], key, production));
  const overview = Object.keys(secrets)
    .filter((key) => !configOnly.has(key))
    .map((key) => ({
      key,
      local:
        productionText === undefined
          ? undefined
          : readRotationStamp(productionText, fileKeyOf(secrets[key], key, production)),
    }));
  // plain settings such as CLIENT_URL are not credentials, so they have no age to track
  const overviewOf = (key) => overview.find((row) => row.key === key) ?? {};

  // files
  if (productionText === undefined) add('files', 'fail', production, 'File not found.');
  for (const [key, spec] of Object.entries(secrets)) {
    for (const relative of spec.files) {
      const content = read(relative);
      if (content === undefined) continue;
      const name = fileKeyOf(spec, key, relative);
      const label = `${relative}: ${name}`;
      const count = countKey(content, name);
      if (count === 0)
        add('files', relative === production ? 'fail' : 'warn', label, 'Not set in this file.');
      else if (parseEnvValue(content, name) === '') add('files', 'warn', label, 'Empty.');
      else if (count > 1) add('files', 'warn', label, `Appears ${count} times, the last one wins.`);
    }
  }

  // permissions
  const loose = [];
  for (const relative of new Set(Object.values(secrets).flatMap((spec) => spec.files))) {
    const file = path.join(root, relative);
    if (!existsSync(file)) continue;
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) loose.push([relative, mode]);
  }
  if (loose.length) {
    const enforceable = canEnforcePermissions(root);
    for (const [relative, mode] of loose) {
      add(
        'permissions',
        'warn',
        relative,
        `Other users on this machine can read it (mode ${mode.toString(8)}). ` +
          (enforceable
            ? `Run: chmod 600 ${relative}`
            : 'This drive ignores permissions, so move the repo to a normal Linux filesystem to fix it.'),
      );
    }
  }

  // age of the local values
  for (const { key, local: stamp } of overview) {
    const date = parseStamp(stamp);
    if (!date) continue;
    const days = daysBetween(date, now);
    if (days > settings.staleDays) add('age', 'warn', key, `Last rotated ${days} days ago.`);
  }

  // Azure
  if (productionText !== undefined && azure) {
    await guard('azure', 'Azure', async () => {
      const current = await azure.current();
      const tags = await azure.rotationTimes().catch(() => ({}));
      for (const result of compareWithAzure({ secrets, local, azure: current })) {
        if (result.state === 'ok') add('azure', 'ok', result.key, 'Matches Azure.');
        else if (result.state === 'missing') add('azure', 'fail', result.key, 'Not set in Azure.');
        else
          add(
            'azure',
            'fail',
            result.key,
            `Differs from Azure (local ${result.localHash}, Azure ${result.azureHash}).`,
          );
      }
      for (const [key, spec] of Object.entries(secrets)) {
        const name = spec.azure?.secret ?? spec.azure?.env;
        if (name && tags[tagName(name)]) overviewOf(key).azure = tags[tagName(name)];
      }
    });
  }

  // GitHub
  if (github)
    await guard('github', 'GitHub', async () => {
      const updated = await github.list();
      for (const [key, spec] of Object.entries(secrets)) {
        if (!spec.github) continue;
        const when = updated.get(key);
        if (!when) {
          add('github', 'warn', key, 'No GitHub secret, so CI cannot use it.');
          continue;
        }
        overviewOf(key).github = when;
        const days = daysBetween(new Date(when), now);
        if (!configOnly.has(key) && days > settings.staleDays)
          add('github', 'warn', key, `Not updated for ${days} days (${when.slice(0, 10)}).`);
        else add('github', 'ok', key, `Updated ${when.slice(0, 10)}.`);
      }
    });

  // MongoDB
  if (productionText !== undefined) {
    const uri = local('MONGO_URI');
    if (!uri) add('mongo', 'fail', 'MONGO_URI', `Not set in ${production}.`);
    else
      await guard('mongo', 'MongoDB', async () => {
        const result = await verifyMongo(uri);
        add(
          'mongo',
          result.state === 'skip' ? 'ok' : result.state,
          `Login, read and write with ${production}`,
          result.detail,
        );
      });
  }

  // health
  const { path: healthPath, publicUrl, backupHeader } = settings.health;
  const probe = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const servedBy = backupHeader ? response.headers?.get?.(backupHeader.name) : undefined;
      const onBackup = backupHeader && servedBy === backupHeader.value;
      if (!response.ok)
        return add(
          'health',
          'fail',
          url,
          `${response.status}${servedBy ? ` from ${servedBy}` : ''}`,
        );
      if (onBackup) return add('health', 'warn', url, 'Answering, but from the backup.');
      add('health', 'ok', url, servedBy ? `Served by ${servedBy}.` : 'Answering.');
    } catch (error) {
      add('health', 'fail', url, error.message);
    }
  };
  let direct;
  if (azure) {
    await guard('health', 'Azure address', async () => {
      direct = `https://${await azure.fqdn()}${healthPath}`;
    });
  }
  if (direct) await probe(direct);
  if (publicUrl) await probe(`${publicUrl}${healthPath}`);

  // old backups
  const backups = listBackups(stateDir);
  if (backups.length) {
    const ages = backups.map((entry) => (entry.startedAt ? backupAgeDays(entry, now) : 0));
    const oldest = Math.max(...ages);
    add(
      'backups',
      oldest > settings.oldBackupDays ? 'warn' : 'ok',
      'Saved old values',
      `${backups.length} run(s) saved in ${stateDir}, the oldest ${oldest} days ago. ` +
        'They hold the credentials you are replacing. Once you have revoked them, run: npm run secrets -- --forget',
    );
  }

  return { rows, overview };
}
