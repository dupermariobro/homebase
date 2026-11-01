import { getSetting } from './db.js';

let cache = { key: null, at: 0, data: null };
const TTL = 30 * 60 * 1000;

export async function getWeather(db, fetchImpl = fetch) {
  const lat = getSetting(db, 'lat');
  const lon = getSetting(db, 'lon');
  if (!lat || !lon) return null;
  const key = `${lat},${lon}`;
  if (cache.key === key && Date.now() - cache.at < TTL) return cache.data;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code' +
    '&temperature_unit=fahrenheit&timezone=auto&forecast_days=7';
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const data = {
      temp: Math.round(j.current.temperature_2m),
      code: j.current.weather_code,
      daily: j.daily.time.map((date, i) => ({
        date,
        hi: Math.round(j.daily.temperature_2m_max[i]),
        lo: Math.round(j.daily.temperature_2m_min[i]),
        code: j.daily.weather_code[i],
      })),
    };
    cache = { key, at: Date.now(), data };
    return data;
  } catch {
    return cache.key === key ? cache.data : null; // serve stale rather than nothing
  }
}
