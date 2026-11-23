// Life Dashboard — Cloudflare Worker: JSON API, notification actions, and the
// 15-minute cron that sends nags and the morning briefing through ntfy.

import { parseCapture } from '../public/parse.js';
import { parseVcards, birthdayEventPerson } from '../public/vcard.js';
import { slotsOn } from '../public/meds.js';
import { homeDue, daysToMonthEnd, FREQS as HOME_FREQS } from '../public/home.js';
import { sendWebPush } from './webpush.js';
import * as RW from '../public/rewards.js';

const ITEM_FIELDS = ['title', 'notes', 'area', 'kind', 'due_at', 'nag', 'repeat_days', 'top3', 'person_id', 'status', 'snooze_until', 'shared'];
const PERSON_FIELDS = ['name', 'birthday', 'phone', 'email', 'notes', 'checkin_days', 'last_contact_at', 'last_contact_how', 'bday_remind', 'bday_notify', 'circle'];

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
const NAG_GAP_MIN = { '15m': 14, hourly: 58, daily: 1380 };

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
    if (path.startsWith('/api/') || path.startsWith('/a/')) out.headers.set('Cache-Control', 'no-store');
    return out;
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

async function route(req, env, ctx) {
  const url = new URL(req.url);
  try {
    const guarded = url.pathname.startsWith('/api/') || url.pathname.startsWith('/a/');
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    if (guarded && (await recentFailures(env, ip)) >= MAX_FAILURES) {
      return json({ error: `Too many wrong attempts. Try again in ${FAILURE_WINDOW_MIN} minutes.` }, 429);
    }
    if (url.pathname.startsWith('/a/')) return await handleAction(req, env, url, ip);
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
  return (await env.DB.prepare('SELECT id, name, ntfy_topic FROM users ORDER BY id').all()).results;
}
// Is this row yours? Tasks also count when they're shared.
async function owns(env, table, id, uid) {
  const sql = {
    items: 'SELECT 1 AS ok FROM items WHERE id = ? AND (user_id = ? OR shared = 1)',
    people: 'SELECT 1 AS ok FROM people WHERE id = ? AND user_id = ?',
    habits: 'SELECT 1 AS ok FROM habits WHERE id = ? AND user_id = ?',
    meds: 'SELECT 1 AS ok FROM meds WHERE id = ? AND user_id = ?',
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

async function sign(env, text) {
  const secret = env.LINK_KEY || env.APP_TOKEN;
  if (!secret) throw new Error('LINK_KEY is not set');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
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

// ---------- item state changes (shared by API and notification buttons) ----------

async function completeItem(env, id) {
  const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!item) return null;
  if (item.repeat_days) {
    const step = item.repeat_days * 86400000;
    let due = item.due_at ? Date.parse(item.due_at) : Date.now();
    do due += step; while (due <= Date.now());
    return updateRow(env, 'items', id, { due_at: new Date(due).toISOString(), snooze_until: null, last_notified_at: null, notify_count: 0, done_at: nowIso() });
  }
  return updateRow(env, 'items', id, { status: 'done', done_at: nowIso(), snooze_until: null });
}

async function snoozeItem(env, id, minutes) {
  return updateRow(env, 'items', id, { snooze_until: new Date(Date.now() + minutes * 60000).toISOString() });
}

async function snoozeTomorrow(env, id) {
  const tz = env.TZ || 'America/Chicago';
  const p = localParts(new Date(Date.now() + 86400000), tz);
  return updateRow(env, 'items', id, { snooze_until: zonedToUtc(p.y, p.m, p.d, 9, 0, tz).toISOString() });
}

// ---------- notification action links (Done / Snooze buttons) ----------

async function handleAction(req, env, url, ip) {
  const mm = /^\/a\/med\/(\d+)\/(\d{4}-\d{2}-\d{2})\/(\d{4})\/(taken|skip)$/.exec(url.pathname);
  if (mm) {
    const [, id, date, hhmm, act] = mm;
    if (url.searchParams.get('sig') !== (await sign(env, `med:${id}:${date}:${hhmm}:${act}`))) { await recordFailure(env, ip); return new Response('Bad link', { status: 403 }); }
    const r = await logMed(env, +id, date, `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`, act === 'skip' ? 'skipped' : 'taken');
    return new Response(r.already ? `Already logged at ${r.already}.` : act === 'skip' ? 'Skipped.' : 'Logged as taken.', { headers: { 'content-type': 'text/plain' } });
  }
  const m = /^\/a\/(\d+)\/(done|snooze|tomorrow)$/.exec(url.pathname);
  if (!m) return new Response('Not found', { status: 404 });
  const [, id, action] = m;
  if (url.searchParams.get('sig') !== (await sign(env, `${id}:${action}`))) {
    await recordFailure(env, ip);
    return new Response('Bad link', { status: 403 });
  }
  if (action === 'done') await completeItem(env, +id);
  if (action === 'snooze') await snoozeItem(env, +id, 60);
  if (action === 'tomorrow') await snoozeTomorrow(env, +id);
  const msg = { done: 'Marked done.', snooze: 'Snoozed for 1 hour.', tomorrow: 'Snoozed until tomorrow 9am.' }[action];
  return new Response(msg, { headers: { 'content-type': 'text/plain' } });
}

// ---------- API ----------

async function handleApi(req, env, url, ctx, uid) {
  const path = url.pathname.replace(/\/$/, '');
  const method = req.method;
  const body = ['POST', 'PATCH', 'PUT'].includes(method) && (req.headers.get('content-type') || '').includes('json') ? await req.json() : null;
  let m;

  if (path === '/api/state' && method === 'GET') {
    const [items, people, events, trips, documents, habits, habitLogs, eventPrefs, gifts, personDates, meds, medLogs, homeTasks, homeLog, meals, mealTitles, settings] = await Promise.all([
      env.DB.prepare("SELECT * FROM items WHERE (user_id = ? OR shared = 1) AND (status = 'open' OR done_at > datetime('now', '-1 day')) ORDER BY due_at IS NULL, due_at").bind(uid).all(),
      env.DB.prepare('SELECT * FROM people WHERE user_id = ? ORDER BY name COLLATE NOCASE').bind(uid).all(),
      visibleEvents(env, uid).then((results) => ({ results })),
      env.DB.prepare("SELECT * FROM trips WHERE COALESCE(end_date, start_date) >= date('now', '-1 day') ORDER BY start_date").all(),
      env.DB.prepare('SELECT * FROM documents WHERE user_id = ? ORDER BY expires_on').bind(uid).all(),
      env.DB.prepare('SELECT * FROM habits WHERE user_id = ? AND archived = 0 ORDER BY sort, id').bind(uid).all(),
      env.DB.prepare("SELECT l.habit_id, l.date FROM habit_logs l JOIN habits h ON h.id = l.habit_id WHERE h.user_id = ? AND l.date >= date('now', '-120 days')").bind(uid).all(),
      eventPrefRows(env, uid).then((results) => ({ results })),
      env.DB.prepare("SELECT g.* FROM gifts g JOIN people p ON p.id = g.person_id WHERE p.user_id = ? AND (g.status != 'given' OR g.created_at > date('now', '-400 days')) ORDER BY g.created_at DESC").bind(uid).all(),
      env.DB.prepare('SELECT d.* FROM person_dates d JOIN people p ON p.id = d.person_id WHERE p.user_id = ?').bind(uid).all(),
      env.DB.prepare('SELECT * FROM meds WHERE user_id = ? AND active = 1 ORDER BY id').bind(uid).all(),
      env.DB.prepare("SELECT l.* FROM med_logs l JOIN meds m ON m.id = l.med_id WHERE m.user_id = ? AND l.date >= date('now', '-35 days')").bind(uid).all(),
      env.DB.prepare('SELECT * FROM home_tasks WHERE hidden = 0').all(),
      env.DB.prepare('SELECT * FROM home_log ORDER BY date DESC').all(),
      env.DB.prepare("SELECT * FROM meals WHERE date >= date('now', '-8 days') AND date <= date('now', '+30 days')").all(),
      env.DB.prepare("SELECT title, link, COUNT(*) AS n, MAX(date) AS last FROM meals WHERE kind = 'cook' AND title IS NOT NULL GROUP BY lower(title) ORDER BY last DESC LIMIT 40").all(),
      getSettings(env, uid),
    ]);
    delete settings.weather_cache;
    const users = await listUsers(env);
    const meRow = users.find((u) => u.id === uid) || { id: uid };
    const me = { id: uid, name: meRow.name, ntfy_topic: meRow.ntfy_topic || (uid === 1 ? env.NTFY_TOPIC || '' : '') };
    const prefs = Object.fromEntries(eventPrefs.results.map((r) => [r.key, r]));
    const evs = events.results.map((e) => ({ ...e, ...eventKeys(e), pref: eventPref(e, prefs, settings) }));
    return json({ items: items.results, people: people.results, events: evs, event_prefs: eventPrefs.results, trips: trips.results, documents: documents.results,
      habits: habits.results, habit_logs: habitLogs.results, gifts: gifts.results, person_dates: personDates.results, meds: meds.results, med_logs: medLogs.results, home_tasks: homeTasks.results, home_log: homeLog.results, meals: meals.results, meal_titles: mealTitles.results, settings, tz: env.TZ || 'America/Chicago', auth: env.ACCESS_AUD ? 'access' : 'password',
      me, users: users.map((u) => ({ id: u.id, name: u.name })), rewards: await loadRewards(env),
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

  // Items
  if (path === '/api/items' && method === 'POST') {
    const data = pick(body, ITEM_FIELDS);
    if (!data.title) return json({ error: 'title required' }, 400);
    data.shared = data.shared ? 1 : 0;
    return json(await insertRow(env, 'items', { ...data, user_id: uid }), 201);
  }
  if ((m = /^\/api\/items\/(\d+)(\/done|\/snooze)?$/.exec(path)) && !(await owns(env, 'items', +m[1], uid))) return notYours();
  if ((m = /^\/api\/items\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') {
      const data = pick(body, ITEM_FIELDS);
      if ('due_at' in data || 'nag' in data) Object.assign(data, { notify_count: 0, last_notified_at: null });
      if (data.status === 'open') data.done_at = null;
      if ('shared' in data) data.shared = data.shared ? 1 : 0;
      return json(await updateRow(env, 'items', +m[1], data));
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(+m[1]).run();
      return json({ ok: true });
    }
  }
  if ((m = /^\/api\/items\/(\d+)\/done$/.exec(path)) && method === 'POST') return json(await completeItem(env, +m[1]));
  if ((m = /^\/api\/items\/(\d+)\/snooze$/.exec(path)) && method === 'POST') {
    const until = body && Date.parse(body.until);
    if (until && until > Date.now()) return json(await updateRow(env, 'items', +m[1], { snooze_until: new Date(until).toISOString() }));
    return json(await snoozeItem(env, +m[1], +(body && body.minutes) || 60));
  }

  // People
  if (path === '/api/people' && method === 'POST') {
    const data = pick(body, PERSON_FIELDS);
    if (!data.name) return json({ error: 'name required' }, 400);
    return json(await insertRow(env, 'people', { ...data, user_id: uid }), 201);
  }
  if ((m = /^\/api\/people\/(\d+)(\/contact)?$/.exec(path)) && !(await owns(env, 'people', +m[1], uid))) return notYours();
  if ((m = /^\/api\/people\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') return json(await updateRow(env, 'people', +m[1], pick(body, PERSON_FIELDS)));
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM people WHERE id = ?').bind(+m[1]).run();
      return json({ ok: true });
    }
  }
  if ((m = /^\/api\/people\/(\d+)\/contact$/.exec(path)) && method === 'POST') {
    const at = nowIso();
    const how = (body && body.how) || 'talked';
    await env.DB.prepare('INSERT INTO contact_log (person_id, how, at) VALUES (?, ?, ?)').bind(+m[1], how, at).run();
    return json(await updateRow(env, 'people', +m[1], { last_contact_at: at, last_contact_how: how }));
  }

  // Quick capture from Siri / Apple Watch: plain text in, a spoken-friendly summary out.
  if (path === '/api/capture' && method === 'POST') {
    const text = body ? String(body.text || '') : await req.text();
    return captureText(env, text, uid);
  }

  // Weather (US National Weather Service; cached for an hour)
  if (path === '/api/weather' && method === 'GET') return json(await getWeather(env));

  // Habits
  if (path === '/api/habits' && method === 'POST') {
    const name = String((body && body.name) || '').trim().slice(0, 40);
    if (!name) return json({ error: 'name required' }, 400);
    const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM habits WHERE user_id = ?').bind(uid).first();
    return json(await insertRow(env, 'habits', { name, sort: max.s + 1, user_id: uid }), 201);
  }
  if ((m = /^\/api\/habits\/(\d+)(\/toggle)?$/.exec(path)) && !(await owns(env, 'habits', +m[1], uid))) return notYours();
  if ((m = /^\/api\/habits\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') return json(await updateRow(env, 'habits', +m[1], pick(body, ['name', 'archived', 'sort'])));
    if (method === 'DELETE') {
      await env.DB.batch([env.DB.prepare('DELETE FROM habit_logs WHERE habit_id = ?').bind(+m[1]), env.DB.prepare('DELETE FROM habits WHERE id = ?').bind(+m[1])]);
      return json({ ok: true });
    }
  }
  if ((m = /^\/api\/habits\/(\d+)\/toggle$/.exec(path)) && method === 'POST') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body && body.date) ? body.date : localParts(new Date(), env.TZ || 'America/Chicago').date;
    const had = await env.DB.prepare('DELETE FROM habit_logs WHERE habit_id = ? AND date = ? RETURNING habit_id').bind(+m[1], date).first();
    if (!had) await env.DB.prepare('INSERT INTO habit_logs (habit_id, date) VALUES (?, ?)').bind(+m[1], date).run();
    return json({ ok: true, done: !had });
  }

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
    return json(await insertRow(env, 'person_dates', { person_id: +body.person_id, label: String(body.label || 'Date').slice(0, 60), date: d, remind: body.remind ? 1 : 0 }), 201);
  }
  if ((m = /^\/api\/person-dates\/(\d+)$/.exec(path)) && !(await owns(env, 'person_dates', +m[1], uid))) return notYours();
  if ((m = /^\/api\/person-dates\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') return json(await updateRow(env, 'person_dates', +m[1], pick(body, ['label', 'date', 'remind'])));
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM person_dates WHERE id = ?').bind(+m[1]).run(); return json({ ok: true }); }
  }

  // Medications
  const medTimes = (t) => String(t || '').split(/[,\s]+/).map((x) => x.trim()).filter((x) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(x))
    .map((x) => x.padStart(5, '0')).sort().slice(0, 8).join(',');
  // Schedule: daily / weekly (days) / monthly (day), every N
  const medSchedule = (b) => {
    const out = {};
    if ('freq' in b) out.freq = ['daily', 'weekly', 'monthly'].includes(b.freq) ? b.freq : 'daily';
    if ('interval_n' in b) out.interval_n = Math.min(52, Math.max(1, Math.round(+b.interval_n) || 1));
    if ('weekdays' in b) out.weekdays = String(b.weekdays || '').split(',').map((x) => x.trim()).filter((x) => /^[0-6]$/.test(x)).filter((x, i, a) => a.indexOf(x) === i).sort().join(',') || null;
    if ('month_day' in b) out.month_day = b.month_day ? Math.min(31, Math.max(1, Math.round(+b.month_day))) : null;
    if ('start_date' in b) out.start_date = /^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '') ? b.start_date : null;
    if ('month_days' in b) out.month_days = String(b.month_days || '').split(',').map((x) => Math.round(+x)).filter((x) => x >= 1 && x <= 31)
      .filter((x, i, a) => a.indexOf(x) === i).sort((x, y) => x - y).join(',') || null;
    // Per-day dose times: {"1":"08:00"} keyed by weekday (0-6) or date (1-31)
    if ('dose_times' in b) {
      const src = b.dose_times && typeof b.dose_times === 'object' ? b.dose_times : {};
      const clean = {};
      for (const [k, v] of Object.entries(src)) if (/^\d{1,2}$/.test(k) && +k <= 31 && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) clean[+k] = v;
      out.dose_times = Object.keys(clean).length ? JSON.stringify(clean) : null;
    }
    if ('remind' in b) out.remind = ['15m', 'hourly', 'once', 'none'].includes(b.remind) ? b.remind : 'hourly';
    return out;
  };
  if (path === '/api/meds' && method === 'POST') {
    const name = String((body && body.name) || '').trim().slice(0, 80);
    const times = medTimes(body && body.times);
    if (!name || !times) return json({ error: 'name and at least one time (like 08:00) required' }, 400);
    return json(await insertRow(env, 'meds', { name, dose: body.dose ? String(body.dose).slice(0, 60) : null, times, notes: body.notes ? String(body.notes).slice(0, 300) : null, active: 1, created_at: nowIso(), user_id: uid,
      start_date: localParts(new Date(), env.TZ || 'America/Chicago').date, ...medSchedule(body) }), 201);
  }
  if ((m = /^\/api\/meds\/(\d+)(\/log)?$/.exec(path)) && !(await owns(env, 'meds', +m[1], uid))) return notYours();
  if ((m = /^\/api\/meds\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') {
      const data = { ...pick(body, ['name', 'dose', 'notes', 'active']), ...medSchedule(body) };
      if ('times' in body) { data.times = medTimes(body.times); if (!data.times) return json({ error: 'at least one time required' }, 400); }
      return json(await updateRow(env, 'meds', +m[1], data));
    }
    if (method === 'DELETE') { await env.DB.prepare('UPDATE meds SET active = 0 WHERE id = ?').bind(+m[1]).run(); return json({ ok: true }); }
  }
  if ((m = /^\/api\/meds\/(\d+)\/log$/.exec(path)) && method === 'POST') {
    return json(await logMed(env, +m[1], body && body.date, body && body.slot, (body && body.status) || 'taken'));
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
  if (path === '/api/home/tasks' && method === 'POST') {
    try { return json(await insertRow(env, 'home_tasks', { freq: 'Annual', months: '*', ...homeFields(body || {}, true) }), 201); } catch (e) { return json({ error: e.message }, 400); }
  }
  if ((m = /^\/api\/home\/tasks\/(\d+)$/.exec(path)) && method === 'PATCH') return json(await updateRow(env, 'home_tasks', +m[1], homeFields(body || {})));
  if ((m = /^\/api\/home\/tasks\/(\d+)\/log$/.exec(path)) && method === 'POST') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body && body.date) ? body.date : localParts(new Date(), env.TZ || 'America/Chicago').date;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO home_log (task_id, date, skipped) VALUES (?, ?, ?) ON CONFLICT(task_id, date) DO UPDATE SET skipped = excluded.skipped').bind(+m[1], date, body && body.skipped ? 1 : 0),
      env.DB.prepare('UPDATE home_tasks SET snooze_until = NULL WHERE id = ?').bind(+m[1]),
    ]);
    return json({ ok: true });
  }
  if ((m = /^\/api\/home\/tasks\/(\d+)\/log$/.exec(path)) && method === 'DELETE') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date required' }, 400);
    await env.DB.prepare('DELETE FROM home_log WHERE task_id = ? AND date = ?').bind(+m[1], date).run();
    return json({ ok: true });
  }
  if ((m = /^\/api\/home\/log\/(\d+)$/.exec(path)) && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM home_log WHERE id = ?').bind(+m[1]).run();
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

  // Meals: one dinner plan per day
  if ((m = /^\/api\/meals\/(\d{4}-\d{2}-\d{2})$/.exec(path))) {
    if (method === 'PUT') {
      const kind = ['cook', 'out', 'leftovers', 'skip'].includes(body && body.kind) ? body.kind : 'cook';
      const title = body && body.title ? String(body.title).trim().slice(0, 120) : null;
      if (kind === 'cook' && !title) return json({ error: 'What are you making?' }, 400);
      await env.DB.prepare(`INSERT INTO meals (date, title, kind, link, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET title = excluded.title, kind = excluded.kind, link = excluded.link, notes = excluded.notes, updated_at = excluded.updated_at`)
        .bind(m[1], title, kind, body.link ? String(body.link).slice(0, 500) : null, body.notes ? String(body.notes).slice(0, 500) : null, nowIso()).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM meals WHERE date = ?').bind(m[1]).run(); return json({ ok: true }); }
  }
  // "We already ate": hides tonight's dinner from Today early
  if ((m = /^\/api\/meals\/(\d{4}-\d{2}-\d{2})\/eaten$/.exec(path)) && method === 'POST') {
    await env.DB.prepare('UPDATE meals SET eaten = ? WHERE date = ?').bind(body && body.eaten === 0 ? 0 : 1, m[1]).run();
    return json({ ok: true });
  }

  // Evening wrap-up: move leftovers to tomorrow
  if (path === '/api/wrap/move' && method === 'POST') {
    const ids = ((body && body.ids) || []).map(Number).filter(Boolean).slice(0, 200);
    const until = Date.parse(body && body.to);
    if (!ids.length || !until) return json({ error: 'ids and to required' }, 400);
    await env.DB.batch(ids.map((id) => env.DB.prepare("UPDATE items SET due_at = ?, snooze_until = NULL, notify_count = 0, last_notified_at = NULL WHERE id = ? AND status = 'open' AND (user_id = ? OR shared = 1)").bind(new Date(until).toISOString(), id, uid)));
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
        env.DB.prepare("DELETE FROM items WHERE external_id = ? AND status = 'open'").bind(`doc:${+m[1]}`),
      ]);
      return json({ ok: true });
    }
  }

  // Imports and syncs
  if (path === '/api/import/vcard' && method === 'POST') return json(await importVcards(env, await req.text(), uid));
  if (path === '/api/import/contacts' && method === 'POST') return json(await importContacts(env, body && body.contacts, uid));
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
    return json({ ok: true, id }, 201);
  }
  if ((m = /^\/api\/rewards\/cards\/([\w-]+)$/.exec(path)) && method === 'DELETE') {
    await env.DB.batch([env.DB.prepare('DELETE FROM rw_cards WHERE id = ?').bind(m[1]), env.DB.prepare('DELETE FROM rw_logs WHERE card_id = ?').bind(m[1])]);
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
  if (path === '/api/backup' && method === 'GET') {
    const all = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
    const people = 'SELECT id FROM people WHERE user_id = ?';
    const out = {
      app: 'life-dashboard', version: 1, exported_at: nowIso(), person: (await all('SELECT id, name FROM users WHERE id = ?', uid))[0],
      yours: {
        items: await all('SELECT * FROM items WHERE user_id = ? OR shared = 1', uid),
        people: await all('SELECT * FROM people WHERE user_id = ?', uid),
        contact_log: await all(`SELECT * FROM contact_log WHERE person_id IN (${people})`, uid),
        gifts: await all(`SELECT * FROM gifts WHERE person_id IN (${people})`, uid),
        person_dates: await all(`SELECT * FROM person_dates WHERE person_id IN (${people})`, uid),
        habits: await all('SELECT * FROM habits WHERE user_id = ?', uid),
        habit_logs: await all('SELECT l.* FROM habit_logs l JOIN habits h ON h.id = l.habit_id WHERE h.user_id = ?', uid),
        meds: await all('SELECT * FROM meds WHERE user_id = ?', uid),
        med_logs: await all('SELECT l.* FROM med_logs l JOIN meds m ON m.id = l.med_id WHERE m.user_id = ?', uid),
        documents: await all('SELECT * FROM documents WHERE user_id = ?', uid),
        event_prefs: await eventPrefRows(env, uid),
        settings: await getSettings(env, uid),
      },
      shared: {
        trips: await all('SELECT * FROM trips'), meals: await all('SELECT * FROM meals'),
        home_tasks: await all('SELECT * FROM home_tasks'), home_log: await all('SELECT * FROM home_log'),
      },
    };
    delete out.yours.settings.weather_cache;
    await setSetting(env, 'last_backup_at', nowIso(), uid);
    await env.DB.prepare("UPDATE items SET status = 'done', done_at = ? WHERE external_id = ? AND status = 'open'").bind(nowIso(), `backup:${uid}`).run();
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
  await env.DB.prepare(`INSERT INTO items (title, area, due_at, nag, source, external_id, notes, user_id)
      VALUES (?, 'travel', ?, 'once', 'documents', ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET title = excluded.title, due_at = excluded.due_at, notes = excluded.notes,
        status = 'open', done_at = NULL, notify_count = 0, last_notified_at = NULL`)
    .bind(`Renew ${name}`, due, `doc:${doc.id}`, `Expires ${expires}`, uid).run();
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
  await insertRow(env, 'items', {
    title: parsed.title, area: parsed.area, kind: parsed.kind, due_at: due ? due.toISOString() : null,
    nag: parsed.nag, repeat_days: parsed.repeat || null, person_id: parsed.person ? parsed.person.id : null, source: 'siri', user_id: uid,
  });
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
  const items = (body && body.items) || [];
  const stmts = items.filter((i) => i.external_id && i.title).map((i) =>
    env.DB.prepare(`INSERT INTO items (title, notes, area, due_at, nag, source, external_id, status, done_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET title = excluded.title, notes = excluded.notes, area = excluded.area,
        due_at = excluded.due_at, status = excluded.status, done_at = excluded.done_at`)
      .bind(i.title, i.notes || null, i.area || 'travel', i.due_at || null, i.nag || 'hourly', source, `${uid === 1 ? '' : `u${uid}:`}${source}:${i.external_id}`,
        i.done ? 'done' : 'open', i.done ? nowIso() : null, uid));
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, synced: stmts.length };
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

// ---------- push (ntfy) ----------

// Send a notification through ntfy. Failures are logged and remembered (Settings shows
// the last one) instead of disappearing silently.
let lastPushError = null;
// `to` is the person (user id) whose phone gets it; each person has their own ntfy topic.
async function topicFor(env, uid) {
  const u = await env.DB.prepare('SELECT ntfy_topic FROM users WHERE id = ?').bind(uid).first();
  return (u && u.ntfy_topic) || (uid === 1 ? env.NTFY_TOPIC : null);
}
// Each person's phones get Life's own notifications (Web Push) once they've turned them on in
// Settings; until then, ntfy is used as before.
async function push(env, opts) {
  const { results: subs } = await env.DB.prepare('SELECT * FROM push_subs WHERE user_id = ?').bind(opts.to || 1).all();
  if (subs.length && env.VAPID_PRIVATE_JWK) return pushWeb(env, subs, opts);
  return pushNtfy(env, opts);
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

async function pushNtfy(env, { to = 1, title, message, actions, priority = 3, tags, click }) {
  const topic = await topicFor(env, to);
  if (!topic) { lastPushError = 'No ntfy topic is set for this person'; return false; }
  try {
    // With an ntfy account token, rate limits count against your account instead of
    // Cloudflare's shared outgoing IP addresses (which other apps exhaust).
    const headers = { 'content-type': 'application/json' };
    if (env.NTFY_TOKEN) headers.authorization = `Bearer ${env.NTFY_TOKEN}`;
    const res = await fetch(env.NTFY_SERVER || 'https://ntfy.sh', {
      method: 'POST',
      headers,
      body: JSON.stringify({ topic, title, message, priority, tags, actions, click: click || env.PUBLIC_URL }),
    });
    if (res.ok) { lastPushError = null; return true; }
    const body = (await res.text().catch(() => '')).slice(0, 200);
    lastPushError = `ntfy ${res.status}: ${body}`;
  } catch (err) {
    lastPushError = `ntfy unreachable: ${String(err && err.message || err).slice(0, 150)}`;
  }
  console.error('push failed:', title, lastPushError);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_push_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(`${new Date().toISOString()} · ${title} · ${lastPushError}`).run().catch(() => {});
  return false;
}

async function actionButton(env, id, action, label) {
  const url = `${env.PUBLIC_URL}/a/${id}/${action}?sig=${await sign(env, `${id}:${action}`)}`;
  return { action: 'http', label, url, method: 'POST', clear: true };
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
  await ensureBirthdayReminders(env, tz, local, uid);
  await ensurePeopleReminders(env, tz, local, uid);
  report.sent.push(...await sendMedReminders(env, tz, local, quiet, now, uid));
  report.sent.push(...await sendHomeReminders(env, tz, local, quiet, now, uid));
  report.sent.push(...await sendRewardsReminders(env, tz, local, now, uid));
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

  // Your own tasks, including ones you shared (the person who owns a task gets its nags).
  const { results } = await env.DB.prepare(`SELECT * FROM items WHERE user_id = ? AND status = 'open' AND kind = 'task' AND nag != 'none'
    AND due_at IS NOT NULL AND due_at <= ? AND (snooze_until IS NULL OR snooze_until <= ?)`).bind(uid, now.toISOString(), now.toISOString()).all();

  // Which items are due for a reminder this run
  const due = results.filter((item) => {
    const sinceMin = item.last_notified_at ? (now - Date.parse(item.last_notified_at)) / 60000 : Infinity;
    return item.nag === 'once' ? item.notify_count === 0 : sinceMin >= (NAG_GAP_MIN[item.nag] || 58);
  });
  const markSent = async (items) => {
    await env.DB.batch(items.map((it) => env.DB.prepare('UPDATE items SET last_notified_at = ?, notify_count = notify_count + 1 WHERE id = ?').bind(now.toISOString(), it.id)));
    report.sent.push(...items.map((it) => it.id));
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
      // Done / Snooze buttons only show through ntfy (Life's own notifications open the app instead)
      actions: [await actionButton(env, item.id, 'done', isBooking ? 'Booked' : 'Done'),
        await actionButton(env, item.id, item.nag === 'daily' || isBooking ? 'tomorrow' : 'snooze', item.nag === 'daily' || isBooking ? 'Tomorrow' : 'Snooze 1h')],
    });
    if (ok) await markSent([item]);
  }
  return report;
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
    const soon = RW.openCredits(ctx, mine).filter((x) => x.dated && x.days <= 3).sort((a, z) => a.days - z.days || z.left - a.left);
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
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO items (title, notes, area, due_at, nag, source, external_id, user_id)
        VALUES (?, ?, NULL, ?, 'daily', 'rewards', ?, ?)`).bind(`Keep or cancel ${c.name}? ${RW.money(c.fee)} fee on ${when}`,
        `Value back this year: ${RW.money(RW.metrics(ctx, c, local.y).used)}. Downgrade or cancel before ${when} if it's not worth it.`, nine, `rwfee:${c.id}:${RW.ymd(fee)}`, uid));
    }
    for (const { b, x, days } of RW.certList(ctx, [c])) {
      if (!x.expires || x.virtual || days > 30 || days < 0) continue;
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO items (title, notes, area, due_at, nag, source, external_id, user_id)
        VALUES (?, ?, 'travel', ?, 'daily', 'rewards', ?, ?)`).bind(`Use your ${b.name} (${c.name})`, `Expires ${x.expires}. Mark it used in Rewards once it's booked.`, nine, `rwcert:${c.id}:${x.id}`, uid));
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
  await env.DB.prepare(`INSERT INTO items (title, notes, due_at, nag, source, external_id, user_id)
      VALUES ('Download a Life backup', 'Settings › Backup › Download a backup. Save it to Files or iCloud Drive.', ?, 'once', 'backup', ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET status = 'open', done_at = NULL, due_at = excluded.due_at, notify_count = 0, last_notified_at = NULL
      WHERE items.status = 'done'`).bind(due, `backup:${uid}`, uid).run();
}

// On someone's birthday (people with "remind me on their birthday" on), add a
// "wish them happy birthday" task due 9am that nags hourly until it's done.
async function ensureBirthdayReminders(env, tz, local, uid = 1) {
  const mmdd = `${String(local.m).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`;
  const { results } = await env.DB.prepare("SELECT id, name FROM people WHERE user_id = ? AND bday_remind = 1 AND birthday LIKE ?").bind(uid, `%${mmdd}`).all();
  if (!results.length) return;
  const due = zonedToUtc(local.y, local.m, local.d, 9, 0, tz).toISOString();
  await env.DB.batch(results.map((p) => env.DB.prepare(`INSERT OR IGNORE INTO items (title, area, due_at, nag, person_id, source, external_id, user_id)
      VALUES (?, 'people', ?, 'hourly', ?, 'birthday', ?, ?)`).bind(`Wish ${p.name.split(' ')[0]} a happy birthday`, due, p.id, `bday:${p.id}:${local.y}`, uid)));
}

// ---------- medications ----------

// Log a dose. Taking an already-taken dose is refused (double-dose guard) and
// tells you when you took it. status: taken | skipped | undo
async function logMed(env, medId, date, slot, status) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(slot || '')) return { error: 'date and slot required' };
  if (status === 'undo') {
    await env.DB.prepare('DELETE FROM med_logs WHERE med_id = ? AND date = ? AND slot = ?').bind(medId, date, slot).run();
    return { ok: true, undone: true };
  }
  const prev = await env.DB.prepare('SELECT * FROM med_logs WHERE med_id = ? AND date = ? AND slot = ?').bind(medId, date, slot).first();
  if (prev && prev.status === 'taken') return { ok: false, already: fmtTime(prev.taken_at, env.TZ || 'America/Chicago'), log: prev };
  await env.DB.prepare(`INSERT INTO med_logs (med_id, date, slot, taken_at, status) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(med_id, date, slot) DO UPDATE SET taken_at = excluded.taken_at, status = excluded.status`)
    .bind(medId, date, slot, nowIso(), status === 'skipped' ? 'skipped' : 'taken').run();
  return { ok: true };
}

// Each scheduled dose reminds you at its time (even in quiet hours or focus, since you
// chose the time), then hourly until you log it. Repeats respect quiet hours.
async function sendMedReminders(env, tz, local, quiet, now, uid = 1) {
  const { results: meds } = await env.DB.prepare("SELECT * FROM meds WHERE user_id = ? AND active = 1 AND remind != 'none'").bind(uid).all();
  if (!meds.length) return [];
  const { results: logs } = await env.DB.prepare('SELECT med_id, slot FROM med_logs WHERE date = ?').bind(local.date).all();
  const logged = new Set(logs.map((l) => `${l.med_id}|${l.slot}`));
  const sent = [];
  for (const med of meds) {
    // Dose times due today (none on days off: weekly / monthly / every N days)
    for (const slot of slotsOn(med, local.date)) {
      if (logged.has(`${med.id}|${slot}`)) continue;
      const [h, mi] = slot.split(':').map(Number);
      const dueAt = zonedToUtc(local.y, local.m, local.d, h, mi, tz);
      if (now < dueAt) continue;
      const key = `med:${med.id}:${local.date}:${slot}`;
      const nag = await env.DB.prepare('SELECT * FROM med_nags WHERE key = ?').bind(key).first();
      // Repeat reminders: every 15 minutes, hourly, or never ('once'); repeats wait out quiet hours.
      const gap = med.remind === '15m' ? 14 : 58;
      if (nag && (med.remind === 'once' || (now - Date.parse(nag.last_at)) / 60000 < gap || quiet)) continue;
      const hhmm = slot.replace(':', '');
      const link = async (act) => ({ action: 'http', label: act === 'taken' ? 'Taken' : 'Skip today', method: 'POST', clear: true,
        url: `${env.PUBLIC_URL}/a/med/${med.id}/${local.date}/${hhmm}/${act}?sig=${await sign(env, `med:${med.id}:${local.date}:${hhmm}:${act}`)}` });
      const ok = await push(env, {
        to: uid,
        tag: `med-${med.id}-${hhmm}`,
        title: `${nag ? 'Still need to take' : 'Time for'} ${med.name}${med.dose ? ` (${med.dose})` : ''}`,
        message: `Scheduled ${fmtTime(dueAt.toISOString(), tz)}${nag ? ` · reminder ${nag.count + 1}` : ''}`,
        priority: 4, actions: [await link('taken'), await link('skip')],
      });
      if (ok) {
        await env.DB.prepare(`INSERT INTO med_nags (key, last_at, count) VALUES (?, ?, 1)
          ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at, count = med_nags.count + 1`).bind(key, now.toISOString()).run();
        sent.push(key);
      }
    }
  }
  await env.DB.prepare('DELETE FROM med_nags WHERE last_at < ?').bind(new Date(now.getTime() - 3 * 86400000).toISOString()).run();
  return sent;
}

// ---------- Home reminders ----------
// Only while a task is on the Home "To do" list (due this month or overdue; not done or snoozed).
//   hourly: from its due day on, every hour outside quiet hours
//   daily / weekly / monthly: once at the time you picked (on the weekday / date you picked)
async function sendHomeReminders(env, tz, local, quiet, now, uid) {
  const { results: tasks } = await env.DB.prepare("SELECT * FROM home_tasks WHERE hidden = 0 AND remind != 'none' AND (remind_to = ? OR remind_to = 0)").bind(uid).all();
  if (!tasks.length) return [];
  const { results: logs } = await env.DB.prepare('SELECT task_id, MAX(date) AS last FROM home_log GROUP BY task_id').all();
  const last = Object.fromEntries(logs.map((r) => [r.task_id, r.last]));
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
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO items (title, notes, area, due_at, nag, person_id, source, external_id, user_id)
      VALUES (?, ?, 'people', ?, 'daily', ?, 'gift', ?, ?)`).bind(`Pick a gift for ${p.name.split(' ')[0]}`,
      ideas.length ? `Ideas: ${ideas.join(' · ')}` : 'No gift ideas saved yet. Add some on their page.', due, p.id, `gift:${p.id}:${year}`, uid));
  }
  // Important dates you asked to be reminded about: hourly on the day until done.
  const mmdd = `${String(local.m).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`;
  const { results: dates } = await env.DB.prepare(`SELECT d.id, d.label, d.person_id, p.name FROM person_dates d JOIN people p ON p.id = d.person_id
    WHERE p.user_id = ? AND d.remind = 1 AND d.date LIKE ?`).bind(uid, `%${mmdd}`).all();
  for (const d of dates) {
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO items (title, area, due_at, nag, person_id, source, external_id, user_id)
      VALUES (?, 'people', ?, 'hourly', ?, 'date', ?, ?)`).bind(`${d.name.split(' ')[0]}: ${d.label}`, due, d.person_id, `pdate:${d.id}:${local.y}`, uid));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------- evening wrap-up ----------

async function sendWrapUp(env, tz, local, uid = 1) {
  const dayStart = zonedToUtc(local.y, local.m, local.d, 0, 0, tz).toISOString();
  const dayEnd = zonedToUtc(local.y, local.m, local.d, 23, 59, tz).toISOString();
  const [done, left, habits, habitDone] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND done_at >= ?').bind(uid, dayStart).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND status = 'open' AND kind = 'task' AND due_at <= ?").bind(uid, dayEnd).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM habits WHERE user_id = ? AND archived = 0').bind(uid).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM habit_logs l JOIN habits h ON h.id = l.habit_id WHERE h.user_id = ? AND l.date = ?').bind(uid, local.date).first(),
  ]);
  const lines = [`${done.n} done today`];
  if (left.n) lines.push(`${left.n} still open: tap to move ${left.n === 1 ? 'it' : 'them'} to tomorrow`);
  else lines.push('Nothing left over. Nice.');
  if (habits.n) lines.push(`Habits: ${habitDone.n} of ${habits.n}`);
  await push(env, { to: uid, title: 'Evening wrap-up', message: lines.join('\n'), priority: 2 });
  // ntfy opens the app's main page; the app shows the wrap-up card in the evening.
}

// Nights this week (Sunday through Saturday, from today on) with no meal plan
async function unplannedNights(env, local) {
  const days = [];
  const dow = new Date(Date.UTC(local.y, local.m - 1, local.d)).getUTCDay();
  for (let i = 0; i <= 6 - dow; i++) days.push(new Date(Date.UTC(local.y, local.m - 1, local.d + i)).toISOString().slice(0, 10));
  const { results } = await env.DB.prepare(`SELECT date FROM meals WHERE date IN (${days.map(() => '?').join(',')})`).bind(...days).all();
  return days.length - results.length;
}

// "Home: 1 overdue · 3 this week" for the morning briefing
async function homeSummary(env, date) {
  const [tasks, logs] = await Promise.all([
    env.DB.prepare('SELECT * FROM home_tasks WHERE hidden = 0').all(),
    env.DB.prepare('SELECT task_id, MAX(date) AS last FROM home_log GROUP BY task_id').all(),
  ]);
  const last = Object.fromEntries(logs.results.map((r) => [r.task_id, r.last]));
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
    env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE (user_id = ? OR shared = 1) AND status = 'open' AND due_at BETWEEN ? AND ?").bind(uid, dayStart, dayEnd).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND status = 'open' AND nag IN ('hourly','15m','daily') AND due_at < ?").bind(uid, dayStart).first(),
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
  const dinner = await env.DB.prepare('SELECT * FROM meals WHERE date = ?').bind(local.date).first();
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
