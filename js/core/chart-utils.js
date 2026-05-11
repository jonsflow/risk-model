// js/core/chart-utils.js — ES module version of chart-utils.js
// Exports all chart helpers as named exports instead of window.ChartUtils.
// The original IIFE chart-utils.js is kept for backwards compatibility
// with pages not yet migrated to ES modules.

const LC = window.LightweightCharts;

const OVERRIDE_KEYS = ['layout', 'grid', 'crosshair', 'rightPriceScale', 'timeScale'];

function mergeOverrides(base, overrides) {
  if (!overrides) return base;
  const result = Object.assign({}, base);
  for (const key of OVERRIDE_KEYS) {
    if (overrides[key] !== undefined) {
      result[key] = Object.assign({}, base[key], overrides[key]);
    }
  }
  return result;
}

export function createDashboardChart(el, height, overrides) {
  const base = {
    layout: {
      background: { type: 'solid', color: '#17181b' },
      textColor: '#e9e9ea',
    },
    grid: {
      vertLines: { color: '#333' },
      horzLines: { color: '#333' },
    },
    handleScroll: false,
    handleScale: false,
    width: el.clientWidth,
    height,
  };
  const chart = LC.createChart(el, mergeOverrides(base, overrides));
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
  return chart;
}

export function createFomcChart(el, height, overrides) {
  const base = {
    layout: {
      background: { color: 'transparent' },
      textColor: '#a7a7ad',
    },
    grid: {
      vertLines: { color: '#1e1e2e' },
      horzLines: { color: '#1e1e2e' },
    },
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#2a2a3e' },
    timeScale: { borderColor: '#2a2a3e', timeVisible: true, minBarSpacing: 0.1 },
    handleScroll: false,
    handleScale: false,
    width: el.clientWidth,
    height,
  };
  const chart = LC.createChart(el, mergeOverrides(base, overrides));
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
  return chart;
}

export function fitWithRightPadding(chart, dataLength, pct = 0.02) {
  chart.timeScale().applyOptions({ rightOffset: Math.ceil(dataLength * pct) });
  chart.timeScale().fitContent();
}

export function fitWithDateRangePadding(chart, pct = 0.075, dataFrom, dataTo) {
  let from, fromMs, toMs, isTs;
  if (dataFrom !== undefined && dataTo !== undefined) {
    from   = dataFrom;
    isTs   = typeof dataTo === 'number';
    fromMs = isTs ? dataFrom * 1000 : +new Date(dataFrom + 'T00:00:00Z');
    toMs   = isTs ? dataTo   * 1000 : +new Date(dataTo   + 'T00:00:00Z');
  } else {
    chart.timeScale().fitContent();
    const vr = chart.timeScale().getVisibleRange();
    if (!vr) return;
    from   = vr.from;
    isTs   = typeof vr.to === 'number';
    fromMs = isTs ? vr.from * 1000 : +new Date(vr.from + 'T00:00:00Z');
    toMs   = isTs ? vr.to   * 1000 : +new Date(vr.to   + 'T00:00:00Z');
  }
  const paddedToMs = toMs + (toMs - fromMs) * pct;
  const paddedTo = isTs
    ? Math.floor(paddedToMs / 1000)
    : new Date(paddedToMs).toISOString().slice(0, 10);
  chart.timeScale().setVisibleRange({ from, to: paddedTo });
}

export function addChartLegend(containerId, entries) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.style.position = 'relative';
  const row = document.createElement('div');
  row.style.cssText = 'position:absolute;top:8px;left:8px;z-index:10;pointer-events:none;display:flex;gap:6px;flex-wrap:wrap;';
  for (const { label, color, value } of entries) {
    const item = document.createElement('div');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
    item.innerHTML = `
      <span style="background:${color};color:#000;font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;">${label}</span>
      <span style="background:rgba(23,24,27,0.85);border:1px solid #2a2a3e;color:${color};font-size:11px;font-weight:600;padding:2px 7px;border-radius:3px;">${value}</span>
    `;
    row.appendChild(item);
  }
  el.appendChild(row);
}

export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function last(arr, n) {
  return arr.slice(Math.max(0, arr.length - n));
}

export function computePercentile(points, currentValue, windowDays) {
  const window = points.slice(Math.max(0, points.length - windowDays));
  const below = window.filter(p => p.value < currentValue).length;
  return Math.round((below / window.length) * 100);
}

export const colors = {
  rate:     '#f97316',
  effr:     '#e2e2e8',
  sofr:     '#7aa2f7',
  iorb:     '#2dd4bf',
  rrp:      '#818cf8',
  balSheet: '#a78bfa',
  reserves: '#34d399',
  mbs:      '#f59e0b',
  hike:     '#f87171',
  cut:      '#34d399',
  credit:   '#f59e0b',
  signalStrongOn:  '#10b981',
  signalOn:        '#84cc16',
  signalNeutral:   '#a7a7ad',
  signalOff:       '#f59e0b',
  signalStrongOff: '#ef4444',
};
