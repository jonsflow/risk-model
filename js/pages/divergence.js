// js/pages/divergence.js — Divergence Dashboard page (ES module).
import { renderNav }                               from '../components/Navigation.js';
import { fetchDivergence, fetchCache }             from '../core/api.js';
import {
  createDashboardChart, hexToRgba, fitWithRightPadding,
  addChartLegend, last, colors,
} from '../core/chart-utils.js';

const LC = window.LightweightCharts;

let LOOKBACK_DAYS     = 20;
let PIVOT_MODE        = 'recent';
let SWING_WINDOW_DAYS = null;

let dataCache = {};
let CONFIG    = null;
let PAIRS     = [];
let SYMBOLS   = [];
let TREND_ASSETS = [];

// ------------------------------------------------------------------
// CSV loading (needed for chart rendering — price data not in cache)
// ------------------------------------------------------------------

async function loadCsvPoints(path, cacheMode = 'default') {
  const opts = cacheMode === 'default' ? {} : { cache: cacheMode };
  const r    = await fetch(path, opts);
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${path}`);
  const lines = (await r.text()).trim().split(/\r?\n/);
  lines.shift();
  const points = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const hasTime = parts.length >= 7 && parts[1].includes(':');
    let date, close;
    if (hasTime) { [date,,,,, close] = parts; }
    else         { [date,,,, close] = parts; }
    if (!date || !close || date === 'Date' || close === 'Close') continue;
    const t = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
    const c = Number(close);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    points.push([t, c]);
  }
  points.sort((a, b) => a[0] - b[0]);
  return points;
}

// ------------------------------------------------------------------
// MA calculation
// ------------------------------------------------------------------

function calculateMA(points, period) {
  const out = [];
  for (let i = period - 1; i < points.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += points[i - j][1];
    out.push([points[i][0], sum / period]);
  }
  return out;
}

// ------------------------------------------------------------------
// Chart rendering
// ------------------------------------------------------------------

function renderChart(containerId, points, color, maPoints) {
  const container = document.getElementById(containerId);
  if (!container || !points?.length) return;
  container.innerHTML = '';

  const chart = LC.createChart(container, {
    layout: { background: { type: 'solid', color: '#17181b' }, textColor: '#e9e9ea' },
    grid:   { vertLines: { color: '#333' }, horzLines: { color: '#333' } },
    crosshair: { mode: LC.CrosshairMode.Normal },
    handleScroll: false, handleScale: false,
    autoSize: true, height: 150,
  });

  const area = chart.addSeries(LC.AreaSeries, {
    lineColor: color,
    topColor:    hexToRgba(color, 0.35),
    bottomColor: hexToRgba(color, 0),
    lineWidth: 2,
    lastValueVisible: true, priceLineVisible: false,
  });
  area.setData(points.map(([time, value]) => ({ time, value })));

  if (maPoints?.length) {
    const ma = chart.addSeries(LC.LineSeries, {
      color: '#f59e0b',
      lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false,
    });
    ma.setData(maPoints.map(([time, value]) => ({ time, value })));
  }

  chart.timeScale().fitContent();
  return chart;
}

// ------------------------------------------------------------------
// Trend scoring
// ------------------------------------------------------------------

function classifyTrend(s) {
  if (s.includes('↗')) return 'up';
  if (s.includes('↘')) return 'down';
  return 'sideways';
}

function trendArrow(s) {
  if (s.includes('↗')) return '↗';
  if (s.includes('↘')) return '↘';
  return '→';
}

function scoreSymbol(s) {
  const t = classifyTrend(s);
  return t === 'up' ? 1 : t === 'down' ? -1 : 0;
}

function trendSignalLabel(score, maxTotal) {
  const r = score / maxTotal;
  if (r >= 6/7)  return { label: '🟢 STRONG RISK ON',  color: colors.signalStrongOn  };
  if (r >= 4/7)  return { label: '🟡 RISK ON',          color: colors.signalOn        };
  if (r >= -3/7) return { label: '⚪ NEUTRAL',           color: colors.signalNeutral   };
  if (r >= -5/7) return { label: '🟠 RISK OFF',          color: colors.signalOff       };
  return          { label: '🔴 STRONG RISK OFF',         color: colors.signalStrongOff };
}

// ------------------------------------------------------------------
// DOM rendering
// ------------------------------------------------------------------

function renderPairColumns() {
  const container = document.querySelector('.pairs-container');
  if (!container) return;
  container.innerHTML = PAIRS.map(pair => {
    const s1 = pair.symbol1.toLowerCase();
    const s2 = pair.symbol2.toLowerCase();
    return `
      <div class="pair-column">
        <h2>${pair.symbol1} ↔ ${pair.symbol2}</h2>
        <div class="trends">
          <div class="trend-item">
            <span class="muted">${pair.symbol1} Trend</span>
            <code id="${pair.id}-${s1}-trend"></code>
          </div>
          <div class="trend-item">
            <span class="muted">${pair.symbol2} Trend</span>
            <code id="${pair.id}-${s2}-trend"></code>
          </div>
        </div>
        <div class="divergence-signal" id="${pair.id}-signal"></div>
        <div class="pair-scores" id="${pair.id}-pair-scores"></div>
        <div class="chart-container">
          <div class="chart-title">${pair.symbol1} Price</div>
          <div id="chart-${pair.id}-${s1}" style="width:100%;height:150px"></div>
        </div>
        <div class="chart-container">
          <div class="chart-title">${pair.symbol2} Price</div>
          <div id="chart-${pair.id}-${s2}" style="width:100%;height:150px"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderPressureCard(summary) {
  const elLabel = document.getElementById('pressure-label');
  const elScore = document.getElementById('pressure-score');
  if (!elLabel) return;
  const sign  = summary.net_score > 0 ? '+' : '';
  const color = { BEARISH: '#ef4444', BULLISH: '#10b981', MIXED: '#fbbf24', NEUTRAL: '#a7a7ad' }[summary.label] ?? '#a7a7ad';
  elLabel.innerHTML = `<span style="color:${color}">${summary.label}</span>`
    + (summary.net_score !== 0 ? ` <span style="font-size:16px">(${sign}${summary.net_score})</span>` : '');
  elScore.textContent = `${summary.bearish_count} bearish · ${summary.bullish_count} bullish (max ±6)`;
}

function applyDivergenceCache(cache) {
  const riskScore   = cache.risk_score;
  const scoreEl     = document.getElementById('risk-score');
  if (scoreEl) scoreEl.textContent = `${riskScore.signal} (${riskScore.above_count}/${riskScore.total})`;

  // Trend-structure risk score
  const trendEl = document.getElementById('trend-risk-score');
  const symbolTrendMap = new Map();
  for (const pairData of cache.pairs) {
    const pairConfig = PAIRS.find(p => p.id === pairData.id);
    if (!pairConfig) continue;
    if (!symbolTrendMap.has(pairConfig.symbol1)) symbolTrendMap.set(pairConfig.symbol1, pairData.trend1);
    if (!symbolTrendMap.has(pairConfig.symbol2)) symbolTrendMap.set(pairConfig.symbol2, pairData.trend2);
  }
  let total = 0;
  for (const symbol of TREND_ASSETS) {
    const trend = symbolTrendMap.get(symbol);
    if (trend !== undefined) total += scoreSymbol(trend);
  }
  const { label, color } = trendSignalLabel(total, TREND_ASSETS.length);
  if (trendEl) {
    trendEl.textContent = `${label} (${total > 0 ? '+' : ''}${total})`;
    trendEl.style.color = color;
  }

  if (cache.summary) renderPressureCard(cache.summary);

  for (const pairData of cache.pairs) {
    const pair = PAIRS.find(p => p.id === pairData.id);
    if (!pair) continue;
    const s1 = pair.symbol1.toLowerCase();
    const s2 = pair.symbol2.toLowerCase();

    const el1 = document.getElementById(`${pairData.id}-${s1}-trend`);
    const el2 = document.getElementById(`${pairData.id}-${s2}-trend`);
    if (el1) el1.textContent = pairData.trend1;
    if (el2) el2.textContent = pairData.trend2;

    const elSignal = document.getElementById(`${pairData.id}-signal`);
    if (elSignal) elSignal.textContent = pairData.signal;

    const pairScoresEl = document.getElementById(`${pairData.id}-pair-scores`);
    if (pairScoresEl) {
      const score   = scoreSymbol(pairData.trend1) + scoreSymbol(pairData.trend2);
      const sign    = score > 0 ? '+' : '';
      const detail1 = riskScore.details.find(d => d.startsWith(pair.symbol1 + ':')) || '';
      const detail2 = riskScore.details.find(d => d.startsWith(pair.symbol2 + ':')) || '';
      const above1  = detail1.includes('✓');
      const above2  = detail2.includes('✓');
      const chipBg  = score > 0 ? 'rgba(16,185,129,0.15)' : score < 0 ? 'rgba(239,68,68,0.15)' : 'rgba(167,167,173,0.15)';
      const chipTxt = score > 0 ? '#10b981' : score < 0 ? '#ef4444' : '#a7a7ad';
      pairScoresEl.innerHTML = [
        `<span style="padding:3px 8px;border-radius:4px;background:${above1 ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)'};color:${above1 ? '#4ade80' : '#f87171'}">${detail1 || pair.symbol1}</span>`,
        `<span style="padding:3px 8px;border-radius:4px;background:${above2 ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)'};color:${above2 ? '#4ade80' : '#f87171'}">${detail2 || pair.symbol2}</span>`,
        `<span style="padding:3px 8px;border-radius:4px;background:${chipBg};color:${chipTxt}">${trendArrow(pairData.trend1)} vs ${trendArrow(pairData.trend2)} (${sign}${score})</span>`,
      ].join('');
    }

    const pts1 = dataCache[s1];
    const pts2 = dataCache[s2];
    if (!pts1?.length || !pts2?.length) continue;

    const recent1 = last(pts1.map(([t,v]) => ({time:t,value:v})), LOOKBACK_DAYS);
    const recent2 = last(pts2.map(([t,v]) => ({time:t,value:v})), LOOKBACK_DAYS);
    const startTime1 = recent1[0]?.time;
    const startTime2 = recent2[0]?.time;
    const ma50_1 = calculateMA(pts1, 50).filter(p => p[0] >= startTime1);
    const ma50_2 = calculateMA(pts2, 50).filter(p => p[0] >= startTime2);

    renderChart(`chart-${pairData.id}-${s1}`, pts1.filter(p => p[0] >= startTime1), pair.color1, ma50_1);
    renderChart(`chart-${pairData.id}-${s2}`, pts2.filter(p => p[0] >= startTime2), pair.color2, ma50_2);
  }
}

async function loadAndRender() {
  const swing = SWING_WINDOW_DAYS !== null
    ? SWING_WINDOW_DAYS
    : Math.min(10, Math.max(2, Math.floor(LOOKBACK_DAYS / 10)));
  const cache = await fetchDivergence(LOOKBACK_DAYS, PIVOT_MODE, swing);
  applyDivergenceCache(cache);
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

async function init() {
  renderNav();
  try {
    const config = await fetchCache('config/config.json');
    if (config.defaults) {
      LOOKBACK_DAYS     = config.defaults.lookback_days     || LOOKBACK_DAYS;
      PIVOT_MODE        = config.defaults.pivot_mode        || PIVOT_MODE;
      SWING_WINDOW_DAYS = config.defaults.swing_window_days ?? null;
    }
    CONFIG      = config;
    PAIRS       = config.pairs || [];
    SYMBOLS     = (config.symbols || []).map(s => s.symbol.toLowerCase());
    TREND_ASSETS = config.trend_assets || [];

    // Check for new data version
    let csvCacheMode = 'default';
    try {
      const r = await fetch('./data/last_updated.txt', { cache: 'no-store' });
      if (r.ok) {
        const rawVersion = (await r.text()).trim();
        const storedVersion = localStorage.getItem('risk_data_version') || '';
        if (rawVersion !== storedVersion) {
          csvCacheMode = 'no-cache';
          localStorage.setItem('risk_data_version', rawVersion);
        }
        const d = new Date(rawVersion.replace(' UTC', 'Z').replace(' ', 'T'));
        document.getElementById('meta').textContent = `Last updated: ${d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`;
      }
    } catch (_) {
      document.getElementById('meta').textContent = 'Last updated: unknown';
    }

    await Promise.all(SYMBOLS.map(async sym => {
      try { dataCache[sym] = await loadCsvPoints(`./data/${sym}.csv`, csvCacheMode); }
      catch (_) { dataCache[sym] = []; }
    }));

    renderPairColumns();
    await loadAndRender();

    document.getElementById('lookbackSelect')?.addEventListener('change', e => {
      LOOKBACK_DAYS = parseInt(e.target.value, 10);
      loadAndRender();
    });
    document.getElementById('pivotModeSelect')?.addEventListener('change', e => {
      PIVOT_MODE = e.target.value;
      loadAndRender();
    });
    document.getElementById('barsSelect')?.addEventListener('change', e => {
      const val = e.target.value;
      SWING_WINDOW_DAYS = val === 'auto' ? null : parseInt(val, 10);
      loadAndRender();
    });
  } catch (err) {
    document.getElementById('meta').textContent = 'Cache missing — run: python3 generate_cache.py';
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
