// Per-device role. The wall tablet gets kiosk behaviors (screensaver, night clock,
// auto-return to Today, faster safety refresh); phones don't — they'd just burn battery.
const KEY = 'homebase-wall-display';

export function isWallDisplay() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* storage blocked — fall back to screen size */
  }
  // Tablets have a short side of ~600pt or more; phones are well under 500.
  return Math.min(screen.width, screen.height) >= 600;
}

export function setWallDisplay(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
