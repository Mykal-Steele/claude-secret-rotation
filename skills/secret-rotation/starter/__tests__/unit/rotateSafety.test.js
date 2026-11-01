import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fingerprint,
  describeValue,
  redact,
  withRetry,
  isAuthError,
  stateDir,
  canEnforcePermissions,
  ensurePrivateDir,
  writePrivateFile,
  secureDelete,
  acquireLock,
  previewValue,
} from '../../scripts/lib/safety.mjs';

describe('fingerprint and describeValue', () => {
  test('gives the same 6 hex characters for the same value and a different one otherwise', () => {
    expect(fingerprint('abc')).toMatch(/^[0-9a-f]{6}$/);
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
  });

  test('describes a value by length and fingerprint without showing any of it', () => {
    const text = describeValue('super-secret-value');
    expect(text).toContain('18 characters');
    expect(text).toContain(fingerprint('super-secret-value'));
    expect(text).not.toContain('super');
    expect(text).not.toContain('value');
  });
});

describe('redact', () => {
  test('replaces secrets in text, including the URL-encoded form', () => {
    const text = 'failed for pa$$word123 and pa%24%24word123 here';
    expect(redact(text, ['pa$$word123'])).toBe('failed for *** and *** here');
  });

  test('treats the secret literally, not as a pattern', () => {
    expect(redact('a.c.e.g abcdefg', ['a.c.e.g'])).toBe('*** abcdefg');
  });

  test('ignores values shorter than 6 characters so ordinary words survive', () => {
    expect(redact('the cat sat', ['cat'])).toBe('the cat sat');
  });

  test('handles empty and missing values', () => {
    expect(redact('hello', [undefined, '', null])).toBe('hello');
  });
});

describe('withRetry', () => {
  test('retries with a growing delay and returns the first success', async () => {
    const delays = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('flaky');
        return 'ok';
      },
      { tries: 3, baseMs: 100, sleep: async (ms) => delays.push(ms) },
    );
    expect(result).toBe('ok');
    expect(delays).toEqual([100, 200]);
  });

  test('throws the last error after the last try', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error(`fail ${attempts}`);
        },
        { tries: 3, baseMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow('fail 3');
    expect(attempts).toBe(3);
  });

  test('does not retry when retryIf says the error is permanent', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error('403 forbidden');
        },
        {
          tries: 3,
          baseMs: 1,
          sleep: async () => {},
          retryIf: (error) => !/403/.test(error.message),
        },
      ),
    ).rejects.toThrow('403');
    expect(attempts).toBe(1);
  });
});

describe('isAuthError', () => {
  test('recognises login problems from az and gh', () => {
    const samples = [
      "ERROR: Please run 'az login' to setup account.",
      'AADSTS70043: The refresh token has expired',
      'To get started with GitHub CLI, please run:  gh auth login',
      'HTTP 401: Bad credentials',
      'The access token has expired',
      'authentication required',
    ];
    for (const sample of samples) expect(isAuthError(sample)).toBe(true);
  });

  test('does not call network or lookup errors an auth problem', () => {
    for (const sample of [
      'getaddrinfo ENOTFOUND',
      'request timed out',
      'ResourceNotFound: app does not exist',
    ]) {
      expect(isAuthError(sample)).toBe(false);
    }
  });
});

describe('stateDir', () => {
  test('uses XDG_STATE_HOME when set', () => {
    expect(stateDir({ XDG_STATE_HOME: '/state' }, '/home/u', 'example-app')).toBe(
      '/state/example-app/secret-rotation',
    );
  });

  test('falls back to ~/.local/state', () => {
    expect(stateDir({}, '/home/u', 'example-app')).toBe('/home/u/.local/state/example-app/secret-rotation');
  });
});

describe('stateDir name', () => {
  test('uses the name of the project it is given', () => {
    expect(stateDir({}, '/home/u', 'shop')).toBe('/home/u/.local/state/shop/secret-rotation');
  });
});

describe('canEnforcePermissions', () => {
  test('is true on a filesystem that keeps the mode it was given', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'perm-'));
    try {
      expect(canEnforcePermissions(dir)).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is false when the mode comes back wider than asked, like on NTFS', () => {
    const removed = [];
    const ops = {
      writeFileSync: () => {},
      chmodSync: () => {},
      statSync: () => ({ mode: 0o100777 }),
      unlinkSync: (file) => removed.push(file),
    };
    expect(canEnforcePermissions('/mnt/ntfs', ops)).toBe(false);
    expect(removed).toHaveLength(1);
  });

  test('is false when the folder cannot be written at all', () => {
    const ops = {
      writeFileSync: () => {
        throw new Error('read only');
      },
      chmodSync: () => {},
      statSync: () => ({ mode: 0o100600 }),
      unlinkSync: () => {},
    };
    expect(canEnforcePermissions('/ro', ops)).toBe(false);
  });
});

describe('private files', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'safety-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('ensurePrivateDir creates nested folders readable only by the owner', () => {
    const target = path.join(dir, 'a', 'b');
    ensurePrivateDir(target);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  test('ensurePrivateDir tightens a folder that was too open', () => {
    const target = path.join(dir, 'open');
    ensurePrivateDir(target);
    chmodSync(target, 0o755);
    ensurePrivateDir(target);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  test('ensurePrivateDir refuses a filesystem that ignores permissions', () => {
    const ops = {
      mkdirSync: () => {},
      chmodSync: () => {},
      statSync: () => ({ mode: 0o40777 }),
    };
    expect(() => ensurePrivateDir('/mnt/ntfs/secrets', ops)).toThrow(/private/i);
  });

  test('writePrivateFile writes a file only the owner can read', () => {
    const file = path.join(dir, 'backup.json');
    writePrivateFile(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('writePrivateFile refuses when the mode could not be set', () => {
    const ops = {
      writeFileSync: () => {},
      renameSync: () => {},
      chmodSync: () => {},
      statSync: () => ({ mode: 0o100666 }),
    };
    expect(() => writePrivateFile('/mnt/ntfs/x', 'secret', ops)).toThrow(/private/i);
  });

  test('secureDelete overwrites the content before removing the file', () => {
    const file = path.join(dir, 'old.json');
    writeFileSync(file, 'top-secret-old-value');
    const written = [];
    const ops = {
      statSync,
      writeFileSync: (target, data) => {
        written.push({ target, size: data.length });
        writeFileSync(target, data);
      },
      unlinkSync: (target) => rmSync(target),
    };
    secureDelete(file, ops);
    expect(written).toEqual([{ target: file, size: 'top-secret-old-value'.length }]);
    expect(existsSync(file)).toBe(false);
  });

  test('secureDelete does nothing for a file that is already gone', () => {
    expect(() => secureDelete(path.join(dir, 'missing'))).not.toThrow();
  });
});

describe('acquireLock', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a second run is refused while the first one is alive', () => {
    const release = acquireLock(dir);
    expect(() => acquireLock(dir)).toThrow(/already running/i);
    release();
  });

  test('the lock can be taken again after it is released', () => {
    acquireLock(dir)();
    expect(() => acquireLock(dir)()).not.toThrow();
  });

  test('a lock left behind by a dead process is taken over', () => {
    writeFileSync(path.join(dir, 'rotation.lock'), '999999');
    const release = acquireLock(dir, { isAlive: () => false });
    expect(readFileSync(path.join(dir, 'rotation.lock'), 'utf8')).toBe(String(process.pid));
    release();
  });
});

describe('previewValue', () => {
  test('shows a value that is not secret in full', () => {
    expect(previewValue('example-app-user', false)).toBe('example-app-user');
  });

  test('shows only the first three characters of a secret, then an ellipsis', () => {
    expect(previewValue('abcdef123456', true)).toBe('abc…');
  });

  test('hides a short secret completely, because three characters would be half of it', () => {
    expect(previewValue('abcdef', true)).toBe('…');
    expect(previewValue('ab', true)).toBe('…');
  });

  test('shortens a long value that is not secret', () => {
    const shown = previewValue('x'.repeat(100), false);
    expect(shown.length).toBeLessThan(70);
    expect(shown.endsWith('…')).toBe(true);
  });

  test('says nothing when there is no value', () => {
    expect(previewValue(undefined, true)).toBeUndefined();
    expect(previewValue('', false)).toBeUndefined();
  });
});
