import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnvValue } from './envfile.mjs';

// The name a file uses for a key, when it differs from the key's own name.
export const fileKeyOf = (spec, key, file) => spec?.fileKeys?.[file] ?? key;

// Reads the value in use now. The production file is the record, any other file
// that holds the key is the fallback when production has no value for it.
export function createReader({ root, secrets, productionFile }) {
  const readFile = (relative) => {
    const file = path.join(root, relative);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };

  return {
    readFile,
    read(key) {
      const spec = secrets[key];
      if (!spec) return undefined;
      const order = spec.files.includes(productionFile)
        ? [productionFile, ...spec.files.filter((file) => file !== productionFile)]
        : spec.files;
      for (const relative of order) {
        const content = readFile(relative);
        const value =
          content === undefined
            ? undefined
            : parseEnvValue(content, fileKeyOf(spec, key, relative));
        if (value) return value;
      }
      return undefined;
    },
  };
}
