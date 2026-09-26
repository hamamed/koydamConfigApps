/**
 * Small server-rendered SVG charts for the panel. No script, no library: the
 * markup is the chart, styled by wz-chart-* classes in wasla.css.
 */

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The smallest 1, 2 or 5 × 10ⁿ at or above `max` (at least `ticks`, so each step is a whole number). */
export function niceMax(max, ticks = 4) {
  if (max <= ticks) return ticks;
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
  return step * ticks;
}

/**
 * A vertical bar chart of `[{ label, value, title }]`, as an SVG string.
 * `xEvery` labels every nth bar (and always the last).
 */
export function barChart(points, { width = 720, height = 240, ticks = 4, xEvery = 5, label = 'Chart' } = {}) {
  // Room on the right for the last date, which is centred on the last bar.
  const margin = { top: 12, right: 20, bottom: 26, left: 36 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const top = niceMax(Math.max(0, ...points.map((p) => p.value)), ticks);
  const slot = points.length ? plotW / points.length : plotW;
  const barW = Math.max(2, slot * 0.72);
  const y = (v) => margin.top + plotH - (v / top) * plotH;

  const parts = [];
  for (let i = 0; i <= ticks; i++) {
    const value = (top / ticks) * i;
    const ty = y(value).toFixed(1);
    parts.push(`<line class="wz-chart-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${ty}" y2="${ty}"/>`);
    parts.push(`<text class="wz-chart-axis" x="${margin.left - 6}" y="${ty}" text-anchor="end" dominant-baseline="middle">${value}</text>`);
  }
  points.forEach((p, i) => {
    const x = margin.left + slot * i + (slot - barW) / 2;
    const h = (p.value / top) * plotH;
    // The whole column is the hover target, not just the bar: a zero day or a
    // thin bar is still easy to point at, and the tooltip names the day.
    parts.push(`<g class="wz-chart-col"><title>${escape(p.title ?? `${p.label}: ${p.value}`)}</title>`
      + `<rect class="wz-chart-hit" x="${(margin.left + slot * i).toFixed(1)}" y="${margin.top}" width="${slot.toFixed(1)}" height="${plotH}"/>`
      + `<rect class="wz-chart-bar" x="${x.toFixed(1)}" y="${(margin.top + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/></g>`);
    if (i % xEvery === 0 || i === points.length - 1) {
      parts.push(`<text class="wz-chart-axis" x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle">${escape(p.label)}</text>`);
    }
  });
  parts.push(`<line class="wz-chart-base" x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotH}" y2="${margin.top + plotH}"/>`);

  return `<svg class="wz-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(label)}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}
