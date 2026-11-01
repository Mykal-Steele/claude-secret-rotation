import { createFieldHold } from '../../scripts/lib/hold.mjs';

// A tiny stand-in for one MongoDB collection that understands the few operators used.
function fakeMongo({ doc, failConnect = false } = {}) {
  const state = { doc: doc ? { ...doc } : null, ops: [], closed: 0 };
  const collection = {
    findOne: async () => (state.doc ? { ...state.doc } : null),
    updateOne: async (filter, update, options = {}) => {
      state.ops.push({ filter, update, options });
      const matches =
        state.doc &&
        Object.entries(filter).every(([key, condition]) => {
          const wanted = condition?.$eq ?? condition;
          const actual = state.doc[key];
          return wanted instanceof Date
            ? actual instanceof Date && actual.getTime() === wanted.getTime()
            : actual === wanted;
        });
      if (!matches) {
        if (!options.upsert) return { matchedCount: 0 };
        state.doc = { ...(update.$setOnInsert ?? {}) };
      }
      for (const [field, value] of Object.entries(update.$max ?? {})) {
        if (!state.doc[field] || value > state.doc[field]) state.doc[field] = value;
      }
      for (const [field, value] of Object.entries(update.$set ?? {})) state.doc[field] = value;
      return { matchedCount: 1 };
    },
  };
  const mongoose = {
    createConnection: () => ({
      asPromise: async () => {
        if (failConnect) throw new Error('bad auth for mongodb+srv://u:topsecret@h/');
        return { db: { collection: () => collection }, close: async () => (state.closed += 1) };
      },
    }),
  };
  return { state, mongoose };
}

const settings = {
  uri: 'mongodb+srv://u:topsecret@h/',
  collection: 'runnerstates',
  match: { key: 'runner' },
  field: 'keepUntil',
  minutes: 20,
};
const now = () => new Date('2026-11-01T10:00:00Z');
const past = new Date(0);

describe('createFieldHold', () => {
  test('moves the field forward with $max, so a longer hold someone else made is never cut short', async () => {
    const { state, mongoose } = fakeMongo({ doc: { key: 'runner', keepUntil: past } });
    const held = await createFieldHold({ ...settings, mongoose, now }).acquire();
    expect(held.until.toISOString()).toBe('2026-11-01T10:20:00.000Z');
    expect(state.doc.keepUntil.toISOString()).toBe('2026-11-01T10:20:00.000Z');
    expect(state.ops[0].update.$max).toEqual({ keepUntil: held.until });
    expect(state.ops[0].filter).toEqual({ key: { $eq: 'runner' } });
    expect(state.ops[0].options.upsert).toBe(true);

    const longer = fakeMongo({
      doc: { key: 'runner', keepUntil: new Date('2026-11-01T13:00:00Z') },
    });
    await createFieldHold({ ...settings, mongoose: longer.mongoose, now }).acquire();
    expect(longer.state.doc.keepUntil.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });

  test('creates the document when there is none yet', async () => {
    const { state, mongoose } = fakeMongo();
    await createFieldHold({ ...settings, mongoose, now }).acquire();
    expect(state.doc).toEqual({ key: 'runner', keepUntil: new Date('2026-11-01T10:20:00Z') });
  });

  test('release puts the previous value back when nobody changed the field since', async () => {
    const { state, mongoose } = fakeMongo({ doc: { key: 'runner', keepUntil: past } });
    const held = await createFieldHold({ ...settings, mongoose, now }).acquire();
    await held.release();
    expect(state.doc.keepUntil.getTime()).toBe(0);
    expect(state.closed).toBe(1);
  });

  test('release leaves the field alone when someone else moved it after us', async () => {
    const { state, mongoose } = fakeMongo({ doc: { key: 'runner', keepUntil: past } });
    const held = await createFieldHold({ ...settings, mongoose, now }).acquire();
    state.doc.keepUntil = new Date('2026-11-01T12:00:00Z');
    await held.release();
    expect(state.doc.keepUntil.toISOString()).toBe('2026-11-01T12:00:00.000Z');
  });

  test('after a release with nothing before it the field is in the past, as the app creates it', async () => {
    const { state, mongoose } = fakeMongo();
    const held = await createFieldHold({ ...settings, mongoose, now }).acquire();
    await held.release();
    expect(state.doc.keepUntil.getTime()).toBe(0);
  });

  test('a login problem says the hold failed and never shows the connection string', async () => {
    const { mongoose } = fakeMongo({ failConnect: true });
    const error = await createFieldHold({ ...settings, mongoose, now })
      .acquire()
      .catch((e) => e);
    expect(error.message).toMatch(/hold/i);
    expect(error.message).not.toContain('topsecret');
  });
});
