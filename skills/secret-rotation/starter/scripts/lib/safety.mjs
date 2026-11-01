import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export function fingerprint(value) {
  return createHash('sha256').update(`example-app-rotation:${value}`).digest('hex').slice(0, 6);
}

// Length and fingerprint tell you whether a value changed without showing any of it.
export function describeValue(value) {
  return `${value.length} characters, fingerprint ${fingerprint(value)}`;
}

// What to show next to a prompt for the value that is current now. A value that is not
// secret is shown, a secret shows its first three characters, and a short secret nothing,
// because three characters would be half of it.
export function previewValue(value, secret) {
  if (!value) return undefined;
  if (secret) return value.length > 6 ? `${value.slice(0, 3)}…` : '…';
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

export function redact(text, secrets) {
  let out = String(text);
  const values = secrets
    .filter((secret) => typeof secret === 'string' && secret.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const secret of values) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join('***');
    }
  }
  return out;
}

export async function withRetry(
  fn,
  {
    tries = 3,
    baseMs = 1000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    retryIf = () => true,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= tries || !retryIf(error)) throw error;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
}

const AUTH_PATTERNS = [
  /az login/i,
  /AADSTS\d+/,
  /gh auth login/i,
  /HTTP 401/i,
  /access token (has )?expired/i,
  /refresh token has expired/i,
  /authentication required/i,
  /not logged in/i,
  /bad credentials/i,
];

export const isAuthError = (text) => AUTH_PATTERNS.some((pattern) => pattern.test(String(text)));

// The folder that keeps the old values of a rotation, one per project.
export function stateDir(env, home, name) {
  const base = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(base, name, 'secret-rotation');
}

const FS = { mkdirSync, chmodSync, statSync, writeFileSync, renameSync, unlinkSync };

const notPrivate = (target, mode) =>
  new Error(
    `Cannot keep ${target} private: this filesystem ignores permissions (mode ${mode.toString(8)}). ` +
      'Set XDG_STATE_HOME to a folder on a normal Linux filesystem.',
  );

// The old secrets are kept here until you revoke them, so the folder has to be
// owner-only. Some drives (NTFS, exFAT) accept chmod and ignore it, so the mode is
// read back instead of trusted.
export function ensurePrivateDir(dir, ops = FS) {
  ops.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ops.chmodSync(dir, 0o700);
  const mode = ops.statSync(dir).mode & 0o777;
  if (mode !== 0o700) throw notPrivate(dir, mode);
}

export function writePrivateFile(file, content, ops = FS) {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    ops.writeFileSync(temp, content, { mode: 0o600 });
    ops.chmodSync(temp, 0o600);
    const mode = ops.statSync(temp).mode & 0o777;
    if (mode !== 0o600) throw notPrivate(file, mode);
    ops.renameSync(temp, file);
  } catch (error) {
    try {
      ops.unlinkSync(temp);
    } catch {}
    throw error;
  }
}

// Overwrites before unlinking. A copy-on-write filesystem (btrfs) can still keep
// old blocks, so this is a best effort, the real fix is revoking the credentials.
export function secureDelete(file, ops = { statSync, writeFileSync, unlinkSync }) {
  let size;
  try {
    size = ops.statSync(file).size;
  } catch {
    return;
  }
  ops.writeFileSync(file, randomBytes(size));
  ops.unlinkSync(file);
}

// Some drives (NTFS, exFAT) accept chmod and ignore it. This writes a probe file,
// asks for owner-only and reads the mode back, so a warning can say whether chmod
// would help or the repo has to move.
export function canEnforcePermissions(
  dir,
  ops = { writeFileSync, chmodSync, statSync, unlinkSync },
) {
  const probe = path.join(dir, `.perm-probe-${randomBytes(4).toString('hex')}`);
  try {
    ops.writeFileSync(probe, '', { mode: 0o600 });
    ops.chmodSync(probe, 0o600);
    return (ops.statSync(probe).mode & 0o077) === 0;
  } catch {
    return false;
  } finally {
    try {
      ops.unlinkSync(probe);
    } catch {}
  }
}

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export function acquireLock(dir, { isAlive = processIsAlive } = {}) {
  const lock = path.join(dir, 'rotation.lock');
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = Number(readFileSync(lock, 'utf8'));
    if (holder && isAlive(holder))
      throw new Error(`Another rotation is already running (process ${holder}).`);
    writeFileSync(lock, String(process.pid), { mode: 0o600 });
  }
  return () => {
    try {
      if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
    } catch {}
  };
}
