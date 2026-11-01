import { useEffect, useMemo, useState } from 'react';
import { fmt } from '../dates.js';

const SLIDE_MS = 12000;

function shuffle(xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function Slide({ photo, className }) {
  const src = `/photos/${photo.filename}`;
  return (
    <div className={`saver-slide ${className}`}>
      <img className="saver-fill" src={src} alt="" aria-hidden="true" />
      <img className="saver-img" src={src} alt="" />
    </div>
  );
}

/** Crossfading photo slideshow with a clock; any tap dismisses it. */
export default function Screensaver({ photos, now, weather, onWake }) {
  const order = useMemo(() => shuffle(photos), [photos]);
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => x + 1), SLIDE_MS);
    return () => clearInterval(t);
  }, []);
  if (!order.length) return null;
  const cur = order[i % order.length];
  const prev = i > 0 ? order[(i - 1) % order.length] : null;
  const next = order[(i + 1) % order.length];
  return (
    <button className="saver" onClick={onWake} aria-label="Wake screen">
      {/* Each slide is fully opaque (photo + blurred backdrop of itself), so portrait photos
          never reveal the previous slide at the sides. The previous slide stays underneath
          only so the new one can crossfade over it. */}
      {prev && prev.id !== cur.id && <Slide key={`p${prev.id}`} photo={prev} className="saver-prev" />}
      <Slide key={cur.id} photo={cur} className="saver-cur" />
      {/* Preload the next slide so the crossfade never flashes. */}
      <link rel="preload" as="image" href={`/photos/${next.filename}`} />
      <div className="saver-clock">
        <span className="saver-time">{fmt.clock(now)}</span>
        <span className="saver-date">
          {fmt.long(now)}
          {weather ? ` · ${weather.temp}°` : ''}
        </span>
      </div>
    </button>
  );
}
