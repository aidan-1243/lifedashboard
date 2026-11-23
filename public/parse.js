// Quick-capture parser (keywords, no AI). Shared by the app (in your browser)
// and the server (for "Hey Siri, add to Life"). It works in "wall-clock" time:
// `now` is the current local time; the server passes a shifted clock.

const DAY = 86400000;

const AREA_WORDS = {
  hoa: /\b(hoa|board|pool|landscap\w*|dues|bylaws?|association|amenit\w*|clubhouse)\b/i,
  travel: /\b(flights?|hotels?|trip|airbnb|passport|travel|wayfare|vacation|rental car|book(ing)?)\b/i,
  home: /\b(hvac|filters?|gutters?|lawn|smoke detectors?|plumb\w*|repair|furnace|water heater|dishwasher|roof|yard|garage|clean)\b/i,
  work: /\b(work|client|office|boss|deck|slides|1:1)\b/i,
  people: /\b(birthday|gift|call|text|catch up|mom|dad)\b/i,
};
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

// Dictation keeps filler words ("um, call mom uh tomorrow"). Drop them, plus the
// stray commas and periods dictation puts around them.
export function cleanDictation(raw) {
  return String(raw)
    .replace(/(^|[\s,.;])(u+m+|u+h+m*|e+r+m+|h+m+|a+h+|o+h+|you know|i mean)(?=[\s,.;!?]|$)[,.;]?/gi, '$1')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([,.;])\1+/g, '$1')
    .replace(/^[\s,.;]+|[\s,;]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.$/, '')
    .trim();
}

export function parseCapture(raw, people = [], now = new Date()) {
  raw = cleanDictation(raw);
  let text = ' ' + raw.trim() + ' ';
  const out = { area: null, due: null, nag: null, person: null, kind: 'task', repeat: null };
  const strip = (re) => { text = text.replace(re, ' '); };

  // How to remind
  if (/\b(keep (bugging|reminding|nagging) me|nag me|until (it'?s )?done|hourly)\b/i.test(text)) { out.nag = 'hourly'; strip(/,?\s*\b(keep (bugging|reminding|nagging) me|nag me|until (it'?s )?done|hourly)\b/gi); }
  if (/\bevery 15( min(ute)?s?)?\b/i.test(text)) { out.nag = '15m'; strip(/\bevery 15( min(ute)?s?)?\b/gi); }
  const dailyNag = /,?\s*\b(remind me (daily|every day)|nag me daily|daily reminders?)\b/i;
  if (dailyNag.test(text)) { out.nag = 'daily'; strip(dailyNag); }

  // Repeats (medicine, chores): "every day", "daily", "every morning", "weekly", "every 3 days"
  let m;
  if ((m = /\bevery (\d{1,3}) days?\b/i.exec(text))) { out.repeat = +m[1]; strip(m[0]); }
  else if ((m = /\b(every ?day|daily|every morning|every night|every evening)\b/i.exec(text))) { out.repeat = 1; strip(m[0]); }
  else if ((m = /\b(every week|weekly)\b/i.exec(text))) { out.repeat = 7; strip(m[0]); }
  else if ((m = /\b(every month|monthly)\b/i.exec(text))) { out.repeat = 30; strip(m[0]); }
  else if ((m = /\b(every year|yearly|annually)\b/i.exec(text))) { out.repeat = 365; strip(m[0]); }

  // When
  const today = startOfDay(now);
  let date = null;
  if ((m = /\b(today|tonight)\b/i.exec(text))) { date = new Date(today); strip(m[0]); }
  else if ((m = /\b(tomorrow|tmrw|tmr)\b/i.exec(text))) { date = new Date(+today + DAY); strip(m[0]); }
  else if ((m = /\bin (\d{1,3}) (day|week)s?\b/i.exec(text))) { date = new Date(+today + +m[1] * (m[2].toLowerCase() === 'week' ? 7 : 1) * DAY); strip(m[0]); }
  else if ((m = /\b(on |by |next |this )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|urday|sday)?\b/i.exec(text))) {
    const target = WEEKDAYS.indexOf(m[2].slice(0, 3).toLowerCase());
    let add = (target - today.getDay() + 7) % 7;
    if (add === 0) add = 7;
    date = new Date(+today + add * DAY);
    strip(m[0]);
  } else if ((m = /\b(on |by )?(\d{1,2})\/(\d{1,2})\b/.exec(text))) {
    date = new Date(today.getFullYear(), +m[2] - 1, +m[3]);
    if (date < today) date.setFullYear(date.getFullYear() + 1);
    strip(m[0]);
  }
  if ((m = /\b(at )?(\d{1,2})(:(\d{2}))?\s*(am|pm|a|p)\b/i.exec(text))) {
    let h = +m[2] % 12;
    if (/p/i.test(m[5])) h += 12;
    date = date || new Date(today);
    date.setHours(h, +(m[4] || 0), 0, 0);
    if (date < now && daysBetween(today, date) === 0 && !/\btoday\b/i.test(raw)) date = new Date(+date + DAY);
    strip(m[0]);
  } else if (date) date.setHours(9, 0, 0, 0);
  if (!date && out.repeat) { date = new Date(today); date.setHours(9, 0, 0, 0); if (date < now) date = new Date(+date + DAY); }
  out.due = date;

  // Who
  const lower = raw.toLowerCase();
  out.person = people.find((p) => p.name && lower.includes(p.name.toLowerCase()))
    || people.find((p) => { const f = (p.name || '').split(' ')[0]; return f.length > 2 && new RegExp(`\\b${f.replace(/[^\w]/g, '')}\\b`, 'i').test(raw); })
    || null;

  // What kind
  for (const [area, re] of Object.entries(AREA_WORDS)) if (re.test(raw)) { out.area = area; break; }
  if (!out.area && out.person) out.area = 'people';
  if (/^\s*(note|idea)s?:/i.test(raw)) { out.kind = 'note'; strip(/^\s*(note|idea)s?:/i); }

  strip(/^\s*(remind me to|remind me|todo:?|to do:?)\s+/i);
  let title = text.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/[,\s]+$/, '').trim();
  title = title.charAt(0).toUpperCase() + title.slice(1);
  out.title = title || raw.trim();
  // Repeating things (like medicine) nag hourly until done unless told otherwise.
  if (!out.nag) out.nag = out.repeat ? 'hourly' : out.due ? 'once' : 'none';
  return out;
}
