import { randomBytes } from 'node:crypto';
import { SECRETS, GROUPS, DERIVED } from '../secrets.manifest.mjs';
import { CONFIG } from '../secrets.config.mjs';

export function groupOfKey(key, { groups = GROUPS, derived = DERIVED } = {}) {
  const owner = derived[key]?.group;
  return groups.find((group) => (owner ? group.id === owner : group.keys.includes(key)));
}

export function generateValues(keys, secrets = SECRETS) {
  const values = {};
  for (const key of keys) {
    if (!secrets[key]?.generate) {
      throw new Error(`${key} cannot be generated, the value has to come from its provider.`);
    }
    values[key] = randomBytes(32).toString('hex');
  }
  return values;
}

// A derived value is built from the values of other keys (and from settings that are
// not being rotated), so it is never asked for. All its parts have to arrive together.
function addDerived(entries, current, derived, errors) {
  for (const [key, rule] of Object.entries(derived)) {
    if (key in entries) continue;
    const given = rule.from.filter((part) => part in entries);
    if (!given.length) continue;
    if (given.length < rule.from.length) {
      errors.push(`Rotate ${rule.from.join(' and ')} together, they come from one place.`);
      continue;
    }
    const parts = Object.fromEntries(rule.from.map((part) => [part, entries[part]]));
    const missing = (rule.needs ?? []).filter((need) => !current(need));
    if (missing.length) {
      errors.push(`${missing.join(' and ')} is not set, so ${key} cannot be built.`);
      continue;
    }
    for (const need of rule.needs ?? []) parts[need] = current(need);
    entries[key] = rule.build(parts);
  }
}

// values: what was typed or generated, current: key -> value now in use. Builds the
// list of changes and catches the mistakes that can be seen before any write.
export function buildPlan({ values, current, secrets = SECRETS, derived = DERIVED }) {
  const errors = [];
  const warnings = [];
  const entries = { ...values };
  addDerived(entries, current, derived, errors);

  const items = [];
  for (const [key, value] of Object.entries(entries)) {
    const spec = secrets[key];
    if (!spec) {
      errors.push(`${key} is not a managed secret.`);
      continue;
    }
    const old = current(key);
    const status = old === value ? 'unchanged' : 'changed';
    if (status === 'unchanged')
      warnings.push(`${key} is the same as the current value, so nothing was rotated.`);
    items.push({ key, spec, value, old, status });
  }

  const owner = new Map();
  for (const { key, value } of items) {
    if (owner.has(value)) {
      errors.push(
        `${owner.get(value)} and ${key} were given the same value. One was probably pasted in the wrong place.`,
      );
    } else {
      owner.set(value, key);
    }
  }

  return { items, changed: items.filter((item) => item.status === 'changed'), warnings, errors };
}

// What pressing enter or typing means for one part of a group. Typing replaces the part,
// enter keeps what is current, and enter with nothing current means a value is needed.
export function resolveInput(input, typed, read) {
  const value = typed?.trim();
  if (value) return { kind: 'changed', value };
  const current = input.current?.(read);
  return current ? { kind: 'kept', value: current } : { kind: 'missing' };
}

// Some groups ask for parts instead of the values themselves (a user name and a password
// instead of a connection string). `group.build(parts, current)` turns them into the values
// of the group, using settings that are not being rotated.
export function valuesFromInputs(group, inputs, current) {
  let built;
  try {
    built = group.build(inputs, current);
  } catch (error) {
    return { ok: false, problem: error.message };
  }
  if (!built.ok) return { ok: false, problem: built.problem };
  const stray = Object.keys(built.values).filter((key) => !group.keys.includes(key));
  if (stray.length)
    return { ok: false, problem: `${group.id} built ${stray.join(', ')}, which it does not own.` };
  return { ok: true, values: built.values };
}

const changedGroups = (items, groups) => {
  const seen = new Map();
  for (const item of items) {
    if (item.status !== 'changed') continue;
    const group = groupOfKey(item.key, { groups });
    if (group) seen.set(group.id, group);
  }
  return [...seen.values()];
};

export const effectsOf = (items, groups = GROUPS) =>
  changedGroups(items, groups).flatMap((group) => (group.effect ? [group.effect] : []));

// The values a second copy of the app needs, as KEY=VALUE lines to paste elsewhere.
export function secondaryCopyBlock(items, keys = CONFIG.secondaryCopy?.keys ?? []) {
  const wanted = new Set(keys);
  return items
    .filter((item) => item.status === 'changed' && wanted.has(item.key))
    .map((item) => `${item.key}=${item.value}\n`)
    .join('');
}

export const revokeChecklist = (items, groups = GROUPS) =>
  changedGroups(items, groups).flatMap((group) =>
    group.revoke ? [{ title: group.title, text: group.revoke }] : [],
  );
