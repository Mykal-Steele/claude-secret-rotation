import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFilesAdapter } from '../../scripts/lib/files.mjs';
import { SECRETS } from './fixtures/manifest.fixture.mjs';

const item = (key, value, old = 'old') => ({
  key,
  spec: SECRETS[key],
  value,
  old,
  status: 'changed',
});

describe('files adapter', () => {
  let root;
  const file = (rel) => path.join(root, rel);
  const read = (rel) => readFileSync(file(rel), 'utf8');

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'files-adapter-'));
    mkdirSync(path.join(root, 'backend-go'));
    writeFileSync(file('.env.development'), '# dev\nJWT_SECRET=dev-old\nOTHER=1\n');
    writeFileSync(file('.env.production'), 'JWT_SECRET=prod-old\nREFRESH_TOKEN_SECRET=r-old\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('updates the key in every listed file that exists and reports each one', async () => {
    const adapter = createFilesAdapter({ root });
    const results = await adapter.write([item('JWT_SECRET', 'new-value')]);
    expect(read('.env.development')).toBe('# dev\nJWT_SECRET=new-value\nOTHER=1\n');
    expect(read('.env.production')).toBe('JWT_SECRET=new-value\nREFRESH_TOKEN_SECRET=r-old\n');
    expect(results).toContainEqual({
      file: '.env.development',
      key: 'JWT_SECRET',
      status: 'updated',
    });
    expect(results).toContainEqual({
      file: '.env.production',
      key: 'JWT_SECRET',
      status: 'updated',
    });
  });

  test('does not create a listed file that is missing', async () => {
    const adapter = createFilesAdapter({ root });
    const results = await adapter.write([item('JWT_SECRET', 'new-value')]);
    expect(existsSync(file('backend-go/.env'))).toBe(false);
    expect(results).toContainEqual({
      file: 'backend-go/.env',
      key: 'JWT_SECRET',
      status: 'file-missing',
    });
  });

  test('adds a key that a listed file does not have yet', async () => {
    const adapter = createFilesAdapter({ root });
    const results = await adapter.write([item('REFRESH_TOKEN_SECRET', 'brand-new')]);
    expect(read('.env.development')).toBe(
      '# dev\nJWT_SECRET=dev-old\nOTHER=1\nREFRESH_TOKEN_SECRET=brand-new\n',
    );
    expect(results).toContainEqual({
      file: '.env.development',
      key: 'REFRESH_TOKEN_SECRET',
      status: 'added',
    });
  });

  test('can be told not to add missing keys', async () => {
    const adapter = createFilesAdapter({ root, addMissing: false });
    const results = await adapter.write([item('REFRESH_TOKEN_SECRET', 'brand-new')]);
    expect(read('.env.development')).not.toContain('REFRESH_TOKEN_SECRET');
    expect(results).toContainEqual({
      file: '.env.development',
      key: 'REFRESH_TOKEN_SECRET',
      status: 'missing',
    });
  });

  test('handles several keys in the same file together', async () => {
    const adapter = createFilesAdapter({ root });
    await adapter.write([item('JWT_SECRET', 'j2'), item('REFRESH_TOKEN_SECRET', 'r2')]);
    expect(read('.env.production')).toBe('JWT_SECRET=j2\nREFRESH_TOKEN_SECRET=r2\n');
  });

  test('backup keeps the original text and restore puts it back exactly', async () => {
    const adapter = createFilesAdapter({ root });
    const before = read('.env.production');
    const backup = await adapter.backup([item('JWT_SECRET', 'new-value')]);
    await adapter.write([item('JWT_SECRET', 'new-value')]);
    expect(read('.env.production')).not.toBe(before);
    await adapter.restore(backup);
    expect(read('.env.production')).toBe(before);
    expect(read('.env.development')).toBe('# dev\nJWT_SECRET=dev-old\nOTHER=1\n');
  });

  test('backup only covers files that exist', async () => {
    const adapter = createFilesAdapter({ root });
    const backup = await adapter.backup([item('JWT_SECRET', 'x')]);
    expect(Object.keys(backup.files).sort()).toEqual(['.env.development', '.env.production']);
  });

  test('adds a last rotated marker above each key it changes or adds', async () => {
    const adapter = createFilesAdapter({ root });
    const stamp = '2026-11-01 09:46 +07:00';
    await adapter.write(
      [item('JWT_SECRET', 'new-value'), item('REFRESH_TOKEN_SECRET', 'brand-new')],
      { stamp },
    );
    expect(read('.env.development')).toBe(
      `# dev\n# last rotated ${stamp}\nJWT_SECRET=new-value\nOTHER=1\n# last rotated ${stamp}\nREFRESH_TOKEN_SECRET=brand-new\n`,
    );
    expect(read('.env.production')).toBe(
      `# last rotated ${stamp}\nJWT_SECRET=new-value\n# last rotated ${stamp}\nREFRESH_TOKEN_SECRET=brand-new\n`,
    );
  });

  test('replaces the marker on the next rotation', async () => {
    const adapter = createFilesAdapter({ root });
    await adapter.write([item('JWT_SECRET', 'v1')], { stamp: '2026-10-01 08:00 +07:00' });
    await adapter.write([item('JWT_SECRET', 'v2')], { stamp: '2026-11-01 09:46 +07:00' });
    expect(read('.env.production')).toBe(
      '# last rotated 2026-11-01 09:46 +07:00\nJWT_SECRET=v2\nREFRESH_TOKEN_SECRET=r-old\n',
    );
  });

  test('writes a key under the name a file uses for it, and marks it', async () => {
    mkdirSync(path.join(root, 'infra'));
    writeFileSync(file('infra/deploy.env'), 'RG=rg\nAUTH=old\n');
    writeFileSync(file('.env.production'), 'TOKEN=old\n');
    const spec = {
      files: ['.env.production', 'infra/deploy.env'],
      fileKeys: { 'infra/deploy.env': 'AUTH' },
    };
    const adapter = createFilesAdapter({ root });
    const results = await adapter.write(
      [{ key: 'TOKEN', spec, value: 'new', old: 'old', status: 'changed' }],
      {
        stamp: '2026-11-01 09:46 +07:00',
      },
    );
    expect(read('.env.production')).toBe('# last rotated 2026-11-01 09:46 +07:00\nTOKEN=new\n');
    expect(read('infra/deploy.env')).toBe(
      'RG=rg\n# last rotated 2026-11-01 09:46 +07:00\nAUTH=new\n',
    );
    expect(results).toContainEqual({ file: 'infra/deploy.env', key: 'TOKEN', status: 'updated' });
  });
});
