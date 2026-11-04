// Work rules the manager sets in Settings → Work rules (stored in Config "workRules").
// Shift times, working days, holidays, the Needs attention thresholds and what members may
// still edit. Read everywhere through get(); the server refreshes the copy every few seconds
// so every instance follows a change.
'use strict';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BEGINNING = '0000-01-01';
const DEFAULTS = Object.freeze({
  shifts: { day: { start: '09:00', end: '18:00' }, night: { start: '21:00', end: '06:00' } },
  workDays: [1, 2, 3, 4, 5],                 // 0 = Sunday … 6 = Saturday
  daysHistory: [{ from: BEGINNING, workDays: [1, 2, 3, 4, 5] }], // so past months keep their working days
  holidays: [],                              // [{ date, name }]
  late: 60,                                  // minutes after the shift starts → "No attendance"
  lowPct: 50, lowDays: 3,                    // under lowPct % for lowDays working days in a row
  noEntry: true, noAttendance: true,         // the two other Needs attention rules
  editYesterday: false,                      // members may still change yesterday themselves
});
const clone = o => JSON.parse(JSON.stringify(o));
let current = clone(DEFAULTS);

const intIn = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };
const days = list => [...new Set((Array.isArray(list) ? list : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();

// A clean copy of whatever was stored (missing or bad fields fall back to the defaults)
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = clone(DEFAULTS);
  for (const s of ['day', 'night']) {
    const x = (r.shifts || {})[s] || {};
    if (TIME_RE.test(x.start || '')) out.shifts[s].start = x.start;
    if (TIME_RE.test(x.end || '')) out.shifts[s].end = x.end;
  }
  const wd = days(r.workDays);
  if (Array.isArray(r.workDays)) out.workDays = wd;
  const hist = (Array.isArray(r.daysHistory) ? r.daysHistory : []).filter(h => h && DATE_RE.test(h.from || '') || (h && h.from === BEGINNING))
    .map(h => ({ from: h.from, workDays: days(h.workDays) })).sort((a, b) => a.from.localeCompare(b.from));
  out.daysHistory = hist.length ? hist : [{ from: BEGINNING, workDays: out.workDays }];
  const seen = new Set();
  out.holidays = (Array.isArray(r.holidays) ? r.holidays : [])
    .map(h => ({ date: String((h && h.date) || ''), name: String((h && h.name) || '').trim().replace(/\s+/g, ' ').slice(0, 60) }))
    .filter(h => DATE_RE.test(h.date) && h.name && !seen.has(h.date) && seen.add(h.date))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 200);
  out.late = intIn(r.late, 0, 720, DEFAULTS.late);
  out.lowPct = intIn(r.lowPct, 1, 100, DEFAULTS.lowPct);
  out.lowDays = intIn(r.lowDays, 1, 30, DEFAULTS.lowDays);
  for (const k of ['noEntry', 'noAttendance', 'editYesterday']) if (typeof r[k] === 'boolean') out[k] = r[k];
  return out;
}

// The rules the manager saves: working-day changes start today, so past days keep theirs
function merge(prev, incoming, today) {
  const next = normalize({ ...prev, ...incoming, daysHistory: prev.daysHistory });
  const before = workDaysOn(today, prev);
  if (before.join() !== next.workDays.join()) {
    const kept = prev.daysHistory.filter(h => h.from < today);
    const last = kept[kept.length - 1];
    next.daysHistory = last && last.workDays.join() === next.workDays.join() ? kept : kept.concat([{ from: today, workDays: next.workDays }]);
  }
  return next;
}

function workDaysOn(iso, r = current) {
  let wd = r.workDays;
  for (const h of r.daysHistory || []) if (h.from <= iso) wd = h.workDays;
  return wd;
}
const holidayOn = (iso, r = current) => (r.holidays || []).find(h => h.date === iso) || null;
// A day people are expected to work: a working weekday on that date, and not a holiday
function isWorkday(iso, r = current) {
  if (holidayOn(iso, r)) return false;
  return workDaysOn(iso, r).includes(new Date(iso + 'T00:00:00Z').getUTCDay());
}
const shiftOf = (user, r = current) => (user && r.shifts[user.shift]) || null;
const defaultShift = (r = current) => r.shifts.day;

module.exports = {
  DEFAULTS, normalize, merge,
  get: () => current, set: r => { current = normalize(r); return current; },
  isWorkday, workDaysOn, holidayOn, shiftOf, defaultShift,
};
