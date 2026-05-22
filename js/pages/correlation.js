// js/pages/correlation.js — Cross-Asset Correlation page (ES module).
import { renderNav }                                          from '../components/Navigation.js';
import { fetchCorrelations, fetchCache }                      from '../core/api.js';
import {
  createDashboardChart, fitWithRightPadding, addChartLegend,
  hexToRgba, last, computePercentile,
} from '../core/chart-utils.js';

const LC = window.LightweightCharts;

let HISTORY_DAYS = 504;

const REGIME_COLORS = {
  NORMAL:    '#7aa2f7',
  WEAKENING: '#f59e0b',
  BROKEN:    '#f97316',
};

const REGIME_LABELS = {
  NORMAL:    'INTACT',
  WEAKENING: 'DECOUPLING',
  BROKEN:    'BROKEN',
};

function renderSparkline(pair, historyDays, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const history = last(pair.history, historyDays);
  if (history.length < 2) return;

  const chart = createDashboardChart(container, 160);

  const zeroLine = chart.addSeries(LC.LineSeries, {
    color: 'rgba(255,255,255,0.25)', lineWidth: 1,
    lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  zeroLine.setData(history.map(p => ({ time: p.date, value: 0 })));

  const half = chart.addSeries(LC.LineSeries, {
    color: 'rgba(255,255,255,0.12)', lineWidth: 1,
    lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  half.setData(history.map(p => ({ time: p.date, value: 0.5 })));

  const halfNeg = chart.addSeries(LC.LineSeries, {
    color: 'rgba(255,255,255,0.12)', lineWidth: 1,
    lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  halfNeg.setData(history.map(p => ({ time: p.date, value: -0.5 })));

  const shortSeries = chart.addSeries(LC.LineSeries, {
    color: 'rgba(167,167,173,0.5)', lineWidth: 1,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  shortSeries.setData(history.map(p => ({ time: p.date, value: p.short_corr })));

  const regimeColor = REGIME_COLORS[pair.current.regime] || '#7aa2f7';
  const primarySeries = chart.addSeries(LC.LineSeries, {
    color: regimeColor, lineWidth: 2,
    priceLineVisible: false, lastValueVisible: true,
  });
  primarySeries.setData(history.map(p => ({ time: p.date, value: p.primary_corr })));

  chart.applyOptions({ rightPriceScale: { autoScale: false, minValue: -1, maxValue: 1 } });
  chart.priceScale('right').applyOptions({ autoScale: false });
  primarySeries.applyOptions({
    autoscaleInfoProvider: () => ({ priceRange: { minValue: -1, maxValue: 1 } }),
  });

  fitWithRightPadding(chart, history.length);

  addChartLegend(containerId, [
    { label: '63d', color: regimeColor, value: pair.current.primary_corr.toFixed(2) },
    { label: '20d', color: '#a7a7ad',   value: pair.current.short_corr.toFixed(2) },
  ]);
}

function renderPairCard(pair, historyDays) {
  const regime      = pair.current.regime;
  const regimeColor = REGIME_COLORS[regime] || '#7aa2f7';
  const chartId     = `chart-${pair.id}`;
  const regimeLabel = REGIME_LABELS[regime] || regime;

  const primaryVal  = pair.current.primary_corr.toFixed(2);
  const shortVal    = pair.current.short_corr.toFixed(2);
  const structMean  = pair.current.structural_mean.toFixed(2);
  const structStd   = pair.current.structural_std.toFixed(2);

  const expectedDir  = pair.expectedSign === -1 ? 'inverse (−)' : 'positive (+)';
  const dominantDir  = pair.dominantSign  === -1 ? 'inverse (−)' : 'positive (+)';
  const dominantAvg  = pair.dominantCorrMean != null ? pair.dominantCorrMean.toFixed(2) : '—';
  const dominantPct  = pair.dominantPct   != null ? pair.dominantPct.toFixed(1)   : '—';
  const dominantYrs  = pair.dominantBars  != null ? (pair.dominantBars / 252).toFixed(1) + 'yr' : '—';
  const structNote   = `Typical range over past year: ${structMean} ± ${structStd}`;

  const currentSign  = pair.current.primary_corr >= 0 ? 1 : -1;
  const currentDir   = currentSign === -1 ? 'inverse (−)' : 'positive (+)';
  const currentColor = regime === 'NORMAL' ? '#7aa2f7' : regime === 'WEAKENING' ? '#f59e0b' : '#f97316';

  const dsi      = pair.current.days_since_intact;
  const sinceLine = regime === 'NORMAL'
    ? 'Currently intact'
    : dsi === null
      ? 'Not intact within available history'
      : `Last intact: ${dsi} day${dsi !== 1 ? 's' : ''} ago`;

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
      <div>
        <div style="font-size:15px;font-weight:700;margin-bottom:2px">${pair.label} <span style="font-size:12px;font-weight:400;color:#a7a7ad">${pair.asset1.label} / ${pair.asset2.label}</span></div>
        <div class="muted" style="font-size:12px">${pair.subtitle}</div>
      </div>
      <span style="background:${regimeColor};color:#000;font-size:11px;font-weight:700;padding:3px 9px;border-radius:4px;white-space:nowrap;margin-left:12px">${regimeLabel}</span>
    </div>
    <div class="muted" style="font-size:11px;margin:8px 0 3px 0">${structNote}</div>
    <div class="muted" style="font-size:11px;margin-bottom:3px">Expected: ${expectedDir} · Historical norm: ${dominantDir} · avg ${dominantAvg} · ${dominantPct}% pos · ${dominantYrs}</div>
    <div style="font-size:11px;font-weight:600;color:${currentColor};margin-bottom:3px">Currently: ${currentDir} (63d: ${primaryVal} · 20d: ${shortVal})</div>
    <div class="muted" style="font-size:11px;margin-bottom:8px">${sinceLine}</div>
    <div id="${chartId}" style="width:100%;height:160px"></div>
  `;

  return card;
}

function renderAll(data, historyDays) {
  const grid = document.getElementById('pairs-grid');
  grid.innerHTML = '';
  for (const pair of data.pairs) {
    const card = renderPairCard(pair, historyDays);
    grid.appendChild(card);
    renderSparkline(pair, historyDays, `chart-${pair.id}`);
  }
}

async function init() {
  renderNav();
  try {
    const [data, config] = await Promise.all([
      fetchCorrelations(),
      fetchCache('correlation_config.json').catch(() => null),
    ]);

    if (config) {
      const signMap = Object.fromEntries(config.pairs.map(p => [p.id, p.expectedSign]));
      for (const pair of data.pairs) {
        if (signMap[pair.id] !== undefined) pair.expectedSign = signMap[pair.id];
      }
    }

    const metaEl = document.getElementById('meta');
    if (metaEl) {
      metaEl.textContent = `Generated: ${data.generated} · ${data.pairs.length} pairs`;
    }

    renderAll(data, HISTORY_DAYS);

    document.getElementById('historySelect')?.addEventListener('change', e => {
      HISTORY_DAYS = parseInt(e.target.value, 10);
      renderAll(data, HISTORY_DAYS);
    });
  } catch (err) {
    const metaEl = document.getElementById('meta');
    if (metaEl) metaEl.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
