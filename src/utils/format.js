/** Presentation helpers shared by every EJS template. */

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/** Compact counts — the panel shows download numbers the same way the app does. */
export function formatNumber(value) {
  const number = Number(value) || 0;
  if (number < 1000) return String(number);
  if (number < 1_000_000) {
    const thousands = number / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}K`;
  }
  return `${(number / 1_000_000).toFixed(1)}M`;
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeAgo(value) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(date.getTime())) return '—';

  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  const steps = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [604800, 'day', 86400],
    [2592000, 'week', 604800],
    [31536000, 'month', 2592000],
  ];

  for (const [limit, unit, divisor] of steps) {
    if (seconds < limit) {
      const amount = Math.floor(seconds / divisor);
      if (amount <= 1 && unit === 'second') return 'just now';
      return `${amount} ${unit}${amount === 1 ? '' : 's'} ago`;
    }
  }
  const years = Math.floor(seconds / 31536000);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Builds an SVG polyline for a sparkline, scaled to a viewBox.
 *
 * Done server-side on purpose: a charting library would be ~200 KB of JavaScript to draw
 * fourteen points, and this way the dashboard renders fully without any client-side work.
 */
export function sparklinePath(series, { width = 100, height = 30, key = 'count' } = {}) {
  const values = series.map((point) => Number(point[key]) || 0);
  if (values.length === 0) return { line: '', area: '', max: 0 };

  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  const points = values.map((value, index) => {
    const x = index * step;
    // A 2px inset keeps the stroke from being clipped at the top and bottom edges.
    const y = height - 2 - (value / max) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return {
    line: points.join(' '),
    area: `${points.join(' ')} ${width},${height} 0,${height}`,
    max,
  };
}
