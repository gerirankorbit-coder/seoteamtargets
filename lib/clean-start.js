// Staging on Vercel starts clean: no test.* accounts and no TEST data, so the team can try
// it like the real thing. The first time a deployment of this version reaches the staging
// database, everything in that database is emptied once (a marker in configs makes sure it
// never happens again, so what you create while testing stays). Then the sign-in page asks
// for the first manager account (see /api/setup in server.js).
//
// Safety: runs only outside production, and only on a database whose name contains
// "staging" (server.js already refuses to start otherwise; this checks again).
'use strict';

const MARKER = 'cleanStart';

async function cleanStart({ db, Config, dbName }) {
  if (!/staging/i.test(dbName || '')) throw new Error(`clean start refused: database "${dbName}" is not a staging database`);
  // Only the instance that writes the marker empties the database
  const r = await Config.updateOne({ key: MARKER }, { $setOnInsert: { key: MARKER, value: { at: new Date().toISOString() } } }, { upsert: true });
  if (!r.upsertedCount) return { cleaned: false };
  const cols = await db.listCollections().toArray();
  const emptied = {};
  for (const { name } of cols) {
    if (name.startsWith('system.')) continue;
    const res = await db.collection(name).deleteMany(name === 'configs' ? { key: { $ne: MARKER } } : {});
    emptied[name] = res.deletedCount;
  }
  return { cleaned: true, emptied };
}

module.exports = { cleanStart, MARKER };
