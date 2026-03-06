// =============================================================================
// CONFIG
// =============================================================================

let LOOKBACK_DAYS = 20;
let PIVOT_MODE = "recent";
let SWING_WINDOW_DAYS = null;

// Global data cache
let dataCache = {};

// Configuration loaded from config.json
let CONFIG = null;
let PAIRS = [];
let SYMBOLS = [];

// =============================================================================
// UTILITIES
// =============================================================================

async function loadLastUpdated() {
  try {
    const r = await fetch('./data/last_updated.txt', { cache: "no-store" });
    if (!r.ok) return "unknown";

    const utcString = await r.text();
    const utcDate = new Date(utcString.replace(' UTC', 'Z').replace(' ', 'T'));

    return utcDate.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch (err) {
    console.warn("Could not load last_updated.txt:", err.message);
    return "unknown";
  }
}

function last(arr, n) {
  return arr.slice(Math.max(0, arr.length - n));
}

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(2) : "N/A";
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

async function loadConfig() {
  const r = await fetch('./config.json', { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to load config.json: ${r.status}`);
  const config = await r.json();

  if (config.defaults) {
    LOOKBACK_DAYS = config.defaults.lookback_days || LOOKBACK_DAYS;
    PIVOT_MODE = config.defaults.pivot_mode || PIVOT_MODE;
    SWING_WINDOW_DAYS = config.defaults.swing_window_days;
  }

  CONFIG = config;
  PAIRS = config.pairs || [];
  SYMBOLS = config.symbols.map(s => s.symbol.toLowerCase());

  console.log(`Loaded config: ${SYMBOLS.length} symbols, ${PAIRS.length} pairs`);
}

// =============================================================================
// DATA LOADING
// =============================================================================

async function loadCsvPoints(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${path}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift();
  const points = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 5) continue;

    const hasTime = parts.length >= 7 && parts[1].includes(":");

    let date, close;
    if (hasTime) {
      [date, , , , , close] = parts;
    } else {
      [date, , , , close] = parts;
    }

    if (!date || !close || date === "Date" || close === "Close") continue;
    const t = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000);
    const c = Number(close);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    points.push([t, c]);
  }
  points.sort((a, b) => a[0] - b[0]);
  console.log(`Loaded ${points.length} points from ${path}`);
  return points;
}

async function loadHourlyData(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${path}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift();
  const points = [];

  for (const line of lines) {
    const [date, time, open, high, low, close, volume] = line.split(",");
    if (!date || !time || !close || date === "Date") continue;

    const timestamp = Math.floor(new Date(date + "T" + time + "Z").getTime() / 1000);
    const c = Number(close);

    if (!Number.isFinite(timestamp) || !Number.isFinite(c)) continue;

    points.push([timestamp, c]);
  }

  points.sort((a, b) => a[0] - b[0]);
  return points;
}

// =============================================================================
// MA CALCULATION
// =============================================================================

function calculateMA(points, period) {
  const maPoints = [];

  for (let i = period - 1; i < points.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += points[i - j][1];
    }
    const ma = sum / period;
    maPoints.push([points[i][0], ma]);
  }

  return maPoints;
}

// =============================================================================
// CHART RENDERING
// =============================================================================

const { createChart, LineSeries, AreaSeries, CrosshairMode } = window.LightweightCharts;

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function renderChartTV(containerId, points, color = "#4a9eff", label = "", swingHighs = null, ma50Points = null) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.warn(`Container not found: ${containerId}`);
    return;
  }

  if (!points || points.length === 0) {
    console.warn(`No data for ${containerId}`);
    container.innerHTML = '<div style="padding:10px;color:#666;font-size:12px">No data</div>';
    return;
  }

  try {
    container.innerHTML = '';

    const chart = createChart(container, {
    layout: {
      background: { type: 'solid', color: '#17181b' },
      textColor: '#e9e9ea',
    },
    grid: {
      vertLines: { color: '#333' },
      horzLines: { color: '#333' },
    },
    crosshair: {
      mode: CrosshairMode.Hidden,
    },
    handleScroll: false,
    handleScale: false,
    width: container.clientWidth,
    height: 150,
  });

  const lineSeries = chart.addSeries(AreaSeries, {
    lineColor: color,
    topColor: hexToRgba(color, 0.35),
    bottomColor: hexToRgba(color, 0),
    lineWidth: 2,
    lastValueVisible: false,
    priceLineVisible: false,
  });

  const tvData = points.map(([time, value]) => ({ time, value }));
  lineSeries.setData(tvData);

  if (ma50Points && ma50Points.length > 0) {
    const ma50Series = chart.addSeries(LineSeries, {
      color: '#ffffff',
      lineWidth: 1,
      lineStyle: 4,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ma50Series.setData(ma50Points.map(([time, value]) => ({ time, value })));
  }

  if (swingHighs && swingHighs.length > 0) {
    if (swingHighs.length >= 2) {
        const trendLine = new TrendLine(chart, lineSeries,
            { time: swingHighs[0].time, price: swingHighs[0].price },
            { time: swingHighs[1].time, price: swingHighs[1].price },
            { lineColor: '#ffd700', width: 2, showLabels: false }
        );
        lineSeries.attachPrimitive(trendLine);
    }
  }

  chart.timeScale().fitContent();
  return chart;
  } catch (err) {
    console.error(`Error rendering chart ${containerId}:`, err);
    container.innerHTML = `<div style="padding:10px;color:red;font-size:12px">Error: ${err.message}</div>`;
  }
}

// =============================================================================
// PAIR GENERATION
// =============================================================================

function generatePairHTML(pair) {
  const { id, symbol1, symbol2 } = pair;
  const s1 = symbol1.toLowerCase();
  const s2 = symbol2.toLowerCase();

  return `
    <!-- ${symbol1} ↔ ${symbol2} -->
    <div class="pair-column">
      <h2>${symbol1} ↔ ${symbol2}</h2>
      <div class="trends">
        <div class="trend-item">
          <span class="muted">${symbol1} Trend</span>
          <code id="${id}-${s1}-trend"></code>
        </div>
        <div class="trend-item">
          <span class="muted">${symbol2} Trend</span>
          <code id="${id}-${s2}-trend"></code>
        </div>
      </div>
      <div class="divergence-signal" id="${id}-signal"></div>

      <div class="chart-container">
        <div class="chart-title">${symbol1} Price</div>
        <div id="chart-${id}-${s1}" style="width:100%;height:150px"></div>
      </div>
      <div class="chart-container">
        <div class="chart-title">${symbol2} Price</div>
        <div id="chart-${id}-${s2}" style="width:100%;height:150px"></div>
      </div>
    </div>
  `;
}

function renderPairColumns() {
  const container = document.querySelector('.pairs-container');
  if (!container) return;

  container.innerHTML = PAIRS.map(pair => generatePairHTML(pair)).join('');
}

// =============================================================================
// CACHE RENDERING
// =============================================================================

function applyDivergenceCache(cache) {
  // Risk score
  const riskScore      = cache.risk_score;
  const scoreElement   = document.getElementById("risk-score");
  const detailsElement = document.getElementById("risk-details");

  if (scoreElement) {
    scoreElement.textContent = `${riskScore.signal} (${riskScore.score > 0 ? '+' : ''}${riskScore.score})`;
  }
  if (detailsElement) {
    detailsElement.innerHTML = riskScore.details.map(d => {
      const above = d.includes('\u2713');
      return `<span style="padding:3px 8px;border-radius:4px;background:${above ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)'};color:${above ? '#4ade80' : '#f87171'}">${d}</span>`;
    }).join('');
  }

  // Per-pair: signals + chart render with cached pivots
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

    // Charts use CSV data from dataCache; pivots come from cache
    const pts1 = dataCache[s1];
    const pts2 = dataCache[s2];
    if (!pts1 || !pts2 || pts1.length === 0 || pts2.length === 0) continue;

    const recent1    = last(pts1, LOOKBACK_DAYS);
    const recent2    = last(pts2, LOOKBACK_DAYS);
    const startTime1 = recent1[0][0];
    const startTime2 = recent2[0][0];
    const ma50_1     = calculateMA(pts1, 50).filter(p => p[0] >= startTime1);
    const ma50_2     = calculateMA(pts2, 50).filter(p => p[0] >= startTime2);

    renderChartTV(`chart-${pairData.id}-${s1}`, recent1, pair.color1, pair.symbol1, pairData.pivots1, ma50_1);
    renderChartTV(`chart-${pairData.id}-${s2}`, recent2, pair.color2, pair.symbol2, pairData.pivots2, ma50_2);
  }
}

async function loadAndRender() {
  const swing = SWING_WINDOW_DAYS !== null ? SWING_WINDOW_DAYS : Math.max(2, Math.floor(LOOKBACK_DAYS / 10));
  const r = await fetch(`./data/cache/divergence_${LOOKBACK_DAYS}_${PIVOT_MODE}_${swing}.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Cache missing — run: python3 generate_cache.py`);
  applyDivergenceCache(await r.json());
}

// =============================================================================
// INITIALIZATION
// =============================================================================

(async function main() {
  try {
    await loadConfig();

    // Load all CSVs — still needed for TradingView chart rendering
    for (const sym of SYMBOLS) {
      try {
        dataCache[sym] = await loadCsvPoints(`./data/${sym}.csv`);
        dataCache[`${sym}_hourly`] = await loadHourlyData(`./data/${sym}_hourly.csv`);
      } catch (err) {
        console.warn(`Could not load ${sym}:`, err.message);
        dataCache[sym] = [];
        dataCache[`${sym}_hourly`] = [];
      }
    }

    renderPairColumns();

    const lastUpdated = await loadLastUpdated();
    document.getElementById("meta").textContent = `Last updated: ${lastUpdated}`;

    await loadAndRender();

    document.getElementById("lookbackSelect").addEventListener("change", (e) => {
      LOOKBACK_DAYS = parseInt(e.target.value, 10);
      loadAndRender();
    });

    document.getElementById("pivotModeSelect").addEventListener("change", (e) => {
      PIVOT_MODE = e.target.value;
      loadAndRender();
    });

    document.getElementById("barsSelect").addEventListener("change", (e) => {
      const val = e.target.value;
      SWING_WINDOW_DAYS = val === "auto" ? null : parseInt(val, 10);
      loadAndRender();
    });

  } catch (err) {
    document.getElementById("meta").textContent = "Cache missing — run: python3 generate_cache.py";
    console.error(err);
  }
})();
