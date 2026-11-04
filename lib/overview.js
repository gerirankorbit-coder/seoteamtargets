// Manager Overview (V2): every number on the Overview page, computed in one pass
// from Users + Tasks + Entries + Attendance. Read-only.
'use strict';
const { entryTasksV2 } = require('./tasks');

const HISTORY_DAYS = 31;
const DEFAULT_TZ   = process.env.APP_TIMEZONE || 'Asia/Karachi';
// Shift times, thresholds and working days come from Settings → Work rules (lib/rules.js).
// A member without a shift follows the day shift.
const rules = require('./rules');

const toMin = hhmm => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = s => /^\d{2}:\d{2}$/.test(s || '');

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "Now": the browser's values when given. Otherwise the date is the UTC calendar date —
// the same convention the member portal uses to date entries and attendance — and the
// time is the team's local clock (used by the time-of-day rules).
function localNow(date, time, tz = DEFAULT_TZ) {
  if (isDate(date) && isTime(time)) return { date, time };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: new Date().toISOString().slice(0, 10), time: `${parts.hour}:${parts.minute}` };
}

// Same rules as the member portal: does this task value contain anything?
// Shape first: a work-log day ({ rows }) counts the same whatever the task's older type was.
function hasData(type, d) {
  if (!d || typeof d !== 'object') return false;
  if (Array.isArray(d.rows)) return d.rows.some(r => r.client || r.value || r.links);
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
  if (type === 'note') return null;
  if (!d) return 0;
  if (Array.isArray(d.rows)) return typeof d.total === 'number' ? d.total : d.rows.reduce((a, r) => a + sumInts(r.value ?? r.links), 0);
  if (d.value !== undefined && d.value !== '' && type !== 'links_note') return sumInts(d.value);
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


async function buildOverview({ Task, Entry, Attendance, User, Assignment }, { members, date, time }) {
  const now   = localNow(date, time);
  const today = now.date;
  const days  = Array.from({ length: HISTORY_DAYS }, (_, i) => addDays(today, i - HISTORY_DAYS + 1)); // oldest → today
  const from  = addDays(today, -(HISTORY_DAYS + Math.max(30, rules.get().lowDays * 4))); // room to find the earlier working days
  const usernames = members.map(m => m.username);

  const [tasks, entries, attendance, users, assignments] = await Promise.all([
    Task.find({}).lean(),
    Entry.find({ username: { $in: usernames }, date: { $gte: from, $lte: today } }).lean(),
    Attendance.find({ username: { $in: usernames }, date: { $gte: from, $lte: today } }).lean(),
    User.find({ username: { $in: usernames } }, { username: 1, shift: 1 }).lean(),
    Assignment ? Assignment.find({ username: { $in: usernames } }).lean() : [],
  ]);

  const tasksById = Object.fromEntries(tasks.map(t => [t.taskId, t]));
  const userDoc   = Object.fromEntries(users.map(u => [u.username, u]));
  const byUser    = Object.fromEntries(usernames.map(u => [u, { tasks: [], allTasks: [], entries: {}, att: {} }]));
  for (const t of tasks) {
    for (const u of t.assignees || []) if (byUser[u]) { byUser[u].allTasks.push(t); if (t.active !== false) byUser[u].tasks.push(t); }
    for (const u of t.formerAssignees || []) if (byUser[u]) byUser[u].allTasks.push(t);
  }
  require('./worklog').attachTargets(byUser, assignments);
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
    const target = dayTarget(u.tasksOn(today), todayData);
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

    // Needs attention (rules from Settings → Work rules)
    const R = rules.get(), shift = rules.shiftOf(userDoc[m.username], R), sh = shift || rules.defaultShift(R);
    const startMin = toMin(sh.start), endMin = toMin(sh.end);
    const shiftOver = endMin < startMin ? (nowMin >= endMin && nowMin < startMin) : nowMin >= endMin;
    const hhmm = t => { const [h, mm] = t.split(':').map(Number); return (h % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM'); };
    const workday = rules.isWorkday(today, R);
    const why = [];
    if (R.noAttendance && submittedToday && status === 'not_started') why.push({ kind: 'no_attendance', reason: 'Submitted an entry but has no attendance today' });
    if (R.noEntry && status !== 'not_started' && !submittedToday && shiftOver)
      why.push({ kind: 'no_entry', reason: shift ? 'Worked today but no entry by the end of the shift' : 'Worked today but no entry after ' + hhmm(sh.end) });
    if (workday && status === 'not_started' && !submittedToday && nowMin >= startMin + R.late)
      why.push({ kind: 'absent', reason: 'No attendance and no entry today' });
    // Last N working days before today (a day with attendance or an entry), all under the % set
    const worked = [];
    for (let d = addDays(today, -1); d >= from && worked.length < R.lowDays; d = addDays(d, -1)) {
      if (u.att[d] || submittedTasks(tasksById, u.entries[d]) > 0) worked.push(d);
    }
    if (worked.length === R.lowDays) {
      const tN = worked.map(d => dayTarget(u.tasksOn(d), u.entries[d]));
      if (tN.every(t => t && t.pct < R.lowPct))
        why.push({ kind: 'low_target', reason: `Below ${R.lowPct}% of target for ${R.lowDays} working day${R.lowDays === 1 ? '' : 's'} in a row (${tN.map(t => Math.round(t.pct) + '%').reverse().join(', ')})` });
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

module.exports = { buildOverview, localNow, achievedValue, dayTarget, attendanceStatus, hasData, addDays, submittedTasks };
