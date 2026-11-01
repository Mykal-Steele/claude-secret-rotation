import { SECRETS, GROUPS, DERIVED, CONFIG_ONLY } from '../../scripts/secrets.manifest.mjs';
import { CONFIG } from '../../scripts/secrets.config.mjs';
import { FORMAT_IDS } from '../../scripts/lib/validate.mjs';
import { CHECK_TYPES } from '../../scripts/lib/verify.mjs';
import { EXTERNAL_TYPES } from '../../scripts/lib/externals/index.mjs';

// These read the real manifest and config of whichever repository the tools are in, and
// check that they agree with each other. A typo in either shows up here before it shows
// up in the middle of a rotation.
const keys = Object.keys(SECRETS);
const groupKeys = GROUPS.flatMap((group) => group.keys);

describe('manifest entries', () => {
  test('every entry names the env files it lives in', () => {
    for (const [key, spec] of Object.entries(SECRETS)) {
      expect(Array.isArray(spec.files) && spec.files.length > 0, `${key} has no files`).toBe(true);
    }
  });

  test('github is a boolean and azure is null, a secret or an env var', () => {
    for (const [key, spec] of Object.entries(SECRETS)) {
      expect(typeof spec.github, `${key}.github`).toBe('boolean');
      const azure = spec.azure;
      const ok = azure === null || Boolean(azure?.secret) !== Boolean(azure?.env);
      expect(ok, `${key}.azure must be null, { secret } or { env }`).toBe(true);
    }
  });

  test('a format is one the validator knows', () => {
    for (const [key, spec] of Object.entries(SECRETS)) {
      if (spec.format) expect(FORMAT_IDS, `${key} format "${spec.format}"`).toContain(spec.format);
    }
  });

  test('a renamed key points at a file the entry lists', () => {
    for (const [key, spec] of Object.entries(SECRETS)) {
      for (const file of Object.keys(spec.fileKeys ?? {})) {
        expect(spec.files, `${key} fileKeys names ${file}`).toContain(file);
      }
    }
  });

  test('only a generator the tool has is named', () => {
    for (const [key, spec] of Object.entries(SECRETS)) {
      if (spec.generate) expect(spec.generate, `${key}.generate`).toBe('hex32');
    }
  });
});

describe('groups', () => {
  test('ids are unique and every key in a group exists', () => {
    const ids = GROUPS.map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const key of groupKeys) expect(keys, `group key ${key}`).toContain(key);
  });

  test('a key belongs to one group only', () => {
    expect(new Set(groupKeys).size).toBe(groupKeys.length);
  });

  test('a generated group only holds keys the tool can generate', () => {
    for (const group of GROUPS.filter((g) => g.generate)) {
      for (const key of group.keys)
        expect(SECRETS[key].generate, `${group.id}: ${key}`).toBeTruthy();
    }
  });

  test('a group you paste into has a format for every key and steps to follow', () => {
    for (const group of GROUPS.filter((g) => !g.generate)) {
      expect(group.how?.length, `${group.id} needs how`).toBeGreaterThan(0);
      for (const key of group.keys)
        expect(SECRETS[key].format, `${key} needs a format`).toBeTruthy();
    }
  });

  test('a live check is a type the tool has and reads keys that exist', () => {
    for (const group of GROUPS.filter((g) => g.verify)) {
      expect(CHECK_TYPES, `${group.id} verify.type`).toContain(group.verify.type);
      for (const name of Object.values(group.verify.inputs))
        expect(keys, `${group.id} reads ${name}`).toContain(name);
    }
  });

  test('every credential can be rotated by some group or is built from other values', () => {
    for (const key of keys.filter((k) => !CONFIG_ONLY.has(k))) {
      expect(groupKeys.includes(key) || key in DERIVED, `${key} has no group`).toBe(true);
    }
  });

  test('a group that asks for parts builds its values from them without throwing', () => {
    const current = () => 'mongodb+srv://x:y@host.example.net/?retryWrites=true';
    for (const group of GROUPS.filter((g) => g.inputs)) {
      expect(typeof group.build, `${group.id} needs build`).toBe('function');
      for (const input of group.inputs) {
        expect(
          input.name && input.label,
          `${group.id} input needs a name and a label`,
        ).toBeTruthy();
      }
      for (const input of group.inputs) {
        if (input.keptNote)
          expect(typeof input.keptNote, `${group.id}.${input.name} keptNote`).toBe('string');
        if (!input.current) continue;
        const shown = input.current(current);
        expect(
          shown === undefined || typeof shown === 'string',
          `${group.id}.${input.name} current`,
        ).toBe(true);
      }
      const sample = Object.fromEntries(group.inputs.map((input) => [input.name, 'sample']));
      const built = group.build(sample, current);
      expect(built.ok, `${group.id} build with sample input`).toBe(true);
      for (const key of Object.keys(built.values))
        expect(group.keys, `${group.id} builds ${key}`).toContain(key);
    }
  });

  test('settings that are not credentials are not in any group', () => {
    for (const key of CONFIG_ONLY) expect(groupKeys, `${key}`).not.toContain(key);
  });
});

describe('derived values', () => {
  test('are real keys of a real group, built from keys of that group', () => {
    for (const [key, rule] of Object.entries(DERIVED)) {
      expect(keys, `${key}`).toContain(key);
      const group = GROUPS.find((g) => g.id === rule.group);
      expect(group, `${key} group "${rule.group}"`).toBeTruthy();
      for (const part of rule.from) expect(group.keys, `${key} part ${part}`).toContain(part);
      for (const need of rule.needs ?? []) expect(keys, `${key} needs ${need}`).toContain(need);
      expect(typeof rule.build).toBe('function');
    }
  });
});

describe('config', () => {
  test('the keys of the second copy of the app exist', () => {
    for (const key of CONFIG.secondaryCopy?.keys ?? []) expect(keys, key).toContain(key);
  });

  test('follow-ups point at keys that exist and have a command to run', () => {
    for (const followUp of CONFIG.followUps ?? []) {
      expect(keys).toContain(followUp.key);
      expect(followUp.command.length).toBeGreaterThan(0);
    }
  });

  test('externals are a type the tool has, follow a real key, and are used by a group', () => {
    for (const external of CONFIG.externals ?? []) {
      expect(EXTERNAL_TYPES, `external ${external.id}`).toContain(external.type);
      expect(keys).toContain(external.tokenKey);
      expect(
        GROUPS.some((group) => group.external === external.id),
        `no group uses ${external.id}`,
      ).toBe(true);
    }
    for (const group of GROUPS.filter((g) => g.external)) {
      expect(
        (CONFIG.externals ?? []).map((e) => e.id),
        `${group.id} external`,
      ).toContain(group.external);
    }
  });

  test('a platform the config leaves out is not used by any entry', () => {
    if (!CONFIG.azure) {
      for (const [key, spec] of Object.entries(SECRETS))
        expect(spec.azure, `${key} targets Azure`).toBeNull();
    }
    if (CONFIG.github === false) {
      for (const [key, spec] of Object.entries(SECRETS))
        expect(spec.github, `${key} targets GitHub`).toBe(false);
    }
  });

  test('a hold on an external names a login that exists and a positive time', () => {
    for (const external of CONFIG.externals ?? []) {
      if (!external.hold) continue;
      expect(keys, `${external.id} hold.uriKey`).toContain(external.hold.uriKey);
      expect(external.hold.minutes, `${external.id} hold.minutes`).toBeGreaterThan(0);
      expect(
        external.hold.collection && external.hold.field,
        `${external.id} hold needs a collection and a field`,
      ).toBeTruthy();
      expect(
        Object.keys(external.hold.match ?? {}).length,
        `${external.id} hold.match`,
      ).toBeGreaterThan(0);
    }
  });

  test('the health path starts with a slash and the production file is one the manifest uses', () => {
    expect(CONFIG.health.path.startsWith('/')).toBe(true);
    expect(Object.values(SECRETS).some((spec) => spec.files.includes(CONFIG.productionFile))).toBe(
      true,
    );
  });
});
