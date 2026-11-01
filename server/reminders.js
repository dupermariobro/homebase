// ntfy reminders: upcoming events, a morning digest, and an afternoon chore nudge.
import { getSetting } from './db.js';
import { choresForDate } from './chores.js';
import { eventsBetween } from './calendar.js';
import { expandLocalEvents } from './extras.js';

const MORNING = '07:30';
const NUDGE = '17:00';

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const timeLabel = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** Claims a reminder key; returns false if it was already sent. */
function claim(db, key) {
  return db.prepare('INSERT OR IGNORE INTO reminders_sent (key) VALUES (?)').run(key).changes === 1;
}

export async function sendNtfy(fetchImpl, baseUrl, topic, { title, message, tags, click }) {
  const headers = { Title: title, Tags: tags || 'house', Priority: '3' };
  // The family ntfy denies anonymous publishing; Homebase signs with its publish-only token.
  if (process.env.HOMEBASE_NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.HOMEBASE_NTFY_TOKEN}`;
  if (click) headers.Click = click;
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body: message,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}

/** Builds every reminder due at `now` (not yet sent). Pure except for the dedupe table. */
export function dueReminders(db, now = new Date()) {
  const lead = Number(getSetting(db, 'reminder_minutes', 30)) || 30;
  const people = db.prepare('SELECT * FROM people ORDER BY sort_order, id').all();
  const withTopic = people.filter((p) => p.ntfy_topic);
  if (!withTopic.length) return [];
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const adults = withTopic.filter((p) => p.role === 'adult');
  const out = [];
  const recipientsFor = (personId) => {
    const p = byId[personId];
    if (!p) return [];
    if (p.role === 'calendar') return adults; // shared family events go to the parents
    return p.ntfy_topic ? [p] : [];
  };

  // Upcoming timed events (iCal + Homebase), starting within the lead window.
  const from = now.toISOString();
  const to = new Date(now.getTime() + lead * 60e3).toISOString();
  const local = expandLocalEvents(db, from, to)
    .filter((e) => !e.all_day && e.start >= from && e.start <= to)
    .map((e) => ({ ...e, lid: e.id }));
  const ical = eventsBetween(db, from, to).filter((e) => !e.all_day && e.start >= from && e.start <= to);
  for (const e of [...ical, ...local]) {
    for (const r of recipientsFor(e.person_id)) {
      const key = `event|${e.uid || e.lid}|${e.start}|${r.id}`;
      out.push({
        key,
        topic: r.ntfy_topic,
        title: e.title,
        message: `${timeLabel(new Date(e.start))}${e.location ? ` · ${e.location}` : ''}${byId[e.person_id]?.id !== r.id ? ` (${byId[e.person_id]?.name})` : ''}`,
        tags: 'calendar',
      });
    }
  }

  const today = dayKey(now);
  const clock = hhmm(now);

  // Morning digest: today's events and tasks for each person.
  if (clock >= MORNING && clock < '11:00') {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart.getTime() + 864e5);
    const events = [
      ...eventsBetween(db, dayStart.toISOString(), dayEnd.toISOString()),
      ...expandLocalEvents(db, dayStart.toISOString(), dayEnd.toISOString()),
    ].filter((e) => (e.all_day ? e.start <= today && e.end > today : true));
    const tasks = db.prepare('SELECT * FROM tasks WHERE done_at IS NULL AND due_date IS NOT NULL AND due_date <= ?').all(today);
    for (const p of withTopic) {
      const mine = events.filter((e) => e.person_id === p.id || (byId[e.person_id]?.role === 'calendar' && p.role === 'adult'));
      const myTasks = tasks.filter((t) => t.person_id === p.id);
      if (!mine.length && !myTasks.length) continue;
      const lines = [
        ...mine
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((e) => `• ${e.all_day ? 'All day' : timeLabel(new Date(e.start))} — ${e.title}`),
        ...myTasks.map((t) => `☐ ${t.title}${t.due_date < today ? ' (overdue)' : ''}`),
      ];
      out.push({ key: `digest|${today}|${p.id}`, topic: p.ntfy_topic, title: `Today for ${p.name}`, message: lines.join('\n'), tags: 'sunrise' });
    }
  }

  // Afternoon nudge: kids with chores still open.
  if (clock >= NUDGE && clock < '21:00') {
    const chores = choresForDate(db, today);
    for (const p of withTopic.filter((x) => x.role === 'child')) {
      const left = chores.filter((c) => c.person_id === p.id && !c.done);
      if (!left.length) continue;
      out.push({
        key: `nudge|${today}|${p.id}`,
        topic: p.ntfy_topic,
        title: `${left.length} chore${left.length === 1 ? '' : 's'} left, ${p.name}`,
        message: left.map((c) => `• ${c.title}`).join('\n'),
        tags: 'broom',
      });
    }
  }
  return out;
}

export async function runReminders(db, fetchImpl = fetch, now = new Date()) {
  const baseUrl = getSetting(db, 'ntfy_url');
  if (!baseUrl) return 0;
  let sent = 0;
  const click = getSetting(db, 'public_url') || undefined; // tapping a notification opens Homebase
  for (const r of dueReminders(db, now)) {
    if (!claim(db, r.key)) continue;
    try {
      await sendNtfy(fetchImpl, baseUrl, r.topic, { ...r, click });
      sent++;
    } catch (err) {
      db.prepare('DELETE FROM reminders_sent WHERE key = ?').run(r.key); // retry next minute
      console.error('Reminder failed:', err.message);
    }
  }
  db.prepare("DELETE FROM reminders_sent WHERE sent_at < datetime('now','-3 days')").run();
  return sent;
}
