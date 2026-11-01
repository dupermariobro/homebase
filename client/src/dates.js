// Date helpers. "Day keys" are local YYYY-MM-DD strings, matching the server.

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}

export function sameDay(a, b) {
  return dayKey(a) === dayKey(b);
}

export const fmt = {
  time: (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  clock: (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, ''),
  ampm: (d) => (d.getHours() < 12 ? 'am' : 'pm'),
  long: (d) => d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
  short: (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
  monthDay: (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
  weekday: (d) => d.toLocaleDateString([], { weekday: 'short' }),
  month: (d) => d.toLocaleDateString([], { month: 'long', year: 'numeric' }),
};

/** Event start/end as Date objects; all-day events use local midnight. */
export function eventRange(ev) {
  if (ev.all_day) return { start: fromKey(ev.start), end: fromKey(ev.end) };
  return { start: new Date(ev.start), end: new Date(ev.end) };
}

/** Does the event touch the local calendar day `day`? (all-day end is exclusive) */
export function eventOnDay(ev, day) {
  const { start, end } = eventRange(ev);
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = addDays(dayStart, 1);
  if (ev.all_day) return start < dayEnd && end > dayStart;
  return start < dayEnd && (end > dayStart || start >= dayStart);
}

/** Days until the next occurrence of a YYYY-MM-DD birthday, plus the age turned. */
export function nextBirthday(birthday, today = new Date()) {
  if (!birthday) return null;
  const [y, m, d] = birthday.split('-').map(Number);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let next = new Date(t.getFullYear(), m - 1, d);
  if (next < t) next = new Date(t.getFullYear() + 1, m - 1, d);
  return { days: Math.round((next - t) / 864e5), age: next.getFullYear() - y, date: next };
}

export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
