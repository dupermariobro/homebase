import { useRef, useState } from 'react';
import {
  IconSparkles,
  IconPhotoPlus,
  IconX,
  IconCalendarEvent,
  IconChecklist,
  IconShoppingCart,
  IconToolsKitchen2,
  IconNote,
  IconHourglass,
  IconBucket,
} from '@tabler/icons-react';
import { api } from '../api.js';
import { blobToDataUrl, resizeImage } from '../image.js';
import { Modal, toast, toastError } from './ui.jsx';
import { members, REPEAT_LABELS } from './extras.jsx';

const MAX_IMAGES = 4;

const TYPES = {
  event: { label: 'Event', icon: IconCalendarEvent },
  chore: { label: 'Chore', icon: IconBucket },
  task: { label: 'To-do', icon: IconChecklist },
  grocery: { label: 'Grocery', icon: IconShoppingCart },
  meal: { label: 'Dinner', icon: IconToolsKitchen2 },
  note: { label: 'Note', icon: IconNote },
  countdown: { label: 'Countdown', icon: IconHourglass },
};

function ItemCard({ item, people, onChange }) {
  const T = TYPES[item.type] || TYPES.note;
  const set = (k, v) => onChange({ ...item, [k]: v });
  const whoOptions = item.type === 'event' ? people : members(people);
  const days = Array.isArray(item.days) ? item.days : [];
  const toggleDay = (d) => set('days', days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());
  return (
    <div className={`qa-card ${item.include ? '' : 'off'}`}>
      <div className="qa-head">
        <label className="qa-include">
          <input type="checkbox" checked={item.include} onChange={(e) => set('include', e.target.checked)} />
          <T.icon size={20} />
        </label>
        {/* If the AI guessed the wrong kind of thing, switch it here. */}
        <select className="qa-type" value={item.type} onChange={(e) => set('type', e.target.value)} aria-label="Type">
          {Object.entries(TYPES).map(([k, t]) => (
            <option key={k} value={k}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <input className="qa-title" value={item.title} onChange={(e) => set('title', e.target.value)} aria-label="Title" />
      <div className="qa-fields">
        {item.type !== 'grocery' && item.type !== 'meal' && item.type !== 'countdown' && (
          <select value={item.person_id ?? ''} onChange={(e) => set('person_id', e.target.value ? Number(e.target.value) : null)} aria-label="Who">
            <option value="">{item.type === 'event' ? 'Family' : item.type === 'chore' ? 'Who?' : 'Anyone'}</option>
            {whoOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {['event', 'task', 'meal', 'countdown'].includes(item.type) && (
          <input type="date" value={item.date || ''} onChange={(e) => set('date', e.target.value)} aria-label="Date" />
        )}
        {item.type === 'event' && (
          <>
            <input type="time" value={item.start_time || ''} onChange={(e) => set('start_time', e.target.value)} aria-label="Start" />
            <input type="time" value={item.end_time || ''} onChange={(e) => set('end_time', e.target.value)} aria-label="End" />
            <select value={item.repeat || 'none'} onChange={(e) => set('repeat', e.target.value)} aria-label="Repeats">
              {Object.entries(REPEAT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </>
        )}
        {(item.type === 'chore' || item.type === 'task') && (
          <label className="qa-points">
            <input
              type="number"
              min="0"
              max="100"
              inputMode="numeric"
              value={item.points ?? (item.type === 'chore' ? 1 : 0)}
              onChange={(e) => set('points', Number(e.target.value))}
              aria-label="Points"
            />
            <span>pts</span>
          </label>
        )}
      </div>
      {item.type === 'chore' && (
        <div className="day-picker qa-days">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w, d) => (
            <button type="button" key={w} className={days.includes(d) ? 'on' : ''} onClick={() => toggleDay(d)}>
              {w}
            </button>
          ))}
          <span className="muted small">{days.length === 0 || days.length === 7 ? 'Every day' : ''}</span>
        </div>
      )}
      {item.type === 'meal' && item.ingredients?.length > 0 && <p className="muted small">Ingredients: {item.ingredients.join(', ')}</p>}
      {item.location && <p className="muted small">At {item.location}</p>}
    </div>
  );
}

export function QuickAddButton({ people, enabled }) {
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return (
    <>
      <button className="fab" onClick={() => setOpen(true)} aria-label="Quick add">
        <IconSparkles size={28} />
      </button>
      {open && <QuickAdd people={people} onClose={() => setOpen(false)} />}
    </>
  );
}

function QuickAdd({ people, onClose }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState([]); // data URLs, up to MAX_IMAGES
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState(null);
  const fileRef = useRef(null);

  const pickPhotos = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const room = MAX_IMAGES - images.length;
    if (files.length > room) toast(`Up to ${MAX_IMAGES} images — using the first ${room}`);
    const added = [];
    for (const file of files.slice(0, room)) {
      try {
        added.push(await blobToDataUrl(await resizeImage(file, 1600, 0.8)));
      } catch (err) {
        toastError(err);
      }
    }
    setImages((cur) => [...cur, ...added].slice(0, MAX_IMAGES));
  };
  const parse = async () => {
    if (!text.trim() && !images.length) return toast('Type something or add a photo');
    setBusy(true);
    try {
      const r = await api('POST', '/api/ai/parse', { text, images });
      if (!r.items.length) toast('Nothing to add found in that');
      setItems(r.items.map((it) => ({ ...it, include: true })));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    const chosen = items.filter((i) => i.include && i.title.trim());
    if (!chosen.length) return onClose();
    setBusy(true);
    try {
      const r = await api('POST', '/api/ai/apply', { items: chosen });
      if (r.errors.length) toast(`Added ${r.added}. Skipped: ${r.errors.join('; ')}`, 'error');
      else toast(`Added ${r.added} item${r.added === 1 ? '' : 's'}`, 'success');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Quick add" onClose={onClose} wide>
      {!items ? (
        <div className="form">
          <textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Riley dentist Thursday at 3:30\nWe need milk, eggs, and coffee\nTacos for dinner Friday'}
            autoFocus
            aria-label="What do you want to add?"
          />
          <p className="hint">Type or use the keyboard’s mic to dictate. Add photos of a flyer, permission slip, or schedule — from your camera or your photo library.</p>
          {images.length > 0 && (
            <div className="qa-thumbs">
              {images.map((src, i) => (
                <div key={i} className="qa-thumb">
                  <img src={src} alt={`Attached ${i + 1}`} />
                  <button className="icon-btn" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove photo">
                    <IconX />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* No "capture" attribute: phones offer Photo Library, Take Photo, or Files. */}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={pickPhotos} />
          <div className="form-actions">
            <button className="btn" onClick={() => fileRef.current.click()} disabled={busy || images.length >= MAX_IMAGES}>
              <IconPhotoPlus size={20} /> {images.length ? 'Add another' : 'Add photo'}
            </button>
            <span className="grow" />
            <button className="btn primary" onClick={parse} disabled={busy}>
              <IconSparkles size={20} className={busy ? 'spin' : ''} /> {busy ? 'Reading…' : 'Read it'}
            </button>
          </div>
        </div>
      ) : (
        <div className="form">
          <p className="muted small">Check what to add — edit anything that’s off.</p>
          {items.map((it, i) => (
            <ItemCard key={i} item={it} people={people} onChange={(next) => setItems(items.map((x, j) => (j === i ? next : x)))} />
          ))}
          <div className="form-actions qa-actions">
            <button className="btn ghost" onClick={() => setItems(null)} disabled={busy}>
              Back
            </button>
            <span className="grow" />
            <button className="btn primary" onClick={apply} disabled={busy}>
              Add {items.filter((i) => i.include).length}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
