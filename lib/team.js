// Team page + Employee 360° profile (V2). Read-only; same rules as the Overview:
// target % per day = average of the member's targeted tasks (each capped at 100%,
// missing data = 0); a "working day" is a day with attendance or an entry.
'use strict';
const { entryTasksV2, titleCase } = require('./tasks');
const { localNow, dayTarget, attendanceStatus, addDays, submittedTasks } = require('./overview');

const avg = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}

async function loadMembers({ Task, Entry, Attendance }, usernames, from, to) {
  const [tasks, entries, attendance] = await Promise.all([
    Task.find({}).lean(),
    Entry.find({ username: { $in: usernames }, date: { $gte: from, $lte: to } }).lean(),
    Attendance.find({ username: { $in: usernames }, date: { $gte: from, $lte: to } }).lean(),
  ]);
  const tasksById = Object.fromEntries(tasks.map(t => [t.taskId, t]));
  const byUser = Object.fromEntries(usernames.map(u => [u, { tasks: [], allTasks: [], entries: {}, att: {} }]));
  for (const t of tasks) {
    for (const u of t.assignees || []) if (byUser[u]) { byUser[u].allTasks.push(t); if (t.active !== false) byUser[u].tasks.push(t); }
    for (const u of t.formerAssignees || []) if (byUser[u]) byUser[u].allTasks.push(t);
  }
  const indexes = new Map();
  for (const e of entries) byUser[e.username].entries[e.date] = await entryTasksV2(Task, e, indexes);
  for (const a of attendance) byUser[a.username].att[a.date] = a;
  return { tasksById, byUser };
}

function streakOf(tasksById, u, today) {
  let n = 0;
  const start = submittedTasks(tasksById, u.entries[today]) > 0 ? today : addDays(today, -1);
  for (let d = start; submittedTasks(tasksById, u.entries[d]) > 0; d = addDays(d, -1)) n++;
  return n;
}

// Target % per working day in [from, to]; null on non-working days or with no targets
function dailyTargets(tasksById, u, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const worked = !!(u.att[d] && u.att[d].startTime) || submittedTasks(tasksById, u.entries[d]) > 0;
    const t = worked ? dayTarget(u.tasks, u.entries[d]) : null;
    out.push({ date: d, pct: t ? Math.round(t.pct) : null, worked });
  }
  return out;
}

// GET /api/team — one row per member
async function buildTeam(models, { members, users, date, time }) {
  const now = localNow(date, time), today = now.date;
  const from = addDays(today, -62), week = mondayOf(today);
  const { tasksById, byUser } = await loadMembers(models, members.map(m => m.username), from, today);
  const userDoc = Object.fromEntries(users.map(u => [u.username, u]));
  const rows = members.map(m => {
    const u = byUser[m.username], doc = userDoc[m.username] || {};
    const weekPcts = dailyTargets(tasksById, u, week, today).filter(d => d.pct !== null).map(d => d.pct);
    return {
      username: m.username, display: m.display, role: doc.role || 'member',
      shift: doc.shift || null, active: doc.active !== false,
      status: attendanceStatus(u.att[today]),
      weekTarget: avg(weekPcts), hasTargets: u.tasks.some(t => t.dailyTarget > 0),
      streak: streakOf(tasksById, u, today),
      lastActiveAt: doc.lastActiveAt || null,
    };
  });
  return { date: today, time: now.time, weekStart: week, rows };
}

// GET /api/members/:username/profile
async function buildProfile(models, { member, user, notes, date, time }) {
  const now = localNow(date, time), today = now.date;
  const monthStart = today.slice(0, 8) + '01';
  const from = addDays(today, -62);
  const { tasksById, byUser } = await loadMembers(models, [member.username], from < monthStart ? from : monthStart, today);
  const u = byUser[member.username];

  const month = Object.values(u.att).filter(a => a.date >= monthStart && a.startTime);
  const monthTargets = dailyTargets(tasksById, u, monthStart, today).filter(d => d.pct !== null).map(d => d.pct);
  const perf = dailyTargets(tasksById, u, addDays(today, -30), today);

  // "Notes for manager" written in entries, newest first
  const entryNotes = Object.entries(u.entries)
    .filter(([, t]) => t && typeof t._managerNote === 'string' && t._managerNote.trim())
    .map(([d, t]) => ({ date: d, text: t._managerNote.trim() }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const attendanceNotes = Object.values(u.att)
    .filter(a => a.note && a.note.trim())
    .map(a => ({ date: a.date, text: a.note.trim() }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const seen = new Set();
  const tasks = u.allTasks.filter(t => !seen.has(t.taskId) && seen.add(t.taskId)).map(t => ({
    taskId: t.taskId, name: titleCase(t.name), type: t.type, dailyTarget: t.dailyTarget ?? null,
    active: t.active !== false, assigned: (t.assignees || []).includes(member.username),
    sharedWith: (t.assignees || []).filter(x => x !== member.username).length,
  })).sort((a, b) => (b.assigned - a.assigned) || (b.active - a.active) || a.name.localeCompare(b.name));

  return {
    date: today, time: now.time,
    user: {
      username: member.username, display: member.display, role: user.role || 'member',
      shift: user.shift || null, active: user.active !== false, lastActiveAt: user.lastActiveAt || null,
    },
    status: attendanceStatus(u.att[today]),
    month: {
      label: new Date(today + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      presentDays: month.length,
      workingMinutes: month.reduce((a, r) => a + (r.totalWorkingMinutes || 0), 0),
      avgTarget: avg(monthTargets),
      streak: streakOf(tasksById, u, today),
    },
    perf,
    tasks,
    notes: { manager: notes, fromEntries: entryNotes, attendance: attendanceNotes },
  };
}

// GET /api/my/summary — the member's own numbers for My Space (encouragement, not a scorecard):
// current streak, today's target %, and "My Week" = the last 7 days including today.
async function buildMySummary(models, { username, date, time }) {
  const now = localNow(date, time), today = now.date;
  const weekFrom = addDays(today, -6);
  const { tasksById, byUser } = await loadMembers(models, [username], addDays(today, -62), today);
  const u = byUser[username];
  const week = dailyTargets(tasksById, u, weekFrom, today);
  const weekPcts = week.filter(d => d.pct !== null).map(d => d.pct);
  let daysSubmitted = 0, workingMinutes = 0, presentDays = 0;
  for (let d = weekFrom; d <= today; d = addDays(d, 1)) {
    if (submittedTasks(tasksById, u.entries[d]) > 0) daysSubmitted++;
    const a = u.att[d];
    if (a && a.startTime) { presentDays++; workingMinutes += a.totalWorkingMinutes || 0; }
  }
  return {
    date: today,
    streak: streakOf(tasksById, u, today),
    hasTargets: u.tasks.some(t => t.dailyTarget > 0),
    week: { from: weekFrom, to: today, daysSubmitted, presentDays, workingMinutes, avgTarget: avg(weekPcts),
            days: week.map(d => ({ date: d.date, pct: d.pct, submitted: submittedTasks(tasksById, u.entries[d.date]) > 0 })) },
  };
}

module.exports = { buildTeam, buildProfile, buildMySummary, loadMembers, streakOf, dailyTargets, mondayOf };
