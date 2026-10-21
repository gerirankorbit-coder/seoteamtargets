// Task model helpers (V2): every task has a permanent taskId; entries store task
// data under taskId, so renaming a task never hides old data.
//
// Entry.tasks before V2:  { "<task name>": data, "_managerNote": "…" }
// Entry.tasks in V2:      { "<taskId>":    data, "_managerNote": "…" }   (Entry.entryVersion = 2)
// Keys starting with "_" are not tasks and are kept as they are.
'use strict';
const crypto = require('crypto');

const TASK_TYPES   = ['links', 'layers', 'count', 'note', 'count_note', 'links_note'];
const ENTRY_VERSION = 2;
const MIGRATION_KEY = 'taskIdMigration';
const LOCK_STALE_MS = 5 * 60 * 1000;

const newTaskId = () => crypto.randomUUID();
const legacyKey = (username, name) => `${username}|${name}`;
const isMetaKey = k => k.startsWith('_');
const escapeRe  = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Task names in Title Case: every word starts with a capital, short joining words stay
// lower case (except first), and words already holding capitals (PDF, GMB, GA4, iOS) are kept.
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with']);
const ACRONYMS = Object.fromEntries(['SEO', 'PDF', 'GMB', 'GBP', 'GTM', 'GA4', 'SBM', 'URL', 'URLs', 'PR', 'PRs', 'GP', 'CK', 'BD', 'PD',
  'SMM', 'KPI', 'API', 'UI', 'UX', 'CTR', 'DA', 'PA', 'DR', 'NAP', 'CMS', 'WP'].map(a => [a.toLowerCase(), a]));
function titleCase(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').split(' ').map((w, i) => {
    if (/[A-Z]/.test(w)) return w;
    if (ACRONYMS[w]) return ACRONYMS[w];
    if (i > 0 && SMALL_WORDS.has(w.toLowerCase())) return w.toLowerCase();
    return w.replace(/^([^a-z]*)([a-z])/, (m, pre, c) => pre + c.toUpperCase());
  }).join(' ');
}

function publicTask(t, { withAssignees = false } = {}) {
  const out = {
    taskId:      t.taskId,
    name:        titleCase(t.name),
    type:        t.type,
    label:       t.label || t.type,
    dailyTarget: typeof t.dailyTarget === 'number' ? t.dailyTarget : null,
    active:      t.active !== false,
  };
  if (withAssignees) out.assignees = t.assignees || [];
  return out;
}

function cleanTaskInput(t) {
  const name = titleCase((t && t.name) || '');
  const type = TASK_TYPES.includes(t && t.type) ? t.type : null;
  if (!name || !type) return null;
  const target = t.dailyTarget === '' || t.dailyTarget == null ? null : Number(t.dailyTarget);
  return {
    name, type,
    label:       String(t.label || type).trim() || type,
    dailyTarget: Number.isFinite(target) && target >= 0 ? target : null,
    active:      t.active !== false,
  };
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || new Date(a.createdAt) - new Date(b.createdAt);

// Tasks of one member. Default: active tasks assigned now (the entry form).
// includeHistory: also inactive and previously-assigned tasks (history views).
async function tasksForUser(Task, username, { includeHistory = false } = {}) {
  const q = includeHistory
    ? { $or: [{ assignees: username }, { formerAssignees: username }] }
    : { assignees: username, active: { $ne: false } };
  return (await Task.find(q).lean()).sort(byOrder).map(t => publicTask(t));
}

// Same as tasksForUser, for many members at once (one query).
async function tasksByUser(Task, usernames, opts = {}) {
  const all = (await Task.find({}).lean()).sort(byOrder);
  const out = {};
  for (const u of usernames) {
    out[u] = all.filter(t => opts.includeHistory
      ? (t.assignees || []).includes(u) || (t.formerAssignees || []).includes(u)
      : (t.assignees || []).includes(u) && t.active !== false).map(t => publicTask(t));
  }
  return out;
}

// ── Reading old (name-keyed) entries ─────────────────────────────────────────
// name → taskId for one member: original names recorded by the migration first,
// then the current names of tasks they have (or had).
async function nameIndex(Task, username) {
  const tasks = await Task.find({ $or: [
    { legacyKey: { $regex: '^' + escapeRe(username) + '\\|' } },
    { assignees: username }, { formerAssignees: username },
  ] }).lean();
  const idx = new Map();
  for (const t of tasks) if (t.legacyKey && t.legacyKey.startsWith(username + '|')) idx.set(t.legacyKey.slice(username.length + 1), t.taskId);
  for (const t of tasks) if (!idx.has(t.name)) idx.set(t.name, t.taskId);
  return idx;
}

function mapLegacyTasks(idx, tasks) {
  const out = {}, unmapped = [];
  for (const [k, v] of Object.entries(tasks || {})) {
    if (isMetaKey(k)) { out[k] = v; continue; }
    if (idx.has(k)) out[idx.get(k)] = v;
    else { out[k] = v; unmapped.push(k); }
  }
  return { tasks: out, unmapped };
}

// Returns entry.tasks keyed by taskId, converting an unmigrated entry on the fly.
// `indexes` caches nameIndex() per username for the duration of one request.
async function entryTasksV2(Task, entry, indexes = new Map()) {
  if (entry.entryVersion === ENTRY_VERSION) return entry.tasks || {};
  if (!indexes.has(entry.username)) indexes.set(entry.username, await nameIndex(Task, entry.username));
  return mapLegacyTasks(indexes.get(entry.username), entry.tasks).tasks;
}

// ── Editing a member's list (Edit Tasks) ────────────────────────────────────
// `list` is the member's full ordered list. Items with a known taskId are updated
// (shared tasks update for everyone they are assigned to); items without one are
// created. Tasks dropped from the list are unassigned from this member only.
async function saveMemberTaskList(Task, username, list) {
  const keep = [];
  for (let i = 0; i < list.length; i++) {
    const t = cleanTaskInput(list[i]);
    if (!t) throw Object.assign(new Error(`Task ${i + 1} needs a name and a valid type`), { status: 400 });
    const existing = list[i].taskId && await Task.findOne({ taskId: list[i].taskId });
    if (existing) {
      await Task.updateOne({ taskId: existing.taskId }, {
        $set: { ...t, order: i }, $addToSet: { assignees: username }, $pull: { formerAssignees: username },
      });
      keep.push(existing.taskId);
    } else {
      const taskId = newTaskId();
      await Task.create({ taskId, legacyKey: `task:${taskId}`, ...t, order: i, assignees: [username] });
      keep.push(taskId);
    }
  }
  await unassignOthers(Task, username, keep);
}

async function unassignOthers(Task, username, keepIds) {
  await Task.updateMany(
    { assignees: username, taskId: { $nin: keepIds } },
    { $pull: { assignees: username }, $addToSet: { formerAssignees: username } }
  );
}

// "Reset to Default": the member gets exactly their default list from code (TEAM),
// re-using the same tasks (same taskIds) so their old data stays attached.
async function resetMemberTasks(Task, username, defaults) {
  const keep = [];
  for (let i = 0; i < defaults.length; i++) {
    const d = defaults[i];
    const set = { name: d.name, type: d.type, label: d.label || d.type, active: true, order: i };
    const onInsert = { taskId: newTaskId() };
    if (d.dailyTarget !== undefined) set.dailyTarget = d.dailyTarget; else onInsert.dailyTarget = null;
    const r = await Task.findOneAndUpdate(
      { legacyKey: legacyKey(username, d.name) },
      { $set: set, $addToSet: { assignees: username }, $pull: { formerAssignees: username },
        $setOnInsert: onInsert },
      { upsert: true, new: true }
    );
    keep.push(r.taskId);
  }
  await unassignOthers(Task, username, keep);
}

// Assign one task to many members at once (template-style). `assignees` replaces
// the current list; members removed keep their old data via formerAssignees.
async function setAssignees(Task, taskId, assignees) {
  const task = await Task.findOne({ taskId }).lean();
  if (!task) return null;
  const next    = [...new Set(assignees.map(String))];
  const removed = (task.assignees || []).filter(u => !next.includes(u));
  await Task.updateOne({ taskId }, {
    $set: { assignees: next },
    $addToSet: { formerAssignees: { $each: removed } },
  });
  if (next.length) await Task.updateOne({ taskId }, { $pull: { formerAssignees: { $in: next } } });
  return Task.findOne({ taskId }).lean();
}

// ── One-time migration ──────────────────────────────────────────────────────
function guessType(data) {
  if (!data || typeof data !== 'object') return 'note';
  if (Array.isArray(data.rows)) return 'links';
  if ('links' in data) return 'links_note';
  if ('value' in data && 'text' in data) return 'count_note';
  if ('value' in data) return 'count';
  return 'note';
}

async function copyCollection(db, from, to) {
  const src = db.collection(from), dst = db.collection(to);
  let batch = [], n = 0;
  for await (const doc of src.find({})) {
    batch.push(doc);
    if (batch.length === 500) { await dst.insertMany(batch); n += batch.length; batch = []; }
  }
  if (batch.length) { await dst.insertMany(batch); n += batch.length; }
  return n;
}

// 1. Every instance: make sure each member's current task list exists as Task
//    documents (upserts keyed by "<username>|<original name>", so it never duplicates).
// 2. One instance (lock in Config): back up entries + configs, convert every
//    name-keyed entry to taskId keys, record the counts. Resumable and idempotent.
async function migrateToTaskIds({ Task, Entry, Config, members, legacyListFor, dryRun = false, log = console.log }) {
  const state = await Config.findOne({ key: MIGRATION_KEY }).lean();
  if (state && state.value && state.value.state === 'done' && !dryRun) return state.value.report;

  let tasksCreated = 0;
  if (!dryRun) {
    for (const { username, display } of members) {
      const list = legacyListFor(display) || [];
      for (let i = 0; i < list.length; i++) {
        const t = cleanTaskInput(list[i]);
        if (!t) continue;
        try {
          const r = await Task.updateOne(
            { legacyKey: legacyKey(username, t.name) },
            { $setOnInsert: { taskId: newTaskId(), ...t, order: i, assignees: [username] } },
            { upsert: true }
          );
          tasksCreated += r.upsertedCount || 0;
        } catch (e) { if (e.code !== 11000) throw e; }
      }
    }
  }

  if (!dryRun) {
    const now = Date.now();
    try {
      const lock = await Config.findOneAndUpdate(
        { key: MIGRATION_KEY, $or: [{ 'value.state': { $exists: false } },
                                    { 'value.state': 'running', 'value.startedAt': { $lt: now - LOCK_STALE_MS } }] },
        { $set: { value: { state: 'running', startedAt: now } } },
        { upsert: true, new: true }
      );
      if (!lock) return null;
    } catch (e) {
      if (e.code === 11000) return null; // another instance holds the lock, or it is done
      throw e;
    }
  }

  const db = Entry.db.db;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const backups = {};
  if (!dryRun) {
    backups.entries = `backup_entries_pre_taskid_${stamp}`;
    backups.configs = `backup_configs_pre_taskid_${stamp}`;
    backups.entriesCopied = await copyCollection(db, Entry.collection.collectionName, backups.entries);
    backups.configsCopied = await copyCollection(db, Config.collection.collectionName, backups.configs);
    log(`✓ Backed up ${backups.entriesCopied} entries → ${backups.entries}, ${backups.configsCopied} configs → ${backups.configs}`);
  }

  const entriesBefore = await Entry.countDocuments({});
  const legacyBefore  = await Entry.countDocuments({ entryVersion: { $ne: ENTRY_VERSION } });
  const indexes = new Map();
  if (dryRun) { // nothing was written: plan the list tasks step 1 would create
    for (const { username, display } of members) {
      const idx = await nameIndex(Task, username);
      for (const t of legacyListFor(display) || []) {
        if (t && t.name && !idx.has(t.name)) { idx.set(t.name, '(planned task)'); tasksCreated++; }
      }
      indexes.set(username, idx);
    }
  }
  let converted = 0, keysMapped = 0, orphanTasks = 0;
  const unmapped = [];

  for await (const e of Entry.find({ entryVersion: { $ne: ENTRY_VERSION } }).lean().cursor()) {
    if (!indexes.has(e.username)) indexes.set(e.username, await nameIndex(Task, e.username));
    const idx = indexes.get(e.username);
    // A task name that no longer exists in any list (removed earlier): keep its data
    // by creating an inactive task the member is recorded as a former assignee of.
    for (const [k, v] of Object.entries(e.tasks || {})) {
      if (isMetaKey(k) || idx.has(k)) continue;
      if (dryRun) { idx.set(k, '(new inactive task)'); orphanTasks++; continue; }
      const r = await Task.findOneAndUpdate(
        { legacyKey: legacyKey(e.username, k) },
        { $setOnInsert: { taskId: newTaskId(), name: k, type: guessType(v), label: guessType(v),
                          dailyTarget: null, active: false, order: 1000, assignees: [], formerAssignees: [e.username] } },
        { upsert: true, new: true }
      );
      idx.set(k, r.taskId); orphanTasks++;
    }
    const m = mapLegacyTasks(idx, e.tasks);
    keysMapped += Object.keys(e.tasks || {}).filter(k => !isMetaKey(k)).length - m.unmapped.length;
    m.unmapped.forEach(k => unmapped.push(`${e.username} ${e.date} "${k}"`));
    if (!dryRun) {
      // Whole-document replace (only if still unconverted): keeps every other field,
      // and is applied even where the values are identical and only the keys change.
      const { _id, ...rest } = e;
      const r = await Entry.collection.replaceOne({ _id, entryVersion: { $ne: ENTRY_VERSION } },
                                                  { ...rest, tasks: m.tasks, entryVersion: ENTRY_VERSION });
      converted += r.modifiedCount || 0;
    } else converted++;
  }

  const report = {
    entriesBefore,
    entriesAfter:     await Entry.countDocuments({}),
    entriesToConvert: legacyBefore,
    entriesConverted: converted,
    entriesStillOld:  dryRun ? legacyBefore - converted : await Entry.countDocuments({ entryVersion: { $ne: ENTRY_VERSION } }),
    taskValuesMapped: keysMapped,
    unmappedValues:   unmapped.length,
    unmappedSample:   unmapped.slice(0, 20),
    tasksCreatedFromLists: tasksCreated,
    inactiveTasksCreatedForOldData: orphanTasks,
    totalTasks:       await Task.countDocuments({}),
    backups,
    dryRun,
  };
  if (!dryRun) {
    await Config.updateOne({ key: MIGRATION_KEY }, { $set: { value: { state: 'done', finishedAt: Date.now(), report } } });
  }
  return report;
}

module.exports = {
  TASK_TYPES, ENTRY_VERSION, newTaskId, legacyKey, publicTask, cleanTaskInput,
  tasksForUser, tasksByUser, entryTasksV2, saveMemberTaskList, resetMemberTasks,
  setAssignees, migrateToTaskIds, titleCase,
};
