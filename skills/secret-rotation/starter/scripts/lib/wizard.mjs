import { GROUPS } from '../secrets.manifest.mjs';
import { cleanInput, validateValue } from './validate.mjs';
import { describeValue, fingerprint, previewValue } from './safety.mjs';
import { buildChecklist } from './checklist.mjs';
import { effectsOf, generateValues, resolveInput, valuesFromInputs } from './plan.mjs';
import { verifyValues } from './verify.mjs';
import {
  choose,
  confirm,
  heading,
  line,
  multiSelect,
  printBox,
  readLine,
  spinner,
  style as c,
  table,
} from './tui.mjs';
import { Fatal, readCurrent, stateDir, track } from './session.mjs';

// Next to each prompt: what is in use now, and on the first one that enter keeps it. Enter
// on the first prompt skips the group, so every value stays as it is.
const promptHint = (first, shown) => {
  if (first)
    return shown
      ? `(current: ${shown}, enter keeps it and skips this group)`
      : '(enter skips this group)';
  return shown ? `(current: ${shown})` : '';
};

// For groups that ask for parts (a user name and a password) and build the values from
// them. Enter keeps the current value of a part, so the user name can stay and only the
// password change. If every part is kept nothing changes and the group is skipped.
// Returns { skipped }, { values }, or undefined when the values could not be built and
// the caller should ask for them directly.
async function collectFromInputs(group) {
  const parts = {};
  const kinds = {};
  for (const input of group.inputs) {
    for (;;) {
      const first = Object.keys(parts).length === 0;
      const shown = previewValue(input.current?.(readCurrent), Boolean(input.mask));
      const hint = shown
        ? `(current: ${shown}, enter keeps it)`
        : first
          ? '(enter skips this group)'
          : '';
      const raw = await readLine(`  ${c.bold(input.label)}${hint ? ` ${c.gray(hint)}` : ''}: `, {
        mask: Boolean(input.mask),
      });
      const typed = cleanInput(raw);
      if (/\s/.test(typed)) {
        line('fail', 'No spaces or line breaks here.');
        continue;
      }
      const result = resolveInput(input, typed, readCurrent);
      if (result.kind === 'missing') {
        if (first) {
          line('skip', `Skipped ${group.title}, it stays as it is`);
          return { skipped: true };
        }
        line('warn', 'This one is needed as well. Type it, or press Ctrl-C to stop.');
        continue;
      }
      parts[input.name] = result.value;
      kinds[input.name] = result.kind;
      if (input.mask) track(result.value);
      if (result.kind === 'kept') line('skip', `${input.label}: keeping the current one`);
      break;
    }
  }
  if (Object.values(kinds).every((kind) => kind === 'kept')) {
    line('skip', `Nothing changed for ${group.title}, it stays as it is`);
    return { skipped: true };
  }
  for (const input of group.inputs) {
    if (kinds[input.name] === 'kept' && input.keptNote) line('warn', input.keptNote);
  }
  const built = valuesFromInputs(group, parts, readCurrent);
  if (!built.ok) {
    line('fail', built.problem);
    return undefined;
  }
  const values = {};
  for (const [key, raw] of Object.entries(built.values)) {
    const result = validateValue(key, raw);
    if (!result.ok) {
      line('fail', result.problem);
      return undefined;
    }
    track(result.value);
    result.warnings.forEach((warning) => line('warn', warning));
    const old = readCurrent(key);
    line(
      'ok',
      `${key} built from what you typed, ${describeValue(result.value)}${old ? c.gray(`, current is ${fingerprint(old)}`) : ''}`,
    );
    values[key] = result.value;
  }
  return { values };
}

// What one provider needs: its steps, why they are in that order, then each value.
export async function collectGroup(group) {
  heading(group.title);
  if (group.how) {
    const lines = group.how.map((step, i) => `${i + 1}. ${step}`);
    if (group.why) lines.push('', `${c.bold('Why this way:')} ${group.why}`);
    printBox({ title: 'Do this first', tone: 'cyan', lines });
  }
  if (group.effect) line('warn', group.effect);

  if (group.generate) {
    const values = generateValues(group.keys);
    Object.values(values).forEach(track);
    line('ok', `Generated ${group.keys.length} new value${group.keys.length > 1 ? 's' : ''}`);
    return values;
  }

  if (group.inputs) {
    const outcome = await collectFromInputs(group);
    if (outcome?.skipped) return {};
    if (outcome?.values) return outcome.values;
    line('info', 'Paste the full value instead.');
  }

  const values = {};
  for (const key of group.keys) {
    for (;;) {
      const hint = promptHint(
        Object.keys(values).length === 0,
        previewValue(readCurrent(key), true),
      );
      const raw = await readLine(`  ${c.bold(key)}${hint ? ` ${c.gray(hint)}` : ''}: `, {
        mask: true,
      });
      if (!raw.trim()) {
        if (!Object.keys(values).length) {
          line('skip', `Skipped ${group.title}, it stays as it is`);
          return {};
        }
        line('warn', 'This one is needed as well. Paste it, or press Ctrl-C to stop.');
        continue;
      }
      const result = validateValue(key, raw);
      if (!result.ok) {
        line('fail', result.problem);
        const choice = await choose('What now?', [
          { key: 'r', label: 'type it again' },
          { key: 's', label: 'skip this group' },
        ]);
        if (choice === 's') return {};
        continue;
      }
      track(result.value);
      result.warnings.forEach((warning) => line('warn', warning));
      const old = readCurrent(key);
      line(
        'ok',
        `${describeValue(result.value)}${old ? c.gray(`, current is ${fingerprint(old)}`) : ''}`,
      );
      values[key] = result.value;
      break;
    }
  }
  return values;
}

export async function collectWizard() {
  heading('What do you want to rotate?');
  const picked = await multiSelect('Pick the credentials', buildChecklist(GROUPS));
  const values = {};
  for (const group of GROUPS.filter((candidate) => picked.includes(candidate.id))) {
    Object.assign(values, await collectGroup(group));
  }
  return values;
}

export async function collectScripted(args, generateKeys) {
  const values = generateKeys.length ? generateValues(generateKeys) : {};
  Object.values(values).forEach(track);
  for (const key of args.set) {
    const result = validateValue(key, await readLine(`  ${c.bold(key)}: `, { mask: true }));
    if (!result.ok) throw new Fatal(`${key}: ${result.problem}`);
    track(result.value);
    values[key] = result.value;
  }
  return values;
}

// Tests the new values with their providers. A rejected value stops the run unless the
// user types it again or insists on using it.
export async function verifyAndFix(values, { interactive }) {
  for (;;) {
    const spin = spinner('Checking the new values with each provider');
    const results = await verifyValues(values, readCurrent);
    spin.stop();
    heading('Check with the providers');
    for (const result of results)
      line(result.state, `${c.bold(result.title)}  ${c.gray(result.detail)}`);

    const failed = results.filter((result) => result.state === 'fail');
    const warned = results.filter((result) => result.state === 'warn');
    if (!failed.length && !warned.length) return values;
    if (!interactive) {
      if (failed.length) throw new Fatal('A provider rejected a new value. Nothing was changed.');
      return values;
    }
    if (!failed.length) {
      if (await confirm('Some checks could not run. Continue anyway?', { defaultYes: true }))
        return values;
      throw new Fatal('Stopped before changing anything.');
    }
    const choice = await choose(
      'A provider rejected a value. A bad value here can take the site down.',
      [
        { key: 'e', label: 'type those again' },
        { key: 'c', label: 'continue anyway' },
        { key: 'q', label: 'quit' },
      ],
    );
    if (choice === 'q') throw new Fatal('Stopped before changing anything.');
    if (choice === 'c') {
      if (await confirm('Apply a value the provider rejected?', { defaultYes: false }))
        return values;
      continue;
    }
    for (const result of failed) {
      const group = GROUPS.find((candidate) => candidate.id === result.groupId);
      group.keys.forEach((key) => delete values[key]);
      Object.assign(values, await collectGroup(group));
    }
  }
}

export function review(plan) {
  heading('Review');
  const rows = plan.items.map((item) => {
    const change =
      item.status === 'unchanged'
        ? c.yellow('same as now, skipped')
        : c.gray(
            item.old
              ? `${fingerprint(item.old)} → ${fingerprint(item.value)}`
              : `new ${fingerprint(item.value)}`,
          );
    const where = [
      item.spec.azure ? `azure ${item.spec.azure.secret ? 'secret' : 'env'}` : undefined,
      item.spec.github ? 'github' : undefined,
      `${item.spec.files.length} file${item.spec.files.length === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' · ');
    return [c.bold(item.key), change, c.gray(where)];
  });
  table(rows);
  plan.warnings.filter((w) => !/same as the current/.test(w)).forEach((w) => line('warn', w));
  const effects = effectsOf(plan.items);
  if (effects.length)
    printBox({ title: 'What people will notice', tone: 'yellow', lines: effects });
  line('info', `The old values are saved first in ${c.gray(stateDir)}, so this can be undone.`);
}
