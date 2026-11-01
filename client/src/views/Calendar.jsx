import { useState } from 'react';
import { IconChevronLeft, IconChevronRight, IconRefresh, IconCake, IconPlus, IconRepeat } from '@tabler/icons-react';
import { EventForm } from '../components/extras.jsx';
import { api, useLive } from '../api.js';
import { addDays, dayKey, eventOnDay, eventRange, fmt, fromKey, sameDay, startOfWeek } from '../dates.js';
import { tone } from '../colors.js';
import { Avatar, toast, toastError } from '../components/ui.jsx';

function rangeFor(mode, cursor) {
  if (mode === 'day') return { start: cursor, days: 1 };
  if (mode === 'week') return { start: startOfWeek(cursor), days: 7 };
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  return { start: startOfWeek(first), days: 42 };
}

function birthdaysOn(people, day) {
  return people.filter((p) => p.birthday && p.birthday.slice(5) === dayKey(day).slice(5));
}

function Chip({ ev, person, showTime = true }) {
  const t = tone(person?.color);
  return (
    <div className={`ev-chip ${ev.all_day ? 'allday' : ''}`} style={{ '--p-solid': t.solid, '--p-soft': t.soft, '--p-ink': t.ink }}>
      {showTime && !ev.all_day && <span className="chip-time">{fmt.time(eventRange(ev).start)}</span>}
      <span className="chip-title">
        {ev.repeat && ev.repeat !== 'none' && <IconRepeat size={12} style={{ marginRight: 3, verticalAlign: '-1px' }} />}
        {ev.title}
      </span>
    </div>
  );
}

export default function Calendar({ now, people }) {
  const [mode, setMode] = useState('week');
  const [cursor, setCursor] = useState(() => fromKey(dayKey(now)));
  const [hidden, setHidden] = useState(() => new Set());
  const [syncing, setSyncing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const openLocal = async (e) => {
    if (e.source !== 'local') return;
    try {
      setEditing(await api('GET', `/api/local-events/${e.local_id}`));
    } catch (err) {
      toastError(err);
    }
  };

  const { start, days } = rangeFor(mode, cursor);
  const end = addDays(start, days);
  const { data } = useLive(
    `/api/events?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`,
    ['events']
  );
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const events = (data || []).filter((e) => !hidden.has(e.person_id));
  const dayList = Array.from({ length: days }, (_, i) => addDays(start, i));

  const step = (dir) => {
    if (mode === 'day') setCursor(addDays(cursor, dir));
    else if (mode === 'week') setCursor(addDays(cursor, 7 * dir));
    else setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
  };
  const toggle = (id) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const refresh = async () => {
    setSyncing(true);
    try {
      const r = await api('POST', '/api/calendar/refresh');
      const failed = Object.values(r.status).filter((s) => !s.ok).length;
      toast(failed ? `${failed} calendar(s) failed — see Settings` : 'Calendars refreshed', failed ? 'error' : 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setSyncing(false);
    }
  };

  const title =
    mode === 'month' ? fmt.month(cursor) : mode === 'day' ? fmt.long(cursor) : `${fmt.monthDay(start)} – ${fmt.monthDay(addDays(start, 6))}`;

  return (
    <div className="cal">
      <div className="toolbar">
        <div className="seg">
          {['day', 'week', 'month'].map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={() => step(-1)} aria-label="Previous">
          <IconChevronLeft />
        </button>
        <button className="btn" onClick={() => setCursor(fromKey(dayKey(now)))}>
          Today
        </button>
        <button className="icon-btn" onClick={() => step(1)} aria-label="Next">
          <IconChevronRight />
        </button>
        <h2 className="toolbar-title">{title}</h2>
        <div className="avatars">
          {people.map((p) => (
            <Avatar key={p.id} person={p} size={40} dim={hidden.has(p.id)} onClick={() => toggle(p.id)} title={`Show ${p.name}`} />
          ))}
        </div>
        <button className="icon-btn" onClick={refresh} disabled={syncing} aria-label="Refresh calendars">
          <IconRefresh className={syncing ? 'spin' : ''} />
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <IconPlus size={18} /> Event
        </button>
      </div>

      {mode === 'month' ? (
        <div className="month">
          {dayList.slice(0, 7).map((d) => (
            <div key={`h${d}`} className="month-head">
              {fmt.weekday(d)}
            </div>
          ))}
          {dayList.map((d) => {
            const evs = events.filter((e) => eventOnDay(e, d));
            const bdays = birthdaysOn(people, d);
            return (
              <button
                key={dayKey(d)}
                className={`month-cell ${d.getMonth() !== cursor.getMonth() ? 'out' : ''} ${sameDay(d, now) ? 'is-today' : ''}`}
                onClick={() => {
                  setCursor(d);
                  setMode('day');
                }}
              >
                <span className="date-num">{d.getDate()}</span>
                {bdays.map((p) => (
                  <span key={p.id} className="bday-chip">
                    <IconCake size={14} /> {p.name}
                  </span>
                ))}
                {evs.slice(0, 3).map((e) => (
                  <Chip key={e.id} ev={e} person={byId[e.person_id]} showTime={false} />
                ))}
                {evs.length > 3 && <span className="more">+{evs.length - 3}</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="week" style={{ '--days': days }}>
          {dayList.map((d) => {
            const evs = events.filter((e) => eventOnDay(e, d));
            const bdays = birthdaysOn(people, d);
            return (
              <div key={dayKey(d)} className={`week-col ${sameDay(d, now) ? 'is-today' : ''}`}>
                <div className="week-head">
                  <span>{fmt.weekday(d)}</span>
                  <span className="date-num">{d.getDate()}</span>
                </div>
                <div className="week-body">
                  {bdays.map((p) => (
                    <span key={p.id} className="bday-chip">
                      <IconCake size={14} /> {p.name}’s birthday
                    </span>
                  ))}
                  {evs.length === 0 && bdays.length === 0 && <span className="muted small">—</span>}
                  {evs.map((e) => (
                    <div
                      key={e.id}
                      className={`week-ev ${e.source === 'local' ? 'editable' : ''}`}
                      onClick={() => openLocal(e)}
                      role={e.source === 'local' ? 'button' : undefined}
                    >
                      <Chip ev={e} person={byId[e.person_id]} />
                      {mode === 'day' && (
                        <span className="muted small day-meta">
                          {byId[e.person_id]?.name}
                          {e.location ? ` · ${e.location}` : ''}
                          {!e.all_day ? ` · until ${fmt.time(eventRange(e).end)}` : ''}
                          {e.source === 'local' && ` · Homebase${e.repeat && e.repeat !== 'none' ? ' · repeats' : ''} · tap to edit`}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {adding && <EventForm people={people} date={dayKey(mode === 'day' ? cursor : now)} onClose={() => setAdding(false)} />}
      {editing && <EventForm people={people} event={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
