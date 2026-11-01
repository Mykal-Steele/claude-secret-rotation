# Extending the toolkit

## How the parts fit

```
scripts/rotate-secrets.mjs      options, picks a mode, shows errors
  lib/preflight.mjs             tools, logins, private folder, drift warnings
  lib/wizard.mjs                groups -> values -> live checks -> review
  lib/run.mjs                   runs applyRotation, draws the steps and the outcome
    lib/apply.mjs               the ordered apply and the rollback. No I/O of its own
      adapters:  azure (cloud.mjs)  files (files.mjs)  github (cloud.mjs)
                 externals (externals/)  journal (journal.mjs)
  lib/modes.mjs                 --rollback --resume --sync-github --check-revoked --forget
scripts/secrets-check.mjs       lib/checks.mjs, read-only status
```

Everything with logic and no I/O (`plan`, `validate`, `envfile`, the helpers in `safety`, `apply`) is unit tested with fakes. The screens (`preflight`, `wizard`, `run`, `modes`, `tui`) are tested by driving them in a pseudo terminal, see `sandbox-e2e.md`.

## The apply contract

`applyRotation(items, adapters, options)` in `lib/apply.mjs`.

An item is `{ key, spec, value, old, status }` where `spec` is the manifest entry and `status` is `changed` or `unchanged`. Only `changed` items are touched.

| Adapter | Members |
| --- | --- |
| `azure` | `snapshot(items)`, `apply(items)`, `restart()`, `waitHealthy()`, `restore(snapshot)`, `markRotated(items, isoTime)` |
| `files` | `backup(items)`, `write(items, { stamp })`, `restore(backup)` |
| `github` | `set(key, value)` |
| `externals` | a list of `{ id, label, applies(items), snapshot(items), apply(items, snapshot), restore(snapshot, items) }` |
| `journal` | `save(patch)` |
| others | `sleep(ms)`, `now()`, `shouldStop()`, `onStep({ id, state, detail })` |

It returns `{ status, githubPending, error?, needsAttention? }` with status `done`, `nothing`, `aborted`, `rolled-back` or `failed`. `failed` always has `needsAttention: true`.

The order, and what happens when a stage fails:

| Stage | If it fails |
| --- | --- |
| snapshot (platform, files, externals) | Stop. Nothing was changed. |
| externals | Restore every external that was started, including the one that failed. |
| platform apply, restart, health | The files are untouched. Restore the platform (restart and wait for health again), then the externals. |
| local files | Restore the files, then the platform, then the externals. |
| recording the rotation time | A warning only. |
| CI | Retry three times with a growing delay. Permanent errors (login, 403, 404) are not retried. Failures are returned as `githubPending`, never rolled back, because CI cannot break the running app. |

The platform and the externals are only restored if they were touched. Externals run before the platform because the thing that checks a credential has to accept the new value before the app starts presenting it, and they are restored last for the same reason.

**The journal.** Each `save` merges into one file per run. The first save holds the snapshots (`azure`, `files`, `externals`) and later saves (`azure-applied`, `files-written`, `done`, `rolled-back`, `failed`) must not drop them, because `rollbackFromJournal` reads them back. Overwriting the file instead of merging was a real bug here: rollback restored nothing and still reported success.

`rollbackFromJournal(state, adapters, { secrets })` restores files, then the platform, then the externals in reverse, then pushes the old values back to CI. If the saved run holds nothing to restore it returns `failed` and says so. It never reports success for work it did not do.

## A platform adapter

`createAzureAdapter` in `lib/cloud.mjs` is the reference. For another platform, write a module with the same members and use it where `createAzureAdapter` is used (`run.mjs`, `modes.mjs`, `secrets-check.mjs`). Add `current()`, `fqdn()` and `rotationTimes()` if you want the status screen to compare values.

| Member | Contract |
| --- | --- |
| `snapshot(items)` | `{ secrets: { name: value or null }, env: { NAME: value or null } }` for the names about to change. `null` means it did not exist. |
| `apply(items)` | Set secrets in one call and plain env vars in another. |
| `restart()` | Make the running app read the new values. Azure Container Apps read secrets only when a replica starts, and `az` says so. |
| `waitHealthy()` | Poll the health URL until it answers well twice in a row (the old replica can still answer for a few seconds after a restart), within a timeout, and throw with the last answer if it never does. |
| `restore(snapshot)` | Put old values back and remove those that did not exist before. |
| `markRotated(items, isoTime)` | Record when, somewhere that holds no secret (tags). Optional. |
| `current()` | `{ secrets, env }` as maps, for drift checks. |

Rules for any adapter that shells out:

- Run programs with an argument list, never a shell string. The runner in `lib/proc.mjs` returns `{ code, stdout, stderr }` and never throws, with code 127 for a missing program and 124 for a timeout.
- Pass values through stdin or a private file when the tool allows it. `az containerapp secret set` has no such form, so its values are on the command line for a moment, which is a known and documented exposure.
- Redact every value you passed from any error text before it is shown (`redact` in `safety.mjs`).
- Retry only errors that are worth retrying (timeouts, 502, 503, 504, 429) and never a login error. Flag login errors so the caller can offer to log in.
- Make the CLI non-interactive: for `az`, quiet errors, no telemetry, extensions installed without a prompt.

Starting points for other platforms (suggestions, not exercised here): AWS ECS `update-service --force-new-deployment` after writing Secrets Manager values, Fly `fly secrets set` (restarts by itself), Kubernetes `kubectl apply` of a Secret then `rollout restart` and `rollout status`, Vercel `env add` then a redeploy.

## A CI adapter

Two members, and the rest of the toolkit calls nothing else: `set(key, value)` and `list()` returning a Map of name to last update time. `createGithubAdapter` sends the value on stdin and marks login, 401, 403 and 404 errors with `error.permanent = true`. GitHub never returns a secret's value, only its update time, which is why the local files are the record of what is current.

## An external

Something outside the app platform, CI and the env files that checks a credential and has to change before the app does: a gateway, a worker, a VM with the token baked in, a webhook consumer that holds a signing key. The contract is in the table above. Steps:

1. Write `lib/externals/<kind>.mjs` exporting a factory that takes `{ config, root, current, paramsDir }` and returns the adapter.
2. Add it to the `FACTORIES` map in `lib/externals/index.mjs`. `EXTERNAL_TYPES` is read from that map.
3. Add an entry to `CONFIG.externals` with `id`, `type`, `label` and the settings your factory needs.
4. Give the group that uses it `external: '<id>'` in the manifest.
5. Tests with a fake command runner: the snapshot holds what the external has now (read from the external, not from the env file, because they can drift), the apply order, secrets never on a command line, temp files deleted even when it fails, errors redacted, restore uses the snapshot, and the polling gives up with the last answer. `rotateManifest.test.js` already checks that every external is a known type and used by a group.

Leave a stopped resource as you found it. If you must start something to change it, stop it again afterwards and restore it the same way on rollback.

## A group that asks for parts

When a value is made of parts that rarely change, ask only for the part that does. A connection string is a protocol, a login, hosts, a database and options, and only the login changes between rotations. Give the group `inputs: [{ name, label, mask, current, keptNote }]` and `build(parts, current)` returning `{ ok: true, values: { KEY: value } }` or `{ ok: false, problem }`. `current` reads settings that are not being rotated, here the current string. Enter keeps a part's current value (`resolveInput` in `plan.mjs`), so one part can stay while another changes, and the group is skipped only when every part is kept. `keptNote` is a warning shown when that part is kept and another changed. The wizard prompts for each part (masked when `mask` is true, and showing what is in use now from `current(read)`: in full when the part is not secret, the first three characters when it is), calls `build`, checks the result against the format, and falls back to asking for the whole value when `build` cannot produce it (for example there is no current string to copy the host from). The builder for MongoDB is `lib/mongo-uri.mjs`, it keeps the hosts, database and options and percent-encodes the login. Write one for any other combined value, with tests for special characters in the password.

## A format

A format catches a wrong paste before it is used: a swapped key and secret, a truncated value, a placeholder left in. Add a function to `FORMATS` in `lib/validate.mjs` that returns `pass(value, warnings)` or `fail(message)`, naming the likely mistake in the message ("This looks like the secret, not the key"). Then use its id as `format` in the manifest. Tests: a valid value, an invalid one, and each swap hint.

## A live check

Add `verifyX(input, deps)` to `lib/verify.mjs`. It returns `{ state, detail }` where state is `ok`, `fail` (stop, the provider refused it) or `warn` (could not tell, for example offline). Then add it to `RUNNERS` (which also defines `CHECK_TYPES`) and reference it from a group as `verify: { type, inputs: { role: 'ENV_NAME' } }`.

- Take `fetch` and any client from `deps` so tests can fake them.
- Put the credential in a header, never the URL.
- A network error is `warn`, a clear refusal is `fail`, anything unclear is `warn`.
- Never put the value in `detail`. Mongo errors are classified into plain sentences for this reason.
- Write only to a scratch name you create and remove, and say so in the docs.
- Run it against a credential you know is good before you trust it.

Tests: bad credential, good credential, unclear status, network error, that the value is not in the URL or the result.

## Config and manifest fields

`scripts/secrets.config.mjs` (the header of the file lists every field):

| Field | Meaning |
| --- | --- |
| `name` | Names the private folder for old values, `<state>/<name>/secret-rotation`. |
| `productionFile` | The env file that is the record of production. |
| `azure` | `{ resourceGroup, app }` or `null`. |
| `github` | `false` when CI secrets are not used. |
| `dependenciesFrom` | A `package.json` whose `node_modules` hold the drivers the live checks load. |
| `mongo.probeCollections` | Collections the login check reads. |
| `health` | `path`, `publicUrl` (or `null`), `backupHeader` (`name`, `value`, `note`, or `null`). |
| `secondaryCopy` | `{ name, reason, keys }` or `null`. |
| `externals` | List of external definitions. |
| `followUps` | `{ key, ask, command, done, failed, manual }` offered after a key changes. |
| `staleDays`, `oldBackupDays` | Age limits for warnings. |

`scripts/secrets.manifest.mjs` has `SECRETS` (per env var: `format`, `generate`, `config`, `files`, `fileKeys`, `github`, `azure`), `GROUPS` (`how`, `why`, `revoke`, `effect`, `generate`, `verify`, `external`, `slow`, and `inputs` with `build`), `DERIVED` (`group`, `from`, `needs`, `build`), and `NOT_MANAGED`.

Format ids available: `mongo-uri`, `cloudinary-key`, `cloudinary-secret`, `resend-key`, `r2-access-key-id`, `r2-secret-access-key`, `turnstile-secret`, `gemini-key`, `generated`. Check types: `mongo`, `cloudinary`, `resend`, `r2`, `turnstile`, `gemini`.

## Tests

- Library tests use fixtures (`__tests__/unit/fixtures/`) and inject them, so they never depend on one repository's manifest. When you add a function that reads the manifest or config, give it a parameter with the real one as the default and pass the fixture in the test.
- Run every default through a fresh repository before calling it portable. Two tests here only passed because the defaults happened to match, and only an install into an empty repo showed it.
- `rotateManifest.test.js` reads the real manifest and config and checks they agree. After changing it, break the manifest on purpose (a wrong format id, a group naming a key that does not exist) and confirm it fails, then put it back.
- Static check for undefined names and unused imports, because many repositories lint with `no-undef` off and skip `.mjs`:

```bash
npx eslint --no-config-lookup \
  --rule '{"no-undef":"error","no-unused-vars":["error",{"args":"none","caughtErrors":"none"}]}' \
  --parser-options '{"ecmaVersion":"latest","sourceType":"module"}' \
  --global process,console,fetch,URL,URLSearchParams,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,Buffer,describe,test,expect,beforeEach,afterEach \
  scripts __tests__/unit/rotate*.test.js __tests__/unit/fixtures
```

  A missing import slipped through once and only showed as a crash after the final confirmation.
