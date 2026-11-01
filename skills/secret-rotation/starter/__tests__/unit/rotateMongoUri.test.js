import { buildMongoUri, readMongoLogin } from '../../scripts/lib/mongo-uri.mjs';

const base =
  'mongodb+srv://olduser:oldpass@cluster0.abc12.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

describe('buildMongoUri', () => {
  test('swaps the user and password and keeps the host, path and options', () => {
    const result = buildMongoUri({ user: 'newuser', password: 'newpass', base });
    expect(result).toEqual({
      ok: true,
      value:
        'mongodb+srv://newuser:newpass@cluster0.abc12.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',
    });
  });

  test('percent-encodes characters that would break the string', () => {
    const password = 'p@ss/w:rd#?%&=+ x';
    const result = buildMongoUri({ user: 'a@b', password, base });
    expect(result.ok).toBe(true);
    const url = new URL(result.value);
    expect(decodeURIComponent(url.username)).toBe('a@b');
    expect(decodeURIComponent(url.password)).toBe(password);
    expect(url.hostname).toBe('cluster0.abc12.mongodb.net');
    expect(url.search).toBe('?retryWrites=true&w=majority&appName=Cluster0');
  });

  test('works when the current string has no credentials or no options', () => {
    expect(
      buildMongoUri({ user: 'u', password: 'p', base: 'mongodb+srv://cluster0.example.net' }).value,
    ).toBe('mongodb+srv://u:p@cluster0.example.net');
    expect(
      buildMongoUri({ user: 'u', password: 'p', base: 'mongodb+srv://x:y@cluster0.example.net/' })
        .value,
    ).toBe('mongodb+srv://u:p@cluster0.example.net/');
  });

  test('keeps a database name and a list of hosts', () => {
    const result = buildMongoUri({
      user: 'u',
      password: 'p',
      base: 'mongodb://x:y@h1:27017,h2:27017/mydb?replicaSet=rs0',
    });
    expect(result.value).toBe('mongodb://u:p@h1:27017,h2:27017/mydb?replicaSet=rs0');
  });

  test('asks for the full string when there is no current one to copy the host from', () => {
    for (const missing of [undefined, '', 'not a connection string', 'https://x:y@host/']) {
      const result = buildMongoUri({ user: 'u', password: 'p', base: missing });
      expect(result.ok).toBe(false);
      expect(result.problem).toMatch(/connection string/i);
    }
  });

  test('refuses an empty user or password', () => {
    expect(buildMongoUri({ user: '', password: 'p', base }).ok).toBe(false);
    expect(buildMongoUri({ user: 'u', password: '', base }).ok).toBe(false);
  });

  test('never puts the old credentials into the result', () => {
    const result = buildMongoUri({ user: 'newuser', password: 'newpass', base });
    expect(result.value).not.toContain('oldpass');
    expect(result.value).not.toContain('olduser');
  });
});

describe('readMongoLogin', () => {
  test('reads the user and password of a connection string', () => {
    expect(readMongoLogin(base)).toEqual({ user: 'olduser', password: 'oldpass' });
  });

  test('decodes what buildMongoUri encoded, so the two agree', () => {
    const built = buildMongoUri({ user: 'a@b', password: 'p@ss/w:rd#?', base });
    expect(readMongoLogin(built.value)).toEqual({ user: 'a@b', password: 'p@ss/w:rd#?' });
  });

  test('is undefined when there is no login or the string cannot be read', () => {
    expect(readMongoLogin('mongodb+srv://cluster0.example.net/')).toBeUndefined();
    expect(readMongoLogin('nonsense')).toBeUndefined();
    expect(readMongoLogin(undefined)).toBeUndefined();
  });
});
