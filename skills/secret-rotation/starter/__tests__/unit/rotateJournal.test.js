import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createJournal,
  listBackups,
  loadBackup,
  backupAgeDays,
  forgetBackups,
} from '../../scripts/lib/journal.mjs';

describe('journal', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'journal-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('saves the state in an owner-only file named after the run', async () => {
    const journal = createJournal({
      dir,
      id: '20261101-094600',
      now: () => new Date('2026-11-01T09:46:00Z'),
    });
    await journal.save({
      phase: 'snapshotted',
      items: [{ key: 'JWT_SECRET', old: 'a', value: 'b' }],
    });
    const file = path.join(dir, '20261101-094600.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const state = JSON.parse(readFileSync(file, 'utf8'));
    expect(state).toMatchObject({
      id: '20261101-094600',
      phase: 'snapshotted',
      startedAt: '2026-11-01T09:46:00.000Z',
    });
    expect(state.items[0]).toEqual({ key: 'JWT_SECRET', old: 'a', value: 'b' });
  });

  test('later saves replace the file but keep the start time', async () => {
    let clock = new Date('2026-11-01T09:46:00Z');
    const journal = createJournal({ dir, id: 'run1', now: () => clock });
    await journal.save({ phase: 'snapshotted', items: [] });
    clock = new Date('2026-11-01T09:47:30Z');
    await journal.save({ phase: 'done', items: [] });
    const state = JSON.parse(readFileSync(path.join(dir, 'run1.json'), 'utf8'));
    expect(state.phase).toBe('done');
    expect(state.startedAt).toBe('2026-11-01T09:46:00.000Z');
    expect(state.updatedAt).toBe('2026-11-01T09:47:30.000Z');
    expect(readdirSync(dir)).toEqual(['run1.json']);
  });

  test('lists backups newest first and ignores other files', async () => {
    await createJournal({ dir, id: '20261101-090000' }).save({ phase: 'done', items: [] });
    await createJournal({ dir, id: '20261102-090000' }).save({ phase: 'rolled-back', items: [] });
    writeFileSync(path.join(dir, 'rotation.lock'), '123');
    writeFileSync(path.join(dir, 'notes.txt'), 'hi');
    const list = listBackups(dir);
    expect(list.map((entry) => entry.id)).toEqual(['20261102-090000', '20261101-090000']);
    expect(list[0].phase).toBe('rolled-back');
  });

  test('returns an empty list when the folder does not exist yet', () => {
    expect(listBackups(path.join(dir, 'missing'))).toEqual([]);
  });

  test('loadBackup returns the saved state', async () => {
    await createJournal({ dir, id: 'x1' }).save({
      phase: 'done',
      items: [{ key: 'K', old: 'o', value: 'n' }],
    });
    expect(loadBackup(path.join(dir, 'x1.json')).items[0].old).toBe('o');
  });

  test('forgetBackups removes every backup and says how many', async () => {
    await createJournal({ dir, id: 'a1' }).save({ phase: 'done', items: [] });
    await createJournal({ dir, id: 'a2' }).save({ phase: 'done', items: [] });
    expect(forgetBackups(dir)).toBe(2);
    expect(existsSync(path.join(dir, 'a1.json'))).toBe(false);
    expect(listBackups(dir)).toEqual([]);
  });

  test('backupAgeDays counts whole days since the run started', () => {
    const state = { startedAt: '2026-11-01T00:00:00.000Z' };
    expect(backupAgeDays(state, new Date('2026-11-04T12:00:00Z'))).toBe(3);
  });

  test('a later save keeps what earlier saves recorded, so the backup survives to the end of the run', async () => {
    const journal = createJournal({ dir, id: 'keep1' });
    await journal.save({
      phase: 'snapshotted',
      items: [{ key: 'K', old: 'o', value: 'n' }],
      azure: { secrets: { k: 'old' } },
      files: { files: { '.env': 'K=o\n' } },
    });
    await journal.save({ phase: 'azure-applied' });
    await journal.save({ phase: 'done', githubPending: [{ key: 'K', error: 'x' }] });
    const state = loadBackup(path.join(dir, 'keep1.json'));
    expect(state.phase).toBe('done');
    expect(state.azure).toEqual({ secrets: { k: 'old' } });
    expect(state.files).toEqual({ files: { '.env': 'K=o\n' } });
    expect(state.items[0].old).toBe('o');
    expect(state.githubPending).toEqual([{ key: 'K', error: 'x' }]);
  });
});
