// js/pages/credit.js — Credit Spread page (ES module).
// Thin orchestrator: imports from core/ and components/, contains only
// layout assembly and data wiring specific to this page.

import { renderNav }            from '../components/Navigation.js';
import { fetchFredBundle }      from '../core/api.js';
import { calculateMA, fmt }     from '../core/utils.js';
import { createDashboardChart, fitWithRightPadding, addChartLegend, hexToRgba, computePercentile, colors } from '../core/chart-utils.js';

const LC = window.LightweightCharts;

const SERIES_ID = 'BAMLH0A0HYM2';

let state = {
  maPeriod:    20,
  windowDays:  756,
  historyDays: 504,
  allPoints:   [],
};

// ------------------------------------------------------------------
// Analysis (stateless, same logic as credit_app.js)
// ------------------------------------------------------------------

function levelScore(percentile) {
  if (percentile <= 25) return  2;
  if (percentile <= 50) return  1;
  if (percentile <= 75) return -1;
  return -2;
}

function momentumScore(current, ma) {
  return current < ma ? 1 : -1;
}

function signalLabel(score) {
  if (score >=  3) return { label: '🟢 STRONG RISK ON',  color: colors.signalStrongOn };
  if (score >=  1) return { label: '🟡 RISK ON',         color: colors.signalOn };
  if (score === 0) return { label: '⚪ NEUTRAL',          color: colors.signalNeutral };
  if (score >= -2) return { label: '🟠 RISK OFF',         color: colors.signalOff };
  return               { label: '🔴 STRONG RISK OFF',    color: colors.signalStrongOff };
}

// ------------------------------------------------------------------
// Chart
// ------------------------------------------------------------------

let _chart = null;

function renderChart(points, maPoints) {
  const container = document.getElementById('chart-credit');
  if (!container) return;
  container.innerHTML = '';

  const { historyDays, maPeriod } = state;
  const recent = points.slice(-historyDays);
  const startDate = recent[0]?.date;
  const recentMa = maPoints.filter(p => p.date >= startDate);

  _chart = createDashboardChart(container, 300);

  const area = _chart.addSeries(LC.AreaSeries, {
    lineColor: colors.credit,
    topColor: hexToRgba(colors.credit, 0.3),
    bottomColor: hexToRgba(colors.credit, 0),
    lineWidth: 2,
    priceLineVisible: true,
    priceLineStyle: LC.LineStyle.Dashed,
    lastValueVisible: true,
  });
  area.setData(recent.map(p => ({ time: p.date, value: p.value })));

  if (recentMa.length) {
    const maSeries = _chart.addSeries(LC.LineSeries, {
      color: '#ffffff', lineWidth: 1, lineStyle: 4,
      priceLineVisible: false, lastValueVisible: true,
    });
    maSeries.setData(recentMa.map(p => ({ time: p.date, value: p.value })));
  }

  fitWithRightPadding(_chart, recent.length);

  const lastSpread = recent.at(-1).value;
  const entries = [{ label: 'HY OAS', color: colors.credit, value: `${lastSpread.toFixed(2)}%` }];
  if (recentMa.length) {
    entries.push({ label: `${maPeriod}d MA`, color: '#ffffff', value: `${recentMa.at(-1).value.toFixed(2)}%` });
  }
  addChartLegend('chart-credit', entries);
}

// ------------------------------------------------------------------
// DOM rendering
// ------------------------------------------------------------------

function applySignal(points) {
  const { maPeriod, windowDays } = state;
  if (points.length < maPeriod + 1) {
    document.getElementById('meta').textContent = 'Not enough data.';
    return;
  }

  const maPoints   = computeMA_credit(points, maPeriod);
  const current    = points.at(-1);
  const currentMa  = maPoints.at(-1);
  const percentile = computePercentile(points, current.value, windowDays);
  const lvl        = levelScore(percentile);
  const mom        = momentumScore(current.value, currentMa.value);
  const score      = lvl + mom;
  const { label, color } = signalLabel(score);
  const direction  = current.value < currentMa.value ? 'tightening ↘' : 'widening ↗';
  const windowLabel = windowDays === 252 ? '1yr' : windowDays === 756 ? '3yr' : '5yr';

  document.getElementById('meta').textContent = `Series: ${SERIES_ID} · As of ${current.date}`;

  const sigEl = document.getElementById('signal-label');
  sigEl.textContent = label;
  sigEl.style.color = color;
  document.getElementById('signal-score').textContent =
    `Level: ${lvl > 0 ? '+' : ''}${lvl}  ·  Momentum: ${mom > 0 ? '+' : ''}${mom}  ·  Total: ${score > 0 ? '+' : ''}${score}`;

  const valEl = document.getElementById('current-value');
  valEl.textContent = `${current.value.toFixed(2)}%`;
  valEl.style.color = color;
  document.getElementById('current-ma').textContent =
    `${maPeriod}-day MA: ${currentMa.value.toFixed(2)}% · ${direction}`;

  const pctEl = document.getElementById('percentile-value');
  pctEl.textContent = `${percentile}th`;
  pctEl.style.color = color;
  document.getElementById('percentile-context').textContent =
    `Spreads tighter than today ${percentile}% of the past ${windowLabel}`;

  renderChart(points, maPoints);
}

function computeMA_credit(points, period) {
  const result = [];
  for (let i = period - 1; i < points.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += points[i - j].value;
    result.push({ date: points[i].date, value: sum / period });
  }
  return result;
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

async function init() {
  renderNav();
  try {
    const bundle = await fetchFredBundle();
    const raw = bundle.series?.[SERIES_ID] ?? [];
    state.allPoints = raw.map(([date, value]) => ({ date, value }));
    applySignal(state.allPoints);

    document.getElementById('maPeriodSelect')?.addEventListener('change', e => {
      state.maPeriod = parseInt(e.target.value, 10);
      applySignal(state.allPoints);
    });
    document.getElementById('windowSelect')?.addEventListener('change', e => {
      state.windowDays = parseInt(e.target.value, 10);
      applySignal(state.allPoints);
    });
    document.getElementById('historySelect')?.addEventListener('change', e => {
      state.historyDays = parseInt(e.target.value, 10);
      applySignal(state.allPoints);
    });
  } catch (err) {
    const meta = document.getElementById('meta');
    if (meta) meta.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
