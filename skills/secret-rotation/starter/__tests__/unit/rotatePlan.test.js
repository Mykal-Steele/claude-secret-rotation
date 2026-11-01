import {
  buildPlan,
  groupOfKey,
  generateValues,
  secondaryCopyBlock,
  revokeChecklist,
  effectsOf,
  valuesFromInputs,
  resolveInput,
} from '../../scripts/lib/plan.mjs';
import { SECRETS, GROUPS, DERIVED } from './fixtures/manifest.fixture.mjs';
import { CONFIG } from './fixtures/config.fixture.mjs';

const makePlan = (args) => buildPlan({ secrets: SECRETS, derived: DERIVED, ...args });
const group = (key, options = {}) =>
  groupOfKey(key, { groups: GROUPS, derived: DERIVED, ...options });
const effectsFor = (items, groups = GROUPS) => effectsOf(items, groups);
const revoke = (items, groups = GROUPS) => revokeChecklist(items, groups);
const generate = (keys, secrets = SECRETS) => generateValues(keys, secrets);
const secondary = (items, keys = CONFIG.secondaryCopy.keys) => secondaryCopyBlock(items, keys);

const lookup = (map) => (key) => map[key];
const item = (key, value, old = 'old', status = 'changed') => ({
  key,
  spec: SECRETS[key],
  value,
  old,
  status,
});

describe('groupOfKey', () => {
  test('finds the group a key belongs to', () => {
    expect(group('CLOUDINARY_SECRET').id).toBe('cloudinary');
    expect(group('R2_ACCESS_KEY_ID').id).toBe('r2');
  });

  test('puts the derived CLOUDINARY_URL in the cloudinary group', () => {
    expect(group('CLOUDINARY_URL').id).toBe('cloudinary');
  });

  test('returns undefined for a key no group owns', () => {
    expect(group('CLIENT_URL')).toBeUndefined();
  });
});

describe('buildPlan', () => {
  test('marks a new value as changed and remembers the old one', () => {
    const plan = makePlan({
      values: { RESEND_API_KEY: 're_new' },
      current: lookup({ RESEND_API_KEY: 're_old' }),
    });
    expect(plan.errors).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      key: 'RESEND_API_KEY',
      value: 're_new',
      old: 're_old',
      status: 'changed',
    });
    expect(plan.items[0].spec.azure).toEqual({ secret: 'resend-api-key' });
    expect(plan.changed).toHaveLength(1);
  });

  test('flags a value equal to the current one as unchanged and warns about it', () => {
    const plan = makePlan({
      values: { RESEND_API_KEY: 're_same' },
      current: lookup({ RESEND_API_KEY: 're_same' }),
    });
    expect(plan.items[0].status).toBe('unchanged');
    expect(plan.changed).toEqual([]);
    expect(plan.warnings.join(' ')).toMatch(/RESEND_API_KEY/);
    expect(plan.warnings.join(' ')).toMatch(/same/i);
  });

  test('builds CLOUDINARY_URL from the new key, the new secret and the current cloud name', () => {
    const plan = makePlan({
      values: { CLOUDINARY_KEY: '111', CLOUDINARY_SECRET: 'sss' },
      current: lookup({ CLOUDINARY_NAME: 'mycloud', CLOUDINARY_URL: 'cloudinary://old' }),
    });
    expect(plan.errors).toEqual([]);
    const url = plan.items.find((i) => i.key === 'CLOUDINARY_URL');
    expect(url).toMatchObject({
      value: 'cloudinary://111:sss@mycloud',
      old: 'cloudinary://old',
      status: 'changed',
    });
    expect(plan.items).toHaveLength(3);
  });

  test('refuses to rotate only one half of the Cloudinary pair', () => {
    const plan = makePlan({
      values: { CLOUDINARY_KEY: '111' },
      current: lookup({ CLOUDINARY_NAME: 'mycloud' }),
    });
    expect(plan.errors.join(' ')).toMatch(/together/);
    expect(plan.items.find((i) => i.key === 'CLOUDINARY_URL')).toBeUndefined();
  });

  test('errors when the cloud name is missing', () => {
    const plan = makePlan({
      values: { CLOUDINARY_KEY: '111', CLOUDINARY_SECRET: 'sss' },
      current: lookup({}),
    });
    expect(plan.errors.join(' ')).toMatch(/CLOUDINARY_NAME/);
  });

  test('keeps an explicit CLOUDINARY_URL instead of building one', () => {
    const plan = makePlan({
      values: {
        CLOUDINARY_KEY: '111',
        CLOUDINARY_SECRET: 'sss',
        CLOUDINARY_URL: 'cloudinary://x:y@z',
      },
      current: lookup({ CLOUDINARY_NAME: 'mycloud' }),
    });
    expect(plan.items.find((i) => i.key === 'CLOUDINARY_URL').value).toBe('cloudinary://x:y@z');
  });

  test('errors when two different keys got the same new value', () => {
    const plan = makePlan({
      values: { R2_ACCESS_KEY_ID: 'dup', R2_SECRET_ACCESS_KEY: 'dup' },
      current: lookup({}),
    });
    const message = plan.errors.join(' ');
    expect(message).toMatch(/R2_ACCESS_KEY_ID/);
    expect(message).toMatch(/R2_SECRET_ACCESS_KEY/);
  });

  test('errors on a key the manifest does not know', () => {
    const plan = makePlan({ values: { UNKNOWN_KEY: 'x' }, current: lookup({}) });
    expect(plan.errors.join(' ')).toMatch(/UNKNOWN_KEY/);
  });
});

describe('generateValues', () => {
  test('makes a different 64 character hex value for each generated key', () => {
    const values = generate(['JWT_SECRET', 'REFRESH_TOKEN_SECRET']);
    expect(values.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(values.REFRESH_TOKEN_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(values.JWT_SECRET).not.toBe(values.REFRESH_TOKEN_SECRET);
  });

  test('refuses a key that cannot be generated', () => {
    expect(() => generate(['MONGO_URI'])).toThrow(/MONGO_URI/);
  });
});

describe('effectsOf', () => {
  test('lists what users notice, once per group', () => {
    const effects = effectsFor([item('JWT_SECRET', 'a'), item('REFRESH_TOKEN_SECRET', 'b')]);
    expect(effects).toEqual(['Everyone is signed out.']);
  });

  test('is empty for credentials that change nothing visible', () => {
    expect(effectsFor([item('RESEND_API_KEY', 'a')])).toEqual([]);
  });

  test('ignores unchanged items', () => {
    expect(effectsFor([item('JWT_SECRET', 'a', 'a', 'unchanged')])).toEqual([]);
  });
});

describe('secondaryCopyBlock', () => {
  test('lists KEY=VALUE for changed runtime values only', () => {
    const block = secondary([
      item('MONGO_URI', 'm'),
      item('RESEND_API_KEY', 'r'),
      item('VITE_GEMINI_API_KEY', 'g'),
      item('AUDIT_PASSWORD', 'p'),
      item('JWT_SECRET', 'j'),
      item('TURNSTILE_SECRET_KEY', 't', 't', 'unchanged'),
    ]);
    expect(block).toBe('MONGO_URI=m\nJWT_SECRET=j\n');
  });

  test('is empty when nothing Failover host needs changed', () => {
    expect(secondary([item('RESEND_API_KEY', 'r')])).toBe('');
  });
});

describe('revokeChecklist', () => {
  test('lists one entry per rotated provider with what to delete', () => {
    const list = revoke([
      item('MONGO_URI', 'm'),
      item('CLOUDINARY_KEY', 'k'),
      item('CLOUDINARY_URL', 'u'),
    ]);
    expect(list.map((e) => e.title)).toEqual(['MongoDB Atlas', 'Cloudinary']);
    expect(list[0].text).toMatch(/old database user/);
  });

  test('skips generated groups and unchanged items', () => {
    expect(revoke([item('JWT_SECRET', 'j')])).toEqual([]);
    expect(revoke([item('MONGO_URI', 'm', 'm', 'unchanged')])).toEqual([]);
  });
});

describe('plan is driven by the manifest, not by key names', () => {
  const secrets = { A: { files: [] }, B: { files: [] }, C: { files: [] }, FULL_URL: { files: [] } };
  const derived = {
    FULL_URL: {
      group: 'conn',
      from: ['A', 'B'],
      needs: ['C'],
      build: (v) => `x://${v.A}:${v.B}@${v.C}`,
    },
  };

  test('builds any derived value from its parts and the settings it needs', () => {
    const plan = makePlan({
      values: { A: '1', B: '2' },
      current: lookup({ C: 'host' }),
      secrets,
      derived,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.items.find((i) => i.key === 'FULL_URL').value).toBe('x://1:2@host');
  });

  test('names the missing setting and the value that cannot be built', () => {
    const plan = makePlan({ values: { A: '1', B: '2' }, current: lookup({}), secrets, derived });
    expect(plan.errors.join(' ')).toMatch(/C/);
    expect(plan.errors.join(' ')).toMatch(/FULL_URL/);
  });

  test('wants all the parts of a derived value together', () => {
    const plan = makePlan({
      values: { A: '1' },
      current: lookup({ C: 'host' }),
      secrets,
      derived,
    });
    expect(plan.errors.join(' ')).toMatch(/A and B together/);
  });

  test('does not build a derived value nobody rotated the parts of', () => {
    const plan = makePlan({ values: {}, current: lookup({}), secrets, derived });
    expect(plan.items).toEqual([]);
    expect(plan.errors).toEqual([]);
  });

  test('groupOfKey and effects use the groups and derived values it is given', () => {
    const groups = [
      {
        id: 'conn',
        title: 'Connection',
        keys: ['A', 'B'],
        effect: 'Reconnects.',
        revoke: 'Delete it.',
      },
    ];
    expect(group('A', { groups, derived }).id).toBe('conn');
    expect(group('FULL_URL', { groups, derived }).id).toBe('conn');
    const items = [{ key: 'A', spec: secrets.A, value: 'v', old: 'o', status: 'changed' }];
    expect(effectsFor(items, groups)).toEqual(['Reconnects.']);
    expect(revoke(items, groups)).toEqual([{ title: 'Connection', text: 'Delete it.' }]);
  });

  test('the secondary copy keys are a parameter', () => {
    const items = [item('JWT_SECRET', 'j'), item('MONGO_URI', 'm')];
    expect(secondary(items, ['JWT_SECRET'])).toBe('JWT_SECRET=j\n');
  });

  test('only keys that can be generated are generated', () => {
    expect(generate(['A'], { A: { generate: 'hex32' } }).A).toMatch(/^[0-9a-f]{64}$/);
    expect(() => generate(['B'], { B: {} })).toThrow(/B/);
  });
});

describe('valuesFromInputs', () => {
  const group = {
    id: 'db',
    keys: ['DB_URL'],
    inputs: [{ name: 'user' }, { name: 'password' }],
    build: ({ user, password }, current) => ({
      ok: true,
      values: { DB_URL: `db://${user}:${password}@${current('HOST')}` },
    }),
  };

  test('turns what was typed into the values of the group, using settings that are not rotated', () => {
    const result = valuesFromInputs(
      group,
      { user: 'u', password: 'p' },
      (key) => ({ HOST: 'h' })[key],
    );
    expect(result).toEqual({ ok: true, values: { DB_URL: 'db://u:p@h' } });
  });

  test('passes on the reason when the group cannot build its values', () => {
    const failing = {
      ...group,
      build: () => ({ ok: false, problem: 'There is no current string.' }),
    };
    expect(valuesFromInputs(failing, {}, () => undefined)).toEqual({
      ok: false,
      problem: 'There is no current string.',
    });
  });

  test('turns a crash while building into a problem', () => {
    const crashing = {
      ...group,
      build: () => {
        throw new Error('boom');
      },
    };
    expect(valuesFromInputs(crashing, {}, () => undefined)).toEqual({ ok: false, problem: 'boom' });
  });

  test('refuses values for keys the group does not own', () => {
    const stray = { ...group, build: () => ({ ok: true, values: { OTHER: 'x' } }) };
    const result = valuesFromInputs(stray, {}, () => undefined);
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/OTHER/);
  });
});

describe('resolveInput', () => {
  const input = { name: 'user', current: (read) => read('USER') };
  const read = (key) => ({ USER: 'current-user' })[key];

  test('what was typed replaces the current value', () => {
    expect(resolveInput(input, 'new-user', read)).toEqual({ kind: 'changed', value: 'new-user' });
  });

  test('pressing enter keeps the current value', () => {
    expect(resolveInput(input, '', read)).toEqual({ kind: 'kept', value: 'current-user' });
    expect(resolveInput(input, '   ', read)).toEqual({ kind: 'kept', value: 'current-user' });
  });

  test('pressing enter with nothing current means a value is still needed', () => {
    expect(resolveInput(input, '', () => undefined)).toEqual({ kind: 'missing' });
    expect(resolveInput({ name: 'password' }, '', read)).toEqual({ kind: 'missing' });
  });

  test('typing the current value again counts as a change of nothing, not as keeping', () => {
    expect(resolveInput(input, 'current-user', read)).toEqual({
      kind: 'changed',
      value: 'current-user',
    });
  });
});
