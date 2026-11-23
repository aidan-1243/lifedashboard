// Medication schedules, shared by the app and the server so both agree on
// which days a dose is due. Dates are plain "YYYY-MM-DD" strings (local days).
//
// med.freq:     'daily'   every `interval_n` days (1 = every day)
//               'weekly'  on `weekdays` ("0,3" = Sun, Wed), every `interval_n` weeks
//               'monthly' on `month_days` ("1,15"; older rows: `month_day`), every `interval_n` months
// med.start_date: first day of the schedule (also anchors "every 2 weeks")
// med.times:     dose times ("08:00,20:00"); every dose day uses these...
// med.dose_times: ...unless a day has its own: JSON {"1":"08:00","4":"20:00"} keyed by
//               weekday (weekly) or date (monthly), one dose that day.
// med.remind:    '15m' | 'hourly' | 'once' | 'none' (repeat reminders until taken)

const toUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const DAY = 86400000;
export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function medDueOn(med, date) {
  const start = med.start_date || (med.created_at || '').slice(0, 10) || date;
  const t = toUTC(date), s = toUTC(start);
  if (t < s) return false;
  const n = Math.max(1, +med.interval_n || 1);
  const freq = med.freq || 'daily';
  if (freq === 'daily') return Math.round((t - s) / DAY) % n === 0;
  if (freq === 'weekly') {
    const days = String(med.weekdays || '').split(',').filter((x) => x !== '').map(Number);
    const dow = new Date(t).getUTCDay();
    if (!(days.length ? days : [new Date(s).getUTCDay()]).includes(dow)) return false;
    // Count whole weeks between the Sundays that start each week.
    const weekOf = (x) => x - new Date(x).getUTCDay() * DAY;
    return Math.round((weekOf(t) - weekOf(s)) / (7 * DAY)) % n === 0;
  }
  if (freq === 'monthly') {
    const d = new Date(t), sd = new Date(s);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const want = monthDays(med, sd).map((x) => Math.min(x, lastDay));
    if (!want.includes(d.getUTCDate())) return false;
    const months = (d.getUTCFullYear() - sd.getUTCFullYear()) * 12 + d.getUTCMonth() - sd.getUTCMonth();
    return months % n === 0;
  }
  return true;
}

const monthDays = (med, sd) => {
  const list = String(med.month_days || '').split(',').map(Number).filter((x) => x >= 1 && x <= 31);
  return list.length ? list : [+med.month_day || (sd ? sd.getUTCDate() : 1)];
};
const ordinal = (d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
export const ORDINAL = ordinal;
function doseTimes(med) {
  try { const o = JSON.parse(med.dose_times || 'null'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; }
}
const baseTimes = (med) => String(med.times || '').split(',').filter(Boolean);

// The dose times due on `date` ([] when it isn't a dose day).
export function slotsOn(med, date) {
  if (!medDueOn(med, date)) return [];
  const own = doseTimes(med);
  const t = new Date(toUTC(date));
  if (med.freq === 'weekly' && own[t.getUTCDay()]) return [own[t.getUTCDay()]];
  if (med.freq === 'monthly') {
    const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    const key = monthDays(med).find((x) => Math.min(x, lastDay) === t.getUTCDate());
    if (key && own[key]) return [own[key]];
  }
  return baseTimes(med).length ? baseTimes(med) : ['08:00'];
}
// Every dose time the medication uses (for lists)
export function allTimes(med) {
  const own = Object.values(doseTimes(med));
  return [...new Set(own.length ? own : baseTimes(med))].sort();
}
// "8a", "8:30p"
export const fmtSlot = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'a' : 'p'}`; };

export function describeSchedule(med) {
  const n = Math.max(1, +med.interval_n || 1);
  const freq = med.freq || 'daily';
  const own = doseTimes(med);
  const base = baseTimes(med).map(fmtSlot).join(', ');
  const times = (count) => (count === 1 ? 'Once' : count === 2 ? 'Twice' : `${count} times`);
  if (freq === 'daily') {
    const k = baseTimes(med).length || 1;
    return `${n === 1 ? `${times(k)} a day` : `Every ${n} days`}${base ? ` · ${base}` : ''}`;
  }
  if (freq === 'weekly') {
    const days = String(med.weekdays || '').split(',').filter((x) => x !== '').map(Number);
    const parts = days.map((d) => `${WEEKDAY_NAMES[d]}${own[d] ? ` ${fmtSlot(own[d])}` : ''}`);
    const lead = n === 1 ? (days.length > 1 ? `${times(days.length)} a week` : 'Weekly') : `Every ${n} weeks`;
    return `${lead}${parts.length ? ` · ${parts.join(', ')}` : ''}${Object.keys(own).length ? '' : base ? ` ${base}` : ''}`;
  }
  if (freq === 'monthly') {
    const ds = monthDays(med);
    const parts = ds.map((d) => `the ${ordinal(d)}${own[d] ? ` ${fmtSlot(own[d])}` : ''}`);
    const lead = n === 1 ? (ds.length > 1 ? `${times(ds.length)} a month` : 'Monthly') : `Every ${n} months`;
    return `${lead} · ${parts.join(', ')}${Object.keys(own).length ? '' : base ? ` ${base}` : ''}`;
  }
  return '';
}

// Next due date on or after `from` (searches up to ~13 months).
export function nextDue(med, from) {
  let t = toUTC(from);
  for (let i = 0; i < 400; i++, t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (medDueOn(med, d)) return d;
  }
  return null;
}
