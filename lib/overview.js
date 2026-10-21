// Manager Overview (V2): every number on the Overview page, computed in one pass
// from Users + Tasks + Entries + Attendance. Read-only.
'use strict';
const { entryTasksV2 } = require('./tasks');

const HISTORY_DAYS = 31;
const DEFAULT_TZ   = process.env.APP_TIMEZONE || 'Asia/Karachi';
// Optional per-user shift (user.shift). Unknown shift: start 09:00, end rule = 18:00.
const SHIFTS = { day: { start: '09:00', end: '18:00' }, night: { start: '21:00', end: '06:00' } };
const DEFAULT_SHIFT = { start: '09:00', end: '18:00' };

const toMin = hhmm => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = s => /^\d{2}:\d{2}$/.test(s || '');

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "Now" from the manager's browser when given, else the team's timezone.
function localNow(date, time, tz = DEFAULT_TZ) {
  if (isDate(date) && isTime(time)) return { date, time };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// Same rules as the member portal: does this task value contain anything?
function hasData(type, d) {
  if (!d || typeof d !== 'object') return false;
  switch (type) {
    case 'links': case 'layers': return !!(d.rows && d.rows.some(r => r.client || r.value || r.links));
    case 'count':      return d.value !== undefined && d.value !== '' && d.value !== null;
    case 'note':       return !!(d.text && String(d.text).trim());
    case 'count_note': return (d.value !== undefined && d.value !== '') || !!(d.text && String(d.text).trim());
    case 'links_note': return !!(d.links && String(d.links).trim()) || !!(d.text && String(d.text).trim());
    default:           return false;
  }
}

const sumInts = s => (String(s ?? '').match(/\d+/g) || []).reduce((a, n) => a + parseInt(n, 10), 0);

// The number compared with dailyTarget. null = this type has no number.
function achievedValue(type, d) {
  if (!d) return 0;
  switch (type) {
    case 'count': case 'count_note': return sumInts(d.value);
    case 'links': case 'layers':
      return typeof d.total === 'number' ? d.total : (d.rows || []).reduce((a, r) => a + sumInts(r.value ?? r.links), 0);
    case 'links_note': return String(d.links || '').split(/[\s,]+/).filter(Boolean).length;
    default: return null;
  }
}

// Target % for one member on one day: average over their targeted tasks, each capped at 100.
// Missing data counts as 0. null when the member has no targeted task.
function dayTarget(tasks, dayData) {
  const pcts = [];
  for (const t of tasks) {
    if (!(t.dailyTarget > 0)) continue;
    const v = achievedValue(t.type, dayData && dayData[t.taskId]);
    if (v === null) continue;
    pcts.push(Math.min(100, (v / t.dailyTarget) * 100));
  }
  return pcts.length ? { pct: pcts.reduce((a, b) => a + b, 0) / pcts.length, pcts } : null;
}

function submittedTasks(tasksById, dayData) {
  if (!dayData) return 0;
  return Object.entries(dayData).filter(([k, v]) => !k.startsWith('_') && hasData((tasksById[k] || {}).type || guess(v), v)).length;
}
const guess = v => Array.isArray(v && v.rows) ? 'links' : v && 'links' in v ? 'links_note' : v && 'value' in v && 'text' in v ? 'count_note' : v && 'value' in v ? 'count' : 'note';

function attendanceStatus(a) {
  if (!a || !a.startTime) return 'not_started';
  if ((a.checkOuts || []).some(c => c.outTime && !c.inTime)) return 'break';
  const sessions = a.sessions || [];
  const open = sessions.length ? sessions.some(s => s.startTime && !s.endTime) : !a.endTime;
  return open ? 'working' : 'offline';
}

function shiftOf(user) { return SHIFTS[(user && user.shift) || ''] || null; }

async function buildOverview({ Task, Entry, Attendance, User }, { members, date, time }) {
  const now   = localNow(date, time);
  const today = now.date;
  const days  = Array.from({ length: HISTORY_DAYS }, (_, i) => addDays(today, i - HISTORY_DAYS + 1)); // oldest → today
  const from  = addDays(today, -(HISTORY_DAYS + 30)); // extra room to find 3 earlier working days
  const usernames = members.map(m => m.username);

  const [tasks, entries, attendance, users] = await Promise.all([
    Task.find({}).lean(),
    Entry.find({ username: { $in: usernames }, date: { $gte: from, $lte: today } }).lean(),
    Attendance.find({ username: { $in: usernames }, date: { $gte: from, $lte: today } }).lean(),
    User.find({ username: { $in: usernames } }, { username: 1, shift: 1 }).lean(),
  ]);

  const tasksById = Object.fromEntries(tasks.map(t => [t.taskId, t]));
  const userDoc   = Object.fromEntries(users.map(u => [u.username, u]));
  const byUser    = Object.fromEntries(usernames.map(u => [u, { tasks: [], entries: {}, att: {} }]));
  for (const t of tasks) for (const u of t.assignees || []) if (byUser[u] && t.active !== false) byUser[u].tasks.push(t);
  const indexes = new Map();
  for (const e of entries) byUser[e.username].entries[e.date] = await entryTasksV2(Task, e, indexes);
  for (const a of attendance) byUser[a.username].att[a.date] = a;

  const nowMin = toMin(now.time);
  const team = [], attention = [];
  let present = 0, submitted = 0, onBreak = 0;
  const allPcts = [];

  for (const m of members) {
    const u = byUser[m.username];
    const todayData   = u.entries[today];
    const submittedToday = submittedTasks(tasksById, todayData) > 0;
    const att    = u.att[today];
    const status = attendanceStatus(att);
    const target = dayTarget(u.tasks, todayData);
    if (status !== 'not_started') present++;
    if (status === 'break') onBreak++;
    if (submittedToday) submitted++;
    if (target) allPcts.push(...target.pcts);

    // Streak: consecutive days with an entry, ending today (or yesterday if not yet today)
    let streak = 0;
    for (let d = submittedToday ? today : addDays(today, -1); submittedTasks(tasksById, u.entries[d]) > 0; d = addDays(d, -1)) streak++;

    team.push({
      username: m.username, display: m.display, status,
      targetPct: target ? Math.round(target.pct) : null,
      streak, submittedToday,
      startTime: att && att.startTime || null,
    });

    // Needs attention
    const shift = shiftOf(userDoc[m.username]);
    const startMin = toMin((shift || DEFAULT_SHIFT).start);
    const endMin   = toMin((shift || DEFAULT_SHIFT).end);
    const shiftOver = shift && endMin < startMin ? (nowMin >= endMin && nowMin < startMin) : nowMin >= endMin;
    const why = [];
    if (submittedToday && status === 'not_started') why.push({ kind: 'no_attendance', reason: 'Submitted an entry but has no attendance today' });
    if (status !== 'not_started' && !submittedToday && shiftOver)
      why.push({ kind: 'no_entry', reason: shift ? 'Worked today but no entry by the end of the shift' : 'Worked today but no entry after 6 PM' });
    if (status === 'not_started' && !submittedToday && nowMin >= startMin + 60)
      why.push({ kind: 'absent', reason: 'No attendance and no entry today' });
    // Last 3 working days before today (a day with attendance or an entry), all under 50% of target
    const worked = [];
    for (let d = addDays(today, -1); d >= from && worked.length < 3; d = addDays(d, -1)) {
      if (u.att[d] || submittedTasks(tasksById, u.entries[d]) > 0) worked.push(d);
    }
    if (worked.length === 3) {
      const t3 = worked.map(d => dayTarget(u.tasks, u.entries[d]));
      if (t3.every(t => t && t.pct < 50))
        why.push({ kind: 'low_target', reason: `Below 50% of target for 3 working days in a row (${t3.map(t => Math.round(t.pct) + '%').reverse().join(', ')})` });
    }
    for (const w of why) attention.push({ username: m.username, display: m.display, ...w });
  }

  // Chart history (client filters by member and 7/14/31 days)
  const history = { days, members: {} };
  for (const m of members) {
    const u = byUser[m.username];
    history.members[m.username] = days.map(d => submittedTasks(tasksById, u.entries[d]));
  }

  return {
    date: today, time: now.time,
    kpis: {
      totalMembers: members.length,
      present, submitted, onBreak,
      avgTarget: allPcts.length ? Math.round(allPcts.reduce((a, b) => a + b, 0) / allPcts.length) : null,
      targetedTasks: allPcts.length,
    },
    attention,
    team,
    history,
  };
}

module.exports = { buildOverview, localNow, achievedValue, dayTarget, attendanceStatus, hasData };
