// Test data. A frozen copy of the shapes the library reads, so these tests do not
// depend on the real manifest of whichever repository the tools are installed in.

// Every value the rotation tools manage, and how each one is handled. A different
// repository edits this file and secrets.config.mjs, and nothing else.
//
// SECRETS, one entry per env var:
//   format    how to check what you paste (a format id from lib/validate.mjs), or
//             'generated' for values the tool makes itself
//   generate  'hex32' when the tool can make a new value
//   config    true for settings that are not credentials, they are never rotated
//   files     env files that hold it. Keys missing from a file are added
//   fileKeys  the key name in a file that uses a different name for it
//   github    push it as a GitHub Actions secret
//   azure     { secret: 'name' } for a Container App secret, { env: 'NAME' } for a
//             plain env var, or null
//
// GROUPS, what the wizard shows. Keys in a group come from one place and have to
// match each other, so they are rotated together:
//   how       exact steps at the provider
//   inputs    ask for parts (name, label, mask, current(read) for what is in use, keptNote
//             to warn when a part is kept) instead of the values themselves, and
//   build     (parts, current) => { ok, values } turns them into the values of the group.
//             Falls back to asking for the values directly when it cannot build them
//   why       why the steps are in this order
//   revoke    what to delete once the site runs on the new value
//   effect    what people notice while it changes
//   generate  the tool makes the values itself
//   verify    { type, inputs } how the new value is tested before it is used. Inputs map
//             the check's roles to env var names
//   external  an id from CONFIG.externals, something outside Azure, GitHub and the env
//             files that has to change first (a VM that checks the token)
//   slow      a hint shown in the checklist
//
// DERIVED values are built from other values, so they are never asked for.

import { buildMongoUri, readMongoLogin } from '../../../scripts/lib/mongo-uri.mjs';

const ENV = ['.env.development', '.env.production'];

export const SECRETS = {
  MONGO_URI: {
    format: 'mongo-uri',
    files: [...ENV, 'backend-go/.env'],
    github: true,
    azure: { secret: 'mongo-uri' },
  },
  JWT_SECRET: {
    format: 'generated',
    generate: 'hex32',
    files: [...ENV, 'backend-go/.env'],
    github: true,
    azure: { secret: 'jwt-secret' },
  },
  REFRESH_TOKEN_SECRET: {
    format: 'generated',
    generate: 'hex32',
    files: ENV,
    github: true,
    azure: { secret: 'refresh-token-secret' },
  },
  CLIENT_URL: { config: true, files: ENV, github: true, azure: { env: 'CLIENT_URL' } },
  CLOUDINARY_NAME: { config: true, files: ENV, github: true, azure: { env: 'CLOUDINARY_NAME' } },
  CLOUDINARY_KEY: {
    format: 'cloudinary-key',
    files: ENV,
    github: true,
    azure: { secret: 'cloudinary-key' },
  },
  CLOUDINARY_SECRET: {
    format: 'cloudinary-secret',
    files: ENV,
    github: true,
    azure: { secret: 'cloudinary-secret' },
  },
  CLOUDINARY_URL: { files: ENV, github: true, azure: { secret: 'cloudinary-url' } },
  RESEND_API_KEY: {
    format: 'resend-key',
    files: ENV,
    github: false,
    azure: { secret: 'resend-api-key' },
  },
  RUNNER_URL: { config: true, files: ENV, github: true, azure: { secret: 'runner-url' } },
  RUNNER_TOKEN: {
    format: 'generated',
    generate: 'hex32',
    files: [...ENV, 'infra/.secrets/runner-deploy.env'],
    fileKeys: { 'infra/.secrets/runner-deploy.env': 'RUNNER_AUTH_TOKEN' },
    github: true,
    azure: { secret: 'runner-token' },
  },
  RUNNER_CA_CERT: { config: true, files: ENV, github: true, azure: { secret: 'runner-ca-cert' } },
  R2_ACCOUNT_ID: { config: true, files: ENV, github: true, azure: { env: 'R2_ACCOUNT_ID' } },
  R2_ACCESS_KEY_ID: {
    format: 'r2-access-key-id',
    files: ENV,
    github: true,
    azure: { secret: 'r2-access-key-id' },
  },
  R2_SECRET_ACCESS_KEY: {
    format: 'r2-secret-access-key',
    files: ENV,
    github: true,
    azure: { secret: 'r2-secret-access-key' },
  },
  R2_BUCKET: { config: true, files: ENV, github: true, azure: { env: 'R2_BUCKET' } },
  R2_PUBLIC_URL: { config: true, files: ENV, github: true, azure: { env: 'R2_PUBLIC_URL' } },
  // Turnstile stays off GitHub on purpose: the backend skips the check unless it has
  // both keys, and CI is meant to run with it skipped.
  TURNSTILE_SITE_KEY: {
    config: true,
    files: ENV,
    github: false,
    azure: { env: 'TURNSTILE_SITE_KEY' },
  },
  TURNSTILE_SECRET_KEY: {
    format: 'turnstile-secret',
    files: ENV,
    github: false,
    azure: { secret: 'turnstile-secret-key' },
  },
  VITE_GEMINI_API_KEY: {
    format: 'gemini-key',
    files: ['.env', ...ENV, 'ai-slop/AI-Slop-For-CAO-exam/.env.development'],
    github: true,
    azure: null,
  },
  // Only the dev-only /performance page reads it, so it never leaves scripts/.env.
  AUDIT_PASSWORD: {
    format: 'generated',
    generate: 'hex32',
    files: ['scripts/.env'],
    github: false,
    azure: null,
  },
};

export const CONFIG_ONLY = new Set(
  Object.entries(SECRETS)
    .filter(([, spec]) => spec.config)
    .map(([key]) => key),
);

export const DERIVED = {
  CLOUDINARY_URL: {
    group: 'cloudinary',
    from: ['CLOUDINARY_KEY', 'CLOUDINARY_SECRET'],
    needs: ['CLOUDINARY_NAME'],
    build: (v) => `cloudinary://${v.CLOUDINARY_KEY}:${v.CLOUDINARY_SECRET}@${v.CLOUDINARY_NAME}`,
  },
};

export const GROUPS = [
  {
    id: 'mongo',
    title: 'MongoDB Atlas',
    keys: ['MONGO_URI'],
    how: [
      'Atlas, Security, Database Access, Add New Database User.',
      'Authentication Method: Password. Choose a user name, click Autogenerate Secure Password and copy it.',
      'Database User Privileges, Specific Privileges: add readWrite on the database "test" and remove every other privilege. Add User.',
      'Type the user name and the password here. The connection string is built from them and the host in your current one, so there is nothing to copy from Connect.',
    ],
    why: 'A second user lets the app keep running on the old one until the new one is proven, and lets this tool switch back if the new one fails. Changing the password of the live user breaks the app until it restarts and leaves nothing to go back to. The old user is deleted at the end. The host and options never change between rotations, so only the login is asked for.',
    inputs: [
      {
        name: 'user',
        label: 'MongoDB user name',
        mask: false,
        current: (read) => readMongoLogin(read('MONGO_URI'))?.user,
        keptNote:
          'Same user name: if you already changed its password in Atlas, the old password no longer works, so a rollback cannot restore a working login. A second user avoids that.',
      },
      {
        name: 'password',
        label: 'MongoDB password',
        mask: true,
        current: (read) => readMongoLogin(read('MONGO_URI'))?.password,
      },
    ],
    build: ({ user, password }, current) => {
      const result = buildMongoUri({ user, password, base: current('MONGO_URI') });
      return result.ok ? { ok: true, values: { MONGO_URI: result.value } } : result;
    },
    revoke: 'Atlas, Database Access: delete the old database user.',
    verify: { type: 'mongo', inputs: { uri: 'MONGO_URI' } },
  },
  {
    id: 'cloudinary',
    title: 'Cloudinary',
    keys: ['CLOUDINARY_KEY', 'CLOUDINARY_SECRET'],
    how: [
      'Cloudinary console, Settings (gear icon), API Keys.',
      'Click Generate New API Key.',
      'Copy the API Key, then the API Secret. CLOUDINARY_URL is built from them, do not copy it.',
    ],
    why: 'The old key keeps working until you delete it, so nothing breaks while the app switches over.',
    revoke: 'Cloudinary, Settings, API Keys: delete the old key.',
    verify: {
      type: 'cloudinary',
      inputs: { name: 'CLOUDINARY_NAME', key: 'CLOUDINARY_KEY', secret: 'CLOUDINARY_SECRET' },
    },
  },
  {
    id: 'resend',
    title: 'Resend',
    keys: ['RESEND_API_KEY'],
    how: [
      'Resend dashboard, API Keys, Create API Key.',
      'Permission: Sending access. Domain: your sending domain.',
      'Copy the key, it is shown once.',
    ],
    why: 'The old key keeps working until you delete it. Sending access is enough because the app only sends mail, so a leaked key cannot read or change anything else.',
    revoke: 'Resend, API Keys: delete the old key.',
    verify: { type: 'resend', inputs: { key: 'RESEND_API_KEY' } },
  },
  {
    id: 'r2',
    title: 'Cloudflare R2',
    keys: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
    how: [
      'Cloudflare dashboard, R2 Object Storage, Manage API Tokens, Create API token.',
      'Permission: Object Read & Write. Apply to specific buckets only: the bucket the app uses.',
      'Create. Copy the Access Key ID and the Secret Access Key, both are shown once.',
    ],
    why: 'The old token keeps working until you delete it. A token limited to one bucket cannot touch anything else in the account.',
    revoke: 'Cloudflare, R2, Manage API Tokens: delete the old token.',
    verify: {
      type: 'r2',
      inputs: {
        accountId: 'R2_ACCOUNT_ID',
        bucket: 'R2_BUCKET',
        accessKeyId: 'R2_ACCESS_KEY_ID',
        secretAccessKey: 'R2_SECRET_ACCESS_KEY',
      },
    },
  },
  {
    id: 'turnstile',
    title: 'Cloudflare Turnstile',
    keys: ['TURNSTILE_SECRET_KEY'],
    how: [
      'Cloudflare dashboard, Turnstile, open your widget, Settings.',
      'Click Rotate secret key. If it asks, choose to keep the old key valid for a while.',
      'Copy the new secret key. The site key does not change.',
    ],
    why: 'Rotating cancels the old secret. Keeping it valid for a while stops the upload form failing until the app runs on the new one.',
    revoke: 'Turnstile: if you kept the old key valid, invalidate it now.',
    verify: { type: 'turnstile', inputs: { secret: 'TURNSTILE_SECRET_KEY' } },
  },
  {
    id: 'gemini',
    title: 'Google AI Studio (Gemini)',
    keys: ['VITE_GEMINI_API_KEY'],
    how: [
      'Google AI Studio, Get API key, Create API key. Copy it.',
      'Google Cloud console, APIs & Services, Credentials, open the key, Application restrictions: Websites, add your site domain.',
    ],
    why: 'The key is built into the frontend, so anyone can read it. The domain restriction is what stops others using it. The old key keeps working until you delete it.',
    revoke: 'Google AI Studio, API keys: delete the old key.',
    verify: { type: 'gemini', inputs: { key: 'VITE_GEMINI_API_KEY' } },
  },
  {
    id: 'jwt',
    title: 'Login tokens',
    keys: ['JWT_SECRET', 'REFRESH_TOKEN_SECRET'],
    generate: true,
    effect: 'Everyone is signed out.',
  },
  {
    id: 'audit',
    title: 'Performance report password (dev only)',
    keys: ['AUDIT_PASSWORD'],
    generate: true,
    effect: 'The report must be encrypted again with the new password.',
  },
  {
    id: 'runner',
    title: 'Code runner token',
    keys: ['RUNNER_TOKEN'],
    generate: true,
    external: 'runner',
    slow: 'about 2 minutes',
    effect: 'The code runner is unavailable for a few minutes while its token is changed.',
  },
];

// Not managed here. Set these by hand.
export const NOT_MANAGED = {
  'AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID':
    'deploy identity, not a rotatable secret (az identity show)',
  'CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN': 'GitHub only, token scoped to Zone.Cache Purge',
  'UPTIMEROBOT_API_KEY, DO_API_TOKEN': 'rotate in their dashboards, edit .env.production by hand',
};
