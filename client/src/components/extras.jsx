import { useState } from 'react';
import { IconCircle, IconCircleCheckFilled, IconPlus, IconTrash, IconX, IconHourglass, IconCake, IconNote } from '@tabler/icons-react';
import { api, useLive } from '../api.js';
import { dayKey, fmt, fromKey, nextBirthday } from '../dates.js';
import { personVars, tone } from '../colors.js';
import { Avatar, Modal, celebrate, toast, toastError } from './ui.jsx';

export const members = (people) => people.filter((p) => p.role !== 'calendar');

const run = async (fn, ok) => {
  try {
    await fn();
    if (ok) toast(ok, 'success');
  } catch (e) {
    toastError(e);
  }
};

// --- Person picker -----------------------------------------------------------------
export function PersonPicker({ people, value, onChange, allowNone, size = 44 }) {
  return (
    <div className="avatars wrap">
      {allowNone && (
        <button type="button" className={`none-pick ${value == null ? 'on' : ''}`} onClick={() => onChange(null)}>
          Anyone
        </button>
      )}
      {people.map((p) => (
        <Avatar key={p.id} person={p} size={size} dim={value !== p.id} onClick={() => onChange(p.id)} title={p.name} />
      ))}
    </div>
  );
}

// --- Tasks -----------------------------------------------------------------------
export function taskDueLabel(t, today) {
  if (!t.due_date) return null;
  if (t.due_date < today) return { text: 'Overdue', cls: 'overdue' };
  if (t.due_date === today) return { text: 'Today', cls: 'due-today' };
  return { text: fmt.short(fromKey(t.due_date)), cls: '' };
}

export function TaskRow({ task, person, today }) {
  const due = taskDueLabel(task, today);
  const done = Boolean(task.done_at);
  const toggle = (e) => {
    if (!done) {
      const r = e.currentTarget.getBoundingClientRect();
      celebrate(r.left + 20, r.top + r.height / 2, tone(person?.color).solid);
      run(() => api('POST', `/api/tasks/${task.id}/done`), task.points ? `+${task.points} for ${person?.name}` : null);
    } else run(() => api('DELETE', `/api/tasks/${task.id}/done`));
  };
  return (
    <li className={`task ${done ? 'done' : ''}`} style={personVars(person?.color || 'gray')}>
      <button className="task-main" onClick={toggle} aria-pressed={done}>
        {done ? <IconCircleCheckFilled size={24} /> : <IconCircle size={24} stroke={1.6} />}
        <span className="task-title">{task.title}</span>
      </button>
      {person && <span className="task-who">{person.name}</span>}
      {due && <span className={`task-due ${due.cls}`}>{due.text}</span>}
      {task.points > 0 && <span className="chore-pts">{task.points}</span>}
    </li>
  );
}

export function TaskForm({ people, onClose }) {
  const [f, setF] = useState({ title: '', person_id: null, due_date: '', points: 0 });
  const set = (k, v) => setF({ ...f, [k]: v });
  return (
    <Modal title="New to-do" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api('POST', '/api/tasks', f);
            onClose();
          }, 'To-do added');
        }}
      >
        <label>
          To-do
          <input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Return library books" autoFocus required />
        </label>
        <div className="field">
          <span className="label">Who</span>
          <PersonPicker people={members(people)} value={f.person_id} onChange={(v) => set('person_id', v)} allowNone />
        </div>
        <div className="row-2">
          <label>
            Due
            <input type="date" value={f.due_date} onChange={(e) => set('due_date', e.target.value)} />
          </label>
          <label>
            Points
            <input type="number" min="0" max="100" value={f.points} onChange={(e) => set('points', Number(e.target.value))} />
          </label>
        </div>
        <div className="form-actions">
          <button className="btn primary">Add to-do</button>
        </div>
      </form>
    </Modal>
  );
}

export function TaskList({ tasks, people, today, empty }) {
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  if (!tasks.length) return empty ? <p className="muted small">{empty}</p> : null;
  return (
    <ul className="task-list">
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} person={byId[t.person_id]} today={today} />
      ))}
    </ul>
  );
}

// --- Notes -----------------------------------------------------------------------
export function NotesBoard({ people }) {
  const { data } = useLive('/api/notes', ['notes']);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [who, setWho] = useState(null);
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const notes = data || [];
  return (
    <div className="notes">
      <div className="section-head">
        <h4 className="subhead">
          <IconNote size={16} /> Notes
        </h4>
        <button className="icon-btn subtle" onClick={() => setAdding(true)} aria-label="Add note">
          <IconPlus size={20} />
        </button>
      </div>
      {notes.length === 0 && <p className="muted small">Leave a note for the family.</p>}
      <div className="note-grid">
        {notes.map((n) => {
          const p = byId[n.person_id];
          return (
            <div key={n.id} className="sticky" style={personVars(p?.color || 'amber')}>
              <p>{n.text}</p>
              <div className="sticky-foot">
                <span>{p ? `— ${p.name}` : ''}</span>
                <button className="icon-btn tiny" onClick={() => run(() => api('DELETE', `/api/notes/${n.id}`))} aria-label="Remove note">
                  <IconX size={16} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {adding && (
        <Modal title="New note" onClose={() => setAdding(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api('POST', '/api/notes', { text, person_id: who });
                setText('');
                setAdding(false);
              });
            }}
          >
            <label>
              Note
              <textarea rows={3} maxLength={280} value={text} onChange={(e) => setText(e.target.value)} placeholder="Pizza night Friday!" autoFocus required />
            </label>
            <div className="field">
              <span className="label">From</span>
              <PersonPicker people={members(people)} value={who} onChange={setWho} allowNone />
            </div>
            <div className="form-actions">
              <button className="btn primary">Post note</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// --- Countdowns --------------------------------------------------------------------
export function daysUntil(dateStr, now) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((fromKey(dateStr) - t) / 864e5);
}

/** Countdowns plus upcoming birthdays, soonest first. */
export function upcoming(countdowns, people, now) {
  const items = (countdowns || []).map((c) => ({ key: `c${c.id}`, id: c.id, title: c.title, days: daysUntil(c.date, now), kind: 'countdown' }));
  for (const p of people) {
    const b = nextBirthday(p.birthday, now);
    if (b) items.push({ key: `b${p.id}`, title: `${p.name} turns ${b.age}`, days: b.days, kind: 'birthday', color: p.color });
  }
  return items.sort((a, b) => a.days - b.days);
}

export function ComingUp({ people, now }) {
  const { data } = useLive('/api/countdowns', ['countdowns']);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ title: '', date: '' });
  const items = upcoming(data, people, now).slice(0, 5);
  return (
    <div>
      <div className="section-head">
        <h3 className="panel-title">
          <IconHourglass size={20} /> Coming up
        </h3>
        <button className="icon-btn subtle" onClick={() => setAdding(true)} aria-label="Add countdown">
          <IconPlus size={20} />
        </button>
      </div>
      <ul className="coming">
        {items.map((i) => (
          <li key={i.key}>
            <span className="days">{i.days === 0 ? 'Today' : i.days}</span>
            <span className="grow">
              {i.kind === 'birthday' && <IconCake size={16} style={{ color: tone(i.color).solid, verticalAlign: '-2px', marginRight: 4 }} />}
              {i.title}
              {i.days > 0 && <span className="muted small"> · {i.days === 1 ? 'day' : 'days'}</span>}
            </span>
            {i.kind === 'countdown' && (
              <button className="icon-btn tiny subtle" onClick={() => run(() => api('DELETE', `/api/countdowns/${i.id}`))} aria-label={`Remove ${i.title}`}>
                <IconTrash size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <Modal title="New countdown" onClose={() => setAdding(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api('POST', '/api/countdowns', f);
                setF({ title: '', date: '' });
                setAdding(false);
              }, 'Countdown added');
            }}
          >
            <label>
              What
              <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Disney trip" autoFocus required />
            </label>
            <label>
              Date
              <input type="date" min={dayKey(now)} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required />
            </label>
            <div className="form-actions">
              <button className="btn primary">Add countdown</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// --- Homebase event form -------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const REPEAT_LABELS = { none: 'Doesn’t repeat', daily: 'Every day', weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Every month' };

/** Turns a stored local_events row into form fields. */
function rowToForm(row) {
  if (row.all_day) return { ...row, date: row.start, start_time: '', end_time: '', repeat_until: row.repeat_until || '' };
  const s = new Date(row.start);
  const e = new Date(row.end);
  return { ...row, date: dayKey(s), start_time: hhmm(s), end_time: hhmm(e), repeat_until: row.repeat_until || '' };
}

export function EventForm({ people, date, event, onClose }) {
  const cal = people.find((p) => p.role === 'calendar');
  const [f, setF] = useState(
    event
      ? rowToForm(event)
      : { title: '', person_id: cal?.id || people[0]?.id, date: date || dayKey(), start_time: '', end_time: '', location: '', repeat: 'none', repeat_until: '' }
  );
  const set = (k, v) => setF({ ...f, [k]: v });
  const weekday = f.date ? fromKey(f.date).toLocaleDateString([], { weekday: 'long' }) : '';
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { ...f, all_day: !f.start_time };
      if (event) await api('PUT', `/api/local-events/${event.id}`, body);
      else await api('POST', '/api/local-events', body);
      onClose();
    }, event ? 'Event updated' : 'Event added');
  };
  const remove = () => {
    const msg = event.repeat !== 'none' ? `Delete every "${event.title}"?` : `Delete "${event.title}"?`;
    if (!confirm(msg)) return;
    run(async () => {
      await api('DELETE', `/api/local-events/${event.id}`);
      onClose();
    }, 'Event deleted');
  };
  return (
    <Modal title={event ? 'Edit event' : 'New event'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <label>
          Event
          <input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Gymnastics" autoFocus={!event} required />
        </label>
        <div className="field">
          <span className="label">Whose calendar</span>
          <PersonPicker people={people} value={f.person_id} onChange={(v) => set('person_id', v)} />
        </div>
        <label>
          Date
          <input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} required />
        </label>
        <div className="row-2">
          <label>
            Starts
            <input type="time" value={f.start_time} onChange={(e) => set('start_time', e.target.value)} />
          </label>
          <label>
            Ends
            <input type="time" value={f.end_time} onChange={(e) => set('end_time', e.target.value)} />
          </label>
        </div>
        <div className="row-2">
          <label>
            Repeats
            <select value={f.repeat} onChange={(e) => set('repeat', e.target.value)}>
              {Object.entries(REPEAT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {k === 'weekly' && weekday ? `Every ${weekday}` : k === 'biweekly' && weekday ? `Every other ${weekday}` : v}
                </option>
              ))}
            </select>
          </label>
          {f.repeat !== 'none' && (
            <label>
              Until (optional)
              <input type="date" min={f.date} value={f.repeat_until} onChange={(e) => set('repeat_until', e.target.value)} />
            </label>
          )}
        </div>
        <label>
          Where
          <input value={f.location || ''} onChange={(e) => set('location', e.target.value)} placeholder="Optional" />
        </label>
        <p className="hint">Leave the time empty for an all-day event. Saved in Homebase only — it won’t appear in Google Calendar.</p>
        <div className="form-actions">
          {event && (
            <button type="button" className="btn ghost danger" onClick={remove}>
              <IconTrash size={18} /> Delete
            </button>
          )}
          <span className="grow" />
          <button className="btn primary">{event ? 'Save' : 'Add event'}</button>
        </div>
      </form>
    </Modal>
  );
}
