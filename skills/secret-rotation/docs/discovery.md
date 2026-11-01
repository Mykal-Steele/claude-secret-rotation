# Finding every credential

The goal is one table with a row per credential: where it lives, who reads it, how to make a new one, how to test it, and what stops working when it changes. The config and manifest in the toolkit are written straight from that table.

Never print values while doing this. Names and counts are enough, and values are compared by hash. A command that lists secrets must be limited to names (`--query "[].name"`, `grep -o '^[A-Z_]*'`).

## 1. Where credentials are stored

**Env files.**

```bash
find . -name '.env*' -not -path '*/node_modules/*' -not -path './.git/*'
grep -oE '^[A-Za-z_][A-Za-z0-9_]*' .env.production        # names only
git check-ignore -v .env.production                        # is it ignored
git ls-files | grep -i '\.env'                             # any committed env file is a finding on its own
```

Read `.env.example`, `Dockerfile`, `docker-compose*.yml` (`env_file:`), and the docs for how the files are meant to be used. Find out which one is the record of what production runs on. That is the `productionFile` in the config. If there is none, create the decision with the user before going on.

**CI.**

```bash
rg -o 'secrets\.[A-Za-z0-9_]+' .github/workflows | sort -u   # what workflows use
gh secret list                                               # names and update times, never values
```

For GitLab, CircleCI and others, list the variable names in their settings. Before treating a credential that CI lacks as a gap, read how CI uses it. A missing secret can be deliberate: some checks are meant to be skipped in CI when a key is absent.

**The hosting platform.** Look at the infrastructure code first (`rg -n 'secret|secretRef|env' infra/`), then ask the platform for names only. These command shapes are from general knowledge, check `--help` before relying on them.

| Platform | Names only |
| --- | --- |
| Azure Container Apps | `az containerapp secret list -g RG -n APP --query "[].name" -o tsv` and `az containerapp show -g RG -n APP --query "properties.template.containers[0].env[].name"` |
| AWS | `aws secretsmanager list-secrets --query 'SecretList[].Name'`, `aws ssm describe-parameters`, the secrets block of the ECS task definition |
| Kubernetes | `kubectl get secrets -A -o name` |
| Fly.io | `fly secrets list` |
| Vercel | `vercel env ls` |

**Second copies the tooling cannot reach.** A failover host, staging, preview environments, edge workers, cron jobs, other repositories that share the credential, desktop or mobile builds. Search the infrastructure and worker configs for other origins (`rg -n 'https?://' infra/ wrangler.toml`) and ask the user. These cannot be automated, so they are listed after every rotation.

**Build-time values.** Names that start with `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_` or `PUBLIC_` are compiled into client code and anyone can read them. Rotating one needs a rebuild and deploy. A restriction at the provider (an allowed domain) matters more than secrecy.

## 2. Who reads each one

```bash
rg -n "process\.env\.NAME|env\(['\"]NAME|os\.environ|getenv" --glob '!node_modules'
```

Note for each: runtime or build time, which service, and whether it is read once at start (a restart is needed after a change) or on every request. A platform that reads secrets only when a replica starts is the usual cause of "I changed it and nothing happened".

## 3. Classify every name

- **Credential.** Rotated: tokens, passwords, API keys, signing secrets, private keys.
- **Config.** Never rotated: URLs, hostnames, account ids, bucket names, public site keys. Mark `config: true` so the wizard never asks about them.
- **Derived.** Built from other values, for example a connection URL made of a key, a secret and a host. Declare the rule so it is rebuilt, never pasted.

For each credential also settle:

| Question | Why it matters |
| --- | --- |
| Which provider, and can two valid credentials exist at once? | Decides whether the old one can stay alive while the app switches. |
| Can the tool generate it, or must the provider issue it? | `generate: 'hex32'` or paste. |
| What do users notice when it changes? | Signed-out sessions, failed webhooks, expired cached tokens. Goes in `effect`. |
| What is a side-effect-free way to test it? | The live check. See `providers.md`. |
| Who else uses it? | A shared database user or API key deleted at the end can break another project. Check before revoking. |
| Does a second copy of the app need it? | Goes in `secondaryCopy.keys`. |
| Does anything outside the platform check it and need to change first? | An `external`. |
| Should CI have it? | `github: true` only if CI uses it. |

## 4. Ask the user

- Which env file is the record of production, and which others are real?
- Is there a failover or second copy of the app, and where are its env vars set?
- Which providers share one credential across projects?
- Is the repository public or has a secret ever been committed? (Rotation is then mandatory, and history rewriting does not make the old value safe again.)
- Where do they want the old values kept while a rotation runs? The default is a private folder outside the repository.
- Is it fine to touch production now, and for how long?

## 5. The output

A table like this, in your notes, before writing any config:

| Name | Kind | Provider | Files | CI | Platform target | Generate | Test | Effect | Revoke |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | credential | Atlas | `.env.development`, `.env.production` | yes | secret `database-url` | paste | login and write probe | none | delete old DB user |
| `SESSION_SECRET` | credential | none | same | yes | secret `session-secret` | hex32 | none | everyone signed out | none |
| `APP_URL` | config | none | same | yes | env `APP_URL` | no | no | none | none |

Each column maps to a manifest field: `files`, `github`, `azure`, `generate`, `format`, a group's `verify`, `effect`, `revoke`, `config`.
