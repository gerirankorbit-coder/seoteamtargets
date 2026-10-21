// Test accounts and TEST data for staging databases only (never production).
//
// seedStagingData(models)                → idempotent: upserts with $setOnInsert, so
//                                          restarts and parallel cold starts never duplicate
// seedStagingData(models, { reset: true }) → also replaces the test.* entries/attendance
'use strict';
const { hashPassword } = require('./passwords');
const { newTaskId, legacyKey, ENTRY_VERSION } = require('./tasks');

// Test-only accounts in a staging database (seeding refuses any other database).
const TEST_PASSWORD = process.env.STAGING_TEST_PASSWORD || 'staging-test-123';
const TEST_USERS = [
  { username: 'test.manager', role: 'manager', display: 'TEST Manager' },
  { username: 'test.member1', role: 'member',  display: 'TEST Member One' },
  { username: 'test.member2', role: 'member',  display: 'TEST Member Two' },
];
// Per test member: task list (with daily targets) — stored as Task documents.
const TEST_TASKS = {
  'test.member1': [
    { name: 'Guest Posting',   type: 'links',      label: 'Links',     dailyTarget: 5 },
    { name: 'Reddit Profile',  type: 'count',      label: 'Profiles',  dailyTarget: 4 },
    { name: 'Quora',           type: 'links_note', label: 'Links',     dailyTarget: null },
  ],
  'test.member2': [
    { name: 'Google Stacking', type: 'layers',     label: 'Layers',    dailyTarget: 3 },
    { name: 'Citations',       type: 'count_note', label: 'Citations', dailyTarget: 6 },
    { name: 'Web Working',     type: 'note',       label: 'Notes',     dailyTarget: null },
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

async function seedStagingData({ User, Entry, Attendance, Task }, { reset = false } = {}) {
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

  // Tasks keyed like migrated ones ("<username>|<name>"), so re-seeding re-uses them.
  const taskIds = {};
  for (const [username, list] of Object.entries(TEST_TASKS)) {
    taskIds[username] = {};
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      await ignoreDup(Task.updateOne(
        { legacyKey: legacyKey(username, t.name) },
        reset ? { $set: { ...t, active: true, order: i, assignees: [username], formerAssignees: [] },
                  $setOnInsert: { taskId: newTaskId() } }
              : { $setOnInsert: { taskId: newTaskId(), ...t, active: true, order: i, assignees: [username] } },
        { upsert: true }
      ));
      taskIds[username][t.name] = (await Task.findOne({ legacyKey: legacyKey(username, t.name) }).lean()).taskId;
    }
  }
  const byId = (username, tasks) => Object.fromEntries(
    Object.entries(tasks).map(([name, v]) => [taskIds[username][name] || name, v]));

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
        { $setOnInsert: { username, date, tasks: byId(username, entries[username]), entryVersion: ENTRY_VERSION } },
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
