import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectChecks, compareWithAzure } from '../../scripts/lib/checks.mjs';
import { createJournal } from '../../scripts/lib/journal.mjs';
import { CONFIG } from './fixtures/config.fixture.mjs';

const deepConfig = (overrides = {}) => ({
  ...CONFIG,
  ...overrides,
  health: { ...CONFIG.health, ...overrides.health },
});

const secrets = {
  JWT_SECRET: { files: ['.env.production'], github: true, azure: { secret: 'jwt-secret' } },
  CLIENT_URL: { files: ['.env.production'], github: false, azure: { env: 'CLIENT_URL' } },
  MONGO_URI: { files: ['.env.production'], github: true, azure: { secret: 'mongo-uri' } },
};

describe('collectChecks', () => {
  let root;
  const write = (rel, content, mode = 0o600) => {
    const file = path.join(root, rel);
    writeFileSync(file, content);
    chmodSync(file, mode);
  };

  const context = (overrides = {}) => ({
    root,
    stateDir: path.join(root, 'state'),
    now: new Date('2026-11-01T00:00:00Z'),
    secrets,
    azure: {
      current: async () => ({
        secrets: { 'jwt-secret': 'jjjjjjjj', 'mongo-uri': 'mongodb+srv://u:p@h/' },
        env: { CLIENT_URL: 'https://a.b' },
      }),
      fqdn: async () => 'app.example.io',
      rotationTimes: async () => ({}),
    },
    github: {
      list: async () =>
        new Map([
          ['JWT_SECRET', '2026-10-30T00:00:00Z'],
          ['MONGO_URI', '2026-10-30T00:00:00Z'],
        ]),
    },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null } }),
    verifyMongo: async () => ({ state: 'ok', detail: 'fine' }),
    ...overrides,
    config: deepConfig(overrides.config),
  });

  const rowsOf = (result, section) => result.rows.filter((row) => row.section === section);
  const find = (result, section, label) =>
    result.rows.find((row) => row.section === section && row.label === label);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'checks-'));
    write(
      '.env.production',
      'MONGO_URI=mongodb+srv://u:p@h/\nJWT_SECRET=jjjjjjjj\nCLIENT_URL=https://a.b\n',
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('everything matching gives only ok rows for azure, github, mongo and health', async () => {
    const result = await collectChecks(context());
    for (const section of ['azure', 'github', 'mongo', 'health']) {
      expect(rowsOf(result, section).length).toBeGreaterThan(0);
      expect(rowsOf(result, section).every((row) => row.state === 'ok')).toBe(true);
    }
  });

  test('a key missing from .env.production is a failure', async () => {
    write('.env.production', 'MONGO_URI=mongodb+srv://u:p@h/\nCLIENT_URL=https://a.b\n');
    const result = await collectChecks(context());
    expect(find(result, 'files', '.env.production: JWT_SECRET')).toMatchObject({ state: 'fail' });
  });

  test('an empty value and a duplicate line are warnings', async () => {
    write(
      '.env.production',
      'MONGO_URI=mongodb+srv://u:p@h/\nJWT_SECRET=\nCLIENT_URL=a\nCLIENT_URL=b\n',
    );
    const result = await collectChecks(context());
    expect(find(result, 'files', '.env.production: JWT_SECRET')).toMatchObject({ state: 'warn' });
    expect(find(result, 'files', '.env.production: CLIENT_URL').detail).toMatch(/2 times/);
  });

  test('warns about an env file other users can read', async () => {
    write(
      '.env.production',
      'MONGO_URI=mongodb+srv://u:p@h/\nJWT_SECRET=jjjjjjjj\nCLIENT_URL=https://a.b\n',
      0o644,
    );
    const result = await collectChecks(context());
    expect(find(result, 'permissions', '.env.production')).toMatchObject({ state: 'warn' });
    expect(find(result, 'permissions', '.env.production').detail).toMatch(/644/);
  });

  test('an owner-only env file has no permission row', async () => {
    const result = await collectChecks(context());
    expect(rowsOf(result, 'permissions')).toEqual([]);
  });

  test('reports drift between .env.production and Azure by hash, never by value', async () => {
    const result = await collectChecks(
      context({
        azure: {
          current: async () => ({
            secrets: { 'jwt-secret': 'different-value', 'mongo-uri': 'mongodb+srv://u:p@h/' },
            env: { CLIENT_URL: 'https://a.b' },
          }),
          fqdn: async () => 'app.example.io',
          rotationTimes: async () => ({}),
        },
      }),
    );
    const row = find(result, 'azure', 'JWT_SECRET');
    expect(row.state).toBe('fail');
    expect(row.detail).toMatch(/differs/i);
    expect(JSON.stringify(result)).not.toContain('different-value');
    expect(JSON.stringify(result)).not.toContain('jjjjjjjj');
  });

  test('says when a secret is not set in Azure at all', async () => {
    const result = await collectChecks(
      context({
        azure: {
          current: async () => ({ secrets: {}, env: {} }),
          fqdn: async () => 'app.example.io',
          rotationTimes: async () => ({}),
        },
      }),
    );
    expect(find(result, 'azure', 'MONGO_URI').detail).toMatch(/not set/i);
  });

  test('a missing GitHub secret is a warning and an old one is flagged with its age', async () => {
    const result = await collectChecks(
      context({ github: { list: async () => new Map([['JWT_SECRET', '2026-06-01T00:00:00Z']]) } }),
    );
    expect(find(result, 'github', 'MONGO_URI').state).toBe('warn');
    const old = find(result, 'github', 'JWT_SECRET');
    expect(old.state).toBe('warn');
    expect(old.detail).toMatch(/153 days/);
  });

  test('a failing Mongo login is a failure and carries the reason', async () => {
    const result = await collectChecks(
      context({
        verifyMongo: async () => ({
          state: 'fail',
          detail: 'The user name or password was rejected.',
        }),
      }),
    );
    expect(rowsOf(result, 'mongo')[0]).toMatchObject({ state: 'fail' });
    expect(rowsOf(result, 'mongo')[0].detail).toMatch(/rejected/);
  });

  test('flags a public site that is being served by the backup', async () => {
    const result = await collectChecks(
      context({
        fetch: async (url) =>
          url.includes('example.com')
            ? {
                ok: false,
                status: 502,
                headers: { get: (name) => (name === 'x-served-by' ? 'failover-backup' : null) },
              }
            : { ok: true, status: 200, headers: { get: () => null } },
      }),
    );
    const row = find(result, 'health', 'https://example.com/api/health');
    expect(row.state).toBe('fail');
    expect(row.detail).toMatch(/502/);
    expect(row.detail).toMatch(/failover-backup/);
  });

  test('warns when old secrets are still stored in a backup', async () => {
    await createJournal({
      dir: path.join(root, 'state'),
      id: '20261001-090000',
      now: () => new Date('2026-10-01T09:00:00Z'),
    }).save({
      phase: 'done',
      items: [],
    });
    const result = await collectChecks(context());
    const row = rowsOf(result, 'backups')[0];
    expect(row.state).toBe('warn');
    expect(row.detail).toMatch(/--forget/);
  });

  test('warns about a value that has not been rotated for 90 days', async () => {
    write(
      '.env.production',
      '# last rotated 2026-06-01 00:00 +00:00\nJWT_SECRET=jjjjjjjj\nMONGO_URI=mongodb+srv://u:p@h/\nCLIENT_URL=https://a.b\n',
    );
    const result = await collectChecks(context());
    expect(find(result, 'age', 'JWT_SECRET')).toMatchObject({ state: 'warn' });
  });

  test('a section that cannot run becomes one warning and the others still run', async () => {
    const result = await collectChecks(
      context({
        azure: {
          current: async () => {
            throw new Error('az is not logged in');
          },
          fqdn: async () => 'app.example.io',
          rotationTimes: async () => ({}),
        },
      }),
    );
    const azureRows = rowsOf(result, 'azure');
    expect(azureRows).toHaveLength(1);
    expect(azureRows[0].detail).toMatch(/az is not logged in/);
    expect(rowsOf(result, 'github').length).toBeGreaterThan(0);
  });

  test('builds an overview of when each key was last rotated in each place', async () => {
    write(
      '.env.production',
      '# last rotated 2026-10-01 08:00 +07:00\nJWT_SECRET=jjjjjjjj\nMONGO_URI=mongodb+srv://u:p@h/\nCLIENT_URL=https://a.b\n',
    );
    const result = await collectChecks(
      context({
        azure: {
          current: async () => ({
            secrets: { 'jwt-secret': 'jjjjjjjj', 'mongo-uri': 'mongodb+srv://u:p@h/' },
            env: { CLIENT_URL: 'https://a.b' },
          }),
          fqdn: async () => 'app.example.io',
          rotationTimes: async () => ({ 'rotated-jwt-secret': '2026-10-01T01:00:00.000Z' }),
        },
      }),
    );
    expect(result.overview.find((row) => row.key === 'JWT_SECRET')).toEqual({
      key: 'JWT_SECRET',
      local: '2026-10-01 08:00 +07:00',
      github: '2026-10-30T00:00:00Z',
      azure: '2026-10-01T01:00:00.000Z',
    });
  });

  test('does not call a plain config value stale, and leaves it out of the overview', async () => {
    write(
      '.env.production',
      '# last rotated 2026-01-01 00:00 +00:00\nCLIENT_URL=https://a.b\nJWT_SECRET=jjjjjjjj\nMONGO_URI=mongodb+srv://u:p@h/\n',
    );
    const result = await collectChecks(
      context({
        configOnly: new Set(['CLIENT_URL']),
        github: {
          list: async () =>
            new Map([
              ['JWT_SECRET', '2026-10-30T00:00:00Z'],
              ['MONGO_URI', '2026-10-30T00:00:00Z'],
              ['CLIENT_URL', '2026-01-01T00:00:00Z'],
            ]),
        },
        secrets: { ...secrets, CLIENT_URL: { ...secrets.CLIENT_URL, github: true } },
      }),
    );
    expect(find(result, 'age', 'CLIENT_URL')).toBeUndefined();
    expect(find(result, 'github', 'CLIENT_URL')).toMatchObject({ state: 'ok' });
    expect(result.overview.find((row) => row.key === 'CLIENT_URL')).toBeUndefined();
  });

  test('uses the health path, public address and backup header from the config', async () => {
    const urls = [];
    const result = await collectChecks(
      context({
        config: {
          health: {
            path: '/healthz',
            publicUrl: 'https://example.com',
            backupHeader: { name: 'x-via', value: 'backup' },
          },
        },
        fetch: async (url) => {
          urls.push(url);
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name) =>
                url.startsWith('https://example.com') && name === 'x-via' ? 'backup' : null,
            },
          };
        },
      }),
    );
    expect(urls).toEqual(['https://app.example.io/healthz', 'https://example.com/healthz']);
    const row = find(result, 'health', 'https://example.com/healthz');
    expect(row.state).toBe('warn');
    expect(row.detail).toMatch(/backup/i);
  });

  test('skips the public probe when no public address is configured', async () => {
    const result = await collectChecks(context({ config: { health: { publicUrl: null } } }));
    expect(rowsOf(result, 'health')).toHaveLength(1);
  });

  test('takes the age limit from the config', async () => {
    write(
      '.env.production',
      '# last rotated 2026-10-01 00:00 +00:00\nJWT_SECRET=jjjjjjjj\nMONGO_URI=mongodb+srv://u:p@h/\nCLIENT_URL=https://a.b\n',
    );
    expect(find(await collectChecks(context()), 'age', 'JWT_SECRET')).toBeUndefined();
    expect(
      find(await collectChecks(context({ config: { staleDays: 10 } })), 'age', 'JWT_SECRET'),
    ).toMatchObject({
      state: 'warn',
    });
  });

  test('reads the record of current values from the configured file', async () => {
    write('.env.prod', 'JWT_SECRET=jjjjjjjj\nMONGO_URI=mongodb+srv://u:p@h/\n');
    const result = await collectChecks(
      context({
        config: { productionFile: '.env.prod' },
        secrets: {
          JWT_SECRET: { files: ['.env.prod'], github: false, azure: { secret: 'jwt-secret' } },
          MONGO_URI: { files: ['.env.prod'], github: false, azure: { secret: 'mongo-uri' } },
        },
      }),
    );
    expect(find(result, 'azure', 'JWT_SECRET')).toMatchObject({ state: 'ok' });
    expect(rowsOf(result, 'mongo')[0].label).toMatch(/\.env\.prod/);
  });

  test('tells you to chmod when the drive keeps permissions, and to move when it does not', async () => {
    write(
      '.env.production',
      'MONGO_URI=mongodb+srv://u:p@h/\nJWT_SECRET=jjjjjjjj\nCLIENT_URL=https://a.b\n',
      0o644,
    );
    const keeps = await collectChecks(context({ canEnforcePermissions: () => true }));
    expect(find(keeps, 'permissions', '.env.production').detail).toMatch(/chmod 600/);
    const ignores = await collectChecks(context({ canEnforcePermissions: () => false }));
    expect(find(ignores, 'permissions', '.env.production').detail).toMatch(/ignores permissions/);
  });

  test('leaves Azure and the direct health probe out when there is no Azure', async () => {
    const result = await collectChecks(context({ azure: null }));
    expect(rowsOf(result, 'azure')).toEqual([]);
    expect(rowsOf(result, 'health').map((row) => row.label)).toEqual([
      'https://example.com/api/health',
    ]);
  });

  test('leaves GitHub out when there is none', async () => {
    const result = await collectChecks(context({ github: null }));
    expect(rowsOf(result, 'github')).toEqual([]);
    expect(rowsOf(result, 'azure').length).toBeGreaterThan(0);
  });

  test('understands a key that another file calls by a different name', async () => {
    mkdirSync(path.join(root, 'infra'));
    write('.env.production', 'TOKEN=tttttttt\n');
    write('infra/deploy.env', 'AUTH=tttttttt\n');
    const withAlias = {
      TOKEN: {
        files: ['.env.production', 'infra/deploy.env'],
        fileKeys: { 'infra/deploy.env': 'AUTH' },
        github: false,
        azure: null,
      },
    };
    const clean = await collectChecks(context({ secrets: withAlias }));
    expect(rowsOf(clean, 'files')).toEqual([]);
    write('infra/deploy.env', 'OTHER=1\n');
    const missing = await collectChecks(context({ secrets: withAlias }));
    expect(find(missing, 'files', 'infra/deploy.env: AUTH')).toMatchObject({ state: 'warn' });
  });
});

describe('compareWithAzure', () => {
  const secrets = {
    A: { azure: { secret: 'a' } },
    B: { azure: { env: 'B' } },
    C: { azure: { secret: 'c' } },
    D: {},
    E: { azure: { secret: 'e' } },
  };
  const local = (key) => ({ A: '1', B: '2', C: 'local-value', D: '4' })[key];
  const azure = { secrets: { a: '1', c: 'azure-value' }, env: {} };

  test('says ok, missing or differs for every key that has an Azure target and a local value', () => {
    const result = compareWithAzure({ secrets, local, azure });
    expect(result.map((r) => [r.key, r.state])).toEqual([
      ['A', 'ok'],
      ['B', 'missing'],
      ['C', 'differs'],
    ]);
  });

  test('describes a difference by hash only', () => {
    const differs = compareWithAzure({ secrets, local, azure }).find((r) => r.state === 'differs');
    expect(differs.localHash).toMatch(/^[0-9a-f]{8}$/);
    expect(differs.azureHash).toMatch(/^[0-9a-f]{8}$/);
    expect(differs.localHash).not.toBe(differs.azureHash);
    expect(JSON.stringify(differs)).not.toContain('local-value');
    expect(JSON.stringify(differs)).not.toContain('azure-value');
  });
});
