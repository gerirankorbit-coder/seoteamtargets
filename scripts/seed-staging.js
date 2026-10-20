#!/usr/bin/env node
// Seed the STAGING database with the production structure (collections +
// indexes from the app's own schemas) plus clearly-labelled test users/data.
//
//   npm run seed:staging        (reads .env.staging)
//
// Safety: refuses to run unless the target database name contains "staging".
// It never reads from or writes to the production database.
'use strict';
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env.staging', quiet: true });
process.env.APP_ENV = process.env.APP_ENV || 'staging';

const dbName = process.env.MONGODB_DB_NAME || '';
if (!process.env.MONGODB_URI) {
  console.error('✗ MONGODB_URI is not set (check .env.staging)');
  process.exit(1);
}
if (!/staging/i.test(dbName)) {
  console.error(`✗ Refusing to seed: MONGODB_DB_NAME is "${dbName}" — it must contain "staging".`);
  process.exit(1);
}

// Loading the app registers every model (and applies the staging guard).
require('../server.js');
const mongoose = require('mongoose');

const TEST_PASSWORD = process.env.STAGING_TEST_PASSWORD || 'staging-test-123';
const TEST_USERS = [
  { username: 'test.manager', role: 'manager', display: 'TEST Manager' },
  { username: 'test.member1', role: 'member',  display: 'TEST Member One' },
  { username: 'test.member2', role: 'member',  display: 'TEST Member Two' },
];
const TEST_TASKS = {
  'TEST Member One': [
    { name: 'Guest Posting',   type: 'links',      label: 'Links' },
    { name: 'Reddit Profile',  type: 'count',      label: 'Profiles' },
    { name: 'Quora',           type: 'links_note', label: 'Links' },
  ],
  'TEST Member Two': [
    { name: 'Google Stacking', type: 'layers',     label: 'Layers' },
    { name: 'Citations',       type: 'count_note', label: 'Citations' },
    { name: 'Web Working',     type: 'note',       label: 'Notes' },
  ],
};

function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function main() {
  if (mongoose.connection.readyState !== 1) await new Promise(r => mongoose.connection.once('open', r));
  const db = mongoose.connection.db;
  if (db.databaseName !== dbName) throw new Error(`Connected to "${db.databaseName}", expected "${dbName}"`);
  console.log(`✓ Connected to staging database "${db.databaseName}"`);

  // 1. Structure: create every collection + index the app defines.
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection().catch(e => { if (e.codeName !== 'NamespaceExists') throw e; });
    await model.syncIndexes();
    console.log(`  · ${model.collection.collectionName}`);
  }

  const { User, Entry, Attendance, Config } = mongoose.models;

  // 2. Test users (upsert so re-running is safe).
  for (const u of TEST_USERS) {
    await User.updateOne(
      { username: u.username },
      { $set: { ...u, password: TEST_PASSWORD, passwordVersion: 1 } },
      { upsert: true }
    );
  }

  // 3. Test task lists for the test members.
  const cfg = await Config.findOne({ key: 'taskOverrides' });
  const overrides = { ...((cfg && cfg.value) || {}), ...TEST_TASKS };
  await Config.updateOne({ key: 'taskOverrides' }, { $set: { value: overrides } }, { upsert: true });

  // 4. Three days of clearly-test entries and attendance (replaced on each run).
  const testNames = TEST_USERS.map(u => u.username);
  await Entry.deleteMany({ username: { $in: testNames } });
  await Attendance.deleteMany({ username: { $in: testNames } });
  for (let i = 0; i < 3; i++) {
    const date = isoDaysAgo(i);
    await Entry.create({ username: 'test.member1', date, tasks: {
      'Guest Posting':  { rows: [{ client: 'TEST Client A', value: String(2 + i) }], total: 2 + i, sectionNote: '' },
      'Reddit Profile': { value: String(3 + i) },
      'Quora':          { links: 'https://example.com/test-quora', text: 'TEST data' },
    } });
    await Entry.create({ username: 'test.member2', date, tasks: {
      'Google Stacking': { rows: [{ client: 'TEST Client B', value: String(1 + i) }], total: 1 + i, sectionNote: '' },
      'Citations':       { value: String(5 + i), text: 'TEST data' },
      'Web Working':     { text: 'TEST note for day ' + date },
    } });
    for (const username of ['test.member1', 'test.member2']) {
      await Attendance.create({
        username, date, workMode: i % 2 ? 'WFH' : 'WFO',
        startTime: '09:00', endTime: '17:00',
        sessions: [{ startTime: '09:00', endTime: '17:00', workMode: i % 2 ? 'WFH' : 'WFO' }],
        checkOuts: [{ outTime: '13:00', inTime: '13:30' }],
        totalCheckOutMinutes: 30, totalWorkingMinutes: 450, note: 'TEST record',
      });
    }
  }

  console.log(`✓ Seeded ${TEST_USERS.length} test users (password: ${process.env.STAGING_TEST_PASSWORD ? 'from STAGING_TEST_PASSWORD' : TEST_PASSWORD}) and 3 days of test data`);
  await new Promise(r => setTimeout(r, 1500)); // let the app's own startup sync finish
  await mongoose.disconnect();
}

main().catch(err => { console.error('✗ Seed failed:', err.message); process.exit(1); });
