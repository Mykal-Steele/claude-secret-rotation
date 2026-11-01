// A MongoDB connection string is a protocol, a login, one or more hosts, an optional
// database and optional options. Between rotations only the login changes, so the new
// string is built from the current one: same hosts, database and options, new login.
const PARTS = /^(mongodb(?:\+srv)?):\/\/(?:([^@/?]*)@)?([^/?]+)(\/[^?]*)?(\?.*)?$/;

export function buildMongoUri({ user, password, base }) {
  if (!user || !password) return { ok: false, problem: 'Enter a user name and a password.' };
  const parts = PARTS.exec(base ?? '');
  if (!parts) {
    return {
      ok: false,
      problem:
        'The current connection string could not be read, so the host is unknown. Paste the full connection string instead.',
    };
  }
  const [, protocol, , hosts, path = '', query = ''] = parts;
  // Special characters in a login have to be percent-encoded or they end the login early.
  const login = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return { ok: true, value: `${protocol}://${login}@${hosts}${path}${query}` };
}

// The user and password in a connection string, decoded, so a prompt can show what is
// current. Undefined when there is no login or the string cannot be read.
export function readMongoLogin(uri) {
  const login = PARTS.exec(uri ?? '')?.[2];
  const split = login?.indexOf(':') ?? -1;
  if (split < 1) return undefined;
  try {
    return {
      user: decodeURIComponent(login.slice(0, split)),
      password: decodeURIComponent(login.slice(split + 1)),
    };
  } catch {
    return undefined;
  }
}
