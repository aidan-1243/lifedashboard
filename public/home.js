// Home maintenance scheduling (ported from your Home Maintenance artifact),
// shared by the app and the server. Dates are "YYYY-MM-DD" local days.
//
// task.freq:   Weekly | Monthly | Quarterly | Semi-annual | Annual |
//              Every 2-3 years | Every 5 years | Every 10 years | One-time
// task.months: "*" (any month), "2,5,8,11" (months it's planned for), or the
//              due date for One-time tasks.

export const FREQS = ['Weekly', 'Monthly', 'Quarterly', 'Semi-annual', 'Annual', 'Every 2-3 years', 'Every 5 years', 'Every 10 years', 'One-time'];
export const TYPES = ['Light Clean', 'Deep Clean', 'Maintenance', 'Safety', 'Admin', 'Pet Care'];
const STEP_MONTHS = { Monthly: 1, Quarterly: 3, 'Semi-annual': 6, Annual: 12, 'Every 2-3 years': 30, 'Every 5 years': 60, 'Every 10 years': 120 };
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const endOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)); // m is 1-12
const addMonths = (d, n) => {
  const day = d.getUTCDate();
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  x.setUTCDate(Math.min(day, endOfMonth(x.getUTCFullYear(), x.getUTCMonth() + 1).getUTCDate()));
  return x;
};
const fmt = (d, today) => `${MN[d.getUTCMonth()]} ${d.getUTCDate()}${d.getUTCFullYear() !== today.getUTCFullYear() ? `, ${d.getUTCFullYear()}` : ''}`;

// Due info for one task. `last` = most recent done/skipped date (or null).
export function homeDue(task, last, todayStr) {
  const today = parse(todayStr);
  const f = task.freq;
  const cm = today.getUTCMonth() + 1;
  let due;
  if (f === 'One-time') {
    if (last) return { k: 99999, due: null, completed: true, label: 'Completed', cls: 'ok' };
    due = parse(task.months);
  } else if (last) due = f === 'Weekly' ? addDays(parse(last), 7) : addMonths(parse(last), STEP_MONTHS[f] || 12);
  else if (task.first_due) due = parse(task.first_due);
  else if (f === 'Weekly') due = addDays(today, (7 - today.getUTCDay()) % 7);
  else if (f === 'Monthly') due = endOfMonth(today.getUTCFullYear(), cm);
  else {
    const ms = task.months === '*' ? [cm] : String(task.months).split(',').map(Number).sort((a, b) => a - b);
    const m = ms.find((x) => x >= cm);
    due = m ? endOfMonth(today.getUTCFullYear(), m) : endOfMonth(today.getUTCFullYear() + 1, ms[0]);
  }
  let snoozed = false;
  if (task.snooze_until && task.snooze_until > ymd(due)) { due = parse(task.snooze_until); snoozed = task.snooze_until > todayStr; } // on the new due day it's simply due
  const k = Math.round((due - today) / 86400000);
  const label = k < 0 ? `Overdue ${-k}d` : k === 0 ? 'Due today' : k === 1 ? 'Due tomorrow' : k <= 6 ? `Due in ${k}d` : `Due ${fmt(due, today)}`;
  return { k, due: ymd(due), snoozed, completed: false, label, cls: k < 0 ? 'late' : k <= 6 ? 'soon' : 'ok' };
}

// Days left in the current month (the "To do" view shows everything due by then).
export const daysToMonthEnd = (todayStr) => { const t = parse(todayStr); return Math.round((endOfMonth(t.getUTCFullYear(), t.getUTCMonth() + 1) - t) / 86400000); };

// "2,5,8,11" for a Quarterly task starting in February, etc.
export function monthsFor(freq, startMonth) {
  if (freq === 'Weekly' || freq === 'Monthly') return '*';
  const step = freq === 'Quarterly' ? 3 : freq === 'Semi-annual' ? 6 : 12;
  const out = [];
  for (let m = startMonth; out.length < 12 / step; m += step) out.push(((m - 1) % 12) + 1);
  return out.sort((a, b) => a - b).join(',');
}

export const minutesOf = (est) => {
  const t = est || ''; let m;
  if ((m = t.match(/(\d+)\s*min/))) return +m[1];
  if ((m = t.match(/(\d+)\s*h/))) return m[1] * 60;
  if ((m = t.match(/(\d+)(?:-\d+)?\s*day/))) return m[1] * 480;
  return 0;
};
