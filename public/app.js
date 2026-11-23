// Life Dashboard: single-page UI. No framework, no build step.
import { parseCapture } from './parse.js';
import { parseVcards, birthdayEventPerson } from './vcard.js';
import { medDueOn, describeSchedule, nextDue, WEEKDAY_NAMES, slotsOn, allTimes, fmtSlot, ORDINAL } from './meds.js';
import { homeDue, daysToMonthEnd, FREQS as HOME_FREQS, TYPES as HOME_TYPES, monthsFor, minutesOf } from './home.js';
import * as RW from './rewards.js';
import * as TK from './tasks.js';

(() => {
  'use strict';

  const AREAS = { hoa: 'HOA', travel: 'Travel', people: 'People', home: 'Home', work: 'Work' };
  const NAGS = { none: 'No reminder', once: 'Remind once', daily: 'Daily till done', hourly: 'Hourly till done', '15m': 'Every 15 min till done' };
  const NAG_SHORT = { daily: 'daily', hourly: 'hourly', '15m': 'every 15m' };
  const REPEATS = (n) => ({ 1: 'every day', 7: 'every week', 14: 'every 2 weeks', 30: 'every month', 90: 'every 3 months', 365: 'every year' }[n] || `every ${n} days`);
  const CHECKINS = { '': 'Not tracked', 14: 'Every 2 weeks', 30: 'Every month', 60: 'Every 2 months', 90: 'Every 3 months', 180: 'Every 6 months', 365: 'Once a year' };
  const DAY = 86400000;

  const app = document.getElementById('app');
  const dock = document.getElementById('dock');
  const nav = document.getElementById('nav');
  const capForm = document.getElementById('capture');
  const capInput = document.getElementById('cap');
  const parsedEl = document.getElementById('parsed');
  const sheet = document.getElementById('sheet');
  const toastEl = document.getElementById('toast');

  let token = '';
  try { token = localStorage.getItem('life_token') || ''; } catch (_) { /* storage blocked */ }
  let data = { items: [], people: [], events: [], trips: [], documents: [], tasks: [], task_log: [], gifts: [], person_dates: [], meds: [], med_logs: [], home_tasks: [], home_log: [], meals: [], meal_titles: [], settings: {} };
  let weather = null;
  let weatherAt = 0;
  let needLogin = false; // only used for local development (online, Cloudflare Access is the sign-in)
  let loaded = false;
  const ui = { rwTab: 'cards', rwWho: 'all', rwType: 'all', allArea: 'all', peopleFilter: 'birthdays', peopleQuery: '', showDone: false, q: '', homeView: 'now', homeRoom: '', homeQ: '', mealWeek: 0 };
  const CIRCLES = { family: 'Family', close: 'Close friend', friends: 'Friend' };
  const inCircle = (p) => p && (p.circle === 'family' || p.circle === 'close');

  // ---------- sheets: one consistent way to open, save and close ----------
  // Every pop-up sheet gets: a × in the corner, tap-outside / Escape / Cancel to
  // close (asking first if you've typed something unsaved), Save/Cancel pinned to
  // the bottom, no keyboard popping up on open, and the page behind held still.
  function showSheet() {
    const form = sheet.querySelector('form');
    if (form && !form.querySelector('.sheet-x')) {
      form.insertAdjacentHTML('afterbegin', '<span class="sheet-grab" aria-hidden="true"></span><button type="button" class="sheet-x" data-sheet="close" aria-label="Close">×</button>');
    }
    // A × may be the only close control on sheets without their own Cancel button
    sheet.querySelectorAll('.sheet-x').forEach((b) => { if (!b.onclick) b.onclick = () => sheet.close(); });
    sheet.dataset.dirty = '';
    if (!sheet.open) sheet.showModal();
    // Don't pop the keyboard: focus the sheet itself, not its first text box.
    if (document.activeElement && document.activeElement !== sheet) document.activeElement.blur();
    sheet.focus({ preventScroll: true });
    sheet.scrollTop = 0;
  }
  const sheetDirty = () => sheet.dataset.dirty === '1';
  const okToClose = () => !sheetDirty() || confirm('Discard your changes?');
  sheet.tabIndex = -1;
  // Typing marks the sheet unsaved (gift ideas / dates save instantly, so they don't count)
  sheet.addEventListener('input', (e) => { if (!e.target.closest('#p-extras') && e.target.type !== 'search') sheet.dataset.dirty = '1'; });
  sheet.addEventListener('change', (e) => { if (!e.target.closest('#p-extras') && e.target.type !== 'search' && e.target.type !== 'file') sheet.dataset.dirty = '1'; });
  sheet.addEventListener('submit', () => { sheet.dataset.dirty = ''; }, true);
  sheet.addEventListener('close', () => { sheet.dataset.dirty = ''; });
  // Cancel / Close / × buttons: confirm before throwing away typing
  sheet.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-sheet="close"]');
    if (closer && !okToClose()) { e.stopImmediatePropagation(); e.preventDefault(); return; }
    // Tap on the dimmed area outside the sheet
    if (e.target === sheet) {
      const r = sheet.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside && okToClose()) sheet.close();
    }
  }, true);
  // Escape key
  sheet.addEventListener('cancel', (e) => { if (!okToClose()) e.preventDefault(); });

  // ---------- utils ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  // Compact time that always says a or p: 7p, 6:45p, 11:30a
  const fmtShortTime = (iso) => { const d = new Date(iso); const h = d.getHours() % 12 || 12, ap = d.getHours() < 12 ? 'a' : 'p';
    return d.getMinutes() ? `${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}` : `${h}${ap}`; };
  const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const weekday = (d, style = 'short') => new Date(d).toLocaleDateString([], { weekday: style });
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
  const areaClass = (a) => (a && AREAS[a] ? `a-${a}` : '');
  const initials = (name) => (name || '?').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const hasTime = (iso) => { const d = new Date(iso); return !(d.getHours() === 9 && d.getMinutes() === 0); };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function relDue(iso) {
    const d = new Date(iso);
    const diff = daysBetween(new Date(), d);
    const t = hasTime(iso) ? ` ${fmtTime(iso)}` : '';
    if (diff === 0) return hasTime(iso) ? fmtTime(iso) : 'Today';
    if (diff === 1) return 'Tomorrow' + t;
    if (diff === -1) return 'Yesterday';
    if (diff < 0) return `${-diff} days ago`;
    if (diff < 7) return weekday(d, 'long') + t;
    return fmtDay(iso) + t;
  }

  function overdueText(iso) {
    const mins = (Date.now() - Date.parse(iso)) / 60000;
    if (mins < 60) return 'due now';
    if (mins < 1440) return `overdue ${Math.round(mins / 60)}h`;
    const d = Math.floor(mins / 1440);
    return `overdue ${d === 1 ? 'a day' : `${d} days`}`;
  }

  function birthdayIn(bday) {
    const m = /(\d{2})-(\d{2})$/.exec(bday || '');
    if (!m) return null;
    const today = startOfDay();
    let next = new Date(today.getFullYear(), +m[1] - 1, +m[2]);
    if (next < today) next = new Date(today.getFullYear() + 1, +m[1] - 1, +m[2]);
    const y = /^(\d{4})-/.exec(bday);
    return { days: daysBetween(today, next), date: next, turns: y ? next.getFullYear() - +y[1] : null };
  }

  function checkinStatus(p) {
    if (!p.checkin_days) return null;
    const since = p.last_contact_at ? daysBetween(new Date(p.last_contact_at), new Date()) : null;
    return { since, overdue: since === null || since >= p.checkin_days, left: since === null ? 0 : p.checkin_days - since };
  }

  function toast(msg, undo) {
    toastEl.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
    toastEl.hidden = false;
    if (undo) toastEl.querySelector('button').onclick = () => { toastEl.hidden = true; undo(); };
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }

  async function api(path, opts = {}) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    // Test copy only: act as another person (the server ignores this anywhere else).
    if (location.hostname === 'localhost') { try { const u = localStorage.getItem('life_dev_user'); if (u) headers['x-dev-user'] = u; } catch (_) { /* ignore */ } }
    if (opts.headers) Object.assign(headers, opts.headers);
    let body = opts.body;
    if (body && typeof body !== 'string') { headers['content-type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
    // Cloudflare Access session expired: reload so the gate can ask for a new email code.
    if (res.type === 'opaqueredirect' || res.status === 403) {
      let last = 0;
      try { last = +sessionStorage.getItem('life_reauth') || 0; sessionStorage.setItem('life_reauth', Date.now()); } catch (_) { /* ignore */ }
      if (Date.now() - last > 30000) location.reload(); // at most once per 30s, so it can't loop
      throw new Error('Your sign-in expired. Reload the page to sign in again.');
    }
    if (res.status === 401) { token = ''; needLogin = true; render(); throw new Error('Wrong password'); }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `Error ${res.status}`);
    return out;
  }

  async function refresh() {
    data = await api('/api/state');
    medsFromTasks();
    loaded = true;
    if (window.lifeTheme && data.settings && data.settings.weather_lat) window.lifeTheme.setLocation(data.settings.weather_lat, data.settings.weather_lon);
    if (window.lifeTheme && data.settings && data.settings.palette) window.lifeTheme.setPalette(data.settings.palette);
    needLogin = false;
    if (Date.now() - weatherAt > 20 * 60000) {
      weatherAt = Date.now();
      api('/api/weather').then((w) => { weather = w; if (currentView() === 'today') render(); }).catch(() => {});
    }
    if (data.auth === 'access' && token) {
      // Online the email-code gate is the sign-in: forget any saved password.
      token = '';
      try { localStorage.removeItem('life_token'); } catch (_) { /* ignore */ }
    }
    render();
  }

  function logout() {
    token = '';
    try { localStorage.removeItem('life_token'); } catch (_) { /* ignore */ }
    if (data.auth === 'access') { location.href = '/cdn-cgi/access/logout'; return; }
    needLogin = true;
    render();
  }

  // Capture parsing lives in parse.js (shared with the server for Siri capture).

  function parsedTags(p) {
    const t = [];
    if (p.area) t.push(`<span class="tag ${areaClass(p.area)}"><span class="adot"></span><strong>${AREAS[p.area]}</strong></span>`);
    if (p.due) t.push(`<span class="tag"><strong>${esc(relDue(p.due.toISOString()))}</strong></span>`);
    if (p.person) t.push(`<span class="tag">with <strong>${esc(p.person.name)}</strong></span>`);
    if (p.repeat) t.push(`<span class="tag">repeats <strong>${REPEATS(p.repeat)}</strong></span>`);
    if (NAG_SHORT[p.nag]) t.push(`<span class="tag"><strong>${NAGS[p.nag]}</strong></span>`);
    if (p.kind === 'note') t.push('<span class="tag"><strong>Note</strong></span>');
    return t.join('');
  }

  // ---------- pieces ----------

  const areaLabel = (a) => (a && AREAS[a] ? `<span class="${areaClass(a)}"><span class="adot"></span>${AREAS[a]}</span>` : '');

  // ---------- Life's own notifications (Web Push) ----------
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let thisEndpoint = null; // this device's push subscription, if any
  async function loadPushState() {
    if (!pushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg && await reg.pushManager.getSubscription();
      const was = thisEndpoint;
      thisEndpoint = sub ? sub.endpoint : null;
      // Re-register a subscription the server lost track of (or that changed).
      if (sub && data && data.push && !data.push.devices.some((d) => d.endpoint === sub.endpoint)) await api('/api/push/subscribe', { body: { ...sub.toJSON(), device: deviceName() } });
      if (was !== thisEndpoint && currentView() === 'settings') render();
    } catch (_) { /* ignore */ }
  }
  const deviceName = () => (isIOS() ? (/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone') : /Mac/.test(navigator.platform) ? 'Mac' : 'Browser');
  function viewPushSetting() {
    const devices = (data.push && data.push.devices) || [];
    const onHere = thisEndpoint && devices.some((d) => d.endpoint === thisEndpoint);
    const others = devices.filter((d) => d.endpoint !== thisEndpoint).length;
    const err = devices.find((d) => d.endpoint === thisEndpoint && d.last_error);
    let html;
    if (onHere) html = `<p><span class="ok-dot" aria-hidden="true"></span> On for this ${esc(deviceName())}. Reminders come straight from Life; tap one to open the app.${others ? ` Also on for ${others} other device${others > 1 ? 's' : ''}.` : ''}</p>${err ? `<p class="hint late">Last attempt failed: ${esc(err.last_error)}</p>` : ''}`;
    else if (!pushSupported() && isIOS() && !isStandalone()) html = `<p>To get Life's notifications on this iPhone, open Life from its <b>Home Screen icon</b> (not Safari), then come back here.</p>`;
    else if (!pushSupported()) html = `<p>This browser can't show Life's notifications.${devices.length ? ` They're on for ${devices.length} other device${devices.length > 1 ? 's' : ''}.` : ''}</p>`;
    else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') html = `<p>Notifications are blocked for Life. On iPhone: <b>Settings › Notifications › Life</b>, turn on Allow Notifications, then reopen Life.</p>`;
    else html = `<p>Get reminders straight from Life: reliable, private, and tapping one opens the app.${devices.length ? ` Already on for ${devices.length} other device${devices.length > 1 ? 's' : ''}.` : ''}</p><div class="btns"><button type="button" class="btn dark" data-act="push-on">Turn on notifications</button></div>`;
    if (!devices.length && data.me && data.me.ntfy_topic) html += `<p class="hint">Until then, reminders go through the ntfy app (topic <b class="sel">${esc(data.me.ntfy_topic)}</b>).</p>`;
    else if (devices.length) html += `<p class="hint">ntfy is no longer used for you, so you can delete the ntfy app.${onHere ? ' <button type="button" class="link" data-act="push-off">Turn off on this device</button>' : ''}</p>`;
    return html;
  }
  // Must start from the tap itself: iPhone only asks for permission during a user gesture.
  async function turnOnPush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were not allowed'); render(); return; }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(data.push.public_key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(data.push.public_key.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/api/push/subscribe', { body: { ...sub.toJSON(), device: deviceName() } });
    thisEndpoint = sub.endpoint;
    await refresh();
    await api('/api/test-push', { body: {} }).then(() => toast('Notifications are on. A test is on its way.')).catch((err) => toast(err.message));
  }
  async function turnOffPush() {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
    thisEndpoint = null;
    await refresh();
    toast('Notifications off for this device');
  }

  // The other people who use Life (for "Shared" tasks)
  const others = () => (data.users || []).filter((u) => !data.me || u.id !== data.me.id);
  const personName = (id) => ((data.users || []).find((u) => u.id === id) || {}).name || 'someone';

  function itemMeta(it, { skipDue = false } = {}) {
    const now = Date.now();
    const parts = [];
    if (it.area) parts.push(areaLabel(it.area));
    if (it.due_at && !skipDue) {
      const late = Date.parse(it.due_at) < now && it.status === 'open';
      parts.push(late ? `<span class="late">${esc(relDue(it.due_at))}</span>` : esc(relDue(it.due_at)));
    } else if (it.due_at && skipDue && hasTime(it.due_at)) parts.push(esc(fmtTime(it.due_at)));
    if (NAG_SHORT[it.nag]) parts.push(NAG_SHORT[it.nag]);
    if (it.repeat_days) parts.push(REPEATS(it.repeat_days));
    if (it.source === 'wayfare') parts.push('Wayfare');
    if (it.top3) parts.push('Top 3');
    if (it.shared) parts.push(it.user_id && data.me && it.user_id !== data.me.id ? `Shared by ${esc(personName(it.user_id))}` : 'Shared');
    if (it.snooze_until && Date.parse(it.snooze_until) > now) parts.push(`snoozed till ${fmtTime(it.snooze_until)}`);
    const person = it.person_id && data.people.find((p) => p.id === it.person_id);
    if (person) parts.push(esc(person.name));
    return parts.join(' · ');
  }

  // Open tasks can be swiped: right = done, left = later (snooze 1 hour).
  function itemRow(it, { when = null, skipDue = false } = {}) {
    const done = it.status === 'done';
    const swipe = !done && it.kind === 'task';
    return `<li class="row${swipe ? ' sw' : ''}"${swipe ? ` data-swipe="${it.id}"` : ''}><div class="row-inner">
      ${when !== null ? `<span class="when">${esc(when)}</span>` : ''}
      <button type="button" class="check${done ? ' done' : ''}" data-act="${done ? 'reopen' : 'done'}" data-id="${it.id}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(it.title)}"></button>
      <button type="button" class="row-main" data-act="edit" data-id="${it.id}">
        <div class="t${done ? ' done-t' : ''}">${esc(it.title)}</div>
        <div class="meta">${itemMeta(it, { skipDue })}</div>
      </button>
    </div></li>`;
  }

  // One icon slot per row type so This week (and the day view) scan easily.
  const KIND_ICONS = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    pill: '<path d="M10.5 20.5a5 5 0 0 1-7-7l10-10a5 5 0 0 1 7 7z"/><path d="M8.5 8.5l7 7"/>',
    balloon: '<path d="M12 16c3.5 0 6-3 6-7a6 6 0 0 0-12 0c0 4 2.5 7 6 7z"/><path d="M12 16l-1 2h2l-1-2M12 18c0 1.5-1 2-2 3"/>',
    heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
    gift: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M12 8S10 3 7.5 4.5 9 8 12 8zm0 0s2-5 4.5-3.5S15 8 12 8z"/>',
    suitcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 12h18"/>',
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    fork: '<path d="M4 3v8a3 3 0 0 0 6 0V3M7 3v18M17 21V3c-2 1.5-3 4-3 7s1 4 3 4"/>',
    check: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M8 12.5l3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    repeat: '<path d="M4 9a5 5 0 0 1 5-5h9l-3-3M20 15a5 5 0 0 1-5 5H6l3 3"/>',
  };
  const kindMark = (k, cls = '') => `<span class="evmark ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${KIND_ICONS[k]}</svg></span>`;

  function eventRow(ev, { when, meta }) {
    const note = ev.pref && ev.pref.note ? `<div class="meta">${esc(ev.pref.note)}</div>` : '';
    return `<li class="row">
      <span class="when">${esc(when)}</span>
      ${kindMark('calendar')}
      <button type="button" class="row-main" data-act="event" data-id="${ev.id}"><div class="t">${esc(ev.title)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}${note}</button>
    </li>`;
  }

  function personRow(p, side) {
    return `<li class="row">
      <span class="avatar a-people" style="width:36px;height:36px;font-size:14px">${esc(initials(p.name))}</span>
      <button type="button" class="row-main" data-act="person" data-id="${p.id}">
        <div class="t">${esc(p.name)}</div>
        <div class="meta">${side}</div>
      </button>
    </li>`;
  }

  // Lists where no row has a time drop the empty time column (otherwise items sit oddly far in)
  const listCard = (rows) => { const timed = rows.some((r) => /class="when">\s*[^<\s]/.test(r));
    return `<div class="card${timed ? '' : ' no-when'}"><ul class="list">${rows.join('')}</ul></div>`; };
  // Sections can fold away (remembered on this device) and carry a quick "+" button.
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(localStorage.getItem('life_collapsed') || '[]')); } catch (_) { /* storage blocked */ }
  const isCol = (k) => collapsed.has(k);
  const chev = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  // def: folded unless you've opened it (remembered as "+key")
  const isFolded = (k, def = false) => (def ? !collapsed.has(`+${k}`) : collapsed.has(k));
  function head(title, { key, add, addLabel, def = false } = {}) {
    const t = key ? `<button type="button" class="sec-toggle" data-act="toggle-sec" data-key="${key}"${def ? ' data-def="1"' : ''} aria-expanded="${!isFolded(key, def)}">${title}${chev}</button>` : title;
    const addIcon = add === 'go-meals' ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS.fork}</svg>` : '+';
    return `<div class="sec-head"><h2>${t}</h2>${add ? `<button type="button" class="sec-add" data-act="${add}" aria-label="${esc(addLabel || 'Add')}">${addIcon}</button>` : ''}</div>`;
  }
  const section = (title, rows, empty, opt = {}) => rows.length || empty
    ? `<section${opt.key && isCol(opt.key) ? ' class="folded"' : ''}>${head(title, opt)}${opt.key && isCol(opt.key) ? '' : rows.length ? listCard(rows) : `<div class="allclear">${empty}</div>`}</section>`
    : '';

  // ---------- views ----------

  function viewToday() {
    const now = new Date();
    const sod = startOfDay(now), eod = new Date(+sod + DAY), week = new Date(+sod + 7 * DAY);
    const open = data.items.filter((i) => i.status === 'open' && i.kind === 'task');
    const isNagging = (i) => i.due_at && new Date(i.due_at) <= now && !!NAG_SHORT[i.nag]
      && !(i.snooze_until && Date.parse(i.snooze_until) > Date.now());
    const overdue = open.filter((i) => i.due_at && (new Date(i.due_at) < sod || isNagging(i)))
      .sort((a, b) => (isNagging(b) - isNagging(a)) || (Date.parse(a.due_at) - Date.parse(b.due_at)));
    const overdueIds = new Set(overdue.map((i) => i.id));
    const eventsOn = (d0, d1) => data.events.filter((e) => !(e.pref && e.pref.hidden) && !birthdayEventPerson(e.title, data.people) && new Date(e.start_at) < d1 && (e.end_at ? new Date(e.end_at) > d0 : new Date(e.start_at) >= d0));

    // header
    const h = now.getHours();
    const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    const name = (data.settings.name || '').trim();
    const todayEvents = eventsOn(sod, eod);
    const eventsLeft = todayEvents.filter((e) => e.all_day || new Date(e.end_at || e.start_at) > now).length;
    const summary = [overdue.length ? `${plural(overdue.length, 'thing')} need${overdue.length === 1 ? 's' : ''} you` : 'Nothing overdue',
      eventsLeft ? `${plural(eventsLeft, 'event')} left today` : 'no more events today'].join(' · ');

    // week strip
    const days = Array.from({ length: 7 }, (_, i) => {
      const d0 = new Date(+sod + i * DAY), d1 = new Date(+d0 + DAY);
      const busy = eventsOn(d0, d1).length || open.some((it) => it.due_at && new Date(it.due_at) >= d0 && new Date(it.due_at) < d1);
      const bday = data.people.some((p) => p.bday_notify !== 0 && birthdayIn(p.birthday)?.days === i);
      // Month label over the first day, and over the 1st when a new month starts this week
      const mon = i === 0 || d0.getDate() === 1 ? d0.toLocaleDateString([], { month: 'short' }) : '';
      return `<div class="wcell"><span class="mon" aria-hidden="true">${esc(mon)}</span><button type="button" class="d${i === 0 ? ' today' : ''}" data-act="day" data-date="${ymd(d0)}" aria-label="${d0.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}${bday ? ', a birthday' : busy ? ', something scheduled' : ''}. Show this day">
        <span>${weekday(d0)}</span><strong>${d0.getDate()}</strong><i class="${bday ? 'bday' : busy ? 'on' : ''}"></i></button></div>`;
    }).join('');

    // needs you now
    let nowCard = '';
    if (overdue.length) {
      const top = overdue[0];
      const booking = top.source === 'wayfare';
      nowCard = `<section class="now" aria-label="Needs you now">
        <span class="label">Needs you now</span>
        <div>
          <button type="button" class="title" data-act="edit" data-id="${top.id}">${esc(top.title)}</button>
          <div class="sub">${top.area ? `<span class="chip ${areaClass(top.area)}">${AREAS[top.area]}</span>` : ''}
            <span>${esc(overdueText(top.due_at))}${isNagging(top) ? ` · I'll keep reminding you ${{ '15m': 'every 15 minutes', hourly: 'hourly', daily: 'daily' }[top.nag]}` : ''}</span></div>
        </div>
        <div class="btns2">
          <button type="button" class="btn dark" data-act="done" data-id="${top.id}">${booking ? 'Booked' : 'Mark done'}</button>
          <button type="button" class="btn" data-act="snooze" data-id="${top.id}">Later</button>
        </div>
        ${overdue.length > 1 ? `<div class="more">${overdue.slice(1, 5).map((i) => `<button type="button" data-act="edit" data-id="${i.id}"><span>${esc(i.title)}</span><span class="late">${esc(overdueText(i.due_at).replace('overdue ', ''))}</span></button>`).join('')}</div>` : ''}
      </section>`;
    }

    // featured birthday (soonest within a week)
    const bdays = data.people.filter((p) => p.bday_notify !== 0).map((p) => ({ p, b: birthdayIn(p.birthday) })).filter((x) => x.b && x.b.days <= 14).sort((a, b) => a.b.days - b.b.days);
    // Heads-up card ahead of time only for family / close friends (gift planning); everyone else on the day itself.
    const featured = bdays.find((x) => x.b.days === 0 || (inCircle(x.p) && x.b.days <= 7));
    let bdayCard = '';
    if (featured) {
      const { p, b } = featured;
      const when = b.days === 0 ? 'today' : b.days === 1 ? 'tomorrow' : weekday(b.date, 'long');
      const first = p.name.split(' ')[0];
      const sub = [b.turns ? `Turns ${b.turns}` : '', (p.notes || '').split('\n')[0].slice(0, 60)].filter(Boolean).join(' · ') || 'Tap to see details';
      bdayCard = `<button type="button" class="feature" data-act="person" data-id="${p.id}">
        <span class="avatar lg a-people">${esc(initials(p.name))}</span>
        <span style="flex:1;min-width:0"><span class="t">${esc(first)}'s birthday is ${esc(when)}</span><span class="s">${esc(sub)}</span></span>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M12 8S10 3 7.5 4.5 9 8 12 8zm0 0s2-5 4.5-3.5S15 8 12 8z"/></svg>
      </button>`;
    }

    // rest of today
    const todayItems = open.filter((i) => !overdueIds.has(i.id) && i.due_at && new Date(i.due_at) >= sod && new Date(i.due_at) < eod);
    const top3 = open.filter((i) => i.top3 && !overdueIds.has(i.id) && !todayItems.includes(i)).slice(0, 3);
    const rest = [
      ...top3.map((i) => ({ at: -1, html: itemRow(i, { when: '' }) })),
      ...todayEvents.map((e) => ({ at: e.all_day ? 0 : Date.parse(e.start_at), html: eventRow(e, { when: e.all_day ? 'All day' : fmtShortTime(e.start_at), meta: eventMeta(e, now) }) })),
      ...todayItems.map((i) => ({ at: Date.parse(i.due_at), html: itemRow(i, { when: hasTime(i.due_at) ? fmtShortTime(i.due_at) : '', skipDue: true }) })),
      ...(() => {
        const ml = (data.meals || []).find((x) => x.date === ymd(sod));
        if (!ml || ml.kind !== 'cook' || ml.eaten || now.getHours() >= 19) return [];
        const at = new Date(sod); at.setHours(18, 0, 0, 0);
        return [{ at: +at, html: `<li class="row"><span class="when"></span>${kindMark('fork', 'k-people')}
          <button type="button" class="row-main" data-act="meal-open" data-date="${ml.date}"><div class="t">Dinner: ${esc(ml.title)}</div>${ml.notes ? `<div class="meta">${esc(ml.notes)}</div>` : ''}</button>
          <button type="button" class="pbtn" data-act="meal-ate" data-date="${ml.date}" aria-label="We already ate. Hide dinner">Ate ✓</button></li>` }];
      })(),
    ].sort((a, b) => a.at - b.at).map((x) => x.html);

    // catch up with
    const reach = data.people.map((p) => ({ p, s: checkinStatus(p) })).filter((x) => x.s && x.s.overdue)
      .sort((a, b) => (b.s.since ?? 9999) - (a.s.since ?? 9999)).slice(0, 4);
    const catchUp = reach.length ? `<section>${head(`Catch up with <span class="n">${reach.length}</span>`, { key: 'catchup' })}${isCol('catchup') ? '' : `<div class="people-grid">${reach.map(({ p, s }) => {
      const note = (p.notes || '').split('\n')[0].slice(0, 50);
      const sub = [s.since === null ? 'No contact logged' : `${s.since} days`, note].filter(Boolean).join(' · ');
      const primary = `<button type="button" class="pbtn" data-act="person" data-id="${p.id}">Open</button>`;
      return `<div class="pcard">
        <button type="button" class="who" data-act="person" data-id="${p.id}">
          <span class="avatar a-people" style="width:40px;height:40px;font-size:15px">${esc(initials(p.name))}</span>
          <span><strong>${esc(p.name)}</strong><span class="s">${esc(sub)}</span></span>
        </button>
        <div class="acts">${primary}<button type="button" class="pbtn icon" data-act="talked" data-id="${p.id}" aria-label="Log that you talked to ${esc(p.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg></button></div>
      </div>`;
    }).join('')}</div>`}</section>` : '';

    // coming up (next 7 days, after today)
    const upcoming = [
      ...eventsOn(eod, week).filter((e) => new Date(e.start_at) >= eod)
        .map((e) => ({ at: Date.parse(e.start_at), html: eventRow(e, { when: weekday(e.start_at), meta: `${e.all_day ? 'All day' : esc(fmtTime(e.start_at))} · Calendar` }) })),
      ...open.filter((i) => i.due_at && new Date(i.due_at) >= eod && new Date(i.due_at) < week && !overdueIds.has(i.id))
        .map((i) => ({ at: Date.parse(i.due_at), html: itemRow(i, { when: weekday(i.due_at), skipDue: true }) })),
      ...(data.person_dates || []).map((d) => ({ d, p: data.people.find((x) => x.id === d.person_id), b: birthdayIn(d.date) }))
        .filter((x) => x.p && inCircle(x.p) && x.b && x.b.days >= 0 && x.b.days < 7)
        .map((x) => ({ at: +x.b.date, html: `<li class="row"><span class="when">${x.b.days === 0 ? 'Today' : esc(weekday(x.b.date))}</span>${kindMark('heart', 'k-people')}<button type="button" class="row-main" data-act="person" data-id="${x.p.id}"><div class="t">${esc(x.p.name)}</div><div class="meta">${esc(x.d.label)}${/^\d{4}/.test(x.d.date) ? ` · ${x.b.date.getFullYear() - +x.d.date.slice(0, 4)} years` : ''}</div></button></li>` })),
      // Medications that aren't every-day: show their next dose days this week
      ...(data.meds || []).filter((m) => !((m.freq || 'daily') === 'daily' && (+m.interval_n || 1) === 1)).flatMap((m) =>
        Array.from({ length: 6 }, (_, i) => { const d = startOfDay(); d.setDate(d.getDate() + i + 1); return d; })
          .filter((d) => medDueOn(m, ymd(d)))
          .map((d) => { const day = slotsOn(m, ymd(d)); const [h, mi] = day[0].split(':').map(Number); const at = new Date(d); at.setHours(h, mi, 0, 0);
            return { at: +at, html: `<li class="row"><span class="when">${esc(weekday(d))}</span>${kindMark('pill', 'k-med')}<button type="button" class="row-main" data-act="med-open" data-id="${m.id}"><div class="t">${esc(m.name)}${m.dose ? ` · ${esc(m.dose)}` : ''}</div><div class="meta">Medication · ${esc(day.map(fmtSlot).join(', '))} · ${esc(describeSchedule(m).split(' · ')[0])}</div></button></li>` }; })),
      ...bdays.filter((x) => x.b.days > 0 && x.b.days < 7 && x !== featured)
        .map((x) => ({ at: +x.b.date, html: `<li class="row"><span class="when">${esc(weekday(x.b.date))}</span>${kindMark('balloon', 'k-people')}<button type="button" class="row-main" data-act="person" data-id="${x.p.id}"><div class="t">${esc(x.p.name)}</div><div class="meta">Birthday${x.b.turns ? ` · turns ${x.b.turns}` : ''}</div></button></li>` })),
    ].sort((a, b) => a.at - b.at).map((x) => x.html);

    const undated = open.filter((i) => !i.due_at && !i.top3).length;
    const synced = data.settings.events_synced_at;
    const nothingToday = !rest.length;
    const tripCard = viewTripCard(open);
    // A group (with its divider) only appears when something is in it
    const tgroup = (label, html) => (html.trim() ? `<div class="tgroup" role="group" aria-label="${label}">${html}</div>` : '');

    return `
      <header class="head">
        <a class="gear" href="#settings" aria-label="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a>
        <h1>Good ${part}${name ? `, ${esc(name)}` : ''}</h1>
        <span class="summary">${esc(summary)}</span>
      </header>
      ${viewWrap(open, eod)}
      ${viewWeather()}
      ${viewFocusBanner()}
      <div class="week" role="list" aria-label="Next 7 days">${days}</div>
      ${viewSetup()}
      ${nowCard}
      ${tgroup('Today', `
        ${nothingToday
          ? `<section>${head('Today', { key: 'rest' })}${isCol('rest') ? '' : `<div class="allclear">${synced ? 'Nothing else today. Enjoy it.' : 'Nothing yet. Calendar events appear once the Shortcut runs.'}</div>`}</section>`
          : section(`Today <span class="n">${rest.length}</span>`, rest, null, { key: 'rest' })}
        ${(() => { const r = rwTodayRows(3); return r.length ? section(`Credits ending <span class="n">${r.length}</span>`, r, null, { key: 'rwsoon' }) : ''; })()}
        ${viewMeds()}
        ${viewHabits()}
        ${featured && featured.b.days === 0 ? bdayCard : ''}`)}
      ${tgroup('This week', `
        ${featured && featured.b.days > 0 ? bdayCard : ''}
        ${section(`This week <span class="n">${upcoming.length}</span>`, upcoming, null, { key: 'upcoming', add: 'go-meals', addLabel: 'Plan meals' })}
        ${viewHomeToday()}
        ${(() => { const r = rwTodayRows(7, 3); return r.length ? section(`Credits this week <span class="n">${r.length}</span>`, r, null, { key: 'rwweek' }) : ''; })()}
        ${catchUp}`)}
      ${tgroup('Later', tripCard)}
      ${undated ? `<a class="link" href="#all">${plural(undated, 'task')} without a date ›</a>` : ''}
    `;
  }

  // Next (or current) trip: countdown, what's left to book, passport check.
  const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtRange = (a, b) => {
    const s = parseDay(a), e = b ? parseDay(b) : null;
    const md = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    if (!e) return md(s);
    return s.getMonth() === e.getMonth() ? `${md(s)}–${e.getDate()}` : `${md(s)} – ${md(e)}`;
  };

  // Up to 3 upcoming trips in one card: name, dates, booking status, countdown.
  function viewTripCard(open) {
    const today = startOfDay();
    const trips = (data.trips || []).filter((t) => parseDay(t.end_date || t.start_date) >= today)
      .sort((a, b) => (a.start_date < b.start_date ? -1 : 1)).slice(0, 5);
    if (!trips.length) return '';
    const warns = new Map(); // document -> trips it may not cover
    const rows = trips.map((trip) => {
      const start = parseDay(trip.start_date), end = parseDay(trip.end_date || trip.start_date);
      const until = daysBetween(today, start);
      const len = daysBetween(start, end) + 1;
      const big = until > 0 ? `${until}` : `Day ${daysBetween(start, today) + 1}`;
      const unit = until > 0 ? (until === 1 ? 'day' : 'days') : `of ${len}`;
      const toBook = open.filter((i) => trip.external_id && (i.external_id || '').startsWith(`${trip.external_id}:`));
      const late = toBook.filter((i) => i.due_at && Date.parse(i.due_at) < Date.now()).length;
      // Booking status is known only for trips synced from Wayfare
      const bookBit = !trip.external_id ? '' : toBook.length ? ` · ${toBook.length} to book${late ? ` · <span class="late">${late} late</span>` : ''}` : ' · <span class="ok">✓ booked</span>';
      // Many countries require 6 months of passport validity after you leave.
      const sixAfter = new Date(end); sixAfter.setMonth(sixAfter.getMonth() + 6);
      for (const d of data.documents || []) if (parseDay(d.expires_on) < sixAfter) { if (!warns.has(d.id)) warns.set(d.id, { d, trips: [] }); warns.get(d.id).trips.push(trip.name); }
      const tag = trip.link ? 'a' : 'button';
      const attrs = trip.link ? ` href="${esc(trip.link)}" target="_blank" rel="noopener"` : ` type="button" data-act="trip-open" data-id="${trip.id}"`;
      return `<${tag} class="trip-row"${attrs} aria-label="${esc(trip.name)}, ${until > 0 ? `${until} days away` : 'in progress'}">
        <span style="min-width:0;flex:1"><strong class="name">${esc(trip.name)}</strong>
          <span class="dates">${esc(fmtRange(trip.start_date, trip.end_date))}${bookBit}</span></span>
        <span class="count"><b>${esc(big)}</b><span>${esc(unit)}</span></span>
      </${tag}>`;
    }).join('');
    return `<section class="trip a-travel" aria-label="Upcoming trips">
      <span class="label">${trips.length > 1 ? 'Upcoming trips' : daysBetween(today, parseDay(trips[0].start_date)) > 0 ? 'Next trip' : 'On your trip'}</span>
      ${rows}
      ${[...warns.values()].map(({ d, trips }) => `<div class="trip-warn">${esc(d.name)} expires ${esc(parseDay(d.expires_on).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}: check it covers ${esc(new Intl.ListFormat('en', { type: 'conjunction' }).format(trips))}.</div>`).join('')}
    </section>`;
  }

  // Today's event detail: countdown and place.
  function eventMeta(e, now) {
    if (e.all_day) return e.location ? esc(e.location) : '';
    const parts = [];
    if (Date.parse(e.start_at) > now.getTime()) parts.push(`in ${untilText(e.start_at)}`);
    if (e.location) parts.push(esc(e.location));
    return parts.join(' · ');
  }

  // ---------- weather ----------
  function weatherIcon(text = '') {
    const t = text.toLowerCase();
    const p = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    if (/thunder/.test(t)) return `<svg viewBox="0 0 24 24" ${p}><path d="M17.5 17a4.5 4.5 0 0 0-1-8.9A6 6 0 0 0 5 9.5 4 4 0 0 0 6 17"/><path d="M13 12l-3 5h4l-3 5"/></svg>`;
    if (/snow|flurr|sleet|ice/.test(t)) return `<svg viewBox="0 0 24 24" ${p}><path d="M17.5 15a4.5 4.5 0 0 0-1-8.9A6 6 0 0 0 5 7.5 4 4 0 0 0 6 15"/><path d="M8 19h.01M12 21h.01M16 19h.01M12 17h.01"/></svg>`;
    if (/rain|shower|drizzle/.test(t)) return `<svg viewBox="0 0 24 24" ${p}><path d="M17.5 15a4.5 4.5 0 0 0-1-8.9A6 6 0 0 0 5 7.5 4 4 0 0 0 6 15"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg>`;
    if (/fog|haze|smoke/.test(t)) return `<svg viewBox="0 0 24 24" ${p}><path d="M4 10h16M3 14h18M6 18h12"/></svg>`;
    const night = new Date().getHours() >= 18 || new Date().getHours() < 6;
    if (night && /clear/.test(t)) return `<svg viewBox="0 0 24 24" ${p}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>`;
    if (/cloud|overcast/.test(t) && !/partly|mostly sunny|mostly clear/.test(t)) return `<svg viewBox="0 0 24 24" ${p}><path d="M17.5 19a4.5 4.5 0 0 0-1-8.9A6 6 0 0 0 5 11.5 4 4 0 0 0 6 19z"/></svg>`;
    if (/partly|mostly/.test(t)) return `<svg viewBox="0 0 24 24" ${p}><path d="M8 3v1M3.5 5.5l.7.7M2 10h1M12.5 5.5l-.7.7"/><path d="M5.6 12A4 4 0 1 1 12 7.2"/><path d="M17.5 20a4 4 0 0 0-.8-7.9A5 5 0 0 0 7 13.5 3.5 3.5 0 0 0 7.5 20z"/></svg>`;
    if (/night|clear/.test(t) && new Date().getHours() >= 18) return `<svg viewBox="0 0 24 24" ${p}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>`;
    return `<svg viewBox="0 0 24 24" ${p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
  }

  function viewWeather() {
    if (!weather) return '';
    if (!weather.configured) return `<a class="link" href="#settings" style="padding:0;margin-top:-10px">+ Add your weather</a>`;
    if (weather.error || !weather.now) return '';
    const day = weather.periods.find((x) => x.day), night = weather.periods.find((x) => !x.day);
    const morning = new Date().getHours() < 12;
    const rain = (day && day.rain) || weather.now.rain;
    return `<a class="weather${morning ? ' big' : ''}" href="weather://" aria-label="Weather. Open the Weather app">
      <span class="wicon" aria-hidden="true">${weatherIcon(weather.now.text)}</span>
      <span class="wnow">${esc(weather.now.temp)}°</span>
      <span class="wtext"><strong>${esc(weather.now.text)}</strong>
        <span>${[day ? `High ${esc(day.temp)}°` : '', night ? `Low ${esc(night.temp)}°` : '', rain ? `${esc(rain)}% rain` : ''].filter(Boolean).join(' · ')}</span></span>
    </a>`;
  }

  // Medications are tasks (kind "med"). The medication lists still read data.meds / data.med_logs,
  // so build those from the tasks in the shape they expect.
  function medsFromTasks() {
    const mine = (data.tasks || []).filter((t) => t.kind === 'med' && (!data.me || t.user_id === data.me.id));
    data.meds = mine.map((t) => { const sch = TK.asSchedule(t) || {}; const d = t.details || {};
      return { id: t.id, task: t, name: t.title, dose: d.dose || null, notes: d.notes || null, ...sch, times: sch.times || t.time || '08:00', remind: t.nag ? 'hourly' : 'none', active: 1 }; });
    const ids = new Set(mine.map((t) => t.id));
    data.med_logs = (data.task_log || []).filter((l) => ids.has(l.task_id) && l.occ.length > 10)
      .map((l) => ({ med_id: l.task_id, date: l.occ.slice(0, 10), slot: l.occ.slice(11), status: l.status === 'skipped' ? 'skipped' : 'taken', taken_at: l.at }));
  }

  // ---------- tasks (the one task model; see docs/tasks-design.md) ----------
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const myHabits = () => (data.tasks || []).filter((t) => t.kind === 'habit' && (!data.me || t.user_id === data.me.id));
  const taskById = (id) => (data.tasks || []).find((t) => t.id === id);
  const taskLog = (t) => (data.task_log || []).filter((l) => l.task_id === t.id);
  const TASK_MAIN = { habit: 'Done', task: 'Done', med: 'Taken' };
  const TASK_ICON = { habit: 'check', task: 'check', med: 'pill' };
  const TASK_NOUN = { habit: 'habit', task: 'task', med: 'medication' };
  const dayLabel = (d) => { const t = todayYmd(); if (d === t) return 'Today'; if (d === TK.addDays(t, 1)) return 'Tomorrow'; if (d === TK.addDays(t, -1)) return 'Yesterday'; return parseDay(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };

  // The occurrence the main button acts on: today's first one not done, a missed one-off,
  // or the next one coming up.
  function taskOcc(t) {
    const today = todayYmd();
    const logs = new Map(taskLog(t).map((l) => [l.occ, l]));
    const list = TK.occurrencesOn(t, today).map((tm) => ({ date: today, time: tm, key: TK.occKey(today, tm) }));
    if (list.length) { const o = list.find((x) => !logs.get(x.key)) || list[list.length - 1]; return { ...o, log: logs.get(o.key) || null }; }
    if ((!t.repeat || t.repeat === 'never') && t.date) { const key = TK.occKey(t.date, t.time || ''); return { date: t.date, time: t.time || '', key, log: logs.get(key) || null }; }
    const next = t.date ? TK.nextDate(t, today) : null;
    if (!next) return null;
    const tm = TK.occurrencesOn(t, next)[0] || '';
    const key = TK.occKey(next, tm);
    return { date: next, time: tm, key, log: logs.get(key) || null, future: true };
  }
  const streakOf = (t) => TK.streak(t, taskLog(t), todayYmd());
  const flame = (n) => `<span class="tk-fire${n ? '' : ' zero'}" aria-label="${n}-time streak">${n} 🔥</span>`;

  async function taskDo(t, status, occ = taskOcc(t)) {
    if (!occ) return;
    await api(`/api/tasks/${t.id}/log`, { body: { occ: occ.key, status } });
    await refresh();
    const s = streakOf(taskById(t.id) || t).current;
    toast(status === 'skipped' ? 'Skipped' : status === 'undo' ? 'Undone' : s > 1 ? `Nice: ${s} in a row 🔥` : 'Done',
      status === 'undo' ? null : async () => { await api(`/api/tasks/${t.id}/log`, { body: { occ: occ.key, status: 'undo' } }); await refresh(); });
  }

  function openTask(t0) {
    const isNew = !t0.id;
    const t = { kind: 'task', repeat: 'never', nag: 0, nag_mode: 'hourly', date: todayYmd(), time: null, details: {}, ...t0 };
    const details = t.details || {};
    const occ = isNew ? null : taskOcc(t);
    const st = TK.streak(t, taskLog(t), todayYmd());
    const done = occ && occ.log && occ.log.status !== 'skipped';
    const status = isNew ? '' : !t.date ? 'No date' : occ ? `${occ.future ? 'Next: ' : ''}${dayLabel(occ.date)}${occ.time ? ` ${fmtSlot(occ.time)}` : ''}${done ? ' · done' : occ.log ? ' · skipped' : ''}` : 'Finished';
    // Custom repeat uses the same chip picker as medications
    const cst = medState({ id: t.repeat === 'custom' ? 1 : 0, ...(t.repeat === 'custom' && t.custom ? { freq: t.custom.freq, interval_n: t.custom.interval_n, weekdays: t.custom.weekdays, month_days: t.custom.month_days, times: t.custom.times || t.time || '08:00', dose_times: t.custom.dose_times ? JSON.stringify(t.custom.dose_times) : null } : { times: t.time || '08:00' }), start_date: t.date || todayYmd() });
    const users = data.users || [];
    const opt = (list, sel) => list.map(([v, l]) => `<option value="${v}"${String(sel) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const sw = (name, on, label) => `<label class="tk-row"><span>${label}</span><input type="checkbox" class="tk-switch" name="${name}"${on ? ' checked' : ''}></label>`;
    const recent = isNew ? [] : TK.recent(t, taskLog(t), todayYmd(), 14);
    const lastDone = isNew ? null : taskLog(t).filter((l) => l.status !== 'skipped').sort((a, z) => z.occ.localeCompare(a.occ))[0];
    sheet.innerHTML = `<form method="dialog" class="tk-sheet">
      <div class="tk-head"><span class="tk-icon">${kindMark(TASK_ICON[t.kind] || 'check', 'k-task')}</span>
        <div class="tk-title"><h3>${isNew ? `New ${TASK_NOUN[t.kind] || 'task'}` : esc(t.title)}${!isNew && details.dose ? ` <span class="tk-dose">${esc(details.dose)}</span>` : ''}</h3>${status ? `<p class="sub">${esc(status)}</p>` : ''}</div>
        ${isNew ? '' : flame(st.current)}</div>
      ${isNew || !occ ? '' : `<div class="tk-main">
        ${done ? `<button type="button" class="btn ok big" data-tk="undo">✓ ${esc(TASK_MAIN[t.kind] || 'Done')} · Undo</button>` : `<button type="button" class="btn dark big" data-tk="done">${esc(TASK_MAIN[t.kind] || 'Done')}</button>`}
        ${done ? '' : `<div class="btns2"><button type="button" class="btn ghost" data-tk="skip">${t.kind === 'med' ? 'Skip this dose' : `Skip${occ.future ? '' : ' this time'}`}</button>${t.nag ? '<button type="button" class="btn ghost" data-tk="snooze">Snooze 1h</button>' : ''}</div>`}
      </div>`}
      <div class="lbl">Details</div>
      <div class="tk-group">
        <label class="tk-row tk-in"><span>Name</span><input name="title" value="${esc(t.title || '')}" required maxlength="120" placeholder="${{ habit: 'Workout', med: 'Vitamin D' }[t.kind] || 'Call the plumber'}"></label>
        ${t.kind === 'med' ? `<label class="tk-row tk-in"><span>Dose</span><input name="dose" value="${esc(details.dose || '')}" maxlength="60" placeholder="10 mg"></label>` : ''}
        <label class="tk-row tk-in"><span>Notes</span><input name="notes" value="${esc(details.notes || '')}" maxlength="300" placeholder="Optional"></label>
      </div>
      <div class="lbl">Schedule</div>
      <div class="tk-group">
        ${sw('has_date', !!t.date, `${kindMark('calendar')} Date`)}
        <label class="tk-row tk-sub" data-tkshow="date"><span>On</span><input type="date" name="date" value="${esc(t.date || todayYmd())}"></label>
        ${sw('has_time', !!t.time, `${kindMark('clock')} Time`)}
        <label class="tk-row tk-sub" data-tkshow="time"><span>At</span><input type="time" name="time" value="${esc(t.time || '08:00')}"></label>
        <label class="tk-row" data-tkshow="date"><span>${kindMark('repeat')} Repeat</span><select name="repeat">${opt(TK.REPEATS, t.repeat || 'never')}</select></label>
        <div class="tk-custom" data-tkshow="custom"><div class="mpresets chips-wrap"></div><div class="mpanel"></div><p class="msum"></p></div>
      </div>
      <div class="lbl">Reminders</div>
      <div class="tk-group">
        ${sw('nag', !!t.nag, 'Nag until done')}
        <label class="tk-row tk-sub" data-tkshow="nag"><span>How often</span><select name="nag_mode">${opt([['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly']], t.nag_mode || 'hourly')}</select></label>
        <label class="tk-row tk-sub" data-tkshow="nagday"><span>On</span><select name="nag_dow">${opt(WEEKDAY_NAMES.map((d, i) => [i, d]), t.nag_dow ?? 1)}</select></label>
        <label class="tk-row tk-sub" data-tkshow="nagtime"><span>At</span><input type="time" name="nag_time" value="${esc(t.nag_time || '09:00')}"></label>
        ${users.length > 1 ? `<label class="tk-row" data-tkshow="nag"><span>For</span><select name="remind_to">${opt([['', 'Me'], ...users.filter((u) => !data.me || u.id !== data.me.id).map((u) => [u.id, u.name]), [0, 'Both of us']], t.remind_to ?? '')}</select></label>` : ''}
        ${users.length > 1 && t.kind !== 'habit' ? sw('shared', !!t.shared, `Shared with ${esc(others().map((u) => u.name).join(', '))}`) : ''}
      </div>
      ${isNew ? '' : `<div class="lbl">History</div>
      <div class="tk-group">
        <div class="tk-strip" role="img" aria-label="Recent: ${recent.filter((r) => r.status === 'done' || r.status === 'partial').length} of ${recent.length} done">${recent.map((r) => `<i class="${r.status}" title="${esc(dayLabel(r.d))}${r.time ? ` ${fmtSlot(r.time)}` : ''}: ${r.status}"></i>`).join('')}</div>
        <div class="tk-row"><span class="meta">${lastDone ? `Last done ${esc(dayLabel(lastDone.occ.slice(0, 10)))}` : 'Not done yet'} · best ${st.best}</span><button type="button" class="link" data-tk="all">All ›</button></div>
        <div class="tk-all" hidden>${taskLog(t).sort((a, z) => z.occ.localeCompare(a.occ)).slice(0, 60).map((l) => `<div class="tk-row"><span>${esc(dayLabel(l.occ.slice(0, 10)))}${l.occ.length > 10 ? ` ${fmtSlot(l.occ.slice(11))}` : ''} · ${l.status === 'skipped' ? 'skipped' : 'done'}</span><button type="button" class="pbtn icon" data-tkdel="${esc(l.occ)}" aria-label="Remove this entry">×</button></div>`).join('') || '<div class="tk-row meta">Nothing yet</div>'}</div>
      </div>`}
      <div class="actions">${isNew ? '' : '<button type="button" class="btn danger" data-tk="remove">Remove</button>'}<span class="grow"></span>
        <button type="button" class="btn ghost" data-sheet="close">${isNew ? 'Cancel' : 'Close'}</button><button type="submit" class="btn dark">Save</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    const show = () => {
      const has = (n) => form[n] && form[n].checked;
      const vis = { date: has('has_date'), time: has('has_date') && has('has_time') && form.repeat.value !== 'custom', custom: has('has_date') && form.repeat.value === 'custom',
        nag: has('nag'), nagday: has('nag') && form.nag_mode.value === 'weekly', nagtime: has('nag') && form.nag_mode.value !== 'hourly' };
      form.querySelectorAll('[data-tkshow]').forEach((el) => { el.hidden = !vis[el.dataset.tkshow]; });
      form.querySelector('label.tk-row:has([name="has_time"])').hidden = !vis.date || form.repeat.value === 'custom';
    };
    const drawCustom = () => {
      const box = form.querySelector('.tk-custom');
      const count = { '2day': cst.dayTimes.length, '2week': cst.days.length, '2month': cst.dates.length };
      box.querySelector('.mpresets').innerHTML = MED_PRESETS.map(([k, v]) => `<button type="button" class="chip-btn" role="radio" aria-checked="${cst.p === k}" data-mp="${k}">${cst.p === k && count[k] > 2 ? v.replace('2×', `${count[k]}×`) : v}</button>`).join('');
      box.querySelector('.mpanel').innerHTML = medPanel(cst);
      box.querySelector('.msum').textContent = medSummary(cst);
    };
    drawCustom(); bindMedPicker(form.querySelector('.tk-custom'), cst, drawCustom);
    form.addEventListener('change', (e) => { if (['has_date', 'has_time', 'repeat', 'nag', 'nag_mode'].includes(e.target.name)) show(); });
    show();
    form.querySelectorAll('[data-tk]').forEach((b) => { b.onclick = async () => {
      const a = b.dataset.tk;
      try {
        if (a === 'done' || a === 'skip') { sheet.close(); await taskDo(t, a === 'done' ? 'done' : 'skipped', occ); }
        else if (a === 'undo') { await taskDo(t, 'undo', occ); openTask(taskById(t.id)); }
        else if (a === 'snooze') { await api(`/api/tasks/${t.id}/snooze`, { body: { minutes: 60 } }); sheet.close(); await refresh(); toast('Snoozed 1 hour'); }
        else if (a === 'all') { const box = form.querySelector('.tk-all'); box.hidden = !box.hidden; }
        else if (a === 'remove') { if (!confirm(`Remove "${t.title}"? Its history is kept in backups.`)) return; await api(`/api/tasks/${t.id}`, { method: 'DELETE' }); sheet.close(); await refresh(); toast('Removed'); }
      } catch (err) { toast(err.message); }
    }; });
    form.querySelectorAll('[data-tkdel]').forEach((b) => { b.onclick = async () => {
      try { await api(`/api/tasks/${t.id}/log`, { body: { occ: b.dataset.tkdel, status: 'undo' } }); await refresh(); openTask(taskById(t.id)); } catch (err) { toast(err.message); }
    }; });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const hasDate = !!form.has_date.checked, repeat = hasDate ? f.get('repeat') : 'never';
      if (t.kind === 'med' && (!hasDate || (repeat !== 'custom' && !form.has_time.checked))) { toast('Medications need a date and a time'); return; }
      const body = { kind: t.kind, title: f.get('title').trim(), details: { ...details, notes: f.get('notes').trim() || undefined, ...(f.has('dose') ? { dose: f.get('dose').trim() || undefined } : {}) },
        date: hasDate ? f.get('date') : null, time: hasDate && form.has_time.checked && repeat !== 'custom' ? f.get('time') : null, repeat, custom: null,
        nag: form.nag.checked ? 1 : 0, nag_mode: f.get('nag_mode'), nag_time: f.get('nag_time'), nag_dow: +f.get('nag_dow') };
      if (f.has('remind_to')) body.remind_to = f.get('remind_to') === '' ? null : +f.get('remind_to');
      if (form.shared) body.shared = form.shared.checked ? 1 : 0;
      if (repeat === 'custom') {
        const sch = medPickerSchedule(cst, body.date);
        if (sch.error) { toast(sch.error); return; }
        body.custom = { freq: sch.freq, interval_n: sch.interval_n, weekdays: sch.weekdays, month_days: sch.month_days, times: sch.times, dose_times: sch.dose_times };
        if (sch.start_date) body.date = sch.start_date;
      }
      if (!body.title) { toast('Give it a name'); return; }
      try {
        if (isNew) await api('/api/tasks', { body }); else await api(`/api/tasks/${t.id}`, { method: 'PATCH', body });
        sheet.close(); await refresh(); toast('Saved');
      } catch (err) { toast(err.message); }
    };
    showSheet();
  }

  // ---------- habits (tasks of kind "habit") ----------
  function viewHabits() {
    const today = todayYmd();
    const habits = myHabits().filter((t) => TK.isDueOn(t, today));
    if (!habits.length) return '';
    const doneNow = (t) => { const o = taskOcc(t); return !!(o && !o.future && o.log && o.log.status !== 'skipped'); };
    const left = habits.filter((t) => !doneNow(t)).length;
    return `<section aria-label="Habits">
      ${head(`Habits <span class="n">${left ? `${left} to go` : 'all done ✓'}</span>`, { key: 'habits', add: 'edit-habits', addLabel: 'Edit habits' })}
      ${isCol('habits') ? '' : `<div class="habits">${habits.map((t) => {
        const on = doneNow(t);
        const s = streakOf(t).current;
        return `<button type="button" class="habit${on ? ' on' : ''}" data-act="habit" data-id="${t.id}" aria-pressed="${on}" aria-label="${esc(t.title)}${s ? `, ${s} in a row` : ''}. Press and hold for details">
          <span class="hcheck" aria-hidden="true">${on ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>' : ''}</span>
          <span class="hname">${esc(t.title)}</span>${s ? `<span class="hstreak">${s} 🔥</span>` : ''}
        </button>`;
      }).join('')}</div>`}
    </section>`;
  }

  function openHabits() {
    const rows = myHabits().map((t) => { const s = streakOf(t);
      return `<li class="row"><button type="button" class="row-main" data-hopen="${t.id}"><div class="t">${esc(t.title)}</div><div class="meta">${esc(TK.describeRepeat(t))}${t.nag ? ` · ${esc(TK.describeNag(t))}` : ''} · best ${s.best}</div></button>${flame(s.current)}</li>`; }).join('');
    sheet.innerHTML = `<form method="dialog">
      <h3>Habits</h3>
      <p class="sub">Things you want to keep up. Tap one on Today to check it off; press and hold it for its streak, history and schedule.</p>
      ${rows ? `<div class="card no-when"><ul class="list">${rows}</ul></div>` : ''}
      <div class="actions"><span class="grow"></span><button type="button" class="btn ghost" data-sheet="close">Close</button><button type="button" class="btn dark" data-hnew="1">Add a habit</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    form.querySelector('[data-hnew]').onclick = () => openTask({ kind: 'habit', repeat: 'daily' });
    form.querySelectorAll('[data-hopen]').forEach((b) => { b.onclick = () => openTask(taskById(+b.dataset.hopen)); });
    showSheet();
  }

  // ---------- focus mode ----------
  let focusTimer = null;
  let focusHidden = false;
  const focusActive = () => data.settings.focus_until && Date.parse(data.settings.focus_until) > Date.now();
  function viewFocusBanner() {
    if (!focusActive()) return '';
    return `<button type="button" class="focus-banner" data-act="focus-open">Focusing · nags paused until ${esc(fmtTime(data.settings.focus_until))} ›</button>`;
  }

  function renderFocusOverlay() {
    let el = document.getElementById('focus');
    if (!focusActive()) { if (el) el.remove(); clearInterval(focusTimer); focusTimer = null; return; }
    if (!el) { el = document.createElement('div'); el.id = 'focus'; el.className = 'focus'; document.body.appendChild(el); }
    const item = data.items.find((i) => String(i.id) === String(data.settings.focus_item));
    const left = Math.max(0, Date.parse(data.settings.focus_until) - Date.now());
    const mm = Math.floor(left / 60000), ss = Math.floor(left / 1000) % 60;
    el.innerHTML = `<div class="focus-inner" role="dialog" aria-label="Focus mode">
      <span class="label">Focus · nags paused</span>
      <h2>${esc(item ? item.title : 'Deep work')}</h2>
      <div class="clock" aria-live="off">${mm}:${String(ss).padStart(2, '0')}</div>
      <div class="btns2">
        ${item ? `<button type="button" class="btn accent" data-focus="done">Done</button>` : ''}
        <button type="button" class="btn" data-focus="stop">${item ? 'Stop' : 'End focus'}</button>
      </div>
      <button type="button" class="link" data-focus="hide" style="text-align:center;color:var(--muted)">Hide timer</button>
    </div>`;
    el.querySelector('[data-focus="stop"]').onclick = () => endFocus();
    const doneBtn = el.querySelector('[data-focus="done"]');
    if (doneBtn) doneBtn.onclick = async () => { await endFocus(); await markDone(item.id); };
    el.hidden = focusHidden;
    el.querySelector('[data-focus="hide"]').onclick = () => { focusHidden = true; el.hidden = true; };
    if (!focusTimer) focusTimer = setInterval(() => {
      if (!focusActive()) { clearInterval(focusTimer); focusTimer = null; toast('Focus session done'); refresh().catch(() => {}); return; }
      const box = document.getElementById('focus');
      if (box) { const l = Date.parse(data.settings.focus_until) - Date.now(); const c = box.querySelector('.clock'); if (c) c.textContent = `${Math.floor(l / 60000)}:${String(Math.floor(l / 1000) % 60).padStart(2, '0')}`; }
    }, 1000);
  }

  async function startFocus(itemId, minutes = 25) {
    focusHidden = false;
    data.settings = await api('/api/focus', { body: { minutes, item_id: itemId || null } });
    render();
  }
  async function endFocus() {
    data.settings = await api('/api/focus', { method: 'DELETE' });
    render();
  }

  // ---------- meals ----------
  const MEAL_KINDS = { cook: 'Cooking', out: 'Eating out', leftovers: 'Leftovers', skip: 'No dinner needed' };
  const mealFor = (date) => (data.meals || []).find((x) => x.date === date) || null;
  const mealLine = (ml) => !ml ? '' : ml.kind === 'cook' ? ml.title : ml.kind === 'out' ? `Eating out${ml.title ? ` · ${ml.title}` : ''}` : ml.kind === 'leftovers' ? `Leftovers${ml.title ? ` · ${ml.title}` : ''}` : 'No dinner needed';
  // Evening calendar plans that might replace dinner at home (3pm or later, or all-day)
  const eveningPlans = (date) => {
    const d0 = parseDay(date), d1 = new Date(+d0 + DAY);
    return data.events.filter((e) => !(e.pref && e.pref.hidden) && !e.all_day && new Date(e.start_at) >= d0 && new Date(e.start_at) < d1 && new Date(e.start_at).getHours() >= 15);
  };
  // Meal weeks run Sunday through Saturday; planning starts over each Sunday.
  const mealWeekDays = (offset = 0) => { const s0 = startOfDay(); s0.setDate(s0.getDate() - s0.getDay() + offset * 7);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(s0); d.setDate(d.getDate() + i); return d; }); };
  const nightsLeftThisWeek = () => mealWeekDays(0).map(ymd).filter((d) => d >= todayYmd() && !mealFor(d)).length;
  const mealIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3v8a3 3 0 0 0 6 0V3M7 3v18M17 21V3c-2 1.5-3 4-3 7s1 4 3 4"/></svg>';

  function viewDinnerCard() {
    const date = todayYmd();
    const ml = mealFor(date);
    const plans = eveningPlans(date);
    const unplanned = nightsLeftThisWeek();
    return `<div class="dinner">
      <button type="button" class="dinner-main" data-act="meal-open" data-date="${date}">
        <span class="dicon">${mealIcon}</span>
        <span style="min-width:0;flex:1"><span class="label">Dinner tonight</span>
          <strong>${ml ? esc(mealLine(ml)) : plans.length ? `Plans: ${esc(plans[0].title)}` : 'Not planned yet'}</strong></span>
      </button>
      <a class="dinner-week" href="#meals">${unplanned ? `${plural(unplanned, 'night')} to plan` : 'Week planned ✓'} ›</a>
    </div>`;
  }

  function viewMeals() {
    const days = mealWeekDays(ui.mealWeek);
    const left = days.filter((d) => ymd(d) >= todayYmd() && !mealFor(ymd(d))).length;
    const range = `${days[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    const rows = days.map((d) => {
      const date = ymd(d), ml = mealFor(date), plans = eveningPlans(date);
      const meta = [ml && ml.notes ? esc(ml.notes) : '', plans.length ? `Plans: ${esc(plans.map((p) => `${p.title} ${fmtTime(p.start_at)}`).join(', '))}` : '', ml && ml.link ? 'recipe' : ''].filter(Boolean).join(' · ');
      const isToday = date === todayYmd();
      const past = date < todayYmd();
      return `<li class="row${past ? ' past' : ''}${ui.mealSaved === date ? ' just-saved' : ''}"><span class="when">${isToday ? 'Today' : esc(weekday(d))}<br><span style="font-weight:500">${d.getDate()}</span></span>
        <button type="button" class="row-main" data-act="meal-open" data-date="${date}">
          <div class="t${ml ? '' : ' muted-t'}">${ml ? esc(mealLine(ml)) : 'Not planned'}</div>${meta ? `<div class="meta">${meta}</div>` : ''}
        </button></li>`;
    }).join('');
    return `
      <header class="head-row"><h1>Meals</h1><a class="link" href="#today" style="padding:0">‹ Today</a></header>
      <div class="filters" role="group" aria-label="Week"><button type="button" data-act="meal-week" data-v="0" aria-pressed="${ui.mealWeek === 0}">This week</button><button type="button" data-act="meal-week" data-v="1" aria-pressed="${ui.mealWeek === 1}">Next week</button></div>
      <p class="home-sum" style="margin:0">${esc(range)} · ${left ? `${plural(left, 'night')} to plan` : 'all planned ✓'}. Evening calendar plans show under each day.</p>
      <div class="card"><ul class="list">${rows}</ul></div>
    `;
  }

  function openMeal(date) {
    const ml = mealFor(date) || { kind: 'cook' };
    const d = parseDay(date);
    const plans = eveningPlans(date);
    const recent = (data.meal_titles || []).slice(0, 10);
    sheet.innerHTML = `<form method="dialog">
      <h3>${esc(d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))}</h3>
      ${plans.length ? `<p class="sub">On your calendar: ${esc(plans.map((p) => `${p.title} at ${fmtTime(p.start_at)}`).join(', '))}</p>` : ''}
      <div class="filters" role="radiogroup" aria-label="Dinner plan">${Object.entries(MEAL_KINDS).map(([k, v]) => `<button type="button" data-kind="${k}" aria-pressed="${ml.kind === k}">${v}</button>`).join('')}</div>
      <label class="field" data-mk="title"><span data-mk-label>What's for dinner?</span><input name="title" value="${esc(ml.title || '')}" list="meal-list" maxlength="120" placeholder="Tacos"></label>
      <datalist id="meal-list">${recent.map((r) => `<option value="${esc(r.title)}">`).join('')}</datalist>
      ${recent.length ? `<div class="chips-scroll filters" data-mk="recent" aria-label="Recent meals">${recent.map((r, i) => `<button type="button" data-recent="${i}">${esc(r.title)}</button>`).join('')}</div>` : ''}
      <label class="field" data-mk="link"><span>Recipe link</span><input name="link" type="url" value="${esc(ml.link || '')}" placeholder="https://"></label>
      <label class="field"><span>Notes</span><input name="notes" value="${esc(ml.notes || '')}" maxlength="500" placeholder="thaw chicken in the morning"></label>
      <div class="actions">${ml.date ? '<button type="button" class="btn danger" data-sheet="clear">Clear</button>' : ''}<span class="grow"></span>
        <button type="button" class="btn ghost" data-sheet="close">Cancel</button><button type="submit" class="btn dark">Save</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    let kind = ml.kind || 'cook';
    const sync = () => {
      form.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
      form.querySelector('[data-mk="title"]').hidden = kind === 'skip';
      form.querySelector('[data-mk-label]').textContent = kind === 'out' ? 'Where? (optional)' : kind === 'leftovers' ? 'Leftovers from? (optional)' : "What's for dinner?";
      form.querySelectorAll('[data-mk="recent"], [data-mk="link"]').forEach((el) => { el.hidden = kind !== 'cook'; });
    };
    sync();
    form.querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => { kind = b.dataset.kind; sync(); }; });
    form.querySelectorAll('[data-recent]').forEach((b) => { b.onclick = () => { const r = recent[+b.dataset.recent]; form.title.value = r.title; if (r.link && !form.link.value) form.link.value = r.link; }; });
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    const clear = form.querySelector('[data-sheet="clear"]');
    if (clear) clear.onclick = async () => { await api(`/api/meals/${date}`, { method: 'DELETE' }); sheet.close(); await refresh(); toast('Cleared'); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/meals/${date}`, { method: 'PUT', body: { kind, title: kind === 'skip' ? null : form.title.value.trim() || null, link: kind === 'cook' ? form.link.value.trim() || null : null, notes: form.notes.value.trim() || null } });
        sheet.close();
        ui.mealSaved = date; // briefly highlight the row you just saved
        await refresh();
        setTimeout(() => { ui.mealSaved = null; }, 1500);
        toast('Saved');
      } catch (err) { toast(err.message); }
    };
    showSheet();
  }

  // ---------- home maintenance ----------
  const homeLast = (id) => { const l = (data.home_log || []).find((x) => x.task_id === id); return l ? l.date : null; };
  const homeInfo = (t) => homeDue(t, homeLast(t.id), todayYmd());
  const fmtYmd = (s, opts = { month: 'short', day: 'numeric' }) => parseDay(s).toLocaleDateString([], opts);

  const shortDue = (i) => (i.completed ? 'Done' : i.k < 0 ? `${-i.k}d late` : i.k === 0 ? 'Today' : i.k === 1 ? 'Tmrw' : i.k <= 6 ? weekday(parseDay(i.due)) : fmtYmd(i.due));
  // Home row: checkbox, room icon, title (up to 2 lines), and when it's due. Frequency etc. live in the task sheet.
  function homeRow(t, info) {
    const icon = `<span class="ricon sm" title="${esc(t.room || '')}">${roomIcon(t.room)}</span>`;
    const due = `<span class="hdue ${info.cls}">${esc(shortDue(info))}</span>`;
    const title = `<div class="t t2">${esc(t.name)}</div>${info.snoozed ? '<div class="meta">snoozed</div>' : ''}`;
    if (ui.homeSelect) {
      const on = ui.homeSelect.has(t.id);
      return `<li class="row hrow${on ? ' picked' : ''}"><div class="row-inner">
        <button type="button" class="check${on ? ' done' : ''}" data-act="home-pick" data-id="${t.id}" aria-pressed="${on}" aria-label="Select ${esc(t.name)}"></button>${icon}
        <button type="button" class="row-main" data-act="home-pick" data-id="${t.id}">${title}</button>${due}</div></li>`;
    }
    return `<li class="row sw hrow" data-swipe="${t.id}" data-kind="home"><div class="row-inner">
      <button type="button" class="check" data-act="home-done" data-id="${t.id}" aria-label="Done today: ${esc(t.name)}"></button>${icon}
      <button type="button" class="row-main" data-act="home-open" data-id="${t.id}">${title}</button>${due}
    </div></li>`;
  }

  function viewHomeToday() {
    const rows = (data.home_tasks || []).map((t) => ({ t, i: homeInfo(t) })).filter((x) => !x.i.completed && x.i.k <= 6).sort((a, b) => a.i.k - b.i.k);
    if (!rows.length) return '';
    return `<section>${head(`Home this week <span class="n">${rows.length}</span>`, { key: 'home', add: 'home-new', addLabel: 'Add a home task' })}${isCol('home') ? '' : `${listCard(rows.slice(0, 5).map((x) => homeRow(x.t, x.i)))}
      ${rows.length > 5 ? `<a class="link" href="#home">${rows.length - 5} more in Home ›</a>` : ''}`}</section>`;
  }

  function viewHome() {
    const today = todayYmd(), end = daysToMonthEnd(today);
    const all = (data.home_tasks || []).map((t) => ({ t, i: homeInfo(t) }));
    const inRoom = (x) => !ui.homeRoom || x.t.room === ui.homeRoom;
    const live = all.filter((x) => !x.i.completed && inRoom(x)).sort((a, b) => a.i.k - b.i.k);
    const over = live.filter((x) => x.i.k < 0), week = live.filter((x) => x.i.k >= 0 && x.i.k <= 6), later = live.filter((x) => x.i.k > 6 && x.i.k <= end);
    const mins = [...over, ...week, ...later].reduce((n, x) => n + minutesOf(x.t.est), 0);
    const doneMonth = (data.home_log || []).filter((l) => !l.skipped && l.date.slice(0, 7) === today.slice(0, 7)).length;
    const fmtMins = (m) => (m >= 60 ? `${Math.round(m / 6) / 10} h` : `${m} min`);
    const v = ui.homeView;
    const tiles = `<div class="htiles" role="group" aria-label="Summary">${[['late', 'Past due', over.length, 'g-late'], ['soon', 'This week', week.length, 'g-week'], ['ok', 'Later this month', later.length, 'g-later']]
      .map(([cls, label, n, to]) => `<button type="button" class="htile ${cls}${n ? '' : ' zero'}" data-act="home-jump" data-to="${to}"><b>${n}</b><span>${label}</span></button>`).join('')}</div>
      ${mins || doneMonth ? `<p class="home-sum">${mins ? `About ${fmtMins(mins)} of work left this month` : ''}${mins && doneMonth ? ' · ' : ''}${doneMonth ? `${doneMonth} done so far` : ''}</p>` : ''}`;
    const filterRow = `<div class="hfilter">
        <div class="seg3" role="group" aria-label="View">${[['now', 'To do'], ['room', 'By room'], ['all', 'All']].map(([k, l]) => `<button type="button" data-act="home-view" data-v="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>
        <button type="button" class="room-pick" data-act="home-room-pick" aria-label="Filter by room">${ui.homeRoom ? `<span class="ricon xs">${roomIcon(ui.homeRoom)}</span>${esc(ui.homeRoom)}` : 'All rooms'} ▾</button>
      </div>`;
    const group = (id, title, xs, opt = {}) => {
      if (!xs.length) return '';
      const folded = opt.key ? isFolded(opt.key, opt.def) : false;
      return `<section id="${id}">${head(`${title} <span class="n">${xs.length}</span>`, opt)}${folded ? '' : listCard(xs.map((x) => homeRow(x.t, x.i)))}</section>`;
    };
    let body = '';
    if (v === 'now') {
      body = group('g-late', 'Past due', over) + group('g-week', 'This week', week) + group('g-later', 'Later this month', later, { key: 'home-later', def: true });
      if (!over.length && !week.length && !later.length) body = '<div class="allclear">Nothing due this month. Nice.</div>';
    } else if (v === 'room') {
      const due = live.filter((x) => x.i.k <= 30);
      const rooms = [...new Set(due.map((x) => x.t.room || 'Whole Home'))].sort();
      body = rooms.map((r) => { const xs = due.filter((x) => (x.t.room || 'Whole Home') === r);
        return `<section>${head(`<span class="ricon xs">${roomIcon(r)}</span>${esc(r)} <span class="n">${xs.length}</span>`, { key: `room:${r}` })}${isFolded(`room:${r}`) ? '' : listCard(xs.map((x) => homeRow(x.t, x.i)))}</section>`; }).join('')
        || '<div class="allclear">Nothing due in the next 30 days.</div>';
      body = `<p class="home-sum" style="margin:0">Due in the next 30 days, by room.</p>${body}`;
    } else {
      const q = ui.homeQ.trim().toLowerCase();
      const list = all.filter((x) => inRoom(x) && (!q || [x.t.name, x.t.room, x.t.type, x.t.notes].join(' ').toLowerCase().includes(q))).sort((a, b) => a.i.k - b.i.k);
      body = `<input class="search" id="hsearch" type="search" placeholder="Search home tasks" aria-label="Search home tasks" value="${esc(ui.homeQ)}">
        ${list.length ? listCard(list.map((x) => homeRow(x.t, x.i))) : '<div class="allclear">Nothing matches.</div>'}`;
    }
    const sel = ui.homeSelect;
    return `
      <header class="head-row"><h1>Home</h1><span class="hhead-acts">
        <button type="button" class="link" data-act="${sel ? 'home-select-cancel' : 'home-select'}" style="min-height:36px">${sel ? 'Cancel' : 'Select'}</button>
        <button type="button" class="sec-add" data-act="home-new" aria-label="Add a home task">+</button></span></header>
      ${tiles}
      ${filterRow}
      ${body}
      ${sel ? `<div class="selbar"><span>${sel.size ? `${sel.size} selected` : 'Tap tasks to select'}</span><button type="button" class="btn accent" data-act="home-batch-done"${sel.size ? '' : ' disabled'}>Mark done</button></div>` : ''}
    `;
  }

  function openRoomPicker() {
    const end = daysToMonthEnd(todayYmd());
    const all = (data.home_tasks || []).map((t) => ({ t, i: homeInfo(t) }));
    const rooms = [...new Set(all.map((x) => x.t.room).filter(Boolean))].sort();
    const dueIn = (r) => all.filter((x) => (!r || x.t.room === r) && !x.i.completed && x.i.k <= end).length;
    sheet.innerHTML = `<form method="dialog"><h3>Show room</h3>
      <div class="card"><ul class="list">${[['', 'All rooms'], ...rooms.map((r) => [r, r])].map(([k, l]) => `<li class="row"><button type="button" class="row-main roomrow" data-room="${esc(k)}">
        <span class="ricon sm">${roomIcon(k || 'home')}</span><span class="t" style="flex:1">${esc(l)}</span><span class="meta" style="margin:0">${dueIn(k) ? `${dueIn(k)} due` : ''}</span>${ui.homeRoom === k ? '<span class="ok" aria-label="selected">✓</span>' : ''}</button></li>`).join('')}</ul></div>
    </form>`;
    sheet.querySelectorAll('[data-room]').forEach((b) => { b.onclick = () => { ui.homeRoom = b.dataset.room; sheet.close(); render(); }; });
    showSheet();
  }

  // ---------- recent actions (undo history, kept on this device) ----------
  let history = [];
  try { history = JSON.parse(localStorage.getItem('life_history') || '[]').filter((h) => Date.now() - h.at < 3 * DAY); } catch (_) { /* ignore */ }
  const saveHistory = () => { try { localStorage.setItem('life_history', JSON.stringify(history.slice(0, 20))); } catch (_) { /* ignore */ } };
  // Record something you did, with what's needed to reverse it. Returns an undo function for the toast.
  function remember(label, undo) {
    const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), label, undo, undone: false };
    history.unshift(entry); history = history.slice(0, 20); saveHistory();
    return () => undoEntry(entry.id);
  }
  async function undoEntry(entryId) {
    const e = history.find((h) => h.id === entryId);
    if (!e || e.undone) return;
    const u = e.undo;
    try {
      if (u.k === 'item') await api(`/api/items/${u.id}`, { method: 'PATCH', body: u.prev });
      else if (u.k === 'items') for (const x of u.list) await api(`/api/items/${x.id}`, { method: 'PATCH', body: x.prev });
      else if (u.k === 'home-log') {
        for (const id of u.ids) await api(`/api/home/tasks/${id}/log?date=${u.date}`, { method: 'DELETE' });
        for (const [id, snz] of Object.entries(u.snooze || {})) if (snz) await api(`/api/home/tasks/${id}`, { method: 'PATCH', body: { snooze_until: snz } });
      } else if (u.k === 'home-snooze') await api(`/api/home/tasks/${u.id}`, { method: 'PATCH', body: { snooze_until: u.prev } });
      else if (u.k === 'habit') await api(`/api/tasks/${u.id}/log`, { body: { occ: u.occ, status: u.was ? 'done' : 'undo' } });
      else if (u.k === 'med') await api(`/api/tasks/${u.id}/log`, { body: { occ: `${u.date} ${u.slot}`, status: 'undo' } });
      else if (u.k === 'meal-eaten') await api(`/api/meals/${u.date}/eaten`, { body: { eaten: 0 } });
      else if (u.k === 'contact') await api(`/api/people/${u.id}`, { method: 'PATCH', body: u.prev });
      e.undone = true; saveHistory();
      await refresh();
      toast(`Undone: ${e.label}`);
    } catch (err) { toast(`Couldn't undo: ${err.message}`); }
  }
  const agoText = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} d ago`; };
  function openRecent() {
    sheet.innerHTML = `<form method="dialog">
      <h3>Recent actions</h3>
      <p class="sub">The last 20 things you checked off, snoozed or logged on this device. Undo any of them.</p>
      ${history.length ? `<div class="card"><ul class="list">${history.map((h) => `<li class="row"><div class="row-main"><div class="t${h.undone ? ' done-t' : ''}">${esc(h.label)}</div><div class="meta">${esc(agoText(h.at))}${h.undone ? ' · undone' : ''}</div></div>
        ${h.undone ? '' : `<button type="button" class="pbtn" data-undo="${h.id}">Undo</button>`}</li>`).join('')}</ul></div>` : '<div class="allclear">Nothing yet. Things you check off or snooze will show up here.</div>'}
      <div class="actions"><span class="grow"></span><button type="button" class="btn dark" data-sheet="close">Done</button></div>
    </form>`;
    sheet.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    sheet.querySelectorAll('[data-undo]').forEach((b) => { b.onclick = async () => { b.disabled = true; await undoEntry(b.dataset.undo); openRecent(); }; });
    showSheet();
  }

  async function homeLog(id, date, skipped = false) {
    const before = data.home_tasks.find((x) => x.id === id);
    const already = (data.home_log || []).some((l) => l.task_id === id && l.date === date);
    await api(`/api/home/tasks/${id}/log`, { body: { date, skipped } });
    const undo = already ? null : remember(`${skipped ? 'Skipped' : 'Done'}: ${before ? before.name : 'Home task'}`, { k: 'home-log', ids: [id], date, snooze: { [id]: before ? before.snooze_until : null } });
    await refresh();
    const t = data.home_tasks.find((x) => x.id === id);
    toast(`${skipped ? 'Skipped' : 'Done'}. Next: ${t ? homeInfo(t).label.replace(/^Due /, 'due ') : ''}`, undo);
  }
  async function homeSnooze(id, days = 7) {
    const t = data.home_tasks.find((x) => x.id === id);
    const i = homeInfo(t);
    const base = i.due && i.due > todayYmd() ? parseDay(i.due) : startOfDay();
    base.setDate(base.getDate() + days);
    await api(`/api/home/tasks/${id}`, { method: 'PATCH', body: { snooze_until: ymd(base) } });
    const undo = remember(`Snoozed: ${t.name}`, { k: 'home-snooze', id, prev: t.snooze_until || null });
    await refresh();
    toast(`Snoozed to ${fmtYmd(ymd(base))}`, undo);
  }

  // Simple line icons per room, so a task reads at a glance
  const ROOM_ICONS = {
    kitchen: '<path d="M4 3v8a3 3 0 0 0 6 0V3M7 3v18M17 21V3c-2 1.5-3 4-3 7s1 4 3 4"/>',
    bath: '<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM6 12V5a2 2 0 0 1 4 0M7 19l-1 2M17 19l1 2"/>',
    bed: '<path d="M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 14h18M3 18v2M21 18v2M7 9V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/>',
    pets: '<circle cx="6" cy="10" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="10" r="2"/><path d="M8 17c0-2.5 1.8-4.5 4-4.5s4 2 4 4.5c0 1.5-1.5 2.5-4 2.5s-4-1-4-2.5z"/>',
    safety: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
    hvac: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8"/>',
    laundry: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="13" r="4"/><path d="M8 6h.01M11 6h.01"/>',
    plumbing: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    outside: '<path d="M12 3l6 8h-3l4 6H5l4-6H6zM12 17v4"/>',
    admin: '<path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/>',
    living: '<path d="M4 11V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M3 11a2 2 0 0 1 2 2v2h14v-2a2 2 0 1 1 2 2v3H3v-3a2 2 0 0 1 0-4zM6 18v2M18 18v2"/>',
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  };
  function roomIcon(room = '') {
    const r = room.toLowerCase();
    const k = /kitchen/.test(r) ? 'kitchen' : /bath/.test(r) ? 'bath' : /bed/.test(r) ? 'bed' : /pet/.test(r) ? 'pets' : /safety/.test(r) ? 'safety'
      : /hvac|heat|air/.test(r) ? 'hvac' : /laundry/.test(r) ? 'laundry' : /plumb|water/.test(r) ? 'plumbing' : /exterior|yard|garden|outside|garage/.test(r) ? 'outside'
      : /admin|paper/.test(r) ? 'admin' : /living/.test(r) ? 'living' : 'home';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ROOM_ICONS[k]}</svg>`;
  }

  // Home task: a calm summary first (status, one big Done button); history,
  // other dates and editing are one tap away.
  function homeRemindText(t) {
    const r = t.remind || 'none';
    if (r === 'none') return '';
    const who = (data.users || []).length > 1 ? (t.remind_to === 0 ? ' · both of you' : t.remind_to && data.me && t.remind_to !== data.me.id ? ` · ${personName(t.remind_to)}` : '') : '';
    const at = fmtSlot(t.remind_time || '09:00');
    const txt = { hourly: 'Hourly once due', daily: `Daily at ${at}`, weekly: `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][t.remind_dow ?? 1]} at ${at}`, monthly: `The ${ORDINAL(t.remind_dom || 1)} at ${at}` }[r];
    return txt + who;
  }

  function openHomeTask(t) {
    const isNew = !t.id;
    const i = isNew ? null : homeInfo(t);
    const hist = isNew ? [] : (data.home_log || []).filter((l) => l.task_id === t.id);
    const last = isNew ? null : homeLast(t.id);
    const startMonth = t.months && t.months !== '*' && !/-/.test(t.months) ? Math.min(...t.months.split(',').map(Number)) : new Date().getMonth() + 1;
    const opt = (list, sel) => list.map((x) => `<option${x === sel ? ' selected' : ''}>${esc(x)}</option>`).join('');
    const rooms = [...new Set((data.home_tasks || []).map((x) => x.room).filter(Boolean))].sort();
    const statusText = isNew ? '' : i.completed ? 'Completed' : i.k < 0 ? `${-i.k} day${i.k === -1 ? '' : 's'} overdue` : i.k === 0 ? 'Due today' : i.k === 1 ? 'Due tomorrow' : `Due ${fmtYmd(i.due, { weekday: i.k <= 6 ? 'long' : undefined, month: 'short', day: 'numeric' })}`;
    const fact = (label, value) => value ? `<div class="hfact"><span>${label}</span><strong>${esc(value)}</strong></div>` : '';
    const view = isNew ? '' : `<div class="hview">
        <div class="hhead"><span class="ricon">${roomIcon(t.room)}</span><h3>${esc(t.name)}</h3></div>
        <div class="hstatus"><span class="pill-status ${i.cls}">${esc(statusText)}${i.snoozed ? ' · snoozed' : ''}</span>${last ? `<span class="muted-t">Last done ${esc(fmtYmd(last))}</span>` : '<span class="muted-t">Not done yet</span>'}</div>
        <div class="hfacts">${fact('Room', t.room)}${fact('How often', t.freq)}${fact('Who', t.who)}${fact('Takes', t.est)}${fact('Reminder', homeRemindText(t))}</div>
        ${t.notes ? `<p class="hnotes">${esc(t.notes)}</p>` : ''}
        <button type="button" class="btn accent hdone" data-h="done">Mark done today</button>
        <div class="btns2 hsecond"><button type="button" class="btn ghost" data-h="snooze">Snooze a week</button><button type="button" class="btn ghost" data-h="skip">Skip this time</button></div>
        <div class="hmore">
          <button type="button" class="link" data-h="other">Done on another day…</button>
          <div class="addrow" data-hpanel="other" hidden><input type="date" id="h-date" max="${todayYmd()}" aria-label="Date completed"><button type="button" class="pbtn" data-h="date">Log it</button></div>
          ${hist.length ? `<button type="button" class="link" data-h="hist">History (${hist.length})</button>
          <div class="card" data-hpanel="hist" hidden>${hist.slice(0, 12).map((l) => `<div class="hist-row"><span>${esc(fmtYmd(l.date, { month: 'short', day: 'numeric', year: 'numeric' }))}${l.skipped ? ' · skipped' : ''}</span><button type="button" class="pbtn icon" data-h="unlog" data-id="${l.id}" aria-label="Remove this entry">×</button></div>`).join('')}</div>` : ''}
          <button type="button" class="link" data-h="edit">Edit task</button>
        </div>
      </div>`;
    sheet.innerHTML = `<form method="dialog" class="home-sheet${isNew ? ' editing' : ''}">
      ${view}
      <div class="hedit">
        <h3>${isNew ? 'New home task' : 'Edit task'}</h3>
        <label class="field"><span>Task</span><input name="name" value="${esc(t.name || '')}" required maxlength="120"></label>
        <div class="two"><label class="field"><span>Room / area</span><input name="room" value="${esc(t.room || '')}" list="room-list" maxlength="60"></label>
          <label class="field"><span>Who</span><input name="who" value="${esc(t.who || '')}" placeholder="DIY / Pro" maxlength="40"></label></div>
        <datalist id="room-list">${rooms.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
        <div class="two"><label class="field"><span>Type</span><select name="type">${opt(HOME_TYPES, t.type || 'Maintenance')}</select></label>
          <label class="field"><span>How often</span><select name="freq">${opt(HOME_FREQS, t.freq || 'Annual')}</select></label></div>
        <div class="two"><label class="field" data-hf="start"><span>Starting month</span><select name="start">${Array.from({ length: 12 }, (_, k) => `<option value="${k + 1}"${startMonth === k + 1 ? ' selected' : ''}>${new Date(2000, k, 1).toLocaleDateString([], { month: 'long' })}</option>`).join('')}</select></label>
          <label class="field" data-hf="date"><span>Due date</span><input type="date" name="due" value="${esc(/-/.test(t.months || '') ? t.months : '')}"></label>
          <label class="field"><span>Takes</span><input name="est" value="${esc(t.est || '')}" placeholder="30 min" maxlength="40"></label></div>
        <label class="field"><span>Notes</span><textarea name="notes">${esc(t.notes || '')}</textarea></label>
        <div class="field"><span>Remind me</span>
          <select name="remind">${[['none', 'Off'], ['hourly', 'Hourly (from the due day until done)'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([k, v]) => `<option value="${k}"${(t.remind || 'none') === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <div class="two" data-hr="when">
            <label class="field" data-hr="dow"><span>Day</span><select name="remind_dow">${WEEKDAY_NAMES.map((d, k) => `<option value="${k}"${(t.remind_dow ?? 1) === k ? ' selected' : ''}>${d}</option>`).join('')}</select></label>
            <label class="field" data-hr="dom"><span>Date</span><select name="remind_dom">${Array.from({ length: 31 }, (_, k) => `<option value="${k + 1}"${(t.remind_dom || 1) === k + 1 ? ' selected' : ''}>${ORDINAL(k + 1)}</option>`).join('')}</select></label>
            <label class="field" data-hr="time"><span>Time</span><input type="time" name="remind_time" value="${esc(t.remind_time || '09:00')}"></label>
          </div>
          ${(data.users || []).length > 1 ? `<label class="field" data-hr="to"><span>Remind</span><select name="remind_to">${[[data.me.id, 'Me'], ...others().map((u) => [u.id, u.name]), [0, 'Both of us']].map(([id, n]) => `<option value="${id}"${(t.remind && t.remind !== 'none' ? t.remind_to ?? 0 : data.me.id) === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : ''}
          <p class="hint" data-hr="note">Reminders only run while the task is on your To do list (due this month or overdue), and stop once it's done.</p>
        </div>
        <div class="actions">${isNew ? '' : '<button type="button" class="btn danger" data-h="hide">Remove</button>'}<span class="grow"></span>
          <button type="button" class="btn ghost" data-h="${isNew ? 'cancel' : 'back'}">${isNew ? 'Cancel' : 'Back'}</button><button type="submit" class="btn dark">Save</button></div>
      </div>
    </form>`;
    const form = sheet.querySelector('form');
    const showFor = () => { const f = form.freq.value;
      form.querySelector('[data-hf="start"]').hidden = ['Weekly', 'Monthly', 'One-time'].includes(f);
      form.querySelector('[data-hf="date"]').hidden = f !== 'One-time'; };
    form.freq.onchange = showFor; showFor();
    const showRemind = () => { const r = form.remind.value;
      form.querySelector('[data-hr="when"]').hidden = r === 'none' || r === 'hourly';
      form.querySelector('[data-hr="dow"]').hidden = r !== 'weekly';
      form.querySelector('[data-hr="dom"]').hidden = r !== 'monthly';
      form.querySelectorAll('[data-hr="to"], [data-hr="note"]').forEach((el) => { el.hidden = r === 'none'; }); };
    form.remind.onchange = showRemind; showRemind();
    form.querySelectorAll('[data-h]').forEach((b) => { b.onclick = async () => {
      const act = b.dataset.h;
      try {
        if (act === 'done') { b.classList.add('completing'); await new Promise((r) => setTimeout(r, 200)); sheet.close(); await homeLog(t.id, todayYmd()); }
        else if (act === 'skip') { sheet.close(); await homeLog(t.id, todayYmd(), true); }
        else if (act === 'snooze') { sheet.close(); await homeSnooze(t.id, 7); }
        else if (act === 'other' || act === 'hist') { const panel = form.querySelector(`[data-hpanel="${act}"]`); panel.hidden = !panel.hidden; }
        else if (act === 'date') { const d = form.querySelector('#h-date').value; if (!d) { toast('Pick a date'); return; } await homeLog(t.id, d); openHomeTask(data.home_tasks.find((x) => x.id === t.id)); }
        else if (act === 'unlog') { await api(`/api/home/log/${b.dataset.id}`, { method: 'DELETE' }); await refresh(); openHomeTask(data.home_tasks.find((x) => x.id === t.id)); form.querySelector('[data-hpanel="hist"]')?.removeAttribute('hidden'); }
        else if (act === 'edit') { form.classList.add('editing'); sheet.scrollTop = 0; }
        else if (act === 'back') { if (!sheetDirty() || confirm('Discard your changes?')) { form.classList.remove('editing'); sheet.dataset.dirty = ''; } }
        else if (act === 'cancel') { if (okToClose()) sheet.close(); }
        else if (act === 'hide') { if (!confirm(`Remove "${t.name}"? Its history is kept.`)) return; await api(`/api/home/tasks/${t.id}`, { method: 'PATCH', body: { hidden: 1 } }); sheet.close(); await refresh(); toast('Removed'); }
      } catch (err) { toast(err.message); }
    }; });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const freq = f.get('freq');
      const body = { name: f.get('name').trim(), room: f.get('room').trim() || 'Whole Home', who: f.get('who').trim(), type: f.get('type'), freq,
        months: freq === 'One-time' ? (f.get('due') || todayYmd()) : monthsFor(freq, +f.get('start')), est: f.get('est').trim(), notes: f.get('notes').trim(),
        remind: f.get('remind'), remind_time: f.get('remind_time') || '09:00', remind_dow: +f.get('remind_dow'), remind_dom: +f.get('remind_dom'),
        remind_to: f.has('remind_to') ? +f.get('remind_to') : (data.me ? data.me.id : 0) };
      try {
        if (isNew) await api('/api/home/tasks', { body }); else await api(`/api/home/tasks/${t.id}`, { method: 'PATCH', body });
        sheet.close(); await refresh(); toast('Saved');
      } catch (err) { toast(err.message); }
    };
    showSheet();
  }

  // ---------- getting started (empty states with a next step) ----------
  function viewSetup() {
    let dismissed = false;
    try { dismissed = localStorage.getItem('life_setup_hidden') === '1'; } catch (_) { /* ignore */ }
    if (dismissed) return '';
    const steps = [
      !data.people.length && ['link', '#settings', 'Import contacts'],
      !myHabits().length && ['btn', 'edit-habits', 'Add habits'],
      !(data.meds || []).length && ['btn', 'med-new', 'Add a medication'],
      !(data.trips || []).length && ['btn', 'trip-new', 'Add a trip'],
      !data.settings.weather_lat && ['link', '#settings', 'Add weather'],
    ].filter(Boolean);
    if (!steps.length) return '';
    return `<section class="setup" aria-label="Getting started">
      <div class="sec-head"><h2>Finish setting up</h2><button type="button" class="sec-add" data-act="setup-hide" aria-label="Hide getting started">×</button></div>
      <div class="filters">${steps.map(([kind, v, label]) => kind === 'link' ? `<a class="chip-btn" href="${v}">${label}</a>` : `<button type="button" class="chip-btn" data-act="${v}">${label}</button>`).join('')}</div>
    </section>`;
  }

  // ---------- one day at a glance (tap a day in the week strip) ----------
  function openDay(date) {
    const d0 = parseDay(date), d1 = new Date(+d0 + DAY);
    const mmdd = date.slice(5);
    const rows = [];
    const row = (when, title, meta, open) => rows.push(`<li class="row"><span class="when">${esc(when)}</span>${kindMark({ event: 'calendar', med: 'pill', home: 'home', trip: 'suitcase', person: /birthday/i.test(title) ? 'balloon' : 'heart', item: 'calendar' }[open.split(':')[0]] || 'calendar', { med: 'k-med', person: 'k-people', home: 'k-home', trip: 'k-travel' }[open.split(':')[0]] || '')}<button type="button" class="row-main" data-open="${esc(open)}"><div class="t">${esc(title)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</button></li>`);
    const evs = data.events.filter((e) => !(e.pref && e.pref.hidden) && !birthdayEventPerson(e.title, data.people) && new Date(e.start_at) < d1 && (e.end_at ? new Date(e.end_at) > d0 : new Date(e.start_at) >= d0))
      .sort((a, b) => (a.all_day - b.all_day) || (Date.parse(a.start_at) - Date.parse(b.start_at)));
    for (const e of evs) row(e.all_day ? 'All day' : fmtShortTime(e.start_at), e.title, `Calendar${e.location ? ` · ${esc(e.location)}` : ''}`, `event:${e.id}`);
    for (const t of data.items.filter((i) => i.status === 'open' && i.due_at && new Date(i.due_at) >= d0 && new Date(i.due_at) < d1)) row(hasTime(t.due_at) ? fmtShortTime(t.due_at) : '', t.title, itemMeta(t, { skipDue: true }), `item:${t.id}`);
    for (const m of (data.meds || []).filter((x) => medDueOn(x, date))) { const day = slotsOn(m, date); row(fmtShortTime(slotDate(day[0]).toISOString()), m.name, `Medication · ${esc(day.map(fmtSlot).join(', '))}`, `med:${m.id}`); }
    for (const h of (data.home_tasks || []).filter((t) => homeInfo(t).due === date)) row('', h.name, `Home · ${esc(h.room || '')}`, `home:${h.id}`);
    for (const p of data.people.filter((x) => x.bday_notify !== 0 && (x.birthday || '').endsWith(mmdd))) row('', `${p.name}'s birthday`, 'People', `person:${p.id}`);
    for (const pd of (data.person_dates || []).filter((x) => x.date.endsWith(mmdd))) { const p = data.people.find((x) => x.id === pd.person_id); if (p && inCircle(p)) row('', `${p.name}: ${pd.label}`, 'People', `person:${p.id}`); }
    for (const t of (data.trips || []).filter((x) => x.start_date <= date && (x.end_date || x.start_date) >= date)) row('', t.name, 'Trip', `trip:${t.id}`);
    const ml = mealFor(date);
    sheet.innerHTML = `<form method="dialog">
      <h3>${esc(d0.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}</h3>
      <button type="button" class="dinner-main day-dinner" data-open="meal:${date}"><span class="dicon">${mealIcon}</span><span style="min-width:0;flex:1"><span class="label">Dinner</span><strong>${ml ? esc(mealLine(ml)) : 'Not planned · tap to plan'}</strong></span></button>
      ${rows.length ? `<div class="card"><ul class="list">${rows.join('')}</ul></div>` : '<div class="allclear">Nothing on this day yet.</div>'}
      <div class="actions"><button type="button" class="btn ghost" data-open="new:${date}">+ Add a task this day</button><span class="grow"></span><button type="button" class="btn dark" data-sheet="close">Done</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    form.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => {
      const [kind, id] = b.dataset.open.split(/:(.+)/);
      const n = +id;
      if (kind === 'event') openEvent(data.events.find((x) => x.id === n));
      else if (kind === 'item') openItem(data.items.find((x) => x.id === n));
      else if (kind === 'med') { const t = taskById(n); if (t) openTask(t); }
      else if (kind === 'home') openHomeTask(data.home_tasks.find((x) => x.id === n));
      else if (kind === 'person') openPerson(data.people.find((x) => x.id === n));
      else if (kind === 'trip') openTrip(data.trips.find((x) => x.id === n));
      else if (kind === 'meal') openMeal(id);
      else if (kind === 'new') { const due = parseDay(id); due.setHours(9, 0, 0, 0); openItem({ title: '', kind: 'task', nag: 'once', due_at: due.toISOString() }); }
    }; });
    showSheet();
  }

  // ---------- evening wrap-up ----------
  function viewWrap(open, eod) {
    const now = new Date();
    if (now.getHours() < 18) return '';
    const left = open.filter((i) => i.due_at && new Date(i.due_at) < eod && !(i.snooze_until && Date.parse(i.snooze_until) > Date.now()));
    const sod = startOfDay(now);
    const doneToday = data.items.filter((i) => i.status === 'done' && i.done_at && new Date(i.done_at) >= sod).length;
    if (!left.length) return doneToday ? `<div class="allclear">Wrapped up: ${plural(doneToday, 'thing')} done today, nothing left over.</div>` : '';
    return `<section class="wrapup" aria-label="Wrap up today">
      <span class="label">Wrap up today</span>
      <strong class="wt">${doneToday ? `${plural(doneToday, 'thing')} done · ` : ''}${left.length} left over</strong>
      <ul class="wlist">${left.slice(0, 5).map((i) => `<li>${esc(i.title)}</li>`).join('')}${left.length > 5 ? `<li>+${left.length - 5} more</li>` : ''}</ul>
      <div class="btns2"><button type="button" class="btn dark" data-act="wrap-move" data-ids="${left.map((i) => i.id).join(',')}">Move all to tomorrow</button>
      <button type="button" class="btn" data-act="wrap-review">Review</button></div>
    </section>`;
  }

  // ---------- medications ----------
  const todayYmd = () => ymd(startOfDay());
  const slotDate = (slot) => { const [h, mi] = slot.split(':').map(Number); const d = new Date(); d.setHours(h, mi, 0, 0); return d; };
  function medSlotsToday() {
    const date = todayYmd();
    const logs = new Map((data.med_logs || []).filter((l) => l.date === date).map((l) => [`${l.med_id}|${l.slot}`, l]));
    const out = [];
    for (const m of data.meds || []) for (const slot of slotsOn(m, date)) out.push({ med: m, slot, at: slotDate(slot), log: logs.get(`${m.id}|${slot}`) || null });
    return out.sort((a, b) => a.at - b.at);
  }

  function viewMeds() {
    const slots = medSlotsToday();
    if (!slots.length) return '';
    const now = Date.now();
    const left = slots.filter((x) => !x.log).length;
    return `<section aria-label="Medications">${head(`Medications <span class="n">${left ? `${left} to take` : 'all taken ✓'}</span>`, { key: 'meds', add: 'med-new', addLabel: 'Add a medication' })}
      ${isCol('meds') ? '' : `<div class="card"><ul class="list">${slots.map((x) => {
        const late = !x.log && x.at.getTime() <= now;
        const state = x.log ? (x.log.status === 'taken' ? `<span class="ok">Taken at ${esc(fmtTime(x.log.taken_at))}</span>` : 'Skipped today')
          : late ? '<span class="late">Due now</span>' : `Scheduled ${esc(fmtTime(x.at.toISOString()))}`;
        return `<li class="row"><span class="when">${esc(fmtShortTime(x.at.toISOString()))}</span>
          <button type="button" class="row-main" data-act="med-open" data-id="${x.med.id}"><div class="t">${esc(x.med.name)}${x.med.dose ? ` · ${esc(x.med.dose)}` : ''}</div><div class="meta">${state}</div></button>
          ${x.log ? `<button type="button" class="pbtn" data-act="med-undo" data-id="${x.med.id}" data-slot="${x.slot}">Undo</button>`
            : `<button type="button" class="pbtn${late ? ' take' : ''}" data-act="med-take" data-id="${x.med.id}" data-slot="${x.slot}">Take</button>`}
        </li>`;
      }).join('')}</ul></div>`}</section>`;
  }

  async function logMed(id, slot, status = 'taken') {
    const m = (data.meds || []).find((x) => x.id === id);
    const prev = (data.med_logs || []).find((l) => l.med_id === id && l.date === todayYmd() && l.slot === slot);
    if (status === 'taken' && prev && prev.status === 'taken') { toast(`Already taken today at ${fmtTime(prev.taken_at)}. Not logged twice.`); return; }
    await api(`/api/tasks/${id}/log`, { body: { occ: `${todayYmd()} ${slot}`, status: status === 'taken' ? 'done' : status } });
    const undo = status === 'undo' ? null : remember(`${status === 'skipped' ? 'Skipped' : 'Took'} ${m ? m.name : 'dose'} (${fmtTime(slotDate(slot).toISOString())})`, { k: 'med', id, date: todayYmd(), slot });
    await refresh();
    toast(status === 'undo' ? 'Undone' : status === 'skipped' ? 'Skipped for today' : `${m ? m.name : 'Dose'} logged as taken`, undo);
  }

  // Medication sheet: preset chips; the days or dates you tap set how many doses there are.
  const MED_PRESETS = [['daily', 'Daily'], ['2day', '2× a day'], ['weekly', 'Weekly'], ['2week', '2× a week'], ['2wk', 'Every 2 weeks'], ['monthly', 'Monthly'], ['2month', '2× a month'], ['custom', 'Custom']];
  const MED_KIND = { daily: 'day', '2day': 'day', weekly: 'week', '2week': 'week', monthly: 'month', '2month': 'month', '2wk': 'every', custom: 'every' };
  const MED_REMIND = [['15m', 'Every 15 minutes'], ['hourly', 'Every hour'], ['once', 'Once, at the dose time'], ['none', "Don't remind me"]];
  function medState(m) {
    let own = {};
    try { own = JSON.parse(m.dose_times || '{}') || {}; } catch (_) { own = {}; }
    const base = String(m.times || '08:00').split(',').filter(Boolean);
    const n = Math.max(1, +m.interval_n || 1);
    const st = { p: 'daily', dayTimes: base.length ? base : ['08:00'], days: [], dayT: {}, dates: [], dateT: {}, every: 2, unit: 'weeks',
      start: m.start_date || todayYmd(), time: base[0] || '08:00', remind: m.remind || 'hourly' };
    if (!m.id) return st;
    if ((m.freq || 'daily') === 'daily') {
      if (n === 1) st.p = st.dayTimes.length > 1 ? '2day' : 'daily';
      else Object.assign(st, { p: 'custom', every: n, unit: 'days' });
    } else if (m.freq === 'weekly') {
      const days = String(m.weekdays || '').split(',').filter((x) => x !== '').map(Number);
      if (n === 1) { st.p = days.length === 1 ? 'weekly' : '2week'; st.days = days; days.forEach((d) => { st.dayT[d] = own[d] || base[0] || '08:00'; }); }
      else Object.assign(st, { p: n === 2 ? '2wk' : 'custom', every: n, unit: 'weeks' });
    } else if (m.freq === 'monthly') {
      const ds = String(m.month_days || m.month_day || '').split(',').map(Number).filter((x) => x >= 1);
      if (n === 1) { st.p = ds.length > 1 ? '2month' : 'monthly'; st.dates = ds; ds.forEach((d) => { st.dateT[d] = own[d] || base[0] || '08:00'; }); }
      else Object.assign(st, { p: 'custom', every: n, unit: 'months' });
    }
    return st;
  }
  function medPick(st, p) {
    const wasEvery = MED_KIND[st.p] === 'every';
    st.p = p;
    const t = st.time || '08:00';
    if (p === 'daily') st.dayTimes = st.dayTimes.slice(0, 1);
    if (p === '2day') st.dayTimes = [st.dayTimes[0] || '08:00', st.dayTimes[1] || '20:00'];
    if (p === 'weekly' || p === '2week') {
      const want = p === 'weekly' ? 1 : 2;
      if (st.days.length !== want) st.days = p === 'weekly' ? [new Date().getDay()] : [1, 4];
      st.days.forEach((d) => { st.dayT[d] = st.dayT[d] || t; });
    }
    if (p === 'monthly' || p === '2month') {
      const want = p === 'monthly' ? 1 : 2;
      if (st.dates.length !== want) st.dates = p === 'monthly' ? [new Date().getDate()] : [1, 15];
      st.dates.forEach((d) => { st.dateT[d] = st.dateT[d] || t; });
    }
    if (p === '2wk') Object.assign(st, { every: 2, unit: 'weeks' });
    if (p === 'custom' && !wasEvery) Object.assign(st, { every: 3, unit: 'days' });
  }
  function medSummary(st) {
    const k = MED_KIND[st.p];
    const times = (c) => (c === 1 ? 'Once' : c === 2 ? 'Twice' : `${c} times`);
    if (k === 'day') return `${times(st.dayTimes.length)} a day · ${st.dayTimes.map(fmtSlot).join(', ')}`;
    if (k === 'week') return st.days.length ? `${times(st.days.length)} a week · ${[...st.days].sort().map((d) => `${WEEKDAY_NAMES[d]} ${fmtSlot(st.dayT[d] || '08:00')}`).join(', ')}` : 'Pick at least one day';
    if (k === 'month') return st.dates.length ? `${times(st.dates.length)} a month · ${[...st.dates].sort((a, b) => a - b).map((d) => `the ${ORDINAL(d)} ${fmtSlot(st.dateT[d] || '08:00')}`).join(', ')}` : 'Pick at least one date';
    const unit = st.every === 1 ? st.unit.slice(0, -1) : st.unit;
    return `Every ${st.every} ${unit} at ${fmtSlot(st.time)} · starting ${parseDay(st.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
  }
  function medPanel(st) {
    const k = MED_KIND[st.p];
    const timeRow = (label, key, val) => `<label class="mrow"><span>${esc(label)}</span><input type="time" data-mt="${key}" value="${esc(val)}" required></label>`;
    if (k === 'day') return `<div class="lbl">Times each day</div>${st.dayTimes.map((t, i) => `<div class="mrow-wrap">${timeRow(`Dose ${i + 1}`, `day:${i}`, t)}${st.dayTimes.length > 1 ? `<button type="button" class="mx" data-mrm="${i}" aria-label="Remove dose ${i + 1}">×</button>` : ''}</div>`).join('')}
      ${st.dayTimes.length < 6 ? '<button type="button" class="madd" data-madd="1">+ Another time</button>' : ''}`;
    if (k === 'week') return `<div class="lbl">Which days (tap to add or remove)</div>
      <div class="mdays" role="group" aria-label="Days of the week">${WEEKDAY_NAMES.map((d, i) => `<button type="button" data-mday="${i}" aria-pressed="${st.days.includes(i)}" aria-label="${d}">${d[0]}</button>`).join('')}</div>
      ${st.days.length ? `<div class="lbl">Time for each day</div>${[...st.days].sort().map((d) => timeRow(WEEKDAY_NAMES[d], `wd:${d}`, st.dayT[d] || '08:00')).join('')}` : ''}`;
    if (k === 'month') return `<div class="lbl">Which dates (tap to add or remove)</div>
      <div class="mdates" role="group" aria-label="Dates of the month">${Array.from({ length: 31 }, (_, i) => `<button type="button" data-mdate="${i + 1}" aria-pressed="${st.dates.includes(i + 1)}">${i + 1}</button>`).join('')}</div>
      ${st.dates.length ? `<div class="lbl">Time for each date</div>${[...st.dates].sort((a, b) => a - b).map((d) => timeRow(`The ${ORDINAL(d)}`, `md:${d}`, st.dateT[d] || '08:00')).join('')}` : ''}
      ${st.dates.some((d) => d > 28) ? '<p class="hint">In shorter months, a late date moves to the last day of the month.</p>' : ''}`;
    return `<div class="lbl">Repeat</div>
      <div class="mevery">Every <button type="button" data-mstep="-1" aria-label="Fewer">−</button><b>${st.every}</b><button type="button" data-mstep="1" aria-label="More">+</button>
        <select data-munit aria-label="Unit">${['days', 'weeks', 'months'].map((u) => `<option${u === st.unit ? ' selected' : ''}>${u}</option>`).join('')}</select></div>
      <label class="mrow"><span>First dose</span><input type="date" data-mstart value="${esc(st.start)}" required></label>
      ${timeRow('Time', 'every', st.time)}`;
  }

  // The preset-chip schedule picker (medications, and Custom repeats on any task)
  function bindMedPicker(root, st, draw) {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !root.contains(b)) return;
      if (b.dataset.mp) { medPick(st, b.dataset.mp); draw(); return; }
      if (b.dataset.mday !== undefined) {
        const d = +b.dataset.mday;
        st.days = st.days.includes(d) ? st.days.filter((x) => x !== d) : [...st.days, d];
        if (st.days.includes(d)) st.dayT[d] = st.dayT[d] || st.dayT[st.days[0]] || st.time || '08:00';
        st.p = st.days.length === 1 ? 'weekly' : '2week'; draw(); return;
      }
      if (b.dataset.mdate) {
        const d = +b.dataset.mdate;
        st.dates = st.dates.includes(d) ? st.dates.filter((x) => x !== d) : [...st.dates, d];
        if (st.dates.includes(d)) st.dateT[d] = st.dateT[d] || st.dateT[st.dates[0]] || st.time || '08:00';
        st.p = st.dates.length === 1 ? 'monthly' : '2month'; draw(); return;
      }
      if (b.dataset.madd) { st.dayTimes.push(st.dayTimes.length === 1 ? '20:00' : '12:00'); st.p = '2day'; draw(); return; }
      if (b.dataset.mrm !== undefined) { st.dayTimes.splice(+b.dataset.mrm, 1); st.p = st.dayTimes.length > 1 ? '2day' : 'daily'; draw(); return; }
      if (b.dataset.mstep) { st.every = Math.min(52, Math.max(1, st.every + +b.dataset.mstep)); if (st.p === '2wk' && !(st.every === 2 && st.unit === 'weeks')) st.p = 'custom'; draw(); }
    });
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.mt) {
        const [kind, key] = t.dataset.mt.split(':');
        if (kind === 'day') st.dayTimes[+key] = t.value;
        if (kind === 'wd') st.dayT[+key] = t.value;
        if (kind === 'md') st.dateT[+key] = t.value;
        if (kind === 'every') st.time = t.value;
      }
      if (t.matches('[data-munit]')) { st.unit = t.value; st.p = st.every === 2 && st.unit === 'weeks' ? '2wk' : 'custom'; draw(); return; }
      if (t.matches('[data-mstart]')) st.start = t.value || todayYmd();
      const sum = root.querySelector('.msum'); if (sum) sum.textContent = medSummary(st);
    });
  }
  function medPickerSchedule(st, startDefault) {
    const k = MED_KIND[st.p];
    const out = { weekdays: '', month_days: null, dose_times: null, start_date: startDefault };
    if (k === 'day') return { ...out, freq: 'daily', interval_n: 1, times: [...new Set(st.dayTimes.filter(Boolean))].sort().join(',') };
    if (k === 'week') {
      if (!st.days.length) return { error: 'Pick at least one day' };
      const dt = Object.fromEntries(st.days.map((d) => [d, st.dayT[d] || '08:00']));
      return { ...out, freq: 'weekly', interval_n: 1, weekdays: [...st.days].sort().join(','), dose_times: dt, times: Object.values(dt).sort()[0] };
    }
    if (k === 'month') {
      if (!st.dates.length) return { error: 'Pick at least one date' };
      const dt = Object.fromEntries(st.dates.map((d) => [d, st.dateT[d] || '08:00']));
      return { ...out, freq: 'monthly', interval_n: 1, month_days: [...st.dates].sort((a, b) => a - b).join(','), dose_times: dt, times: Object.values(dt).sort()[0] };
    }
    const start = parseDay(st.start);
    const r = { ...out, interval_n: st.every, times: st.time || '08:00', start_date: st.start, freq: { days: 'daily', weeks: 'weekly', months: 'monthly' }[st.unit] };
    if (st.unit === 'weeks') r.weekdays = String(start.getDay());
    if (st.unit === 'months') r.month_days = String(start.getDate());
    return r;
  }

  function openMed(m) {
    const st = medState(m);
    let hist = '';
    if (m.id) {
      const cells = [];
      for (let i = 13; i >= 0; i--) {
        const d = startOfDay(); d.setDate(d.getDate() - i);
        const want = slotsOn(m, ymd(d)).length;
        const taken = (data.med_logs || []).filter((l) => l.med_id === m.id && l.date === ymd(d) && l.status === 'taken').length;
        const cls = !want ? ' off' : taken >= want ? ' full' : taken ? ' part' : '';
        cells.push(`<span class="mday${cls}" aria-label="${esc(d.toLocaleDateString([], { month: 'short', day: 'numeric' }))}: ${taken} of ${want}"><b>${d.getDate()}</b></span>`);
      }
      hist = `<p class="sub">Last 14 days (filled = every dose taken, faded = no dose that day)</p><div class="mhist">${cells.join('')}</div>`;
    }
    sheet.innerHTML = `<form method="dialog">
      <h3>${m.id ? esc(m.name) : 'New medication'}</h3>
      ${hist}
      <div class="two"><label class="field"><span>Name</span><input name="name" value="${esc(m.name || '')}" required maxlength="80"></label>
        <label class="field"><span>Dose</span><input name="dose" value="${esc(m.dose || '')}" placeholder="10 mg" maxlength="60"></label></div>
      <div class="field"><span>How often</span><div class="chips-wrap mpresets" role="radiogroup" aria-label="How often"></div></div>
      <div class="mpanel"></div>
      <p class="msum" aria-live="polite"></p>
      <label class="field"><span>If not taken</span><select name="remind">${MED_REMIND.map(([k, v]) => `<option value="${k}"${st.remind === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>Notes</span><input name="notes" value="${esc(m.notes || '')}" placeholder="with food" maxlength="300"></label>
      <div class="actions">${m.id ? '<button type="button" class="btn danger" data-sheet="delete">Stop taking</button>' : ''}<span class="grow"></span>
        <button type="button" class="btn ghost" data-sheet="close">Cancel</button><button type="submit" class="btn dark">Save</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    const draw = () => {
      // The "2×" chips show the real count once you pick more (3× a week, etc.)
      const count = { '2day': st.dayTimes.length, '2week': st.days.length, '2month': st.dates.length };
      const label = (k, v) => (st.p === k && count[k] > 2 ? v.replace('2×', `${count[k]}×`) : v);
      form.querySelector('.mpresets').innerHTML = MED_PRESETS.map(([k, v]) => `<button type="button" class="chip-btn" role="radio" aria-checked="${st.p === k}" data-mp="${k}">${label(k, v)}</button>`).join('');
      form.querySelector('.mpanel').innerHTML = medPanel(st);
      form.querySelector('.msum').textContent = medSummary(st);
    };
    draw();
    bindMedPicker(form, st, draw);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const k = MED_KIND[st.p];
      const sch = medPickerSchedule(st, m.start_date || todayYmd());
      if (sch.error) { toast(sch.error); return; }
      const body = { name: f.get('name').trim(), dose: f.get('dose').trim() || null, notes: f.get('notes').trim() || null, remind: f.get('remind'), ...sch };
      try {
        if (m.id) await api(`/api/meds/${m.id}`, { method: 'PATCH', body }); else await api('/api/meds', { body });
        sheet.close(); await refresh(); toast('Saved');
      } catch (err) { toast(err.message); }
    };
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    const del = form.querySelector('[data-sheet="delete"]');
    if (del) del.onclick = async () => {
      if (!confirm(`Stop tracking ${m.name}? Its history is kept.`)) return;
      await api(`/api/meds/${m.id}`, { method: 'DELETE' }); sheet.close(); await refresh();
    };
    showSheet();
  }

  // ---------- contacts import with review ----------
  function openContactsReview(cards) {
    const existing = new Set(data.people.map((p) => p.external_id));
    const keyOf = (c) => c.uid || `name:${c.name.toLowerCase()}`;
    const st = { sel: new Set(), f: 'all', q: '', fields: { birthday: true, dates: true, email: false, notes: false } };
    const total = cards.length, withB = cards.filter((c) => c.birthday).length;
    const shown = () => cards.filter((c) => (st.f === 'bday' ? c.birthday : st.f === 'sel' ? st.sel.has(keyOf(c)) : st.f === 'new' ? !existing.has(keyOf(c)) : true)
      && (!st.q || c.name.toLowerCase().includes(st.q)));
    const draw = () => {
      const list = shown();
      const body = sheet.querySelector('.review-list');
      body.innerHTML = list.slice(0, 600).map((c) => {
        const k = keyOf(c);
        const bits = [c.birthday ? `Birthday ${birthdayIn(c.birthday).date.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '', c.dates.length ? c.dates.map((d) => d.label).join(', ') : '', existing.has(k) ? 'already in app' : ''].filter(Boolean).join(' · ');
        return `<li class="row"><label class="rv"><input type="checkbox" data-k="${esc(k)}"${st.sel.has(k) ? ' checked' : ''}><span><span class="t">${esc(c.name)}</span>${bits ? `<span class="meta">${esc(bits)}</span>` : ''}</span></label></li>`;
      }).join('') + (list.length > 600 ? `<li class="row"><span class="meta">Showing 600 of ${list.length}. Search to narrow.</span></li>` : '') || '<li class="row"><span class="meta">No contacts match.</span></li>';
      sheet.querySelector('.rv-count').textContent = `${st.sel.size} selected`;
      sheet.querySelector('[data-rv="go"]').disabled = !st.sel.size;
      sheet.querySelector('[data-rv="go"]').textContent = st.sel.size ? `Import ${st.sel.size}` : 'Import';
      sheet.querySelectorAll('[data-rf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rf === st.f)));
    };
    sheet.innerHTML = `<form method="dialog" class="review">
      <h3>Choose contacts</h3>
      <p class="sub">${total} in the file · ${withB} with birthdays. Nothing leaves your device until you tap Import, and only the people and details you pick are sent.</p>
      <div class="field"><span>Include</span><div class="filters">${[['birthday', 'Birthday'], ['dates', 'Anniversaries'], ['email', 'Email'], ['notes', 'Notes']]
        .map(([k, v]) => `<button type="button" data-fld="${k}" aria-pressed="${st.fields[k]}">${v}</button>`).join('')}</div></div>
      <input class="search" type="search" placeholder="Search names" aria-label="Search contacts" data-rv="q">
      <div class="filters">${[['all', 'All'], ['bday', 'With birthday'], ['new', 'Not in app'], ['sel', 'Selected']].map(([k, v]) => `<button type="button" data-rf="${k}">${v}</button>`).join('')}</div>
      <div class="btns"><button type="button" class="pbtn" data-rv="all">Select all shown</button><button type="button" class="pbtn" data-rv="none">Clear</button><span class="rv-count meta" style="align-self:center"></span></div>
      <div class="card review-card"><ul class="list review-list"></ul></div>
      <div class="actions"><span class="grow"></span><button type="button" class="btn ghost" data-sheet="close">Cancel</button><button type="submit" class="btn dark" data-rv="go">Import</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    form.addEventListener('change', (e) => { const k = e.target.dataset.k; if (!k) return; if (e.target.checked) st.sel.add(k); else st.sel.delete(k); draw(); });
    form.querySelector('[data-rv="q"]').oninput = (e) => { st.q = e.target.value.trim().toLowerCase(); draw(); };
    form.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.rf) { st.f = b.dataset.rf; draw(); }
      else if (b.dataset.fld) { st.fields[b.dataset.fld] = !st.fields[b.dataset.fld]; b.setAttribute('aria-pressed', String(st.fields[b.dataset.fld])); }
      else if (b.dataset.rv === 'all') { shown().forEach((c) => st.sel.add(keyOf(c))); draw(); }
      else if (b.dataset.rv === 'none') { st.sel.clear(); draw(); }
      else if (b.dataset.sheet === 'close') sheet.close();
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const F = st.fields;
      const contacts = cards.filter((c) => st.sel.has(keyOf(c))).map((c) => ({
        uid: c.uid || null, name: c.name, birthday: F.birthday ? c.birthday || null : null, phone: null, // phone numbers are never imported
        email: F.email ? c.email || null : null, notes: F.notes ? c.notes || null : null, dates: F.dates ? c.dates : [],
      }));
      try {
        sheet.close(); toast('Importing…');
        const res = await api('/api/import/contacts', { body: { contacts } });
        await refresh();
        toast(`Imported ${res.imported} people (${res.withBirthday} with birthdays)`);
      } catch (err) { toast(err.message); }
    };
    draw();
    showSheet();
  }

  // ---------- search ----------
  function viewSearch(q) {
    const t = q.toLowerCase();
    const has = (...xs) => xs.some((x) => x && String(x).toLowerCase().includes(t));
    const items = data.items.filter((i) => has(i.title, i.notes)).slice(0, 30);
    const people = data.people.filter((p) => has(p.name, p.notes) || (data.gifts || []).some((g) => g.person_id === p.id && has(g.idea))).slice(0, 20);
    const events = data.events.filter((e) => has(e.title, e.location, e.pref && e.pref.note)).slice(0, 20);
    const trips = (data.trips || []).filter((x) => has(x.name));
    const meds = (data.meds || []).filter((m) => has(m.name, m.notes));
    const rows = [
      section('Tasks & notes', items.map((i) => itemRow(i))),
      section('People', people.map((p) => personRow(p, [p.circle ? CIRCLES[p.circle] : '', (data.gifts || []).filter((g) => g.person_id === p.id && has(g.idea)).map((g) => `gift: ${esc(g.idea)}`).join(', ')].filter(Boolean).join(' · ')))),
      section('Calendar', events.map((e) => eventRow(e, { when: weekday(e.start_at), meta: `${esc(new Date(e.start_at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}${e.all_day ? '' : ` · ${esc(fmtTime(e.start_at))}`}${e.location ? ` · ${esc(e.location)}` : ''}` }))),
      section('Trips', trips.map((x) => `<li class="row"><a class="row-main" style="text-decoration:none;color:inherit" href="${esc(x.link || '#')}" target="_blank" rel="noopener"><div class="t">${esc(x.name)}</div><div class="meta">${esc(fmtRange(x.start_date, x.end_date))}</div></a></li>`)),
      section('Medications', meds.map((m) => `<li class="row"><button type="button" class="row-main" data-act="med-open" data-id="${m.id}"><div class="t">${esc(m.name)}</div><div class="meta">${esc(describeSchedule(m))}</div></button></li>`)),
    ].join('');
    return rows || `<div class="allclear">Nothing matches “${esc(q)}”.</div>`;
  }

  function untilText(iso) {
    const mins = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }

  function viewAll() {
    const filter = (i) => ui.allArea === 'all' || (ui.allArea === 'none' ? !i.area : i.area === ui.allArea);
    const open = data.items.filter((i) => i.status === 'open' && filter(i));
    const notes = open.filter((i) => i.kind === 'note');
    const tasks = open.filter((i) => i.kind === 'task');
    const dated = tasks.filter((i) => i.due_at).sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
    const undated = tasks.filter((i) => !i.due_at);
    const done = data.items.filter((i) => i.status === 'done' && filter(i));
    const chips = [['all', 'All'], ...Object.entries(AREAS), ['none', 'No area']]
      .map(([k, v]) => `<button type="button" data-act="area" data-v="${k}" aria-pressed="${ui.allArea === k}">${v}</button>`).join('');
    const whenFor = (i) => {
      const d = daysBetween(new Date(), new Date(i.due_at));
      return d === 0 ? 'Today' : d === 1 ? 'Tmrw' : d < 0 ? 'Late' : d < 7 ? weekday(i.due_at) : new Date(i.due_at).toLocaleDateString([], { month: 'numeric', day: 'numeric' });
    };
    return `
      <header class="head-row"><h1>Everything <span class="count">${tasks.length} open</span></h1><span class="hhead-acts"><button type="button" class="link" data-act="recent" style="min-height:36px">Recent</button><button type="button" class="sec-add" data-act="new-item" aria-label="Add a task">+</button></span></header>
      <input class="search" id="allsearch" type="search" placeholder="Search tasks, people, events, gifts…" aria-label="Search everything" value="${esc(ui.q)}">
      ${ui.q.trim() ? viewSearch(ui.q.trim()) : `<div class="filters" role="group" aria-label="Filter by area">${chips}</div>
      ${section('Scheduled', dated.map((i) => itemRow(i, { when: whenFor(i) })))}
      ${section('Anytime', undated.map((i) => itemRow(i)))}
      ${section('Notes', notes.map((i) => itemRow(i)))}
      ${!dated.length && !undated.length && !notes.length ? '<div class="allclear">Nothing here.</div>' : ''}
      ${done.length ? `<button type="button" class="link" data-act="toggle-done">${ui.showDone ? 'Hide' : 'Show'} done today (${done.length})</button>
        ${ui.showDone ? listCard(done.map((i) => itemRow(i))) : ''}` : ''}`}
    `;
  }

  function viewPeople() {
    const q = ui.peopleQuery.toLowerCase();
    const list = data.people.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.notes || '').toLowerCase().includes(q));
    let rows, missing = [];
    if (ui.peopleFilter === 'reach' && !q) {
      rows = list.map((p) => ({ p, s: checkinStatus(p) })).filter((x) => x.s).sort((a, b) => a.s.left - b.s.left)
        .map((x) => personRow(x.p, x.s.overdue
          ? `<span class="late">${x.s.since === null ? 'No contact logged' : `${x.s.since} days`}</span> · ${esc((CHECKINS[x.p.checkin_days] || `every ${x.p.checkin_days} days`).toLowerCase())}`
          : `${x.s.since} days · due in ${x.s.left}`));
    } else if ((ui.peopleFilter === 'family' || ui.peopleFilter === 'close') && !q) {
      rows = list.filter((p) => p.circle === ui.peopleFilter).map((p) => {
        const g = (data.gifts || []).filter((x) => x.person_id === p.id && x.status === 'idea').length;
        const b = birthdayIn(p.birthday);
        return personRow(p, [CIRCLES[p.circle], b ? `birthday in ${b.days} days` : '', g ? plural(g, 'gift idea') : ''].filter(Boolean).join(' · '));
      });
    } else if (ui.peopleFilter === 'birthdays' && !q) {
      rows = list.map((p) => ({ p, b: birthdayIn(p.birthday) })).filter((x) => x.b).sort((a, b) => a.b.days - b.b.days)
        .map((x) => personRow(x.p, (x.b.days === 0 ? 'Today' : `${x.b.date.toLocaleDateString([], { month: 'short', day: 'numeric' })} · in ${x.b.days} days${x.b.turns ? ` · turns ${x.b.turns}` : ''}`) + (x.p.bday_notify === 0 ? ' · hidden from Today' : '')));
      // Everyone without a birthday, at the end, so gaps are easy to fill in
      missing = list.filter((p) => !birthdayIn(p.birthday)).map((p) => personRow(p, [p.circle ? CIRCLES[p.circle] : '', 'tap to add a birthday'].filter(Boolean).join(' · ')));
    } else {
      rows = list.slice(0, 200).map((p) => personRow(p, [p.birthday ? `Birthday ${birthdayIn(p.birthday).date.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '', p.checkin_days ? 'keeping in touch' : ''].filter(Boolean).join(' · ')));
    }
    const chips = [['birthdays', 'Birthdays'], ['family', 'Family'], ['close', 'Close friends'], ['reach', 'Keep in touch'], ['all', 'Everyone']]
      .map(([k, v]) => `<button type="button" data-act="pfilter" data-v="${k}" aria-pressed="${ui.peopleFilter === k}">${v}</button>`).join('');
    const empty = ui.peopleFilter === 'reach' ? 'No one yet. Open a person and choose how often to check in.'
      : ui.peopleFilter === 'family' ? 'No family yet. Open a person and set Circle to Family.'
      : ui.peopleFilter === 'close' ? 'No close friends yet. Open a person and set Circle to Close friend.'
      : data.people.length ? 'No matches.' : 'No people yet. Import your contacts in Settings.';
    return `
      <header class="head-row"><h1>People <span class="count">${data.people.length}</span></h1><button type="button" class="sec-add" data-act="new-person" aria-label="Add a person">+</button></header>
      <input class="search" id="psearch" type="search" placeholder="Search names and notes" aria-label="Search people" value="${esc(ui.peopleQuery)}">
      <div class="chips-scroll filters" role="group" aria-label="People filter">${chips}</div>
      ${rows.length ? listCard(rows) : `<div class="allclear">${ui.peopleFilter === 'birthdays' && data.people.length ? 'No birthdays saved yet.' : empty}</div>`}
      ${missing.length ? `<section>${head(`Missing a birthday <span class="n">${missing.length}</span>`, { key: 'nobday' })}${isFolded('nobday') ? '' : listCard(missing)}</section>` : ''}
      <button type="button" class="link" data-act="new-person">+ Add a person</button>
    `;
  }

  function viewSettings() {
    const s = data.settings;
    const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}"${+sel === h ? ' selected' : ''}>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>`).join('');
    return `
      <header class="head-row"><h1>Settings</h1><a class="link" href="#today">Done</a></header>
      <div class="jump" role="navigation" aria-label="Settings sections"><button type="button" data-act="jump" data-to="set-you">You</button><button type="button" data-act="jump" data-to="set-today">Today</button><button type="button" data-act="jump" data-to="set-calendar">Calendar & people</button><button type="button" data-act="jump" data-to="set-travel">Travel</button><button type="button" data-act="jump" data-to="set-account">Account</button></div>
      <h2 class="set-group" id="set-you">You</h2>
      <form class="setting" id="settings-form">
        <strong>You</strong>
        <label class="field"><span>First name, for the greeting</span><input name="name" value="${esc(s.name || '')}" autocomplete="given-name"></label>
        <div class="two">
          <label class="field"><span>Quiet from</span><select name="quiet_start">${hours(s.quiet_start)}</select></label>
          <label class="field"><span>Until</span><select name="quiet_end">${hours(s.quiet_end)}</select></label>
        </div>
        <label class="field"><span>Morning briefing at</span><select name="briefing_hour">${hours(s.briefing_hour)}</select></label>
        <div><button class="btn dark" type="submit">Save</button></div>
      </form>
      <div class="setting">
        <strong>Notifications</strong>
        ${viewPushSetting()}
        <div class="btns"><button type="button" class="btn ghost" data-act="test-push">Send a test</button>
        <button type="button" class="btn ghost" data-act="briefing">Send briefing now</button></div>
      </div>
      <div class="setting">
        <strong>Backup</strong>
        <p>Downloads everything that's yours plus the shared Home, dinners and trips as one file. Save it to Files or iCloud Drive. ${s.last_backup_at ? `Last backup: ${esc(fmtDay(s.last_backup_at))}.` : 'No backup yet.'} Life adds a reminder once a month.</p>
        <div class="btns"><button type="button" class="btn ghost" data-act="backup">Download a backup</button></div>
      </div>
      <h2 class="set-group" id="set-today">Today</h2>
      <div class="setting">
        <strong>Weather</strong>
        <p>${s.weather_lat ? `Using a location near ${esc(weather && weather.place ? weather.place : `${s.weather_lat}, ${s.weather_lon}`)} (rounded to about 1 km). Forecasts come from the US National Weather Service.` : 'Show the forecast on Today and in your morning briefing. Your location is rounded to about 1 km and used only to ask the US National Weather Service for a forecast.'}</p>
        <div class="btns"><button type="button" class="btn ghost" data-act="locate">${s.weather_lat ? 'Update to my current location' : 'Use my current location'}</button>
        ${s.weather_lat ? '<button type="button" class="btn ghost" data-act="unlocate">Remove</button>' : ''}</div>
      </div>
      <div class="setting">
        <strong>Colors</strong>
        <div class="palettes" role="radiogroup" aria-label="Color palette">${(window.lifeTheme ? window.lifeTheme.palettes : []).map((p) => `<button type="button" class="pal" role="radio" aria-checked="${window.lifeTheme.palette() === p.key}" data-act="palette" data-v="${p.key}"><span class="pal-sw" aria-hidden="true">${p.swatches.map((c) => `<i style="background:${c}"></i>`).join('')}</span><span>${esc(p.name)}</span></button>`).join('')}</div>
        <p>${(() => { const t = window.lifeTheme && window.lifeTheme.today; if (!t) return 'Colors switch at sunrise and sunset.'; const f = (d) => fmtTime(d.toISOString()); return `Night colors start at sunset (${f(t.set)} today) and day colors return at sunrise (${f(t.rise)}).${window.lifeTheme.hasLocation() ? '' : ' Add your weather location for exact times; until then it uses 7a and 7p.'}`; })()}</p>
      </div>
      <div class="setting">
        <strong>Habits</strong>
        <p>${myHabits().length ? esc(myHabits().map((h) => h.title).join(', ')) : 'None yet. Add a few small daily things to check off on Today.'}</p>
        <div class="btns"><button type="button" class="btn ghost" data-act="edit-habits">${myHabits().length ? 'Edit habits' : 'Add habits'}</button>
        <button type="button" class="btn ghost" data-act="focus-free" data-min="25">Start a 25-min focus</button></div>
      </div>
      <div class="setting">
        <strong>Medications</strong>
        <p>${(data.meds || []).length ? esc(data.meds.map((m) => `${m.name} (${allTimes(m).map(fmtSlot).join(', ')})`).join(' · ')) : 'Track daily medicine: a reminder at each dose time, hourly until taken, and a guard against taking it twice.'}</p>
        ${(data.meds || []).length ? `<ul class="list">${data.meds.map((m) => `<li class="row"><button type="button" class="row-main" data-act="med-open" data-id="${m.id}"><div class="t">${esc(m.name)}${m.dose ? ` · ${esc(m.dose)}` : ''}</div><div class="meta">${esc(describeSchedule(m))}${medDueOn(m, todayYmd()) ? ' · today' : (() => { const nd = nextDue(m, todayYmd()); return nd ? ` · next ${esc(parseDay(nd).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}` : ''; })()}</div></button></li>`).join('')}</ul>` : ''}
        <button type="button" class="link" data-act="med-new">+ Add a medication</button>
      </div>
      <form class="setting" id="meal-form">
        <strong>Meal planning</strong>
        <p>A Sunday nudge if any of the next 7 nights don't have a dinner plan yet. Your plan for tonight also appears in the morning briefing.</p>
        <label class="field"><span>Sunday reminder at</span><select name="meal_plan_hour"><option value="-1"${s.meal_plan_hour === '-1' ? ' selected' : ''}>Off</option>${[9, 10, 12, 14, 16, 17, 18, 19].map((h) => `<option value="${h}"${(s.meal_plan_hour === undefined || s.meal_plan_hour === '' ? 16 : +s.meal_plan_hour) === h ? ' selected' : ''}>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>`).join('')}</select></label>
        <div><button class="btn dark" type="submit">Save</button></div>
      </form>
      <form class="setting" id="wrap-form">
        <strong>Evening wrap-up</strong>
        <p>A nudge at night with what you finished and what's left. From 6pm, Today shows a wrap-up card to move leftovers to tomorrow.</p>
        <label class="field"><span>Send at</span><select name="wrap_hour"><option value="-1"${s.wrap_hour === '-1' ? ' selected' : ''}>Off</option>${[18, 19, 20, 21, 22].map((h) => `<option value="${h}"${(s.wrap_hour === undefined || s.wrap_hour === '' ? 21 : +s.wrap_hour) === h ? ' selected' : ''}>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>`).join('')}</select></label>
        <div><button class="btn dark" type="submit">Save</button></div>
      </form>
      <h2 class="set-group" id="set-calendar">Calendar & people</h2>
      <div class="setting">
        <strong>Calendar</strong>
        <p>${s.events_synced_at ? `Last synced ${esc(fmtDay(s.events_synced_at))} at ${esc(fmtTime(s.events_synced_at))}.` : 'Not synced yet.'} Your Shortcut sends upcoming events each morning. Tap any event on Today to hide it or add a note.</p>
        ${(data.users || []).length > 1 ? `<form class="inline-form" id="shared-cal-form"><label class="field"><span>Shared calendars: both of you see their events (separate names with commas, exactly as in Apple Calendar)</span><input name="shared_calendar" value="${esc(s.shared_calendar || '')}" placeholder="Logan & Aidan, US Holidays"></label><div><button class="btn ghost" type="submit">Save</button></div></form>` : ''}
        <label class="inline"><input type="checkbox" id="hide-bdays"${s.hide_cal_birthdays === '1' ? ' checked' : ''}> Hide birthday events from the calendar (People already tracks birthdays)</label>
        ${(() => {
          const hidden = (data.event_prefs || []).filter((r) => r.hidden === 1);
          return hidden.length ? `<p style="margin-top:4px">Hidden events:</p><ul class="list">${hidden.map((r) => `<li class="row"><div class="row-main"><div class="t">${esc(r.label || r.key.replace(/^(one|all):/, ''))}</div><div class="meta">${r.key.startsWith('all:') ? 'every time' : 'one time'}</div></div><button type="button" class="pbtn" data-act="unhide" data-key="${esc(r.key)}" data-keep='${esc(JSON.stringify({ leave: r.leave, travel_min: r.travel_min, note: r.note, label: r.label }))}'>Show</button></li>`).join('')}</ul>` : '';
        })()}
      </div>
      <div class="setting">
        <strong>Import contacts</strong>
        <p>In Contacts on your Mac (or iPhone: share a contact or list), export a vCard (.vcf), then choose it here. You'll review and pick exactly who and what to import first. Re-importing only fills in blanks; your edits are kept.</p>
        <label class="field"><span>vCard file (.vcf)</span><input type="file" id="vcf" accept=".vcf,text/vcard,text/x-vcard"></label>
      </div>
      <h2 class="set-group" id="set-travel">Travel</h2>
      <div class="setting">
        <strong>Trips</strong>
        <p>Your next trip shows as a countdown on Today. Add a link (Wayfare or any trip page) to open it from the card, or leave it blank.</p>
        ${(data.trips || []).length ? `<ul class="list">${data.trips.map((t) => `<li class="row"><button type="button" class="row-main" data-act="trip-open" data-id="${t.id}"><div class="t">${esc(t.name)}</div><div class="meta">${esc(fmtRange(t.start_date, t.end_date))}${t.link ? ` · ${/claude\.ai\/artifact/.test(t.link) ? 'Wayfare link' : 'has link'}` : ' · no link'}</div></button></li>`).join('')}</ul>` : ''}
        <button type="button" class="link" data-act="trip-new">+ Add a trip</button>
      </div>
      <div class="setting">
        <strong>Travel documents</strong>
        <p>You'll get a renewal reminder ahead of each expiry, and the trip card warns if one runs out within 6 months of a trip.</p>
        ${(data.documents || []).length ? `<ul class="list">${data.documents.map((d) => `<li class="row"><button type="button" class="row-main" data-act="doc" data-id="${d.id}"><div class="t">${esc(d.name)}</div><div class="meta">Expires ${esc(parseDay(d.expires_on).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }))} · remind ${d.remind_months} months ahead</div></button></li>`).join('')}</ul>` : ''}
        <button type="button" class="link" data-act="new-doc">+ Add a document</button>
      </div>
      <h2 class="set-group" id="set-account">Account</h2>
      <div class="setting">
        <button type="button" class="link" data-act="logout">Sign out on this device</button>
      </div>
    `;
  }

  function viewLogin() {
    return `<form class="login" id="login">
      <h1 style="margin:0">Life</h1>
      <p>Enter the local development password (APP_TOKEN in .dev.vars).</p>
      <label class="field"><span>Password</span><input type="password" name="token" autocomplete="current-password" required></label>
      <button class="btn dark" type="submit">Open</button>
    </form>`;
  }

  // ---------- Rewards (credit cards, credits, certificates, points) ----------
  // Logic lives in rewards.js (shared with the server). Cards are shared by the household;
  // each belongs to one person.
  const rwCtx = () => ({ ...(data.rewards || { cards: [], logs: [], points: {}, config: {} }), today: todayYmd() });
  const rwCard = (id) => ((data.rewards || {}).cards || []).find((c) => c.id === id);
  const rwBen = (c, id) => (c.benefits || []).find((b) => b.id === id);
  const rwOwner = (c) => personName(c.owner);
  const rwPeople = () => (data.users || []).map((u) => u.id);
  const RW_ARTS = ['platinum', 'gold', 'graphite', 'palladium', 'brilliant', 'sapphire', 'freedom', 'ihg', 'discover', 'atmos', 'deltagold', 'venturex', 'prime', 'slate'];
  const rwChip = (c, cls = '') => `<span class="rw-chip art-${RW_ARTS.includes(c.art) ? c.art : 'slate'} ${cls}" aria-hidden="true"><b>${esc(c.mark || '')}</b></span>`;
  const rwDate = (d) => `${RW.MONTHS[d.getMonth()]} ${d.getDate()}`;
  const rwDays = (n) => (n <= 1 ? 'last day' : `${n} days left`);
  const rwPill = (v) => `<span class="rw-pill ${v.k}">${esc(v.label)}</span>`;
  const RW_TABS = [['cards', 'Cards'], ['use', 'Credits'], ['points', 'Points']];

  function viewRewards() {
    const tab = ui.rwTab || 'cards';
    const body = tab === 'use' ? rwToUse() : tab === 'points' ? rwPoints() : rwCards();
    return `<header class="head-row"><h1>Rewards</h1>${tab === 'cards' ? '<button type="button" class="sec-add" data-act="rw-add-card" aria-label="Add a card">+</button>' : ''}</header>
      <div class="seg3" role="group" aria-label="Rewards view">${RW_TABS.map(([k, l]) => `<button type="button" data-act="rw-tab" data-v="${k}" aria-pressed="${tab === k}">${l}</button>`).join('')}</div>
      ${body}`;
  }

  // Cards: the year at a glance, then each person's cards
  function rwCards() {
    const ctx = rwCtx(), y = startOfDay().getFullYear();
    const ms = ctx.cards.map((c) => ({ c, m: RW.metrics(ctx, c, y) }));
    if (!ms.length) return '<div class="allclear">No cards yet. Tap + to add one.</div>';
    const sumOf = (list, f) => list.reduce((a, x) => a + f(x), 0);
    const used = sumOf(ms, (x) => x.m.used), fees = sumOf(ms, (x) => x.m.fee), still = sumOf(ms, (x) => x.m.still);
    const monthEnd = new Date(y, startOfDay().getMonth() + 1, 0);
    const leftMonth = RW.openCredits(ctx).filter((x) => +x.info.end === +monthEnd).reduce((a, x) => a + x.left, 0);
    const people = rwPeople();
    const by = people.map((id) => { const g = ms.filter((x) => x.c.owner === id); return { id, used: sumOf(g, (x) => x.m.used), fee: sumOf(g, (x) => x.m.fee), g }; }).filter((p) => p.g.length);
    const net = used - fees;
    let h = `<section class="rw-hero">
      <div class="rw-big"><span class="rw-num">${RW.money(Math.round(used))}</span><span>back in ${y}</span></div>
      ${by.length > 1 ? `<div class="rw-split" role="img" aria-label="${by.map((p) => `${esc(personName(p.id))} ${RW.money(p.used)}`).join(', ')}">${by.map((p, i) => `<span class="p${i + 1}" style="width:${used > 0 ? (p.used / used) * 100 : 100 / by.length}%"></span>`).join('')}</div>
        <div class="rw-legend">${by.map((p, i) => `<span><i class="p${i + 1}"></i>${esc(personName(p.id))} <b>${RW.money(Math.round(p.used))}</b></span>`).join('')}</div>` : ''}
      <div class="rw-stats">
        <div><small>Annual fees</small><b>${RW.money(fees)}</b></div>
        <div><small>${net >= 0 ? 'Ahead by' : 'Behind by'}</small><b class="${net >= 0 ? 'ok' : 'late'}">${RW.money(Math.round(Math.abs(net)))}</b></div>
        <button type="button" data-act="rw-tab" data-v="use"><small>Left this month</small><b class="${leftMonth > 0.004 ? 'late' : ''}">${RW.money(leftMonth)}</b></button>
        <button type="button" data-act="rw-tab" data-v="use"><small>Left this year</small><b>${RW.money(Math.round(still))}</b></button>
      </div>
    </section>`;
    for (const p of by) {
      const g = p.g.sort((a, b) => (+b.c.fee || 0) - (+a.c.fee || 0) || String(a.c.name).localeCompare(b.c.name));
      h += `<section><div class="sec-head"><h2>${esc(personName(p.id))}</h2><span class="rw-meta">${RW.money(Math.round(p.used))} back / ${RW.money(p.fee)} fees</span></div>
        <div class="card"><ul class="list">${g.map(({ c, m }) => `<li class="row rw-card-row"><button type="button" class="row-main" data-act="rw-card" data-id="${esc(c.id)}">
          ${rwChip(c)}<span class="rw-cmain"><span class="t">${esc(c.name)}</span><span class="meta">${esc(c.issuer || '')}${c.issuer ? ' · ' : ''}${m.fee ? `${RW.money(m.fee)} fee` : 'No fee'}</span></span>
          <span class="rw-cside">${rwPill(m.verdict)}<span class="meta">${RW.money(m.used)}${m.fee ? ` / ${RW.money(m.fee)}` : ' back'}</span></span>
          ${m.fee ? `<span class="rw-bar"><span class="${m.used >= m.fee ? 'good' : ''}" style="width:${Math.min(100, (m.used / m.fee) * 100)}%"></span></span>` : ''}
        </button></li>`).join('')}</ul></div></section>`;
    }
    const fees4 = ctx.cards.map((c) => ({ c, d: RW.nextFee(ctx, c) })).filter((x) => x.d).sort((a, b) => a.d - b.d).slice(0, 4);
    if (fees4.length) h += section('Upcoming fees', fees4.map(({ c, d }) => `<li class="row"><span class="when">${esc(rwDate(d))}</span>
      <button type="button" class="row-main" data-act="rw-card" data-id="${esc(c.id)}"><div class="t">${esc(c.name)}</div><div class="meta">${esc(rwOwner(c))} · ${RW.money(c.fee)}${d.getFullYear() !== startOfDay().getFullYear() ? ` · ${d.getFullYear()}` : ''}</div></button></li>`));
    return h;
  }

  function rwCredRow(x, { when = true } = {}) {
    const { c, b, left, cap } = x;
    return `<li class="row">${when ? `<span class="when">${esc(rwDate(x.info.end))}</span>` : ''}
      <button type="button" class="check" data-act="rw-use-all" data-card="${esc(c.id)}" data-ben="${esc(b.id)}" aria-label="Mark ${esc(RW.money(left))} of ${esc(b.name)} used"></button>
      <button type="button" class="row-main" data-act="rw-ben" data-card="${esc(c.id)}" data-ben="${esc(b.id)}">
        <div class="t">${esc(b.name)} · ${esc(RW.money(left))}${left < cap - 0.004 ? ` <span class="rw-of">of ${esc(RW.money(cap))}</span>` : ''}</div>
        <div class="meta">${esc(rwOwner(c))}'s ${esc(c.name)} · ${esc(rwDays(x.days))}</div></button></li>`;
  }

  // Credits: every credit with money left, grouped by when it runs out; then certificates
  function rwToUse() {
    const ctx = rwCtx();
    const open = RW.openCredits(ctx);
    const dated = open.filter((x) => x.dated);
    const byEnd = new Map();
    for (const x of dated) { const k = RW.ymd(x.info.end); if (!byEnd.has(k)) byEnd.set(k, []); byEnd.get(k).push(x); }
    const keys = [...byEnd.keys()].sort();
    let h = '';
    if (keys.length) {
      const first = byEnd.get(keys[0]).reduce((a, x) => a + x.left, 0);
      h += `<section class="rw-hero"><div class="rw-big"><span class="rw-num">${RW.money(first)}</span><span>left to use by ${esc(rwDate(RW.parseDate(keys[0])))}</span></div></section>`;
    } else h += '<div class="allclear">Every credit is used. Nice.</div>';
    for (const k of keys) {
      const items = byEnd.get(k).sort((a, z) => z.left - a.left);
      const d = RW.daysLeft(ctx, RW.parseDate(k));
      h += section(`Ends ${esc(rwDate(RW.parseDate(k)))} <span class="n">${esc(rwDays(d))} · ${esc(RW.money(items.reduce((a, x) => a + x.left, 0)))}</span>`, items.map((x) => rwCredRow(x, { when: false })));
    }
    const yearly = open.filter((x) => !x.dated && x.b.period === 'anniversary');
    if (yearly.length) h += section('Each card year', yearly.map((x) => rwCredRow(x, { when: false })));
    const certs = RW.certList(ctx);
    if (certs.length) h += section('Certificates', certs.map(({ c, b, x, days }) => { const pot = RW.certPot(x, b); return `<li class="row">
      <button type="button" class="row-main" data-act="rw-ben" data-card="${esc(c.id)}" data-ben="${esc(b.id)}"><div class="t">${esc(b.name)}</div>
      <div class="meta">${esc(rwOwner(c))}'s ${esc(c.name)}${pot ? ` · worth ~${esc(RW.money(pot))}` : ''} · ${x.expires ? `<span class="${days <= 30 ? 'late' : ''}">expires ${esc(rwDate(RW.parseDate(x.expires)))}</span>` : 'no expiry set'}</div></button></li>`; }));
    const fours = open.filter((x) => x.b.period === '4yr');
    if (fours.length) h += section('Every 4 years', fours.map((x) => rwCredRow(x, { when: false })));
    return h;
  }

  // Points: balances by person, then where they can go
  function rwPoints() {
    const ctx = rwCtx(); const people = rwPeople();
    const val = (o) => RW.progsFor(ctx, o).reduce((a, k) => { const c = RW.progCpp(ctx, k); return a + (c == null ? 0 : RW.bal(ctx, o, k) * c / 100); }, 0);
    const cnt = (o) => RW.progsFor(ctx, o).reduce((a, k) => a + RW.bal(ctx, o, k), 0);
    const total = people.reduce((a, o) => a + cnt(o), 0), tval = people.reduce((a, o) => a + val(o), 0);
    let h = `<section class="rw-hero"><div class="rw-big"><span class="rw-num">${RW.fmtPts(total)}</span><span>points and miles</span></div>
      <div class="rw-stats three">${people.map((o) => `<div><small>${esc(personName(o))}</small><b>${RW.fmtPts(cnt(o))}</b><small>≈ ${RW.money(Math.round(val(o)))}</small></div>`).join('')}<div><small>Worth about</small><b>${RW.money(Math.round(tval))}</b></div></div></section>`;
    for (const o of people) {
      const progs = RW.progsFor(ctx, o).sort((a, z) => RW.bal(ctx, o, z) - RW.bal(ctx, o, a));
      const upd = (ctx.points[o] || {}).updated || {};
      h += `<section>${head(esc(personName(o)), { add: 'rw-add-prog', addLabel: `Add a program for ${personName(o)}` }).replace('data-act="rw-add-prog"', `data-act="rw-add-prog" data-owner="${o}"`)}
        <div class="card no-when"><ul class="list">${progs.map((k) => { const b = RW.bal(ctx, o, k), c = RW.progCpp(ctx, k);
          return `<li class="row"><button type="button" class="row-main rw-pt" data-act="rw-bal" data-owner="${o}" data-prog="${esc(k)}">
            <span><span class="t">${esc(RW.progName(ctx, k))}</span><span class="meta">${b ? (upd[k] ? `Updated ${esc(rwDate(RW.parseDate(upd[k])))}` : '') : 'Tap to add a balance'}</span></span>
            <span class="rw-ptv"><b>${b ? RW.fmtPts(b) : '—'}</b>${b && c != null ? `<small>≈ ${RW.money(Math.round(b * c / 100))}</small>` : ''}</span></button></li>`; }).join('') || '<li class="row"><div class="row-main"><div class="meta">No programs yet</div></div></li>'}</ul></div></section>`;
    }
    // Transfer partners
    const mode = ui.rwWho || 'all', type = ui.rwType || 'all';
    const partners = ((ctx.config.transfers || {}).partners) || {};
    const rows = [];
    for (const [pid, pt] of Object.entries(partners)) {
      if (type !== 'all' && pt.type !== type) continue;
      let best;
      if (mode === 'all') best = people.map((o) => RW.reachFor(ctx, o, pid, true, people)).sort((a, z) => z.total - a.total)[0];
      else best = RW.reachFor(ctx, +mode, pid, false, people);
      if (best && best.total > 0) rows.push({ pid, pt, ...best });
    }
    rows.sort((a, z) => z.total - a.total || a.pt.name.localeCompare(z.pt.name));
    h += `<section><div class="sec-head"><h2>Transfer partners <span class="n">${rows.length}</span></h2></div>
      <div class="seg3" role="group" aria-label="Whose points">${[['all', 'Together'], ...people.map((o) => [String(o), personName(o)])].map(([k, l]) => `<button type="button" data-act="rw-who" data-v="${k}" aria-pressed="${mode === k}">${esc(l)}</button>`).join('')}</div>
      <div class="filters" style="margin-top:8px">${[['all', 'All'], ['air', 'Airlines'], ['hotel', 'Hotels']].map(([k, l]) => `<button type="button" data-act="rw-type" data-v="${k}" aria-pressed="${type === k}">${l}</button>`).join('')}</div>
      ${rows.length ? `<div class="card no-when" style="margin-top:8px"><ul class="list">${rows.map((r) => {
        const bon = r.parts.find((p) => p.bonus);
        const line = r.parts.map((p) => (p.own ? `${RW.fmtK(p.amt)} already there` : `${mode === 'all' && p.q !== r.o ? `${esc(personName(p.q))}'s ` : ''}${RW.SRC_SHORT[p.src]} ${RW.fmtK(p.b)}${p.got !== p.b ? ` → ${RW.fmtK(p.got)}` : ''}`)).join(' + ');
        const pc = RW.progCpp(ctx, r.pid);
        return `<li class="row"><div class="row-main rw-xf"><div class="rw-xfh"><span class="t">${esc(r.pt.name)}</span><span class="rw-ptv"><b>${RW.fmtPts(r.total)}</b>${pc != null ? `<small>≈ ${RW.money(Math.round(r.total * pc / 100))}</small>` : ''}</span></div>
          <div class="meta">${mode === 'all' ? `${esc(personName(r.o))}'s account · ` : ''}${line}</div>
          ${bon ? `<span class="rw-bonus">+${bon.bonus.pct}% from ${RW.SRC_SHORT[bon.src]} until ${esc(rwDate(RW.parseDate(bon.bonus.end)))}</span>` : ''}</div></li>`; }).join('')}</ul></div>`
        : '<div class="allclear">Add a Chase, Amex, Capital One or Bilt balance to see where it can go.</div>'}
      <p class="hint">${mode === 'all' ? 'Together combines Chase and Capital One points into one account first; Amex and Bilt stay with whoever earned them. ' : ''}Values are conservative, about what a typical redemption gets. Partners as of ${esc((ctx.config.transfers || {}).asOf || '')}.</p></section>`;
    return h;
  }

  // Credits ending soon, for Today (your own cards only)
  function rwTodayRows(maxDays, minDays = 0) {
    if (!data.rewards || !data.me) return [];
    const ctx = rwCtx();
    return RW.openCredits(ctx, ctx.cards.filter((c) => c.owner === data.me.id))
      .filter((x) => x.dated && x.days <= maxDays && x.days > minDays).sort((a, z) => a.days - z.days || z.left - a.left)
      .map((x) => rwCredRow(x));
  }

  // ----- Rewards sheets -----
  async function rwLog(cardId, benId, amount, date, note) {
    const r = await api('/api/rewards/logs', { body: { card_id: cardId, benefit_id: benId, amount, date, note } });
    await refresh();
    toast(`Logged ${RW.money(amount)}`, async () => { await api(`/api/rewards/logs/${r.id}`, { method: 'DELETE' }); await refresh(); });
  }
  async function rwPatch(c, patch) { await api(`/api/rewards/cards/${encodeURIComponent(c.id)}`, { method: 'PATCH', body: patch }); await refresh(); }

  function openRwCard(id, { edit = false } = {}) {
    const c = rwCard(id); if (!c) return;
    const ctx = rwCtx(), y = startOfDay().getFullYear(), m = RW.metrics(ctx, c, y);
    const fee = RW.nextFee(ctx, c);
    const benRow = (b) => {
      let line = '';
      if (b.kind === 'credit') { const u = RW.benUse(ctx, c, b, y); const p = u.cur;
        const lf = p ? Math.max(0, p.cap - p.used) : 0;
        line = `${RW.money(b.amount)} ${(RW.PERIOD_LABEL[b.period] || '').toLowerCase()}${p ? ` · ${lf > 0.004 ? `<span class="late">${RW.money(lf)} left</span>` : 'used'} ${p.info.label ? `(${esc(p.info.label)})` : ''}` : ''}`; }
      else if (b.kind === 'cert') { const { cur } = RW.certState(ctx, c, b); line = !cur ? 'Used' : cur.next ? 'Next one at renewal' : cur.expires ? `Expires ${rwDate(RW.parseDate(cur.expires))}` : 'Not used yet'; }
      else line = b.note || 'Perk';
      return `<li class="row"><button type="button" class="row-main" data-rw="ben" data-ben="${esc(b.id)}"><div class="t">${esc(b.name)}</div><div class="meta">${line}</div></button></li>`;
    };
    const vis = RW.visibleBenefits(c);
    sheet.innerHTML = `<form method="dialog" class="rw-sheet${edit ? ' editing' : ''}">
      <div class="hview">
        <div class="rw-shead">${rwChip(c, 'big')}<div><h3>${esc(c.name)}</h3><p class="sub">${esc(rwOwner(c))}'s card${c.issuer ? ` · ${esc(c.issuer)}` : ''}</p></div></div>
        <div class="rw-stats">
          <div><small>Back in ${y}</small><b>${RW.money(m.used)}</b></div>
          <div><small>Annual fee</small><b>${m.fee ? RW.money(m.fee) : 'None'}</b></div>
          <div><small>Status</small>${rwPill(m.verdict)}</div>
        </div>
        ${fee ? `<p class="rw-renew${RW.daysLeft(ctx, fee) <= 45 ? ' soon' : ''}">Fee of ${RW.money(c.fee)} renews ${esc(rwDate(fee))}${fee.getFullYear() !== y ? `, ${fee.getFullYear()}` : ''}${RW.daysLeft(ctx, fee) <= 45 ? ' · decide whether to keep it' : ''}</p>` : ''}
        ${c.notes ? `<p class="hnotes">${esc(c.notes)}</p>` : ''}
        <div class="lbl">Benefits</div>
        <div class="card no-when"><ul class="list">${vis.map(benRow).join('') || '<li class="row"><div class="row-main"><div class="meta">No benefits tracked</div></div></li>'}</ul></div>
        <div class="hmore"><button type="button" class="link" data-rw="edit">Edit card</button></div>
      </div>
      <div class="hedit">
        <h3>Edit ${esc(c.name)}</h3>
        <div class="two"><label class="field"><span>Name</span><input name="name" value="${esc(c.name)}" maxlength="80" required></label>
          <label class="field"><span>Issuer</span><input name="issuer" value="${esc(c.issuer || '')}" maxlength="40"></label></div>
        <div class="two"><label class="field"><span>Annual fee ($)</span><input name="fee" type="number" min="0" value="${esc(c.fee || 0)}"></label>
          <label class="field"><span>Fee renews</span><input name="renews" type="date" value="${esc(c.renews || '')}"></label></div>
        ${(data.users || []).length > 1 ? `<label class="field"><span>Whose card</span><select name="owner">${(data.users || []).map((u) => `<option value="${u.id}"${u.id === c.owner ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span>Notes</span><textarea name="notes">${esc(c.notes || '')}</textarea></label>
        <div class="field"><span>Benefits you track (turn off ones you don't use)</span>
          <div class="card no-when"><ul class="list">${(c.benefits || []).map((b) => `<li class="row"><label class="row-main rw-toggle"><span><span class="t">${esc(b.name)}</span><span class="meta">${b.kind === 'credit' ? `${RW.money(b.amount)} ${(RW.PERIOD_LABEL[b.period] || '').toLowerCase()}` : b.kind === 'cert' ? 'Certificate' : 'Perk'}</span></span><input type="checkbox" data-ben-on="${esc(b.id)}"${(c.hidden || []).includes(b.id) ? '' : ' checked'}></label></li>`).join('')}</ul></div></div>
        <details class="rw-addben"><summary>+ Add a credit</summary>
          <div class="two"><label class="field"><span>Name</span><input data-nb="name" placeholder="Uber Cash" maxlength="80"></label>
            <label class="field"><span>Amount ($)</span><input data-nb="amount" type="number" min="0" step="0.01"></label></div>
          <label class="field"><span>Resets</span><select data-nb="period">${['monthly', 'quarterly', 'semiannual', 'annual', 'anniversary'].map((p) => `<option value="${p}">${RW.PERIOD_LABEL[p]}</option>`).join('')}</select></label>
        </details>
        <div class="actions"><button type="button" class="btn danger" data-rw="remove">Remove card</button><span class="grow"></span>
          <button type="button" class="btn ghost" data-rw="back">Back</button><button type="submit" class="btn dark">Save</button></div>
      </div>
    </form>`;
    const form = sheet.querySelector('form');
    form.querySelectorAll('[data-rw]').forEach((el) => { el.onclick = async () => {
      const a = el.dataset.rw;
      try {
        if (a === 'ben') openRwBenefit(c.id, el.dataset.ben);
        else if (a === 'edit') { form.classList.add('editing'); sheet.scrollTop = 0; }
        else if (a === 'back') form.classList.remove('editing');
        else if (a === 'remove') { if (!confirm(`Remove ${c.name} and its history?`)) return; await api(`/api/rewards/cards/${encodeURIComponent(c.id)}`, { method: 'DELETE' }); sheet.close(); await refresh(); toast('Card removed'); }
      } catch (err) { toast(err.message); }
    }; });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const hidden = [...form.querySelectorAll('[data-ben-on]')].filter((x) => !x.checked).map((x) => x.dataset.benOn);
      const patch = { name: f.get('name'), issuer: f.get('issuer'), fee: +f.get('fee') || 0, renews: f.get('renews') || null, notes: f.get('notes'), hidden };
      if (f.has('owner')) patch.owner = +f.get('owner');
      const nb = (k) => form.querySelector(`[data-nb="${k}"]`).value.trim();
      if (nb('name') && +nb('amount') > 0) {
        const bid = `${nb('name').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}-${Math.random().toString(36).slice(2, 5)}`;
        patch.benefits = [...(c.benefits || []), { id: bid, kind: 'credit', name: nb('name'), amount: +nb('amount'), period: nb('period') }];
      }
      try { await rwPatch(c, patch); toast('Saved'); openRwCard(c.id); } catch (err) { toast(err.message); }
    };
    showSheet();
  }

  function openRwBenefit(cardId, benId) {
    const c = rwCard(cardId); const b = c && rwBen(c, benId); if (!b) return;
    const ctx = rwCtx(), y = startOfDay().getFullYear();
    const u = RW.benUse(ctx, c, b, y); const p = u.cur;
    const left = p ? Math.max(0, p.cap - p.used) : 0;
    const snoozed = p && RW.isSnoozed(c, b, p.info);
    const back = p ? new Date(p.info.end.getFullYear(), p.info.end.getMonth(), p.info.end.getDate() + 1) : null;
    let body = '';
    if (b.kind === 'credit') {
      body = `${p ? `<div class="rw-meter"><div class="rw-mbig"><b>${RW.money(left)}</b> left of ${RW.money(p.cap)}</div>
          <span class="rw-bar"><span class="good" style="width:${p.cap ? Math.min(100, (p.used / p.cap) * 100) : 0}%"></span></span>
          <div class="meta">${esc(p.info.label || '')}${p.info.end ? ` · ${esc(rwDays(RW.daysLeft(ctx, p.info.end)))}` : ''}</div></div>` : ''}
        <div class="two"><label class="field"><span>Amount used ($)</span><input name="amount" type="number" min="0.01" step="0.01" value="${left ? Math.round(left * 100) / 100 : ''}" required></label>
          <label class="field"><span>Date</span><input name="date" type="date" value="${todayYmd()}" max="${todayYmd()}" required></label></div>
        <label class="field"><span>Note (optional)</span><input name="note" maxlength="200" placeholder="Disney+ bill"></label>
        <div class="btns"><button type="submit" class="btn dark">Log it</button></div>
        ${p && left > 0.004 ? `<button type="button" class="link" data-rwb="snooze">${snoozed ? 'Show it in Credits again' : `Hide until ${esc(rwDate(back))} (not using it this time)`}</button>` : ''}
        ${u.mine.length ? `<div class="lbl">This year</div><div class="card no-when"><ul class="list">${u.mine.slice().sort((a, z) => String(z.date || '').localeCompare(String(a.date || ''))).map((l) => `<li class="row"><div class="row-main"><div class="t">${RW.money(l.amount)}${l.kind === 'ytd' ? ' (year total)' : ''}</div><div class="meta">${l.date ? esc(rwDate(RW.parseDate(l.date))) : ''}${l.note ? ` · ${esc(l.note)}` : ''}</div></div><button type="button" class="pbtn icon" data-rwdel="${esc(l.id)}" aria-label="Delete this entry">×</button></li>`).join('')}</ul></div>` : ''}`;
    } else if (b.kind === 'cert') {
      const { cur, past } = RW.certState(ctx, c, b);
      body = cur && !cur.next ? `<div class="two"><label class="field"><span>Expires</span><input name="expires" type="date" value="${esc(cur.expires || '')}"></label>
          <label class="field"><span>Worth about ($)</span><input name="potential" type="number" min="0" value="${esc(RW.certPot(cur, b) || '')}"></label></div>
          <div class="btns"><button type="button" class="btn ghost" data-rwb="cert-save">Save</button><button type="button" class="btn dark" data-rwb="cert-used">Mark used</button></div>`
        : `<p class="sub">${cur && cur.next ? 'Used. The next one arrives at renewal.' : 'Used.'}</p>`;
      if (past.length) body += `<div class="lbl">Earlier</div><p class="meta">${past.map((x) => `${x.used ? 'Used' : 'Expired'}${x.expires ? ` (${esc(rwDate(RW.parseDate(x.expires)))})` : ''}`).join(' · ')}</p>`;
    } else body = `<p class="sub">${esc(b.note || 'A perk with nothing to track.')}</p>`;
    sheet.innerHTML = `<form method="dialog" class="rw-sheet">
      <div class="rw-shead">${rwChip(c)}<div><h3>${esc(b.name)}</h3><p class="sub">${esc(rwOwner(c))}'s ${esc(c.name)}${b.kind === 'credit' ? ` · ${RW.money(b.amount)} ${(RW.PERIOD_LABEL[b.period] || '').toLowerCase()}` : ''}</p></div></div>
      ${b.note ? `<p class="hnotes">${esc(b.note)}</p>` : ''}
      ${body}
      <div class="actions"><button type="button" class="btn ghost" data-rwb="card">${esc(c.name)} ›</button><span class="grow"></span><button type="button" class="btn ghost" data-sheet="close">Close</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (b.kind !== 'credit') return;
      const f = new FormData(form);
      try { await rwLog(c.id, b.id, +f.get('amount'), f.get('date'), f.get('note').trim()); openRwBenefit(c.id, b.id); } catch (err) { toast(err.message); }
    };
    form.querySelectorAll('[data-rwb]').forEach((el) => { el.onclick = async () => {
      const a = el.dataset.rwb;
      try {
        if (a === 'card') openRwCard(c.id);
        else if (a === 'snooze') { const sn = { ...(c.snoozed || {}) }; if (snoozed) delete sn[b.id]; else sn[b.id] = p.info.key; await rwPatch(c, { snoozed: sn }); sheet.close(); toast(snoozed ? 'Back in Credits' : `Hidden until ${rwDate(back)}`); }
        else if (a === 'cert-save' || a === 'cert-used') {
          const { cur } = RW.certState(ctx, c, b);
          const entry = { ...(cur && !cur.virtual ? cur : { id: Math.random().toString(36).slice(2, 10), benId: b.id, at: Date.now() }),
            expires: form.expires.value || '', potential: +form.potential.value || 0, used: a === 'cert-used' };
          const certs = (c.certs || []).filter((x) => x.id !== entry.id).concat(entry);
          await rwPatch(c, { certs }); openRwBenefit(c.id, b.id); toast(a === 'cert-used' ? 'Marked used' : 'Saved');
        }
      } catch (err) { toast(err.message); }
    }; });
    form.querySelectorAll('[data-rwdel]').forEach((el) => { el.onclick = async () => {
      try { await api(`/api/rewards/logs/${el.dataset.rwdel}`, { method: 'DELETE' }); await refresh(); openRwBenefit(c.id, b.id); toast('Entry deleted'); } catch (err) { toast(err.message); }
    }; });
    showSheet();
  }

  function openRwBalance(owner, prog) {
    const ctx = rwCtx(); const b = prog ? RW.bal(ctx, owner, prog) : 0;
    const known = Object.entries(((ctx.config.transfers || {}).partners) || {}).map(([k, v]) => [k, v.name]);
    const srcs = RW.SRC.map((k) => [k, RW.progName(ctx, k)]);
    sheet.innerHTML = `<form method="dialog">
      <h3>${prog ? esc(RW.progName(ctx, prog)) : 'Add a program'}</h3>
      <p class="sub">${esc(personName(owner))}'s balance${prog && ((ctx.points[owner] || {}).updated || {})[prog] ? ` · updated ${esc(rwDate(RW.parseDate(ctx.points[owner].updated[prog])))}` : ''}</p>
      ${prog ? '' : `<label class="field"><span>Program</span><select name="prog">${[...srcs, ...known].map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join('')}</select></label>`}
      <label class="field"><span>Points (you can type 66.8k or 1.2m)</span><input name="bal" inputmode="decimal" value="${b || ''}" placeholder="0"></label>
      <div class="actions">${prog ? '<button type="button" class="btn danger" data-rwp="remove">Remove</button>' : ''}<span class="grow"></span><button type="button" class="btn ghost" data-sheet="close">Cancel</button><button type="submit" class="btn dark">Save</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    const save = async (n) => { await api('/api/rewards/points', { body: { user: owner, program: prog || form.prog.value, balance: n } }); sheet.close(); await refresh(); toast('Saved'); };
    form.onsubmit = async (e) => { e.preventDefault(); const n = RW.parsePts(form.bal.value); if (Number.isNaN(n)) { toast('Enter a number like 66819 or 66.8k'); return; } try { await save(n); } catch (err) { toast(err.message); } };
    const rm = form.querySelector('[data-rwp="remove"]'); if (rm) rm.onclick = () => save(0).catch((err) => toast(err.message));
    showSheet();
  }

  function openRwAddCard() {
    sheet.innerHTML = `<form method="dialog">
      <h3>Add a card</h3>
      ${(data.users || []).length > 1 ? `<label class="field"><span>Whose card</span><select name="owner">${(data.users || []).map((u) => `<option value="${u.id}"${data.me && u.id === data.me.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
      <div class="two"><label class="field"><span>Card name</span><input name="name" required maxlength="80" placeholder="Sapphire Reserve"></label>
        <label class="field"><span>Issuer</span><input name="issuer" maxlength="40" placeholder="Chase"></label></div>
      <div class="two"><label class="field"><span>Annual fee ($)</span><input name="fee" type="number" min="0" value="0"></label>
        <label class="field"><span>Fee renews</span><input name="renews" type="date"></label></div>
      <label class="field"><span>Earns</span><select name="currency">${Object.entries(RW.CURRENCY).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <p class="sub">After saving, open the card and tap Edit card to add its credits.</p>
      <div class="actions"><span class="grow"></span><button type="button" class="btn ghost" data-sheet="close">Cancel</button><button type="submit" class="btn dark">Add card</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    form.onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(form);
      try { const r = await api('/api/rewards/cards', { body: Object.fromEntries(f) }); await refresh(); openRwCard(r.id, { edit: true }); toast('Card added'); } catch (err) { toast(err.message); }
    };
    showSheet();
  }

  // ---------- render ----------

  function currentView() {
    const h = location.hash.replace('#', '');
    return ['today', 'all', 'home', 'people', 'rewards', 'settings', 'meals'].includes(h) ? h : 'today';
  }

  function render() {
    if (needLogin) { dock.hidden = true; app.innerHTML = viewLogin(); return; }
    if (!loaded) { dock.hidden = true; app.innerHTML = '<p class="empty">Loading…</p>'; return; }
    dock.hidden = false;
    const v = currentView();
    capForm.hidden = v === 'settings';
    parsedEl.hidden = v === 'settings';
    nav.querySelectorAll('a').forEach((a) => a.setAttribute('aria-current', a.getAttribute('href') === `#${v === 'meals' || v === 'settings' ? 'today' : v}` ? 'page' : 'false'));
    const focusId = document.activeElement && document.activeElement.id;
    const caret = document.activeElement && document.activeElement.selectionStart;
    app.innerHTML = { today: viewToday, all: viewAll, home: viewHome, people: viewPeople, rewards: viewRewards, settings: viewSettings, meals: viewMeals }[v]();
    renderFocusOverlay();
    if (focusId === 'psearch' || focusId === 'allsearch' || focusId === 'hsearch') { const el = document.getElementById(focusId); if (el) { el.focus(); el.setSelectionRange(caret, caret); } }
  }

  // ---------- sheets ----------

  function openItem(it) {
    const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
    const opt = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${String(sel ?? '') === k ? ' selected' : ''}>${v}</option>`).join('');
    const people = data.people.slice(0, 2000).map((p) => `<option value="${p.id}"${it.person_id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    sheet.innerHTML = `<form method="dialog" id="item-form">
      <h3>${it.id ? 'Edit' : 'New'}</h3>
      <label class="field"><span>Title</span><input name="title" value="${esc(it.title)}" required></label>
      <div class="two">
        <label class="field"><span>Area</span><select name="area"><option value="">None</option>${opt(AREAS, it.area)}</select></label>
        <label class="field"><span>Type</span><select name="kind">${opt({ task: 'Task', note: 'Note' }, it.kind)}</select></label>
      </div>
      <label class="field"><span>Due</span><input type="datetime-local" name="due_at" value="${toLocalInput(it.due_at)}"></label>
      <div class="two">
        <label class="field"><span>Reminder</span><select name="nag">${opt(NAGS, it.nag)}</select></label>
        <label class="field"><span>Repeats every (days)</span><input type="number" min="1" name="repeat_days" value="${it.repeat_days ?? ''}" placeholder="No"></label>
      </div>
      <label class="field"><span>Person</span><select name="person_id"><option value="">None</option>${people}</select></label>
      <label class="field"><span>Notes</span><textarea name="notes">${esc(it.notes)}</textarea></label>
      <label class="inline"><input type="checkbox" name="top3"${it.top3 ? ' checked' : ''}> Top 3 today</label>
      ${others().length ? `<label class="inline"><input type="checkbox" name="shared"${it.shared ? ' checked' : ''}> Shared with ${esc(others().map((u) => u.name).join(', '))}</label>
      ${it.shared && it.user_id && data.me && it.user_id !== data.me.id ? `<p class="hint">${esc(personName(it.user_id))} added this, so reminders go to their phone.</p>` : ''}` : ''}
      ${it.id && it.status === 'open' ? `<div class="btns"><button type="button" class="pbtn" data-focus-min="25">Focus 25 min</button><button type="button" class="pbtn" data-focus-min="50">Focus 50 min</button></div>` : ''}
      <div class="actions">
        ${it.id ? '<button type="button" class="btn danger" data-sheet="delete">Delete</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-sheet="close">Cancel</button>
        <button type="submit" class="btn dark">Save</button>
      </div>
    </form>`;
    const form = sheet.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const body = {
        title: f.get('title').trim(), area: f.get('area') || null, kind: f.get('kind'), nag: f.get('nag'),
        due_at: f.get('due_at') ? new Date(f.get('due_at')).toISOString() : null,
        repeat_days: f.get('repeat_days') ? +f.get('repeat_days') : null,
        person_id: f.get('person_id') ? +f.get('person_id') : null,
        notes: f.get('notes').trim() || null, top3: f.get('top3') ? 1 : 0,
      };
      if (others().length) body.shared = f.get('shared') ? 1 : 0;
      try {
        if (it.id) await api(`/api/items/${it.id}`, { method: 'PATCH', body });
        else await api('/api/items', { body });
        sheet.close();
        await refresh();
        toast('Saved');
      } catch (err) { toast(err.message); }
    };
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    form.querySelectorAll('[data-focus-min]').forEach((b) => { b.onclick = async () => { sheet.close(); await startFocus(it.id, +b.dataset.focusMin); }; });
    const del = form.querySelector('[data-sheet="delete"]');
    if (del) del.onclick = async () => {
      if (!confirm(`Delete "${it.title}"?`)) return;
      await api(`/api/items/${it.id}`, { method: 'DELETE' });
      sheet.close();
      await refresh();
    };
    showSheet();
  }

  // Settings for a synced calendar event. Saved by title (all of them) or for
  // just this one, so they survive every calendar sync.
  function openEvent(e) {
    if (!e) return;
    const prefs = Object.fromEntries((data.event_prefs || []).map((r) => [r.key, r]));
    const start = new Date(e.start_at);
    const when = e.all_day ? start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      : `${start.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · ${fmtTime(e.start_at)}${e.end_at ? `–${fmtTime(e.end_at)}` : ''}`;
    const isBday = /\bbirthday\b/i.test(e.title) && data.settings.hide_cal_birthdays === '1';
    const fieldsFor = (key) => {
      const r = prefs[key] || {};
      return { hide: r.hidden === 1, leave: r.leave === null || r.leave === undefined ? '' : String(r.leave), travel: r.travel_min ?? '', note: r.note || '' };
    };
    const startScope = prefs[e.one] ? 'one' : 'all';
    sheet.innerHTML = `<form method="dialog">
      <h3>${esc(e.title)}</h3>
      <p class="sub">${esc(when)}${e.location ? ` · ${esc(e.location)}` : ''}<br>From your calendar. Change the event itself in Apple Calendar; these settings are just for this app and survive every sync.</p>
      <div class="filters" role="radiogroup" aria-label="Apply to">
        <button type="button" data-scope="all" aria-pressed="${startScope === 'all'}">All “${esc(e.title.length > 24 ? e.title.slice(0, 22) + '…' : e.title)}” events</button>
        <button type="button" data-scope="one" aria-pressed="${startScope === 'one'}">Just this one</button>
      </div>
      <label class="inline"><input type="checkbox" name="hide"> Hide from Today and my briefing</label>
      <label class="field"><span>Note (shows under the event)</span><input name="note" maxlength="500" placeholder="e.g. bring paperwork"></label>
      <div class="actions"><button type="button" class="btn danger" data-sheet="reset">Reset</button><span class="grow"></span>
        <button type="button" class="btn ghost" data-sheet="close">Cancel</button><button type="submit" class="btn dark">Save</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    let scope = startScope;
    const fill = () => {
      const key = scope === 'one' ? e.one : e.all;
      const f = fieldsFor(key);
      const r = prefs[key] || {};
      form.hide.checked = f.hide || (isBday && r.hidden !== 0); // birthday events are hidden by your setting unless you un-hid this one
      form.note.value = f.note;
      form.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === scope)));
    };
    fill();
    form.querySelectorAll('[data-scope]').forEach((b) => { b.onclick = () => { scope = b.dataset.scope; fill(); }; });
    const save = async (body) => {
      await api('/api/event-prefs', { body: { key: scope === 'one' ? e.one : e.all, label: scope === 'one' ? `${e.title} (${when})` : e.title, ...body } });
      sheet.close();
      await refresh();
    };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        await save({
          hidden: form.hide.checked ? 1 : (isBday ? 0 : null),
          note: form.note.value.trim() || null,
        });
        toast(form.hide.checked ? 'Hidden. Find it in Settings › Calendar to show it again.' : 'Saved');
      } catch (err) { toast(err.message); }
    };
    form.querySelector('[data-sheet="reset"]').onclick = async () => { try { await save({}); toast('Back to normal'); } catch (err) { toast(err.message); } };
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    showSheet();
  }

  function openTrip(t) {
    const bookings = t.id && t.external_id ? data.items.filter((i) => (i.external_id || '').startsWith(`${t.external_id}:`) && i.status === 'open').length : 0;
    sheet.innerHTML = `<form method="dialog">
      <h3>${t.id ? esc(t.name) : 'New trip'}</h3>
      ${t.source === 'wayfare' ? `<p class="sub">Synced from Wayfare${bookings ? ` · ${plural(bookings, 'booking')} to make` : ''}. Your edits here are kept.</p>` : ''}
      <label class="field"><span>Name</span><input name="name" value="${esc(t.name || '')}" required maxlength="120"></label>
      <div class="two"><label class="field"><span>Start</span><input type="date" name="start_date" value="${esc(t.start_date || '')}" required></label>
        <label class="field"><span>End</span><input type="date" name="end_date" value="${esc(t.end_date || '')}"></label></div>
      <label class="field"><span>Link (optional)</span><input type="url" name="link" value="${esc(t.link || '')}" placeholder="https://claude.ai/artifact/…"></label>
      <p class="sub" style="margin:-6px 0 0">Paste your Wayfare trip's address, any other trip page, or leave it empty for no link.</p>
      <div class="actions">${t.id ? '<button type="button" class="btn danger" data-sheet="delete">Delete</button>' : ''}<span class="grow"></span>
        <button type="button" class="btn ghost" data-sheet="close">Cancel</button><button type="submit" class="btn dark">Save</button></div>
    </form>`;
    const form = sheet.querySelector('form');
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    // End date follows the start date, so its picker opens on the right month.
    const syncEnd = () => {
      const st = form.start_date.value;
      form.end_date.min = st || '';
      if (st && (!form.end_date.value || form.end_date.value < st)) form.end_date.value = st;
    };
    form.start_date.addEventListener('change', syncEnd);
    form.start_date.addEventListener('input', syncEnd);
    syncEnd();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const link = form.link.value.trim();
      if (link && !/^https:\/\//.test(link)) { toast('Links need to start with https://'); return; }
      const body = { name: form.name.value.trim(), start_date: form.start_date.value, end_date: form.end_date.value || null, link: link || null };
      try { if (t.id) await api(`/api/trips/${t.id}`, { method: 'PATCH', body }); else await api('/api/trips', { body });
        sheet.close(); await refresh(); toast('Saved'); } catch (err) { toast(err.message); }
    };
    const del = form.querySelector('[data-sheet="delete"]');
    if (del) del.onclick = async () => {
      if (!confirm(`Delete ${t.name}? Its booking reminders stay in your task list.`)) return;
      await api(`/api/trips/${t.id}`, { method: 'DELETE' }); sheet.close(); await refresh(); toast('Trip deleted');
    };
    showSheet();
  }

  function openDocument(d) {
    const months = [3, 6, 9, 12].map((n) => `<option value="${n}"${(d.remind_months || 9) === n ? ' selected' : ''}>${n} months before</option>`).join('');
    sheet.innerHTML = `<form method="dialog">
      <h3>${d.id ? esc(d.name) : 'New document'}</h3>
      <label class="field"><span>Document</span><input name="name" list="doc-names" value="${esc(d.name)}" required placeholder="Passport"></label>
      <datalist id="doc-names"><option value="Passport"><option value="Global Entry"><option value="TSA PreCheck"><option value="Driver's license"><option value="REAL ID"></datalist>
      <div class="two">
        <label class="field"><span>Expires</span><input type="date" name="expires_on" value="${esc(d.expires_on)}" required></label>
        <label class="field"><span>Remind me</span><select name="remind_months">${months}</select></label>
      </div>
      <label class="field"><span>Notes (avoid document numbers)</span><textarea name="notes">${esc(d.notes)}</textarea></label>
      <div class="actions">
        ${d.id ? '<button type="button" class="btn danger" data-sheet="delete">Delete</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-sheet="close">Cancel</button>
        <button type="submit" class="btn dark">Save</button>
      </div>
    </form>`;
    const form = sheet.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      try {
        if (d.id) await api(`/api/documents/${d.id}`, { method: 'PATCH', body: f });
        else await api('/api/documents', { body: f });
        sheet.close();
        await refresh();
        toast('Saved. Renewal reminder set.');
      } catch (err) { toast(err.message); }
    };
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    const del = form.querySelector('[data-sheet="delete"]');
    if (del) del.onclick = async () => {
      if (!confirm(`Delete ${d.name}?`)) return;
      await api(`/api/documents/${d.id}`, { method: 'DELETE' });
      sheet.close();
      await refresh();
    };
    showSheet();
  }

  function personExtras(p) {
    const gifts = (data.gifts || []).filter((g) => g.person_id === p.id);
    const dates = (data.person_dates || []).filter((d) => d.person_id === p.id);
    const giftRows = gifts.map((g) => `<li class="row"><div class="row-main"><div class="t${g.status === 'given' ? ' done-t' : ''}">${esc(g.idea)}</div>
      <div class="meta">${g.status === 'idea' ? 'Idea' : g.status === 'bought' ? 'Bought' : 'Given'}${g.link ? ` · <a href="${esc(g.link)}" target="_blank" rel="noopener">link</a>` : ''}</div></div>
      ${g.status === 'idea' ? `<button type="button" class="pbtn" data-gift="bought" data-id="${g.id}">Bought</button>` : g.status === 'bought' ? `<button type="button" class="pbtn" data-gift="given" data-id="${g.id}">Given</button>` : ''}
      <button type="button" class="pbtn icon" data-gift="del" data-id="${g.id}" aria-label="Remove ${esc(g.idea)}">×</button></li>`).join('');
    const dateRows = dates.map((d) => { const b = birthdayIn(d.date);
      return `<li class="row"><div class="row-main"><div class="t">${esc(d.label)}</div><div class="meta">${b ? esc(b.date.toLocaleDateString([], { month: 'long', day: 'numeric' })) + ` · in ${b.days} days` : esc(d.date)}${d.remind ? ' · reminding you' : ''}</div></div>
      <button type="button" class="pbtn" data-pdate="remind" data-id="${d.id}" data-v="${d.remind ? 0 : 1}">${d.remind ? 'Mute' : 'Remind'}</button>
      <button type="button" class="pbtn icon" data-pdate="del" data-id="${d.id}" aria-label="Remove ${esc(d.label)}">×</button></li>`; }).join('');
    return `<div class="field"><span>Gift ideas · you'll get a nudge 2 weeks before their birthday</span>
        ${giftRows ? `<div class="card"><ul class="list">${giftRows}</ul></div>` : ''}
        <div class="addrow"><input id="gift-new" placeholder="Idea (paste a link too)" maxlength="300"><button type="button" class="pbtn" data-gift="add">Add</button></div></div>
      <div class="field"><span>Important dates</span>
        ${dateRows ? `<div class="card"><ul class="list">${dateRows}</ul></div>` : ''}
        <div class="addrow"><input id="pd-label" placeholder="Anniversary" maxlength="60" style="flex:1.2"><input id="pd-date" type="date" aria-label="Date" style="flex:1"></div>
        <div class="addrow"><label class="inline" style="flex:1"><input type="checkbox" id="pd-remind" checked> Remind me on the day</label><button type="button" class="pbtn" data-pdate="add">Add date</button></div></div>`;
  }

  // Gift ideas and important dates save immediately and redraw just their own
  // section, so the sheet stays put and anything you've typed above is kept.
  function bindPersonExtras(form, p) {
    const box = form.querySelector('#p-extras');
    if (!box) return;
    const redraw = async () => {
      await refresh();
      const fresh = data.people.find((x) => x.id === p.id) || p;
      box.innerHTML = personExtras(fresh);
      bindPersonExtras(form, fresh);
    };
    const addGift = async () => {
      const inp = box.querySelector('#gift-new'); const v = inp.value.trim(); if (!v) return;
      const link = (v.match(/https?:\/\/\S+/) || [])[0] || null;
      await api('/api/gifts', { body: { person_id: p.id, idea: v.replace(link || '', '').trim() || v, link } });
      await redraw(); toast('Gift idea added');
    };
    const addDate = async () => {
      const label = box.querySelector('#pd-label').value.trim() || 'Anniversary', d = box.querySelector('#pd-date').value;
      if (!d) { toast('Pick a date'); return; }
      await api('/api/person-dates', { body: { person_id: p.id, label, date: d, remind: box.querySelector('#pd-remind').checked } });
      await redraw(); toast('Date added');
    };
    // Enter in these boxes adds the item instead of submitting the whole form.
    box.querySelectorAll('#gift-new, #pd-label, #pd-date').forEach((inp) => {
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); (inp.id === 'gift-new' ? addGift() : addDate()).catch((err) => toast(err.message)); } };
    });
    box.querySelectorAll('[data-gift]').forEach((b) => { b.onclick = async () => {
      const id = +b.dataset.id, act = b.dataset.gift;
      try {
        if (act === 'add') return await addGift();
        if (act === 'del') await api(`/api/gifts/${id}`, { method: 'DELETE' });
        else await api(`/api/gifts/${id}`, { method: 'PATCH', body: { status: act } });
        await redraw();
      } catch (err) { toast(err.message); }
    }; });
    box.querySelectorAll('[data-pdate]').forEach((b) => { b.onclick = async () => {
      const id = +b.dataset.id, act = b.dataset.pdate;
      try {
        if (act === 'add') return await addDate();
        if (act === 'del') await api(`/api/person-dates/${id}`, { method: 'DELETE' });
        else if (act === 'remind') await api(`/api/person-dates/${id}`, { method: 'PATCH', body: { remind: +b.dataset.v } });
        await redraw();
      } catch (err) { toast(err.message); }
    }; });
  }

  function openPerson(p) {
    const b = birthdayIn(p.birthday);
    const opt = Object.entries(CHECKINS).map(([k, v]) => `<option value="${k}"${String(p.checkin_days ?? '') === k ? ' selected' : ''}>${v}</option>`).join('');
    sheet.innerHTML = `<form method="dialog" id="person-form">
      ${p.id ? `<div style="display:flex;gap:14px;align-items:center">
        <span class="avatar lg a-people">${esc(initials(p.name))}</span>
        <div><h3>${esc(p.name)}</h3><p class="sub" style="margin:2px 0 0">${[
          b ? `Birthday ${b.date.toLocaleDateString([], { month: 'long', day: 'numeric' })}${b.days === 0 ? ' (today)' : ` (in ${b.days} days)`}` : '',
          p.last_contact_at ? `last ${esc(p.last_contact_how || 'contact')} ${daysBetween(new Date(p.last_contact_at), new Date())} days ago` : 'no contact logged',
        ].filter(Boolean).join(' · ')}</p></div></div>
      <div class="btns">
        <button type="button" class="pbtn" data-log="called">Called ✓</button>
        <button type="button" class="pbtn" data-log="texted">Texted ✓</button>
        <button type="button" class="pbtn" data-log="saw">Saw them ✓</button>
      </div>` : '<h3>New person</h3>'}
      <label class="field"><span>Name</span><input name="name" value="${esc(p.name)}" required></label>
      <div class="two">
        <label class="field"><span>Birthday</span><input name="birthday" value="${esc(p.birthday)}" placeholder="YYYY-MM-DD or --MM-DD"></label>
        <label class="field"><span>Check in</span><select name="checkin_days">${opt}</select></label>
      </div>
      <div class="two">
        <label class="field"><span>Circle</span><select name="circle"><option value="">—</option>${Object.entries(CIRCLES).map(([k, v]) => `<option value="${k}"${p.circle === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      ${p.id ? `<div id="p-extras"${inCircle(p) ? '' : ' hidden'}>${personExtras(p)}</div>
      <p class="sub" id="p-extras-hint" style="margin:0"${inCircle(p) ? ' hidden' : ''}>Set them as Family or Close friend to keep gift ideas and important dates.</p>` : ''}
      <label class="inline"><input type="checkbox" name="bday_notify"${p.bday_notify !== 0 ? ' checked' : ''}> Show their birthday on Today and in my briefing</label>
      <label class="inline"><input type="checkbox" name="bday_remind"${p.bday_remind ? ' checked' : ''}> Remind me hourly on their birthday until I've wished them</label>
      <label class="field"><span>Notes</span><textarea name="notes">${esc(p.notes)}</textarea></label>
      <div class="actions">
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-sheet="close">Close</button>
        <button type="submit" class="btn dark">Save</button>
      </div>
    </form>`;
    const form = sheet.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const body = { name: f.get('name').trim(), birthday: f.get('birthday').trim() || null, checkin_days: f.get('checkin_days') ? +f.get('checkin_days') : null, notes: f.get('notes').trim() || null, bday_remind: f.get('bday_remind') ? 1 : 0, bday_notify: f.get('bday_notify') ? 1 : 0, circle: f.get('circle') || null };
      try {
        if (p.id) await api(`/api/people/${p.id}`, { method: 'PATCH', body });
        else await api('/api/people', { body });
        sheet.close();
        await refresh();
        toast('Saved');
      } catch (err) { toast(err.message); }
    };
    form.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    // Choosing Family / Close friend shows gift ideas and dates right here.
    form.circle.onchange = () => {
      const on = form.circle.value === 'family' || form.circle.value === 'close';
      const ex = form.querySelector('#p-extras'), hint = form.querySelector('#p-extras-hint');
      if (ex) ex.hidden = !on;
      if (hint) hint.hidden = on;
    };
    if (p.id) bindPersonExtras(form, p);
    form.querySelectorAll('[data-log]').forEach((btn) => {
      btn.onclick = async () => {
        await api(`/api/people/${p.id}/contact`, { body: { how: btn.dataset.log } });
        const undo = remember(`Logged: ${btn.dataset.log} ${p.name}`, { k: 'contact', id: p.id, prev: { last_contact_at: p.last_contact_at || null, last_contact_how: p.last_contact_how || null } });
        sheet.close();
        toast(`Logged: ${btn.dataset.log} ${p.name.split(' ')[0]}`, undo);
        await refresh();
      };
    });
    showSheet();
  }

  // ---------- events ----------

  capInput.addEventListener('input', () => {
    const v = capInput.value.trim();
    parsedEl.innerHTML = v ? parsedTags(parseCapture(v, data.people)) : '';
  });

  // Capture starts as a lone + button; tapping it opens the text box and keyboard.
  const capOpen = () => { capForm.classList.remove('collapsed'); capInput.focus(); };
  const capClose = () => { capForm.classList.add('collapsed'); capInput.value = ''; parsedEl.innerHTML = ''; capInput.blur(); };
  capForm.querySelector('button').addEventListener('click', (e) => {
    if (capForm.classList.contains('collapsed')) { e.preventDefault(); capOpen(); }
  });
  capInput.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== capInput && !capInput.value.trim()) capClose();
  }, 150));
  capInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') capClose(); });

  capForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = capInput.value.trim();
    if (!raw) { capClose(); return; }
    const p = parseCapture(raw, data.people);
    try {
      const created = await api('/api/items', { body: { title: p.title, area: p.area, kind: p.kind, due_at: p.due ? p.due.toISOString() : null, nag: p.nag, repeat_days: p.repeat || null, person_id: p.person ? p.person.id : null } });
      capClose();
      await refresh();
      toast('Added', async () => { await api(`/api/items/${created.id}`, { method: 'DELETE' }); refresh(); });
    } catch (err) { toast(err.message); }
  });

  app.addEventListener('input', (e) => {
    if (e.target.id === 'psearch') { ui.peopleQuery = e.target.value; render(); }
    if (e.target.id === 'allsearch') { ui.q = e.target.value; render(); }
    if (e.target.id === 'hsearch') { ui.homeQ = e.target.value; render(); }
  });

  app.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.id === 'login') {
      token = new FormData(form).get('token');
      try {
        await refresh();
        try { localStorage.setItem('life_token', token); } catch (_) { /* ignore */ }
      } catch (err) { toast(err.message); }
      return;
    }
    if (form.id === 'travel-form' || form.id === 'wrap-form' || form.id === 'meal-form' || form.id === 'shared-cal-form') {
      await api('/api/settings', { method: 'PATCH', body: Object.fromEntries(new FormData(form)) });
      toast('Saved');
      await refresh();
      return;
    }
    if (form.id === 'settings-form') {
      await api('/api/settings', { method: 'PATCH', body: Object.fromEntries(new FormData(form)) });
      toast('Saved');
      await refresh();
    }
  });

  app.addEventListener('change', async (e) => {
    if (e.target.id === 'hide-bdays') {
      await api('/api/settings', { method: 'PATCH', body: { hide_cal_birthdays: e.target.checked ? '1' : '0' } });
      await refresh();
      toast(e.target.checked ? 'Birthday events hidden' : 'Birthday events shown');
      return;
    }
    if (e.target.id !== 'vcf' || !e.target.files[0]) return;
    try {
      const cards = parseVcards(await e.target.files[0].text());
      e.target.value = '';
      if (!cards.length) { toast('No contacts found in that file'); return; }
      openContactsReview(cards);
    } catch (err) { toast(`Couldn't read that file: ${err.message}`); }
  });

  async function markDone(id) {
    const it = data.items.find((i) => i.id === id);
    await api(`/api/items/${id}/done`, { body: {} });
    const undo = remember(`Done: ${it ? it.title : 'Task'}`, { k: 'item', id, prev: { status: 'open', due_at: it ? it.due_at : null, snooze_until: it ? it.snooze_until : null } });
    await refresh();
    toast(it && it.repeat_days ? 'Done. Rescheduled.' : 'Done', undo);
  }

  // "Later": pick how long to snooze.
  function snoozeChoices() {
    const now = new Date();
    const at = (daysAhead, h) => { const d = startOfDay(now); d.setDate(d.getDate() + daysAhead); d.setHours(h, 0, 0, 0); return d; };
    const out = [{ label: 'In 1 hour', sub: fmtTime(new Date(Date.now() + 3600000).toISOString()), until: new Date(Date.now() + 3600000) }];
    if (now.getHours() < 17) out.push({ label: 'This evening', sub: '6pm', until: at(0, 18) });
    out.push({ label: 'Tomorrow morning', sub: `${weekday(at(1, 9))} 9am`, until: at(1, 9) });
    const dow = now.getDay();
    if (dow >= 1 && dow <= 4) out.push({ label: 'This weekend', sub: 'Sat 9am', until: at(6 - dow, 9) });
    const toMon = ((8 - dow) % 7) || 7; // next Monday; if that's tomorrow, the one after
    const nextMon = at(toMon === 1 ? 8 : toMon, 9);
    out.push({ label: 'Next week', sub: nextMon.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' 9am', until: nextMon });
    return out;
  }

  function openSnooze(id) {
    const it = data.items.find((i) => i.id === id);
    const choices = snoozeChoices();
    sheet.innerHTML = `<form method="dialog">
      <h3>Remind me later</h3>
      ${it ? `<p class="sub">${esc(it.title)}</p>` : ''}
      <div class="card"><ul class="list">${choices.map((c, i) => `<li class="row"><button type="button" class="row-main" data-pick="${i}" style="display:flex;justify-content:space-between;align-items:center"><span class="t">${esc(c.label)}</span><span class="meta" style="margin:0">${esc(c.sub)}</span></button></li>`).join('')}</ul></div>
      <div class="actions"><span class="grow"></span><button type="button" class="btn ghost" data-sheet="close">Cancel</button></div>
    </form>`;
    sheet.querySelector('[data-sheet="close"]').onclick = () => sheet.close();
    sheet.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = async () => {
        const c = choices[+b.dataset.pick];
        sheet.close();
        try {
          await api(`/api/items/${id}/snooze`, { body: { until: c.until.toISOString() } });
          const undo = remember(`Snoozed: ${it ? it.title : 'Task'} (${c.label.toLowerCase()})`, { k: 'item', id, prev: { snooze_until: it ? it.snooze_until : null } });
          await refresh();
          toast(`Snoozed: ${c.label.toLowerCase()}`, undo);
        } catch (err) { toast(err.message); }
      };
    });
    showSheet();
  }

  async function snoozeHour(id) { openSnooze(id); }

  // ---------- swipe gestures ----------
  const SWIPE_AT = 80;
  let sw = null;
  let suppressClick = false;
  app.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('li[data-swipe]');
    if (!row || (e.pointerType === 'mouse' && e.button !== 0)) return;
    sw = { row, id: +row.dataset.swipe, kind: row.dataset.kind || 'item', x: e.clientX, y: e.clientY, dx: 0, active: false };
  });
  app.addEventListener('pointermove', (e) => {
    if (!sw) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (!sw.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
      if (Math.abs(dx) < 12) return;
      sw.active = true;
      sw.row.classList.add('swiping');
    }
    sw.dx = Math.max(-150, Math.min(150, dx));
    sw.row.style.setProperty('--dx', `${sw.dx}px`);
    sw.row.dataset.dir = sw.dx > 0 ? 'done' : 'later';
    sw.row.classList.toggle('armed', Math.abs(sw.dx) >= SWIPE_AT);
  });
  const endSwipe = async () => {
    if (!sw) return;
    const s = sw;
    sw = null;
    if (!s.active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
    s.row.classList.remove('swiping', 'armed');
    s.row.style.setProperty('--dx', '0px');
    if (Math.abs(s.dx) < SWIPE_AT) return;
    try {
      if (s.kind === 'home') await (s.dx > 0 ? homeLog(s.id, todayYmd()) : homeSnooze(s.id, 7));
      else await (s.dx > 0 ? markDone(s.id) : snoozeHour(s.id));
    } catch (err) { toast(err.message); }
  };
  app.addEventListener('pointerup', endSwipe);
  app.addEventListener('pointercancel', endSwipe);
  app.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  // Press and hold a habit to open its streak, history and schedule
  let holdTimer = null;
  app.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.habit'); if (!h) return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 400); const t = taskById(+h.dataset.id); if (t) openTask(t); }, 500);
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'].forEach((ev) => app.addEventListener(ev, (e) => { if (ev !== 'pointermove' || Math.abs(e.movementX) + Math.abs(e.movementY) > 6) clearTimeout(holdTimer); }));
  app.addEventListener('contextmenu', (e) => { if (e.target.closest('.habit')) e.preventDefault(); });

  app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = +el.dataset.id;
    const act = el.dataset.act;
    if (act === 'rw-tab') { ui.rwTab = el.dataset.v; render(); window.scrollTo(0, 0); return; }
    if (act === 'rw-who') { ui.rwWho = el.dataset.v; render(); return; }
    if (act === 'rw-type') { ui.rwType = el.dataset.v; render(); return; }
    if (act === 'rw-card') { openRwCard(el.dataset.id); return; }
    if (act === 'rw-ben') { openRwBenefit(el.dataset.card, el.dataset.ben); return; }
    if (act === 'rw-bal') { openRwBalance(+el.dataset.owner, el.dataset.prog); return; }
    if (act === 'rw-add-prog') { openRwBalance(+el.dataset.owner, null); return; }
    if (act === 'rw-add-card') { openRwAddCard(); return; }
    if (act === 'rw-use-all') {
      const c = rwCard(el.dataset.card), b = c && rwBen(c, el.dataset.ben);
      const p = b && RW.benUse(rwCtx(), c, b, startOfDay().getFullYear()).cur;
      if (p) { (el.closest('.row') || el).classList.add('completing'); rwLog(c.id, b.id, Math.round((p.cap - p.used) * 100) / 100, todayYmd(), '').catch((err) => toast(err.message)); }
      return;
    }
    if (act === 'backup') {
      (async () => {
        const res = await fetch('/api/backup', { headers: token ? { authorization: `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error("Couldn't make the backup");
        const blob = await res.blob();
        const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'life-backup.json';
        const file = new File([blob], name, { type: 'application/json' });
        // iPhone: the share sheet offers "Save to Files"; elsewhere a normal download
        const download = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
        let shared = false;
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file] }); shared = true; }
          catch (err) { shared = err && err.name === 'AbortError'; } // closed the sheet: fine; not allowed: download instead
        }
        if (!shared) download();
        await refresh(); toast('Backup ready');
      })().catch((err) => toast(err.message));
      return;
    }
    if (act === 'push-on') { turnOnPush().catch((err) => toast(`Couldn't turn on notifications: ${err.message}`)); return; }
    if (act === 'push-off') { turnOffPush().catch((err) => toast(err.message)); return; }
    // A quick check-off animation before the list updates
    if (['done', 'home-done', 'med-take'].includes(act) || (act === 'habit' && !el.classList.contains('on'))) {
      (el.closest('.row') || el).classList.add('completing');
      await new Promise((r) => setTimeout(r, 260));
    }
    try {
      if (act === 'done') await markDone(id);
      else if (act === 'snooze') await snoozeHour(id);
      else if (act === 'reopen') {
        await api(`/api/items/${id}`, { method: 'PATCH', body: { status: 'open' } });
        await refresh();
      } else if (act === 'talked') {
        const p = data.people.find((x) => x.id === id);
        await api(`/api/people/${id}/contact`, { body: { how: 'talked' } });
        const undo = remember(`Logged: talked to ${p.name}`, { k: 'contact', id, prev: { last_contact_at: p.last_contact_at || null, last_contact_how: p.last_contact_how || null } });
        await refresh();
        toast(`Logged: talked to ${p.name.split(' ')[0]}`, undo);
      } else if (act === 'edit') openItem(data.items.find((i) => i.id === id));
      else if (act === 'person') openPerson(data.people.find((p) => p.id === id));
      else if (act === 'new-person') openPerson({ name: '' });
      else if (act === 'doc') openDocument(data.documents.find((d) => d.id === id));
      else if (act === 'new-doc') openDocument({ name: '', remind_months: 9 });
      else if (act === 'habit') {
        const t = taskById(id); const o = t && taskOcc(t);
        if (!o) return;
        const was = !!(o.log && o.log.status !== 'skipped');
        await api(`/api/tasks/${id}/log`, { body: { occ: o.key, status: was ? 'undo' : 'done' } });
        const undo = remember(`${was ? 'Unchecked' : 'Checked'} ${t.title}`, { k: 'habit', id, occ: o.key, was });
        await refresh();
        if (!was) { const s = streakOf(taskById(id)).current; toast(s > 1 ? `Nice: ${s} in a row 🔥` : 'Checked off', undo); }
      } else if (act === 'edit-habits') openHabits();
      else if (act === 'event') openEvent(data.events.find((x) => x.id === id));
      else if (act === 'trip-open') openTrip(data.trips.find((x) => x.id === id));
      else if (act === 'trip-new') openTrip({});
      else if (act === 'day') openDay(el.dataset.date);
      else if (act === 'toggle-sec') {
        const k = el.dataset.def === '1' ? `+${el.dataset.key}` : el.dataset.key; if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
        try { localStorage.setItem('life_collapsed', JSON.stringify([...collapsed])); } catch (_) { /* ignore */ }
        render();
      } else if (act === 'setup-hide') { try { localStorage.setItem('life_setup_hidden', '1'); } catch (_) { /* ignore */ } render(); }
      else if (act === 'new-item') openItem({ title: '', kind: 'task', nag: 'once' });
      else if (act === 'jump') document.getElementById(el.dataset.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else if (act === 'meal-open') openMeal(el.dataset.date);
      else if (act === 'go-meals') location.hash = '#meals';
      else if (act === 'recent') openRecent();
      else if (act === 'meal-ate') {
        const d = el.dataset.date;
        await api(`/api/meals/${d}/eaten`, { body: { eaten: 1 } });
        const undo = remember('Marked dinner as eaten', { k: 'meal-eaten', date: d });
        await refresh();
        toast('Dinner hidden for tonight', undo);
      }
      else if (act === 'meal-week') { ui.mealWeek = +el.dataset.v; render(); }
      else if (act === 'home-done') await homeLog(id, todayYmd());
      else if (act === 'home-open') openHomeTask(data.home_tasks.find((x) => x.id === id));
      else if (act === 'home-new') openHomeTask({});
      else if (act === 'home-view') { ui.homeView = el.dataset.v; render(); }
      else if (act === 'home-room') { ui.homeRoom = el.dataset.v; render(); }
      else if (act === 'home-room-pick') openRoomPicker();
      else if (act === 'home-jump') {
        if (el.dataset.to === 'g-later' && isFolded('home-later', true)) { collapsed.add('+home-later'); try { localStorage.setItem('life_collapsed', JSON.stringify([...collapsed])); } catch (_) { /* ignore */ } }
        if (ui.homeView !== 'now') ui.homeView = 'now';
        render(); document.getElementById(el.dataset.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (act === 'home-select') { ui.homeSelect = new Set(); render(); }
      else if (act === 'home-select-cancel') { ui.homeSelect = null; render(); }
      else if (act === 'home-pick') { const sel = ui.homeSelect; if (sel.has(id)) sel.delete(id); else sel.add(id); render(); }
      else if (act === 'home-batch-done') {
        const ids = [...ui.homeSelect]; ui.homeSelect = null;
        const snooze = Object.fromEntries(ids.map((x) => [x, (data.home_tasks.find((t) => t.id === x) || {}).snooze_until || null]));
        for (const x of ids) await api(`/api/home/tasks/${x}/log`, { body: { date: todayYmd() } });
        const undo = remember(`Done: ${plural(ids.length, 'Home task')}`, { k: 'home-log', ids, date: todayYmd(), snooze });
        await refresh(); toast(`Marked ${plural(ids.length, 'task')} done`, undo);
      }
      else if (act === 'med-take') await logMed(id, el.dataset.slot, 'taken');
      else if (act === 'med-undo') { if (confirm('Undo this dose?')) await logMed(id, el.dataset.slot, 'undo'); }
      else if (act === 'med-open') { const t = taskById(id); if (t) openTask(t); }
      else if (act === 'med-new') openTask({ kind: 'med', repeat: 'daily', time: '08:00', nag: 1, nag_mode: 'hourly' });
      else if (act === 'wrap-move') {
        const ids = el.dataset.ids.split(',').map(Number);
        const t = startOfDay(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
        const list = ids.map((x) => { const it = data.items.find((i) => i.id === x) || {}; return { id: x, prev: { due_at: it.due_at || null, snooze_until: it.snooze_until || null } }; });
        await api('/api/wrap/move', { body: { ids, to: t.toISOString() } });
        const undo = remember(`Moved ${plural(ids.length, 'item')} to tomorrow`, { k: 'items', list });
        await refresh();
        toast(`Moved ${plural(ids.length, 'item')} to tomorrow 9am`, undo);
      } else if (act === 'wrap-review') { location.hash = '#all'; }
      else if (act === 'unhide') { await api('/api/event-prefs', { body: { key: el.dataset.key, ...JSON.parse(el.dataset.keep || '{}'), hidden: null } }); await refresh(); toast('Showing it again'); }
      else if (act === 'focus-open') { focusHidden = false; render(); }
      else if (act === 'focus-free') await startFocus(null, +el.dataset.min || 25);
      else if (act === 'locate') {
        if (!navigator.geolocation) { toast('Location is not available in this browser'); return; }
        toast('Finding your location…');
        navigator.geolocation.getCurrentPosition(async (pos) => {
          await api('/api/settings', { method: 'PATCH', body: { weather_lat: pos.coords.latitude, weather_lon: pos.coords.longitude } });
          weatherAt = 0; await refresh(); toast('Weather location saved');
        }, () => toast('Location permission was declined'), { maximumAge: 600000, timeout: 15000 });
      } else if (act === 'unlocate') {
        await api('/api/settings', { method: 'PATCH', body: { weather_lat: '', weather_lon: '' } });
        weather = null; weatherAt = 0; await refresh(); toast('Weather location removed');
      }
      else if (act === 'area') { ui.allArea = el.dataset.v; render(); }
      else if (act === 'pfilter') { ui.peopleFilter = el.dataset.v; render(); }
      else if (act === 'toggle-done') { ui.showDone = !ui.showDone; render(); }
      else if (act === 'palette') { window.lifeTheme.setPalette(el.dataset.v); data.settings.palette = el.dataset.v; render(); await api('/api/settings', { method: 'PATCH', body: { palette: el.dataset.v } }); }
      else if (act === 'test-push') { await api('/api/test-push', { body: {} }); toast('Sent. Check your phone.'); }
      else if (act === 'briefing') { if (el.disabled) return; el.disabled = true; setTimeout(() => { el.disabled = false; }, 10000); const r = await api('/api/run-cron', { body: { briefing: true } }); toast(r.briefing === 'sent' ? 'Briefing sent. Check your phone.' : `Briefing didn't send: ${r.briefing || 'unknown error'}`); }
      else if (act === 'logout') logout();
    } catch (err) { toast(err.message); }
  });

  window.addEventListener('hashchange', () => {
    if (currentView() === 'people') { ui.peopleFilter = 'birthdays'; ui.peopleQuery = ''; } // People always opens on Birthdays
    render(); window.scrollTo(0, 0);
  });

  // Pull down at the top of the page to refresh
  const ptr = document.createElement('div');
  ptr.className = 'ptr'; ptr.setAttribute('aria-hidden', 'true');
  document.body.appendChild(ptr);
  let pull = null;
  document.addEventListener('touchstart', (e) => {
    // Not from sideways-scrolling rows (room chips, settings jump bar) or swipeable rows
    if (e.target.closest && e.target.closest('.chips-scroll, .jump, .habits, li[data-swipe]')) { pull = null; return; }
    if (window.scrollY <= 0 && !sheet.open && e.touches.length === 1) pull = { y: e.touches[0].clientY, d: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pull) return;
    pull.d = Math.max(0, e.touches[0].clientY - pull.y);
    if (window.scrollY > 0) { pull = null; ptr.style.transform = ''; return; }
    ptr.style.transform = `translate(-50%, ${Math.min(pull.d, 110) * 0.6}px)`;
    ptr.textContent = pull.d > 80 ? 'Release to refresh' : 'Pull to refresh';
    ptr.classList.toggle('show', pull.d > 15);
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (!pull) return;
    const go = pull.d > 80; pull = null;
    if (!go) { ptr.classList.remove('show'); ptr.style.transform = ''; return; }
    ptr.textContent = 'Refreshing…';
    try { weatherAt = 0; await refresh(); } catch (_) { /* toast shown elsewhere */ }
    ptr.classList.remove('show'); ptr.style.transform = '';
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && loaded) refresh().catch(() => {}); });

  render();
  refresh().then(loadPushState).catch((err) => { if (!needLogin) toast(err.message); });
  if (pushSupported()) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.open) location.href = e.data.open; });
  }
})();
