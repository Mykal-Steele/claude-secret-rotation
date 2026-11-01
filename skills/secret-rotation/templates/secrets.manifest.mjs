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
//   external  an id from CONFIG.externals, something outside the app platform that has
//             to change first
//   slow      a hint shown in the checklist
//
// DERIVED values are built from other values, so they are never asked for.

import { buildMongoUri, readMongoLogin } from './lib/mongo-uri.mjs';

const ENV = ['.env.development', '.env.production'];

export const SECRETS = {
  DATABASE_URL: {
    format: 'mongo-uri',
    files: ENV,
    github: true,
    azure: { secret: 'database-url' },
  },
  SESSION_SECRET: {
    format: 'generated',
    generate: 'hex32',
    files: ENV,
    github: true,
    azure: { secret: 'session-secret' },
  },
  EMAIL_API_KEY: {
    format: 'resend-key',
    files: ENV,
    github: false,
    azure: { secret: 'email-api-key' },
  },
  APP_URL: { config: true, files: ENV, github: true, azure: { env: 'APP_URL' } },
};

export const CONFIG_ONLY = new Set(
  Object.entries(SECRETS)
    .filter(([, spec]) => spec.config)
    .map(([key]) => key),
);

export const DERIVED = {};

export const GROUPS = [
  {
    id: 'database',
    title: 'MongoDB Atlas',
    keys: ['DATABASE_URL'],
    how: [
      'Atlas, Security, Database Access, Add New Database User.',
      'Authentication Method: Password. Choose a user name, click Autogenerate Secure Password and copy it.',
      'Database User Privileges, Specific Privileges: add readWrite on the one database the app uses and remove every other privilege. Add User.',
      'Type the user name and the password here. The connection string is built from them and the host in your current one, so there is nothing to copy from Connect.',
    ],
    why: 'A second user lets the app keep running on the old one until the new one is proven, and lets the tool switch back if the new one fails. The old user is deleted at the end. The host and options never change between rotations, so only the login is asked for.',
    inputs: [
      {
        name: 'user',
        label: 'MongoDB user name',
        mask: false,
        current: (read) => readMongoLogin(read('DATABASE_URL'))?.user,
        keptNote:
          'Same user name: if you already changed its password in Atlas, the old password no longer works, so a rollback cannot restore a working login. A second user avoids that.',
      },
      {
        name: 'password',
        label: 'MongoDB password',
        mask: true,
        current: (read) => readMongoLogin(read('DATABASE_URL'))?.password,
      },
    ],
    build: ({ user, password }, current) => {
      const result = buildMongoUri({ user, password, base: current('DATABASE_URL') });
      return result.ok ? { ok: true, values: { DATABASE_URL: result.value } } : result;
    },
    revoke: 'Atlas, Database Access: delete the old database user.',
    verify: { type: 'mongo', inputs: { uri: 'DATABASE_URL' } },
  },
  {
    id: 'session',
    title: 'Session secret',
    keys: ['SESSION_SECRET'],
    generate: true,
    effect: 'Everyone is signed out.',
  },
  {
    id: 'email',
    title: 'Resend',
    keys: ['EMAIL_API_KEY'],
    how: [
      'Resend dashboard, API Keys, Create API Key.',
      'Permission: Sending access. Domain: your sending domain.',
      'Copy the key, it is shown once.',
    ],
    why: 'The old key keeps working until you delete it. Sending access is enough when the app only sends mail.',
    revoke: 'Resend, API Keys: delete the old key.',
    verify: { type: 'resend', inputs: { key: 'EMAIL_API_KEY' } },
  },
];

// Not managed here. Set these by hand.
export const NOT_MANAGED = {};
