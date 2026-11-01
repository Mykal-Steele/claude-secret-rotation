import { redact } from './safety.mjs';
import { loadMongoose } from './verify.mjs';

// Something else in the system may switch a resource off when it looks idle (an app that
// stops a VM nobody is using). A rotation that has to use the resource needs that stopped
// for a while, the same way a person would ask for a hold. This does it the way the app
// itself does: it moves a date field forward with $max, so it can never cut short a longer
// hold someone else made, and it gives the field back afterwards only if nobody has moved
// it since.
export function createFieldHold({
  uri,
  collection,
  match,
  field,
  minutes,
  mongoose,
  now = () => new Date(),
}) {
  return {
    async acquire() {
      let connection;
      try {
        connection = await (mongoose ?? loadMongoose())
          .createConnection(uri, { serverSelectionTimeoutMS: 8000, appName: 'rotation-hold' })
          .asPromise();
        const filter = Object.fromEntries(
          Object.entries(match).map(([key, value]) => [key, { $eq: value }]),
        );
        const target = connection.db.collection(collection);
        const previous = (await target.findOne(filter))?.[field];
        const until = new Date(now().getTime() + minutes * 60_000);
        await target.updateOne(
          filter,
          { $max: { [field]: until }, $setOnInsert: match },
          { upsert: true },
        );
        return {
          until,
          async release() {
            try {
              await target.updateOne(
                { ...filter, [field]: until },
                { $set: { [field]: previous ?? new Date(0) } },
              );
            } finally {
              await connection.close();
            }
          },
        };
      } catch (error) {
        await connection?.close().catch(() => {});
        const reason = redact(String(error.message).split('\n')[0], [uri]);
        throw new Error(
          `Could not take the hold, the database login failed or could not be reached (${reason.slice(0, 80)}).`,
        );
      }
    },
  };
}
