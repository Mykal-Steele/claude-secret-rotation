---
name: secret-rotation
description: Rotate or audit a project's credentials across env files, CI secrets and the hosting platform, or set up a guided tool that does it safely with automatic rollback. Use when asked to rotate secrets, API keys, tokens or passwords, to check that secrets in different places agree, to build a rotation script or runbook, or when a credential may have leaked.
---

# Secret rotation

Rotating a credential means making a new one, getting every place that uses it to switch, proving the switch worked, and only then killing the old one. Outages and leaks both come from skipping a step or doing them in the wrong order. This skill has the rules, a tested toolkit that rotates with automatic rollback, and the steps to install that toolkit in a repository.

Read "Rules that never bend" before touching any credential, in every mode.

## Pick the mode

| The user wants | Go to |
| --- | --- |
| to rotate in a repo that already has `scripts/rotate-secrets.mjs` | Operating the toolkit |
| a repeatable tool in a repo that has none | Setting up the toolkit |
| one credential rotated now, no tooling | The manual protocol |
| to know whether secrets agree across files, CI and the platform | Auditing |
| a credential rotated because it leaked | If a credential leaked |

Look first: `ls scripts/rotate-secrets.mjs scripts/secrets.manifest.mjs scripts/secrets.config.mjs`.

## What the toolkit does

Use this to describe it to the user.

- Checks the setup first: tools installed, logins (it offers to log in again), the app reachable, the record file present, env files readable by others, old saved values, and values where the platform and the record disagree.
- Asks which providers to rotate, shows the exact dashboard steps and why, and takes each value hidden (shown as `*`). It catches a wrong paste by shape, then tests the value with the provider before anything changes.
- Shows a review with fingerprints, never values, where each one is written, and what people will notice.
- Applies in a fixed order with automatic rollback, and ends in a box that says plainly what happened.
- Writes `# last rotated <time>` above each changed key, records the time on the platform as tags, and shows CI's own update times in the status screen.
- Keeps the old values in an owner-only folder outside the repo for rollback, `--check-revoked` proves they are dead, `--forget` overwrites and deletes them.
- Lists what it cannot do (a second copy of the app) and can copy those values with the clipboard's "sensitive" hint.
- `secrets:check` compares everything by hash and never prints a value.

Supporting files, read when the step needs them:

| File | Read it for |
| --- | --- |
| `docs/discovery.md` | finding every credential in an unfamiliar repo, and the table to fill in |
| `docs/providers.md` | what to do at each provider, how to test a value, how to revoke |
| `docs/adapters.md` | the contracts, and adding a platform, CI, external, format or live check |
| `docs/sandbox-e2e.md` | testing the wizard end to end without touching anything real |
| `docs/lessons.md` | what went wrong while this was built, and what was and was not verified |
| `starter/` | the toolkit, ready to copy (`starter/README.md`) |
| `templates/` | the two files to edit, the npm scripts, a runbook to fill in |
| `tools/` | `pty-drive.py` (drive the wizard in a pseudo terminal) |

## Rules that never bend

1. **Never show a secret value.** Not in chat, logs, errors, commit messages, test output or files you write. Say "64 characters, fingerprint a1b2c3" or the first 8 hex of a sha256. Names and counts are fine. Strip values from command output before showing it. Before you finish, search every file you changed for the real values.
2. **New first, old last.** Make the new credential at the provider while the old one still works, switch every consumer, prove the app works, then revoke the old one. Revoking first turns a rotation into an outage. A leak changes the speed, not the order.
3. **Test the new value before using it.** Check its shape (a swapped key and secret, a truncated paste, a leftover `<placeholder>`), then probe the provider with a call that has no side effects. A refused value stops the run. Try any new probe on a credential you know is good first, because a probe that wrongly rejects blocks real work.
4. **One order, undoable until the last step.** Snapshot, externals, platform, restart, wait for health, local files, record the time, CI. Everything before CI rolls back automatically. Do not reorder to save time: writing the local files first leaves a record that does not match what is running.
5. **Know when each consumer reads its secrets.** A platform app usually reads them when a replica starts, a build-time value is read at build, some are read per request. Restart or redeploy to match, and wait for health twice in a row, because the old replica can still answer for a few seconds.
6. **Never claim what you did not verify.** "The app is healthy" only after a health check ran. "Rolled back" only when something was restored. A rollback with nothing to restore is an error. Say when a platform behavior is from memory.
7. **Old values are private and temporary.** A rollback needs them. Keep them outside the repo in an owner-only folder, read the mode back (some drives ignore `chmod`), offer to delete them once the old credentials are revoked, and prove the revocation by trying the old values.
8. **Keep secrets off command lines and out of shell strings.** Use stdin or a private file, run programs with an argument list, never accept `--set KEY=VALUE`. Where a tool forces the command line, say so.
9. **Write files safely.** Write to a temp file and rename, keep the mode and line endings, update every duplicate line (the last one wins when a dotenv file loads), leave other lines alone, and put `# last rotated <date> <time> <offset>` above each changed key.
10. **Separate credentials from config, and derive combined values.** Never rotate URLs, names or ids. Rebuild a connection string made of a key, a secret and a host from its parts, and rotate the parts together.
11. **Do not copy a secret where it does not belong.** Before "fixing" a credential that CI or a second copy lacks, read how the code and workflow use it. The gap can be deliberate.
12. **List what you cannot reach, every time.** A failover host, preview environments, other projects that share the credential. Say how long a failover takes to switch back.
13. **Ask for what only the user has, and do not take outward actions unasked.** Values come from their dashboards, typed hidden into their own terminal, never pasted into chat (in Claude Code suggest `! npm run secrets`). Revoking, deleting users, reimaging, restarting production: confirm first unless they asked for exactly that.
14. **Read-only first, and stay out of the way mid-rotation.** Check state before changing it. While the user is rotating, do not probe production: errors are expected and a probe only confuses.
15. **Tests first, then a sandbox, then production.** Write the test, see it fail for the right reason, then the code. Run the real flow against fake env files before any real credential.
16. **Write plainly.** Follow the user's own writing rules, keep steps terse and exact, no filler.

## Operating the toolkit

The commands (the toolkit adds no npm packages):

```bash
npm run secrets:check          # read-only: files, platform, CI, database login, health, ages
npm run secrets                # the wizard
npm run secrets -- --dry-run   # everything except the final write
npm run secrets -- --rollback  # undo the last run
npm run secrets -- --resume    # push CI secrets that failed
npm run secrets -- --sync-github
npm run secrets -- --check-revoked
npm run secrets -- --forget
```

**What you can do and what the user does.** `secrets:check` runs without a terminal, so run it yourself and read it. The wizard needs an interactive terminal and hidden input, so the user runs it (`! npm run secrets`) and you stay available. A scripted run exists for generated keys only (`--gen KEY --yes`) and still logs in to the platform and changes production, so ask first.

**Procedure.**

1. Run `secrets:check`. Red lines are real problems: a value that differs between the record and the platform, a login that fails, an unhealthy site. Understand each one before rotating, because rotating on top of drift hides which side was right. Yellow lines are warnings.
2. Tell the user what will be asked (the providers), what users will notice (for example everyone signed out) and how long it takes. Get a go-ahead if it touches production.
3. The user runs the wizard. For each provider it shows the exact steps and why, takes the value hidden, checks its shape and tests it with the provider. If a probe is wrong or a step is out of date, fix the manifest, not the user.
4. After it finishes, go through "Your turn": the second copy of the app (a failover host) is the user's to update and the wizard can copy the values for them, the old credentials are theirs to revoke, then `--check-revoked`, then `--forget`.
5. Run `secrets:check` again. Expect everything ok. A failover proxy may keep serving the backup for a while after a restart, see `lessons.md`.

**The outcomes.**

| Outcome | Meaning | Next |
| --- | --- | --- |
| Done | Everything changed, the app is healthy. | "Your turn" list. |
| Done, with CI pending | CI refused a secret three times. | `--resume`. |
| Rolled back, nothing changed (exit 2) | A step failed, everything is back on the old values. | Read the reason, fix it, rerun. |
| ATTENTION (exit 3) | The rollback also failed, the app may be down. | Read the platform logs, then `--rollback`. Do this first, everything else waits. |

Ctrl-C while applying lets the run finish first, so nothing is left half done. A second Ctrl-C force quits and needs `--rollback`.

## Setting up the toolkit

Do these in order. The first two decide how much work the rest is.

1. **Discover.** Follow `docs/discovery.md` and produce the table (name, kind, provider, files, CI, platform target, generate, test, effect, revoke). Confirm it with the user, especially the record of production, any second copy of the app, and credentials shared with other projects.
2. **Check the fit.** The reference adapters talk to Azure Container Apps (`az`) and GitHub Actions (`gh`), and either can be switched off (`azure: null`, `github: false`). For any other platform or CI, a small adapter has to be written (`docs/adapters.md`). Tell the user the effort before starting.
3. **Install the starter.** Work on a branch and never overwrite existing files:

   ```bash
   SK=~/.claude/skills/secret-rotation
   mkdir -p scripts __tests__/unit
   cp -rn "$SK/starter/scripts/." scripts/
   cp -rn "$SK/starter/__tests__/unit/." __tests__/unit/
   ```

   `cp -n` skips files that exist, so compare any clash by hand. If tests live somewhere else, copy them there and fix the `../../scripts/` imports. Add the scripts from `templates/package-scripts.json` to `package.json`. Nothing else is installed.
4. **Write the two files from the table.** In `scripts/secrets.config.mjs`: names, platform, health path and public URL, second copy, externals, follow-ups. In `scripts/secrets.manifest.mjs`: every env var (`format`, `generate`, `config`, `files`, `fileKeys`, `github`, `azure`), one group per provider with exact `how` steps, a `why`, a `revoke` line and a `verify` check, and any derived values. Where a value is made of parts that rarely change (a connection string), give the group `inputs` and a `build` so the user types only the part that changes. The steps shown to the user must be exact and current. If you are not sure of a dashboard path, ask the user or look it up, and label it. A provider the toolkit has no format or check for needs one added with tests (`docs/adapters.md`).
5. **Make the tests pass.** The tests use the globals `describe`, `test`, `expect`, `beforeEach`, `afterEach` and a couple of messages as the second argument of `expect` (Bun and Vitest accept that, Jest does not). Run them, then run the static check for undefined names from `adapters.md`. `rotateManifest.test.js` reads the new manifest and config and says what disagrees. Break the manifest on purpose once to prove it can fail.
6. **Run `secrets:check`** against the real repository. Read every row. Fix real drift only with the user's agreement.
7. **Run the wizard** with `--dry-run` in the user's terminal, and run the sandbox end to end yourself (`docs/sandbox-e2e.md`): apply, rollback, check the files are restored byte for byte, forget. Also install the same files in an empty repository if you changed library code, because that is what found coupling to defaults.
8. **Write the runbook** from `templates/runbook.md` into the repo's docs, and add a pointer in the agent instructions (`AGENTS.md` or `CLAUDE.md`) naming `npm run secrets`, `npm run secrets:check` and the doc. Follow the repo's own commit and PR rules. Do not push unless asked.
9. **Do the first real rotation** on the least risky credential, with the user watching, after the sandbox is clean. Then the rest.
10. **Tell the user what was and was not verified.** Anything that ran only against fakes (a platform adapter, an external) is "tested with a fake runner, not yet run for real".

Add `.gitignore` entries only if you create files in the repo. The old values live outside it.

## The manual protocol

For one credential, no tooling. The rules apply in full.

1. Find every place it lives (`docs/discovery.md`). Name them to the user before changing anything.
2. Check the places agree. Compare by hash and never print: `printf %s "$VALUE" | sha256sum | cut -c1-8`. If they disagree, find out which side is right first.
3. Keep the old value somewhere private and outside the repo until the end, or confirm the provider keeps it valid until you delete it.
4. Create the new credential at the provider, least privilege, old one still valid (`docs/providers.md`).
5. Test the new value with a side-effect-free probe. Stop if it is refused.
6. Update the platform, restart, and confirm health twice in a row on the platform's own address.
7. Update the env files (atomic, every duplicate line, the marker), then CI.
8. Update every second copy you cannot reach, or list it for the user.
9. Compare again by hash. Use the app.
10. Revoke the old credential, try it to prove it is dead, then delete your private copy.

## Auditing

Run `npm run secrets:check` if the toolkit is installed. Otherwise do steps 1 and 2 of the manual protocol for every credential and report names and short hashes only. Report age as well: anything older than the repo's limit (90 days by default) is a finding. Env files readable by other users, committed env files and a record that is empty or missing keys are findings too.

## If a credential leaked

Rotate it now, in the same order: create the new one, switch everything, then revoke the old one as quickly as the switch is proven. Then:

- Ask the provider's audit log or usage page whether the old credential was used by anyone else, and tell the user.
- Rewriting git history does not make the old value safe again. Rotating is still required.
- Check where else the value may sit: shell history, terminal scrollback, a clipboard history file, logs, CI output, chat. Name them to the user. Wiping their history is their call.
- Everything that shared the credential (other projects, a second copy) needs the new one too.

## When something goes wrong

| What you see | Likely cause | What to do |
| --- | --- | --- |
| The app broke after a platform secret change | The platform reads secrets at start and was never restarted, or the new value is wrong | Restart, read the app logs, `--rollback` if the value is wrong |
| `bad auth` in the app logs | The login value is wrong or the user was changed under the app | Put the old value back, rotate with a second user |
| `not allowed to do action [find]` | It logs in but lacks privileges on that collection | Check the privilege's database and collection fields, fix the privilege, not the password |
| The public site returns 502 from a backup host, the platform's own address is healthy | A failover proxy flipped during the restart and has not switched back | Wait for its probes (about ten minutes in the case seen), then check the backup copy's env vars |
| The check says drift between the record and the platform | One side is stale | Decide which is right by testing both against the provider, never by guessing |
| Rollback printed success but files are unchanged | The journal lost its snapshot, or nothing was saved | Never trust it, read the files, fix the journal merge (`lessons.md`) |
| `chmod` seems to work but the mode stays 777 | The drive ignores permissions | Keep old values elsewhere, warn that env files are readable, say the repo has to move |
| A login prompt or extension prompt appears mid-run | The CLI was not logged in or wanted to install something | Log in first, run the CLI non-interactively |
| A probe rejects a value you know is good | The probe is wrong | Fix the probe with a test, do not tell the user their key is bad |
| The "same value" warning for a rotated key | The provider kept an identifier when rolling the token | Fine, it is flagged and skipped, rotate the part that changed |

## Before you say it is done

For a rotation:

- `secrets:check` is all ok, or each remaining warning is named and explained.
- The app works, not only the health endpoint.
- The user knows what is still theirs: the second copy, revoking, `--check-revoked`, `--forget`.
- No value appeared in chat, logs or any file you wrote.

For a setup:

- Unit tests pass, the manifest consistency test fails when the manifest is broken, the static name check is clean.
- A sandbox apply, rollback and forget ran and the files came back byte for byte.
- `secrets:check` ran against the real repository and every row is understood.
- The runbook and the pointer in the agent instructions are written, and nothing is pushed unasked.
- The user has been told plainly what ran only against fakes.
