# Starter kit

The rotation tools, ready to copy into a repository. `SKILL.md` one level up says how to install and adapt them. Improve the tools in the repository you installed them in, and copy the changes back here if you want to keep them.

## What is in it

- `scripts/rotate-secrets.mjs`, `scripts/secrets-check.mjs`: the two commands.
- `scripts/secrets.config.mjs`, `scripts/secrets.manifest.mjs`: the two files you edit. They hold an example for a database URL, a session secret and an email key. Replace the entries with the repository's own.
- `scripts/lib/`: the logic. Nothing here names a repository.
- `__tests__/unit/rotate*.test.js` and `__tests__/unit/fixtures/`: the tests. They use their own fixture data, not your manifest, so they keep passing when you change it. `rotateManifest.test.js` is the one that reads your real manifest and config and checks they agree with each other.

## What it assumes

- Node 20 or newer (`fetch`, `AbortSignal.timeout`), no npm packages added.
- The app runs on Azure Container Apps and secrets are kept in GitHub Actions, through the `az` and `gh` command line tools. Either can be switched off in the config (`azure: null`, `github: false`). For any other platform, write an adapter (`docs/adapters.md`).
- The tests use the globals `describe`, `test`, `expect`, `beforeEach`, `afterEach`, as Bun, Jest and Vitest provide. A few assertions pass a message as the second argument of `expect`, which Bun and Vitest accept and Jest does not.
