// Each person owns one hue; every surface that belongs to them uses it.
// soft = card fill, ink = text on soft, solid = stripes/avatars.
export const PALETTE = {
  blue: { solid: '#3b7dd8', soft: '#e3eefb', ink: '#123d73', night: '#1d3553' },
  green: { solid: '#4f9a3a', soft: '#e6f2de', ink: '#27501a', night: '#233b1d' },
  teal: { solid: '#1f9a82', soft: '#dcf3ec', ink: '#0b4d40', night: '#173a33' },
  purple: { solid: '#7a68d8', soft: '#ecebfd', ink: '#382e86', night: '#2d2952' },
  orange: { solid: '#e07b24', soft: '#fcebd9', ink: '#733a08', night: '#4a2e17' },
  pink: { solid: '#d4537e', soft: '#fbe6ee', ink: '#72243e', night: '#4a2231' },
  red: { solid: '#d84a45', soft: '#fbe6e5', ink: '#791f1f', night: '#4a2020' },
  amber: { solid: '#c28a12', soft: '#f9efd6', ink: '#5e4105', night: '#453712' },
  gray: { solid: '#7d7a72', soft: '#eeece6', ink: '#3f3e3a', night: '#34332f' },
};

export const COLOR_NAMES = Object.keys(PALETTE);

export function tone(color) {
  return PALETTE[color] || PALETTE.gray;
}

/** CSS custom properties for a person-scoped element. */
export function personVars(color) {
  const t = tone(color);
  return { '--p-solid': t.solid, '--p-soft': t.soft, '--p-ink': t.ink, '--p-night': t.night };
}
