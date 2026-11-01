import { buildChecklist } from '../../scripts/lib/checklist.mjs';

const groups = [
  { id: 'a', title: 'Fast one', keys: ['A_KEY', 'A_SECRET'] },
  { id: 'b', title: 'Generated', keys: ['B'], generate: true },
  { id: 'c', title: 'Slow one', keys: ['C'], generate: true, slow: 'about 5 minutes' },
];

describe('buildChecklist', () => {
  test('lists the keys of a group you paste into, and says a generated one is generated', () => {
    const [a, b] = buildChecklist(groups);
    expect(a.hint).toBe('A_KEY, A_SECRET');
    expect(b.hint).toBe('generated for you');
  });

  test('everything is selected by default except what is slow', () => {
    expect(buildChecklist(groups).map((option) => option.checked)).toEqual([true, true, false]);
  });

  test('a slow group carries its time estimate as a warning to show in red', () => {
    const [a, , c] = buildChecklist(groups);
    expect(a.warn).toBeUndefined();
    expect(c.warn).toBe('about 5 minutes');
  });

  test('keeps the id and label the checklist needs', () => {
    expect(buildChecklist(groups)[2]).toMatchObject({ id: 'c', label: 'Slow one' });
  });
});
