// Work log (V2.1): every piece of work is one line — task · client · how many.
//
// Lines live in the day's Entry, under the task's ID, in the "rows" shape the Links List
// type always used:   tasks[taskId] = { rows: [{ client, clientId, value }], total, sectionNote }
// Older entries keep their own shapes ({ value }, { links, text } …); every reader is
// shape-based, so old days and new days count the same way.
//
// Targets belong to an assignment: one member, one task, a daily target, and the dates it
// applies (from … to, to = null while it runs). A month is judged against the targets that
// applied on each of its days, so changing a target later never rewrites past months.
// Tasks with no assignment rows yet (everything made before the work log) fall back to the
// task's own dailyTarget while the member is assigned — exactly the old behaviour.
'use strict';
const { addDays, achievedValue, hasData, attendanceStatus } = require('./overview');

const BEGINNING = '2000-01-01';
const looseName = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const avg = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
const isWeekday = iso => require('./rules').isWorkday(iso); // working day per Settings → Work rules
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const prevMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
const monthLabel = ym => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const covers = (r, d) => r.from <= d && (!r.to || r.to >= d);

// ── Assignments → targets on a given day ──────────────────────────────────
function assignIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const k = r.username + '|' + r.taskId;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  }
  for (const list of idx.values()) list.sort((a, b) => a.from.localeCompare(b.from));
  return idx;
}

// Give every member in byUser a tasksOn(date): their tasks that day, each with that day's
// dailyTarget. byUser[u] = { tasks (current, active), allTasks (incl. former) } from loadMembers.
function attachTargets(byUser, assignments) {
  const idx = assignIndex(assignments);
  for (const [username, u] of Object.entries(byUser)) {
    const current = new Set(u.tasks.map(t => t.taskId));
    const seen = new Set();
    const pool = [...u.tasks, ...(u.allTasks || [])].filter(t => !seen.has(t.taskId) && seen.add(t.taskId));
    u.assignRows = idx;
    u.tasksOn = date => {
      const out = [];
      for (const t of pool) {
        const rows = idx.get(username + '|' + t.taskId);
        if (rows) { const r = rows.find(x => covers(x, date)); if (r) out.push({ ...t, dailyTarget: r.target }); }
        else if (current.has(t.taskId)) out.push(t);
      }
      return out;
    };
  }
  return byUser;
}

// Task.assignees mirrors "assigned today" for tasks that have assignment rows (the rest of
// the app reads assignees). Run after every assignment change and once a day (a change can
// be dated in the future). Returns the usernames whose task list changed.
async function syncAssignees({ Task, Assignment }, today) {
  const rows = await Assignment.find({}).lean();
  const byTask = new Map();
  for (const r of rows) {
    if (!byTask.has(r.taskId)) byTask.set(r.taskId, new Map());
    const m = byTask.get(r.taskId);
    const st = m.get(r.username) || { now: false, past: false };
    if (covers(r, today)) st.now = true;
    if (r.from <= today) st.past = true;
    m.set(r.username, st);
  }
  if (!byTask.size) return [];
  const tasks = await Task.find({ taskId: { $in: [...byTask.keys()] } }).lean();
  const changed = new Set();
  for (const t of tasks) {
    const people = byTask.get(t.taskId);
    const assignees = new Set(t.assignees || []), former = new Set(t.formerAssignees || []);
    for (const [u, st] of people) {
      if (st.now) { if (!assignees.has(u)) changed.add(u); assignees.add(u); former.delete(u); }
      else {
        if (assignees.has(u)) changed.add(u);
        assignees.delete(u);
        if (st.past) former.add(u);
      }
    }
    const a = [...assignees], f = [...former];
    if (a.join() !== (t.assignees || []).join() || f.join() !== (t.formerAssignees || []).join())
      await Task.updateOne({ taskId: t.taskId }, { $set: { assignees: a, formerAssignees: f } });
  }
  return [...changed];
}

// Set (or change) a member's daily target for a task from a date on. A task that was
// assigned before the work log first gets a "so far" row with its old target, so the
// days before keep the target they had.
async function setAssignment({ Task, Assignment }, { username, taskId, target, from, by }) {
  const task = await Task.findOne({ taskId }).lean();
  if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
  const rows = await Assignment.find({ username, taskId }).lean();
  if (!rows.length && (task.assignees || []).includes(username) && from > BEGINNING)
    await Assignment.create({ username, taskId, target: task.dailyTarget ?? null, from: BEGINNING, to: addDays(from, -1), by });
  await endAssignment({ Assignment }, { username, taskId, from, keepLegacy: true });
  await Assignment.create({ username, taskId, target: target ?? null, from, to: null, by });
}

// Stop a member's assignment from a date on (the day before `from` is their last day).
async function endAssignment({ Task, Assignment }, { username, taskId, from, by, keepLegacy = false }) {
  const rows = await Assignment.find({ username, taskId }).lean();
  if (!rows.length && !keepLegacy) {
    const task = await Task.findOne({ taskId }).lean();
    if (task && (task.assignees || []).includes(username))
      await Assignment.create({ username, taskId, target: task.dailyTarget ?? null, from: BEGINNING, to: addDays(from, -1), by });
    return;
  }
  let hadPast = false;
  for (const r of rows) {
    if (r.from >= from) await Assignment.deleteOne({ _id: r._id });                       // not started yet: drop it
    else { hadPast = true; if (!r.to || r.to >= from) await Assignment.updateOne({ _id: r._id }, { $set: { to: addDays(from, -1) } }); }
  }
  // No row left means no row covers today either, and the sync no longer knows this
  // member — so take them off the task here
  if (!keepLegacy && Task && !(await Assignment.exists({ username, taskId })))
    await Task.updateOne({ taskId }, hadPast ? { $pull: { assignees: username }, $addToSet: { formerAssignees: username } } : { $pull: { assignees: username } });
}

// ── Task library: tasks grouped by name (each member may have their own copy of a task
// from before V2; the board shows them as one row) ─────────────────────────
function libraryOf(tasks) {
  const groups = new Map();
  const sorted = [...tasks].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  for (const t of sorted) {
    const k = looseName(t.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.values()].map(list => {
    const active = list.filter(t => t.active !== false);
    const head = active.find(t => String(t.legacyKey || '').startsWith('task:')) || active[0] || list[0];
    return {
      key: head.taskId, name: head.name, unit: head.unit || unitFromLabel(head), group: head.group || 'Other',
      note: head.type === 'note', active: active.length > 0, taskIds: list.map(t => t.taskId), tasks: list,
    };
  });
}
function unitFromLabel(t) {
  if (t.type === 'note') return 'notes';
  const l = String(t.label || '').trim().toLowerCase();
  return l && !['links', 'layers', 'count', 'note', 'count_note', 'links_note'].includes(l) ? l : t.type === 'layers' ? 'layers' : t.type === 'links' || t.type === 'links_note' ? 'links' : 'items';
}
// The task document a member works on for a library row: their own copy if they have one
function taskIdFor(lib, username) {
  const own = lib.tasks.find(t => (t.assignees || []).includes(username)) || lib.tasks.find(t => (t.formerAssignees || []).includes(username));
  return own ? own.taskId : lib.key;
}

// ── Day and month numbers ────────────────────────────────────────────────
const rowsOf = d => (d && Array.isArray(d.rows) ? d.rows : []);
function linesCount(day) {
  if (!day) return 0;
  return Object.entries(day).reduce((a, [k, v]) => a + (k.startsWith('_') ? 0 : rowsOf(v).filter(r => r.client || r.value).length || (hasData(guessType(v), v) ? 1 : 0)), 0);
}
const guessType = v => Array.isArray(v && v.rows) ? 'links' : v && 'links' in v ? 'links_note' : v && 'value' in v && 'text' in v ? 'count_note' : v && 'value' in v ? 'count' : 'note';
const worked = (tasksById, u, d) => !!(u.att[d] && u.att[d].startTime) ||
  Object.entries(u.entries[d] || {}).some(([k, v]) => !k.startsWith('_') && hasData((tasksById[k] || {}).type || guessType(v), v));

function taskDone(t, data) { const v = achievedValue(t.type, data); return v === null ? null : v; }

// Today, per member: status, each task's done vs target, a score (capped average)
function todayRow(tasksById, m, u, today, entryDoc) {
  const day = u.entries[today] || {};
  const tasks = u.tasksOn(today).map(t => {
    const done = taskDone(t, day[t.taskId]);
    const target = t.dailyTarget > 0 ? t.dailyTarget : null;
    const d = day[t.taskId] || {};
    return { taskId: t.taskId, name: t.name, unit: t.unit || unitFromLabel(t), note: t.type === 'note', done: done ?? 0, target,
             pct: target && done !== null ? Math.round(done / target * 100) : null, lines: rowsOf(day[t.taskId]).length,
             rows: rowsOf(day[t.taskId]).map(r => ({ client: String(r.client || '').trim().slice(0, 80), value: parseInt(String(r.value ?? r.links ?? '').replace(/\D+/g, '') || '0', 10) }))
               .filter(r => r.client || r.value),
             text: String(d.text || d.sectionNote || '').trim().slice(0, 400) };
  });
  const scored = tasks.filter(t => t.pct !== null);
  return {
    username: m.username, display: m.display, status: attendanceStatus(u.att[today]),
    startTime: (u.att[today] && u.att[today].startTime) || null,
    lastUpdate: entryDoc ? entryDoc.updatedAt : null,
    lines: linesCount(day), tasks,
    score: scored.length ? Math.round(scored.reduce((a, t) => a + Math.min(100, t.pct), 0) / scored.length) : null,
  };
}

// One member, one month (to = today while the month is running)
function monthOf(tasksById, u, ym, today) {
  const from = ym + '-01', end = monthEnd(ym), to = end < today ? end : today;
  if (from > today) return null;
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const per = new Map();
  const daily = [];
  let present = 0;
  for (const d of days) {
    const here = worked(tasksById, u, d);
    if (here) present++;
    const data = u.entries[d] || {};
    const onDay = u.tasksOn(d);
    const pcts = [];
    for (const t of onDay) {
      if (t.type === 'note') continue;
      const done = taskDone(t, data[t.taskId]) || 0;
      if (!per.has(t.taskId)) per.set(t.taskId, { taskId: t.taskId, name: t.name, unit: t.unit || unitFromLabel(t), done: 0, potential: 0, days: 0, series: [], targets: new Set() });
      const p = per.get(t.taskId);
      p.done += done;
      if (here) {
        p.days++; p.series.push({ date: d, done, target: t.dailyTarget > 0 ? t.dailyTarget : null });
        if (t.dailyTarget > 0) { p.potential += t.dailyTarget; p.targets.add(t.dailyTarget); pcts.push(Math.min(100, done / t.dailyTarget * 100)); }
      }
    }
    daily.push({ date: d, present: here, pct: here && pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null });
  }
  // Work logged on a task not assigned that day (moved, or logged anyway) still counts as done
  for (const d of days) for (const [k, v] of Object.entries(u.entries[d] || {})) {
    if (k.startsWith('_') || per.has(k) || !tasksById[k] || tasksById[k].type === 'note') continue;
    const t = tasksById[k], done = taskDone(t, v) || 0;
    if (!done) continue;
    per.set(k, { taskId: k, name: t.name, unit: t.unit || unitFromLabel(t), done, potential: 0, days: 0, series: [], targets: new Set() });
  }
  const tasks = [...per.values()].map(p => ({
    taskId: p.taskId, name: p.name, unit: p.unit, done: p.done, potential: p.potential,
    target: p.targets.size === 1 ? [...p.targets][0] : p.targets.size ? Math.round(p.potential / Math.max(1, p.series.filter(s => s.target).length)) : null,
    targetChanged: p.targets.size > 1,
    pct: p.potential ? Math.round(p.done / p.potential * 100) : null,
    avg: p.days ? Math.round(p.done / p.days * 10) / 10 : null,
    series: p.series,
  }));
  const scored = tasks.filter(t => t.pct !== null);
  const clients = {}, clientTasks = {};
  for (const d of days) for (const [k, v] of Object.entries(u.entries[d] || {})) {
    if (k.startsWith('_')) continue;
    for (const r of rowsOf(v)) {
      const name = String(r.client || '').trim(); if (!name) continue;
      const key = r.clientId || 'name:' + looseName(name);
      const c = clients[key] = clients[key] || { clientId: r.clientId || null, name, total: 0 };
      const v = parseInt(String(r.value ?? r.links ?? '').replace(/\D+/g, '') || '0', 10);
      c.total += v;
      const t = tasksById[k] || {}, tk = key + '|' + k;
      const ct = clientTasks[tk] = clientTasks[tk] || { client: name, taskId: k, task: t.name || k, unit: t.unit || unitFromLabel(t), total: 0 };
      ct.total += v;
    }
  }
  return {
    month: ym, label: monthLabel(ym), from, to, running: to < end,
    // working days = working days in Work rules (no holidays), plus any other day they actually worked (same rule as Reports)
    workdays: days.filter(d => isWeekday(d) || worked(tasksById, u, d)).length, present,
    score: scored.length ? Math.round(scored.reduce((a, t) => a + Math.min(100, t.pct), 0) / scored.length) : null,
    tasks, daily, clients: Object.values(clients).sort((a, b) => b.total - a.total),
    clientTasks: Object.values(clientTasks).filter(c => c.total > 0).sort((a, b) => a.client.localeCompare(b.client) || b.total - a.total),
  };
}

module.exports = {
  BEGINNING, looseName, avg, monthEnd, prevMonth, monthLabel, covers,
  attachTargets, syncAssignees, setAssignment, endAssignment,
  libraryOf, unitFromLabel, taskIdFor, rowsOf, linesCount, todayRow, monthOf, worked,
};
