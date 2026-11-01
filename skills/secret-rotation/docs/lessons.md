# Lessons

Things that went wrong or nearly did while the toolkit was built and used for the first time, and what each one means for the next repository. Each is why a rule in `SKILL.md` exists.

## Production incidents and near misses

- **A stale secret hid behind a system that looked fine.** The platform's copy of a database string had stopped matching the local record, and the app only noticed when a replica restarted. Hash both sides and compare before any rotation. It is the first thing `secrets:check` does.
- **Setting a platform secret did nothing until a restart.** The platform reads secrets when a replica starts. The first version of the script claimed "a new revision rolls automatically", which was false. Restart explicitly and wait for health. Never state what the platform does without checking.
- **Editing the live database user broke the running app.** Changing its privileges gave authorization errors ("not allowed to do action [find]") on connections that were already open, and there was nothing to go back to. Create a second user, switch, verify, delete the old one at the end.
- **A failover proxy served the backup after a short outage and took about ten minutes to switch back.** It probes every few minutes and needs two good answers in a row. The backup copy also had stale secrets and returned 502. After a restart, check the platform's own address and the public address separately, and tell the user how long a switch back takes.
- **A rollback that restored nothing and said it had.** Each journal save replaced the file, so the snapshot taken at the start was gone by the end of the run. Saves now merge, and rollback refuses with an error when the saved run holds nothing. Found only by running apply then rollback against a sandbox, never by the unit tests.

## Things that looked like problems and were not

- **A "missing" CI secret was deliberate.** The app skips a bot check unless it has both keys, and CI is meant to run with it skipped, so pushing the key would have turned the check on in CI. Read how the code and CI use a value before "syncing" it. A copy that should not exist is a leak surface.
- **A typed value equal to the current one.** Some providers keep an identifier when a token is rolled, so a "new" value can match the old one. The plan flags it as unchanged and skips it instead of pretending it was rotated.

## Process mistakes worth not repeating

- **Tests that only passed because of this repository's defaults.** Two tests relied on a default health path and a default list of collections. They went green here and failed the moment the kit was installed in an empty repository. Install into a fresh repository before calling anything portable.
- **A missing import that only crashed after the final confirmation.** A scripted edit silently did not apply because a formatter had reflowed the line, and the repository's lint had `no-undef` off and skipped `.mjs`. Use the static check in `adapters.md`, and make every scripted replacement assert that it matched.
- **Formatting a whole folder, then trying to undo it with a discard command.** Format only the files you wrote. Never use destructive git commands to clean up without asking. The permission system blocked it, rightly.
- **Probing production while the user was mid-rotation.** The credential or its privileges were being changed under the app, so every check gave confusing answers. When the user says they are rotating, stop reading logs, health and logins.
- **Three disagreeing copies of one credential.** A secret variable, the same secret embedded in a URL variable, and the platform's copy all differed. Declare derived values so they are rebuilt from their parts, and rotate the parts together.

## The environment

- **A drive that ignores `chmod`.** The repository sat on an NTFS mount where every file reads as mode 777 and `chmod 600` changes nothing. The tool writes a probe file and reads the mode back, refuses to keep old values on a drive that cannot keep them private, and warns that the env files themselves are readable by every user. Say plainly that moving the repo is the only fix.
- **Clipboard history had recorded pasted secrets.** A clipboard manager had stored copies of provider keys in a plain, readable history file. Copy with a "sensitive" hint where the tool supports one (`wl-copy --sensitive` sets the standard password-manager hint that managers skip), and tell the user their history may already hold secrets. Wiping it was the user's call, so do not build wiping into the tool unless asked.
- **Shell history and process lists.** A value typed as `--set KEY=VALUE` lands in shell history and in `ps`. The tool refuses that form and prompts with hidden input instead.

## What was verified and what was not

Checked against real systems: the six live provider checks (accepting real credentials and rejecting a fake one), the read-only platform and CI adapter calls, the platform tag command on a throwaway resource group, the status screen against a live app, the wizard through a pseudo terminal (checklist, hidden input with backspace, provider rejection, generated values, review, dry run), apply then rollback then forget against a sandbox copy with fake env files, and an install into an empty repository running 300+ tests.

Not checked for real: a full platform apply and restart through the final code (the same commands were run by hand earlier, and the adapter is covered by unit tests with a fake command runner), whether tagging the app avoids a new revision (expected, tags are metadata). The in-place VM secret change (apply, restore and `--rollback`) and a full platform apply, restart and health check were run live once. Say so when the first real rotation in a new repository goes through code that has not run there.

## A boot-time secret on a VM cannot be changed by redeploying the template

Some platforms refuse to change a VM's boot data (cloud-init, user data) after the VM exists, and the deployment fails with a "property change not allowed" error, even when you pass the current value. Do not plan a "redeploy then reimage" step. Change the value on the running machine instead (a run-command or SSH step that rewrites the config file in place and restarts the service), and prove it from inside the machine: the new value is accepted and the old one is refused. A reimage or recreate brings back the value baked in at creation, so the tool has to be run again after one.

## Check what else manages the machine before you start

If the application itself starts and stops that machine (an idle timer, a scale-down job), it can stop the VM halfway through your change and cancel the operation. Hold the machine on the same way the application's own override does, make the change fail fast when the machine is no longer running, and release the hold only if nobody else moved it. Rotations of machine-level secrets are a good place to test this live, because unit tests with a fake runner cannot show it.
