import {
  verifyResend,
  verifyTurnstile,
  verifyGemini,
  verifyCloudinary,
  verifyR2,
  verifyMongo,
  verifyValues,
} from '../../scripts/lib/verify.mjs';
import { GROUPS } from './fixtures/manifest.fixture.mjs';

const verify = (values, current, deps = {}) =>
  verifyValues(values, current, { groups: GROUPS, ...deps });

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  fn.calls = calls;
  return fn;
}

const brokenFetch = async () => {
  throw new TypeError('fetch failed');
};

describe('verifyResend', () => {
  test('an invalid key is rejected with 403 or 401', async () => {
    for (const status of [401, 403]) {
      const result = await verifyResend('re_bad', {
        fetch: fakeFetch(status, { message: 'API key is invalid' }),
      });
      expect(result.state).toBe('fail');
    }
  });

  test('a validation error means the key itself was accepted', async () => {
    const result = await verifyResend('re_good', {
      fetch: fakeFetch(422, { message: 'Missing `from` field.' }),
    });
    expect(result.state).toBe('ok');
  });

  test('sends nothing: an empty body to the emails endpoint, key only in the header', async () => {
    const fetch = fakeFetch(422, {});
    await verifyResend('re_secretvalue', { fetch });
    const call = fetch.calls[0];
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.options.method).toBe('POST');
    expect(call.options.headers.Authorization).toBe('Bearer re_secretvalue');
    expect(call.options.body).toBe('{}');
    expect(call.url).not.toContain('re_secretvalue');
  });

  test('is only a warning when Resend cannot be reached', async () => {
    expect((await verifyResend('re_x', { fetch: brokenFetch })).state).toBe('warn');
  });
});

describe('verifyTurnstile', () => {
  test('a wrong secret is reported as invalid', async () => {
    const fetch = fakeFetch(200, { success: false, 'error-codes': ['invalid-input-secret'] });
    expect((await verifyTurnstile('0xbad', { fetch })).state).toBe('fail');
  });

  test('a right secret only complains about the dummy response', async () => {
    const fetch = fakeFetch(200, { success: false, 'error-codes': ['invalid-input-response'] });
    expect((await verifyTurnstile('0xgood', { fetch })).state).toBe('ok');
  });

  test('anything else is a warning, not a failure', async () => {
    const fetch = fakeFetch(200, { success: false, 'error-codes': ['internal-error'] });
    expect((await verifyTurnstile('0xgood', { fetch })).state).toBe('warn');
    expect((await verifyTurnstile('0xgood', { fetch: brokenFetch })).state).toBe('warn');
  });

  test('posts to the siteverify endpoint', async () => {
    const fetch = fakeFetch(200, { success: false, 'error-codes': ['invalid-input-response'] });
    await verifyTurnstile('0xgood', { fetch });
    expect(fetch.calls[0].url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(fetch.calls[0].options.method).toBe('POST');
  });
});

describe('verifyGemini', () => {
  test('lists models with the key in a header, never in the URL', async () => {
    const fetch = fakeFetch(200, { models: [] });
    const result = await verifyGemini('AIzaSECRET', { fetch });
    expect(result.state).toBe('ok');
    expect(fetch.calls[0].options.headers['x-goog-api-key']).toBe('AIzaSECRET');
    expect(fetch.calls[0].url).not.toContain('AIzaSECRET');
  });

  test('400, 401 and 403 mean the key was refused', async () => {
    for (const status of [400, 401, 403]) {
      expect((await verifyGemini('AIza', { fetch: fakeFetch(status, {}) })).state).toBe('fail');
    }
  });

  test('server errors and network errors are warnings', async () => {
    expect((await verifyGemini('AIza', { fetch: fakeFetch(500, {}) })).state).toBe('warn');
    expect((await verifyGemini('AIza', { fetch: brokenFetch })).state).toBe('warn');
  });
});

describe('verifyCloudinary', () => {
  test('pings the cloud with basic auth and keeps the secret out of the URL', async () => {
    const fetch = fakeFetch(200, { status: 'ok' });
    const result = await verifyCloudinary(
      { name: 'mycloud', key: '123', secret: 'sss' },
      { fetch },
    );
    expect(result.state).toBe('ok');
    expect(fetch.calls[0].url).toBe('https://api.cloudinary.com/v1_1/mycloud/ping');
    expect(fetch.calls[0].options.headers.Authorization).toBe(
      `Basic ${Buffer.from('123:sss').toString('base64')}`,
    );
    expect(fetch.calls[0].url).not.toContain('sss');
  });

  test('401 and 403 mean the pair was rejected', async () => {
    for (const status of [401, 403]) {
      const result = await verifyCloudinary(
        { name: 'c', key: '1', secret: 's' },
        { fetch: fakeFetch(status, {}) },
      );
      expect(result.state).toBe('fail');
    }
  });

  test('other statuses and network errors are warnings', async () => {
    expect(
      (await verifyCloudinary({ name: 'c', key: '1', secret: 's' }, { fetch: fakeFetch(500, {}) }))
        .state,
    ).toBe('warn');
    expect(
      (await verifyCloudinary({ name: 'c', key: '1', secret: 's' }, { fetch: brokenFetch })).state,
    ).toBe('warn');
  });
});

describe('verifyR2', () => {
  const input = { accountId: 'acc', bucket: 'files', accessKeyId: 'id', secretAccessKey: 'secret' };

  test('passes when the bucket can be reached with the new token', async () => {
    const calls = [];
    const createClient = (options) => ({
      headBucket: async (bucket) => {
        calls.push({ options, bucket });
      },
    });
    const result = await verifyR2(input, { createClient });
    expect(result.state).toBe('ok');
    expect(calls[0].bucket).toBe('files');
    expect(calls[0].options).toMatchObject({
      accountId: 'acc',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    });
  });

  test('a 403 means the token is wrong or cannot reach this bucket', async () => {
    const createClient = () => ({
      headBucket: async () => {
        throw Object.assign(new Error('Forbidden'), {
          name: 'Forbidden',
          $metadata: { httpStatusCode: 403 },
        });
      },
    });
    const result = await verifyR2(input, { createClient });
    expect(result.state).toBe('fail');
    expect(result.detail).toMatch(/token|bucket/i);
  });

  test('a 404 says the bucket was not found', async () => {
    const createClient = () => ({
      headBucket: async () => {
        throw Object.assign(new Error('NotFound'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        });
      },
    });
    const result = await verifyR2(input, { createClient });
    expect(result.state).toBe('fail');
    expect(result.detail).toMatch(/not found/i);
  });

  test('network trouble is a warning', async () => {
    const createClient = () => ({
      headBucket: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });
    expect((await verifyR2(input, { createClient })).state).toBe('warn');
  });
});

function fakeMongoose({ connectError, readError, writeError } = {}) {
  const calls = [];
  const collection = (name) => ({
    findOne: async () => {
      calls.push(`findOne:${name}`);
      if (readError) throw new Error(readError);
      return null;
    },
    insertOne: async () => {
      calls.push(`insertOne:${name}`);
      if (writeError) throw new Error(writeError);
      return { insertedId: 'id1' };
    },
    deleteOne: async () => {
      calls.push(`deleteOne:${name}`);
    },
    drop: async () => {
      calls.push(`drop:${name}`);
    },
  });
  const mongoose = {
    createConnection: () => ({
      asPromise: async () => {
        if (connectError) throw new Error(connectError);
        return { db: { collection }, close: async () => calls.push('close') };
      },
    }),
  };
  return { calls, mongoose };
}

describe('verifyMongo', () => {
  test('logs in, reads users and posts, writes and removes a probe document, and closes', async () => {
    const { mongoose, calls } = fakeMongoose();
    const result = await verifyMongo('mongodb+srv://u:p@h/', {
      mongoose,
      collections: ['users', 'posts'],
    });
    expect(result.state).toBe('ok');
    expect(calls).toEqual([
      'findOne:users',
      'findOne:posts',
      'insertOne:__rotation_probe',
      'deleteOne:__rotation_probe',
      'drop:__rotation_probe',
      'close',
    ]);
  });

  test('a rejected login says the user name or password is wrong', async () => {
    const { mongoose } = fakeMongoose({ connectError: 'bad auth : authentication failed' });
    const result = await verifyMongo('mongodb+srv://u:p@h/', { mongoose });
    expect(result.state).toBe('fail');
    expect(result.detail).toMatch(/user name or password/i);
  });

  test('a user that can log in but not read says it lacks permission, and still closes', async () => {
    const { mongoose, calls } = fakeMongoose({
      readError: 'user is not allowed to do action [find] on [test.users]',
    });
    const result = await verifyMongo('mongodb+srv://u:p@h/', { mongoose });
    expect(result.state).toBe('fail');
    expect(result.detail).toMatch(/permission/i);
    expect(calls).toContain('close');
  });

  test('a user that cannot write says so', async () => {
    const { mongoose } = fakeMongoose({
      writeError: 'not authorized on test to execute command { insert }',
    });
    const result = await verifyMongo('mongodb+srv://u:p@h/', { mongoose });
    expect(result.state).toBe('fail');
    expect(result.detail).toMatch(/write/i);
  });

  test('a timeout points at the network access list', async () => {
    const { mongoose } = fakeMongoose({ connectError: 'Server selection timed out after 8000 ms' });
    const result = await verifyMongo('mongodb+srv://u:p@h/', { mongoose });
    expect(result.state).toBe('fail');
    expect(result.detail).toMatch(/network access|reach/i);
  });

  test('the connection string never appears in the result', async () => {
    const { mongoose } = fakeMongoose({
      connectError: 'bad auth for mongodb+srv://u:topsecret@h/',
    });
    const result = await verifyMongo('mongodb+srv://u:topsecret@h/', { mongoose });
    expect(JSON.stringify(result)).not.toContain('topsecret');
  });
});

describe('verifyValues', () => {
  test('checks only the groups that were rotated and hands each its inputs', async () => {
    const seen = [];
    const verifiers = {
      cloudinary: async (inputs) => {
        seen.push(inputs);
        return { state: 'ok', detail: 'fine' };
      },
      resend: async () => ({ state: 'fail', detail: 'nope' }),
    };
    const results = await verify(
      { CLOUDINARY_KEY: 'k', CLOUDINARY_SECRET: 's' },
      (key) => ({ CLOUDINARY_NAME: 'n' })[key],
      { verifiers },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ groupId: 'cloudinary', title: 'Cloudinary', state: 'ok' });
    expect(seen[0]).toEqual({ CLOUDINARY_KEY: 'k', CLOUDINARY_SECRET: 's', CLOUDINARY_NAME: 'n' });
  });

  test('falls back to the current value for the half of a group that was not rotated', async () => {
    let inputs;
    const verifiers = {
      r2: async (value) => {
        inputs = value;
        return { state: 'ok', detail: '' };
      },
    };
    await verify(
      { R2_SECRET_ACCESS_KEY: 'new-secret' },
      (key) => ({ R2_ACCESS_KEY_ID: 'old-id', R2_ACCOUNT_ID: 'acc', R2_BUCKET: 'files' })[key],
      { verifiers },
    );
    expect(inputs).toEqual({
      R2_ACCESS_KEY_ID: 'old-id',
      R2_SECRET_ACCESS_KEY: 'new-secret',
      R2_ACCOUNT_ID: 'acc',
      R2_BUCKET: 'files',
    });
  });

  test('says there is nothing to check online for generated groups', async () => {
    const results = await verify({ JWT_SECRET: 'x'.repeat(64) }, () => undefined, {
      verifiers: {},
    });
    expect(results[0]).toMatchObject({ groupId: 'jwt', state: 'skip' });
  });

  test('turns a crashing check into a warning instead of stopping the run', async () => {
    const verifiers = {
      resend: async () => {
        throw new Error('boom');
      },
    };
    const results = await verify({ RESEND_API_KEY: 're_x' }, () => undefined, { verifiers });
    expect(results[0].state).toBe('warn');
    expect(results[0].detail).toMatch(/boom/);
  });
});

describe('verification is driven by the group definition', () => {
  const groups = [
    {
      id: 'mail',
      title: 'Mail',
      keys: ['MAIL_KEY'],
      verify: { type: 'resend', inputs: { key: 'MAIL_KEY' } },
    },
    {
      id: 'db',
      title: 'Database',
      keys: ['MY_DB'],
      verify: { type: 'mongo', inputs: { uri: 'MY_DB' } },
    },
    { id: 'plain', title: 'Plain', keys: ['OTHER'] },
  ];

  test('runs the check named by the group type with the key under the repo own name', async () => {
    const fetch = fakeFetch(422, {});
    const results = await verify({ MAIL_KEY: 're_x' }, () => undefined, { groups, fetch });
    expect(results).toEqual([
      {
        groupId: 'mail',
        title: 'Mail',
        state: 'ok',
        detail: 'Resend accepted the key (nothing was sent).',
      },
    ]);
    expect(fetch.calls[0].options.headers.Authorization).toBe('Bearer re_x');
  });

  test('passes a custom Mongo collection list through', async () => {
    const { mongoose, calls } = fakeMongoose();
    await verify({ MY_DB: 'mongodb+srv://u:p@h/' }, () => undefined, {
      groups,
      mongoose,
      collections: ['accounts'],
    });
    expect(calls.filter((c) => c.startsWith('findOne'))).toEqual(['findOne:accounts']);
  });

  test('says there is nothing to check for a group without a verify entry', async () => {
    const results = await verify({ OTHER: 'x' }, () => undefined, { groups });
    expect(results[0]).toMatchObject({ groupId: 'plain', state: 'skip' });
  });

  test('warns when an input the check needs is not set anywhere', async () => {
    const results = await verify({}, () => undefined, { groups: [] });
    expect(results).toEqual([]);
    const missing = await verify({ MAIL_KEY: undefined }, () => undefined, { groups });
    expect(missing[0].state).toBe('warn');
    expect(missing[0].detail).toMatch(/MAIL_KEY/);
  });
});
