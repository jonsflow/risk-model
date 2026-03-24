// =============================================================================
// CONFIG
// =============================================================================

let MA_PERIOD      = 20;
let WINDOW_DAYS    = 756;  // percentile lookback
let HISTORY_DAYS   = 504;  // chart display window

const SERIES_ID    = 'BAMLH0A0HYM2';
const CSV_PATH     = `./data/fred/${SERIES_ID}.csv`;

const { LineSeries, AreaSeries } = window.LightweightCharts;

// =============================================================================
// DATA LOADING
// =============================================================================

async function loadFredCsv(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to fetch ${path}: ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  lines.shift(); // remove header

  const points = [];
  for (const line of lines) {
    const [date, value] = line.split(',');
    if (!date || !value || date === 'Date') continue;
    const v = parseFloat(value);
    if (!isFinite(v)) continue;
    points.push({ date, value: v });
  }
  return points; // [{ date: 'YYYY-MM-DD', value: float }, ...]
}

// =============================================================================
// ANALYSIS
// =============================================================================

function computeMA(points, period) {
  const result = [];
  for (let i = period - 1; i < points.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += points[i - j].value;
    result.push({ date: points[i].date, value: sum / period });
  }
  return result;
}

function computePercentile(points, currentValue, windowDays) {
  // Use the last windowDays points as the reference distribution
  const window = points.slice(Math.max(0, points.length - windowDays));
  const below = window.filter(p => p.value < currentValue).length;
  return Math.round((below / window.length) * 100);
}

function levelScore(percentile) {
  if (percentile <= 25) return  2;
  if (percentile <= 50) return  1;
  if (percentile <= 75) return -1;
  return -2;
}

function momentumScore(currentValue, maValue) {
  return currentValue < maValue ? 1 : -1;
}

function signalLabel(score) {
  if (score >=  3) return { label: '🟢 STRONG RISK ON',  color: ChartUtils.colors.signalStrongOn };
  if (score >=  1) return { label: '🟡 RISK ON',         color: ChartUtils.colors.signalOn };
  if (score === 0) return { label: '⚪ NEUTRAL',          color: ChartUtils.colors.signalNeutral };
  if (score >= -2) return { label: '🟠 RISK OFF',         color: ChartUtils.colors.signalOff };
  return               { label: '🔴 STRONG RISK OFF',    color: ChartUtils.colors.signalStrongOff };
}

// =============================================================================
// CHART
// =============================================================================

let chartInstance = null;

function renderChart(points, maPoints, historyDays) {
  const container = document.getElementById('chart-credit');
  if (!container) return;
  container.innerHTML = '';

  const recent = points.slice(-historyDays);
  const startDate = recent[0].date;
  const recentMa = maPoints.filter(p => p.date >= startDate);

  const chart = ChartUtils.createDashboardChart(container, 300);
  const LC = window.LightweightCharts;

  const area = chart.addSeries(AreaSeries, {
    lineColor: ChartUtils.colors.credit,
    topColor: ChartUtils.hexToRgba(ChartUtils.colors.credit, 0.3),
    bottomColor: ChartUtils.hexToRgba(ChartUtils.colors.credit, 0),
    lineWidth: 2,
    priceLineVisible: true,
    priceLineStyle: LC.LineStyle.Dashed,
    lastValueVisible: true,
  });
  area.setData(recent.map(p => ({ time: p.date, value: p.value })));

  if (recentMa.length) {
    const ma = chart.addSeries(LineSeries, {
      color: '#ffffff',
      lineWidth: 1,
      lineStyle: 4,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    ma.setData(recentMa.map(p => ({ time: p.date, value: p.value })));
  }

  ChartUtils.fitWithRightPadding(chart, recent.length);

  const lastSpread = recent[recent.length - 1].value;
  const entries = [{ label: 'HY OAS', color: ChartUtils.colors.credit, value: `${lastSpread.toFixed(2)}%` }];
  if (recentMa.length) {
    const lastMa = recentMa[recentMa.length - 1].value;
    entries.push({ label: `${MA_PERIOD}d MA`, color: '#ffffff', value: `${lastMa.toFixed(2)}%` });
  }
  ChartUtils.addChartLegend('chart-credit', entries);

  chartInstance = chart;
}

// =============================================================================
// DOM RENDERING
// =============================================================================

function applySignal(points) {
  if (points.length < MA_PERIOD + 1) {
    document.getElementById('meta').textContent = 'Not enough data.';
    return;
  }

  const maPoints   = computeMA(points, MA_PERIOD);
  const current    = points[points.length - 1];
  const currentMa  = maPoints[maPoints.length - 1];
  const percentile = computePercentile(points, current.value, WINDOW_DAYS);
  const lvl        = levelScore(percentile);
  const mom        = momentumScore(current.value, currentMa.value);
  const score      = lvl + mom;
  const { label, color } = signalLabel(score);
  const direction  = current.value < currentMa.value ? 'tightening ↘' : 'widening ↗';
  const windowLabel = WINDOW_DAYS === 252 ? '1yr' : WINDOW_DAYS === 756 ? '3yr' : '5yr';

  document.getElementById('meta').textContent =
    `Series: ${SERIES_ID} · As of ${current.date}`;

  const sigEl = document.getElementById('signal-label');
  sigEl.textContent  = label;
  sigEl.style.color  = color;
  document.getElementById('signal-score').textContent =
    `Level: ${lvl > 0 ? '+' : ''}${lvl}  ·  Momentum: ${mom > 0 ? '+' : ''}${mom}  ·  Total: ${score > 0 ? '+' : ''}${score}`;

  const valEl = document.getElementById('current-value');
  valEl.textContent = `${current.value.toFixed(2)}%`;
  valEl.style.color = color;
  document.getElementById('current-ma').textContent =
    `${MA_PERIOD}-day MA: ${currentMa.value.toFixed(2)}% · ${direction}`;

  const pctEl = document.getElementById('percentile-value');
  pctEl.textContent = `${percentile}th`;
  pctEl.style.color = color;
  document.getElementById('percentile-context').textContent =
    `vs ${windowLabel} history · ${lvl >= 1 ? 'tight (risk-on)' : 'wide (risk-off)'}`;

  renderChart(points, maPoints, HISTORY_DAYS);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

let allPoints = [];

async function loadAndRender() {
  allPoints = await loadFredCsv(CSV_PATH);
  applySignal(allPoints);
}

(async function main() {
  try {
    await loadAndRender();

    document.getElementById('maPeriodSelect').addEventListener('change', e => {
      MA_PERIOD = parseInt(e.target.value, 10);
      applySignal(allPoints);
    });

    document.getElementById('windowSelect').addEventListener('change', e => {
      WINDOW_DAYS = parseInt(e.target.value, 10);
      applySignal(allPoints);
    });

    document.getElementById('historySelect').addEventListener('change', e => {
      HISTORY_DAYS = parseInt(e.target.value, 10);
      applySignal(allPoints);
    });

  } catch (err) {
    document.getElementById('meta').textContent = `Error: ${err.message}`;
    console.error(err);
  }
})();
