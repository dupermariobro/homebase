import { useEffect, useState } from 'react';
import { IconCalendar, IconCheck, IconAlertTriangle, IconLock, IconMapPin, IconPlus, IconUsers, IconTrash, IconBell, IconCoin, IconSparkles, IconSend, IconWorld, IconDeviceMobile, IconShare, IconCopy } from '@tabler/icons-react';
import QRCode from 'qrcode';
import { isWallDisplay, setWallDisplay } from '../device.js';
import { api, forgetPin, useLive } from '../api.js';
import { COLOR_NAMES, tone } from '../colors.js';
import { Avatar, Modal, toast, toastError } from '../components/ui.jsx';

function PersonEditor({ person, onClose, ntfyPublicUrl }) {
  const ntfyHint = ntfyPublicUrl
    ? `In the ntfy app: tap +, turn on “Use another server”, enter ${ntfyPublicUrl}, then this exact topic.`
    : 'Install the ntfy app on their phone and subscribe to this exact topic. Make it hard to guess.';
  const [f, setF] = useState(person || { name: '', role: 'child', color: 'pink', birthday: '', rewards_enabled: 1, ical_url: '' });
  const set = (k, v) => setF({ ...f, [k]: v });
  // A random suffix keeps public ntfy topics from being guessable.
  const [topicSuffix] = useState(() => Math.random().toString(36).slice(2, 8));
  const save = async (e) => {
    e.preventDefault();
    try {
      if (person) await api('PUT', `/api/people/${person.id}`, f);
      else await api('POST', '/api/people', f);
      if (f.ical_url) api('POST', '/api/calendar/refresh').catch(() => {});
      toast('Saved', 'success');
      onClose(true);
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${person.name}? Their chores and points history go too.`)) return;
    try {
      await api('DELETE', `/api/people/${person.id}`);
      onClose(true);
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Modal title={person ? `Edit ${person.name}` : 'Add person'} onClose={() => onClose(false)}>
      <form className="form" onSubmit={save}>
        <label>
          Name
          <input value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus={!person} />
        </label>
        <div className="field">
          <span className="label">Role</span>
          <div className="seg">
            {['adult', 'child', 'calendar'].map((r) => (
              <button type="button" key={r} className={f.role === r ? 'on' : ''} onClick={() => set('role', r)}>
                {{ adult: 'Adult', child: 'Kid', calendar: 'Calendar only' }[r]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Color</span>
          <div className="swatches">
            {COLOR_NAMES.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch ${f.color === c ? 'on' : ''}`}
                style={{ background: tone(c).solid }}
                onClick={() => set('color', c)}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        <label>
          Birthday
          <input type="date" value={f.birthday || ''} onChange={(e) => set('birthday', e.target.value)} />
        </label>
        {f.role !== 'calendar' && (
          <label className="check">
            <input type="checkbox" checked={Boolean(f.rewards_enabled)} onChange={(e) => set('rewards_enabled', e.target.checked ? 1 : 0)} />
            Earns points and rewards for chores
          </label>
        )}
        <label>
          Google Calendar secret iCal address
          <input
            value={f.ical_url || ''}
            onChange={(e) => set('ical_url', e.target.value)}
            placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics"
          />
          <span className="hint">Google Calendar → Settings → your calendar → Integrate calendar → “Secret address in iCal format”.</span>
        </label>
        {f.role !== 'calendar' && (
          <label>
            ntfy topic for reminders
            <div className="add-row" style={{ marginBottom: 0 }}>
              <input
                value={f.ntfy_topic || ''}
                onChange={(e) => set('ntfy_topic', e.target.value.replace(/[^\w-]/g, ''))}
                placeholder={`homebase-${(f.name || 'name').toLowerCase()}-${topicSuffix}`}
              />
              {person?.ntfy_topic && (
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    try {
                      await api('POST', '/api/reminders/test', { person_id: person.id });
                      toast('Test sent', 'success');
                    } catch (err) {
                      toastError(err);
                    }
                  }}
                >
                  <IconSend size={18} /> Test
                </button>
              )}
            </div>
            <span className="hint">{ntfyHint}</span>
          </label>
        )}
        <div className="form-actions">
          {person && (
            <button type="button" className="btn ghost danger" onClick={remove}>
              <IconTrash size={18} /> Remove
            </button>
          )}
          <span className="grow" />
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function LocationPicker({ settings }) {
  const [q, setQ] = useState(settings?.location_name || '');
  const [results, setResults] = useState([]);
  const search = async (e) => {
    e.preventDefault();
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=5&name=${encodeURIComponent(q)}`).then((x) => x.json());
      setResults(r.results || []);
      if (!r.results?.length) toast('No matches — try a city name');
    } catch {
      toast('Couldn’t reach the location service', 'error');
    }
  };
  const pick = async (r) => {
    try {
      const name = [r.name, r.admin1].filter(Boolean).join(', ');
      await api('PUT', '/api/settings', { lat: r.latitude, lon: r.longitude, location_name: name });
      setQ(name);
      setResults([]);
      toast(`Weather set to ${name}`, 'success');
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div>
      <form className="add-row" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="City or ZIP" aria-label="Weather location" />
        <button className="btn">Search</button>
      </form>
      {results.map((r) => (
        <button key={r.id} className="result-row" onClick={() => pick(r)}>
          <IconMapPin size={18} /> {r.name}, {r.admin1} {r.country_code}
        </button>
      ))}
    </div>
  );
}

function ThisDevice() {
  const [wall, setWall] = useState(isWallDisplay());
  return (
    <section className="panel">
      <h3 className="panel-title">
        <IconDeviceMobile size={20} /> This device
      </h3>
      <label className="check">
        <input
          type="checkbox"
          checked={wall}
          onChange={(e) => {
            setWallDisplay(e.target.checked);
            setWall(e.target.checked);
            toast(e.target.checked ? 'Wall display mode on — reloading' : 'Phone mode on — reloading', 'success');
            setTimeout(() => location.reload(), 900);
          }}
        />
        Wall display mode
      </label>
      <p className="muted small">
        Photo screensaver, night clock, and returning to Today when idle. Turn off on phones to save battery. Only affects this device.
      </p>
    </section>
  );
}

function timeAgo(sqlTime) {
  if (!sqlTime) return 'never';
  const t = new Date(sqlTime.replace(' ', 'T') + 'Z');
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return t.toLocaleDateString();
}

function LinkPhone({ onClose }) {
  const [link, setLink] = useState(null);
  const [qr, setQr] = useState(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    api('POST', '/api/devices/pair')
      .then(async (r) => {
        setLink(r);
        setQr(await QRCode.toDataURL(r.url, { width: 560, margin: 1, color: { dark: '#1f2a26', light: '#ffffff' } }));
      })
      .catch((e) => {
        toastError(e);
        onClose();
      });
  }, []);
  useEffect(() => {
    if (!link) return;
    const tick = () => setLeft(Math.max(0, Math.round((link.expiresAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [link]);
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Homebase', text: 'Tap to link your phone to Homebase (works for 15 minutes):', url: link.url });
      else {
        await navigator.clipboard.writeText(link.url);
        toast('Link copied', 'success');
      }
    } catch {
      /* share sheet dismissed */
    }
  };
  return (
    <Modal title="Link a phone" onClose={onClose}>
      {!link ? (
        <p className="muted">Making a link…</p>
      ) : left === 0 ? (
        <p className="muted">This link expired. Close and make a new one.</p>
      ) : (
        <div className="link-phone">
          <p className="muted small">Scan with the phone’s camera, or send the link. It works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</p>
          {qr && <img className="qr" src={qr} alt="QR code to link a phone" />}
          <div className="form-actions" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={share}>
              {navigator.share ? <IconShare size={18} /> : <IconCopy size={18} />} {navigator.share ? 'Send link' : 'Copy link'}
            </button>
          </div>
          <ol className="small muted steps">
            <li>Open the link in Safari (or Chrome) on the phone.</li>
            <li>Name the phone and tap <strong>Link phone</strong>.</li>
            <li>Then tap Share → <strong>Add to Home Screen</strong>.</li>
          </ol>
        </div>
      )}
    </Modal>
  );
}

function AwayFromHome() {
  const [data, setData] = useState(null);
  const [linking, setLinking] = useState(false);
  const load = () => api('GET', '/api/devices').then(setData).catch(toastError);
  useEffect(() => {
    load();
  }, []);
  if (!data) return null;
  const unlink = async (d) => {
    if (!confirm(`Unlink ${d.name}? It will lose access away from home.`)) return;
    try {
      await api('DELETE', `/api/devices/${d.id}`);
      load();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <section className="panel">
      <h3 className="panel-title">
        <IconWorld size={20} /> Away from home
      </h3>
      {!data.publicUrl ? (
        <p className="muted small">Not turned on yet. Set HOMEBASE_PUBLIC_URL in the .env file (see the README).</p>
      ) : (
        <>
          <p className="muted small">Linked phones can use Homebase from anywhere — no VPN app needed. Everyone else just sees a locked page.</p>
          <div className="people-list">
            {data.devices.length === 0 && <p className="muted small">No phones linked yet.</p>}
            {data.devices.map((d) => (
              <div key={d.id} className="person-row">
                <IconDeviceMobile size={26} />
                <span className="grow">
                  <strong>{d.name}</strong>
                  <span className="muted small"> · last used {timeAgo(d.last_seen)}</span>
                </span>
                <button className="btn ghost small-btn danger" onClick={() => unlink(d)}>
                  Unlink
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn primary"
            onClick={() => setLinking(true)}
          >
            <IconPlus size={18} /> Link a phone
          </button>
        </>
      )}
      {linking && (
        <LinkPhone
          onClose={() => {
            setLinking(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function Preferences({ settings }) {
  const [f, setF] = useState(null);
  useEffect(() => {
    if (settings && !f) setF({ ntfy_url: settings.ntfy_url || '', reminder_minutes: settings.reminder_minutes, cents_per_point: settings.cents_per_point });
  }, [settings, f]);
  if (!f) return null;
  const save = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', { ...f, reminder_minutes: Number(f.reminder_minutes) || 30, cents_per_point: Number(f.cents_per_point) || 0 });
      toast('Saved', 'success');
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <section className="panel">
      <form className="form" onSubmit={save}>
        <h3 className="panel-title">
          <IconBell size={20} /> Reminders
        </h3>
        <label>
          ntfy server
          <input value={f.ntfy_url} onChange={(e) => setF({ ...f, ntfy_url: e.target.value })} placeholder="https://ntfy.sh" />
          <span className="hint">Where reminders are sent. Each person’s topic is set on their profile.</span>
        </label>
        <label>
          Remind before events (minutes)
          <input type="number" min="5" max="240" value={f.reminder_minutes} onChange={(e) => setF({ ...f, reminder_minutes: e.target.value })} />
        </label>
        <h3 className="panel-title">
          <IconCoin size={20} /> Allowance
        </h3>
        <label>
          Cents per point (0 = points only)
          <input type="number" min="0" max="1000" value={f.cents_per_point} onChange={(e) => setF({ ...f, cents_per_point: e.target.value })} />
          <span className="hint">
            {Number(f.cents_per_point) > 0 ? `100 points = $${(Number(f.cents_per_point)).toFixed(2)}` : 'Show a dollar value next to points.'}
          </span>
        </label>
        <h3 className="panel-title">
          <IconSparkles size={20} /> AI quick-add
        </h3>
        <p className="small muted">
          {settings.ai_enabled ? 'On — tap ✨ on any screen.' : 'Off. Add an AI provider to the .env file on the Homebase computer to turn it on (see the README).'}
        </p>
        <div className="form-actions">
          <button className="btn primary">Save</button>
        </div>
      </form>
    </section>
  );
}

export default function Settings({ onPeopleChanged }) {
  const [admin, setAdmin] = useState(null);
  const [locked, setLocked] = useState(false);
  const [editing, setEditing] = useState(null);
  const [newPin, setNewPin] = useState('');
  const { data: settings } = useLive('/api/settings', ['settings']);

  const load = async () => {
    try {
      setAdmin(await api('GET', '/api/admin/people'));
      setLocked(false);
    } catch (e) {
      if (e.message === 'cancelled' || e.message === 'Wrong PIN') setLocked(true);
      else toastError(e);
    }
  };
  useEffect(() => {
    load();
  }, []);

  if (locked)
    return (
      <div className="locked">
        <IconLock size={40} stroke={1.5} />
        <p>Settings are for parents.</p>
        <button className="btn primary" onClick={load}>
          Enter PIN
        </button>
      </div>
    );
  if (!admin) return null;

  const savePin = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/auth/pin', { pin: newPin });
      forgetPin();
      setNewPin('');
      toast(newPin ? 'PIN updated' : 'PIN removed', 'success');
    } catch (err) {
      toastError(err);
    }
  };
  const status = settings?.calendar_status || {};

  return (
    <div className="settings">
      <section className="panel">
        <h3 className="panel-title">
          <IconUsers size={20} /> Household
        </h3>
        <div className="people-list">
          {admin.map((p) => {
            const s = status[p.id];
            return (
              <button key={p.id} className="person-row" onClick={() => setEditing(p)}>
                <Avatar person={p} size={44} />
                <span className="grow">
                  <strong>{p.name}</strong>
                  <span className="muted small">
                    {' '}
                    · {{ adult: 'Adult', child: 'Kid', calendar: 'Calendar only' }[p.role]}
                    {p.ntfy_topic ? ' · reminders on' : ''}
                    {p.rewards_enabled ? ' · earns rewards' : ''}
                  </span>
                </span>
                <span className="small">
                  {!p.ical_url ? (
                    <span className="muted">
                      <IconCalendar size={16} /> No calendar
                    </span>
                  ) : s?.ok ? (
                    <span className="ok">
                      <IconCheck size={16} /> {s.count} events
                    </span>
                  ) : s ? (
                    <span className="warn" title={s.error}>
                      <IconAlertTriangle size={16} /> {s.error}
                    </span>
                  ) : (
                    <span className="muted">Syncing…</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <button className="btn ghost" onClick={() => setEditing('new')}>
          <IconPlus size={18} /> Add person
        </button>
      </section>

      <section className="panel">
        <h3 className="panel-title">
          <IconMapPin size={20} /> Weather location
        </h3>
        <LocationPicker settings={settings} />
      </section>

      <ThisDevice />

      <AwayFromHome />

      <Preferences settings={settings} />

      <section className="panel">
        <h3 className="panel-title">
          <IconLock size={20} /> Parent PIN
        </h3>
        <p className="muted small">
          {settings?.pinSet
            ? 'Required for settings, editing chores, redeeming rewards, and un-checking chores.'
            : 'No PIN yet — anyone can change settings. Set one to lock parent actions.'}
        </p>
        <form className="add-row" onSubmit={savePin}>
          <input
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
            placeholder="New 4-digit PIN"
            aria-label="New PIN"
          />
          <button className="btn primary" disabled={newPin.length !== 4}>
            {settings?.pinSet ? 'Change PIN' : 'Set PIN'}
          </button>
          {settings?.pinSet && (
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                if (!confirm('Remove the parent PIN? Anyone will be able to change settings.')) return;
                try {
                  await api('PUT', '/api/auth/pin', { pin: '' });
                  forgetPin();
                  toast('PIN removed', 'success');
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              Remove PIN
            </button>
          )}
        </form>
        <button
          className="btn ghost"
          onClick={() => {
            forgetPin();
            setLocked(true);
          }}
        >
          <IconLock size={18} /> Lock now
        </button>
      </section>

      {editing && (
        <PersonEditor
          ntfyPublicUrl={settings?.ntfy_public_url}
          person={editing === 'new' ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) {
              load();
              onPeopleChanged?.();
            }
          }}
        />
      )}
    </div>
  );
}
