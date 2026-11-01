# secret-rotation

A Claude Code plugin for rotating a project's secrets. It helps Claude rotate or audit API keys, tokens and passwords across your env files, CI secrets and hosting platform. It also includes a small toolkit you can install into a repo, so you can rotate by yourself later with `npm run secrets`.

## Install

In a Claude Code session:

```
/plugin install secret-rotation --marketplace Mykal-Steele/claude-secret-rotation
```

Or from a shell:

```
claude plugin install secret-rotation --marketplace Mykal-Steele/claude-secret-rotation
```

Answer `y` to add the marketplace, then pick a scope.

## Use

Ask Claude to rotate your secrets, check that they agree everywhere, or set up a rotation script for the repo. The skill is `secret-rotation`.

## What the toolkit does

- Guided terminal wizard with a checklist of what to rotate.
- Checks each new value for format, then with the provider where it can.
- Saves the old values in a private folder outside the repo, applies the change in an order that can be undone, and rolls back on failure.
- Writes a "last rotated" line above each key in your env files.
- `npm run secrets:check` shows where values disagree and how old they are, without changing anything.

It has no dependencies beyond Node 20 or newer. Tests run with Bun. The tools are wired for Azure Container Apps, GitHub Actions and env files. Other platforms are written up in `skills/secret-rotation/docs/adapters.md` as untested notes.

## Layout

```
.claude-plugin/        plugin and marketplace files
skills/secret-rotation/
  SKILL.md             rules and steps Claude follows
  docs/                providers, adapters, sandbox testing, lessons
  templates/           config, manifest and runbook templates
  starter/             the toolkit to copy into a repo
  tools/pty-drive.py   drives the wizard in a pseudo terminal for tests
```

## License

MIT
