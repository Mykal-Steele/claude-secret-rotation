import {
  createAzureAdapter,
  createGithubAdapter,
  azureStatus,
  githubStatus,
  checkTools,
  isTransient,
} from '../../scripts/lib/cloud.mjs';
import { SECRETS } from './fixtures/manifest.fixture.mjs';

const item = (key, value = 'new', old = 'old') => ({
  key,
  spec: SECRETS[key],
  value,
  old,
  status: 'changed',
});
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

function fakeRun(responses = []) {
  const calls = [];
  const run = async (cmd, args, options = {}) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push({ cmd, args, options, line });
    for (const [needle, result] of responses) {
      if (line.includes(needle))
        return typeof result === 'function' ? result(args, options) : result;
    }
    return ok();
  };
  run.calls = calls;
  return run;
}

const config = { resourceGroup: 'rg', app: 'app' };

describe('azure adapter: snapshot', () => {
  test('records only the secrets and env vars the run will touch, null when missing', async () => {
    const run = fakeRun([
      [
        'secret list',
        ok(
          JSON.stringify([
            { name: 'jwt-secret', value: 'old-jwt' },
            { name: 'other', value: 'x' },
          ]),
        ),
      ],
      [
        '--query properties.template.containers[0].env',
        ok(JSON.stringify([{ name: 'CLIENT_URL', value: 'https://a.b' }])),
      ],
    ]);
    const azure = createAzureAdapter({ run, config });
    const snapshot = await azure.snapshot([
      item('JWT_SECRET'),
      item('RESEND_API_KEY'),
      item('CLIENT_URL'),
    ]);
    expect(snapshot).toEqual({
      secrets: { 'jwt-secret': 'old-jwt', 'resend-api-key': null },
      env: { CLIENT_URL: 'https://a.b' },
    });
    expect(run.calls[0].line).toContain('containerapp secret list -g rg -n app --show-values');
  });
});

describe('azure adapter: apply', () => {
  test('sets all secrets in one call and all env vars in another', async () => {
    const run = fakeRun();
    const azure = createAzureAdapter({ run, config });
    await azure.apply([
      item('JWT_SECRET', 'j'),
      item('REFRESH_TOKEN_SECRET', 'r'),
      item('CLIENT_URL', 'https://x.y'),
    ]);
    expect(run.calls[0].args).toEqual([
      'containerapp',
      'secret',
      'set',
      '-g',
      'rg',
      '-n',
      'app',
      '--secrets',
      'jwt-secret=j',
      'refresh-token-secret=r',
    ]);
    expect(run.calls[1].args).toEqual([
      'containerapp',
      'update',
      '-g',
      'rg',
      '-n',
      'app',
      '--set-env-vars',
      'CLIENT_URL=https://x.y',
    ]);
  });

  test('makes no call for a kind that has nothing to change', async () => {
    const run = fakeRun();
    await createAzureAdapter({ run, config }).apply([item('JWT_SECRET', 'j')]);
    expect(run.calls).toHaveLength(1);
  });

  test('turns a failed command into an error that does not contain the secret', async () => {
    const run = fakeRun([
      ['secret set', { code: 1, stdout: '', stderr: 'bad value hunter2hunter2 rejected' }],
    ]);
    const azure = createAzureAdapter({ run, config });
    await expect(azure.apply([item('JWT_SECRET', 'hunter2hunter2')])).rejects.toThrow(
      /bad value \*\*\* rejected/,
    );
  });
});

describe('azure adapter: restart', () => {
  test('restarts the active revision', async () => {
    const run = fakeRun([['revision list', ok('app--0000081\n')]]);
    await createAzureAdapter({ run, config }).restart();
    expect(run.calls.at(-1).args).toEqual([
      'containerapp',
      'revision',
      'restart',
      '-g',
      'rg',
      '-n',
      'app',
      '--revision',
      'app--0000081',
    ]);
  });

  test('says so when there is no active revision', async () => {
    const run = fakeRun([['revision list', ok('\n')]]);
    await expect(createAzureAdapter({ run, config }).restart()).rejects.toThrow(/active revision/i);
  });
});

describe('azure adapter: waitHealthy', () => {
  const fetchSequence = (statuses) => {
    let i = 0;
    const fn = async () => {
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return { ok: status >= 200 && status < 300, status };
    };
    fn.count = () => i;
    return fn;
  };
  const fqdnRun = () => fakeRun([['ingress.fqdn', ok('app.example.io\n')]]);
  const fast = { initialWaitMs: 0, intervalMs: 1, timeoutMs: 20, sleep: async () => {} };

  test('needs two good answers in a row', async () => {
    const fetch = fetchSequence([503, 200, 503, 200, 200]);
    await createAzureAdapter({ run: fqdnRun(), config, fetch, ...fast }).waitHealthy();
    expect(fetch.count()).toBe(5);
  });

  test('gives up with the last status when it never gets healthy', async () => {
    const fetch = fetchSequence([502]);
    await expect(
      createAzureAdapter({ run: fqdnRun(), config, fetch, ...fast }).waitHealthy(),
    ).rejects.toThrow(/not healthy.*502/s);
  });

  test('checks the health endpoint of the app address', async () => {
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200 };
    };
    await createAzureAdapter({
      run: fqdnRun(),
      config,
      fetch,
      healthPath: '/api/health',
      ...fast,
    }).waitHealthy();
    expect(urls[0]).toBe('https://app.example.io/api/health');
  });

  test('uses the health path it is given', async () => {
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200 };
    };
    await createAzureAdapter({
      run: fqdnRun(),
      config,
      fetch,
      healthPath: '/healthz',
      ...fast,
    }).waitHealthy();
    expect(urls[0]).toBe('https://app.example.io/healthz');
  });

  test('treats a network error as not healthy yet', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return { ok: true, status: 200 };
    };
    await createAzureAdapter({ run: fqdnRun(), config, fetch, ...fast }).waitHealthy();
    expect(calls).toBe(4);
  });
});

describe('azure adapter: restore', () => {
  test('puts old values back and removes what did not exist before', async () => {
    const run = fakeRun();
    const azure = createAzureAdapter({ run, config });
    await azure.restore({
      secrets: { 'jwt-secret': 'old-jwt', 'resend-api-key': null },
      env: { CLIENT_URL: 'https://a.b', R2_BUCKET: null },
    });
    const lines = run.calls.map((c) => c.args.join(' '));
    expect(lines).toContain('containerapp secret set -g rg -n app --secrets jwt-secret=old-jwt');
    expect(lines).toContain(
      'containerapp secret remove -g rg -n app --secret-names resend-api-key',
    );
    expect(lines).toContain(
      'containerapp update -g rg -n app --set-env-vars CLIENT_URL=https://a.b',
    );
    expect(lines).toContain('containerapp update -g rg -n app --remove-env-vars R2_BUCKET');
  });
});

describe('azure adapter: current, fqdn and rotationTimes', () => {
  test('current returns every secret and env var as maps', async () => {
    const run = fakeRun([
      [
        'secret list',
        ok(
          JSON.stringify([
            { name: 'a', value: '1' },
            { name: 'b', value: '2' },
          ]),
        ),
      ],
      [
        '--query properties.template.containers[0].env',
        ok(
          JSON.stringify([
            { name: 'X', value: 'y' },
            { name: 'S', secretRef: 'a' },
          ]),
        ),
      ],
    ]);
    const current = await createAzureAdapter({ run, config }).current();
    expect(current).toEqual({ secrets: { a: '1', b: '2' }, env: { X: 'y', S: null } });
  });

  test('fqdn returns the app address without a newline', async () => {
    const run = fakeRun([['ingress.fqdn', ok('app.example.io\n')]]);
    expect(await createAzureAdapter({ run, config }).fqdn()).toBe('app.example.io');
  });

  test('rotationTimes returns the tags, or an empty object when there are none', async () => {
    const withTags = fakeRun([
      ['--query tags', ok(JSON.stringify({ 'rotated-jwt-secret': '2026-11-01T02:46:00.000Z' }))],
    ]);
    expect(await createAzureAdapter({ run: withTags, config }).rotationTimes()).toEqual({
      'rotated-jwt-secret': '2026-11-01T02:46:00.000Z',
    });
    const noTags = fakeRun([['--query tags', ok('null\n')]]);
    expect(await createAzureAdapter({ run: noTags, config }).rotationTimes()).toEqual({});
  });
});

describe('azure adapter: markRotated', () => {
  test('writes one tag per changed Azure secret or env var, holding only the time', async () => {
    const run = fakeRun([
      [
        '--query id',
        ok('/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/app\n'),
      ],
    ]);
    await createAzureAdapter({ run, config }).markRotated(
      [item('JWT_SECRET'), item('CLIENT_URL'), item('VITE_GEMINI_API_KEY')],
      '2026-11-01T02:46:00.000Z',
    );
    expect(run.calls.at(-1).args).toEqual([
      'tag',
      'update',
      '--resource-id',
      '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/app',
      '--operation',
      'Merge',
      '--tags',
      'rotated-jwt-secret=2026-11-01T02:46:00.000Z',
      'rotated-client-url=2026-11-01T02:46:00.000Z',
    ]);
  });

  test('does nothing when no changed key goes to Azure', async () => {
    const run = fakeRun();
    await createAzureAdapter({ run, config }).markRotated(
      [item('VITE_GEMINI_API_KEY')],
      '2026-11-01T02:46:00.000Z',
    );
    expect(run.calls).toEqual([]);
  });

  test('never puts a secret value in the tags', async () => {
    const run = fakeRun([['--query id', ok('/id\n')]]);
    await createAzureAdapter({ run, config }).markRotated(
      [item('JWT_SECRET', 'super-secret-value')],
      '2026-11-01T02:46:00.000Z',
    );
    expect(JSON.stringify(run.calls)).not.toContain('super-secret-value');
  });
});

describe('github adapter', () => {
  test('sends the value on stdin, never on the command line', async () => {
    const run = fakeRun();
    await createGithubAdapter({ run }).set('JWT_SECRET', 'the-value-123');
    expect(run.calls[0].args).toEqual(['secret', 'set', 'JWT_SECRET']);
    expect(run.calls[0].options.input).toBe('the-value-123');
    expect(run.calls[0].line).not.toContain('the-value-123');
  });

  test('marks permission and login errors as permanent so they are not retried', async () => {
    const run = fakeRun([
      ['secret set', { code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }],
    ]);
    const error = await createGithubAdapter({ run })
      .set('K', 'v')
      .catch((e) => e);
    expect(error.permanent).toBe(true);
  });

  test('leaves a network error retryable', async () => {
    const run = fakeRun([['secret set', { code: 1, stdout: '', stderr: 'dial tcp: i/o timeout' }]]);
    const error = await createGithubAdapter({ run })
      .set('K', 'v')
      .catch((e) => e);
    expect(error.permanent).toBeFalsy();
  });

  test('lists the secrets that already exist', async () => {
    const run = fakeRun([
      ['secret list', ok('JWT_SECRET\t2026-11-01T02:06:35Z\nMONGO_URI\t2026-09-24T09:52:29Z\n')],
    ]);
    const names = await createGithubAdapter({ run }).list();
    expect([...names.keys()]).toEqual(['JWT_SECRET', 'MONGO_URI']);
    expect(names.get('JWT_SECRET')).toBe('2026-11-01T02:06:35Z');
  });
});

describe('azureStatus', () => {
  test('is ok when logged in and the app is reachable', async () => {
    const run = fakeRun([
      ['get-access-token', ok('2026-11-01 12:00:00\n')],
      ['account show', ok(JSON.stringify({ subscription: 'Visual Studio', user: 'me@x.com' }))],
      ['containerapp show', ok('app\n')],
    ]);
    expect(await azureStatus({ run, config })).toEqual({
      state: 'ok',
      subscription: 'Visual Studio',
      user: 'me@x.com',
    });
  });

  test('asks for a login when the token is missing or expired', async () => {
    const run = fakeRun([
      [
        'get-access-token',
        { code: 1, stdout: '', stderr: "Please run 'az login' to setup account." },
      ],
    ]);
    expect((await azureStatus({ run, config })).state).toBe('login');
  });

  test('explains when the app cannot be found in the signed in subscription', async () => {
    const run = fakeRun([
      ['get-access-token', ok('x')],
      ['account show', ok(JSON.stringify({ subscription: 'Other Sub', user: 'me@x.com' }))],
      ['containerapp show', { code: 1, stdout: '', stderr: 'ResourceGroupNotFound' }],
    ]);
    const status = await azureStatus({ run, config });
    expect(status.state).toBe('target');
    expect(status.detail).toMatch(/Other Sub/);
  });

  test('reports other failures as errors with the reason', async () => {
    const run = fakeRun([
      [
        'get-access-token',
        { code: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND login.microsoftonline.com' },
      ],
    ]);
    const status = await azureStatus({ run, config });
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/ENOTFOUND/);
  });
});

describe('githubStatus', () => {
  test('is ok when logged in and secrets can be listed', async () => {
    const run = fakeRun([
      ['auth status', ok()],
      ['repo view', ok('owner/Example\n')],
      ['secret list', ok('')],
    ]);
    expect(await githubStatus({ run })).toEqual({ state: 'ok', repo: 'owner/Example' });
  });

  test('asks for a login when not signed in', async () => {
    const run = fakeRun([
      ['auth status', { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts' }],
    ]);
    expect((await githubStatus({ run })).state).toBe('login');
  });

  test('says when the account cannot manage secrets in this repo', async () => {
    const run = fakeRun([
      ['auth status', ok()],
      ['repo view', ok('owner/Example\n')],
      [
        'secret list',
        {
          code: 1,
          stdout: '',
          stderr: 'HTTP 403: Resource not accessible by personal access token',
        },
      ],
    ]);
    const status = await githubStatus({ run });
    expect(status.state).toBe('access');
    expect(status.repo).toBe('owner/Example');
  });
});

describe('checkTools', () => {
  test('flags a missing program with an install hint', async () => {
    const run = fakeRun([
      ['gh --version', { code: 127, stdout: '', stderr: 'gh is not installed or not on PATH.' }],
    ]);
    const tools = await checkTools({ run });
    expect(tools.find((t) => t.name === 'gh')).toMatchObject({ ok: false });
    expect(tools.find((t) => t.name === 'gh').detail).toMatch(/install/i);
    expect(tools.find((t) => t.name === 'az').ok).toBe(true);
  });
});

describe('isTransient', () => {
  test('recognises errors worth retrying', () => {
    for (const text of [
      'connection reset by peer',
      'request timed out',
      'HTTP 503',
      'Too Many Requests',
      'EAI_AGAIN',
    ]) {
      expect(isTransient(text)).toBe(true);
    }
  });

  test('does not retry permanent errors', () => {
    for (const text of ['ResourceNotFound', 'HTTP 403', 'InvalidParameter'])
      expect(isTransient(text)).toBe(false);
  });
});
