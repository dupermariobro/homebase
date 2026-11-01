import IcalExpander from 'ical-expander';
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

const PAST_DAYS = 31;
const FUTURE_DAYS = 120;

function toStored(time) {
  // All-day events stay as plain dates so they never drift across timezones.
  if (time.isDate) {
    const p = (n) => String(n).padStart(2, '0');
    return { value: `${time.year}-${p(time.month)}-${p(time.day)}`, allDay: true };
  }
  return { value: time.toJSDate().toISOString(), allDay: false };
}

export function parseIcs(ics, now = new Date()) {
  const after = new Date(now.getTime() - PAST_DAYS * 864e5);
  const before = new Date(now.getTime() + FUTURE_DAYS * 864e5);
  const expander = new IcalExpander({ ics, maxIterations: 2000 });
  const { events, occurrences } = expander.between(after, before);
  const out = [];
  const push = (item, startDate, endDate) => {
    const s = toStored(startDate);
    const e = toStored(endDate || startDate);
    out.push({
      uid: item.uid,
      title: item.summary || '(busy)',
      start: s.value,
      end: e.value,
      all_day: s.allDay ? 1 : 0,
      location: item.location || null,
    });
  };
  for (const ev of events) push(ev, ev.startDate, ev.endDate);
  for (const occ of occurrences) push(occ.item, occ.startDate, occ.endDate);
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export function normalizeUrl(url) {
  return url.trim().replace(/^webcal:\/\//i, 'https://');
}

export async function syncPerson(db, person, fetchImpl = fetch) {
  const res = await fetchImpl(normalizeUrl(person.ical_url), { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Not an iCal feed — use the "Secret address in iCal format"');
  const events = parseIcs(text);
  // Fingerprint the result so callers can tell whether anything actually changed.
  const hash = crypto.createHash('sha1').update(JSON.stringify(events)).digest('hex');
  const ins = db.prepare(
    'INSERT INTO events (person_id, uid, title, start, end, all_day, location) VALUES (?,?,?,?,?,?,?)'
  );
  // Replace only after a successful parse, so a bad fetch keeps the last good copy.
  db.transaction(() => {
    db.prepare('DELETE FROM events WHERE person_id = ?').run(person.id);
    for (const e of events) ins.run(person.id, e.uid, e.title, e.start, e.end, e.all_day, e.location);
  })();
  return { count: events.length, hash };
}

export async function syncAll(db, fetchImpl = fetch) {
  const people = db.prepare("SELECT * FROM people WHERE ical_url IS NOT NULL AND ical_url != ''").all();
  const status = JSON.parse(getSetting(db, 'calendar_status', '{}'));
  let changed = false;
  for (const p of people) {
    try {
      const { count, hash } = await syncPerson(db, p, fetchImpl);
      // Only report a change when the events differ — screens refetch on every change notice.
      if (status[p.id]?.hash !== hash) changed = true;
      status[p.id] = { ok: true, count, hash, at: new Date().toISOString() };
    } catch (err) {
      status[p.id] = { ok: false, error: err.message, at: new Date().toISOString() };
    }
  }
  setSetting(db, 'calendar_status', JSON.stringify(status));
  return { changed, status };
}

export function eventsBetween(db, from, to) {
  // Inclusive of events that overlap [from, to): start < to AND end >= from.
  return db
    .prepare('SELECT * FROM events WHERE start < ? AND end >= ? ORDER BY all_day DESC, start')
    .all(to, from);
}
