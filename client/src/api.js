import { useCallback, useEffect, useRef, useState } from 'react';

// --- Parent PIN ------------------------------------------------------------
// The PIN is kept in memory only, and forgotten after 5 minutes so the wall
// tablet doesn't stay in "parent mode" after an adult walks away.
let pin = null;
let pinTimer = null;
let pinPrompt = null; // set by <PinProvider>: () => Promise<string|null>

export function setPinPrompt(fn) {
  pinPrompt = fn;
}
export function rememberPin(value) {
  pin = value;
  clearTimeout(pinTimer);
  pinTimer = setTimeout(() => (pin = null), 5 * 60 * 1000);
}
export function forgetPin() {
  pin = null;
}

export class ApiError extends Error {}

export async function api(method, url, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...(pin ? { 'x-parent-pin': pin } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.needsPin && pinPrompt) {
      forgetPin();
      const entered = await pinPrompt();
      if (!entered) throw new ApiError('cancelled');
      rememberPin(entered);
      continue;
    }
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`);
    return data;
  }
  throw new ApiError('Wrong PIN');
}

// --- Live updates ------------------------------------------------------------
const listeners = new Map(); // topic -> Set<fn>

function emit(topic) {
  for (const fn of listeners.get(topic) || []) fn();
  for (const fn of listeners.get('*') || []) fn();
}

export function subscribe(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}

let connState = 'connecting';
const connListeners = new Set();
function setConn(s) {
  connState = s;
  connListeners.forEach((fn) => fn(s));
}

// Live updates. Everything pauses while the app is hidden (another app, locked screen)
// so a phone's radio and CPU can sleep; coming back reconnects and catches up once.
export function connectLive({ refreshMs = 60000 } = {}) {
  let ws = null;
  let everOpened = false;
  let retry = 1000;
  let retryTimer = null;
  let refreshTimer = null;

  const open = () => {
    clearTimeout(retryTimer);
    if (document.hidden || ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      setConn('live');
      retry = 1000;
      if (everOpened) emit('*reconnect'); // catch up on anything missed while away
      everOpened = true;
    };
    sock.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'changed') emit(msg.topic);
      } catch {
        /* ignore malformed frames */
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (document.hidden) return; // paused on purpose
      setConn('offline');
      retryTimer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 30000);
    };
  };

  const pause = () => {
    clearTimeout(retryTimer);
    clearInterval(refreshTimer);
    refreshTimer = null;
    if (ws) {
      const s = ws;
      ws = null;
      s.close();
    }
  };
  const resume = () => {
    open();
    // One batched safety refresh for every section at once (one radio wake-up, not twelve).
    if (!refreshTimer) refreshTimer = setInterval(() => !document.hidden && emit('*reconnect'), refreshMs);
  };

  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : resume()));
  addEventListener('pagehide', pause);
  addEventListener('pageshow', () => !document.hidden && resume());
  resume();
}

export function useConnection() {
  const [s, set] = useState(connState);
  useEffect(() => {
    connListeners.add(set);
    return () => connListeners.delete(set);
  }, []);
  return s;
}

/**
 * Fetch `url` and keep it fresh: refetches when the server broadcasts a change
 * for any of `topics`, and on the shared reconnect / safety-refresh signal.
 */
export function useLive(url, topics) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const urlRef = useRef(url);
  urlRef.current = url;

  const load = useCallback(async () => {
    if (!urlRef.current) return;
    const requested = urlRef.current;
    try {
      const d = await api('GET', requested);
      if (requested === urlRef.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [url, load]);

  const topicKey = topics.join(',');
  useEffect(() => {
    const unsubs = [...topicKey.split(','), '*reconnect'].map((t) => subscribe(t, load));
    return () => unsubs.forEach((u) => u());
  }, [topicKey, load]);

  return { data, error, reload: load };
}
