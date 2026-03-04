// =============================================================================
// CONFIG
// =============================================================================

let LOOKBACK_DAYS = 20;   // number of days to analyze for divergence (configurable via dropdown)
let PIVOT_MODE = "recent";  // "highest" = 2 highest by price, "recent" = last 2 chronologically
let SWING_WINDOW_DAYS = null;  // null = auto-scale, or manual override (2, 3, 5, etc.)

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

    const utcString = await r.text(); // e.g., "2024-12-23 21:00:00 UTC"

    // Parse UTC timestamp and convert to local browser timezone
    const utcDate = new Date(utcString.replace(' UTC', 'Z').replace(' ', 'T'));

    // Format in user's local timezone
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

  // Apply defaults
  if (config.defaults) {
    LOOKBACK_DAYS = config.defaults.lookback_days || LOOKBACK_DAYS;
    PIVOT_MODE = config.defaults.pivot_mode || PIVOT_MODE;
    SWING_WINDOW_DAYS = config.defaults.swing_window_days;
  }

  // Set global config
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
  const header = lines.shift(); // Date,Open,High,Low,Close,Volume OR Date,Time,Open,High,Low,Close,Volume
  const points = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 5) continue;

    // Check if this is hourly data (has Time column) or daily data
    const hasTime = parts.length >= 7 && parts[1].includes(":");

    let date, close;
    if (hasTime) {
      // Hourly format: Date,Time,Open,High,Low,Close,Volume
      [date, , , , , close] = parts;
    } else {
      // Daily format: Date,Open,High,Low,Close,Volume
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
  const header = lines.shift(); // Date,Time,Open,High,Low,Close,Volume
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
// SWING HIGH/LOW DETECTION
// =============================================================================

/**
 * LEGACY METHOD - NOT CURRENTLY USED
 * Find the N highest swing highs by price, returned chronologically.
 * This was the original approach but has been replaced with ThinkScript-style pivot detection.
 *
 * @param {Array} points - Array of [timestamp, price] tuples
 * @param {Number} maxSwings - How many swing highs to return (default 2)
 * @param {Number} barsEachSide - How many bars on each side must be lower (default 1)
 * @returns {Array} Array of {idx, time, price} objects, sorted chronologically
 */
function findRecentSwingHighs(points, maxSwings = 2, barsEachSide = 1) {
  const swingHighs = [];

  // Scan through ALL bars to find every swing high
  for (let i = 0; i < points.length; i++) {
    const curr = points[i][1];
    let isSwingHigh = true;

    // Check bars BEFORE (as many as are available, up to barsEachSide)
    const checkBefore = Math.min(barsEachSide, i);
    for (let j = 1; j <= checkBefore; j++) {
      if (points[i - j][1] >= curr) {
        isSwingHigh = false;
        break;
      }
    }

    // Check bars AFTER (as many as are available, up to barsEachSide)
    if (isSwingHigh) {
      const checkAfter = Math.min(barsEachSide, points.length - 1 - i);
      for (let j = 1; j <= checkAfter; j++) {
        if (points[i + j][1] >= curr) {
          isSwingHigh = false;
          break;
        }
      }
    }

    if (isSwingHigh) {
      swingHighs.push({ idx: i, time: points[i][0], price: curr });
    }
  }

  // Sort by price (highest first) and take the top N
  swingHighs.sort((a, b) => b.price - a.price);
  const topN = swingHighs.slice(0, maxSwings);

  // Sort chronologically for display
  return topN.sort((a, b) => a.time - b.time);
}

/**
 * ACTIVE METHOD - ThinkScript-style pivot detection
 * Find swing highs using ThinkScript-style pivot detection.
 * Based on the RSI_With_Divergence indicator logic.
 * Uses fixed 1-bar buffer on edges to prevent absolute edge cases while still catching recent swings.
 *
 * @param {Array} points - Array of [timestamp, price] tuples
 * @param {Number} leftBars - Bars to the left that must be lower
 * @param {Number} rightBars - Bars to the right that must be lower
 * @returns {Array} Array of {idx, time, price} objects for all pivot highs
 */
function findPivotHighs(points, leftBars = 2, rightBars = 2) {
  const pivotHighs = [];

  // Use fixed 1-bar buffer on each side (not swing window)
  // This prevents absolute edge cases but allows recent swings to be detected
  for (let i = 1; i < points.length - 1; i++) {
    const curr = points[i][1];
    let isPivotHigh = true;

    // Check leftBars BEFORE current bar (as many as available)
    const checkBefore = Math.min(leftBars, i);
    for (let j = 1; j <= checkBefore; j++) {
      if (points[i - j][1] >= curr) {
        isPivotHigh = false;
        break;
      }
    }

    // Check rightBars AFTER current bar (as many as available)
    if (isPivotHigh) {
      const checkAfter = Math.min(rightBars, points.length - 1 - i);
      for (let j = 1; j <= checkAfter; j++) {
        if (points[i + j][1] >= curr) {
          isPivotHigh = false;
          break;
        }
      }
    }

    if (isPivotHigh) {
      pivotHighs.push({ idx: i, time: points[i][0], price: curr });
    }
  }

  return pivotHighs;
}

/**
 * ACTIVE METHOD - Get pivot highs using configurable mode.
 * This is the currently active detection method.
 *
 * @param {Array} points - Array of [timestamp, price] tuples
 * @param {Number} maxPivots - How many pivots to return (default 2)
 * @param {Number} barsEachSide - How many bars on each side must be lower (default based on lookback)
 * @param {String} mode - "highest" for 2 highest by price, "recent" for last 2 chronologically
 * @returns {Array} Array of {idx, time, price} objects, sorted chronologically
 */
function findRecentPivotHighs(points, maxPivots = 2, barsEachSide = 2, mode = "highest") {
  const allPivots = findPivotHighs(points, barsEachSide, barsEachSide);

  if (mode === "highest") {
    // Sort by price (highest first) and take the top N
    allPivots.sort((a, b) => b.price - a.price);
    const topN = allPivots.slice(0, maxPivots);
    // Sort chronologically for display
    return topN.sort((a, b) => a.time - b.time);
  } else {
    // Return the last N pivots chronologically (most recent in time)
    return allPivots.slice(-maxPivots);
  }
}

/**
 * NEW METHOD - Highest swing high to current price
 * Find the highest swing high (respecting swing window) and the current (most recent) price.
 * Returns 2 points: [highest swing high, current price]
 *
 * @param {Array} points - Array of [timestamp, price] tuples
 * @param {Number} barsEachSide - How many bars on each side must be lower (swing window)
 * @returns {Array} Array of 2 {idx, time, price} objects
 */
function findHighestToCurrentLine(points, barsEachSide = 5) {
  if (points.length === 0) return [];

  // Get the current (most recent) price first (treat as first swing high)
  const currentIdx = points.length - 1;
  const currentPrice = points[currentIdx][1];

  // Exclude the current bar AND the full swing window before we start looking
  // This ensures proper separation between current price and historical swing high
  const excludeBars = barsEachSide + 1;
  const historicalPoints = points.slice(0, -excludeBars);

  if (historicalPoints.length === 0) return [];

  const allPivots = findPivotHighs(historicalPoints, barsEachSide, barsEachSide);

  if (allPivots.length === 0) return [];

  // Find the highest pivot high by price
  let highestPivot = allPivots[0];
  for (let i = 1; i < allPivots.length; i++) {
    if (allPivots[i].price > highestPivot.price) {
      highestPivot = allPivots[i];
    }
  }

  // Return both points: highest historical swing high + current price
  return [
    highestPivot,
    { idx: currentIdx, time: points[currentIdx][0], price: currentPrice }
  ];
}

// Legacy functions (not currently used, but kept for reference)
function findSwingHighs(points, window = 5) {
  const swings = [];
  for (let i = window; i < points.length - window; i++) {
    const price = points[i][1];
    let isHigh = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j !== i && points[j][1] >= price) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) swings.push({ idx: i, time: points[i][0], price });
  }
  return swings;
}

function findSwingLows(points, window = 5) {
  const swings = [];
  for (let i = window; i < points.length - window; i++) {
    const price = points[i][1];
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j !== i && points[j][1] <= price) {
        isLow = false;
        break;
      }
    }
    if (isLow) swings.push({ idx: i, time: points[i][0], price });
  }
  return swings;
}

function hasHigherHighs(swingHighs) {
  if (swingHighs.length < 2) return false;
  const recent = swingHighs.slice(-3);
  if (recent.length < 2) return false;
  let increasing = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].price > recent[i-1].price) increasing++;
  }
  return increasing >= recent.length - 1;
}

function hasLowerLows(swingLows) {
  if (swingLows.length < 2) return false;
  const recent = swingLows.slice(-3);
  if (recent.length < 2) return false;
  let decreasing = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].price < recent[i-1].price) decreasing++;
  }
  return decreasing >= recent.length - 1;
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
      lineStyle: 4, // Sparse Dotted
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
// ANALYSIS & RENDERING
// =============================================================================

/**
 * Analyze a single divergence pair and update the UI
 */
function analyzePair(pairId, symbol1, symbol2, color1, color2) {
  // Always use daily data for now (hourly data available for future use)
  const pts1 = dataCache[symbol1.toLowerCase()];
  const pts2 = dataCache[symbol2.toLowerCase()];

  if (!pts1 || !pts2 || pts1.length === 0 || pts2.length === 0) {
    console.warn(`Missing data for ${symbol1} or ${symbol2}`);
    // Show "no data" message in the signal element
    const elSignal = document.getElementById(`${pairId}-signal`);
    if (elSignal) elSignal.textContent = "⏳ No data available yet";
    return;
  }

  // Get recent data for analysis
  const recent1 = last(pts1, LOOKBACK_DAYS);
  const recent2 = last(pts2, LOOKBACK_DAYS);

  // Scale bars required based on lookback period: 20d→2 bars, 50d→5 bars, 100d→10 bars
  // Can be manually overridden with SWING_WINDOW_DAYS config
  const barsEachSide = SWING_WINDOW_DAYS !== null ? SWING_WINDOW_DAYS : Math.max(2, Math.floor(LOOKBACK_DAYS / 10));

  // Use pivot detection with configurable mode
  let top2_1, top2_2;
  if (PIVOT_MODE === "highest-to-current") {
    top2_1 = findHighestToCurrentLine(recent1, barsEachSide);
    top2_2 = findHighestToCurrentLine(recent2, barsEachSide);
  } else {
    top2_1 = findRecentPivotHighs(recent1, 2, barsEachSide, PIVOT_MODE);
    top2_2 = findRecentPivotHighs(recent2, 2, barsEachSide, PIVOT_MODE);
  }

  // Calculate trends
  const trend1 = calculateTrend(top2_1);
  const trend2 = calculateTrend(top2_2);

  // Update trend displays
  const el1 = document.getElementById(`${pairId}-${symbol1.toLowerCase()}-trend`);
  const el2 = document.getElementById(`${pairId}-${symbol2.toLowerCase()}-trend`);
  if (el1) el1.textContent = trend1;
  if (el2) el2.textContent = trend2;

  // Determine divergence signal
  const signal = getDivergenceSignal(trend1, trend2, symbol1, symbol2);
  const elSignal = document.getElementById(`${pairId}-signal`);
  if (elSignal) elSignal.textContent = signal;

  // Compute MAs from full dataset, then filter to the lookback window for display
  const startTime1 = recent1[0][0];
  const startTime2 = recent2[0][0];
  const ma50_1 = calculateMA(pts1, 50).filter(p => p[0] >= startTime1);
  const ma50_2 = calculateMA(pts2, 50).filter(p => p[0] >= startTime2);

  // Render charts
  renderChartTV(`chart-${pairId}-${symbol1.toLowerCase()}`, recent1, color1, symbol1, top2_1, ma50_1);
  renderChartTV(`chart-${pairId}-${symbol2.toLowerCase()}`, recent2, color2, symbol2, top2_2, ma50_2);

}

function calculateTrend(swingHighs) {
  if (swingHighs.length < 2) return "Sideways ↔";
  if (swingHighs[1].price > swingHighs[0].price) return "Higher Highs ↗";
  if (swingHighs[1].price < swingHighs[0].price) return "Lower Highs ↘";
  return "Sideways ↔";
}

function getDivergenceSignal(trend1, trend2, name1, name2) {
  const up = "Higher Highs ↗";
  const down = "Lower Highs ↘";

  if (trend1 === up && trend2 === down) {
    return `⚠️ BEARISH: ${name1} higher highs, ${name2} lower highs`;
  } else if (trend1 === down && trend2 === up) {
    return `⚠️ BULLISH: ${name1} lower highs, ${name2} higher highs`;
  } else if (trend1 === up && trend2 === up) {
    return `✅ ALIGNED: Both making higher highs`;
  } else if (trend1 === down && trend2 === down) {
    return `🔴 ALIGNED: Both making lower highs`;
  }
  return "⚖️ No clear divergence";
}

function calculateRatio(pts1, pts2) {
  const ratioPoints = [];
  const map1 = new Map(pts1.map(p => [p[0], p[1]]));
  const map2 = new Map(pts2.map(p => [p[0], p[1]]));

  for (const [time, price1] of map1) {
    const price2 = map2.get(time);
    if (price2 && price2 !== 0) {
      ratioPoints.push([time, price1 / price2]);
    }
  }
  return ratioPoints;
}

/**
 * Calculate simple moving average for a given period
 * @param {Array} points - Array of [timestamp, price] tuples
 * @param {Number} period - MA period (e.g., 50 for 50-day MA)
 * @returns {Array} Array of [timestamp, ma_value] tuples
 */
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

function calculateRiskScore() {
  let score = 0;
  const signals = [];

  for (const sym of SYMBOLS) {
    const pts = dataCache[sym];
    if (!pts || pts.length === 0) continue;

    const ma50 = calculateMA(pts, 50);
    if (ma50.length === 0) continue;

    const currentPrice = pts[pts.length - 1][1];
    const currentMA = ma50[ma50.length - 1][1];
    const label = sym.toUpperCase();

    if (currentPrice > currentMA) {
      score += 1;
      signals.push(`${label}: Above 50 MA ✓`);
    } else {
      score -= 1;
      signals.push(`${label}: Below 50 MA ✗`);
    }
  }

  const total = SYMBOLS.length;
  let signal = "";
  if (score >= Math.ceil(total * 0.7)) {
    signal = "🟢 STRONG RISK ON";
  } else if (score >= Math.ceil(total * 0.3)) {
    signal = "🟡 RISK ON";
  } else if (score >= -Math.ceil(total * 0.3)) {
    signal = "⚪ NEUTRAL";
  } else if (score >= -Math.ceil(total * 0.7)) {
    signal = "🟠 RISK OFF";
  } else {
    signal = "🔴 STRONG RISK OFF";
  }

  return { score, signal, details: signals };
}

function calculateMA(points, period) {
  const maPoints = [];
  for (let i = period - 1; i < points.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += points[i - j][1];
    }
    maPoints.push([points[i][0], sum / period]);
  }
  return maPoints;
}

function analyzeAndRender() {
  for (const pair of PAIRS) {
    analyzePair(pair.id, pair.symbol1, pair.symbol2, pair.color1, pair.color2);
  }

  const riskScore = calculateRiskScore();
  const scoreElement = document.getElementById("risk-score");
  const detailsElement = document.getElementById("risk-details");

  if (scoreElement) {
    scoreElement.textContent = `${riskScore.signal} (${riskScore.score > 0 ? '+' : ''}${riskScore.score})`;
  }

  if (detailsElement) {
    detailsElement.innerHTML = riskScore.details.map(d => {
      const above = d.includes('✓');
      return `<span style="padding:3px 8px;border-radius:4px;background:${above ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)'};color:${above ? '#4ade80' : '#f87171'}">${d}</span>`;
    }).join('');
  }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

(async function main() {
  try {
    // Load configuration first
    await loadConfig();

    // Load all symbols from config (gracefully handle missing files)
    for (const sym of SYMBOLS) {
      try {
        // Load daily data (for 50/100 day lookbacks)
        dataCache[sym] = await loadCsvPoints(`./data/${sym}.csv`);
        console.log(`Loaded ${sym} daily: ${dataCache[sym].length} points`);

        // Load hourly data (for 20 day lookback)
        dataCache[`${sym}_hourly`] = await loadHourlyData(`./data/${sym}_hourly.csv`);
        console.log(`Loaded ${sym} hourly: ${dataCache[`${sym}_hourly`].length} points`);
      } catch (err) {
        console.warn(`Could not load ${sym}:`, err.message);
        dataCache[sym] = []; // Empty array for missing data
        dataCache[`${sym}_hourly`] = [];
      }
    }

    // Generate pair columns from config
    renderPairColumns();

    // Load and display last updated timestamp
    const lastUpdated = await loadLastUpdated();
    document.getElementById("meta").textContent = `Last updated: ${lastUpdated}`;

    // Set up dropdown listeners
    const lookbackSelect = document.getElementById("lookbackSelect");
    lookbackSelect.addEventListener("change", (e) => {
      LOOKBACK_DAYS = parseInt(e.target.value, 10);
      analyzeAndRender();
    });

    const pivotModeSelect = document.getElementById("pivotModeSelect");
    pivotModeSelect.addEventListener("change", (e) => {
      PIVOT_MODE = e.target.value;
      analyzeAndRender();
    });

    const barsSelect = document.getElementById("barsSelect");
    barsSelect.addEventListener("change", (e) => {
      const val = e.target.value;
      SWING_WINDOW_DAYS = val === "auto" ? null : parseInt(val, 10);
      analyzeAndRender();
    });

    // Initial render
    analyzeAndRender();
  } catch (err) {
    document.getElementById("meta").textContent = "Error loading data.";
    console.error(err);
  }
})();
