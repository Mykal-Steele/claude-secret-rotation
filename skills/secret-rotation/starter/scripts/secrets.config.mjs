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
//   health           the path every health check uses, the public address to probe
//                    (or null), and the header a failover proxy sets when it serves a
//                    backup (or null)
//   secondaryCopy    a second copy of the app the tools cannot reach (a failover host),
//                    with the keys it needs, so they are listed after every rotation.
//                    null when there is none
//   externals        things outside the app platform, GitHub and the env files that
//                    check a rotated value and have to change before the app does
//   followUps        commands to offer after a key changes
//   staleDays        a credential older than this is flagged
//   oldBackupDays    saved old values older than this are flagged
export const CONFIG = {
  name: 'example-app',
  productionFile: '.env.production',
  azure: { resourceGroup: 'example-rg', app: 'example-app' },
  github: true,
  dependenciesFrom: 'package.json',
  mongo: { probeCollections: ['users'] },
  health: {
    path: '/health',
    publicUrl: null,
    backupHeader: null,
  },
  secondaryCopy: null,
  externals: [],
  followUps: [],
  staleDays: 90,
  oldBackupDays: 7,
};
