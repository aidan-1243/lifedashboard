// Rewards (credit cards, credits, certificates, points), shared by the app and the server.
// Ported from the Reward Tracker artifact. Every function takes a context:
//   ctx = { cards, logs, points, config, today: 'YYYY-MM-DD' }
// cards:  [{ id, owner (user id), name, issuer, mark, art, fee, renews, opened, feeMonth, currency,
//            benefits: [{ id, name, kind: 'credit'|'cert'|'perk', amount, amounts:{month:amt}, period, note, hint, recur }],
//            hidden: [benefit ids], snoozed: { benefitId: periodKey }, certs: [{ id, benId, expires, potential, used, note, at }], notes, earn }]
// logs:   [{ id, card_id, benefit_id, year, period, kind: 'use'|'ytd'|'bonus', amount, date, note }]
// points: { [userId]: { balances: { prog: n }, updated: { prog: 'YYYY-MM-DD' } } }
// config: { cpp: { MR: 1.5, ... }, pcpp: {}, transfers: { partners, routes, bonuses, asOf } }

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const PERIOD_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Twice a year', annual: 'Yearly', anniversary: 'Each card year', '4yr': 'Every 4 years', none: 'Per use' };
export const CURRENCY = { MR: 'Amex Membership Rewards', UR: 'Chase Ultimate Rewards', BILT: 'Bilt Points', DL: 'Delta SkyMiles', MAR: 'Marriott Bonvoy', IHG: 'IHG One Rewards', ATM: 'Atmos Rewards', C1: 'Capital One Miles', CASH: 'Cash back' };
const DEFAULT_CPP = { MR: 1.5, UR: 1.5, BILT: 1.55, DL: 1.1, MAR: 0.73, IHG: 0.59, ATM: 1.5, C1: 1.45, CASH: 1 };
const DATED = ['monthly', 'quarterly', 'semiannual', 'annual'];
const DAY = 86400000;

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const sum = (a) => a.reduce((x, y) => x + (+y || 0), 0);
export const money = (n) => {
  const v = Math.round((+n || 0) * 100) / 100; const frac = Math.abs(v % 1) > 0.001;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: frac ? 2 : 0 });
  return (v < 0 ? '−$' : '$') + s;
};
const todayOf = (ctx) => parseDate(ctx.today);
export const daysLeft = (ctx, end) => Math.round((end - todayOf(ctx)) / DAY) + 1;
export const cpp = (ctx, code) => { const v = ((ctx.config && ctx.config.cpp) || {})[code]; return typeof v === 'number' && v >= 0 ? v : (DEFAULT_CPP[code] ?? 1); };
export const visibleBenefits = (c) => (c.benefits || []).filter((b) => !(c.hidden || []).includes(b.id));

// Card year: from the account anniversary (date opened, else renewal date) to the day before the next one
function annivAnchor(c) { const src = c && (c.opened || c.renews); if (!src) return null; const d = parseDate(src); return { m: d.getMonth(), d: d.getDate() }; }
function annivDate(y, a) { const last = new Date(y, a.m + 1, 0).getDate(); return new Date(y, a.m, Math.min(a.d, last)); }
function cardYear(a, ref) {
  let st = annivDate(ref.getFullYear(), a); if (st > ref) st = annivDate(ref.getFullYear() - 1, a);
  const nx = annivDate(st.getFullYear() + 1, a), en = new Date(nx.getFullYear(), nx.getMonth(), nx.getDate() - 1);
  return { key: `A${ymd(st)}`, anniv: true, start: st, end: en, label: `Card year · ${MONTHS[st.getMonth()]} ${st.getDate()} – ${MONTHS[en.getMonth()]} ${en.getDate()}` };
}
export function periodInfo(period, d, c) {
  if (period === 'anniversary' && c) { const a = annivAnchor(c); if (a) return cardYear(a, d); }
  const y = d.getFullYear(), m = d.getMonth();
  if (period === 'monthly') return { key: `${y}-${pad(m + 1)}`, m: m + 1, start: new Date(y, m, 1), end: new Date(y, m + 1, 0), label: MONTHS_LONG[m] };
  if (period === 'quarterly') { const q = Math.floor(m / 3); return { key: `${y}-Q${q + 1}`, start: new Date(y, q * 3, 1), end: new Date(y, q * 3 + 3, 0), label: `Q${q + 1} · ${MONTHS[q * 3]}–${MONTHS[q * 3 + 2]}` }; }
  if (period === 'semiannual') { const h = m < 6 ? 0 : 1; return { key: `${y}-H${h + 1}`, start: new Date(y, h * 6, 1), end: new Date(y, h * 6 + 6, 0), label: h ? 'Jul–Dec' : 'Jan–Jun' }; }
  return { key: `${y}`, start: new Date(y, 0, 1), end: new Date(y, 11, 31), label: period === 'anniversary' ? 'This card year' : period === '4yr' ? 'Every 4 years' : String(y) };
}
function periodDates(period, y) {
  if (period === 'monthly') return Array.from({ length: 12 }, (_, i) => new Date(y, i, 15));
  if (period === 'quarterly') return [0, 3, 6, 9].map((m) => new Date(y, m, 15));
  if (period === 'semiannual') return [new Date(y, 0, 15), new Date(y, 6, 15)];
  return [new Date(y, 6, 1)];
}
function capFor(b, info) {
  if (b.kind !== 'credit') return 0;
  if (b.period === 'monthly' && b.amounts && info.m && b.amounts[String(info.m)] != null) return +b.amounts[String(info.m)];
  return +b.amount || 0;
}
const yearFrac = (ctx, y) => {
  const t = todayOf(ctx); if (y < t.getFullYear()) return 1;
  const s = new Date(y, 0, 1), e = new Date(y + 1, 0, 1);
  return Math.min(1, Math.max(0, (t - s + DAY) / (e - s)));
};

// Usage of one benefit in a year. Dated entries land in their own period; an undated
// year total ("ytd") fills earlier periods first, then the current one.
export function benUse(ctx, c, b, y) {
  const today = todayOf(ctx), curYear = today.getFullYear();
  const mine = ctx.logs.filter((l) => l.card_id === c.id && l.benefit_id === b.id && l.year === y);
  const dated = mine.filter((l) => l.kind !== 'ytd');
  const ytd = sum(mine.filter((l) => l.kind === 'ytd').map((l) => l.amount));
  const datedSum = sum(dated.map((l) => l.amount));
  const base = { mine, dated, ytd, datedSum, total: datedSum + ytd, count: dated.length };
  if (b.kind !== 'credit') return { ...base, per: [], cur: null, cap: 0 };
  const anchor = b.period === 'anniversary' ? annivAnchor(c) : null;
  if (anchor) {
    const info = cardYear(anchor, y === curYear ? today : new Date(y, 11, 31)), cap = +b.amount || 0;
    const inWin = ctx.logs.filter((l) => l.card_id === c.id && l.benefit_id === b.id && l.kind !== 'ytd' && l.date && parseDate(l.date) >= info.start && parseDate(l.date) <= info.end);
    const p = { info, cap, used: sum(inWin.map((l) => l.amount)) };
    if (ytd > 0.004) p.used += Math.min(Math.max(0, cap - p.used), ytd);
    return { ...base, per: [p], cur: y === curYear ? p : null, cap };
  }
  const per = periodDates(b.period, y).map((d) => { const info = periodInfo(b.period, d); return { info, cap: capFor(b, info), used: sum(dated.filter((l) => l.period === info.key).map((l) => l.amount)) }; });
  let rest = ytd;
  for (const p of per.filter((x) => x.info.start <= today)) {
    if (rest <= 0.004) break; const take = Math.min(Math.max(0, p.cap - p.used), rest); p.used += take; rest -= take;
  }
  const cur = y === curYear ? (per.find((p) => p.info.start <= today && today <= p.info.end) || null) : null;
  return { ...base, per, cur, cap: sum(per.map((p) => p.cap)) };
}

export const isSnoozed = (c, b, info) => !!info && !!c.snoozed && c.snoozed[b.id] === info.key;

export function metrics(ctx, c, y) {
  const today = todayOf(ctx);
  const logs = ctx.logs.filter((l) => l.card_id === c.id && l.year === y);
  const used = sum(logs.map((l) => l.amount)); const fee = +c.fee || 0; const isCur = y === today.getFullYear();
  let potential = 0, still = 0;
  for (const b of visibleBenefits(c)) {
    if (b.kind !== 'credit') continue;
    const u = benUse(ctx, c, b, y); potential += u.cap;
    if (isCur) for (const p of u.per) if (p.info.end >= today && !isSnoozed(c, b, p.info)) still += Math.max(0, p.cap - p.used);
  }
  const pace = fee * yearFrac(ctx, y);
  let verdict;
  if (fee === 0) verdict = { k: 'nofee', label: 'No fee' };
  else if (used >= fee) verdict = { k: 'good', label: 'Paid off' };
  else if (!isCur) verdict = { k: 'bad', label: 'Fell short' };
  else if (used >= pace) verdict = { k: 'ok', label: 'On pace' };
  else verdict = { k: 'warn', label: 'Behind' };
  return { used, fee, net: used - fee, potential, still, pace, verdict };
}

// Credits with money left in the current period (snoozed ones skipped)
export function openCredits(ctx, cards = ctx.cards) {
  const out = []; const y = todayOf(ctx).getFullYear();
  for (const c of cards) for (const b of visibleBenefits(c)) if (b.kind === 'credit') {
    const u = benUse(ctx, c, b, y); const p = u.cur; if (!p) continue;
    const left = p.cap - p.used;
    if (left > 0.004 && !isSnoozed(c, b, p.info)) out.push({ c, b, info: p.info, cap: p.cap, used: p.used, left, days: daysLeft(ctx, p.info.end), dated: DATED.includes(b.period) || !!p.info.anniv });
  }
  return out;
}

// Certificates (free nights, companion fares)
const certsOf = (c, b) => (c.certs || []).filter((x) => x.benId === b.id);
const certExpired = (ctx, x) => !x.used && !!x.expires && x.expires < ctx.today;
const certRecur = (b) => b.recur || (['annual', 'anniversary'].includes(b.period) ? 'annual' : 'once');
export const certPot = (x, b) => (x && x.potential != null ? +x.potential : (+b.hint || 0));
export function certState(ctx, c, b) {
  const list = certsOf(c, b).slice().sort((a, z) => (a.at || 0) - (z.at || 0));
  const live = list.filter((x) => !x.used && !certExpired(ctx, x));
  const past = list.filter((x) => x.used || certExpired(ctx, x)).reverse();
  const virt = (next) => ({ virtual: true, next, id: '', benId: b.id, expires: '', potential: +b.hint || 0, used: false });
  let cur = null;
  if (live.length) cur = live[0];
  else if (!past.length) cur = virt(false);
  else if (certRecur(b) === 'annual') cur = virt(true);
  return { cur, extra: live.slice(1), past };
}
export function certList(ctx, cards = ctx.cards) {
  const out = [];
  for (const c of cards) for (const b of visibleBenefits(c)) if (b.kind === 'cert') {
    const { cur, extra } = certState(ctx, c, b);
    for (const x of [cur, ...extra]) if (x && !x.next) out.push({ c, b, x, days: x.expires ? daysLeft(ctx, parseDate(x.expires)) : Infinity });
  }
  return out.sort((a, z) => a.days - z.days || a.b.name.localeCompare(z.b.name));
}

// Next annual fee date for a card (from its renewal date or fee month)
export function nextFee(ctx, c) {
  if (!(+c.fee > 0)) return null;
  const t = todayOf(ctx);
  if (c.renews) { const d = parseDate(c.renews); let n = new Date(t.getFullYear(), d.getMonth(), d.getDate()); if (ymd(n) < ctx.today) n = new Date(t.getFullYear() + 1, d.getMonth(), d.getDate()); return n; }
  if (c.feeMonth) { let yy = t.getFullYear(); if (c.feeMonth - 1 < t.getMonth()) yy++; return new Date(yy, c.feeMonth - 1, 1); }
  return null;
}

// ---------- points and transfers ----------
export const SRC = ['MR', 'UR', 'C1', 'BILT'];
const SRC_NAME = { MR: 'Amex Membership Rewards', UR: 'Chase Ultimate Rewards', C1: 'Capital One Miles', BILT: 'Bilt Points' };
export const SRC_SHORT = { MR: 'Amex', UR: 'Chase', C1: 'Capital One', BILT: 'Bilt' };
const POOLABLE = ['UR', 'C1']; // these can be combined between household members
const CUR_TO_PARTNER = { DL: 'delta', MAR: 'marriott', IHG: 'ihg', ATM: 'atmos' };
const PARTNER_CPP = { delta: 'DL', marriott: 'MAR', ihg: 'IHG', atmos: 'ATM' };
const xfer = (ctx) => (ctx.config && ctx.config.transfers) || { partners: {}, routes: {}, bonuses: [] };
export const bal = (ctx, o, k) => +(((ctx.points[o] || {}).balances || {})[k]) || 0;
export const progName = (ctx, k) => SRC_NAME[k] || (xfer(ctx).partners[k] ? xfer(ctx).partners[k].name : k);
export const fmtPts = (n) => Math.round(n).toLocaleString('en-US');
export function fmtK(n) { n = Math.round(n); if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M`; if (n >= 1000) return `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}k`; return String(n); }
export function progCpp(ctx, k) {
  const code = SRC.includes(k) ? k : (PARTNER_CPP[k] || null); if (code) return cpp(ctx, code);
  const o = ((ctx.config && ctx.config.pcpp) || {})[k]; if (typeof o === 'number') return o;
  const pt = xfer(ctx).partners[k]; return pt && typeof pt.cpp === 'number' ? pt.cpp : null;
}
const holdsSrc = (ctx, o, src) => ctx.cards.some((c) => c.owner === o && c.currency === src) || bal(ctx, o, src) > 0;
export function progsFor(ctx, o) {
  const out = [];
  for (const s of SRC) if (ctx.cards.some((c) => c.owner === o && c.currency === s)) out.push(s);
  for (const [cur, pid] of Object.entries(CUR_TO_PARTNER)) if (ctx.cards.some((c) => c.owner === o && c.currency === cur) && !out.includes(pid)) out.push(pid);
  for (const k of Object.keys((ctx.points[o] || {}).balances || {})) if (!out.includes(k)) out.push(k);
  return out;
}
export function bonusFor(ctx, src, to) { return (xfer(ctx).bonuses || []).find((x) => x.src === src && x.to === to && ctx.today >= x.start && ctx.today <= x.end) || null; }
// What person `o` could have in partner program `pid` (pooled: combine both people's Chase / Capital One points)
export function reachFor(ctx, o, pid, pooled, people) {
  let total = bal(ctx, o, pid); const parts = [];
  if (total > 0) parts.push({ own: true, amt: total });
  for (const src of SRC) {
    const r = ((xfer(ctx).routes || {})[src] || []).find((x) => x.to === pid); if (!r) continue;
    let who = [o];
    if (pooled && POOLABLE.includes(src)) { if (!holdsSrc(ctx, o, src)) continue; who = people; }
    for (const q of who) {
      const b = bal(ctx, q, src); if (b <= 0) continue;
      const bonus = bonusFor(ctx, src, pid);
      const got = Math.floor(b * r.get / r.from * (1 + (bonus ? bonus.pct / 100 : 0)));
      parts.push({ src, q, b, got, r, bonus }); total += got;
    }
  }
  return { o, total, parts };
}
export function parsePts(v) {
  const t = String(v || '').trim().toLowerCase().replace(/[,\s]/g, ''); if (!t) return 0;
  const m = t.match(/^(\d*\.?\d+)([km]?)$/); if (!m) return NaN;
  return Math.round(parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
}
