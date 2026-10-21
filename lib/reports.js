// Reports page (V2): one row per member for a period, from real Entry + Attendance data.
// Same rules as Overview / Team: a day's target % = average of the member's targeted
// tasks (each capped at 100%, missing data = 0), counted on working days only.
//
// Submission rate = days with an entry ÷ expected days. Expected days = the weekdays
// (Mon–Fri) in the period, plus any weekend day the member actually worked or submitted.
'use strict';
const { localNow, addDays, submittedTasks } = require('./overview');
const { loadMembers, streakOf, dailyTargets, mondayOf } = require('./team');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const avg = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
const isWeekend = iso => [0, 6].includes(new Date(iso + 'T00:00:00Z').getUTCDay());
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5) + 1;

// period: 'week' | 'month' | 'custom' (with from/to). The end is never after today.
function resolvePeriod({ period, from, to }, today) {
  if (period === 'custom') {
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw Object.assign(new Error('Pick a start and an end date'), { status: 400 });
    if (to > today) to = today;
    if (from > to) throw Object.assign(new Error('The start date must be before the end date'), { status: 400 });
    if (daysBetween(from, to) > MAX_DAYS) throw Object.assign(new Error('Pick a range of one year or less'), { status: 400 });
    return { period, from, to };
  }
  if (period === 'month') return { period, from: today.slice(0, 8) + '01', to: today };
  return { period: 'week', from: mondayOf(today), to: today };
}

async function buildReport(models, { members, query }) {
  const today = localNow(query.date, query.time).date;
  const range = resolvePeriod(query, today);
  const loadFrom = addDays(range.from < addDays(today, -62) ? range.from : addDays(today, -62), -1);
  const { tasksById, byUser } = await loadMembers(models, members.map(m => m.username), loadFrom, today);

  const rows = members.map(m => {
    const u = byUser[m.username];
    let presentDays = 0, workingMinutes = 0, submittedDays = 0, expectedDays = 0;
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      const a = u.att[d];
      const present = !!(a && a.startTime);
      const submitted = submittedTasks(tasksById, u.entries[d]) > 0;
      if (present) { presentDays++; workingMinutes += a.totalWorkingMinutes || 0; }
      if (submitted) submittedDays++;
      if (!isWeekend(d) || present || submitted) expectedDays++;
    }
    const pcts = dailyTargets(tasksById, u, range.from, range.to).filter(x => x.pct !== null).map(x => x.pct);
    return {
      username: m.username, display: m.display, active: m.active !== false,
      presentDays, workingMinutes, submittedDays, expectedDays,
      submissionRate: expectedDays ? Math.round(submittedDays / expectedDays * 100) : null,
      avgTarget: avg(pcts),
      hasTargets: u.tasks.some(t => t.dailyTarget > 0),
      streak: streakOf(tasksById, u, today),
    };
  });
  return { ...range, today, days: daysBetween(range.from, range.to), rows };
}

module.exports = { buildReport, resolvePeriod };
