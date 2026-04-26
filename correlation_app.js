// =============================================================================
// CONFIG
// =============================================================================

let HISTORY_DAYS = 504;

const CACHE_PATH = './data/cache/correlations.json';

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

const { LineSeries } = window.LightweightCharts;
const LC = window.LightweightCharts;

// =============================================================================
// DATA LOADING
// =============================================================================

async function loadCorrelations() {
  const r = await fetch(CACHE_PATH, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to fetch ${CACHE_PATH}: ${r.status}`);
  return r.json();
}

// =============================================================================
// SPARKLINE
// =============================================================================

function renderSparkline(pair, historyDays, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const history = ChartUtils.last(pair.history, historyDays);
  if (history.length < 2) return;

  const chart = ChartUtils.createDashboardChart(container, 160);

  // Zero reference line
  const zeroLine = chart.addSeries(LineSeries, {
    color: 'rgba(255,255,255,0.25)',
    lineWidth: 1,
    lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  zeroLine.setData(history.map(p => ({ time: p.date, value: 0 })));

  // ±0.5 reference lines
  const half = chart.addSeries(LineSeries, {
    color: 'rgba(255,255,255,0.12)',
    lineWidth: 1,
    lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  half.setData(history.map(p => ({ time: p.date, value: 0.5 })));

  const halfNeg = chart.addSeries(LineSeries, {
    color: 'rgba(255,255,255,0.12)',
    lineWidth: 1,
    lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  halfNeg.setData(history.map(p => ({ time: p.date, value: -0.5 })));

  // Short corr (muted)
  const shortSeries = chart.addSeries(LineSeries, {
    color: 'rgba(167,167,173,0.5)',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  shortSeries.setData(history.map(p => ({ time: p.date, value: p.short_corr })));

  // Primary corr (colored by regime)
  const regimeColor = REGIME_COLORS[pair.current.regime] || '#7aa2f7';
  const primarySeries = chart.addSeries(LineSeries, {
    color: regimeColor,
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: true,
  });
  primarySeries.setData(history.map(p => ({ time: p.date, value: p.primary_corr })));

  chart.applyOptions({
    rightPriceScale: {
      autoScale: false,
      minValue: -1,
      maxValue: 1,
    },
  });
  chart.priceScale('right').applyOptions({ autoScale: false });
  primarySeries.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: -1, maxValue: 1 } }) });

  ChartUtils.fitWithRightPadding(chart, history.length);

  const shortVal = pair.current.short_corr;
  const primaryVal = pair.current.primary_corr;
  ChartUtils.addChartLegend(containerId, [
    { label: '63d', color: regimeColor, value: primaryVal.toFixed(2) },
    { label: '20d', color: '#a7a7ad', value: shortVal.toFixed(2) },
  ]);
}

// =============================================================================
// CARD RENDERING
// =============================================================================

function renderPairCard(pair, historyDays) {
  const regime = pair.current.regime;
  const regimeColor = REGIME_COLORS[regime] || '#7aa2f7';
  const chartId = `chart-${pair.id}`;
  const regimeLabel = REGIME_LABELS[regime] || regime;

  const primaryVal = pair.current.primary_corr.toFixed(2);
  const shortVal = pair.current.short_corr.toFixed(2);
  const structMean = pair.current.structural_mean.toFixed(2);
  const structStd = pair.current.structural_std.toFixed(2);

  const expectedDir = pair.expectedSign === -1 ? 'inverse (−)' : 'positive (+)';
  const dominantDir = pair.dominantSign === -1 ? 'inverse (−)' : 'positive (+)';
  const dominantAvg = pair.dominantCorrMean != null ? pair.dominantCorrMean.toFixed(2) : '—';
  const dominantPct = pair.dominantPct != null ? pair.dominantPct.toFixed(1) : '—';
  const dominantYrs = pair.dominantBars != null ? (pair.dominantBars / 252).toFixed(1) + 'yr' : '—';
  const structNote = `Typical range over past year: ${structMean} ± ${structStd}`;

  const dsi = pair.current.days_since_intact;
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
        <div style="font-size:15px;font-weight:700;margin-bottom:2px">${pair.label}</div>
        <div class="muted" style="font-size:12px">${pair.subtitle}</div>
      </div>
      <span style="background:${regimeColor};color:#000;font-size:11px;font-weight:700;padding:3px 9px;border-radius:4px;white-space:nowrap;margin-left:12px">${regimeLabel}</span>
    </div>
    <div class="muted" style="font-size:11px;margin:8px 0 3px 0">${structNote}</div>
    <div class="muted" style="font-size:11px;margin-bottom:3px">Expected: ${expectedDir}</div>
    <div class="muted" style="font-size:11px;margin-bottom:3px">Data: ${dominantDir} · avg ${dominantAvg} · ${dominantPct}% pos · ${dominantYrs}</div>
    <div class="muted" style="font-size:11px;margin-bottom:8px">${sinceLine}</div>
    <div id="${chartId}" style="width:100%;height:160px"></div>
  `;

  return card;
}

// =============================================================================
// MAIN RENDER
// =============================================================================

function renderAll(data, historyDays) {
  const grid = document.getElementById('pairs-grid');
  grid.innerHTML = '';

  for (const pair of data.pairs) {
    const card = renderPairCard(pair, historyDays);
    grid.appendChild(card);
    renderSparkline(pair, historyDays, `chart-${pair.id}`);
  }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

(async function main() {
  try {
    const data = await loadCorrelations();

    const lastUpdated = await ChartUtils.loadLastUpdated();
    document.getElementById('meta').textContent =
      `Generated: ${data.generated} · ${data.pairs.length} pairs · Last updated: ${lastUpdated}`;

    renderAll(data, HISTORY_DAYS);

    document.getElementById('historySelect').addEventListener('change', e => {
      HISTORY_DAYS = parseInt(e.target.value, 10);
      renderAll(data, HISTORY_DAYS);
    });

  } catch (err) {
    document.getElementById('meta').textContent = `Error: ${err.message}`;
    console.error(err);
  }
}());
