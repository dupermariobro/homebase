import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb, seed } from './db.js';
import { createApp } from './app.js';
import { syncAll } from './calendar.js';
import { runReminders } from './reminders.js';
import { deviceForRequest } from './remote.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Secrets (OPENAI_API_KEY) live in .env, which is gitignored.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* no .env yet */
}
const PORT = Number(process.env.HOMEBASE_PORT || 4830);
// Loopback-only listener that Tailscale Funnel exposes to the internet; paired devices only.
const REMOTE_PORT = Number(process.env.HOMEBASE_REMOTE_PORT || 4831);
const SYNC_MS = 5 * 60 * 1000;

const db = openDb(process.env.HOMEBASE_DB || path.join(root, 'data/family.db'));
if (seed(db)) console.log('Seeded household and starter chores');

const server = http.createServer();
const wss = new WebSocketServer({ server, path: '/ws' });

const remoteServer = http.createServer();
const remoteWss = new WebSocketServer({ noServer: true });
remoteServer.on('upgrade', (req, socket, head) => {
  // Live updates for away-from-home phones need the same pairing cookie as the page.
  if (!req.url.startsWith('/ws') || !deviceForRequest(db, req.headers.cookie)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  remoteWss.handleUpgrade(req, socket, head, (ws) => remoteWss.emit('connection', ws, req));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const set of [wss.clients, remoteWss.clients]) for (const client of set) if (client.readyState === 1) client.send(data);
}

// Keep dead tablet connections (sleeping Wi-Fi) from piling up.
setInterval(() => {
  for (const ws of [...wss.clients, ...remoteWss.clients]) {
    if (ws.isAlive === false) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000).unref();
for (const w of [wss, remoteWss]) {
  w.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
  });
}

const app = createApp({ db, broadcast, staticDir: path.join(root, 'client/dist'), photoDir: process.env.HOMEBASE_PHOTOS || path.join(root, 'data/photos') });
server.on('request', app);
const remoteApp = createApp({ db, broadcast, remote: true, staticDir: path.join(root, 'client/dist'), photoDir: process.env.HOMEBASE_PHOTOS || path.join(root, 'data/photos') });
remoteServer.on('request', remoteApp);
if (REMOTE_PORT) remoteServer.listen(REMOTE_PORT, '127.0.0.1', () => console.log(`Homebase remote entrance on 127.0.0.1:${REMOTE_PORT}`));

async function syncCalendars() {
  try {
    const { changed } = await syncAll(db);
    if (changed) broadcast({ type: 'changed', topic: 'events' });
  } catch (err) {
    console.error('Calendar sync failed:', err.message);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Homebase listening on http://0.0.0.0:${PORT}`);
  syncCalendars();
  setInterval(syncCalendars, SYNC_MS).unref();
  setInterval(() => runReminders(db).catch((e) => console.error('Reminders failed:', e.message)), 60000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    remoteServer.close();
    db.close();
    process.exit(0);
  });
}
