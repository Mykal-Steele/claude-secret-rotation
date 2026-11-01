# Providers

What to do at each provider, how to test a new value without side effects, and how to revoke the old one. The first six are wired into the toolkit and the probes were run against real accounts. UI paths drift, so treat menu names as a guide.

A good probe is an authenticated read (or a deliberately empty write) that changes nothing, answers differently for a bad credential than for a good one, and keeps the value out of the URL (use a header) so it cannot land in logs.

Test a new probe against a credential you know is good before trusting it. A probe that wrongly rejects a good value blocks a rotation, and one that wrongly accepts a bad value is worse.

## Wired in

| Provider | Make the new one | Probe | Revoke |
| --- | --- | --- | --- |
| MongoDB Atlas | Add a second database user with `readWrite` on the one database the app uses and no other privilege. The tool asks for the user name and the password only and builds the string from them and the host and options of the current one, percent-encoding the login. Leave the database name out of the path if the app uses the default one. | Connect, read the collections the app reads, insert and delete one document in a scratch collection, drop it. "bad auth" means the login is wrong. "not allowed to do action [find]" means it logged in but lacks privileges. A timeout points at the network access list. | Delete the old user, after checking nothing else shares it. |
| Cloudinary | Settings, API Keys, Generate New API Key. Several keys can exist at once. The URL form is `cloudinary://KEY:SECRET@CLOUD_NAME`, so build it from the pair and the cloud name instead of copying it. | `GET https://api.cloudinary.com/v1_1/<cloud>/ping` with Basic auth (key as user, secret as password). 200 is good, 401 or 403 is rejected. | Delete the old key. |
| Resend | API Keys, Create, permission Sending access, limited to the sending domain. Shown once. | `POST https://api.resend.com/emails` with `Authorization: Bearer <key>` and body `{}`. 401 or 403 is an invalid key. 400 or 422 means the key was accepted and nothing was sent. | Delete the old key. |
| Cloudflare R2 | R2, Manage API Tokens, Create API token, Object Read & Write, limited to the bucket. The secret is shown once. | S3 `HeadBucket` against `https://<account>.r2.cloudflarestorage.com`, region `auto`, path style. 403 is a wrong token or no access to the bucket, 404 is a missing bucket. | Delete the old token. |
| Cloudflare Turnstile | On the widget, rotate the secret key. If it offers to keep the old key valid for a while, take it. | `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with the secret and a dummy response. `invalid-input-secret` means the secret is wrong, `invalid-input-response` means the secret was accepted. | Invalidate the old key if you kept it alive. |
| Google AI Studio (Gemini) | Create a key, then restrict it to the site's domain in Google Cloud console, APIs & Services, Credentials. | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1` with the key in the `x-goog-api-key` header. 200 is good, 400, 401 or 403 is invalid. | Delete the old key. |

Notes that cost time to learn:

- **Atlas.** Changing the live user's password or privileges affects the running app at once and leaves nothing to go back to. That is why a second user is the default. The string must have the real password where `<db_password>` was, and special characters in the password must be percent-encoded.
- **Cloudinary.** A repository can end up with three copies that disagree: the secret variable, the secret inside the URL variable, and the platform's copy. Rotate the pair together and rebuild the URL from it.
- **Build-time keys** (a `VITE_` key, for example) end up in the shipped frontend. The domain restriction is what protects them.
- **Turnstile.** Rotating cancels the old secret straight away unless the dialog keeps it valid. An app that only enforces the check when it has both keys may deliberately run without them in CI.

## Generated secrets

Session secrets, JWT signing keys, refresh token keys, cookie keys, HMAC keys, shared tokens, report passwords. Make 32 random bytes as 64 hex characters (`openssl rand -hex 32`). The effect of changing one is that everything signed with the old one stops verifying: sessions end, and signed links, cached tokens or webhook signatures fail. If the library can verify with a list of keys, a gentler rotation adds the new key as the signing key and keeps the old one for verification until old tokens expire. The toolkit does not do that, it replaces the value, so say plainly what users will notice before applying.

## Common providers not wired in

These are the usual shapes, from general knowledge and not exercised here. Check the provider's own docs, and run the probe against a known-good key before trusting it.

| Provider | Probe idea |
| --- | --- |
| Stripe secret key | `GET /v1/balance` with `Authorization: Bearer` |
| OpenAI | `GET /v1/models` with `Authorization: Bearer` |
| Anthropic | `GET /v1/models` with `x-api-key` and `anthropic-version` headers |
| GitHub token | `GET https://api.github.com/user` with `Authorization: Bearer` |
| SendGrid | `GET /v3/scopes` with `Authorization: Bearer` |
| Slack bot token | `POST /api/auth.test` |
| Postgres or MySQL | Connect, `SELECT 1`, then insert and delete a row in a scratch table |
| Redis | `PING`, then `SET` and `DEL` a scratch key |
| AWS access keys | `aws sts get-caller-identity` |

Adding one means a format rule (so a swapped or truncated paste is caught), a probe, a group in the manifest, and tests. `adapters.md` has the steps.
