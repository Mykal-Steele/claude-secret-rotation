import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { redact } from './safety.mjs';
import { GROUPS } from '../secrets.manifest.mjs';
import { CONFIG } from '../secrets.config.mjs';
import { groupOfKey } from './plan.mjs';

// Live checks for new values, run before anything is written. Each one sends the
// value only to its own provider over HTTPS and returns { state, detail } where
// state is ok, fail (do not apply) or warn (could not tell).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendRequire = () => createRequire(path.join(repoRoot, CONFIG.dependenciesFrom));

const ok = (detail = 'Accepted by the provider.') => ({ state: 'ok', detail });
const fail = (detail) => ({ state: 'fail', detail });
const warn = (detail) => ({ state: 'warn', detail });

const callFetch = async (fetch, url, options) => {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
  } catch {
    return undefined;
  }
};

export async function verifyResend(key, { fetch = globalThis.fetch } = {}) {
  const res = await callFetch(fetch, 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res) return warn('Could not reach Resend to check the key.');
  if (res.status === 401 || res.status === 403)
    return fail('Resend says this API key is not valid.');
  if (res.status === 400 || res.status === 422)
    return ok('Resend accepted the key (nothing was sent).');
  return warn(`Resend answered ${res.status}, so the key could not be checked.`);
}

export async function verifyTurnstile(secret, { fetch = globalThis.fetch } = {}) {
  const res = await callFetch(fetch, 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: 'rotation-check' }).toString(),
  });
  if (!res) return warn('Could not reach Cloudflare to check the secret.');
  const body = await res.json().catch(() => ({}));
  const codes = body['error-codes'] ?? [];
  if (codes.includes('invalid-input-secret'))
    return fail('Cloudflare says this Turnstile secret is not valid.');
  if (codes.includes('invalid-input-response')) return ok('Cloudflare accepted the secret.');
  return warn('Cloudflare gave an answer that could not be read, so the secret was not checked.');
}

export async function verifyGemini(key, { fetch = globalThis.fetch } = {}) {
  const res = await callFetch(
    fetch,
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    {
      headers: { 'x-goog-api-key': key },
    },
  );
  if (!res) return warn('Could not reach Google to check the key.');
  if (res.ok) return ok('Google accepted the key.');
  if ([400, 401, 403].includes(res.status)) return fail('Google says this API key is not valid.');
  return warn(`Google answered ${res.status}, so the key could not be checked.`);
}

export async function verifyCloudinary({ name, key, secret }, { fetch = globalThis.fetch } = {}) {
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await callFetch(
    fetch,
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(name)}/ping`,
    {
      headers: { Authorization: `Basic ${auth}` },
    },
  );
  if (!res) return warn('Could not reach Cloudinary to check the key.');
  if (res.ok) return ok('Cloudinary accepted the key and secret.');
  if (res.status === 401 || res.status === 403) {
    return fail('Cloudinary rejected this key and secret pair. Check both came from the same key.');
  }
  return warn(`Cloudinary answered ${res.status}, so the pair could not be checked.`);
}

async function defaultCreateClient({ accountId, accessKeyId, secretAccessKey }) {
  const { S3Client, HeadBucketCommand } = backendRequire()('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return { headBucket: (Bucket) => client.send(new HeadBucketCommand({ Bucket })) };
}

export async function verifyR2(input, { createClient = defaultCreateClient } = {}) {
  const { accountId, bucket, accessKeyId, secretAccessKey } = input;
  try {
    const client = await createClient({ accountId, accessKeyId, secretAccessKey });
    await client.headBucket(bucket);
    return ok(`The token can reach the "${bucket}" bucket.`);
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (
      [401, 403].includes(status) ||
      ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied'].includes(error?.name)
    ) {
      return fail('R2 rejected this key pair, or the token cannot reach the bucket.');
    }
    if (status === 404 || ['NotFound', 'NoSuchBucket'].includes(error?.name)) {
      return fail(`The "${bucket}" bucket was not found for this account.`);
    }
    return warn(
      `Could not check R2: ${redact(error?.message ?? 'unknown error', [secretAccessKey]).slice(0, 120)}`,
    );
  }
}

function classifyMongo(error, phase, secrets) {
  const text = String(error?.message ?? error).toLowerCase();
  if (/bad auth|authentication failed/.test(text)) return 'The user name or password was rejected.';
  if (/not authorized|not allowed to do action|unauthorized/.test(text)) {
    return phase === 'write'
      ? 'The user can read but has no permission to write. Give it readWrite on the database.'
      : 'The user can log in but has no permission to read the data. Give it readWrite on the database.';
  }
  if (/timed out|enotfound|econnrefused|eai_again|server selection/.test(text)) {
    return 'Could not reach Atlas. Check your internet connection and the Network Access list in Atlas.';
  }
  return `MongoDB said: ${redact(String(error?.message ?? error), secrets).slice(0, 160)}`;
}

export function loadMongoose() {
  return backendRequire()('mongoose');
}

// Logs in with the new connection string, reads users and posts, and writes then
// removes a probe document. That catches a user with the wrong privileges before
// the app is switched to it.
export async function verifyMongo(
  uri,
  { mongoose, collections = CONFIG.mongo.probeCollections } = {},
) {
  let password = '';
  try {
    password = decodeURIComponent(new URL(uri).password);
  } catch {}
  const secrets = [uri, password];
  let connection;
  try {
    const driver = mongoose ?? loadMongoose();
    connection = await driver
      .createConnection(uri, { serverSelectionTimeoutMS: 8000, appName: 'example-app-rotation-check' })
      .asPromise();
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND')
      return warn('Could not load mongoose. Run npm run setup first.');
    return fail(classifyMongo(error, 'connect', secrets));
  }
  try {
    for (const name of collections) {
      try {
        await connection.db.collection(name).findOne({});
      } catch (error) {
        return fail(classifyMongo(error, 'read', secrets));
      }
    }
    try {
      const probe = connection.db.collection('__rotation_probe');
      const { insertedId } = await probe.insertOne({ createdAt: new Date() });
      await probe.deleteOne({ _id: insertedId });
      await probe.drop();
    } catch (error) {
      return fail(classifyMongo(error, 'write', secrets));
    }
    return ok('Logged in, can read the data and write.');
  } finally {
    await connection.close().catch(() => {});
  }
}

// The check each group `verify.type` names. Roles are the check's own names for its
// inputs, the group maps each role to whatever env var the repository calls it.
const RUNNERS = {
  mongo: (r, deps) => verifyMongo(r.uri, deps),
  cloudinary: (r, deps) => verifyCloudinary({ name: r.name, key: r.key, secret: r.secret }, deps),
  resend: (r, deps) => verifyResend(r.key, deps),
  r2: (r, deps) =>
    verifyR2(
      {
        accountId: r.accountId,
        bucket: r.bucket,
        accessKeyId: r.accessKeyId,
        secretAccessKey: r.secretAccessKey,
      },
      deps,
    ),
  turnstile: (r, deps) => verifyTurnstile(r.secret, deps),
  gemini: (r, deps) => verifyGemini(r.key, deps),
};

export const CHECK_TYPES = Object.keys(RUNNERS);

// values: what is being checked, current: name -> value to fall back on for the parts
// of a group that were not part of values (for example the cloud name).
export async function verifyValues(values, current, deps = {}) {
  const groups = deps.groups ?? GROUPS;
  const ids = [
    ...new Set(
      Object.keys(values)
        .map((key) => groupOfKey(key, { groups })?.id)
        .filter(Boolean),
    ),
  ];
  const results = [];
  for (const id of ids) {
    const group = groups.find((candidate) => candidate.id === id);
    const spec = group.verify;
    const override = deps.verifiers?.[id];
    if (!spec && !override) {
      results.push({
        groupId: id,
        title: group.title,
        state: 'skip',
        detail: 'Nothing to check online.',
      });
      continue;
    }
    const names = spec ? Object.values(spec.inputs) : [];
    const inputs = Object.fromEntries(
      names.map((name) => [name, name in values ? values[name] : current(name)]),
    );
    const missing = names.filter((name) => !inputs[name]);
    if (missing.length) {
      results.push({
        groupId: id,
        title: group.title,
        state: 'warn',
        detail: `Cannot check, ${missing.join(', ')} is not set.`,
      });
      continue;
    }
    if (!override && !RUNNERS[spec.type]) {
      results.push({
        groupId: id,
        title: group.title,
        state: 'warn',
        detail: `Unknown check type "${spec.type}".`,
      });
      continue;
    }
    const run =
      override ??
      ((byName) =>
        RUNNERS[spec.type](
          Object.fromEntries(
            Object.entries(spec.inputs).map(([role, name]) => [role, byName[name]]),
          ),
          deps,
        ));
    try {
      results.push({ groupId: id, title: group.title, ...(await run(inputs)) });
    } catch (error) {
      results.push({
        groupId: id,
        title: group.title,
        state: 'warn',
        detail: `The check could not run: ${error.message}`,
      });
    }
  }
  return results;
}
