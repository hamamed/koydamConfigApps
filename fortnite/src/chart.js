/**
 * A line chart as inline SVG.
 *
 * Drawn on the server rather than by a charting library because the panel runs
 * under a CSP with no inline scripts and no third-party sources — a JS chart
 * would need both. An SVG is markup, so it simply renders.
 */
export function sparkline(points, { width = 720, height = 200, colour = '#00AEEF' } = {}) {
  const values = points.filter((p) => p.value != null);
  if (values.length < 2) return null;

  const pad = { top: 14, right: 12, bottom: 26, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const max = Math.max(...values.map((p) => p.value));
  const min = Math.min(...values.map((p) => p.value));
  // A flat series would divide by zero and, worse, draw a line through the
  // middle implying variation that is not there — so a flat range is padded.
  const span = max - min || Math.max(max, 1);
  const ceiling = max + span * 0.1;
  const floor = Math.max(0, min - span * 0.1);

  const x = (i) => pad.left + (plotW * i) / (values.length - 1);
  const y = (v) => pad.top + plotH - (plotH * (v - floor)) / (ceiling - floor || 1);

  const line = values.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${pad.left},${pad.top + plotH} ${line} ${(pad.left + plotW).toFixed(1)},${pad.top + plotH}`;

  const short = (n) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
        : String(Math.round(n));

  // Three gridlines is enough to read a value off; more is furniture.
  const grid = [0, 0.5, 1].map((t) => {
    const value = floor + (ceiling - floor) * (1 - t);
    const gy = pad.top + plotH * t;
    return `<line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${gy.toFixed(1)}"
              stroke="rgba(255,255,255,.10)" stroke-width="1"/>
            <text x="${pad.left - 8}" y="${(gy + 4).toFixed(1)}" fill="rgba(255,255,255,.45)"
              font-size="11" text-anchor="end">${short(value)}</text>`;
  }).join('');

  const first = values[0].day ?? '';
  const last = values[values.length - 1].day ?? '';

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
     aria-label="${values.length} days, from ${short(min)} to ${short(max)}">
  <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${colour}" stop-opacity="0.35"/>
    <stop offset="1" stop-color="${colour}" stop-opacity="0"/>
  </linearGradient></defs>
  ${grid}
  <polygon points="${area}" fill="url(#fill)"/>
  <polyline points="${line}" fill="none" stroke="${colour}" stroke-width="2"
    stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(values[values.length - 1].value).toFixed(1)}"
    r="3.5" fill="${colour}"/>
  <text x="${pad.left}" y="${height - 8}" fill="rgba(255,255,255,.45)" font-size="11">${first}</text>
  <text x="${(pad.left + plotW).toFixed(1)}" y="${height - 8}" fill="rgba(255,255,255,.45)"
    font-size="11" text-anchor="end">${last}</text>
</svg>`;
}
