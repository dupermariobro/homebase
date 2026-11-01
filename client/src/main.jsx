import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { connectLive } from './api.js';
import { isWallDisplay } from './device.js';
import './styles.css';

// Phones rely on pushed updates and refresh rarely; the wall tablet double-checks every minute.
connectLive({ refreshMs: isWallDisplay() ? 60000 : 5 * 60000 });

// Kiosk tablets run for weeks: reload once a night to pick up new builds and shed any leaks.
if (isWallDisplay()) {
  setInterval(() => {
    const d = new Date();
    if (d.getHours() === 3 && d.getMinutes() < 1) location.reload();
  }, 60000);
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
