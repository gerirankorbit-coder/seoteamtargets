// Test accounts and TEST data for staging databases only (never production).
//
// seedStagingData(models)                → idempotent: upserts with $setOnInsert, so
//                                          restarts and parallel cold starts never duplicate
// seedStagingData(models, { reset: true }) → also replaces the test.* entries/attendance
'use strict';
const { hashPassword } = require('./passwords');

// Test-only accounts in a staging database (seeding refuses any other database).
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

function testEntries(i, date) {
  return {
    'test.member1': {
      'Guest Posting':  { rows: [{ client: 'TEST Client A', value: String(2 + i) }], total: 2 + i, sectionNote: '' },
      'Reddit Profile': { value: String(3 + i) },
      'Quora':          { links: 'https://example.com/test-quora', text: 'TEST data' },
    },
    'test.member2': {
      'Google Stacking': { rows: [{ client: 'TEST Client B', value: String(1 + i) }], total: 1 + i, sectionNote: '' },
      'Citations':       { value: String(5 + i), text: 'TEST data' },
      'Web Working':     { text: 'TEST note for day ' + date },
    },
  };
}

// Ignore duplicate-key races between two instances seeding at the same moment.
const ignoreDup = p => p.catch(e => { if (e.code !== 11000) throw e; });

async function seedStagingData({ User, Entry, Attendance, Config }, { reset = false } = {}) {
  const dbName = User.db.name;
  if (!/staging/i.test(dbName)) throw new Error(`Refusing to seed non-staging database "${dbName}"`);

  const password = await hashPassword(TEST_PASSWORD);
  for (const u of TEST_USERS) {
    await ignoreDup(User.updateOne(
      { username: u.username },
      reset ? { $set: { ...u, password, passwordVersion: 1 } }
            : { $setOnInsert: { ...u, password, passwordVersion: 1 } },
      { upsert: true }
    ));
  }

  const cfg = await Config.findOne({ key: 'taskOverrides' });
  const overrides = (cfg && cfg.value) || {};
  if (reset || Object.keys(TEST_TASKS).some(k => !overrides[k])) {
    await ignoreDup(Config.updateOne(
      { key: 'taskOverrides' },
      { $set: { value: { ...overrides, ...TEST_TASKS } } },
      { upsert: true }
    ));
  }

  const testNames = TEST_USERS.map(u => u.username);
  if (reset) {
    await Entry.deleteMany({ username: { $in: testNames } });
    await Attendance.deleteMany({ username: { $in: testNames } });
  } else if (await Entry.exists({ username: { $in: testNames } })) {
    return; // already seeded
  }

  for (let i = 0; i < 3; i++) {
    const date = isoDaysAgo(i);
    const entries = testEntries(i, date);
    for (const username of ['test.member1', 'test.member2']) {
      await ignoreDup(Entry.updateOne(
        { username, date },
        { $setOnInsert: { username, date, tasks: entries[username] } },
        { upsert: true }
      ));
      const workMode = i % 2 ? 'WFH' : 'WFO';
      await ignoreDup(Attendance.updateOne(
        { username, date },
        { $setOnInsert: {
          username, date, workMode, startTime: '09:00', endTime: '17:00',
          sessions: [{ startTime: '09:00', endTime: '17:00', workMode }],
          checkOuts: [{ outTime: '13:00', inTime: '13:30' }],
          totalCheckOutMinutes: 30, totalWorkingMinutes: 450, note: 'TEST record',
        } },
        { upsert: true }
      ));
    }
  }
  console.log(`✓ Staging test data seeded in "${dbName}"`);
}

module.exports = { seedStagingData, TEST_USERS, TEST_PASSWORD };
