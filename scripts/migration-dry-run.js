#!/usr/bin/env node
// Read-only rehearsal of the one-time V2 task-ID migration (lib/tasks.js), for a COPY of
// the production database before promoting V2. It writes nothing: no indexes, no new
// collections, no task or entry changes — it only reads and prints what the migration
// would do.
//
//   MONGODB_URI="mongodb+srv://…/<copy-db>" node scripts/migration-dry-run.js
//   (optional MONGODB_DB_NAME=<copy-db> if the name is not in the URI)
//
// Exit code 0 = every old value maps to a task (safe to promote); 2 = some values would
// stay unmapped (they are listed); 1 = could not run.
'use strict';
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { migrateToTaskIds } = require('../lib/tasks');
const { legacyListFor } = require('../lib/team-defaults');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const loose = new mongoose.Schema({}, { strict: false, autoIndex: false, autoCreate: false });
const model = (name, coll) => mongoose.model(name, loose.clone(), coll);
const Task = model('Task', 'tasks'), Entry = model('Entry', 'entries'), Config = model('Config', 'configs'), User = model('User', 'users');

(async () => {
  if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI to a copy of the production database.'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || undefined, serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db.databaseName;

  const state = await Config.findOne({ key: 'taskIdMigration' }).lean();
  if (state && state.value && state.value.state === 'done') {
    console.log(`Database "${db}" is already migrated (${new Date(state.value.finishedAt).toISOString()}). Nothing to rehearse.`);
    await mongoose.disconnect(); process.exit(0);
  }
  const [over, base] = await Promise.all([Config.findOne({ key: 'taskOverrides' }).lean(), Config.findOne({ key: 'taskBaselines' }).lean()]);
  const members = (await User.find({ role: 'member' }, { _id: 0, username: 1, display: 1 }).lean())
    .map(u => ({ username: u.username, display: u.display }));
  const counts = async () => ({ entries: await Entry.countDocuments({}), tasks: await Task.countDocuments({}), users: await User.countDocuments({}) });
  const before = await counts();

  const report = await migrateToTaskIds({
    Task, Entry, Config, members, dryRun: true, log: () => {},
    legacyListFor: legacyListFor((over && over.value) || {}, (base && base.value) || {}),
  });
  const after = await counts();

  console.log(`Migration rehearsal on "${db}" (read-only)`);
  console.log(`  members ................................ ${members.length}`);
  console.log(`  entries in the database ............... ${report.entriesBefore}`);
  console.log(`  entries that would be converted ...... ${report.entriesToConvert}`);
  console.log(`  task values that map to a task ....... ${report.taskValuesMapped}`);
  console.log(`  tasks that would be created from lists  ${report.tasksCreatedFromLists}`);
  console.log(`  inactive tasks kept for old names .... ${report.inactiveTasksCreatedForOldData}`);
  console.log(`  values that would stay UNMAPPED ...... ${report.unmappedValues}`);
  if (report.unmappedValues) report.unmappedSample.forEach(s => console.log('    - ' + s));
  console.log(`  nothing written: entries ${before.entries}→${after.entries}, tasks ${before.tasks}→${after.tasks}, users ${before.users}→${after.users}`);
  console.log(report.unmappedValues ? '\n✗ Some old values would not map to a task — fix before promoting.' : '\n✓ Every old value maps to a task. Safe to promote.');
  await mongoose.disconnect();
  process.exit(report.unmappedValues ? 2 : 0);
})().catch(async err => { console.error('Dry run failed:', err.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
