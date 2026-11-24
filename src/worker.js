// Life Dashboard — Cloudflare Worker: JSON API and the 15-minute cron that sends nags and
// the morning briefing as Life's own notifications (Web Push).

import { parseCapture } from '../public/parse.js';
import { parseVcards, birthdayEventPerson } from '../public/vcard.js';
import { homeDue, daysToMonthEnd, FREQS as HOME_FREQS } from '../public/home.js';
import { sendWebPush } from './webpush.js';
import * as RW from '../public/rewards.js';
import * as TK from '../public/tasks.js';

const ITEM_FIELDS = ['title', 'notes', 'area', 'kind', 'due_at', 'nag', 'repeat_days', 'top3', 'person_id', 'status', 'snooze_until', 'shared', 'trip_id'];
const PERSON_FIELDS = ['name', 'birthday', 'phone', 'email', 'notes', 'checkin_days', 'bday_remind', 'bday_notify', 'circle'];

// Your settings for synced calendar events live in event_prefs, keyed by the
// event's title (all events with that title) or title + start time (just that
// one), so they survive every re-sync. The one-time setting wins.
const eventKeys = (e) => ({ one: `one:${e.title}|${e.start_at}`, all: `all:${String(e.title).trim().toLowerCase()}` });
function eventPref(e, prefs, s) {
  const k = eventKeys(e);
  const all = prefs[k.all] || {}, one = prefs[k.one] || {};
  const val = (f) => (one[f] !== null && one[f] !== undefined ? one[f] : all[f] !== null && all[f] !== undefined ? all[f] : null);
  const autoHide = s && s.hide_cal_birthdays === '1' && /\bbirthday\b/i.test(e.title);
  return { hidden: val('hidden') === 1 || (autoHide && val('hidden') !== 0), leave: val('leave'), travel_min: val('travel_min'), note: val('note') };
}
// Each person's event settings: user 1 keeps plain keys, others are stored as "u<id>|<key>".
const prefKey = (uid, key) => (uid === 1 ? key : `u${uid}|${key}`);
async function eventPrefRows(env, uid) {
  const { results } = await env.DB.prepare('SELECT * FROM event_prefs').all();
  const pre = `u${uid}|`;
  return results.filter((r) => (uid === 1 ? !/^u\d+\|/.test(r.key) : r.key.startsWith(pre)))
    .map((r) => (uid === 1 ? r : { ...r, key: r.key.slice(pre.length) }));
}
async function loadEventPrefs(env, uid = 1) {
  return Object.fromEntries((await eventPrefRows(env, uid)).map((r) => [r.key, r]));
}
// Minutes between repeat notifications (a little under the period so the 15-minute cron never skips one).

// Lockout: this many failed passwords (or bad button links) from one IP address
// within the window blocks that address until the window passes.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MIN = 15;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
};

export default {
  async fetch(req, env, ctx) {
    const res = await route(req, env, ctx);
    const out = new Response(res.body, res); // copy so headers are editable
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/')) out.headers.set('Cache-Control', 'no-store');
    return out;
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

async function route(req, env, ctx) {
  const url = new URL(req.url);
  try {
    const guarded = url.pathname.startsWith('/api/');
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    if (guarded && (await recentFailures(env, ip)) >= MAX_FAILURES) {
      return json({ error: `Too many wrong attempts. Try again in ${FAILURE_WINDOW_MIN} minutes.` }, 429);
    }
    // Everything except notification buttons must have passed the Cloudflare Access gate.
    const who = await verifyAccess(req, env);
    if (!who) return new Response('Forbidden', { status: 403 });
    // A service token (your Shortcuts) has no email: it may only send calendar events or add a capture.
    const SHORTCUT_PATHS = ['/api/events/sync', '/api/capture'];
    if (who !== 'local' && !who.email && !(req.method === 'POST' && SHORTCUT_PATHS.includes(url.pathname))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, env)) {
        await recordFailure(env, ip);
        return json({ error: 'unauthorized' }, 401);
      }
      const uid = await userFor(req, env, who);
      if (!uid) return json({ error: "This sign-in isn't set up in Life yet." }, 403);
      return await handleApi(req, env, url, ctx, uid);
    }
    return env.ASSETS.fetch(req);
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong' }, 500);
  }
}

// ---------- Cloudflare Access check ----------
// Access adds a signed token (Cf-Access-Jwt-Assertion) to every request it lets
// through. Verifying it here means a request that somehow skipped the gate is
// still refused. Skipped when ACCESS_AUD is empty (local development).

let accessKeys = { at: 0, keys: {} };

const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function accessKey(env, kid) {
  if (Date.now() - accessKeys.at > 3600000 || !accessKeys.keys[kid]) {
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const { keys } = await res.json();
    const out = {};
    for (const k of keys) out[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    accessKeys = { at: Date.now(), keys: out };
  }
  return accessKeys.keys[kid];
}

// Returns the verified token payload ({email} for you, {common_name} for a
// service token), 'local' in local development, or null if not verified.
async function verifyAccess(req, env) {
  if (!env.ACCESS_AUD) return 'local';
  const jwt = req.headers.get('cf-access-jwt-assertion') || '';
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    const key = await accessKey(env, header.kid);
    if (!key) return null;
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const ok = valid && aud.includes(env.ACCESS_AUD) && payload.iss === `https://${env.ACCESS_TEAM_DOMAIN}` && payload.exp * 1000 > Date.now();
    return ok ? payload : null;
  } catch (_) {
    return null;
  }
}

async function recentFailures(env, ip) {
  const since = new Date(Date.now() - FAILURE_WINDOW_MIN * 60000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures WHERE ip = ? AND at > ?').bind(ip, since).first();
  return row ? row.n : 0;
}

async function recordFailure(env, ip) {
  await env.DB.prepare('INSERT INTO auth_failures (ip, at) VALUES (?, ?)').bind(ip, new Date().toISOString()).run();
}


// ---------- people using the app ----------
// Who is asking: the Access sign-in email, a person's own Shortcut service token,
// or (test copy on this Mac only) an x-dev-user header. Other service tokens act as user 1.
async function userFor(req, env, who) {
  if (who === 'local') {
    const dev = +(req.headers.get('x-dev-user') || 0);
    if (dev && env.LOCAL_DEV === '1') { const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(dev).first(); if (u) return u.id; }
    return 1;
  }
  if (who.email) {
    const u = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').bind(who.email).first();
    return u ? u.id : null;
  }
  const u = who.common_name ? await env.DB.prepare('SELECT id FROM users WHERE service_token = ?').bind(who.common_name).first() : null;
  return u ? u.id : 1;
}
async function listUsers(env) {
  return (await env.DB.prepare('SELECT id, name FROM users ORDER BY id').all()).results;
}
// Is this row yours? Tasks also count when they're shared.
async function owns(env, table, id, uid) {
  const sql = {
    items: "SELECT 1 AS ok FROM tasks WHERE id = ? AND kind = 'task' AND (user_id = ? OR shared = 1)",
    people: 'SELECT 1 AS ok FROM people WHERE id = ? AND user_id = ?',
    tasks: 'SELECT 1 AS ok FROM tasks WHERE id = ? AND (user_id = ? OR shared = 1)',
    documents: 'SELECT 1 AS ok FROM documents WHERE id = ? AND user_id = ?',
    gifts: 'SELECT 1 AS ok FROM gifts g JOIN people p ON p.id = g.person_id WHERE g.id = ? AND p.user_id = ?',
    person_dates: 'SELECT 1 AS ok FROM person_dates d JOIN people p ON p.id = d.person_id WHERE d.id = ? AND p.user_id = ?',
  }[table];
  return !!(await env.DB.prepare(sql).bind(id, uid).first());
}
const notYours = () => json({ error: 'not found' }, 404);

// ---------- helpers ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function authorized(req, env) {
  // Online, the Cloudflare Access gate (verified in route()) is the sign-in.
  // The password check only applies to local development.
  if (env.ACCESS_AUD) return true;
  // Test copy on this Mac: LOCAL_DEV=1 lives only in .dev.vars (never deployed), and it
  // only applies to requests addressed to this computer itself.
  if (env.LOCAL_DEV === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.url).hostname)) return true;
  const token = env.APP_TOKEN || '';
  if (!token) return false;
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (got.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= got.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

const nowIso = () => new Date().toISOString();

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd: p.weekday, date: `${p.year}-${p.month}-${p.day}` };
}

// Local wall-clock time in tz -> Date (UTC).
function zonedToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = localParts(new Date(guess), tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return new Date(guess - (asUtc - guess));
}

function fmtTime(iso, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(' ', '').toLowerCase();
}

function daysUntilBirthday(bday, today) {
  const m = /(\d{2})-(\d{2})$/.exec(bday || '');
  if (!m) return null;
  const t = Date.UTC(today.y, today.m - 1, today.d);
  let next = Date.UTC(today.y, +m[1] - 1, +m[2]);
  if (next < t) next = Date.UTC(today.y + 1, +m[1] - 1, +m[2]);
  return Math.round((next - t) / 86400000);
}

// Settings are per person, except the household ones below. User 1's are stored under
// plain keys (as before); everyone else's as "u<id>:<key>".
const HOUSEHOLD_SETTINGS = new Set(['weather_lat', 'weather_lon', 'weather_points', 'weather_cache', 'last_push_error', 'shared_calendar']);
const DEFAULT_SETTINGS = { quiet_start: '22', quiet_end: '7', briefing_hour: '7', last_briefing: '', events_synced_at: '', shared_calendar: 'Aidan & Logan' };

// Your events plus the household's shared-calendar events from the other person. If you both
// sync the shared calendar, each event is kept once (yours wins).
// Settings › Shared calendars: names separated by commas, matched without regard to case.
const sharedCalendars = (s) => String((s && s.shared_calendar) || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const isSharedCal = (list, cal) => !!cal && list.includes(String(cal).trim().toLowerCase());
// Re-mark already-synced events after the list changes (no re-sync needed).
async function reshareEvents(env) {
  const list = sharedCalendars(await getSettings(env, 1));
  const { results } = await env.DB.prepare('SELECT DISTINCT calendar FROM events WHERE calendar IS NOT NULL').all();
  await env.DB.batch([env.DB.prepare('UPDATE events SET shared = 0'),
    ...results.filter((r) => isSharedCal(list, r.calendar)).map((r) => env.DB.prepare('UPDATE events SET shared = 1 WHERE calendar = ?').bind(r.calendar))]);
}

async function visibleEvents(env, uid, from = null, to = null) {
  const range = from ? ' AND start_at BETWEEN ? AND ?' : '';
  const { results } = await env.DB.prepare(`SELECT * FROM events WHERE (user_id = ? OR shared = 1)${range} ORDER BY start_at`)
    .bind(uid, ...(from ? [from, to] : [])).all();
  const mine = new Set(results.filter((e) => e.user_id === uid).map((e) => `${e.title}|${e.start_at}`));
  return results.filter((e) => e.user_id === uid || !mine.has(`${e.title}|${e.start_at}`));
}
async function getSettings(env, uid = 1) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const base = { ...DEFAULT_SETTINGS }, mine = {};
  for (const r of results) {
    const m = /^u(\d+):(.+)$/.exec(r.key);
    if (m) { if (+m[1] === uid) mine[m[2]] = r.value; }
    else if (uid === 1 || HOUSEHOLD_SETTINGS.has(r.key)) base[r.key] = r.value;
  }
  return { ...base, ...mine };
}

async function setSetting(env, key, value, uid = 1) {
  const k = uid === 1 || HOUSEHOLD_SETTINGS.has(key) ? key : `u${uid}:${key}`;
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(value)).run();
}

function pick(body, fields) {
  const out = {};
  for (const f of fields) if (f in body) out[f] = body[f] === '' ? null : body[f];
  return out;
}

async function insertRow(env, table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`;
  return env.DB.prepare(sql).bind(...keys.map((k) => data[k])).first();
}

async function updateRow(env, table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? RETURNING *`;
  return env.DB.prepare(sql).bind(...keys.map((k) => data[k]), id).first();
}

// ---------- everyday tasks (kind "task"; they used to be the items table) ----------
// The older routes (/api/items, Wayfare sync, Siri capture, document renewals, nudges) still speak
// the old item shape { title, notes, area, kind, due_at, nag, repeat_days, top3, person_id, trip_id,
// shared, snooze_until, status }. These helpers turn that into a task (see public/tasks.js todoOcc).
// Old reminder settings map to: hourly / every 15 min -> nag hourly; daily -> nag daily at its time;
// once -> no nag (one alert at the due time); none -> no alerts at all (details.silent).

const pad2 = (n) => String(n).padStart(2, '0');
const TZ = (env) => env.TZ || 'America/Chicago';

function todoFields(b, tz, prev = null) {
  const out = {};
  const det = prev ? { ...(prev.details || {}) } : {};
  if ('title' in b) out.title = String(b.title || '').trim().slice(0, 200);
  for (const k of ['notes', 'area', 'source']) if (k in b) { if (b[k]) det[k] = String(b[k]).slice(0, k === 'notes' ? 2000 : 40); else delete det[k]; }
  for (const k of ['person_id', 'trip_id']) if (k in b) { if (+b[k]) det[k] = +b[k]; else delete det[k]; }
  if ('top3' in b) { if (b.top3) det.top3 = 1; else delete det.top3; }
  if ('kind' in b) { if (b.kind === 'note') det.note = 1; else delete det.note; }
  if ('due_at' in b) {
    if (b.due_at && Date.parse(b.due_at)) {
      const p = localParts(new Date(b.due_at), tz); const hm = `${pad2(p.h)}:${pad2(p.min)}`;
      Object.assign(out, { date: p.date, time: hm === '09:00' ? null : hm }); // 9:00 means "no time" (old convention)
    } else Object.assign(out, { date: null, time: null });
  }
  if ('repeat_days' in b) {
    const n = Math.round(+b.repeat_days);
    Object.assign(out, n > 0 ? { repeat: 'custom', custom: JSON.stringify({ freq: 'daily', interval_n: Math.min(366, n) }) } : { repeat: 'never', custom: null });
  }
  if ('nag' in b) {
    const n = b.nag;
    if (n === 'hourly' || n === '15m') Object.assign(out, { nag: 1, nag_mode: 'hourly' });
    else if (n === 'daily') Object.assign(out, { nag: 1, nag_mode: 'daily', nag_time: ('time' in out ? out.time : prev && prev.time) || '09:00' });
    else out.nag = 0;
    if (n === 'none') det.silent = 1; else delete det.silent;
  }
  if ('snooze_until' in b) out.snooze_until = b.snooze_until && Date.parse(b.snooze_until) ? new Date(b.snooze_until).toISOString() : null;
  if ('shared' in b) out.shared = b.shared ? 1 : 0;
  out.details = JSON.stringify(det);
  return out;
}

async function todoRow(env, where, arg) {
  const r = await env.DB.prepare(`SELECT * FROM tasks WHERE kind = 'task' AND ${where}`).bind(arg).first();
  return r ? taskOut(r) : null;
}
const todoLogs = async (env, id) => (await env.DB.prepare('SELECT task_id, occ, status, at FROM task_log WHERE task_id = ?').bind(id).all()).results;
const clearTodoNags = (env, id) => env.DB.prepare('DELETE FROM task_nags WHERE key LIKE ?').bind(`todo:${id}:%`).run();

async function createTodo(env, b, uid, extra = {}) {
  const f = todoFields(b, TZ(env));
  if (!f.title) throw new Error('title required');
  const row = await insertRow(env, 'tasks', { kind: 'task', repeat: 'never', nag: 0, nag_mode: 'hourly', ...f, ...extra, user_id: uid, created_at: nowIso() });
  if (b.status === 'done') await completeTodo(env, row.id, uid);
  return taskOut(row);
}

// Finish (or skip) the occurrence that's due now; an undated one-off is logged on today.
async function completeTodo(env, id, uid, status = 'done') {
  const t = await todoRow(env, 'id = ?', id);
  if (!t) return null;
  const today = localParts(new Date(), TZ(env)).date;
  const o = TK.todoOcc(t, await todoLogs(env, id), today);
  if (!o || o.log) return { ok: true, already: true };
  await env.DB.prepare(`INSERT INTO task_log (task_id, occ, status, at, by_user) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(task_id, occ) DO UPDATE SET status = excluded.status, at = excluded.at, by_user = excluded.by_user`).bind(id, o.key, status, nowIso(), uid).run();
  await env.DB.prepare('UPDATE tasks SET snooze_until = NULL WHERE id = ?').bind(id).run();
  return { ok: true, occ: o.key };
}
// Undo the last completion
async function reopenTodo(env, id) {
  const last = await env.DB.prepare('SELECT occ FROM task_log WHERE task_id = ? ORDER BY occ DESC LIMIT 1').bind(id).first();
  if (last) await env.DB.prepare('DELETE FROM task_log WHERE task_id = ? AND occ = ?').bind(id, last.occ).run();
  await clearTodoNags(env, id);
  return { ok: true };
}
async function updateTodo(env, id, b, uid) {
  const prev = await todoRow(env, 'id = ?', id);
  if (!prev) return null;
  const f = todoFields(b, TZ(env), prev);
  if ('title' in f && !f.title) delete f.title;
  const row = await updateRow(env, 'tasks', id, f);
  if ('due_at' in b || 'nag' in b) await clearTodoNags(env, id);
  if (b.status === 'done') await completeTodo(env, id, uid);
  if (b.status === 'open') await reopenTodo(env, id);
  return taskOut(row);
}
// Create or update by an outside id (Wayfare booking, document renewal...). `reopen` puts a
// finished one back on the list (a renewal whose date changed, a new month's backup).
async function upsertTodo(env, ref, b, uid, { reopen = false, onlyCreate = false } = {}) {
  const prev = await todoRow(env, 'legacy_ref = ?', ref);
  if (!prev) return createTodo(env, b, uid, { legacy_ref: ref });
  if (onlyCreate) return prev;
  const f = todoFields(b, TZ(env), prev);
  await updateRow(env, 'tasks', prev.id, { ...f, archived: 0 });
  const done = !!TK.todoOcc(prev, await todoLogs(env, prev.id), localParts(new Date(), TZ(env)).date)?.log;
  if (b.status === 'done' && !done) await completeTodo(env, prev.id, uid);
  else if ((b.status === 'open' || reopen) && done) await reopenTodo(env, prev.id);
  if ('due_at' in b && b.due_at !== undefined) await clearTodoNags(env, prev.id);
  return prev;
}

// Open everyday tasks with the occurrence due now, for reminders and counts.
// mode 'mine' = ones whose reminders go to this person; 'visible' = everything they can see.
async function openTodos(env, uid, local, tz, mode = 'mine') {
  const who = mode === 'mine' ? '((remind_to IS NULL AND user_id = ?) OR remind_to = ? OR (remind_to = 0 AND (user_id = ? OR shared = 1)))' : '(user_id = ? OR shared = 1 OR remind_to = ? OR ? = 0)';
  const sql = `SELECT * FROM tasks WHERE kind = 'task' AND archived = 0 AND ${who}`;
  const { results } = await env.DB.prepare(sql).bind(uid, uid, uid).all();
  if (!results.length) return [];
  const logs = (await env.DB.prepare(`SELECT task_id, occ, status, at FROM task_log WHERE task_id IN (SELECT id FROM tasks WHERE kind = 'task' AND archived = 0 AND ${who})`).bind(uid, uid, uid).all()).results;
  const out = [];
  for (const t of results.map(taskOut)) {
    const o = TK.todoOcc(t, logs, local.date);
    if (!o || o.log || !o.date) continue;
    const [h, mi] = (o.time || '09:00').split(':').map(Number);
    const [y, m, d] = o.date.split('-').map(Number);
    out.push({ t, o, due: zonedToUtc(y, m, d, h, mi, tz) });
  }
  return out;
}

// ---------- API ----------

async function handleApi(req, env, url, ctx, uid) {
  const path = url.pathname.replace(/\/$/, '');
  const method = req.method;
  const body = ['POST', 'PATCH', 'PUT'].includes(method) && (req.headers.get('content-type') || '').includes('json') ? await req.json() : null;
  let m;

  if (path === '/api/state' && method === 'GET') {
    const homeP = loadHome(env);
    const [people, events, trips, documents, eventPrefs, gifts, personDates, homeTasks, homeLog, meals, mealTitles, settings] = await Promise.all([
      env.DB.prepare('SELECT * FROM people WHERE user_id = ? ORDER BY name COLLATE NOCASE').bind(uid).all(),
      visibleEvents(env, uid).then((results) => ({ results })),
      env.DB.prepare("SELECT * FROM trips WHERE COALESCE(end_date, start_date) >= date('now', '-1 day') ORDER BY start_date").all(),
      env.DB.prepare('SELECT * FROM documents WHERE user_id = ? ORDER BY expires_on').bind(uid).all(),
      eventPrefRows(env, uid).then((results) => ({ results })),
      env.DB.prepare("SELECT g.* FROM gifts g JOIN people p ON p.id = g.person_id WHERE p.user_id = ? AND (g.status != 'given' OR g.created_at > date('now', '-400 days')) ORDER BY g.created_at DESC").bind(uid).all(),
      env.DB.prepare('SELECT d.* FROM person_dates d JOIN people p ON p.id = d.person_id WHERE p.user_id = ?').bind(uid).all(),
      homeP.then((h) => ({ results: h.tasks })),
      homeP.then((h) => ({ results: h.logs })),
      loadMeals(env, "date('now', '-15 days')", "date('now', '+30 days')").then((results) => ({ results })),
      env.DB.prepare(`SELECT json_extract(details, '$.name') AS title, json_extract(details, '$.link') AS link, COUNT(*) AS n, MAX(date) AS last FROM tasks
        WHERE kind = 'meal' AND archived = 0 AND json_extract(details, '$.mkind') = 'cook' AND json_extract(details, '$.name') IS NOT NULL
        GROUP BY lower(json_extract(details, '$.name')) ORDER BY last DESC LIMIT 40`).all(),
      getSettings(env, uid),
    ]);
    delete settings.weather_cache;
    const users = await listUsers(env);
    const meRow = users.find((u) => u.id === uid) || { id: uid };
    const me = { id: uid, name: meRow.name };
    const prefs = Object.fromEntries(eventPrefs.results.map((r) => [r.key, r]));
    const evs = events.results.map((e) => ({ ...e, ...eventKeys(e), pref: eventPref(e, prefs, settings) }));
    return json({ people: people.results, events: evs, event_prefs: eventPrefs.results, trips: trips.results, documents: documents.results,
      gifts: gifts.results, person_dates: personDates.results, home_tasks: homeTasks.results, home_log: homeLog.results, meals: meals.results, meal_titles: mealTitles.results, settings, tz: env.TZ || 'America/Chicago', auth: env.ACCESS_AUD ? 'access' : 'password',
      me, users: users.map((u) => ({ id: u.id, name: u.name })), rewards: await loadRewards(env), ...(await loadTasks(env, uid)),
      push: { public_key: env.VAPID_PUBLIC || '', devices: (await env.DB.prepare('SELECT device, created_at, last_ok_at, last_error, endpoint FROM push_subs WHERE user_id = ?').bind(uid).all()).results } });
  }

  // Your settings for a calendar event (or all events with that title)
  if (path === '/api/event-prefs' && method === 'POST') {
    const key = String((body && body.key) || '');
    if (!/^(one|all):/.test(key) || key.length > 400) return json({ error: 'bad key' }, 400);
    const num = (v, lo, hi) => (v === null || v === undefined || v === '' ? null : Math.min(hi, Math.max(lo, Math.round(+v))));
    const row = {
      hidden: num(body.hidden, 0, 1), leave: num(body.leave, 0, 1), travel_min: num(body.travel_min, 0, 600),
      note: body.note ? String(body.note).slice(0, 500) : null, label: body.label ? String(body.label).slice(0, 200) : null,
    };
    if (row.hidden === null && row.leave === null && row.travel_min === null && !row.note) {
      await env.DB.prepare('DELETE FROM event_prefs WHERE key = ?').bind(prefKey(uid, key)).run();
      return json({ ok: true, cleared: true });
    }
    await env.DB.prepare(`INSERT INTO event_prefs (key, hidden, leave, travel_min, note, label) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET hidden = excluded.hidden, leave = excluded.leave, travel_min = excluded.travel_min, note = excluded.note, label = excluded.label`)
      .bind(prefKey(uid, key), row.hidden, row.leave, row.travel_min, row.note, row.label).run();
    return json({ ok: true });
  }

  // Everyday tasks in the old item shape (Siri, the + button, Wayfare...). They're tasks of kind "task".
  if (path === '/api/items' && method === 'POST') {
    try { return json(await createTodo(env, body || {}, uid), 201); } catch (e) { return json({ error: e.message }, 400); }
  }
  if ((m = /^\/api\/items\/(\d+)(\/done|\/snooze)?$/.exec(path)) && !(await owns(env, 'items', +m[1], uid))) return notYours();
  if ((m = /^\/api\/items\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') return json(await updateTodo(env, +m[1], pick(body, ITEM_FIELDS), uid));
    if (method === 'DELETE') { await env.DB.prepare('UPDATE tasks SET archived = 1 WHERE id = ?').bind(+m[1]).run(); return json({ ok: true }); }
  }
  if ((m = /^\/api\/items\/(\d+)\/done$/.exec(path)) && method === 'POST') return json(await completeTodo(env, +m[1], uid));
  if ((m = /^\/api\/items\/(\d+)\/snooze$/.exec(path)) && method === 'POST') {
    const until = Date.parse(body && body.until) || Date.now() + (+(body && body.minutes) || 60) * 60000;
    await env.DB.prepare('UPDATE tasks SET snooze_until = ? WHERE id = ?').bind(new Date(Math.max(until, Date.now() + 60000)).toISOString(), +m[1]).run();
    return json({ ok: true });
  }

  // People
  if (path === '/api/people' && method === 'POST') {
    const data = pick(body, PERSON_FIELDS);
    if (!data.name) return json({ error: 'name required' }, 400);
    const created = await insertRow(env, 'people', { ...data, user_id: uid });
    await syncPeopleTasks(env, uid, created.id);
    return json(created, 201);
  }
  if ((m = /^\/api\/people\/(\d+)(\/contact(?:\/\d+)?)?$/.exec(path)) && !(await owns(env, 'people', +m[1], uid))) return notYours();
  if ((m = /^\/api\/people\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') { const r = await updateRow(env, 'people', +m[1], pick(body, PERSON_FIELDS)); await syncPeopleTasks(env, uid, +m[1]); return json(r); }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM people WHERE id = ?').bind(+m[1]).run();
      await syncPeopleTasks(env, uid, +m[1]);
      return json({ ok: true });
    }
  }
  if ((m = /^\/api\/people\/(\d+)\/contact$/.exec(path)) && method === 'POST') {
    // A talk is a "done" on the person's catch-up task: today, or an earlier day you forgot to log
    // (up to a year back). `how` = talked / called / texted / saw; `who` = who reached out (me / them).
    const tz = env.TZ || 'America/Chicago';
    const today = localParts(new Date(), tz).date;
    const date = body && /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : today;
    if (date > today) return json({ error: 'That day hasn’t happened yet' }, 400);
    if (date < new Date(Date.now() - 366 * 864e5).toISOString().slice(0, 10)) return json({ error: 'Pick a day within the last year' }, 400);
    const at = date === today ? nowIso() : `${date}T18:00:00.000Z`; // midday local, so the day stays put
    const tid = await catchupTaskId(env, uid, +m[1]);
    const log = await env.DB.prepare(`INSERT INTO task_log (task_id, occ, status, at, by_user, how, who) VALUES (?, ?, 'done', ?, ?, ?, ?)
      ON CONFLICT(task_id, occ) DO UPDATE SET status = 'done', at = excluded.at, by_user = excluded.by_user, how = excluded.how, who = excluded.who RETURNING id`)
      .bind(tid, date, at, uid, talkHow(body && body.how), talkWho(body && body.who)).first();
    const r = await afterTalk(env, uid, +m[1]);
    return json({ ...r, log_id: log.id, date });
  }
  if ((m = /^\/api\/people\/(\d+)\/contact\/(\d+)$/.exec(path)) && (method === 'DELETE' || method === 'PATCH')) {
    // Change who reached out / how, or remove a talk (undo). Only talks on this person's catch-up.
    const tid = await catchupTaskId(env, uid, +m[1]);
    if (method === 'DELETE') await env.DB.prepare('DELETE FROM task_log WHERE id = ? AND task_id = ?').bind(+m[2], tid).run();
    else {
      const set = {};
      if (body && 'who' in body) set.who = talkWho(body.who);
      if (body && 'how' in body) set.how = talkHow(body.how);
      const keys = Object.keys(set);
      if (keys.length) await env.DB.prepare(`UPDATE task_log SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND task_id = ?`).bind(...keys.map((k) => set[k]), +m[2], tid).run();
    }
    return json(await afterTalk(env, uid, +m[1]));
  }

  // Quick capture from Siri / Apple Watch: plain text in, a spoken-friendly summary out.
  if (path === '/api/capture' && method === 'POST') {
    const text = body ? String(body.text || '') : await req.text();
    return captureText(env, text, uid);
  }

  // Weather (US National Weather Service; cached for an hour)
  if (path === '/api/weather' && method === 'GET') return json(await getWeather(env));

  // Focus mode: pause nags for a while
  if (path === '/api/focus' && method === 'POST') {
    const minutes = Math.min(180, Math.max(5, +(body && body.minutes) || 25));
    await setSetting(env, 'focus_until', new Date(Date.now() + minutes * 60000).toISOString(), uid);
    await setSetting(env, 'focus_item', (body && body.item_id) ? String(+body.item_id) : '', uid);
    return json(await getSettings(env, uid));
  }
  if (path === '/api/focus' && method === 'DELETE') {
    await setSetting(env, 'focus_until', '', uid);
    await setSetting(env, 'focus_item', '', uid);
    return json(await getSettings(env, uid));
  }

  // Gift ideas (close circle)
  if (path === '/api/gifts' && method === 'POST') {
    const idea = String((body && body.idea) || '').trim().slice(0, 200);
    if (!idea || !body.person_id) return json({ error: 'person and idea required' }, 400);
    if (!(await owns(env, 'people', +body.person_id, uid))) return notYours();
    return json(await insertRow(env, 'gifts', { person_id: +body.person_id, idea, link: body.link ? String(body.link).slice(0, 500) : null, status: 'idea', created_at: nowIso() }), 201);
  }
  if ((m = /^\/api\/gifts\/(\d+)$/.exec(path)) && !(await owns(env, 'gifts', +m[1], uid))) return notYours();
  if ((m = /^\/api\/gifts\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') return json(await updateRow(env, 'gifts', +m[1], pick(body, ['idea', 'link', 'status'])));
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM gifts WHERE id = ?').bind(+m[1]).run(); return json({ ok: true }); }
  }

  // Important dates (anniversaries, etc.)
  if (path === '/api/person-dates' && method === 'POST') {
    const d = String((body && body.date) || '');
    if (!body.person_id || !/^(\d{4}|-)-?\d{2}-\d{2}$/.test(d)) return json({ error: 'person and date required' }, 400);
    if (!(await owns(env, 'people', +body.person_id, uid))) return notYours();
    const pd = await insertRow(env, 'person_dates', { person_id: +body.person_id, label: String(body.label || 'Date').slice(0, 60), date: d, remind: body.remind ? 1 : 0 });
    await syncPeopleTasks(env, uid, +body.person_id);
    return json(pd, 201);
  }
  if ((m = /^\/api\/person-dates\/(\d+)$/.exec(path)) && !(await owns(env, 'person_dates', +m[1], uid))) return notYours();
  if ((m = /^\/api\/person-dates\/(\d+)$/.exec(path))) {
    const pid = (await env.DB.prepare('SELECT person_id FROM person_dates WHERE id = ?').bind(+m[1]).first() || {}).person_id;
    if (method === 'PATCH') { const r = await updateRow(env, 'person_dates', +m[1], pick(body, ['label', 'date', 'remind'])); await syncPeopleTasks(env, uid, pid); return json(r); }
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM person_dates WHERE id = ?').bind(+m[1]).run(); await syncPeopleTasks(env, uid, pid); return json({ ok: true }); }
  }

  // Home maintenance
  const homeFields = (b, creating) => {
    const out = {};
    const str = (k, n) => { if (k in b) out[k] = b[k] ? String(b[k]).trim().slice(0, n) : null; };
    str('name', 120); str('room', 60); str('type', 40); str('who', 40); str('est', 40); str('notes', 1000);
    if ('freq' in b) out.freq = HOME_FREQS.includes(b.freq) ? b.freq : 'Annual';
    if ('months' in b) out.months = /^(\*|\d{1,2}(,\d{1,2})*|\d{4}-\d{2}-\d{2})$/.test(String(b.months)) ? String(b.months) : '*';
    if ('first_due' in b) out.first_due = /^\d{4}-\d{2}-\d{2}$/.test(b.first_due || '') ? b.first_due : null;
    if ('snooze_until' in b) out.snooze_until = /^\d{4}-\d{2}-\d{2}$/.test(b.snooze_until || '') ? b.snooze_until : null;
    if ('hidden' in b) out.hidden = b.hidden ? 1 : 0;
    // Reminders (see sendHomeReminders)
    if ('remind' in b) out.remind = ['none', 'hourly', 'daily', 'weekly', 'monthly'].includes(b.remind) ? b.remind : 'none';
    if ('remind_time' in b) out.remind_time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.remind_time || '') ? b.remind_time : null;
    if ('remind_dow' in b) out.remind_dow = b.remind_dow === null || b.remind_dow === '' ? null : Math.min(6, Math.max(0, Math.round(+b.remind_dow) || 0));
    if ('remind_dom' in b) out.remind_dom = b.remind_dom === null || b.remind_dom === '' ? null : Math.min(31, Math.max(1, Math.round(+b.remind_dom) || 1));
    if ('remind_to' in b) out.remind_to = Math.max(0, Math.round(+b.remind_to) || 0);
    if (creating && !out.name) throw new Error('name required');
    return out;
  };
  // Home tasks are stored as tasks (kind 'home'); these routes keep the Home screens' shape.
  if (path === '/api/home/tasks' && method === 'POST') {
    try { return json(await saveHomeTask(env, null, { freq: 'Annual', months: '*', ...homeFields(body || {}, true) }, uid), 201); } catch (e) { return json({ error: e.message }, 400); }
  }
  if ((m = /^\/api\/home\/tasks\/(\d+)/.exec(path)) && !(await env.DB.prepare("SELECT 1 FROM tasks WHERE id = ? AND kind = 'home'").bind(+m[1]).first())) return notYours();
  if ((m = /^\/api\/home\/tasks\/(\d+)$/.exec(path)) && method === 'PATCH') return json(await saveHomeTask(env, +m[1], homeFields(body || {}), uid));
  if ((m = /^\/api\/home\/tasks\/(\d+)\/log$/.exec(path)) && method === 'POST') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body && body.date) ? body.date : localParts(new Date(), env.TZ || 'America/Chicago').date;
    await env.DB.prepare(`INSERT INTO task_log (task_id, occ, status, at, by_user) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, occ) DO UPDATE SET status = excluded.status, at = excluded.at, by_user = excluded.by_user`).bind(+m[1], date, body && body.skipped ? 'skipped' : 'done', nowIso(), uid).run();
    await saveHomeTask(env, +m[1], { snooze_until: null }, uid);
    return json({ ok: true });
  }
  if ((m = /^\/api\/home\/tasks\/(\d+)\/log$/.exec(path)) && method === 'DELETE') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date required' }, 400);
    await env.DB.prepare('DELETE FROM task_log WHERE task_id = ? AND occ = ?').bind(+m[1], date).run();
    return json({ ok: true });
  }
  if ((m = /^\/api\/home\/log\/(\d+)$/.exec(path)) && method === 'DELETE') {
    await env.DB.prepare("DELETE FROM task_log WHERE id = ? AND task_id IN (SELECT id FROM tasks WHERE kind = 'home')").bind(+m[1]).run();
    return json({ ok: true });
  }

  // Trips (shown as the countdown card). Link is optional: Wayfare or anything else.
  const tripFields = (b) => {
    const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
    const out = {};
    if ('name' in b) out.name = String(b.name || '').trim().slice(0, 120);
    if ('start_date' in b) out.start_date = d(b.start_date);
    if ('end_date' in b) out.end_date = d(b.end_date);
    if ('link' in b) out.link = /^https:\/\/\S+$/.test(String(b.link || '').trim()) ? String(b.link).trim().slice(0, 500) : null;
    return out;
  };
  if (path === '/api/trips' && method === 'POST') {
    const t = tripFields(body || {});
    if (!t.name || !t.start_date) return json({ error: 'Name and start date required' }, 400);
    return json(await insertRow(env, 'trips', { ...t, source: 'manual' }), 201);
  }
  if ((m = /^\/api\/trips\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') {
      const t = tripFields(body || {});
      if ('name' in t && !t.name) return json({ error: 'Name required' }, 400);
      if ('start_date' in t && !t.start_date) return json({ error: 'Start date required' }, 400);
      return json(await updateRow(env, 'trips', +m[1], t));
    }
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM trips WHERE id = ?').bind(+m[1]).run(); return json({ ok: true }); }
  }

  // Meals: one dinner plan per night, stored as a shared task (kind 'meal')
  if ((m = /^\/api\/meals\/(\d{4}-\d{2}-\d{2})$/.exec(path))) {
    if (method === 'PUT') {
      const kind = ['cook', 'out', 'leftovers', 'skip'].includes(body && body.kind) ? body.kind : 'cook';
      const name = body && body.title ? String(body.title).trim().slice(0, 120) : null;
      if (kind === 'cook' && !name) return json({ error: 'What are you making?' }, 400);
      const title = kind === 'cook' ? name : kind === 'out' ? `Out${name ? `: ${name}` : ''}` : kind === 'leftovers' ? `Leftovers${name ? `: ${name}` : ''}` : 'No dinner needed';
      const details = { mkind: kind, name, link: body.link ? String(body.link).slice(0, 500) : null, notes: body.notes ? String(body.notes).slice(0, 500) : null };
      await env.DB.prepare(`INSERT INTO tasks (user_id, shared, kind, title, details, date, repeat, legacy_ref, created_at) VALUES (?, 1, 'meal', ?, ?, ?, 'never', ?, ?)
        ON CONFLICT(legacy_ref) DO UPDATE SET title = excluded.title, details = excluded.details, archived = 0`)
        .bind(uid, title, JSON.stringify(details), m[1], `meal:${m[1]}`, nowIso()).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') { await env.DB.prepare("UPDATE tasks SET archived = 1 WHERE legacy_ref = ?").bind(`meal:${m[1]}`).run(); return json({ ok: true }); }
  }
  // "We already ate": hides tonight's dinner from Today early (and counts in its history)
  if ((m = /^\/api\/meals\/(\d{4}-\d{2}-\d{2})\/eaten$/.exec(path)) && method === 'POST') {
    const t = await env.DB.prepare('SELECT id FROM tasks WHERE legacy_ref = ?').bind(`meal:${m[1]}`).first();
    if (!t) return notYours();
    if (body && body.eaten === 0) await env.DB.prepare('DELETE FROM task_log WHERE task_id = ? AND occ = ?').bind(t.id, m[1]).run();
    else await env.DB.prepare(`INSERT INTO task_log (task_id, occ, status, at, by_user) VALUES (?, ?, 'done', ?, ?) ON CONFLICT(task_id, occ) DO NOTHING`).bind(t.id, m[1], nowIso(), uid).run();
    return json({ ok: true });
  }

  // Evening wrap-up: move leftovers to tomorrow
  if (path === '/api/wrap/move' && method === 'POST') {
    const ids = ((body && body.ids) || []).map(Number).filter(Boolean).slice(0, 200);
    const until = Date.parse(body && body.to);
    if (!ids.length || !until) return json({ error: 'ids and to required' }, 400);
    for (const id of ids) if (await owns(env, 'items', id, uid)) await updateTodo(env, id, { due_at: new Date(until).toISOString(), snooze_until: null }, uid);
    return json({ ok: true, moved: ids.length });
  }

  // Travel documents (passport, Global Entry...). Each keeps a renewal reminder item.
  if (path === '/api/documents' && method === 'POST') {
    try { return json(await saveDocument(env, null, body || {}, uid), 201); } catch (e) { return json({ error: e.message }, 400); }
  }
  if ((m = /^\/api\/documents\/(\d+)$/.exec(path)) && !(await owns(env, 'documents', +m[1], uid))) return notYours();
  if ((m = /^\/api\/documents\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') {
      try { return json(await saveDocument(env, +m[1], body || {}, uid)); } catch (e) { return json({ error: e.message }, 400); }
    }
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(+m[1]),
        env.DB.prepare("UPDATE tasks SET archived = 1 WHERE kind = 'task' AND legacy_ref = ?").bind(`x:doc:${+m[1]}`),
      ]);
      return json({ ok: true });
    }
  }

  // Imports and syncs
  if (path === '/api/import/vcard' && method === 'POST') return json(await importVcards(env, await req.text(), uid));
  if (path === '/api/import/contacts' && method === 'POST') { const r = await importContacts(env, body && body.contacts, uid); await syncPeopleTasks(env, uid); return json(r); }
  if (path === '/api/events/sync' && method === 'POST') {
    let events;
    if (body) events = body.events || body;
    else {
      const text = await req.text();
      events = parseEventLines(text);
    }
    return json(await syncEvents(env, events, uid));
  }
  if (path === '/api/sync/items' && method === 'POST') return json(await syncItems(env, body, uid));

  // Settings and testing
  if (path === '/api/settings' && method === 'PATCH') {
    for (const k of ['quiet_start', 'quiet_end', 'briefing_hour', 'name', 'default_travel', 'hide_cal_birthdays', 'wrap_hour', 'meal_plan_hour', 'palette']) if (k in body) await setSetting(env, k, String(body[k]).slice(0, 60), uid);
    if ('shared_calendar' in body) { await setSetting(env, 'shared_calendar', String(body.shared_calendar).slice(0, 500), uid); await reshareEvents(env); }
    // Weather location: rounded to about 1 km, used only to ask the National Weather Service for a forecast.
    if ('weather_lat' in body && 'weather_lon' in body) {
      const lat = Math.round(+body.weather_lat * 100) / 100, lon = Math.round(+body.weather_lon * 100) / 100;
      const valid = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && body.weather_lat !== '';
      await setSetting(env, 'weather_lat', valid ? lat : '');
      await setSetting(env, 'weather_lon', valid ? lon : '');
      await setSetting(env, 'weather_points', '');
      await setSetting(env, 'weather_cache', '');
    }
    const out = await getSettings(env, uid);
    delete out.weather_cache;
    return json(out);
  }
  // ---------- Tasks (the one task model; see docs/tasks-design.md) ----------
  if (path === '/api/tasks' && method === 'POST') {
    const data = taskFields(body || {});
    if (!data.title) return json({ error: 'title required' }, 400);
    const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM tasks WHERE user_id = ? AND kind = ?').bind(uid, data.kind || 'task').first();
    const row = await insertRow(env, 'tasks', { kind: 'task', repeat: 'never', ...data, user_id: uid, sort: max.s + 1, created_at: nowIso(),
      // Everyday tasks may have no date ("someday"); other kinds start today
      date: data.kind === 'task' && 'date' in data ? data.date : data.date || localParts(new Date(), env.TZ || 'America/Chicago').date });
    return json(taskOut(row), 201);
  }
  if ((m = /^\/api\/tasks\/(\d+)(\/log|\/snooze)?$/.exec(path)) && !(await owns(env, 'tasks', +m[1], uid))) return notYours();
  if ((m = /^\/api\/tasks\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') {
      const before = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(+m[1]).first();
      const fields = taskFields(body || {});
      const row = await updateRow(env, 'tasks', +m[1], fields);
      // An everyday task whose schedule or reminder changed starts its reminders over
      if (row && row.kind === 'task' && ['date', 'time', 'repeat', 'custom', 'nag', 'nag_mode', 'nag_time', 'nag_dow'].some((k) => k in fields && String(fields[k] ?? '') !== String(before[k] ?? ''))) await clearTodoNags(env, row.id);
      if ('nag' in (body || {}) && row && row.legacy_ref) {
        const [kind, ref] = row.legacy_ref.split(':');
        if (kind === 'bday') await env.DB.prepare('UPDATE people SET bday_remind = ? WHERE id = ?').bind(row.nag, +ref).run();
        if (kind === 'pdate') await env.DB.prepare('UPDATE person_dates SET remind = ? WHERE id = ?').bind(row.nag, +ref).run();
      }
      return json(taskOut(row));
    }
    if (method === 'DELETE') { await env.DB.prepare('UPDATE tasks SET archived = 1 WHERE id = ?').bind(+m[1]).run(); return json({ ok: true }); }
  }
  if ((m = /^\/api\/tasks\/(\d+)\/log$/.exec(path)) && method === 'POST') {
    const occ = String((body && body.occ) || '');
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(occ)) return json({ error: 'occ required' }, 400);
    const status = body.status;
    const pid = await catchupPerson(env, +m[1]);
    if (status === 'undo') { await env.DB.prepare('DELETE FROM task_log WHERE task_id = ? AND occ = ?').bind(+m[1], occ).run(); if (pid) await afterTalk(env, uid, pid); return json({ ok: true }); }
    if (!['done', 'partial', 'skipped'].includes(status)) return json({ error: 'status must be done, partial, skipped or undo' }, 400);
    await env.DB.prepare(`INSERT INTO task_log (task_id, occ, status, amount, at, by_user) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, occ) DO UPDATE SET status = excluded.status, amount = excluded.amount, at = excluded.at, by_user = excluded.by_user`)
      .bind(+m[1], occ, status, body.amount == null ? null : +body.amount || 0, nowIso(), uid).run();
    await env.DB.prepare('UPDATE tasks SET snooze_until = NULL WHERE id = ?').bind(+m[1]).run();
    if (pid) await afterTalk(env, uid, pid);
    return json({ ok: true });
  }
  if ((m = /^\/api\/tasks\/(\d+)\/snooze$/.exec(path)) && method === 'POST') {
    const minutes = Math.min(7 * 1440, Math.max(5, +(body && body.minutes) || 60));
    await env.DB.prepare('UPDATE tasks SET snooze_until = ? WHERE id = ?').bind(new Date(Date.now() + minutes * 60000).toISOString(), +m[1]).run();
    return json({ ok: true });
  }

  // ---------- Rewards (shared by the household) ----------
  if (path === '/api/rewards/logs' && method === 'POST') {
    const b = body || {};
    const card = await rwCard(env, b.card_id);
    const ben = card && (card.benefits || []).find((x) => x.id === b.benefit_id);
    const amount = Math.round(+b.amount * 100) / 100;
    if (!ben || !(amount > 0) || amount > 100000) return json({ error: 'card, benefit and amount required' }, 400);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : localParts(new Date(), env.TZ || 'America/Chicago').date;
    const info = RW.periodInfo(ben.period, RW.parseDate(date), card);
    const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    await env.DB.prepare('INSERT INTO rw_logs (id, card_id, benefit_id, year, period, kind, amount, date, note, by_user, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, card.id, ben.id, +date.slice(0, 4), info.key, 'use', amount, date, b.note ? String(b.note).slice(0, 200) : null, uid, nowIso()).run();
    return json({ ok: true, id }, 201);
  }
  if ((m = /^\/api\/rewards\/logs\/([\w-]+)$/.exec(path)) && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM rw_logs WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }
  // Card changes: snoozes, certificates, benefit on/off, fee and dates, notes
  if ((m = /^\/api\/rewards\/cards\/([\w-]+)$/.exec(path)) && method === 'PATCH') {
    const card = await rwCard(env, m[1]);
    if (!card) return notYours();
    const b = body || {};
    const next = { ...card };
    delete next.id; delete next.owner;
    const str = (v, n) => (v ? String(v).slice(0, n) : null);
    const dateOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
    if ('name' in b) next.name = str(b.name, 80) || card.name;
    if ('issuer' in b) next.issuer = str(b.issuer, 40);
    if ('fee' in b) next.fee = Math.max(0, Math.round(+b.fee || 0));
    if ('renews' in b) next.renews = dateOk(b.renews);
    if ('opened' in b) next.opened = dateOk(b.opened);
    if ('notes' in b) next.notes = str(b.notes, 1000);
    if ('hidden' in b && Array.isArray(b.hidden)) next.hidden = b.hidden.map(String).slice(0, 60);
    if ('snoozed' in b && b.snoozed && typeof b.snoozed === 'object') next.snoozed = Object.fromEntries(Object.entries(b.snoozed).filter(([, v]) => v).map(([k, v]) => [String(k), String(v)]));
    if ('certs' in b && Array.isArray(b.certs)) next.certs = b.certs.slice(0, 40).map((x) => ({ id: str(x.id, 20) || Math.random().toString(36).slice(2, 10), benId: str(x.benId, 60),
      expires: dateOk(x.expires) || '', potential: x.potential == null ? null : +x.potential || 0, used: !!x.used, note: str(x.note, 200) || '', at: +x.at || Date.now() }));
    if ('benefits' in b && Array.isArray(b.benefits)) next.benefits = b.benefits.slice(0, 60).map((x) => ({ ...x, id: str(x.id, 60), name: str(x.name, 80), amount: x.amount == null ? undefined : +x.amount || 0 }));
    let owner = card.owner;
    if ('owner' in b && (await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(+b.owner).first())) owner = +b.owner;
    await env.DB.prepare('UPDATE rw_cards SET data = ?, owner = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(next), owner, nowIso(), card.id).run();
    await syncCreditTasks(env);
    return json({ ok: true });
  }
  if (path === '/api/rewards/cards' && method === 'POST') {
    const b = body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return json({ error: 'Card name required' }, 400);
    const owner = (await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(+b.owner || uid).first()) ? (+b.owner || uid) : uid;
    const id = `u${owner}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`;
    const data = { name, issuer: b.issuer ? String(b.issuer).slice(0, 40) : '', mark: String(b.issuer || name).slice(0, 5).toUpperCase(), art: 'slate',
      fee: Math.max(0, Math.round(+b.fee || 0)), renews: /^\d{4}-\d{2}-\d{2}$/.test(b.renews || '') ? b.renews : null, currency: b.currency || 'CASH', benefits: [], hidden: [], certs: [] };
    await env.DB.prepare('INSERT INTO rw_cards (id, owner, data, updated_at) VALUES (?, ?, ?, ?)').bind(id, owner, JSON.stringify(data), nowIso()).run();
    await syncCreditTasks(env);
    return json({ ok: true, id }, 201);
  }
  if ((m = /^\/api\/rewards\/cards\/([\w-]+)$/.exec(path)) && method === 'DELETE') {
    await env.DB.batch([env.DB.prepare('DELETE FROM rw_cards WHERE id = ?').bind(m[1]), env.DB.prepare('DELETE FROM rw_logs WHERE card_id = ?').bind(m[1])]);
    await syncCreditTasks(env);
    return json({ ok: true });
  }
  // Point balances: { user, program, balance } (0 removes it)
  if (path === '/api/rewards/points' && method === 'POST') {
    const b = body || {};
    const who = +b.user || uid;
    if (!(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(who).first())) return json({ error: 'unknown person' }, 400);
    const prog = String(b.program || '').slice(0, 40);
    const n = Math.max(0, Math.round(+b.balance || 0));
    if (!/^[\w-]+$/.test(prog)) return json({ error: 'program required' }, 400);
    const row = await env.DB.prepare('SELECT * FROM rw_points WHERE user_id = ?').bind(who).first();
    const balances = row ? JSON.parse(row.balances) : {}, updated = row ? JSON.parse(row.updated) : {};
    if (n > 0) { balances[prog] = n; updated[prog] = localParts(new Date(), env.TZ || 'America/Chicago').date; } else { delete balances[prog]; delete updated[prog]; }
    await env.DB.prepare(`INSERT INTO rw_points (user_id, balances, updated) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET balances = excluded.balances, updated = excluded.updated`).bind(who, JSON.stringify(balances), JSON.stringify(updated)).run();
    return json({ ok: true });
  }

  // Backup: everything that's yours plus the shared household data, as one JSON file.
  // Every kind of task (habits, medications, Home, people dates, credits, dinners) is in tasks / task_log;
  // everyday tasks and trip bookings too (kind "task"). Left out on purpose: push subscriptions (device keys).
  if (path === '/api/backup' && method === 'GET') {
    const all = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
    const people = 'SELECT id FROM people WHERE user_id = ?';
    const out = {
      app: 'life-dashboard', version: 2, exported_at: nowIso(), person: (await all('SELECT id, name FROM users WHERE id = ?', uid))[0],
      yours: {
        people: await all('SELECT * FROM people WHERE user_id = ?', uid),
        contact_log: await all(`SELECT * FROM contact_log WHERE person_id IN (${people})`, uid),
        gifts: await all(`SELECT * FROM gifts WHERE person_id IN (${people})`, uid),
        person_dates: await all(`SELECT * FROM person_dates WHERE person_id IN (${people})`, uid),
        tasks: await all('SELECT * FROM tasks WHERE user_id = ? OR shared = 1', uid),
        task_log: await all('SELECT l.* FROM task_log l JOIN tasks t ON t.id = l.task_id WHERE t.user_id = ? OR t.shared = 1', uid),
        documents: await all('SELECT * FROM documents WHERE user_id = ?', uid),
        event_prefs: await eventPrefRows(env, uid),
        calendar_events: await visibleEvents(env, uid),
        settings: await getSettings(env, uid),
      },
      shared: {
        trips: await all('SELECT * FROM trips'),
        rewards: {
          cards: await all('SELECT * FROM rw_cards'),
          logs: await all('SELECT * FROM rw_logs'),
          points: await all('SELECT * FROM rw_points'),
          config: await all('SELECT * FROM rw_config'),
        },
        notes: 'Dinners, Home tasks and credits are tasks: see yours.tasks / yours.task_log (kind "meal", "home", "credit").',
      },
    };
    delete out.yours.settings.weather_cache;
    await setSetting(env, 'last_backup_at', nowIso(), uid);
    const bt = await todoRow(env, 'legacy_ref = ?', `x:backup:${uid}`);
    if (bt) await completeTodo(env, bt.id, uid);
    const day = localParts(new Date(), env.TZ || 'America/Chicago').date;
    return new Response(JSON.stringify(out, null, 1), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="life-backup-${day}.json"` } });
  }

  // Life's own notifications: this device's push subscription
  if (path === '/api/push/subscribe' && method === 'POST') {
    const ep = String((body && body.endpoint) || '');
    const keys = (body && body.keys) || {};
    let host = '';
    try { host = new URL(ep).hostname; } catch (_) { /* invalid */ }
    // Only real push services (never an arbitrary address for the server to call)
    const okHost = /^https:/.test(ep) && /(^|\.)push\.apple\.com$|^fcm\.googleapis\.com$|(^|\.)push\.services\.mozilla\.com$|(^|\.)notify\.windows\.com$/.test(host);
    if (!okHost || !/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh || '') || !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth || '')) return json({ error: 'Not a valid push subscription' }, 400);
    await env.DB.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, last_error = NULL`)
      .bind(uid, ep.slice(0, 1000), keys.p256dh, keys.auth, String(body.device || '').slice(0, 60) || null, nowIso()).run();
    return json({ ok: true });
  }
  if (path === '/api/push/subscribe' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String((body && body.endpoint) || ''), uid).run();
    return json({ ok: true });
  }
  if (path === '/api/test-push' && method === 'POST') {
    const ok = await push(env, { to: uid, title: 'Life Dashboard', message: 'Test notification. If you see this, push works.' });
    return json(ok ? { ok: true } : { error: `Notification failed: ${lastPushError}` }, ok ? 200 : 502);
  }
  if (path === '/api/run-cron' && method === 'POST') return json(await runCron(env, { force: !!(body && body.briefing), only: uid }));

  return json({ error: 'not found' }, 404);
}

// ---------- travel documents ----------

async function saveDocument(env, id, body, uid = 1) {
  const name = String(body.name || '').trim().slice(0, 80);
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(body.expires_on || '') ? body.expires_on : null;
  if (!name || !expires) throw new Error('name and expires_on (YYYY-MM-DD) required');
  const months = Math.min(24, Math.max(1, +body.remind_months || 9));
  const notes = body.notes ? String(body.notes).slice(0, 500) : null;
  const doc = id
    ? await updateRow(env, 'documents', id, { name, expires_on: expires, remind_months: months, notes })
    : await insertRow(env, 'documents', { name, expires_on: expires, remind_months: months, notes, user_id: uid });
  // Renewal reminder: `months` before expiry, 9am local, reminded once (then it stays on Today).
  const tz = env.TZ || 'America/Chicago';
  const [y, mo, d] = expires.split('-').map(Number);
  const when = new Date(Date.UTC(y, mo - 1 - months, d));
  const due = zonedToUtc(when.getUTCFullYear(), when.getUTCMonth() + 1, when.getUTCDate(), 9, 0, tz).toISOString();
  await upsertTodo(env, `x:doc:${doc.id}`, { title: `Renew ${name}`, area: 'travel', due_at: due, nag: 'once', source: 'documents', notes: `Expires ${expires}` }, uid, { reopen: true });
  return doc;
}

// ---------- calendar sync (from an Apple Shortcut) ----------

// Text form, one event per line: start|end|allDay|title   (ISO 8601 dates; allDay = yes/no)
// Optional extra fields, for leave-by alerts: start|end|allDay|title|location|travelMinutes
function parseEventLines(text) {
  // A new event starts only on a line beginning with a date, so multi-line
  // locations ("Clinic\n123 Main St") stay with their event.
  return text.split(/\r?\n(?=\s*\d{4}-\d{2}-\d{2})/).map((rec) => rec.trim().replace(/\s*\r?\n\s*/g, ', ')).filter(Boolean).map((line) => {
    const parts = line.split('|').map((s) => s.trim());
    // Optional last field "cal:<calendar name>" says which calendar the event is on.
    const calendar = parts.length > 4 && /^cal:/i.test(parts[parts.length - 1]) ? parts.pop().slice(4).trim() : null;
    const [start, end, allDay] = parts;
    let rest = parts.slice(3), location = null, travel = null;
    // With "cal:" the Shortcut always sends title|location, so the location is the last piece and
    // any bars before it belong to the title ("Flight 1 of 2 | DL123").
    if (calendar && rest.length >= 2) location = rest.pop();
    else if (rest.length >= 3 && /^\d*(\.\d+)?$/.test(rest[rest.length - 1])) { travel = rest.pop(); location = rest.pop(); }
    else if (rest.length === 2) location = rest.pop();
    return { start, end: end || '', allDay: /^(yes|true|1)$/i.test(allDay || ''), title: rest.join(' | '), location: location || null, travelMinutes: travel, calendar };
  });
}

async function syncEvents(env, events, uid = 1) {
  if (!Array.isArray(events)) return { error: 'expected a list of events' };
  const sharedList = sharedCalendars(await getSettings(env, uid));
  const rows = events
    .map((e) => ({
      title: e.title || '(untitled)', start: Date.parse(e.start), end: e.end ? Date.parse(e.end) : NaN, allDay: !!e.allDay,
      location: e.location ? String(e.location).slice(0, 200) : null,
      travel: e.travelMinutes !== null && e.travelMinutes !== undefined && e.travelMinutes !== '' && Number.isFinite(+e.travelMinutes) ? Math.round(+e.travelMinutes) : null,
      calendar: e.calendar ? String(e.calendar).slice(0, 100) : null,
    }))
    .filter((e) => !isNaN(e.start));
  const stmts = [env.DB.prepare('DELETE FROM events WHERE user_id = ?').bind(uid)];
  for (const e of rows) {
    const shared = isSharedCal(sharedList, e.calendar) ? 1 : 0;
    stmts.push(env.DB.prepare('INSERT INTO events (title, start_at, end_at, all_day, location, travel_min, user_id, calendar, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(e.title, new Date(e.start).toISOString(), isNaN(e.end) ? null : new Date(e.end).toISOString(), e.allDay ? 1 : 0, e.location, e.travel, uid, e.calendar, shared));
  }
  await env.DB.batch(stmts);
  await setSetting(env, 'events_synced_at', nowIso(), uid);
  const sharedN = rows.filter((e) => isSharedCal(sharedList, e.calendar)).length;
  return { ok: true, events: rows.length, shared: sharedN, calendars: rows.some((e) => e.calendar) };
}

// ---------- quick capture (Siri / Apple Watch) ----------

async function captureText(env, raw, uid = 1) {
  const text = String(raw || '').trim().slice(0, 500);
  const reply = (msg, status = 200) => new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!text) return reply("I didn't catch anything to add.", 400);
  const tz = env.TZ || 'America/Chicago';
  // The parser thinks in local wall-clock time: give it a clock shifted to your time zone, then shift back.
  const now = new Date();
  const p = localParts(now, tz);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(now.getTime() / 60000) * 60000;
  const people = (await env.DB.prepare('SELECT id, name FROM people WHERE user_id = ?').bind(uid).all()).results;
  const parsed = parseCapture(text, people, new Date(now.getTime() + offset));
  const due = parsed.due ? new Date(parsed.due.getTime() - offset) : null;
  await createTodo(env, {
    title: parsed.title, area: parsed.area, kind: parsed.kind, due_at: due ? due.toISOString() : null,
    nag: parsed.nag, repeat_days: parsed.repeat || null, person_id: parsed.person ? parsed.person.id : null, source: 'siri',
  }, uid);
  const when = due ? new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(due) : null;
  const how = { hourly: 'reminding you hourly', daily: 'reminding you daily', '15m': 'reminding you every 15 minutes', once: 'one reminder' }[parsed.nag];
  return reply(`Added "${parsed.title}"${when ? `, ${when}` : ''}${due && how ? `, ${how}` : ''}.`);
}

// ---------- weather (api.weather.gov, US only, free, no key) ----------

const NWS_HEADERS = { 'User-Agent': 'life-dashboard (personal app)', Accept: 'application/geo+json' };

async function getWeather(env) {
  const s = await getSettings(env);
  if (!s.weather_lat || !s.weather_lon) return { configured: false };
  try {
    const cached = s.weather_cache ? JSON.parse(s.weather_cache) : null;
    if (cached && Date.now() - cached.fetched < 3600000) return cached;
  } catch (_) { /* refetch */ }
  try {
    let points = s.weather_points ? JSON.parse(s.weather_points) : null;
    if (!points) {
      const r = await fetch(`https://api.weather.gov/points/${s.weather_lat},${s.weather_lon}`, { headers: NWS_HEADERS });
      if (!r.ok) throw new Error(`points ${r.status}`);
      const pj = await r.json();
      points = { forecast: pj.properties.forecast, hourly: pj.properties.forecastHourly, place: pj.properties.relativeLocation?.properties?.city || '' };
      await setSetting(env, 'weather_points', JSON.stringify(points));
    }
    const [fr, hr] = await Promise.all([fetch(points.forecast, { headers: NWS_HEADERS }), fetch(points.hourly, { headers: NWS_HEADERS })]);
    if (!fr.ok || !hr.ok) throw new Error(`forecast ${fr.status}/${hr.status}`);
    const periods = (await fr.json()).properties.periods.slice(0, 3);
    const hour = (await hr.json()).properties.periods[0];
    const pp = (x) => x && x.probabilityOfPrecipitation && x.probabilityOfPrecipitation.value;
    const out = {
      configured: true, fetched: Date.now(), place: points.place,
      now: { temp: hour.temperature, unit: hour.temperatureUnit, text: hour.shortForecast, rain: pp(hour) },
      periods: periods.map((x) => ({ name: x.name, day: x.isDaytime, temp: x.temperature, text: x.shortForecast, rain: pp(x) })),
    };
    await setSetting(env, 'weather_cache', JSON.stringify(out));
    return out;
  } catch (err) {
    return { configured: true, error: 'Weather is unavailable right now.' };
  }
}

function weatherLine(w) {
  if (!w || !w.configured || w.error || !w.periods) return null;
  const day = w.periods.find((x) => x.day), night = w.periods.find((x) => !x.day);
  return `${w.now.temp}° now, ${w.now.text.toLowerCase()}${day ? ` · high ${day.temp}°` : ''}${night ? ` · low ${night.temp}°` : ''}${day && day.rain ? ` · ${day.rain}% rain` : ''}`;
}

// ---------- item sync (e.g. Wayfare bookings) ----------

async function syncItems(env, body, uid = 1) {
  const source = (body && body.source) || 'external';
  const items = ((body && body.items) || []).filter((i) => i.external_id && i.title).slice(0, 300);
  // Bookings belong to their trip (matched by the trip's Wayfare id)
  const { results: trips } = await env.DB.prepare('SELECT id, external_id FROM trips WHERE external_id IS NOT NULL').all();
  for (const i of items) {
    const ext = `${source}:${i.external_id}`;
    const trip = trips.find((t) => ext.startsWith(`${t.external_id}:`));
    await upsertTodo(env, `x:${uid === 1 ? '' : `u${uid}:`}${ext}`, { title: i.title, notes: i.notes || null, area: i.area || 'travel', due_at: i.due_at || null,
      nag: i.nag || 'hourly', source, status: i.done ? 'done' : 'open', ...(trip ? { trip_id: trip.id } : {}) }, uid);
  }
  return { ok: true, synced: items.length };
}

// ---------- vCard import (one-time Contacts load) ----------

// Contacts arrive already chosen and trimmed on your device (the review screen);
// the .vcf upload path is kept for completeness. Re-importing only fills blanks:
// anything you've edited in the app is kept.
async function importContacts(env, contacts, uid = 1) {
  const list = (Array.isArray(contacts) ? contacts : []).filter((c) => c && c.name).slice(0, 5000);
  const str = (v, n) => (v ? String(v).slice(0, n) : null);
  const date = (v) => (/^(\d{4}|-)-?\d{2}-\d{2}$/.test(v || '') ? v : null);
  // Each person's contacts are their own: ids are prefixed for everyone but user 1 so they never collide.
  const ext = (c) => `${uid === 1 ? '' : `u${uid}:`}${str(c.uid, 200) || `name:${String(c.name).toLowerCase()}`}`;
  let i = 0;
  for (; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    await env.DB.batch(chunk.map((c) => env.DB.prepare(`INSERT INTO people (name, birthday, phone, email, notes, external_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        birthday = COALESCE(people.birthday, excluded.birthday), phone = COALESCE(people.phone, excluded.phone),
        email = COALESCE(people.email, excluded.email), notes = COALESCE(people.notes, excluded.notes)`)
      .bind(str(c.name, 120), date(c.birthday), str(c.phone, 40), str(c.email, 120), str(c.notes, 2000), ext(c), uid)));
  }
  // Important dates (anniversaries, etc.)
  const withDates = list.filter((c) => Array.isArray(c.dates) && c.dates.length);
  for (const c of withDates) {
    const person = await env.DB.prepare('SELECT id FROM people WHERE external_id = ? AND user_id = ?').bind(ext(c), uid).first();
    if (!person) continue;
    await env.DB.batch(c.dates.filter((d) => date(d.date)).slice(0, 10).map((d) => env.DB.prepare(
      'INSERT OR IGNORE INTO person_dates (person_id, label, date) VALUES (?, ?, ?)').bind(person.id, str(d.label, 60) || 'Date', d.date)));
  }
  return { ok: true, imported: list.length, withBirthday: list.filter((c) => date(c.birthday)).length, withDates: withDates.length };
}

async function importVcards(env, text, uid = 1) {
  return importContacts(env, parseVcards(text), uid);
}

// ---------- push (Life's own notifications) ----------

// Send to every phone / browser where this person turned on notifications (Settings).
// Failures are remembered (Settings shows the last one) instead of disappearing silently.
let lastPushError = null;
async function push(env, opts) {
  const { results: subs } = await env.DB.prepare('SELECT * FROM push_subs WHERE user_id = ?').bind(opts.to || 1).all();
  if (subs.length && env.VAPID_PRIVATE_JWK) return pushWeb(env, subs, opts);
  lastPushError = 'Notifications are not turned on for this person (Settings › Notifications)';
  console.error('push skipped:', opts.title, lastPushError);
  return false;
}

async function pushWeb(env, subs, { title, message, priority = 3, click, tag }) {
  const url = click || `${env.PUBLIC_URL || ''}/#today`;
  const payload = { title, body: message || '', url, tag: tag || undefined };
  let anyOk = false, lastErr = null;
  for (const sub of subs) {
    let r;
    try { r = await sendWebPush(env, sub, payload, { urgency: priority >= 4 ? 'high' : 'normal', topic: tag ? tag.slice(0, 32) : undefined }); }
    catch (err) { r = { ok: false, error: `send failed: ${String((err && err.message) || err).slice(0, 150)}` }; }
    if (r.ok) { anyOk = true; await env.DB.prepare('UPDATE push_subs SET last_ok_at = ?, last_error = NULL WHERE id = ?').bind(nowIso(), sub.id).run(); }
    else if (r.gone) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id).run(); // phone removed it
    else { lastErr = r.error; await env.DB.prepare('UPDATE push_subs SET last_error = ? WHERE id = ?').bind(`${nowIso()} · ${r.error}`, sub.id).run(); }
  }
  if (anyOk) { lastPushError = null; return true; }
  lastPushError = lastErr || 'This device turned notifications off';
  console.error('web push failed:', title, lastPushError);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_push_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(`${nowIso()} · ${title} · ${lastPushError}`).run().catch(() => {});
  return false;
}

// ---------- cron: nags + morning briefing ----------

const AREA_LABEL = { hoa: 'HOA', travel: 'Travel', people: 'People', home: 'Home', work: 'Work' };

// Runs for each person (or just `only`, when someone taps "Send briefing now").
async function runCron(env, { force = false, only = null } = {}) {
  const tz = env.TZ || 'America/Chicago';
  const now = new Date();
  const local = localParts(now, tz);
  await env.DB.prepare("DELETE FROM auth_failures WHERE at < ?").bind(new Date(Date.now() - 86400000).toISOString()).run();
  const users = (await listUsers(env)).filter((u) => !only || u.id === only);
  const report = { people: {} };
  for (const u of users) {
    try { report.people[u.id] = await runCronFor(env, u.id, { force, tz, now, local }); }
    catch (err) { console.error('cron failed for user', u.id, err); report.people[u.id] = { error: String((err && err.message) || err) }; }
  }
  if (only && report.people[only]) Object.assign(report, report.people[only]);
  return report;
}

async function runCronFor(env, uid, { force, tz, now, local }) {
  const s = await getSettings(env, uid);
  const qs = +s.quiet_start, qe = +s.quiet_end;
  const quiet = qs > qe ? (local.h >= qs || local.h < qe) : (local.h >= qs && local.h < qe);
  const report = { quiet, sent: [] };

  // Morning briefing: due at briefing_hour; if that send fails, keep retrying for up to 3 hours.
  const bh = +s.briefing_hour;
  if (force || (local.h >= bh && local.h < bh + 3 && s.last_briefing !== local.date)) {
    let ok = false;
    try { ok = await sendBriefing(env, tz, local, uid); }
    catch (err) { lastPushError = `briefing error: ${String(err && err.message || err).slice(0, 150)}`; console.error(lastPushError); }
    report.briefing = ok ? 'sent' : `failed: ${lastPushError}`;
    if (ok) { await setSetting(env, 'last_briefing', local.date, uid); report.sent.push('briefing'); }
    else await setSetting(env, 'last_push_error', `${now.toISOString()} · briefing (user ${uid}) · ${lastPushError}`);
  }
  await ensureBackupReminder(env, tz, local, uid, s);
  // Birthdays, important dates and catch-ups are tasks now (synced from People; reminders come
  // from sendTaskReminders). Only the gift nudge is still generated here.
  if (!s.people_tasks_v1) { await syncPeopleTasks(env, uid); await setSetting(env, 'people_tasks_v1', nowIso(), uid); }
  if (uid === 1 && !s.credit_tasks_v1) { await syncCreditTasks(env); await setSetting(env, 'credit_tasks_v1', nowIso(), 1); }
  await ensurePeopleReminders(env, tz, local, uid);
  report.sent.push(...await sendHomeReminders(env, tz, local, quiet, now, uid));
  report.sent.push(...await sendRewardsReminders(env, tz, local, now, uid));
  report.sent.push(...await sendTaskReminders(env, tz, local, quiet, now, uid));
  const wrapHour = s.wrap_hour === '' || s.wrap_hour === undefined ? 21 : +s.wrap_hour;
  if (wrapHour >= 0 && local.h === wrapHour && s.last_wrap !== local.date) {
    await sendWrapUp(env, tz, local, uid);
    await setSetting(env, 'last_wrap', local.date, uid);
    report.sent.push('wrap-up');
  }
  // Sunday meal planning nudge (once, at the hour you chose; default 4pm)
  const mealHour = s.meal_plan_hour === '' || s.meal_plan_hour === undefined ? 16 : +s.meal_plan_hour;
  if (mealHour >= 0 && local.wd === 'Sun' && local.h === mealHour && s.last_meal_nudge !== local.date) {
    const left = await unplannedNights(env, local);
    if (left) await push(env, { to: uid, title: 'Meal planning', message: `${left} night${left === 1 ? '' : 's'} this week (Sun–Sat) still need a dinner plan.`, click: `${env.PUBLIC_URL}/#meals`, priority: 3 });
    await setSetting(env, 'last_meal_nudge', local.date, uid);
    if (left) report.sent.push('meal-nudge');
  }
  if (quiet) return report;
  if (s.focus_until && Date.parse(s.focus_until) > now.getTime()) { report.focus = true; return report; }

  // Everyday tasks whose reminders go to you (yours, or ones set to remind you / both of you).
  //   nag off: one alert at the due time (9am for date-only), unless it's set to stay silent
  //   hourly: every hour from the due time;  daily / weekly: once a day (on the chosen weekday) after the chosen time
  const dow = new Date(Date.UTC(local.y, local.m - 1, local.d)).getUTCDay();
  const minutesNow = local.h * 60 + local.min;
  const open = (await openTodos(env, uid, local, tz)).filter(({ t, due }) => due <= now && !(t.snooze_until && Date.parse(t.snooze_until) > now) && !(t.details && t.details.note));
  const nagRows = open.length ? Object.fromEntries((await env.DB.prepare('SELECT key, last_at, count FROM task_nags WHERE key LIKE ?').bind(`todo:%:${uid}:%`).all()).results.map((r) => [r.key, r])) : {};
  const due = [];
  for (const { t, o, due: dueAt } of open) {
    const key = `todo:${t.id}:${uid}:${o.key}`;
    const n = nagRows[key];
    const mode = t.nag ? t.nag_mode : (t.details && t.details.silent ? 'none' : 'once');
    let send = false;
    if (mode === 'once') send = !n;
    else if (mode === 'hourly') send = !n || (now - Date.parse(n.last_at)) / 60000 >= 58;
    else if (mode === 'daily' || mode === 'weekly') {
      const [h, mi] = String(t.nag_time || '09:00').split(':').map(Number);
      send = minutesNow >= h * 60 + mi && (mode === 'daily' || dow === (t.nag_dow ?? 1)) && (!n || localParts(new Date(n.last_at), tz).date !== local.date);
    }
    if (!send) continue;
    const d = t.details || {};
    due.push({ id: t.id, key, title: t.title, area: d.area, source: d.source, external_id: (t.legacy_ref || '').replace(/^x:(u\d+:)?/, ''),
      due_at: dueAt.toISOString(), nag: mode, notify_count: n ? n.count : 0 });
  }
  const markSent = async (items) => {
    await env.DB.batch(items.map((it) => env.DB.prepare('INSERT INTO task_nags (key, last_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at, count = task_nags.count + 1').bind(it.key, now.toISOString())));
    report.sent.push(...items.map((it) => it.key));
  };
  const whenText = (item) => {
    const overdueMin = (now - Date.parse(item.due_at)) / 60000;
    return overdueMin < 60 ? 'due now' : overdueMin < 1440 ? `overdue ${Math.round(overdueMin / 60)}h` : `overdue ${Math.floor(overdueMin / 1440)}d`;
  };

  // Bookings from the same Wayfare trip go out as one notification instead of one each.
  const { results: trips } = await env.DB.prepare('SELECT name, external_id FROM trips WHERE external_id IS NOT NULL').all();
  const tripOf = (item) => (item.source === 'wayfare' ? trips.find((t) => (item.external_id || '').startsWith(`${t.external_id}:`)) : null);
  const groups = new Map();
  for (const item of due) { const t = tripOf(item); if (t) { if (!groups.has(t.external_id)) groups.set(t.external_id, { trip: t, items: [] }); groups.get(t.external_id).items.push(item); } }
  for (const { trip, items } of groups.values()) {
    if (items.length < 2) continue;
    const names = items.map((it) => it.title.replace(/^Book\s+/i, ''));
    const late = items.filter((it) => Date.parse(it.due_at) < now - 3600000).length;
    const ok = await push(env, {
      to: uid, tag: `trip-${trip.external_id}`.slice(0, 32),
      title: `${trip.name}: ${items.length} bookings ${late ? 'overdue' : 'due'}`,
      message: `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}`,
      priority: items.some((it) => it.nag !== 'once') ? 4 : 3,
    });
    if (ok) await markSent(items);
    for (const it of items) it.grouped = true;
  }

  for (const item of due) {
    if (item.grouped) continue;
    const repeating = item.nag === 'once' ? '' : ` · reminder ${item.notify_count + 1}`;
    const isBooking = item.source === 'wayfare';
    const ok = await push(env, {
      to: uid,
      tag: `item-${item.id}`,
      title: item.title,
      message: [AREA_LABEL[item.area], isBooking ? 'from Wayfare' : null, whenText(item)].filter(Boolean).join(' · ') + repeating,
      priority: item.nag === 'once' ? 3 : 4,
    });
    if (ok) await markSent([item]);
  }
  return report;
}

// ---------- Dinners, stored as tasks ----------
// The dinner screens use the old meals shape: { date, title, kind, link, notes, eaten }.
async function loadMeals(env, fromSql, toSql) {
  const { results } = await env.DB.prepare(`SELECT t.id, t.date, t.details, t.created_at,
      EXISTS (SELECT 1 FROM task_log l WHERE l.task_id = t.id AND l.occ = t.date AND l.status = 'done') AS eaten
    FROM tasks t WHERE t.kind = 'meal' AND t.archived = 0 AND t.date >= ${fromSql} AND t.date <= ${toSql} ORDER BY t.date`).all();
  return results.map((r) => { const d = JSON.parse(r.details || '{}'); return { task_id: r.id, date: r.date, title: d.name || null, kind: d.mkind || 'cook', link: d.link || null, notes: d.notes || null, eaten: r.eaten ? 1 : 0, updated_at: r.created_at }; });
}

// ---------- Home tasks, stored as tasks ----------
// The Home screens and due rules (public/home.js) use the old home_tasks / home_log shape.
async function loadHome(env) {
  const { results } = await env.DB.prepare("SELECT * FROM tasks WHERE kind = 'home' AND archived = 0").all();
  const tasks = results.map((r) => {
    const d = r.details ? JSON.parse(r.details) : {};
    return { id: r.id, lib_key: d.lib_key || null, name: r.title, room: d.room || null, type: d.type || null, freq: d.freq || 'Annual', months: d.months || '*',
      who: d.who || null, est: d.est || null, first_due: d.first_due || null, notes: d.notes || null, snooze_until: d.snooze || null, hidden: r.archived,
      remind: r.nag ? r.nag_mode : 'none', remind_time: r.nag_time, remind_dow: r.nag_dow, remind_dom: d.remind_dom ?? null, remind_to: r.remind_to ?? 0 };
  });
  const { results: logs } = await env.DB.prepare(`SELECT l.id, l.task_id, l.occ AS date, CASE WHEN l.status = 'skipped' THEN 1 ELSE 0 END AS skipped
    FROM task_log l JOIN tasks t ON t.id = l.task_id WHERE t.kind = 'home' ORDER BY l.occ DESC`).all();
  const last = {};
  for (const l of logs) if (!last[l.task_id]) last[l.task_id] = l.date;
  return { tasks, logs, last };
}
const HOME_REPEAT = { Weekly: 'weekly', Monthly: 'monthly', Quarterly: 'quarterly', 'Semi-annual': 'semiannual', 'One-time': 'never' };
async function saveHomeTask(env, id, f, uid) {
  const cur = id ? await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first() : null;
  const d = { ...(cur && cur.details ? JSON.parse(cur.details) : {}) };
  for (const [k, col] of [['room', 'room'], ['type', 'type'], ['who', 'who'], ['est', 'est'], ['notes', 'notes'], ['freq', 'freq'], ['months', 'months'],
    ['first_due', 'first_due'], ['snooze_until', 'snooze'], ['remind_dom', 'remind_dom']]) if (k in f) d[col] = f[k];
  const row = { details: JSON.stringify(d) };
  if ('name' in f) row.title = f.name;
  if ('hidden' in f) row.archived = f.hidden;
  if ('freq' in f) row.repeat = HOME_REPEAT[f.freq] || 'yearly';
  if ('first_due' in f) row.date = f.first_due;
  if ('remind' in f) { row.nag = f.remind === 'none' ? 0 : 1; if (f.remind !== 'none') row.nag_mode = f.remind; }
  if ('remind_time' in f) row.nag_time = f.remind_time;
  if ('remind_dow' in f) row.nag_dow = f.remind_dow;
  if ('remind_to' in f) row.remind_to = f.remind_to;
  if (!id) {
    const created = await insertRow(env, 'tasks', { user_id: uid, shared: 1, kind: 'home', title: row.title || 'Home task', repeat: row.repeat || 'yearly', created_at: nowIso(), ...row });
    return (await loadHome(env)).tasks.find((t) => t.id === created.id);
  }
  await updateRow(env, 'tasks', id, row);
  return (await loadHome(env)).tasks.find((t) => t.id === id) || { ok: true };
}

// ---------- Credits -> tasks ----------
// Each credit (a card benefit of kind "credit" you track) is a task owned by the card's owner.
// The money stays in rw_logs (several uses per period, notes, totals); the task holds your
// reminder choices and puts the credit on the same footing as everything else.
const CREDIT_REPEAT = { monthly: 'monthly', quarterly: 'quarterly', semiannual: 'semiannual', annual: 'yearly', anniversary: 'yearly', '4yr': 'yearly' };
async function syncCreditTasks(env) {
  const rw = await loadRewards(env);
  const want = [];
  for (const c of rw.cards) for (const b of RW.visibleBenefits(c)) {
    if (b.kind !== 'credit') continue;
    want.push({ ref: `credit:${c.id}:${b.id}`, owner: c.owner, title: b.name, repeat: CREDIT_REPEAT[b.period] || 'yearly',
      details: { card_id: c.id, benefit_id: b.id, card_name: c.name, amount: +b.amount || 0, period: b.period } });
  }
  const stmts = want.map((w) => env.DB.prepare(`INSERT INTO tasks (user_id, kind, title, details, date, repeat, nag, nag_mode, archived, legacy_ref, created_at)
      VALUES (?, 'credit', ?, ?, '2026-01-01', ?, 1, 'daily', 0, ?, ?)
      ON CONFLICT(legacy_ref) DO UPDATE SET user_id = excluded.user_id, title = excluded.title, repeat = excluded.repeat, archived = 0,
        details = json_patch(COALESCE(tasks.details, '{}'), excluded.details)`)
    .bind(w.owner, w.title, JSON.stringify(w.details), w.repeat, w.ref, nowIso()));
  stmts.push(env.DB.prepare("UPDATE tasks SET archived = 1 WHERE kind = 'credit' AND legacy_ref NOT IN (SELECT value FROM json_each(?))").bind(JSON.stringify(want.map((w) => w.ref))));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return want.length;
}

// ---------- People -> tasks ----------
// Each person's birthday (if shown), important dates and catch-up become tasks, kept in step with
// the People data. Your reminder choices on a task are kept; the person page's checkboxes set them.
const yearlyDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : /^--\d{2}-\d{2}$/.test(d || '') ? `2000${d.slice(1)}` : null);
// Talks with someone are the log of their catch-up task (every person has one; with no check-in
// it has no date and never comes due). "Last contact" on the person is worked out from that log.
const talkHow = (v) => (['talked', 'called', 'texted', 'saw'].includes(v) ? v : 'talked');
const talkWho = (v) => (v === 'them' ? 'them' : 'me');
async function catchupTaskId(env, uid, personId) {
  const ref = `catchup:${+personId}`;
  let t = await env.DB.prepare('SELECT id FROM tasks WHERE legacy_ref = ?').bind(ref).first();
  if (!t) { await syncPeopleTasks(env, uid, +personId); t = await env.DB.prepare('SELECT id FROM tasks WHERE legacy_ref = ?').bind(ref).first(); }
  return t.id;
}
async function catchupPerson(env, taskId) {
  const t = await env.DB.prepare("SELECT legacy_ref FROM tasks WHERE id = ? AND kind = 'catchup'").bind(taskId).first();
  return t && /^catchup:\d+$/.test(t.legacy_ref || '') ? +t.legacy_ref.slice(8) : null;
}
async function afterTalk(env, uid, personId) {
  const last = await env.DB.prepare(`SELECT l.at, l.how FROM task_log l JOIN tasks t ON t.id = l.task_id
    WHERE t.legacy_ref = ? AND l.status != 'skipped' ORDER BY l.occ DESC, l.at DESC LIMIT 1`).bind(`catchup:${+personId}`).first();
  const r = await updateRow(env, 'people', +personId, { last_contact_at: last ? last.at : null, last_contact_how: last ? last.how || 'talked' : null });
  await syncPeopleTasks(env, uid, +personId);
  return r;
}
async function syncPeopleTasks(env, uid, personId = null) {
  const tz = env.TZ || 'America/Chicago';
  const today = localParts(new Date(), tz).date;
  const people = (await env.DB.prepare(`SELECT * FROM people WHERE user_id = ?${personId ? ' AND id = ?' : ''}`).bind(...(personId ? [uid, personId] : [uid])).all()).results;
  const dates = people.length ? (await env.DB.prepare('SELECT * FROM person_dates WHERE person_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(people.map((p) => p.id))).all()).results : [];
  const want = [];
  for (const p of people) {
    const first = String(p.name).split(' ')[0];
    const bd = yearlyDate(p.birthday);
    if (bd && p.bday_notify !== 0) want.push({ ref: `bday:${p.id}`, kind: 'birthday', title: `${p.name}'s birthday`, date: bd, repeat: 'yearly', nag: p.bday_remind ? 1 : 0, details: { person_id: p.id, first } });
    for (const d of dates.filter((x) => x.person_id === p.id)) {
      const dd = yearlyDate(d.date);
      if (dd) want.push({ ref: `pdate:${d.id}`, kind: 'pdate', title: `${first}: ${d.label}`, date: dd, repeat: 'yearly', nag: d.remind ? 1 : 0, details: { person_id: p.id, first, label: d.label } });
    }
    // Everyone has a catch-up task, so every talk has somewhere to go; it only has a date
    // (and comes due) when a check-in is set.
    const lastDay = p.last_contact_at ? localParts(new Date(p.last_contact_at), tz).date : null;
    const due = !p.checkin_days ? null : lastDay ? new Date(Date.UTC(+lastDay.slice(0, 4), +lastDay.slice(5, 7) - 1, +lastDay.slice(8, 10) + p.checkin_days)).toISOString().slice(0, 10) : today;
    want.push({ ref: `catchup:${p.id}`, kind: 'catchup', title: `Catch up with ${p.name}`, date: due, repeat: 'never', nag: null, details: { person_id: p.id, first, every: p.checkin_days || null } });
  }
  const stmts = want.map((w) => env.DB.prepare(`INSERT INTO tasks (user_id, kind, title, details, date, repeat, nag, nag_mode, archived, legacy_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'hourly', 0, ?, ?)
      ON CONFLICT(legacy_ref) DO UPDATE SET title = excluded.title, details = excluded.details, date = excluded.date, repeat = excluded.repeat, archived = 0,
        nag = CASE WHEN ? IS NULL THEN tasks.nag ELSE excluded.nag END`)
    .bind(uid, w.kind, w.title, JSON.stringify(w.details), w.date, w.repeat, w.nag ?? 0, w.ref, nowIso(), w.nag));
  // Anything this person (or everyone, on a full sync) no longer has is archived
  const keep = want.map((w) => w.ref);
  const scope = personId ? `AND (legacy_ref LIKE 'bday:${+personId}' OR legacy_ref LIKE 'catchup:${+personId}' OR (kind = 'pdate' AND json_extract(details, '$.person_id') = ${+personId}))` : '';
  stmts.push(env.DB.prepare(`UPDATE tasks SET archived = 1 WHERE user_id = ? AND kind IN ('birthday', 'pdate', 'catchup') ${scope}
    AND legacy_ref NOT IN (SELECT value FROM json_each(?))`).bind(uid, JSON.stringify(keep)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return want.length;
}

// ---------- Tasks ----------
const TASK_REPEATS = ['never', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'yearly', 'custom'];
function taskFields(b) {
  const out = {};
  const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v || '') ? v : null);
  if ('title' in b) out.title = String(b.title || '').trim().slice(0, 120);
  if ('kind' in b) out.kind = ['task', 'habit', 'med', 'home', 'birthday', 'pdate', 'catchup', 'credit', 'meal'].includes(b.kind) ? b.kind : 'task';
  if ('details' in b) out.details = b.details && typeof b.details === 'object' ? JSON.stringify(b.details).slice(0, 4000) : null;
  if ('date' in b) out.date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : null;
  if ('time' in b) out.time = hhmm(b.time);
  if ('repeat' in b) out.repeat = TASK_REPEATS.includes(b.repeat) ? b.repeat : 'never';
  if ('custom' in b) {
    const c = b.custom && typeof b.custom === 'object' ? b.custom : null;
    out.custom = c ? JSON.stringify({ freq: ['daily', 'weekly', 'monthly'].includes(c.freq) ? c.freq : 'daily', interval_n: Math.min(366, Math.max(1, Math.round(+c.interval_n) || 1)),
      weekdays: String(c.weekdays || '').split(',').filter((x) => /^[0-6]$/.test(x)).join(',') || null,
      month_days: String(c.month_days || '').split(',').map(Number).filter((x) => x >= 1 && x <= 31).join(',') || null,
      times: String(c.times || '').split(',').map((x) => hhmm(x)).filter(Boolean).join(',') || null,
      dose_times: c.dose_times && typeof c.dose_times === 'object' ? Object.fromEntries(Object.entries(c.dose_times).filter(([k, v]) => /^\d{1,2}$/.test(k) && hhmm(v))) : null }) : null;
  }
  if ('nag' in b) out.nag = b.nag ? 1 : 0;
  if ('nag_mode' in b) out.nag_mode = ['hourly', 'daily', 'weekly', 'monthly'].includes(b.nag_mode) ? b.nag_mode : 'hourly';
  if ('nag_time' in b) out.nag_time = hhmm(b.nag_time);
  if ('nag_dow' in b) out.nag_dow = b.nag_dow === null || b.nag_dow === '' ? null : Math.min(6, Math.max(0, Math.round(+b.nag_dow) || 0));
  if ('remind_to' in b) out.remind_to = b.remind_to === null || b.remind_to === '' ? null : Math.max(0, Math.round(+b.remind_to) || 0);
  if ('shared' in b) out.shared = b.shared ? 1 : 0;
  if ('sort' in b) out.sort = Math.round(+b.sort) || 0;
  return out;
}
const taskOut = (t) => (t ? { ...t, details: t.details ? JSON.parse(t.details) : null, custom: t.custom ? JSON.parse(t.custom) : null } : t);
async function loadTasks(env, uid) {
  const { results } = await env.DB.prepare('SELECT * FROM tasks WHERE archived = 0 AND (user_id = ? OR shared = 1) ORDER BY sort, id').bind(uid).all();
  const ids = results.map((t) => t.id);
  // (A subquery, not one ? per task: the database allows at most 100 bound values per query.)
  const logs = ids.length ? (await env.DB.prepare(`SELECT id, task_id, occ, status, amount, at, how, who FROM task_log WHERE task_id IN (SELECT id FROM tasks WHERE archived = 0 AND (user_id = ? OR shared = 1)) AND occ >= date('now', '-750 days')`).bind(uid).all()).results : [];
  return { tasks: results.map(taskOut), task_log: logs };
}

// Nag until done: hourly, daily at a time, or weekly on a day. Only for today's occurrences
// (and a one-off task whose date has passed); snoozes and quiet hours are respected.
async function sendTaskReminders(env, tz, local, quiet, now, uid) {
  const { results } = await env.DB.prepare(`SELECT * FROM tasks WHERE archived = 0 AND nag = 1 AND kind NOT IN ('task', 'home', 'credit', 'meal')
    AND ((remind_to IS NULL AND user_id = ?) OR remind_to = ? OR (remind_to = 0 AND (user_id = ? OR shared = 1)))`).bind(uid, uid, uid).all();
  if (!results.length) return [];
  const tasks = results.map(taskOut);
  const ids = tasks.map((t) => t.id);
  const done = new Set((await env.DB.prepare(`SELECT task_id, occ FROM task_log WHERE task_id IN (SELECT value FROM json_each(?)) AND occ >= ?`).bind(JSON.stringify(ids), TK.addDays(local.date, -400)).all()).results.map((l) => `${l.task_id}|${l.occ}`));
  const minutesNow = local.h * 60 + local.min;
  const dow = new Date(Date.UTC(local.y, local.m - 1, local.d)).getUTCDay();
  const sent = [];
  for (const t of tasks) {
    if (t.snooze_until && Date.parse(t.snooze_until) > now) continue;
    const occs = TK.occurrencesOn(t, local.date).map((tm) => ({ key: TK.occKey(local.date, tm), tm }));
    if ((!t.repeat || t.repeat === 'never') && t.date && t.date < local.date) occs.push({ key: TK.occKey(t.date, t.time || ''), tm: '', late: true });
    const open = occs.filter((o) => !done.has(`${t.id}|${o.key}`) && (o.late || !o.tm || minutesNow >= +o.tm.slice(0, 2) * 60 + +o.tm.slice(3)));
    if (!open.length) continue;
    let key, first = true;
    if (t.nag_mode === 'daily' || t.nag_mode === 'weekly') {
      const [h, mi] = String(t.nag_time || '09:00').split(':').map(Number);
      if (minutesNow < h * 60 + mi) continue;
      if (t.nag_mode === 'weekly' && dow !== (t.nag_dow ?? 1)) continue;
      key = `task:${t.id}:${uid}:${local.date}`;
      if (await env.DB.prepare('SELECT 1 FROM task_nags WHERE key = ?').bind(key).first()) continue;
    } else {
      if (open.every((o) => !o.tm && !o.late) && minutesNow < 9 * 60) continue; // date-only: start at 9am
      key = `task:${t.id}:${uid}:hourly`;
      const nag = await env.DB.prepare('SELECT last_at FROM task_nags WHERE key = ?').bind(key).first();
      if (nag && (now - Date.parse(nag.last_at)) / 60000 < 58) continue;
      // A timed occurrence always gets its first reminder at its time (you chose it), even in
      // quiet hours; the repeats wait until quiet hours end.
      const o0 = open[0];
      const firstForThis = o0.tm && (!nag || Date.parse(nag.last_at) < zonedToUtc(local.y, local.m, local.d, +o0.tm.slice(0, 2), +o0.tm.slice(3), tz).getTime());
      if (quiet && !firstForThis) continue;
      first = !o0.tm || firstForThis;
    }
    const o = open[0];
    const when = o.late ? `was due ${o.key.slice(5, 10).replace('-', '/')}` : o.tm ? `scheduled ${fmtTime(zonedToUtc(local.y, local.m, local.d, +o.tm.slice(0, 2), +o.tm.slice(3), tz).toISOString(), tz)}` : 'today';
    const dose = t.details && t.details.dose ? ` (${t.details.dose})` : '';
    const first1 = (t.details && t.details.first) || t.title;
    const title = t.kind === 'med' ? `${first ? 'Time for' : 'Still need to take'} ${t.title}${dose}`
      : t.kind === 'birthday' ? `Wish ${first1} a happy birthday` : t.kind === 'catchup' ? `Reach out to ${first1}` : t.title;
    const ok = await push(env, { to: uid, tag: `task-${t.id}`, title, message: `${{ habit: 'Habit', med: 'Medication', birthday: 'Birthday', pdate: 'Important date', catchup: 'Catch up' }[t.kind] || 'Task'} · ${when}`, priority: 4 });
    if (ok) {
      await env.DB.prepare('INSERT INTO task_nags (key, last_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at, count = task_nags.count + 1').bind(key, now.toISOString()).run();
      sent.push(key);
    }
  }
  return sent;
}

// ---------- Rewards reminders ----------
// For each person's own cards:
//  - one morning notification (at their briefing hour or later) listing credits that run out within 3 days
//  - a "keep or cancel?" task 30 days before an annual fee renews (daily nag until done)
//  - a "use it" task 30 days before a certificate expires (daily nag until done)
async function sendRewardsReminders(env, tz, local, now, uid) {
  const rw = await loadRewards(env);
  const mine = rw.cards.filter((c) => c.owner === uid);
  if (!mine.length) return [];
  const ctx = { ...rw, today: local.date };
  const sent = [];
  const s = await getSettings(env, uid);
  const key = `rw:${uid}:${local.date}`;
  if (local.h >= Math.max(8, +s.briefing_hour || 8) && !(await env.DB.prepare('SELECT 1 FROM home_nags WHERE key = ?').bind(key).first())) {
    // Each credit's task says whether to remind and how many days before it ends (default 3)
    const prefs = Object.fromEntries((await env.DB.prepare("SELECT legacy_ref, nag, details FROM tasks WHERE kind = 'credit' AND user_id = ? AND archived = 0").bind(uid).all()).results
      .map((r) => [r.legacy_ref, { nag: r.nag, lead: (JSON.parse(r.details || '{}').lead) || 3 }]));
    const pref = (x) => prefs[`credit:${x.c.id}:${x.b.id}`] || { nag: 1, lead: 3 };
    const soon = RW.openCredits(ctx, mine).filter((x) => x.dated && pref(x).nag && x.days <= pref(x).lead).sort((a, z) => a.days - z.days || z.left - a.left);
    if (soon.length) {
      const total = soon.reduce((a, x) => a + x.left, 0);
      const ok = await push(env, { to: uid, tag: 'rw-credits', priority: 4, click: `${env.PUBLIC_URL}/#rewards`,
        title: `${soon.length} credit${soon.length > 1 ? 's' : ''} ending soon · ${RW.money(total)} left`,
        message: soon.slice(0, 4).map((x) => `${x.b.name} ${RW.money(x.left)} (${x.c.name})`).join(', ') + (soon.length > 4 ? ` +${soon.length - 4} more` : '') });
      if (ok) sent.push(key);
    }
    await env.DB.prepare('INSERT INTO home_nags (key, last_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').bind(key, now.toISOString()).run();
  }
  const nine = zonedToUtc(local.y, local.m, local.d, 9, 0, tz).toISOString();
  const stmts = [];
  for (const c of mine) {
    const fee = RW.nextFee(ctx, c);
    if (fee && RW.daysLeft(ctx, fee) <= 31) {
      const when = `${RW.MONTHS[fee.getMonth()]} ${fee.getDate()}`;
      await upsertTodo(env, `x:rwfee:${c.id}:${RW.ymd(fee)}`, { title: `Keep or cancel ${c.name}? ${RW.money(c.fee)} fee on ${when}`,
        notes: `Value back this year: ${RW.money(RW.metrics(ctx, c, local.y).used)}. Downgrade or cancel before ${when} if it's not worth it.`, due_at: nine, nag: 'daily', source: 'rewards' }, uid, { onlyCreate: true });
    }
    for (const { b, x, days } of RW.certList(ctx, [c])) {
      if (!x.expires || x.virtual || days > 30 || days < 0) continue;
      await upsertTodo(env, `x:rwcert:${c.id}:${x.id}`, { title: `Use your ${b.name} (${c.name})`, notes: `Expires ${x.expires}. Mark it used in Rewards once it's booked.`,
        area: 'travel', due_at: nine, nag: 'daily', source: 'rewards' }, uid, { onlyCreate: true });
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return sent;
}

// ---------- Rewards helpers ----------
async function loadRewards(env) {
  const [cards, logs, pts, cfg] = await Promise.all([
    env.DB.prepare('SELECT * FROM rw_cards').all(),
    env.DB.prepare("SELECT id, card_id, benefit_id, year, period, kind, amount, date, note FROM rw_logs WHERE year >= CAST(strftime('%Y', 'now') AS INTEGER) - 1").all(),
    env.DB.prepare('SELECT * FROM rw_points').all(),
    env.DB.prepare('SELECT * FROM rw_config').all(),
  ]).catch(() => [{ results: [] }, { results: [] }, { results: [] }, { results: [] }]);
  const config = Object.fromEntries(cfg.results.map((r) => [r.key, JSON.parse(r.value)]));
  return {
    cards: cards.results.map((r) => ({ ...JSON.parse(r.data), id: r.id, owner: r.owner })),
    logs: logs.results,
    points: Object.fromEntries(pts.results.map((r) => [r.user_id, { balances: JSON.parse(r.balances), updated: JSON.parse(r.updated) }])),
    config,
  };
}
async function rwCard(env, id) {
  const r = await env.DB.prepare('SELECT * FROM rw_cards WHERE id = ?').bind(String(id || '')).first();
  return r ? { ...JSON.parse(r.data), id: r.id, owner: r.owner } : null;
}

// Once a month: a "Download a Life backup" task (done automatically when you download one).
async function ensureBackupReminder(env, tz, local, uid, s) {
  if (s.last_backup_at && Date.now() - Date.parse(s.last_backup_at) < 30 * 86400000) return;
  const due = zonedToUtc(local.y, local.m, local.d, 9, 0, tz).toISOString();
  const ref = `x:backup:${uid}`;
  const prev = await todoRow(env, 'legacy_ref = ?', ref);
  const open = prev && TK.todoOcc(prev, await todoLogs(env, prev.id), local.date);
  if (prev && open && !open.log && !prev.archived) return; // still on the list
  await upsertTodo(env, ref, { title: 'Download a Life backup', notes: 'Settings › Backup › Download a backup. Save it to Files or iCloud Drive.', due_at: due, nag: 'once', source: 'backup' }, uid, { reopen: true });
}

// ---------- Home reminders ----------
// Only while a task is on the Home "To do" list (due this month or overdue; not done or snoozed).
//   hourly: from its due day on, every hour outside quiet hours
//   daily / weekly / monthly: once at the time you picked (on the weekday / date you picked)
async function sendHomeReminders(env, tz, local, quiet, now, uid) {
  const home = await loadHome(env);
  const tasks = home.tasks.filter((t) => t.remind !== 'none' && (t.remind_to === uid || t.remind_to === 0));
  if (!tasks.length) return [];
  const last = home.last;
  const window = daysToMonthEnd(local.date);
  const minutesNow = local.h * 60 + local.min;
  const sent = [];
  for (const t of tasks) {
    const d = homeDue(t, last[t.id] || null, local.date);
    if (d.completed || d.snoozed || d.k > window) continue;
    let key;
    if (t.remind === 'hourly') {
      if (d.k > 0 || quiet) continue;
      key = `home:${t.id}:${uid}:hourly`;
      const nag = await env.DB.prepare('SELECT last_at FROM home_nags WHERE key = ?').bind(key).first();
      if (nag && (now - Date.parse(nag.last_at)) / 60000 < 58) continue;
    } else {
      const [h, m] = String(t.remind_time || '09:00').split(':').map(Number);
      if (minutesNow < h * 60 + m) continue;
      const dow = new Date(Date.UTC(local.y, local.m - 1, local.d)).getUTCDay();
      const lastDay = new Date(Date.UTC(local.y, local.m, 0)).getUTCDate();
      if (t.remind === 'weekly' && dow !== (t.remind_dow ?? 1)) continue;
      if (t.remind === 'monthly' && local.d !== Math.min(t.remind_dom || 1, lastDay)) continue;
      key = `home:${t.id}:${uid}:${local.date}`;
      if (await env.DB.prepare('SELECT 1 FROM home_nags WHERE key = ?').bind(key).first()) continue;
    }
    const when = d.k < 0 ? `overdue ${-d.k} day${d.k === -1 ? '' : 's'}` : d.k === 0 ? 'due today' : d.k === 1 ? 'due tomorrow' : `due in ${d.k} days`;
    const ok = await push(env, { to: uid, tag: `home-${t.id}`, title: t.name, message: [t.room, when].filter(Boolean).join(' · '),
      priority: t.remind === 'hourly' || d.k < 0 ? 4 : 3, click: `${env.PUBLIC_URL}/#home` });
    if (ok) {
      await env.DB.prepare(`INSERT INTO home_nags (key, last_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at, count = home_nags.count + 1`)
        .bind(key, now.toISOString()).run();
      sent.push(key);
    }
  }
  await env.DB.prepare('DELETE FROM home_nags WHERE last_at < ?').bind(new Date(now.getTime() - 40 * 86400000).toISOString()).run();
  return sent;
}

// ---------- close circle: gift nudges and important dates ----------

async function ensurePeopleReminders(env, tz, local, uid = 1) {
  const due = zonedToUtc(local.y, local.m, local.d, 9, 0, tz).toISOString();
  const stmts = [];
  // Two weeks before a family / close friend's birthday: "Pick a gift", daily until done.
  const { results: circle } = await env.DB.prepare("SELECT id, name, birthday FROM people WHERE user_id = ? AND circle IN ('family','close') AND birthday IS NOT NULL").bind(uid).all();
  for (const p of circle) {
    const d = daysUntilBirthday(p.birthday, local);
    if (d === null || d < 3 || d > 14) continue;
    const year = local.y + (Number(p.birthday.slice(-5, -3)) < local.m ? 1 : 0);
    const ideas = (await env.DB.prepare("SELECT idea FROM gifts WHERE person_id = ? AND status = 'idea' ORDER BY created_at DESC LIMIT 5").bind(p.id).all()).results.map((g) => g.idea);
    await upsertTodo(env, `x:gift:${p.id}:${year}`, { title: `Pick a gift for ${p.name.split(' ')[0]}`, area: 'people', person_id: p.id, source: 'gift', nag: 'daily', due_at: due,
      notes: ideas.length ? `Ideas: ${ideas.join(' · ')}` : 'No gift ideas saved yet. Add some on their page.' }, uid, { onlyCreate: true });
  }
  // (Important dates are tasks now.)
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------- evening wrap-up ----------

async function sendWrapUp(env, tz, local, uid = 1) {
  const dayStart = zonedToUtc(local.y, local.m, local.d, 0, 0, tz).toISOString();
  const dayEnd = zonedToUtc(local.y, local.m, local.d, 23, 59, tz).toISOString();
  const [done, left, habits, habitDone] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM task_log l JOIN tasks t ON t.id = l.task_id WHERE t.kind = 'task' AND l.by_user = ? AND l.status = 'done' AND l.at >= ?").bind(uid, dayStart).first(),
    openTodos(env, uid, local, tz, 'visible').then((list) => ({ n: list.filter((x) => x.t.user_id === uid && !(x.t.details && x.t.details.note) && x.due <= new Date(dayEnd)).length })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND kind = 'habit' AND archived = 0").bind(uid).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM task_log l JOIN tasks t ON t.id = l.task_id WHERE t.user_id = ? AND t.kind = 'habit' AND l.occ = ? AND l.status IN ('done','partial')").bind(uid, local.date).first(),
  ]);
  const lines = [`${done.n} done today`];
  if (left.n) lines.push(`${left.n} still open: tap to move ${left.n === 1 ? 'it' : 'them'} to tomorrow`);
  else lines.push('Nothing left over. Nice.');
  if (habits.n) lines.push(`Habits: ${habitDone.n} of ${habits.n}`);
  await push(env, { to: uid, title: 'Evening wrap-up', message: lines.join('\n'), priority: 2 });
}

// Nights this week (Sunday through Saturday, from today on) with no meal plan
async function unplannedNights(env, local) {
  const days = [];
  const dow = new Date(Date.UTC(local.y, local.m - 1, local.d)).getUTCDay();
  for (let i = 0; i <= 6 - dow; i++) days.push(new Date(Date.UTC(local.y, local.m - 1, local.d + i)).toISOString().slice(0, 10));
  const results = await loadMeals(env, `'${days[0]}'`, `'${days[days.length - 1]}'`);
  return days.length - results.length;
}

// "Home: 1 overdue · 3 this week" for the morning briefing
async function homeSummary(env, date) {
  const home = await loadHome(env);
  const tasks = { results: home.tasks }, last = home.last;
  let over = 0, week = 0;
  for (const t of tasks.results) { const d = homeDue(t, last[t.id] || null, date); if (d.completed) continue; if (d.k < 0) over++; else if (d.k <= 6) week++; }
  if (!over && !week) return null;
  return `Home: ${[over ? `${over} overdue` : '', week ? `${week} this week` : ''].filter(Boolean).join(' · ')}`;
}

async function sendBriefing(env, tz, local, uid = 1) {
  const dayStart = zonedToUtc(local.y, local.m, local.d, 0, 0, tz).toISOString();
  const dayEnd = zonedToUtc(local.y, local.m, local.d, 23, 59, tz).toISOString();
  const [events, dueToday, nagging, people] = await Promise.all([
    visibleEvents(env, uid, dayStart, dayEnd).then((results) => ({ results })),
    openTodos(env, uid, local, tz, 'visible').then((list) => ({ n: list.filter((x) => x.o.date === local.date).length })),
    openTodos(env, uid, local, tz).then((list) => ({ n: list.filter((x) => x.t.nag && x.o.date < local.date).length })),
    env.DB.prepare('SELECT * FROM people WHERE user_id = ? AND (birthday IS NOT NULL OR checkin_days IS NOT NULL)').bind(uid).all(),
  ]);
  const lines = [];
  const wl = weatherLine(await getWeather(env).catch(() => null));
  if (wl) lines.push(wl);
  const [prefs, s] = await Promise.all([loadEventPrefs(env, uid), getSettings(env, uid)]);
  const ev = events.results.filter((e) => !eventPref(e, prefs, s).hidden && !birthdayEventPerson(e.title, people.results));
  if (ev.length) {
    const timed = ev.find((e) => !e.all_day);
    lines.push(`${ev.length} event${ev.length > 1 ? 's' : ''}${timed ? `, first at ${fmtTime(timed.start_at, tz)}` : ''}`);
  } else lines.push('Nothing on the calendar');
  if (dueToday.n) lines.push(`${dueToday.n} task${dueToday.n > 1 ? 's' : ''} due today`);
  const dinner = (await loadMeals(env, `'${local.date}'`, `'${local.date}'`))[0] || null;
  if (dinner) lines.push(dinner.kind === 'cook' ? `Dinner: ${dinner.title}` : dinner.kind === 'out' ? `Dinner: out${dinner.title ? ` (${dinner.title})` : ''}` : dinner.kind === 'leftovers' ? 'Dinner: leftovers' : 'No dinner plan needed tonight');
  const homeLine = await homeSummary(env, local.date);
  if (homeLine) lines.push(homeLine);
  const rw = await loadRewards(env);
  const myCards = rw.cards.filter((c) => c.owner === uid);
  if (myCards.length) {
    const open = RW.openCredits({ ...rw, today: local.date }, myCards).filter((x) => x.dated && x.days <= 7);
    if (open.length) lines.push(`Credits: ${RW.money(open.reduce((a, x) => a + x.left, 0))} left this week (${open.length})`);
  }
  for (const p of people.results) {
    if (p.bday_notify === 0) continue; // you chose not to hear about this birthday
    const d = daysUntilBirthday(p.birthday, local);
    if (d === 0) lines.push(`🎂 ${p.name}'s birthday is today`);
    else if (d !== null && d <= 7 && (p.circle === 'family' || p.circle === 'close')) lines.push(`${p.name}'s birthday in ${d} day${d > 1 ? 's' : ''}`);
  }
  const overdue = people.results
    .filter((p) => p.checkin_days)
    .map((p) => ({ p, days: p.last_contact_at ? Math.floor((Date.now() - Date.parse(p.last_contact_at)) / 86400000) : null }))
    .filter((x) => x.days === null || x.days >= x.p.checkin_days)
    .sort((a, b) => (b.days ?? 9999) - (a.days ?? 9999));
  if (overdue.length) lines.push(`Reach out: ${overdue.slice(0, 2).map((x) => x.p.name).join(', ')}${overdue.length > 2 ? ` +${overdue.length - 2}` : ''}`);
  if (nagging.n) lines.push(`${nagging.n} still nagging`);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date());
  // Priority 4 is 'time-sensitive' on iPhone, so it gets through Focus like the nags do.
  const ok = await push(env, { to: uid, title: `Good morning: your ${weekday}`, message: lines.join('\n'), priority: 4, tags: ['sunrise'] });
  console.log('briefing', ok ? 'sent' : `FAILED: ${lastPushError}`, `(${lines.length} lines)`);
  return ok;
}
