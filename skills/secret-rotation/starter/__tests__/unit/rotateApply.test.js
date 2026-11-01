import { applyRotation, rollbackFromJournal } from '../../scripts/lib/apply.mjs';
import { SECRETS } from './fixtures/manifest.fixture.mjs';

const rollback = (state, adapters) => rollbackFromJournal(state, adapters, { secrets: SECRETS });

const item = (key, value = 'new', old = 'old', status = 'changed') => ({
  key,
  spec: SECRETS[key],
  value,
  old,
  status,
});

function setup(overrides = {}) {
  const calls = [];
  const journal = [];
  const steps = [];
  const rec =
    (name, impl = async () => {}) =>
    async (...args) => {
      calls.push(name);
      return impl(...args);
    };
  const adapters = {
    journal: {
      save: async (state) => {
        journal.push(state);
      },
    },
    azure: {
      snapshot: rec('azure.snapshot', async () => ({ azureSnapshot: true })),
      apply: rec('azure.apply'),
      restart: rec('azure.restart'),
      waitHealthy: rec('azure.waitHealthy'),
      restore: rec('azure.restore'),
      markRotated: rec('azure.markRotated'),
      ...overrides.azure,
    },
    files: {
      backup: rec('files.backup', async () => ({ filesBackup: true })),
      write: rec('files.write', async () => []),
      restore: rec('files.restore'),
      ...overrides.files,
    },
    github: {
      set: async (key) => {
        calls.push(`github.set:${key}`);
        if (overrides.githubSet) return overrides.githubSet(key);
      },
    },
    sleep: async () => {},
    now: () => new Date('2026-11-01T02:46:00Z'),
    shouldStop: overrides.shouldStop ?? (() => false),
    onStep: (step) => steps.push(step),
  };
  return { adapters, calls, journal, steps };
}

describe('applyRotation, happy path', () => {
  test('snapshots first, then Azure, restart, health, local files, GitHub', async () => {
    const { adapters, calls } = setup();
    const result = await applyRotation([item('JWT_SECRET')], adapters);
    expect(result.status).toBe('done');
    expect(result.githubPending).toEqual([]);
    expect(calls).toEqual([
      'azure.snapshot',
      'files.backup',
      'azure.apply',
      'azure.restart',
      'azure.waitHealthy',
      'files.write',
      'azure.markRotated',
      'github.set:JWT_SECRET',
    ]);
  });

  test('saves the old and new state before it changes anything, and marks the run done at the end', async () => {
    const { adapters, journal } = setup();
    await applyRotation([item('JWT_SECRET')], adapters);
    expect(journal[0].phase).toBe('snapshotted');
    expect(journal[0].azure).toEqual({ azureSnapshot: true });
    expect(journal[0].files).toEqual({ filesBackup: true });
    expect(journal.at(-1).phase).toBe('done');
  });

  test('reports each step to the UI', async () => {
    const { adapters, steps } = setup();
    await applyRotation([item('JWT_SECRET')], adapters);
    const ok = steps.filter((s) => s.state === 'ok').map((s) => s.id);
    expect(ok).toEqual(['snapshot', 'azure', 'restart', 'health', 'files', 'stamp', 'github']);
  });

  test('skips Azure completely when no changed key goes there', async () => {
    const { adapters, calls } = setup();
    await applyRotation([item('VITE_GEMINI_API_KEY')], adapters);
    expect(calls.some((c) => c.startsWith('azure.'))).toBe(false);
    expect(calls).toContain('files.write');
    expect(calls).toContain('github.set:VITE_GEMINI_API_KEY');
  });

  test('does not touch GitHub for a key that has no GitHub secret', async () => {
    const { adapters, calls } = setup();
    await applyRotation([item('AUDIT_PASSWORD')], adapters);
    expect(calls.some((c) => c.startsWith('github.'))).toBe(false);
  });

  test('waits for health but does not restart when only plain env vars changed', async () => {
    const { adapters, calls } = setup();
    await applyRotation([item('CLIENT_URL')], adapters);
    expect(calls).toContain('azure.apply');
    expect(calls).toContain('azure.waitHealthy');
    expect(calls).not.toContain('azure.restart');
  });

  test('ignores unchanged items and does nothing when all are unchanged', async () => {
    const { adapters, calls } = setup();
    const result = await applyRotation([item('JWT_SECRET', 'same', 'same', 'unchanged')], adapters);
    expect(result.status).toBe('nothing');
    expect(calls).toEqual([]);
  });

  test('stops before touching anything when the user interrupted', async () => {
    const { adapters, calls } = setup({ shouldStop: () => true });
    const result = await applyRotation([item('JWT_SECRET')], adapters);
    expect(result.status).toBe('aborted');
    expect(calls).toEqual([]);
  });
});

describe('applyRotation, rotation time', () => {
  test('gives the local files a stamp and Azure the same moment as an ISO time', async () => {
    const seen = {};
    const { adapters } = setup({
      files: {
        write: async (_items, options) => {
          seen.files = options;
          return [];
        },
      },
      azure: {
        markRotated: async (_items, when) => {
          seen.azure = when;
        },
      },
    });
    adapters.now = () => new Date('2026-11-01T02:46:30Z');
    await applyRotation([item('JWT_SECRET')], adapters);
    expect(seen.files.stamp).toMatch(/^2026-1[01]-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/);
    expect(seen.azure).toBe('2026-11-01T02:46:30.000Z');
  });

  test('a failure while recording the time is a warning, not a rollback', async () => {
    const { adapters, calls, steps } = setup({
      azure: {
        markRotated: async () => {
          throw new Error('tags are not allowed');
        },
      },
    });
    const result = await applyRotation([item('JWT_SECRET')], adapters);
    expect(result.status).toBe('done');
    expect(calls).not.toContain('azure.restore');
    expect(calls).toContain('github.set:JWT_SECRET');
    expect(steps.filter((s) => s.id === 'stamp').at(-1).state).toBe('warn');
  });

  test('does not record anything in Azure when no key went there', async () => {
    const { adapters, calls } = setup();
    await applyRotation([item('VITE_GEMINI_API_KEY')], adapters);
    expect(calls).not.toContain('azure.markRotated');
  });
});

describe('applyRotation, Azure failures roll back', () => {
  test('restores Azure and never writes files or GitHub when setting secrets fails', async () => {
    const { adapters, calls, journal } = setup({
      azure: {
        apply: async () => {
          calls.push('azure.apply');
          throw new Error('az exploded');
        },
      },
    });
    const result = await applyRotation([item('JWT_SECRET')], adapters);
    expect(result.status).toBe('rolled-back');
    expect(result.error).toMatch(/az exploded/);
    expect(calls).toContain('azure.restore');
    expect(calls).not.toContain('files.write');
    expect(calls.some((c) => c.startsWith('github.'))).toBe(false);
    expect(journal.at(-1).phase).toBe('rolled-back');
  });

  test('restores the old values and restarts again when the new revision never gets healthy', async () => {
    let health = 0;
    const { adapters, calls } = setup({
      azure: {
        waitHealthy: async () => {
          calls.push('azure.waitHealthy');
          health += 1;
          if (health === 1) throw new Error('not healthy after 4 minutes');
        },
      },
    });
    const result = await applyRotation([item('MONGO_URI')], adapters);
    expect(result.status).toBe('rolled-back');
    expect(result.error).toMatch(/not healthy/);
    expect(calls).toEqual([
      'azure.snapshot',
      'files.backup',
      'azure.apply',
      'azure.restart',
      'azure.waitHealthy',
      'azure.restore',
      'azure.restart',
      'azure.waitHealthy',
    ]);
  });

  test('says it needs attention when the rollback is not healthy either', async () => {
    const { adapters, journal } = setup({
      azure: {
        waitHealthy: async () => {
          throw new Error('still down');
        },
      },
    });
    const result = await applyRotation([item('MONGO_URI')], adapters);
    expect(result.status).toBe('failed');
    expect(result.needsAttention).toBe(true);
    expect(journal.at(-1).phase).toBe('failed');
  });
});

describe('applyRotation, local file failures roll back', () => {
  test('restores the files and Azure when writing local files fails', async () => {
    const { adapters, calls } = setup({
      files: {
        write: async () => {
          calls.push('files.write');
          throw new Error('disk full');
        },
      },
    });
    const result = await applyRotation([item('JWT_SECRET')], adapters);
    expect(result.status).toBe('rolled-back');
    expect(result.error).toMatch(/disk full/);
    expect(calls).toEqual([
      'azure.snapshot',
      'files.backup',
      'azure.apply',
      'azure.restart',
      'azure.waitHealthy',
      'files.write',
      'files.restore',
      'azure.restore',
      'azure.restart',
      'azure.waitHealthy',
    ]);
  });
});

describe('applyRotation, GitHub failures are retried and reported, not rolled back', () => {
  test('retries a flaky secret and succeeds', async () => {
    let attempts = 0;
    const { adapters, calls } = setup({
      githubSet: () => {
        attempts += 1;
        if (attempts < 3) throw new Error('network blip');
      },
    });
    const result = await applyRotation([item('JWT_SECRET')], adapters);
    expect(result.status).toBe('done');
    expect(result.githubPending).toEqual([]);
    expect(calls.filter((c) => c === 'github.set:JWT_SECRET')).toHaveLength(3);
  });

  test('keeps going and lists the keys that still failed after all retries', async () => {
    const { adapters, calls, steps } = setup({
      githubSet: (key) => {
        if (key === 'JWT_SECRET') throw new Error('403 forbidden');
      },
    });
    const result = await applyRotation(
      [item('JWT_SECRET'), item('REFRESH_TOKEN_SECRET')],
      adapters,
    );
    expect(result.status).toBe('done');
    expect(result.githubPending).toEqual([{ key: 'JWT_SECRET', error: '403 forbidden' }]);
    expect(calls).toContain('github.set:REFRESH_TOKEN_SECRET');
    expect(calls).not.toContain('azure.restore');
    expect(steps.filter((s) => s.id === 'github').at(-1).state).toBe('warn');
  });
});

describe('rollbackFromJournal', () => {
  const state = {
    items: [
      { key: 'JWT_SECRET', old: 'old-jwt', value: 'new-jwt' },
      { key: 'RESEND_API_KEY', old: 'old-resend', value: 'new-resend' },
      { key: 'AUDIT_PASSWORD', old: undefined, value: 'new-audit' },
    ],
    azure: { azureSnapshot: true },
    files: { filesBackup: true },
  };

  function rollbackSetup(githubSet) {
    const { adapters, calls } = setup();
    const pushed = [];
    adapters.github.set = async (key, value) => {
      calls.push(`github.set:${key}`);
      pushed.push({ key, value });
      if (githubSet) githubSet(key);
    };
    return { adapters, calls, pushed };
  }

  test('puts files and Azure back, waits for health, then restores old GitHub values', async () => {
    const { adapters, calls, pushed } = rollbackSetup();
    const result = await rollback(state, adapters);
    expect(result).toEqual({ status: 'rolled-back', githubPending: [] });
    expect(calls).toEqual([
      'files.restore',
      'azure.restore',
      'azure.restart',
      'azure.waitHealthy',
      'github.set:JWT_SECRET',
    ]);
    expect(pushed).toEqual([{ key: 'JWT_SECRET', value: 'old-jwt' }]);
  });

  test('skips Azure when the run never used it', async () => {
    const { adapters, calls } = rollbackSetup();
    await rollback({ ...state, azure: undefined }, adapters);
    expect(calls.some((c) => c.startsWith('azure.'))).toBe(false);
  });

  test('lists GitHub keys that could not be restored', async () => {
    const { adapters } = rollbackSetup(() => {
      throw new Error('403');
    });
    const result = await rollback(state, adapters);
    expect(result.status).toBe('rolled-back');
    expect(result.githubPending).toEqual([{ key: 'JWT_SECRET', error: '403' }]);
  });

  test('says it failed when Azure does not come back healthy', async () => {
    const { adapters } = rollbackSetup();
    adapters.azure.waitHealthy = async () => {
      throw new Error('still down');
    };
    const result = await rollback(state, adapters);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/still down/);
  });

  test('refuses to claim success when the saved run holds nothing to restore', async () => {
    const { adapters, calls } = rollbackSetup();
    const result = await rollback({ items: state.items }, adapters);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/nothing to restore|no saved/i);
    expect(calls).toEqual([]);
  });
});

describe('externals', () => {
  const external = (calls, overrides = {}) => ({
    id: 'runner',
    label: 'Updating the runner',
    applies: (items) => items.some((i) => i.key === 'RUNNER_TOKEN'),
    snapshot: async () => {
      calls.push('ext.snapshot');
      return { token: 'old' };
    },
    apply: async () => {
      calls.push('ext.apply');
    },
    restore: async () => {
      calls.push('ext.restore');
    },
    ...overrides,
  });

  function withExternal(overrides = {}, setupOverrides = {}) {
    const made = setup(setupOverrides);
    made.adapters.externals = [external(made.calls, overrides)];
    return made;
  }

  test('snapshots it with the rest and updates it before Azure', async () => {
    const { adapters, calls } = withExternal();
    const result = await applyRotation([item('RUNNER_TOKEN')], adapters);
    expect(result.status).toBe('done');
    expect(calls).toEqual([
      'azure.snapshot',
      'files.backup',
      'ext.snapshot',
      'ext.apply',
      'azure.apply',
      'azure.restart',
      'azure.waitHealthy',
      'files.write',
      'azure.markRotated',
      'github.set:RUNNER_TOKEN',
    ]);
  });

  test('keeps its snapshot in the journal and reports its step', async () => {
    const { adapters, journal, steps } = withExternal();
    await applyRotation([item('RUNNER_TOKEN')], adapters);
    expect(journal[0].externals).toEqual({ runner: { token: 'old' } });
    expect(steps.filter((s) => s.state === 'ok').map((s) => s.id)).toEqual([
      'snapshot',
      'runner',
      'azure',
      'restart',
      'health',
      'files',
      'stamp',
      'github',
    ]);
  });

  test('is left alone when it does not apply to what changed', async () => {
    const { adapters, calls } = withExternal();
    await applyRotation([item('JWT_SECRET')], adapters);
    expect(calls.some((c) => c.startsWith('ext.'))).toBe(false);
  });

  test('a failure in it restores it and never touches Azure', async () => {
    const { adapters, calls } = setup();
    adapters.externals = [
      external(calls, {
        apply: async () => {
          calls.push('ext.apply');
          throw new Error('deployment failed');
        },
      }),
    ];
    const result = await applyRotation([item('RUNNER_TOKEN')], adapters);
    expect(result.status).toBe('rolled-back');
    expect(result.error).toMatch(/deployment failed/);
    expect(calls).toEqual([
      'azure.snapshot',
      'files.backup',
      'ext.snapshot',
      'ext.apply',
      'ext.restore',
    ]);
  });

  test('when the app never gets healthy, Azure is restored first and then the external', async () => {
    let health = 0;
    const { adapters, calls } = setup({
      azure: {
        waitHealthy: async () => {
          calls.push('azure.waitHealthy');
          health += 1;
          if (health === 1) throw new Error('not healthy');
        },
      },
    });
    adapters.externals = [external(calls)];
    const result = await applyRotation([item('RUNNER_TOKEN')], adapters);
    expect(result.status).toBe('rolled-back');
    expect(calls.slice(calls.indexOf('azure.restore'))).toEqual([
      'azure.restore',
      'azure.restart',
      'azure.waitHealthy',
      'ext.restore',
    ]);
  });

  test('when writing the files fails, files, Azure and then the external are restored', async () => {
    const { adapters, calls } = setup({
      files: {
        write: async () => {
          calls.push('files.write');
          throw new Error('disk full');
        },
      },
    });
    adapters.externals = [external(calls)];
    await applyRotation([item('RUNNER_TOKEN')], adapters);
    expect(calls.slice(calls.indexOf('files.restore'))).toEqual([
      'files.restore',
      'azure.restore',
      'azure.restart',
      'azure.waitHealthy',
      'ext.restore',
    ]);
  });

  test('says it needs attention when the external cannot be restored', async () => {
    const { adapters } = setup({
      azure: {
        apply: async () => {
          throw new Error('az exploded');
        },
      },
    });
    adapters.externals = [
      external([], {
        restore: async () => {
          throw new Error('vm is stuck');
        },
      }),
    ];
    const result = await applyRotation([item('RUNNER_TOKEN')], adapters);
    expect(result.status).toBe('failed');
    expect(result.needsAttention).toBe(true);
    expect(result.error).toMatch(/vm is stuck/);
    expect(result.cause).toBe('az exploded');
    expect(result.rollbackError).toBe('vm is stuck');
  });

  test('rollbackFromJournal restores an external after Azure', async () => {
    const { adapters, calls } = setup();
    adapters.externals = [external(calls)];
    adapters.github.set = async () => {};
    const result = await rollback(
      {
        items: [{ key: 'RUNNER_TOKEN', old: 'old', value: 'new' }],
        azure: { azureSnapshot: true },
        files: { filesBackup: true },
        externals: { runner: { token: 'old' } },
      },
      adapters,
    );
    expect(result.status).toBe('rolled-back');
    expect(calls).toEqual([
      'files.restore',
      'azure.restore',
      'azure.restart',
      'azure.waitHealthy',
      'ext.restore',
    ]);
  });
});
