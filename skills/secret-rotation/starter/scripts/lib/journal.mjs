import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, secureDelete, writePrivateFile } from './safety.mjs';

const stamp = (date) =>
  date
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');

// One file per run in a private folder. It holds the old and the new values, which
// is what makes a rollback possible, so it is owner-only and meant to be deleted
// once the old credentials are revoked.
export function createJournal({ dir, id, now = () => new Date() }) {
  const runId = id ?? stamp(now());
  const file = path.join(dir, `${runId}.json`);
  let startedAt;
  let state = {};
  return {
    id: runId,
    file,
    // Each save adds to what is already recorded. The snapshot from the start of the
    // run has to survive to the end, because a rollback reads it back.
    async save(patch) {
      ensurePrivateDir(dir);
      const time = now().toISOString();
      startedAt ??= time;
      state = { ...state, ...patch };
      writePrivateFile(
        file,
        JSON.stringify({ id: runId, startedAt, updatedAt: time, ...state }, null, 2),
      );
    },
  };
}

export const loadBackup = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const { id, startedAt, phase } = loadBackup(file);
        return { file, id, startedAt, phase };
      } catch {
        return { file, id: name.replace(/\.json$/, ''), phase: 'unreadable' };
      }
    });
}

export function forgetBackups(dir) {
  const backups = listBackups(dir);
  for (const { file } of backups) secureDelete(file);
  return backups.length;
}

export const backupAgeDays = (state, now = new Date()) =>
  Math.floor((now.getTime() - Date.parse(state.startedAt)) / 86_400_000);
