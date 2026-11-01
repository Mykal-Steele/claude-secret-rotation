import { SECRETS } from '../secrets.manifest.mjs';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function cleanInput(raw, key) {
  let value = String(raw ?? '').trim();
  if (key)
    value = value.replace(new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*`), '').trim();
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && first === value.at(-1)) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

const fail = (problem) => ({ ok: false, problem });
const pass = (value, warnings = []) => ({ ok: true, value, warnings });

function checkMongoUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail('This is not a valid connection string. It should start with mongodb+srv://');
  }
  if (url.protocol !== 'mongodb+srv:' && url.protocol !== 'mongodb:') {
    return fail('Connection strings start with mongodb:// or mongodb+srv://');
  }
  const authority = value.slice(value.indexOf('://') + 3).split('/')[0];
  if ((authority.match(/@/g) ?? []).length > 1) {
    return fail(
      'The password contains an @. Replace it with %40, special characters have to be percent-encoded.',
    );
  }
  if (!url.username || !url.password) {
    return fail('The connection string needs a user name and a password (user:password@host).');
  }
  if (!url.hostname) return fail('The connection string has no host.');
  const warnings = [];
  if (url.pathname && url.pathname !== '/') {
    warnings.push(
      `The string names a database ("${url.pathname.slice(1)}"). The app uses the default database, so leave the database name out.`,
    );
  }
  return pass(value, warnings);
}

const SECRET_LIKE = /^[A-Za-z0-9_-]{20,40}$/;

// What each provider's values look like. A manifest entry names one with `format`, so
// the rule follows the credential, not the name of the env var that holds it.
const FORMATS = {
  'mongo-uri': checkMongoUri,
  'cloudinary-key'(value) {
    if (/^\d{10,20}$/.test(value)) return pass(value);
    if (SECRET_LIKE.test(value) && /[A-Za-z]/.test(value)) {
      return fail('This looks like the API secret, not the key. Cloudinary API keys are numbers.');
    }
    return fail('Cloudinary API keys are numbers, usually 15 digits.');
  },
  'cloudinary-secret'(value) {
    if (/^\d{10,20}$/.test(value))
      return fail('This looks like the API key, not the secret. Secrets contain letters.');
    if (SECRET_LIKE.test(value)) return pass(value);
    return fail('Cloudinary API secrets are 20 to 40 letters, digits, - and _.');
  },
  'resend-key': (value) =>
    /^re_[A-Za-z0-9_-]{16,}$/.test(value) ? pass(value) : fail('Resend keys start with re_'),
  'r2-access-key-id'(value) {
    if (/^[0-9a-f]{32}$/i.test(value)) return pass(value);
    if (/^[0-9a-f]{64}$/i.test(value)) {
      return fail(
        'This looks like the secret access key (64 characters). The access key ID is 32.',
      );
    }
    return fail('R2 access key IDs are 32 hex characters.');
  },
  'r2-secret-access-key': (value) =>
    /^[0-9a-f]{64}$/i.test(value)
      ? pass(value)
      : fail('R2 secret access keys are 64 hex characters.'),
  'turnstile-secret': (value) =>
    /^0x[A-Za-z0-9_-]{20,}$/.test(value)
      ? pass(value)
      : fail('Turnstile secret keys start with 0x'),
  'gemini-key'(value) {
    const ok = /^AIza[0-9A-Za-z_-]{35}$/.test(value) || /^AQ\.[0-9A-Za-z_.-]{20,}$/.test(value);
    return ok ? pass(value) : fail('Gemini keys start with AIza or AQ.');
  },
  generated: (value) =>
    value.length >= 32
      ? pass(value)
      : fail(
          'Secrets typed by hand need at least 32 characters. Let the wizard generate one instead.',
        ),
};

export const FORMAT_IDS = Object.keys(FORMATS);

export function validateValue(key, raw, { secrets = SECRETS } = {}) {
  const value = cleanInput(raw, key);
  if (!value) return fail('Nothing was entered.');
  if (/\s/.test(value)) return fail('This contains a space or a line break. Paste only the value.');
  if (/<[^>\s]+>/.test(value))
    return fail('This still contains a <placeholder>. Replace it with the real value.');
  const format = secrets[key]?.format;
  if (!format) return pass(value);
  if (!FORMATS[format])
    throw new Error(`${key} has an unknown format "${format}". Known: ${FORMAT_IDS.join(', ')}`);
  return FORMATS[format](value);
}
