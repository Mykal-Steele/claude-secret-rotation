import { createRunner } from './proc.mjs';
import { isAuthError, redact, withRetry } from './safety.mjs';
import { CONFIG } from '../secrets.config.mjs';

// Keeps az quiet and stops it from stopping to ask about extensions or telemetry.
const CLOUD_ENV = {
  AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
  AZURE_CORE_COLLECT_TELEMETRY: 'false',
  AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'yes_without_prompt',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
};

export const defaultRun = createRunner({ baseEnv: { ...process.env, ...CLOUD_ENV } });

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSIENT =
  /timed out|timeout|connection (reset|refused|aborted)|ECONN|ETIMEDOUT|EAI_AGAIN|HTTP (502|503|504|429)|too many requests|temporarily|service unavailable|TLS handshake/i;

export const isTransient = (text) => TRANSIENT.test(String(text));

const lastLines = (text, count) => text.split('\n').slice(-count).join('\n');
const firstLine = (text) => text.trim().split('\n')[0] ?? '';

// Runs a command and throws a readable error when it fails. The message has any
// secret values removed, because az and gh sometimes repeat what they were given.
async function runChecked(run, command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code === 0) return result;
  const raw = (
    result.stderr ||
    result.stdout ||
    `${command} exited with code ${result.code}`
  ).trim();
  const text = redact(raw, options.secrets ?? []);
  const error = new Error(lastLines(text, 6));
  error.auth = isAuthError(text);
  error.transient = isTransient(text);
  throw error;
}

const unique = (list) => [...new Set(list)];
export const tagName = (name) => `rotated-${name.toLowerCase().replace(/_/g, '-')}`;

export function createAzureAdapter({
  run = defaultRun,
  fetch = globalThis.fetch,
  sleep = realSleep,
  config = CONFIG.azure,
  healthPath = CONFIG.health.path,
  initialWaitMs = 20_000,
  intervalMs = 10_000,
  timeoutMs = 240_000,
  onTick,
} = {}) {
  const target = ['-g', config.resourceGroup, '-n', config.app];
  const az = (args, options) =>
    withRetry(() => runChecked(run, 'az', args, options), {
      tries: 3,
      baseMs: 1500,
      sleep,
      retryIf: (error) => error.transient,
    });

  return {
    // Remembers the current value of everything this run will change, so it can be put back.
    async snapshot(items) {
      const secretNames = unique(items.map((item) => item.spec.azure?.secret).filter(Boolean));
      const envNames = unique(items.map((item) => item.spec.azure?.env).filter(Boolean));
      const snapshot = { secrets: {}, env: {} };
      if (secretNames.length) {
        const { stdout } = await az([
          'containerapp',
          'secret',
          'list',
          ...target,
          '--show-values',
          '-o',
          'json',
        ]);
        const current = new Map(
          JSON.parse(stdout || '[]').map((entry) => [entry.name, entry.value]),
        );
        for (const name of secretNames)
          snapshot.secrets[name] = current.has(name) ? current.get(name) : null;
      }
      if (envNames.length) {
        const { stdout } = await az([
          'containerapp',
          'show',
          ...target,
          '--query',
          'properties.template.containers[0].env',
          '-o',
          'json',
        ]);
        const current = new Map(
          (JSON.parse(stdout || 'null') ?? []).map((entry) => [entry.name, entry.value]),
        );
        for (const name of envNames) snapshot.env[name] = current.get(name) ?? null;
      }
      return snapshot;
    },

    // az has no way to read a secret from stdin, so values go on its command line.
    // Another user on this machine could see them in the process list for a moment.
    async apply(items) {
      const secrets = items.filter((item) => item.spec.azure?.secret);
      const envs = items.filter((item) => item.spec.azure?.env);
      const options = { secrets: items.map((item) => item.value) };
      if (secrets.length) {
        await az(
          [
            'containerapp',
            'secret',
            'set',
            ...target,
            '--secrets',
            ...secrets.map((i) => `${i.spec.azure.secret}=${i.value}`),
          ],
          options,
        );
      }
      if (envs.length) {
        await az(
          [
            'containerapp',
            'update',
            ...target,
            '--set-env-vars',
            ...envs.map((i) => `${i.spec.azure.env}=${i.value}`),
          ],
          options,
        );
      }
    },

    // A Container App reads secrets when a replica starts, so a change needs a restart.
    async restart() {
      const { stdout } = await az([
        'containerapp',
        'revision',
        'list',
        ...target,
        '--query',
        '[?properties.active] | [0].name',
        '-o',
        'tsv',
      ]);
      const revision = stdout.trim();
      if (!revision) throw new Error('No active revision found for the Container App.');
      await az(['containerapp', 'revision', 'restart', ...target, '--revision', revision]);
    },

    async fqdn() {
      const { stdout } = await az([
        'containerapp',
        'show',
        ...target,
        '--query',
        'properties.configuration.ingress.fqdn',
        '-o',
        'tsv',
      ]);
      return stdout.trim();
    },

    // Every secret and env var as it is now, for comparing with the local files.
    async current() {
      const { stdout: secretList } = await az([
        'containerapp',
        'secret',
        'list',
        ...target,
        '--show-values',
        '-o',
        'json',
      ]);
      const { stdout: envList } = await az([
        'containerapp',
        'show',
        ...target,
        '--query',
        'properties.template.containers[0].env',
        '-o',
        'json',
      ]);
      return {
        secrets: Object.fromEntries(
          JSON.parse(secretList || '[]').map((entry) => [entry.name, entry.value]),
        ),
        env: Object.fromEntries(
          (JSON.parse(envList || 'null') ?? []).map((entry) => [entry.name, entry.value ?? null]),
        ),
      };
    },

    // Two good answers in a row, because the old replica can still answer for a few
    // seconds after a restart.
    async waitHealthy() {
      const url = `https://${await this.fqdn()}${healthPath}`;
      await sleep(initialWaitMs);
      const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
      let good = 0;
      let last = 'no answer';
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
          last = response.ok ? 'ok' : String(response.status);
          good = response.ok ? good + 1 : 0;
        } catch {
          last = 'no answer';
          good = 0;
        }
        if (good >= 2) return;
        onTick?.(attempt + 1, attempts, last);
        await sleep(intervalMs);
      }
      throw new Error(
        `The app was not healthy ${Math.round(timeoutMs / 1000)} seconds after the change. Last answer: ${last}.`,
      );
    },

    async restore(snapshot) {
      const options = { secrets: Object.values(snapshot.secrets ?? {}) };
      const setSecrets = Object.entries(snapshot.secrets ?? {}).filter(
        ([, value]) => value !== null,
      );
      const removeSecrets = Object.entries(snapshot.secrets ?? {}).filter(
        ([, value]) => value === null,
      );
      if (setSecrets.length) {
        await az(
          [
            'containerapp',
            'secret',
            'set',
            ...target,
            '--secrets',
            ...setSecrets.map(([n, v]) => `${n}=${v}`),
          ],
          options,
        );
      }
      for (const [name] of removeSecrets) {
        await az(['containerapp', 'secret', 'remove', ...target, '--secret-names', name]);
      }
      const setEnv = Object.entries(snapshot.env ?? {}).filter(([, value]) => value !== null);
      const removeEnv = Object.entries(snapshot.env ?? {}).filter(([, value]) => value === null);
      if (setEnv.length) {
        await az(
          [
            'containerapp',
            'update',
            ...target,
            '--set-env-vars',
            ...setEnv.map(([n, v]) => `${n}=${v}`),
          ],
          options,
        );
      }
      if (removeEnv.length) {
        await az([
          'containerapp',
          'update',
          ...target,
          '--remove-env-vars',
          ...removeEnv.map(([n]) => n),
        ]);
      }
    },

    // Azure has no timestamp on Container App secrets, so the rotation time goes on
    // the resource as tags like rotated-jwt-secret. A tag holds a time, never a value.
    async markRotated(items, when) {
      const names = unique(
        items.map((item) => item.spec.azure?.secret ?? item.spec.azure?.env).filter(Boolean),
      );
      if (!names.length) return;
      const { stdout } = await az([
        'containerapp',
        'show',
        ...target,
        '--query',
        'id',
        '-o',
        'tsv',
      ]);
      await az([
        'tag',
        'update',
        '--resource-id',
        stdout.trim(),
        '--operation',
        'Merge',
        '--tags',
        ...names.map((name) => `${tagName(name)}=${when}`),
      ]);
    },

    // The rotation time of each Azure secret and env var, read back from the tags.
    async rotationTimes() {
      const { stdout } = await az([
        'containerapp',
        'show',
        ...target,
        '--query',
        'tags',
        '-o',
        'json',
      ]);
      return JSON.parse(stdout || 'null') ?? {};
    },
  };
}

export function createGithubAdapter({ run = defaultRun } = {}) {
  return {
    // The value goes in on stdin, so it never shows up in the process list.
    async set(key, value) {
      const result = await run('gh', ['secret', 'set', key], { input: value });
      if (result.code === 0) return;
      const text = redact((result.stderr || result.stdout).trim(), [value]);
      const error = new Error(lastLines(text, 4) || `gh exited with code ${result.code}`);
      error.permanent = isAuthError(text) || /HTTP (401|403|404)|not accessible|admin/i.test(text);
      throw error;
    },

    async list() {
      const { stdout } = await runChecked(run, 'gh', ['secret', 'list']);
      const secrets = new Map();
      for (const row of stdout.trim().split('\n').filter(Boolean)) {
        const [name, updated] = row.split('\t');
        secrets.set(name, updated);
      }
      return secrets;
    },
  };
}

export async function checkTools({ run = defaultRun } = {}) {
  const hints = {
    az: 'Install it from https://learn.microsoft.com/cli/azure/install-azure-cli',
    gh: 'Install it from https://cli.github.com',
  };
  const tools = [];
  for (const name of ['az', 'gh']) {
    const result = await run(name, ['--version'], { timeoutMs: 30_000 });
    tools.push(
      result.code === 0
        ? { name, ok: true, detail: firstLine(result.stdout) }
        : { name, ok: false, detail: `${name} is not installed. ${hints[name]}` },
    );
  }
  const major = Number(process.versions.node.split('.')[0]);
  tools.push({
    name: 'node',
    ok: major >= 20,
    detail: major >= 20 ? `v${process.versions.node}` : 'Node 20 or newer is needed.',
  });
  return tools;
}

export async function azureStatus({ run = defaultRun, config = CONFIG.azure } = {}) {
  const token = await run(
    'az',
    ['account', 'get-access-token', '--query', 'expiresOn', '-o', 'tsv'],
    { timeoutMs: 60_000 },
  );
  if (token.code !== 0) {
    const text = (token.stderr || token.stdout).trim();
    return isAuthError(text) ? { state: 'login' } : { state: 'error', detail: firstLine(text) };
  }
  let subscription = 'unknown';
  let user = 'unknown';
  const account = await run('az', [
    'account',
    'show',
    '--query',
    '{subscription:name,user:user.name}',
    '-o',
    'json',
  ]);
  try {
    ({ subscription, user } = JSON.parse(account.stdout));
  } catch {}
  const app = await run(
    'az',
    [
      'containerapp',
      'show',
      '-g',
      config.resourceGroup,
      '-n',
      config.app,
      '--query',
      'name',
      '-o',
      'tsv',
    ],
    {
      timeoutMs: 90_000,
    },
  );
  if (app.code !== 0) {
    return {
      state: 'target',
      subscription,
      user,
      detail: `Could not find ${config.app} in ${config.resourceGroup} under the subscription "${subscription}". If you have more than one, run: az account set --subscription <name>`,
    };
  }
  return { state: 'ok', subscription, user };
}

export async function githubStatus({ run = defaultRun } = {}) {
  const auth = await run('gh', ['auth', 'status']);
  if (auth.code !== 0) return { state: 'login' };
  const repo = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (repo.code !== 0) return { state: 'repo', detail: firstLine(repo.stderr || repo.stdout) };
  const name = repo.stdout.trim();
  const list = await run('gh', ['secret', 'list']);
  if (list.code !== 0)
    return { state: 'access', repo: name, detail: firstLine(list.stderr || list.stdout) };
  return { state: 'ok', repo: name };
}

export const azureLogin = ({ run = defaultRun, deviceCode = false } = {}) =>
  run('az', ['login', ...(deviceCode ? ['--use-device-code'] : [])], {
    inherit: true,
    timeoutMs: 600_000,
  });

export const githubLogin = ({ run = defaultRun } = {}) =>
  run('gh', ['auth', 'login'], { inherit: true, timeoutMs: 600_000 });
