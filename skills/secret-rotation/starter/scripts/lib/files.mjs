import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileKeyOf } from './current.mjs';
import { appendEnvValue, upsertEnvValue, writeFileAtomic } from './envfile.mjs';

// Local env files. Each file is changed in memory and written once, atomically,
// and the originals are kept so the whole change can be undone.
export function createFilesAdapter({ root, addMissing = true }) {
  const absolute = (relative) => path.join(root, relative);
  const filesFor = (items) => [...new Set(items.flatMap((item) => item.spec.files))];

  return {
    async backup(items) {
      const files = {};
      for (const relative of filesFor(items)) {
        if (existsSync(absolute(relative)))
          files[relative] = readFileSync(absolute(relative), 'utf8');
      }
      return { files };
    },

    async write(items, { stamp } = {}) {
      const results = [];
      for (const relative of filesFor(items)) {
        const mine = items.filter((item) => item.spec.files.includes(relative));
        if (!existsSync(absolute(relative))) {
          for (const { key } of mine) results.push({ file: relative, key, status: 'file-missing' });
          continue;
        }
        const original = readFileSync(absolute(relative), 'utf8');
        let content = original;
        for (const { key, spec, value } of mine) {
          const name = fileKeyOf(spec, key, relative);
          const result = upsertEnvValue(content, name, value, { stamp });
          if (result.status !== 'missing') {
            content = result.content;
            results.push({ file: relative, key, status: result.status });
          } else if (addMissing) {
            content = appendEnvValue(content, name, value, { stamp });
            results.push({ file: relative, key, status: 'added' });
          } else {
            results.push({ file: relative, key, status: 'missing' });
          }
        }
        if (content !== original) writeFileAtomic(absolute(relative), content);
      }
      return results;
    },

    async restore(backup) {
      for (const [relative, content] of Object.entries(backup.files))
        writeFileAtomic(absolute(relative), content);
    },
  };
}
