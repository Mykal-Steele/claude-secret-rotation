import { CONFIG } from '../../secrets.config.mjs';
import { readCurrent, root, stateDir } from '../session.mjs';

// A kind of external is a file in this folder that exports a factory returning
//   { id, label, applies(items), snapshot(items), apply(items, snapshot), restore(snapshot, items) }
// plus an entry in the map below. CONFIG.externals lists the ones a repository uses.
// docs/adapters.md in the skill has the contract and the tests to write.
const FACTORIES = {};

export const EXTERNAL_TYPES = Object.keys(FACTORIES);

export function buildExternals() {
  return (CONFIG.externals ?? []).map((entry) => {
    const factory = FACTORIES[entry.type];
    if (!factory) throw new Error(`Unknown external type "${entry.type}" in secrets.config.mjs.`);
    return factory({ config: entry, root, current: readCurrent, paramsDir: stateDir });
  });
}
