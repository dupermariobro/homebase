import { useCallback, useEffect, useRef, useState } from 'react';
import { IconCake, IconCalendar, IconChecklist, IconHome, IconHourglass, IconPhoto, IconSettings, IconShoppingCart, IconToolsKitchen2, IconWifiOff } from '@tabler/icons-react';
import { useConnection, useLive } from './api.js';
import { fmt, greeting } from './dates.js';
import { isWallDisplay } from './device.js';
import { ConfettiLayer, PinProvider, Toasts } from './components/ui.jsx';
import { weatherIcon } from './components/shared.jsx';
import Today from './views/Today.jsx';
import Calendar from './views/Calendar.jsx';
import Chores from './views/Chores.jsx';
import Meals from './views/Meals.jsx';
import Lists from './views/Lists.jsx';
import Settings from './views/Settings.jsx';
import Photos from './views/Photos.jsx';
import Screensaver from './components/Screensaver.jsx';
import { QuickAddButton } from './components/QuickAdd.jsx';
import { upcoming } from './components/extras.jsx';

const TABS = [
  { id: 'today', label: 'Today', icon: IconHome },
  { id: 'calendar', label: 'Calendar', icon: IconCalendar },
  { id: 'chores', label: 'Chores', icon: IconChecklist },
  { id: 'meals', label: 'Meals', icon: IconToolsKitchen2 },
  { id: 'lists', label: 'Lists', icon: IconShoppingCart },
  { id: 'photos', label: 'Photos', icon: IconPhoto },
  { id: 'settings', label: 'Settings', icon: IconSettings },
];
const IDLE_MS = 2 * 60 * 1000;
const SAVER_MS = 5 * 60 * 1000;
const NIGHT_START = 22;
const NIGHT_END = 6;

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => !document.hidden && setNow(new Date());
    const t = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return now;
}

const isNight = (d) => d.getHours() >= NIGHT_START || d.getHours() < NIGHT_END;

function Header({ now, people, weather, countdowns }) {
  const conn = useConnection();
  const next = upcoming(countdowns, people, now)[0];
  const WIcon = weather ? weatherIcon(weather.code) : null;
  const todayHiLo = weather?.daily?.[0];
  return (
    <header className="top">
      <div className="clock">
        <span className="time">{fmt.clock(now)}</span>
        <span className="ampm">{fmt.ampm(now)}</span>
      </div>
      <div className="date-block">
        <span className="date">{fmt.long(now)}</span>
        <span className="greet">{greeting(now)}</span>
      </div>
      <span className="grow" />
      {conn === 'offline' && (
        <span className="pill warn-pill">
          <IconWifiOff size={18} /> Reconnecting
        </span>
      )}
      {next && next.days <= 60 && (
        <span className={`pill ${next.kind === 'birthday' ? 'bday-pill' : 'count-pill'}`}>
          {next.kind === 'birthday' ? <IconCake size={18} /> : <IconHourglass size={18} />}
          {next.days === 0
            ? next.kind === 'birthday'
              ? `Happy birthday! ${next.title}`
              : `${next.title} is today!`
            : `${next.title} in ${next.days} day${next.days === 1 ? '' : 's'}`}
        </span>
      )}
      {weather && (
        <span className="weather">
          <WIcon size={30} stroke={1.5} />
          <span className="temp">{weather.temp}°</span>
          {todayHiLo && (
            <span className="hilo">
              {todayHiLo.hi}° / {todayHiLo.lo}°
            </span>
          )}
        </span>
      )}
    </header>
  );
}

function NightClock({ now, onWake }) {
  return (
    <button className="night" onClick={onWake} aria-label="Wake screen">
      <span className="night-time">{fmt.clock(now)}</span>
      <span className="night-date">{fmt.long(now)}</span>
    </button>
  );
}

export default function App() {
  const now = useNow();
  const wall = isWallDisplay();
  const [tab, setTab] = useState('today');
  const [awakeUntil, setAwakeUntil] = useState(0);
  const lastTouch = useRef(Date.now());
  const people = useLive('/api/people', ['people', 'chores', 'rewards']);
  const weather = useLive('/api/weather', ['settings']);
  const settings = useLive('/api/settings', ['settings']);
  const photos = useLive('/api/photos', ['photos']);
  const countdowns = useLive('/api/countdowns', ['countdowns']);

  // Any touch counts as activity; after 2 idle minutes go home (and to sleep at night).
  const touch = useCallback(() => {
    lastTouch.current = Date.now();
  }, []);
  useEffect(() => {
    if (!wall) return undefined; // phones stay where you left them
    const t = setInterval(() => {
      if (Date.now() - lastTouch.current > IDLE_MS) setTab('today');
    }, 5000);
    return () => clearInterval(t);
  }, [wall]);

  const idleFor = Date.now() - lastTouch.current;
  // Screensaver and night clock are for the wall display only.
  const sleeping = wall && isNight(now) && idleFor > IDLE_MS && Date.now() > awakeUntil;
  const saver = wall && !isNight(now) && idleFor > SAVER_MS && Date.now() > awakeUntil && photos.data?.length > 0;
  const wake = () => {
    touch();
    setAwakeUntil(Date.now() + IDLE_MS);
  };
  const cfg = settings.data || {};
  const list = people.data || [];
  const go = (id) => setTab(id);

  return (
    <div className="app" onPointerDown={touch} onKeyDown={touch}>
      <Header now={now} people={list} weather={weather.data} countdowns={countdowns.data} />
      <main className="main">
        {!people.data && !people.error && <div className="loading">Loading…</div>}
        {people.error && (
          <div className="loading">
            {/linked/i.test(people.error) ? 'This phone isn’t linked to Homebase. Ask for a new link from Settings on the tablet.' : 'Can’t reach Homebase. Retrying…'}
          </div>
        )}
        {people.data && (
          <>
            {tab === 'today' && <Today now={now} people={list} go={go} settings={cfg} />}
            {tab === 'calendar' && <Calendar now={now} people={list} />}
            {tab === 'chores' && <Chores now={now} people={list} settings={cfg} />}
            {tab === 'meals' && <Meals now={now} aiEnabled={cfg.ai_enabled} />}
            {tab === 'lists' && <Lists />}
            {tab === 'photos' && <Photos />}
            {tab === 'settings' && <Settings onPeopleChanged={people.reload} />}
          </>
        )}
      </main>
      <nav className="tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}>
            <Icon size={26} stroke={1.7} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {people.data && <QuickAddButton people={list} enabled={cfg.ai_enabled} />}
      {saver && <Screensaver photos={photos.data} now={now} weather={weather.data} onWake={wake} />}
      {sleeping && <NightClock now={now} onWake={wake} />}
      <ConfettiLayer />
      <PinProvider />
      <Toasts />
    </div>
  );
}
