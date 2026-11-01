import { IconCalendarEvent, IconChecklist, IconToolsKitchen2, IconShoppingCart, IconMapPin } from '@tabler/icons-react';
import { useLive } from '../api.js';
import { addDays, dayKey, eventOnDay, eventRange, fmt, fromKey } from '../dates.js';
import { tone } from '../colors.js';
import { ChoreCard } from '../components/shared.jsx';
import { ComingUp, NotesBoard, TaskList } from '../components/extras.jsx';
import { Empty } from '../components/ui.jsx';

function EventRow({ ev, person, now }) {
  const { start, end } = eventRange(ev);
  const happening = !ev.all_day && start <= now && end > now;
  const past = !ev.all_day && end <= now;
  return (
    <li className={`ev ${past ? 'past' : ''} ${happening ? 'now' : ''}`} style={{ '--p-solid': tone(person?.color).solid }}>
      <span className="ev-when">
        {ev.all_day ? 'All day' : fmt.time(start)}
        {person && <> · {person.name}</>}
      </span>
      <span className="ev-title">{ev.title}</span>
      {ev.location && (
        <span className="ev-loc">
          <IconMapPin size={13} /> {ev.location}
        </span>
      )}
    </li>
  );
}

export default function Today({ now, people, go, settings }) {
  const today = dayKey(now);
  const todayDate = fromKey(today);
  const tomorrow = addDays(todayDate, 1);
  const from = todayDate.toISOString();
  const to = addDays(todayDate, 2).toISOString();

  const chores = useLive(`/api/chores?date=${today}`, ['chores']);
  const events = useLive(`/api/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, ['events']);
  const meals = useLive(`/api/meals?from=${today}&to=${today}`, ['meals']);
  const lists = useLive('/api/lists', ['lists']);
  const tasks = useLive('/api/tasks', ['tasks']);
  const todos = (tasks.data || []).filter((t) => !t.due_date || t.due_date <= today);

  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const evs = events.data || [];
  const todayEvents = evs.filter((e) => eventOnDay(e, todayDate));
  const tomorrowEvents = evs.filter((e) => eventOnDay(e, tomorrow));
  const choreList = chores.data?.chores || [];
  const kids = people.filter((p) => p.role === 'child');
  const adults = people.filter((p) => p.role === 'adult');
  const choresFor = (p) => choreList.filter((c) => c.person_id === p.id);
  const dinner = meals.data?.[0];
  const grocery = lists.data?.[0];
  const openItems = grocery?.items.filter((i) => !i.done) || [];
  const anyCalendars = people.some((p) => p.has_calendar);

  return (
    <div className="today">
      <section className="panel today-events">
        <h3 className="panel-title">
          <IconCalendarEvent size={20} /> Today
        </h3>
        {todayEvents.length === 0 ? (
          <Empty title={anyCalendars ? 'Nothing on the calendar' : 'Connect calendars'}>
            {anyCalendars ? 'A free day.' : 'Add iCal links in Settings to see everyone’s schedule here.'}
          </Empty>
        ) : (
          <ul className="ev-list">
            {todayEvents.map((e) => (
              <EventRow key={`${e.id}`} ev={e} person={byId[e.person_id]} now={now} />
            ))}
          </ul>
        )}
        {tomorrowEvents.length > 0 && (
          <>
            <h4 className="subhead">Tomorrow</h4>
            <ul className="ev-list compact">
              {tomorrowEvents.slice(0, 4).map((e) => (
                <EventRow key={`t${e.id}`} ev={e} person={byId[e.person_id]} now={now} />
              ))}
              {tomorrowEvents.length > 4 && <li className="more">+{tomorrowEvents.length - 4} more</li>}
            </ul>
          </>
        )}
        <NotesBoard people={people} />
      </section>

      <section className="panel today-chores">
        <h3 className="panel-title">
          <IconChecklist size={20} /> Chores
        </h3>
        <div className="kid-grid" style={{ '--cols': Math.max(1, kids.length) }}>
          {kids.map((p) => (
            <ChoreCard key={p.id} person={p} chores={choresFor(p)} date={today} settings={settings} />
          ))}
        </div>
        <div className="adult-strips">
          {adults.map((p) => (
            <ChoreCard key={p.id} person={p} chores={choresFor(p)} date={today} size="sm" />
          ))}
        </div>
        {todos.length > 0 && (
          <>
            <h4 className="subhead">To-dos</h4>
            <TaskList tasks={todos.slice(0, 6)} people={people} today={today} />
            {todos.length > 6 && (
              <button className="more" onClick={() => go('chores')}>
                +{todos.length - 6} more
              </button>
            )}
          </>
        )}
      </section>

      <section className="panel today-side">
        <button className="side-block" onClick={() => go('meals')}>
          <h3 className="panel-title">
            <IconToolsKitchen2 size={20} /> Dinner
          </h3>
          {dinner ? (
            <>
              <p className="dinner">{dinner.title}</p>
              {dinner.notes && <p className="muted small">{dinner.notes}</p>}
            </>
          ) : (
            <p className="muted">Not planned yet — tap to plan</p>
          )}
        </button>
        <div className="side-block">
          <ComingUp people={people} now={now} />
        </div>
        <button className="side-block" onClick={() => go('lists')}>
          <h3 className="panel-title">
            <IconShoppingCart size={20} /> {grocery?.name || 'Groceries'}
            {openItems.length > 0 && <span className="count">{openItems.length}</span>}
          </h3>
          {openItems.length === 0 ? (
            <p className="muted">List is empty</p>
          ) : (
            <ul className="mini-list">
              {openItems.slice(0, 7).map((i) => (
                <li key={i.id}>{i.text}</li>
              ))}
              {openItems.length > 7 && <li className="more">+{openItems.length - 7} more</li>}
            </ul>
          )}
        </button>
      </section>
    </div>
  );
}
