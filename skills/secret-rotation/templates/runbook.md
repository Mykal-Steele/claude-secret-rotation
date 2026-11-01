# Rotating secrets

`npm run secrets` rotates the credentials this project uses and keeps <platform>, <CI> and the local env files in step. It takes about <time>, most of it in provider dashboards. It needs only a terminal. If `<cli>` is not logged in it offers to log you in.

## The short version

1. `npm run secrets:check` shows what is already wrong. Fix that first.
2. `npm run secrets` starts the wizard.
3. <Set the same values in the second copy of the app, if there is one. The wizard can copy them.>
4. Revoke the old credentials, then `npm run secrets -- --check-revoked`.
5. `npm run secrets -- --forget` deletes the saved old values.

## What the wizard does

1. **Checks your setup.** Tools installed and logged in, the app reachable, `<productionFile>` present. It warns about env files other users can read, old saved secrets, and values where the platform and `<productionFile>` disagree.
2. **Asks what to rotate.** One line per provider.
3. **Walks through each provider.** The exact steps and why, then each value, typed with `*` shown. A wrong shape is caught at once.
4. **Tests every new value with its provider** before anything changes.
5. **Shows a review** with fingerprints (never values), where each one is written, and what people will notice.
6. **Applies it in an order that can be undone:** old values saved, <externals>, <platform> updated and restarted, healthy twice in a row, then the env files, the rotation time, and <CI>.
7. **Checks again** and lists what is left for you.

The steps for each provider are in `scripts/secrets.manifest.mjs`.

## If something goes wrong

| Outcome | Meaning | What to do |
| --- | --- | --- |
| Done | Everything changed and the app is healthy. | Do the "Your turn" list. |
| Done, with CI pending | The CI refused a secret after three tries. | `npm run secrets -- --resume` |
| Rolled back, nothing changed | A step failed. Everything is back on the old values. | Read the reason, fix it, run again. |
| ATTENTION | The rollback failed too and the app may be down. | <how to read the logs>, then `npm run secrets -- --rollback`. |

`--rollback` undoes the last run, `--sync-github` pushes CI secrets that exist locally but not there, `--check-revoked` tries the old credentials, `--forget` deletes the saved old values. Ctrl-C while applying lets the run finish first. Press it twice to force quit, then run `--rollback`.

<Notes about the failover or second copy: how long it takes to switch back, where its env vars are set.>

## Security notes

- Old values are kept in `~/.local/state/<name>/secret-rotation`, owner-only, outside the repository. Delete them once the old credentials are revoked.
- Typed values show as `*`. Screens and errors show only a length and a fingerprint.
- <Say which commands put a value on a command line and why that is unavoidable.>
- <Warn about anything about this machine or drive that weakens the above.>

## How the code is laid out

`scripts/secrets.config.mjs` and `scripts/secrets.manifest.mjs` describe this repository. `scripts/lib/` is generic. The unit tests are `__tests__/unit/rotate*.test.js`.
