import { cleanInput, validateValue } from '../../scripts/lib/validate.mjs';
import { SECRETS } from './fixtures/manifest.fixture.mjs';

const validate = (key, raw, options = {}) =>
  validateValue(key, raw, { secrets: SECRETS, ...options });

const hex = (n) => 'a1b2c3d4e5f60718'.repeat(Math.ceil(n / 16)).slice(0, n);
const alnum = (n) => 'aB3xY9kLmN2pQ7rS5tU8vW1zC4dE6fG0hJ'.repeat(3).slice(0, n);

describe('cleanInput', () => {
  test('trims whitespace and trailing newlines', () => {
    expect(cleanInput('  abc\n')).toBe('abc');
  });

  test('strips one pair of matching quotes', () => {
    expect(cleanInput('"abc"')).toBe('abc');
    expect(cleanInput("'abc'")).toBe('abc');
    expect(cleanInput('"abc\'')).toBe('"abc\'');
  });

  test('strips a pasted KEY= prefix, with or without export', () => {
    expect(cleanInput('RESEND_API_KEY=re_abc', 'RESEND_API_KEY')).toBe('re_abc');
    expect(cleanInput('export RESEND_API_KEY="re_abc"', 'RESEND_API_KEY')).toBe('re_abc');
  });

  test('keeps an = that belongs to the value', () => {
    expect(cleanInput('abc=def', 'RESEND_API_KEY')).toBe('abc=def');
  });
});

describe('validateValue general rules', () => {
  test('rejects an empty value', () => {
    expect(validate('JWT_SECRET', '   ').ok).toBe(false);
  });

  test('rejects whitespace inside a value', () => {
    const result = validate('JWT_SECRET', hex(40) + ' ' + hex(10));
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/space|whitespace/i);
  });

  test('rejects an <angle bracket> placeholder', () => {
    const result = validate('CLOUDINARY_SECRET', '<your_api_secret>');
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/placeholder/i);
  });

  test('returns the cleaned value on success', () => {
    const result = validate('RESEND_API_KEY', ` "re_${alnum(33)}" \n`);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(`re_${alnum(33)}`);
  });
});

describe('MONGO_URI', () => {
  const good = 'mongodb+srv://example-app-user:S3cretPass@cluster0.abc12.mongodb.net/';

  test('accepts a normal Atlas string', () => {
    const result = validate('MONGO_URI', good);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('rejects the <db_password> placeholder', () => {
    const result = validate(
      'MONGO_URI',
      'mongodb+srv://u:<db_password>@cluster0.abc12.mongodb.net/',
    );
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/<db_password>|placeholder/i);
  });

  test('rejects a string without a password', () => {
    expect(validate('MONGO_URI', 'mongodb+srv://cluster0.abc12.mongodb.net/').ok).toBe(false);
    expect(validate('MONGO_URI', 'mongodb+srv://user@cluster0.abc12.mongodb.net/').ok).toBe(
      false,
    );
  });

  test('rejects another scheme', () => {
    const result = validate('MONGO_URI', 'https://u:p@cluster0.abc12.mongodb.net/');
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/mongodb/);
  });

  test('warns when a database name is in the path, because the app uses the default one', () => {
    const result = validate(
      'MONGO_URI',
      'mongodb+srv://u:p4ss@cluster0.abc12.mongodb.net/mydb?retryWrites=true',
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/database/i);
  });

  test('rejects a password with an unescaped @', () => {
    const result = validate('MONGO_URI', 'mongodb+srv://u:pa@ss@cluster0.abc12.mongodb.net/');
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/encode|@/i);
  });
});

describe('Cloudinary', () => {
  test('accepts a numeric API key', () => {
    expect(validate('CLOUDINARY_KEY', '123456789012345').ok).toBe(true);
  });

  test('points out when the secret was pasted into the key field', () => {
    const result = validate('CLOUDINARY_KEY', alnum(27));
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/secret/i);
  });

  test('accepts a secret with letters, digits, - and _', () => {
    expect(validate('CLOUDINARY_SECRET', 'aB3xY9kLm-N2pQ7rS5tU_8vW1z').ok).toBe(true);
  });

  test('points out when the key was pasted into the secret field', () => {
    const result = validate('CLOUDINARY_SECRET', '123456789012345');
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/key/i);
  });
});

describe('other providers', () => {
  test('Resend keys start with re_', () => {
    expect(validate('RESEND_API_KEY', `re_${alnum(33)}`).ok).toBe(true);
    expect(validate('RESEND_API_KEY', alnum(36)).ok).toBe(false);
  });

  test('R2 access key id is 32 hex characters and the secret is 64', () => {
    expect(validate('R2_ACCESS_KEY_ID', hex(32)).ok).toBe(true);
    expect(validate('R2_SECRET_ACCESS_KEY', hex(64)).ok).toBe(true);
    expect(validate('R2_ACCESS_KEY_ID', hex(31)).ok).toBe(false);
    expect(validate('R2_SECRET_ACCESS_KEY', hex(32)).ok).toBe(false);
  });

  test('points out when the R2 secret was pasted into the key id field', () => {
    const result = validate('R2_ACCESS_KEY_ID', hex(64));
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/secret/i);
  });

  test('Turnstile secret keys start with 0x', () => {
    expect(validate('TURNSTILE_SECRET_KEY', `0x4${alnum(30)}`).ok).toBe(true);
    expect(validate('TURNSTILE_SECRET_KEY', alnum(34)).ok).toBe(false);
  });

  test('Gemini keys can be AIza or AQ. style', () => {
    expect(validate('VITE_GEMINI_API_KEY', `AIza${alnum(35)}`).ok).toBe(true);
    expect(validate('VITE_GEMINI_API_KEY', `AQ.${alnum(50)}`).ok).toBe(true);
    expect(validate('VITE_GEMINI_API_KEY', alnum(39)).ok).toBe(false);
  });

  test('generated secrets need at least 32 characters when typed by hand', () => {
    expect(validate('JWT_SECRET', hex(64)).ok).toBe(true);
    const short = validate('JWT_SECRET', 'abc');
    expect(short.ok).toBe(false);
    expect(short.problem).toMatch(/32/);
  });

  test('a key without a specific rule only needs to be a single token', () => {
    expect(validate('SOMETHING_ELSE', 'abc').ok).toBe(true);
  });
});

describe('validation follows the format named in the manifest', () => {
  const secrets = {
    MY_DB: { format: 'mongo-uri' },
    MAIL: { format: 'resend-key' },
    TOKEN: { format: 'generated' },
    PLAIN: {},
  };

  test('a differently named key still gets the rules of its format', () => {
    expect(validate('MY_DB', 'mongodb+srv://cluster0.abc12.mongodb.net/', { secrets }).ok).toBe(
      false,
    );
    expect(
      validate('MY_DB', 'mongodb+srv://u:p4ss@cluster0.abc12.mongodb.net/', { secrets }).ok,
    ).toBe(true);
    expect(validate('MAIL', 'abc', { secrets }).ok).toBe(false);
    expect(validate('MAIL', `re_${alnum(33)}`, { secrets }).ok).toBe(true);
  });

  test('a generated format needs 32 characters when typed by hand', () => {
    expect(validate('TOKEN', 'abc', { secrets }).problem).toMatch(/32/);
    expect(validate('TOKEN', hex(64), { secrets }).ok).toBe(true);
  });

  test('a key with no format only has to be a single token', () => {
    expect(validate('PLAIN', 'abc', { secrets }).ok).toBe(true);
    expect(validate('PLAIN', 'a b', { secrets }).ok).toBe(false);
  });

  test('the same key name means nothing without a format entry', () => {
    expect(validate('RESEND_API_KEY', 'abc', { secrets }).ok).toBe(true);
  });
});
