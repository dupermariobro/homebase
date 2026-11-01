import {
  IconCircle,
  IconCircleCheckFilled,
  IconStar,
  IconSun,
  IconCloud,
  IconCloudRain,
  IconCloudSnow,
  IconCloudStorm,
  IconCloudFog,
  IconSunHigh,
  IconFlame,
  IconClockHour4,
  IconRefresh,
} from '@tabler/icons-react';
import { api } from '../api.js';
import { personVars, tone } from '../colors.js';
import { celebrate, toast, toastError } from './ui.jsx';

export function weatherIcon(code) {
  if (code === 0) return IconSun;
  if (code <= 2) return IconSunHigh;
  if (code === 3) return IconCloud;
  if (code <= 48) return IconCloudFog;
  if (code <= 67 || (code >= 80 && code <= 82)) return IconCloudRain;
  if (code <= 77 || code === 85 || code === 86) return IconCloudSnow;
  return IconCloudStorm;
}

export async function toggleChore(chore, date, person, evt) {
  try {
    if (chore.done) {
      await api('DELETE', `/api/chores/${chore.id}/complete?date=${date}`);
      toast(`Unchecked "${chore.title}"`);
    } else {
      const rect = evt?.currentTarget?.getBoundingClientRect();
      if (rect) celebrate(rect.left + 24, rect.top + rect.height / 2, tone(person?.color).solid);
      const r = await api('POST', `/api/chores/${chore.id}/complete`, { date });
      if (r.created && r.status === 'pending') toast(`Nice! A parent will check “${chore.title}”`, 'success');
      else if (r.created && person?.rewards_enabled && r.points) toast(`+${r.points} for ${person.name}`, 'success');
    }
  } catch (e) {
    toastError(e);
  }
}

export function money(points, settings) {
  const cents = Number(settings?.cents_per_point) || 0;
  if (!cents) return null;
  return `$${((points * cents) / 100).toFixed(2)}`;
}

/** One person's chores for a day. `size` is "lg" for kids, "sm" for the adult strip. */
export function ChoreCard({ person, chores, date, size = 'lg', settings }) {
  const left = chores.filter((c) => !c.done).length;
  const allDone = chores.length > 0 && left === 0;
  if (size === 'sm') {
    return (
      <div className="chore-strip" style={personVars(person.color)}>
        <span className="strip-name">{person.name}</span>
        <span className="strip-items">
          {chores.length === 0 && <span className="muted-ink">No chores today</span>}
          {chores.map((c) => (
            <button
              key={c.id}
              className={`strip-chip ${c.done ? 'done' : ''}`}
              onClick={(e) => toggleChore(c, date, person, e)}
            >
              {c.done ? <IconCircleCheckFilled size={18} /> : <IconCircle size={18} />}
              {c.title}
            </button>
          ))}
        </span>
      </div>
    );
  }
  return (
    <section className={`chore-card ${allDone ? 'all-done' : ''}`} style={personVars(person.color)}>
      <header>
        <span className="chore-name">{person.name}</span>
        {person.rewards_enabled ? (
          <span className="points" title="Points balance">
            <IconStar size={18} /> {person.points?.balance ?? 0}
          </span>
        ) : (
          <span className="points muted-ink">{chores.length === 0 ? '' : allDone ? 'All done' : `${left} left`}</span>
        )}
      </header>
      {(person.streak >= 2 || Boolean(person.rewards_enabled && money(person.points?.balance ?? 0, settings))) && (
        <div className="card-meta">
          {person.streak >= 2 && (
            <span className="streak" title={`${person.streak}-day streak`}>
              <IconFlame size={15} /> {person.streak}-day streak
            </span>
          )}
          {Boolean(person.rewards_enabled) && money(person.points?.balance ?? 0, settings) && (
            <span className="money">{money(person.points.balance, settings)}</span>
          )}
        </div>
      )}
      {chores.length === 0 && <p className="muted-ink small">Nothing today</p>}
      <ul>
        {chores.map((c) => (
          <li key={c.id}>
            <button
              className={`chore ${c.done ? 'done' : ''} ${c.status === 'pending' ? 'pending' : ''}`}
              onClick={(e) => toggleChore(c, date, person, e)}
              aria-pressed={c.done}
            >
              {c.status === 'pending' ? (
                <IconClockHour4 size={26} />
              ) : c.done ? (
                <IconCircleCheckFilled size={26} />
              ) : (
                <IconCircle size={26} stroke={1.6} />
              )}
              <span className="chore-title">
                {c.title}
                {c.status === 'pending' && <span className="pending-tag">Waiting for OK</span>}
                {c.rotation?.length > 1 && <IconRefresh size={14} className="rot-icon" title="Rotates weekly" />}
              </span>
              {person.rewards_enabled ? <span className="chore-pts">{c.points}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {allDone && <p className="done-banner">All done — nice work</p>}
    </section>
  );
}
