# Testing the wizard in a sandbox

Unit tests cover the logic. The screens, the key handling and the ordering across modules only show their bugs when the whole thing runs. This recipe runs it end to end against a throwaway copy with fake env files, so nothing real is touched. It found a rollback that restored nothing and a missing import that crashed after the final confirmation, both missed by unit tests.

## Set it up

```bash
T=$(mktemp -d)                                   # the throwaway repo
tar --exclude='scripts/.env' -cf - scripts | tar -xf - -C "$T"     # never copy a real env file
cd "$T"
# fake env files with fake values, for every file the manifest lists
printf 'DATABASE_URL=mongodb+srv://u:p@h/\nSESSION_SECRET=%064d\n' 0 > .env.production
cp .env.production .env.development
```

Choose how much of the outside world the sandbox touches:

- **None.** In the copied `scripts/secrets.config.mjs` set `azure: null` and `github: false`, and in the copied manifest set every `azure` to `null` and every `github` to `false`. The wizard then only changes the fake env files and the private folder.
- **Read-only.** Leave the platforms on and `git init` the copy with the real remote (`git remote add origin <url>`) so `gh` can find a repository. Preflight and the status check make read-only calls, and you rotate only a credential that has no platform or CI target. Do not apply anything that has a platform target here.

Isolate the private folder so the run cannot touch real backups:

```bash
export XDG_STATE_HOME="$T/state"
```

(`gh` also keeps a small state file there, which is harmless.)

## Scenarios

Write one JSON file per scenario and run it with `tools/pty-drive.py` from this skill. The format is documented in the tool's header. The checklist starts fully checked, so one `a` clears it, then arrows (`"\u001b[B"` is down) and space pick what to rotate, and `"\r"` is enter.

Apply a generated credential:

```json
{ "cwd": "/tmp/t", "args": ["scripts/rotate-secrets.mjs"], "env": { "XDG_STATE_HOME": "/tmp/t/state" }, "timeout": 60,
  "steps": [
    ["enter continue", ["a", "\u001b[B", " ", "\r"]],
    ["Apply these changes?", ["y", "\r"]]
  ] }
```

Then roll back with `"args": [..., "--rollback"]` and a step `["Roll back now?", ["y", "\r"]]`, and clean up with `--forget` and `["Delete them?", ["y", "\r"]]`.

Things to check after each run:

1. **Apply.** The Applying steps ran in order, the env file has `# last rotated <date> <time> <offset>` above the key, and the "Done" box only claims what ran (no "app is healthy" when no platform step ran).
2. **Rollback.** Take `md5sum` of each env file before the apply and after the rollback. They must be identical, including the removed marker line.
3. **Forget.** The state folder holds no run files afterwards.
4. **Provider rejection.** Type a made-up key for a group with a live check (`re_` plus 33 letters for a Resend format), press backspace once and type one more character, and expect the provider to reject it and the failure options to appear. Answer `q`. This covers hidden input, backspace, the format check, the live probe and the failure path.
5. **Dry run.** `--dry-run` with a generated group ends at the review and writes nothing.
6. **A bad invocation.** No terminal (`< /dev/null`) gives a clear message, `--set KEY=VALUE` is refused, an unknown key lists the known ones.

## Reading the output

The driver prints the screen as plain text. The checklist redraws in place in a real terminal, so in the capture it appears stacked once per key press. That is not a bug. A box border can show one odd character where a multi-byte character was split between reads, which is the driver, not the tool.

## What this does not cover

A real platform apply and restart, a real CI push, a real external. Those need the real systems, so do them last, on the least risky credential, with the user watching, after the sandbox and the read-only checks are clean.
