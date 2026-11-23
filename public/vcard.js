// vCard (.vcf) reader, shared by the app (to preview contacts on your device
// before anything is sent) and the server.

const unescapeV = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseDate(v, omitYear) {
  let m;
  v = v.trim();
  if ((m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v))) return omitYear || m[1] === '1604' ? `--${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^--(\d{2})-?(\d{2})/.exec(v))) return `--${m[1]}-${m[2]}`;
  return null;
}

const LABELS = { anniversary: 'Anniversary', other: 'Other' };
const cleanLabel = (l) => {
  const m = /_\$!<(.+)>!\$_/.exec(l || '');
  const raw = (m ? m[1] : l || 'Date').trim();
  return LABELS[raw.toLowerCase()] || raw;
};

export function parseVcards(text) {
  const lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const cards = [];
  let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VCARD/i.test(line)) { cur = { dates: [], groups: {} }; continue; }
    if (/^END:VCARD/i.test(line)) {
      if (cur) {
        // Apple stores anniversaries as itemN.X-ABDATE + itemN.X-ABLabel
        for (const g of Object.values(cur.groups)) if (g.date) cur.dates.push({ label: cleanLabel(g.label), date: g.date });
        delete cur.groups;
        cards.push(cur);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const gm = /^(item\d+)\./i.exec(head);
    const group = gm ? gm[1].toLowerCase() : null;
    const prop = head.split(';')[0].replace(/^item\d+\./i, '').toUpperCase();
    if (prop === 'FN') cur.name = unescapeV(value).trim();
    else if (prop === 'N' && !cur.nName) {
      const [last, first] = value.split(';');
      cur.nName = [unescapeV(first || ''), unescapeV(last || '')].join(' ').trim();
    } else if (prop === 'BDAY') cur.birthday = parseDate(value, /X-APPLE-OMIT-YEAR/i.test(head));
    else if (prop === 'TEL' && !cur.phone) cur.phone = value.trim();
    else if (prop === 'EMAIL' && !cur.email) cur.email = value.trim();
    else if (prop === 'NOTE') cur.notes = unescapeV(value).trim();
    else if (prop === 'UID') cur.uid = value.trim();
    else if (prop === 'ORG') cur.org = unescapeV(value.split(';')[0]).trim();
    else if (prop === 'ANNIVERSARY') { const d = parseDate(value); if (d) cur.dates.push({ label: 'Anniversary', date: d }); }
    else if (prop === 'X-ABDATE' && group) { (cur.groups[group] ||= {}).date = parseDate(value, /X-APPLE-OMIT-YEAR/i.test(head)); }
    else if (prop === 'X-ABLABEL' && group) { (cur.groups[group] ||= {}).label = unescapeV(value); }
  }
  return cards
    .map((c) => ({ ...c, name: c.name || c.nName || c.org }))
    .filter((c) => c.name)
    .map(({ nName, ...c }) => c);
}

// A calendar birthday ("Jane Doe's Birthday", "Jane Doe’s 40th Birthday") for someone
// already in People is a duplicate: People handles that birthday.
export function birthdayEventPerson(title, people) {
  const m = /^(.+?)[’']s?\s+(?:\d+(?:st|nd|rd|th)\s+)?birthday\b/i.exec(String(title || '').trim());
  if (!m) return null;
  const who = m[1].trim().toLowerCase();
  return people.find((p) => (p.name || '').trim().toLowerCase() === who) || null;
}
