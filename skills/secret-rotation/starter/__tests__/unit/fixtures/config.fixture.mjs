// Test data. A frozen copy of the config shape, see manifest.fixture.mjs.

// What the rotation tools need to know about this repository that is not a secret.
// A different repository edits this file and secrets.manifest.mjs, and nothing else.
//
//   name             used for the private folder that keeps the old values
//   productionFile   the env file that is the record of what production runs on
//   azure            resource group and Container App name, or null when the app does
//                    not run on Azure Container Apps
//   github           false when secrets are not kept in GitHub Actions
//   dependenciesFrom a package.json whose node_modules hold the database and storage
//                    drivers the live checks use
//   mongo            collections the live login check reads
//   health           the path every health check uses, the public address to probe,
//                    and the header a failover proxy sets when it serves a backup
//   secondaryCopy    a second copy of the app the tools cannot reach (a failover host),
//                    with the keys it needs, so they are listed after every rotation
//   externals        things outside Azure, GitHub and the env files that check a
//                    rotated value and have to change before the app does
//   followUps        commands to offer after a key changes
//   staleDays        a credential older than this is flagged
//   oldBackupDays    saved old values older than this are flagged
export const CONFIG = {
  name: 'example-app',
  productionFile: '.env.production',
  azure: { resourceGroup: 'example-rg', app: 'example-app' },
  github: true,
  dependenciesFrom: 'backend/package.json',
  mongo: { probeCollections: ['users', 'posts'] },
  health: {
    path: '/api/health',
    publicUrl: 'https://example.com',
    backupHeader: {
      name: 'x-served-by',
      value: 'failover-backup',
      note: 'Cloudflare switches back after two good checks, which takes about 10 minutes.',
    },
  },
  secondaryCopy: {
    name: 'Failover host',
    reason: 'the failover copy of the app',
    keys: [
      'MONGO_URI',
      'JWT_SECRET',
      'REFRESH_TOKEN_SECRET',
      'CLOUDINARY_KEY',
      'CLOUDINARY_SECRET',
      'CLOUDINARY_URL',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'TURNSTILE_SECRET_KEY',
      'RUNNER_TOKEN',
    ],
  },
  externals: [],
  followUps: [
    {
      key: 'AUDIT_PASSWORD',
      ask: 'The report password changed. Encrypt the report again now?',
      command: ['npm', 'run', 'encrypt-report'],
      done: 'Report encrypted with the new password',
      failed: 'Encrypting the report failed, run npm run encrypt-report yourself',
      manual: 'Run npm run encrypt-report so the report uses the new password.',
    },
  ],
  staleDays: 90,
  oldBackupDays: 7,
};
