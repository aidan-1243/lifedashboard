// One task model (see docs/tasks-design.md), shared by the app and the server.
//
// task: { id, kind, title, details, date 'YYYY-MM-DD', time 'HH:MM'|null,
//         repeat: never|daily|weekly|biweekly|monthly|quarterly|semiannual|yearly|custom,
//         custom: { freq: daily|weekly|monthly, interval_n, weekdays '1,4', month_days '1,15',
//                   times 'HH:MM,HH:MM', dose_times {key: 'HH:MM'} },
//         nag, nag_mode: hourly|daily|weekly, nag_time 'HH:MM', nag_dow 0-6, remind_to, snooze_until }
// log:  { task_id, occ, status: done|partial|skipped, amount, at }
//   occ = "YYYY-MM-DD" (date-only) or "YYYY-MM-DD HH:MM" (timed occurrence)
//
// Repeats are turned into the medication schedule model (public/meds.js) so there is one engine.

import { slotsOn, fmtSlot, WEEKDAY_NAMES } from './meds.js';

export const REPEATS = [['never', 'Never'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['biweekly', 'Biweekly'], ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'], ['semiannual', 'Semi-annually'], ['yearly', 'Yearly'], ['custom', 'Custom']];
const DAY = 86400000;
const toUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const ymdUTC = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s, n) => ymdUTC(toUTC(s) + n * DAY);

// The task's schedule in the medication model
export function asSchedule(t) {
  const start = t.date || (t.created_at || '').slice(0, 10);
  const d = start ? new Date(toUTC(start)) : null;
  const base = { start_date: start, times: t.time || '', interval_n: 1, freq: 'daily' };
  switch (t.repeat) {
    case 'daily': return base;
    case 'weekly': return { ...base, freq: 'weekly', weekdays: String(d.getUTCDay()) };
    case 'biweekly': return { ...base, freq: 'weekly', interval_n: 2, weekdays: String(d.getUTCDay()) };
    case 'monthly': return { ...base, freq: 'monthly', month_days: String(d.getUTCDate()) };
    case 'quarterly': return { ...base, freq: 'monthly', interval_n: 3, month_days: String(d.getUTCDate()) };
    case 'semiannual': return { ...base, freq: 'monthly', interval_n: 6, month_days: String(d.getUTCDate()) };
    case 'yearly': return { ...base, freq: 'monthly', interval_n: 12, month_days: String(d.getUTCDate()) };
    case 'custom': {
      const c = t.custom || {};
      return { ...base, freq: c.freq || 'daily', interval_n: c.interval_n || 1, weekdays: c.weekdays || null, month_days: c.month_days || null,
        times: c.times || t.time || '', dose_times: c.dose_times ? JSON.stringify(c.dose_times) : null };
    }
    default: return null; // never: a single date
  }
}

// Occurrences on a date: [] (none), [''] (date-only) or ['08:00', ...] (timed)
export function occurrencesOn(t, date) {
  if (!t.date) return [];
  if (!t.repeat || t.repeat === 'never') return t.date === date ? [t.time || ''] : [];
  const sch = asSchedule(t);
  const timed = !!(sch.times || sch.dose_times);
  if (!timed) return slotsOn({ ...sch, times: '00:00' }, date).length ? [''] : [];
  return slotsOn(sch, date);
}
export const occKey = (date, time) => (time ? `${date} ${time}` : date);
export const isDueOn = (t, date) => occurrencesOn(t, date).length > 0;

// Next occurrence date on or after `from` (searches ~13 months)
export function nextDate(t, from) {
  for (let i = 0; i < 400; i++) { const d = addDays(from, i); if (isDueOn(t, d)) return d; }
  return null;
}

// Streak: consecutive past occurrences completed with the main button (done / partial).
// Today's occurrences only count once done; an undone one today doesn't break the streak yet.
export function streak(t, logs, today) {
  const byOcc = new Map(logs.filter((l) => l.task_id === t.id).map((l) => [l.occ, l.status]));
  const counts = (s) => s === 'done' || s === 'partial';
  let n = 0, best = 0, run = 0;
  // Walk back up to ~2 years of occurrences
  const occs = [];
  for (let i = 0; i < 740; i++) {
    const d = addDays(today, -i);
    if (t.date && d < t.date) break;
    const list = occurrencesOn(t, d);
    for (let k = list.length - 1; k >= 0; k--) occs.push({ d, key: occKey(d, list[k]) });
  }
  let current = true;
  for (const o of occs) {
    const st = byOcc.get(o.key);
    if (counts(st)) { run++; if (current) n++; }
    else {
      if (o.d === today && !st) continue; // still open today
      current = false; best = Math.max(best, run); run = 0;
    }
  }
  best = Math.max(best, run, n);
  return { current: n, best };
}

// Recent history for the strip: the last `count` occurrences (oldest first)
export function recent(t, logs, today, count = 14) {
  const byOcc = new Map(logs.filter((l) => l.task_id === t.id).map((l) => [l.occ, l]));
  const out = [];
  for (let i = 0; i < 740 && out.length < count; i++) {
    const d = addDays(today, -i);
    if (t.date && d < t.date) break;
    const list = occurrencesOn(t, d);
    for (let k = list.length - 1; k >= 0 && out.length < count; k--) {
      const key = occKey(d, list[k]); const l = byOcc.get(key);
      out.push({ key, d, time: list[k], status: l ? l.status : d === today ? 'open' : 'missed' });
    }
  }
  return out.reverse();
}

export function describeRepeat(t) {
  const label = (REPEATS.find(([k]) => k === (t.repeat || 'never')) || [])[1] || 'Never';
  if (t.repeat === 'custom') {
    const c = t.custom || {};
    const times = String(c.times || '').split(',').filter(Boolean);
    if (c.freq === 'weekly') return `Custom · ${String(c.weekdays || '').split(',').filter((x) => x !== '').map((d) => WEEKDAY_NAMES[+d]).join(', ')}`;
    if (c.freq === 'monthly') return `Custom · the ${String(c.month_days || '').split(',').join(', ')}`;
    return `Custom · ${c.interval_n > 1 ? `every ${c.interval_n} days` : `${times.length || 1}× a day`}`;
  }
  return label;
}
export const describeNag = (t) => {
  if (!t.nag) return 'Off';
  if (t.nag_mode === 'daily') return `Daily at ${fmtSlot(t.nag_time || '09:00')}`;
  if (t.nag_mode === 'weekly') return `${WEEKDAY_NAMES[t.nag_dow ?? 1]}s at ${fmtSlot(t.nag_time || '09:00')}`;
  return 'Hourly';
};

// Everyday tasks (kind "task"): the occurrence that's due now.
//   One-off with a date: that date (late once it has passed, until done).
//   One-off without a date: open until done; it's logged on the day you finish it.
//   Repeating: the latest occurrence up to today that's after the last one you logged
//   (older missed ones just count as missed), else the next one coming up.
// Returns { date, time, key, log, late, future, undated } or null (nothing left).
export function todoOcc(t, logs, today) {
  const mine = logs.filter((l) => l.task_id === t.id).sort((a, z) => a.occ.localeCompare(z.occ));
  const byOcc = new Map(mine.map((l) => [l.occ, l]));
  if (!t.repeat || t.repeat === 'never') {
    if (!t.date) { const l = mine[mine.length - 1] || null; return { date: null, time: '', key: l ? l.occ : today, log: l, late: false, future: false, undated: true }; }
    const key = occKey(t.date, t.time || ''); const log = byOcc.get(key) || null;
    return { date: t.date, time: t.time || '', key, log, late: !log && t.date < today, future: t.date > today };
  }
  const last = mine.length ? mine[mine.length - 1].occ : '';
  // Walk back from today to the last logged occurrence (or the start, at most ~13 months)
  for (let i = 0; i < 400; i++) {
    const d = addDays(today, -i);
    if ((t.date && d < t.date) || (last && d < last.slice(0, 10))) break;
    const list = occurrencesOn(t, d);
    for (let k = list.length - 1; k >= 0; k--) {
      const key = occKey(d, list[k]);
      if (key > last) {
        // Today's later times aren't due yet: prefer the earliest open one today
        if (d === today) { const first = list.find((tm) => occKey(d, tm) > last); return { date: d, time: first, key: occKey(d, first), log: null, late: false, future: false }; }
        return { date: d, time: list[k], key, log: null, late: true, future: false };
      }
    }
  }
  // Nothing open up to today: the next one after today
  for (let i = 1; i < 400; i++) {
    const d = addDays(today, i); const list = occurrencesOn(t, d);
    if (list.length) return { date: d, time: list[0], key: occKey(d, list[0]), log: null, late: false, future: true };
  }
  return null;
}
