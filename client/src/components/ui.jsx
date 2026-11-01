import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconBackspace, IconLock, IconX } from '@tabler/icons-react';
import { setPinPrompt, api } from '../api.js';
import { personVars } from '../colors.js';

// --- Toasts ------------------------------------------------------------------
let pushToast = () => {};
export function toast(message, kind = 'info') {
  pushToast({ message, kind, id: Math.random() });
}
export function toastError(err) {
  if (err?.message === 'cancelled') return;
  toast(err?.message || String(err), 'error');
}

export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3500);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// --- Modal -------------------------------------------------------------------
export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Portal to <body>: on iOS a fixed overlay inside the scrolling main area gets
  // trapped in that area (header and close button scroll out of reach).
  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX size={22} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

// --- PIN pad -----------------------------------------------------------------
export function PinProvider() {
  const [pending, setPending] = useState(null); // { resolve }
  const [digits, setDigits] = useState('');
  const [shake, setShake] = useState(false);

  useEffect(() => {
    setPinPrompt(
      () =>
        new Promise((resolve) => {
          setDigits('');
          setPending({ resolve });
        })
    );
    return () => setPinPrompt(null);
  }, []);

  if (!pending) return null;

  const close = (value) => {
    pending.resolve(value);
    setPending(null);
  };
  const submit = async (value) => {
    const { ok } = await api('POST', '/api/auth/check', { pin: value });
    if (ok) return close(value);
    setShake(true);
    setTimeout(() => {
      setShake(false);
      setDigits('');
    }, 450);
  };
  const press = (d) => {
    const next = (digits + d).slice(0, 8);
    setDigits(next);
    if (next.length === 4) submit(next);
  };

  // Portal + its own layer so the PIN pad always sits above any open window.
  return createPortal(
    <div className="scrim pin-scrim">
      <div className={`pinpad ${shake ? 'shake' : ''}`} role="dialog" aria-label="Parent PIN">
        <IconLock size={28} />
        <h2>Parent PIN</h2>
        <div className="pin-dots" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={i < digits.length ? 'on' : ''} />
          ))}
        </div>
        <div className="pin-keys">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} onClick={() => press(d)}>
              {d}
            </button>
          ))}
          <button className="ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button onClick={() => press('0')}>0</button>
          <button className="ghost" onClick={() => setDigits(digits.slice(0, -1))} aria-label="Delete">
            <IconBackspace size={24} />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// --- Avatar ------------------------------------------------------------------
export function Avatar({ person, size = 40, dim = false, onClick, title }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`avatar ${dim ? 'dim' : ''}`}
      style={{ ...personVars(person.color), width: size, height: size, fontSize: size * 0.42 }}
      onClick={onClick}
      title={title || person.name}
      aria-label={title || person.name}
      aria-pressed={onClick ? !dim : undefined}
    >
      {person.name[0]}
    </Tag>
  );
}

// --- Confetti ----------------------------------------------------------------
let fireConfetti = () => {};
export function celebrate(x, y, color) {
  fireConfetti(x, y, color);
}

export function ConfettiLayer() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    let parts = [];
    let raf = null;
    const resize = () => {
      canvas.width = innerWidth * devicePixelRatio;
      canvas.height = innerHeight * devicePixelRatio;
    };
    resize();
    addEventListener('resize', resize);
    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      parts = parts.filter((p) => p.life > 0);
      for (const p of parts) {
        p.vy += 0.35;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life -= 1;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.life / 20);
        ctx.translate(p.x * devicePixelRatio, p.y * devicePixelRatio);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-4 * devicePixelRatio, -2 * devicePixelRatio, 8 * devicePixelRatio, 4 * devicePixelRatio);
        ctx.restore();
      }
      raf = parts.length ? requestAnimationFrame(tick) : null;
    };
    fireConfetti = (x, y, color) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const colors = [color, '#f2b84b', '#ffffff', color];
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 3 + Math.random() * 6;
        parts.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s - 5,
          rot: Math.random() * 6,
          vr: (Math.random() - 0.5) * 0.4,
          life: 50 + Math.random() * 25,
          color: colors[i % colors.length],
        });
      }
      if (!raf) raf = requestAnimationFrame(tick);
    };
    return () => {
      removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
    };
  }, []);
  return <canvas ref={ref} className="confetti" aria-hidden="true" />;
}

// --- Misc ----------------------------------------------------------------------
export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="empty">
      {Icon && <Icon size={36} stroke={1.5} />}
      <p className="empty-title">{title}</p>
      {children && <p className="empty-body">{children}</p>}
    </div>
  );
}
