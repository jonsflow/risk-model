// =============================================================================
// FED CHAIR TRANSITION DASHBOARD — fed_chair_app.js
// Powell (2018–2026) → Warsh (Expected 2026+)
// Client-side only — reads from fred_cache.json or individual CSVs
// =============================================================================

const FEDCHAIR_SERIES = [
  'WALCL', 'TREAST', 'MBST',
  'WRESBAL', 'RRPONTSYD',
  'FEDFUNDS', 'EFFR',
  'PCEPILFE', 'CPILFESL',
  'T10YIE', 'T5YIE',
  'T10Y2Y',
];

// Key era dates for chart markers
const ERA = {
  powellStart:   '2018-02-05',
  covidQE:       '2020-03-15',
  faitAdopted:   '2020-08-27',
  firstHike:     '2022-03-17',
  qtBegins:      '2022-06-01',
  firstCut:      '2024-09-19',
  faitAbandoned: '2025-08-22',
  warshHearing:  '2026-04-21',
};

const TIMELINE = [
  { date: '2018-02-05', event: 'Powell confirmed as Fed Chair',              context: 'Balance sheet ~$4.4T · Rate: 1.25–1.5%',             era: 'powell' },
  { date: '2019-07-31', event: 'First Powell-era cut (−25bps)',               context: 'Insurance cut; trade war concerns',                   era: 'powell' },
  { date: '2020-03-15', event: 'Emergency cuts to 0–0.25%; unlimited QE',    context: 'COVID shock; balance sheet begins surge toward $9T',  era: 'powell' },
  { date: '2020-08-27', event: 'FAIT adopted at Jackson Hole',                context: 'Warsh later calls this the direct cause of 2022 surge', era: 'powell' },
  { date: '2021-11-03', event: 'Taper announced; QE wind-down begins',       context: 'Balance sheet near $8.6T · CPI at 6.2%',             era: 'powell' },
  { date: '2022-03-17', event: 'First hike of cycle (+25bps)',                context: 'Rate: 0.25–0.5% · Headline CPI above 8%',            era: 'powell' },
  { date: '2022-06-01', event: 'QT begins ($47.5B/mo → $95B/mo cap)',        context: 'Drawdown starts from ~$9T peak',                      era: 'powell' },
  { date: '2023-07-27', event: 'Last hike: 5.25–5.5% (22-year high)',        context: 'Core PCE still ~4.2% at peak rate',                   era: 'powell' },
  { date: '2024-09-19', event: 'First cut of easing cycle (−50bps)',         context: 'Fed pivots; Core PCE still above 2%',                 era: 'powell' },
  { date: '2025-08-22', event: 'FAIT abandoned — strict 2% target restored', context: 'Jackson Hole 2025; ahead of Warsh era',               era: 'powell' },
  { date: '2026-04-21', event: 'Warsh Senate confirmation hearing',          context: '"QT for cuts" · eliminate dot plot · vows independence', era: 'warsh' },
];

const fedChairCharts = new Map();

// =============================================================================
// DATA LOADING
// =============================================================================

async function loadFedChairData() {
  try {
    const r = await fetch('./data/fred/fred_cache.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bundle = await r.json();
    const results = {};
    for (const id of FEDCHAIR_SERIES) {
      if (bundle.series?.[id]) {
        results[id] = bundle.series[id].map(([date, value]) => ({ date, value }));
      }
    }
    console.log(`FedChair: loaded from fred_cache.json (fetched ${bundle.fetched_at})`);
    return results;
  } catch (e) {
    console.warn(`fred_cache.json unavailable (${e.message}), falling back to individual CSVs`);
  }

  const results = {};
  await Promise.all(
    FEDCHAIR_SERIES.map(async (id) => {
      try {
        results[id] = await ChartUtils.loadFredCsv(`./data/fred/${id}.csv`);
      } catch (err) {
        console.warn(`Could not load ${id}: ${err.message}`);
        results[id] = null;
      }
    })
  );
  return results;
}

// =============================================================================
// HELPERS
// =============================================================================

function toChartPoints(points) {
  return points.map(p => ({ time: p.date, value: p.value }));
}

// Find the nearest existing data point to a target date.
// Handles both {date, value} and {time, value} formats.
function nearestDate(points, targetDate) {
  if (!points?.length) return null;
  const getKey = p => p.date ?? p.time;
  let best = points[0], bestDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(new Date(getKey(p)) - new Date(targetDate));
    if (diff < bestDiff) { bestDiff = diff; best = p; }
  }
  return getKey(best);
}

// YoY% from monthly index series using 12-position array offset.
function computeMonthlyYoY(points) {
  return points.slice(12).map((p, i) => ({
    date: p.date,
    value: +((p.value / points[i].value - 1) * 100).toFixed(2),
  }));
}

function nYearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

// =============================================================================
// CHART OVERLAY — vertical lines + shaded era regions
// Positioned using timeToCoordinate; re-renders on visible range change.
// =============================================================================

function addChartOverlay(chart, containerId, { regions = [], lines = [] } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const existing = container.querySelector('.era-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'era-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;overflow:hidden;z-index:1';
  container.appendChild(overlay);

  function render() {
    overlay.innerHTML = '';
    const ts = chart.timeScale();
    const w  = container.clientWidth;

    for (const r of regions) {
      let x1 = ts.timeToCoordinate(r.from) ?? 0;
      let x2 = ts.timeToCoordinate(r.to)   ?? w;
      x1 = Math.max(0, Math.round(x1));
      x2 = Math.min(w, Math.round(x2));
      if (x2 <= x1) continue;
      const div = document.createElement('div');
      div.style.cssText = `position:absolute;top:0;bottom:0;left:${x1}px;width:${x2 - x1}px;background:${r.color}`;
      overlay.appendChild(div);
    }

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i];
      const x = ts.timeToCoordinate(m.date);
      if (x === null || x < 0 || x > w) continue;
      const lx = Math.round(x);

      const line = document.createElement('div');
      line.style.cssText = `position:absolute;top:0;bottom:20px;left:${lx}px;width:1px;background:${m.color};opacity:0.7`;
      overlay.appendChild(line);

      const top = (i % 2 === 0) ? 4 : 18;
      const label = document.createElement('div');
      label.style.cssText = `position:absolute;top:${top}px;left:${lx + 3}px;font-size:10px;color:${m.color};white-space:nowrap;font-weight:600`;
      label.textContent = m.label;
      overlay.appendChild(label);
    }
  }

  chart.timeScale().subscribeVisibleTimeRangeChange(render);
  setTimeout(render, 50);
}

function destroyChart(id) {
  if (fedChairCharts.has(id)) {
    try { fedChairCharts.get(id).remove(); } catch (_) {}
    fedChairCharts.delete(id);
  }
}

function makeChart(containerId, height) {
  destroyChart(containerId);
  const el = document.getElementById(containerId);
  if (!el) return null;
  const chart = ChartUtils.createFomcChart(el, height);
  fedChairCharts.set(containerId, chart);
  return chart;
}

// =============================================================================
// SCORECARD
// =============================================================================

function renderScorecard(data) {
  const walcl    = data['WALCL'];
  const pcepilfe = data['PCEPILFE'];
  const t10yie   = data['T10YIE'];
  const t10y2y   = data['T10Y2Y'];

  const pceYoY = pcepilfe?.length >= 13 ? computeMonthlyYoY(pcepilfe) : null;

  const metrics = [
    {
      label: 'Fed Balance Sheet',
      raw: walcl?.length ? walcl[walcl.length - 1].value : null,
      display: v => `$${(v / 1_000_000).toFixed(2)}T`,
      warshTake: 'Too large — QT is the primary lever to reduce this',
      status(v) {
        const t = v / 1_000_000;
        if (t > 7.5) return { text: 'Very Elevated', color: '#ef4444' };
        if (t > 6.0) return { text: 'Elevated', color: '#f59e0b' };
        return { text: 'Declining', color: '#34d399' };
      },
    },
    {
      label: 'Core PCE (YoY%)',
      raw: pceYoY?.length ? pceYoY[pceYoY.length - 1].value : null,
      display: v => `${v.toFixed(1)}%`,
      warshTake: 'Strict 2% — no averaging, no overshoot tolerance',
      status(v) {
        if (v > 2.5) return { text: 'Above Target', color: '#ef4444' };
        if (v > 2.0) return { text: 'Slightly Above', color: '#f59e0b' };
        return { text: 'At Target', color: '#34d399' };
      },
    },
    {
      label: '10Y Breakeven',
      raw: t10yie?.length ? t10yie[t10yie.length - 1].value : null,
      display: v => `${v.toFixed(2)}%`,
      warshTake: 'Must stay anchored at 2% — de-anchoring = policy failure',
      status(v) {
        if (v > 2.7) return { text: 'De-Anchored', color: '#ef4444' };
        if (v > 2.3) return { text: 'Elevated', color: '#f59e0b' };
        return { text: 'Anchored', color: '#34d399' };
      },
    },
    {
      label: 'Yield Curve (10Y−2Y)',
      raw: t10y2y?.length ? t10y2y[t10y2y.length - 1].value : null,
      display: v => `${v.toFixed(2)}%`,
      warshTake: 'QT should steepen by unwinding QE-era term premium distortion',
      status(v) {
        if (v < -0.1) return { text: 'Inverted', color: '#ef4444' };
        if (v < 0.3)  return { text: 'Flat', color: '#f59e0b' };
        return { text: 'Normal Slope', color: '#34d399' };
      },
    },
  ];

  const container = document.getElementById('scorecard-container');
  if (!container) return;

  container.innerHTML = metrics.map(m => {
    if (m.raw === null) return `
      <div class="card">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">${m.label}</div>
        <div style="font-size:24px;font-weight:bold;margin-bottom:12px;color:#a7a7ad">—</div>
        <div class="muted" style="font-size:11px">${m.warshTake}</div>
      </div>`;

    const s = m.status(m.raw);
    const displayVal = m.display(m.raw);
    return `
      <div class="card">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">${m.label}</div>
        <div style="font-size:24px;font-weight:bold;margin-bottom:6px;color:${s.color}">${displayVal}</div>
        <div style="display:inline-block;background:${s.color}22;color:${s.color};font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;margin-bottom:10px">${s.text}</div>
        <div class="muted" style="font-size:11px;line-height:1.5">Warsh: ${m.warshTake}</div>
      </div>`;
  }).join('');
}

// =============================================================================
// TIMELINE TABLE
// =============================================================================

function renderTimeline() {
  const tbody = document.getElementById('timeline-tbody');
  if (!tbody) return;

  tbody.innerHTML = TIMELINE.map(ev => {
    const isWarsh = ev.era === 'warsh';
    return `
      <tr style="border-bottom:1px solid #1e1e2e">
        <td style="padding:6px 8px;white-space:nowrap;color:${isWarsh ? '#f97316' : '#a7a7ad'};font-size:12px">${ev.date}</td>
        <td style="padding:6px 8px;color:${isWarsh ? '#f97316' : '#e9e9ea'}">${ev.event}</td>
        <td style="padding:6px 8px;color:#a7a7ad;font-size:12px">${ev.context}</td>
      </tr>`;
  }).join('');
}

// =============================================================================
// CHART 1: Balance Sheet — full history with era markers
// =============================================================================

function renderBalanceSheetChart(data) {
  const walcl  = data['WALCL'];
  const treast = data['TREAST'];
  const mbst   = data['MBST'];
  if (!walcl?.length) return;

  // WALCL, TREAST, MBST all in millions → convert to $B
  const toB = pts => pts.map(p => ({ time: p.date, value: +(p.value / 1000).toFixed(1) }));

  const chart = makeChart('chart-balance-sheet', 300);
  if (!chart) return;

  chart.applyOptions({
    handleScroll: { pressedMouseMove: true, horzTouchDrag: true, mouseWheel: false },
  });

  const totalArea = chart.addSeries(LightweightCharts.AreaSeries, {
    lineColor: ChartUtils.colors.balSheet,
    topColor: ChartUtils.hexToRgba(ChartUtils.colors.balSheet, 0.25),
    bottomColor: ChartUtils.hexToRgba(ChartUtils.colors.balSheet, 0),
    lineWidth: 2,
    priceLineVisible: true,
    priceLineStyle: LightweightCharts.LineStyle.Dashed,
    lastValueVisible: true,
  });
  totalArea.setData(toB(walcl));

  if (treast?.length >= 2) {
    const tLine = chart.addSeries(LightweightCharts.LineSeries, {
      color: ChartUtils.colors.sofr,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    tLine.setData(toB(treast));
  }

  if (mbst?.length >= 2) {
    const mLine = chart.addSeries(LightweightCharts.LineSeries, {
      color: ChartUtils.colors.mbs,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    mLine.setData(toB(mbst));
  }

  const lastW = walcl[walcl.length - 1];
  const entries = [
    { label: 'Total Assets', color: ChartUtils.colors.balSheet, value: `$${(lastW.value / 1000).toFixed(0)}B` },
  ];
  if (treast?.length) entries.push({ label: 'Treasuries', color: ChartUtils.colors.sofr, value: `$${(treast[treast.length-1].value / 1000).toFixed(0)}B` });
  if (mbst?.length)   entries.push({ label: 'MBS',        color: ChartUtils.colors.mbs,  value: `$${(mbst[mbst.length-1].value / 1000).toFixed(0)}B` });
  ChartUtils.addChartLegend('chart-balance-sheet', entries);

  ChartUtils.fitWithRightPadding(chart, walcl.length, 0.04);

  addChartOverlay(chart, 'chart-balance-sheet', {
    regions: [
      { from: ERA.powellStart,  to: ERA.warshHearing, color: 'rgba(122,162,247,0.05)' },
      { from: ERA.warshHearing, to: '2030-01-01',     color: 'rgba(249,115,22,0.05)'  },
    ],
    lines: [
      { date: ERA.covidQE,      label: 'COVID QE', color: '#ef4444' },
      { date: ERA.qtBegins,     label: 'QT',       color: '#34d399' },
      { date: ERA.warshHearing, label: 'Warsh',    color: '#f97316' },
    ],
  });
}

// =============================================================================
// CHART 2: Inflation vs strict 2% target (YoY%)
// =============================================================================

function renderInflationChart(data) {
  const pcepilfe = data['PCEPILFE'];
  const cpilfesl = data['CPILFESL'];

  const pceYoY = pcepilfe?.length >= 13 ? computeMonthlyYoY(pcepilfe) : [];
  const cpiYoY = cpilfesl?.length >= 13 ? computeMonthlyYoY(cpilfesl) : [];
  if (!pceYoY.length && !cpiYoY.length) return;

  const chart = makeChart('chart-inflation', 260);
  if (!chart) return;

  const pceColor = '#7aa2f7';
  const cpiColor = '#34d399';

  if (pceYoY.length >= 2) {
    const pceLine = chart.addSeries(LightweightCharts.LineSeries, {
      color: pceColor,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    pceLine.setData(toChartPoints(pceYoY));
  }

  if (cpiYoY.length >= 2) {
    const cpiLine = chart.addSeries(LightweightCharts.LineSeries, {
      color: cpiColor,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    cpiLine.setData(toChartPoints(cpiYoY));
  }

  // 2% hard target reference line
  const refData = pceYoY.length ? pceYoY : cpiYoY;
  const targetLine = chart.addSeries(LightweightCharts.LineSeries, {
    color: '#ef4444',
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  targetLine.setData([
    { time: refData[0].date, value: 2.0 },
    { time: refData[refData.length - 1].date, value: 2.0 },
  ]);

  const entries = [];
  if (pceYoY.length) entries.push({ label: 'Core PCE', color: pceColor, value: `${pceYoY[pceYoY.length-1].value.toFixed(1)}%` });
  if (cpiYoY.length) entries.push({ label: 'Core CPI', color: cpiColor, value: `${cpiYoY[cpiYoY.length-1].value.toFixed(1)}%` });
  entries.push({ label: 'Target', color: '#ef4444', value: '2.0%' });
  ChartUtils.addChartLegend('chart-inflation', entries);

  ChartUtils.fitWithRightPadding(chart, Math.max(pceYoY.length, cpiYoY.length), 0.04);

  addChartOverlay(chart, 'chart-inflation', {
    lines: [
      { date: ERA.firstHike,     label: 'Hike',      color: '#ef4444' },
      { date: ERA.faitAbandoned, label: 'FAIT end',  color: '#f59e0b' },
      { date: ERA.warshHearing,  label: 'Warsh',     color: '#f97316' },
    ],
  });
}

// =============================================================================
// CHART 3: Breakeven inflation vs 2% anchor
// =============================================================================

function renderBreakevenChart(data) {
  const t10yie = data['T10YIE'];
  const t5yie  = data['T5YIE'];
  if (!t10yie?.length) return;

  const chart = makeChart('chart-breakevens', 260);
  if (!chart) return;

  const c10 = '#7aa2f7';
  const c5  = '#2dd4bf';

  const line10 = chart.addSeries(LightweightCharts.LineSeries, {
    color: c10,
    lineWidth: 2,
    priceLineVisible: true,
    priceLineStyle: LightweightCharts.LineStyle.Dashed,
    lastValueVisible: true,
  });
  line10.setData(toChartPoints(t10yie));

  if (t5yie?.length >= 2) {
    const line5 = chart.addSeries(LightweightCharts.LineSeries, {
      color: c5,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    line5.setData(toChartPoints(t5yie));
  }

  // 2% anchor reference
  const anchor = chart.addSeries(LightweightCharts.LineSeries, {
    color: '#ef4444',
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  anchor.setData([
    { time: t10yie[0].date, value: 2.0 },
    { time: t10yie[t10yie.length - 1].date, value: 2.0 },
  ]);

  const entries = [
    { label: '10Y BEI', color: c10, value: `${t10yie[t10yie.length-1].value.toFixed(2)}%` },
  ];
  if (t5yie?.length) entries.push({ label: '5Y BEI', color: c5, value: `${t5yie[t5yie.length-1].value.toFixed(2)}%` });
  entries.push({ label: 'Anchor', color: '#ef4444', value: '2.0%' });
  ChartUtils.addChartLegend('chart-breakevens', entries);

  ChartUtils.fitWithRightPadding(chart, t10yie.length, 0.04);

  addChartOverlay(chart, 'chart-breakevens', {
    lines: [
      { date: ERA.firstHike,    label: 'Hike',  color: '#ef4444' },
      { date: ERA.warshHearing, label: 'Warsh', color: '#f97316' },
    ],
  });
}

// =============================================================================
// CHART 4: Rate history — FEDFUNDS + EFFR splice with era markers
// =============================================================================

function renderRateChart(data) {
  const fedfunds = data['FEDFUNDS'] || [];
  const effr     = data['EFFR']     || [];

  const effrStart = effr.length ? effr[0].date : '2099-01-01';
  const pre     = fedfunds.filter(p => p.date < effrStart).map(p => ({ time: p.date, value: p.value }));
  const post    = toChartPoints(effr);
  const combined = [...pre, ...post];
  if (combined.length < 2) return;

  const chart = makeChart('chart-rates', 260);
  if (!chart) return;

  chart.applyOptions({
    handleScroll: { pressedMouseMove: true, horzTouchDrag: true, mouseWheel: false },
  });

  const area = chart.addSeries(LightweightCharts.AreaSeries, {
    lineColor: ChartUtils.colors.rate,
    topColor: ChartUtils.hexToRgba(ChartUtils.colors.rate, 0.3),
    bottomColor: ChartUtils.hexToRgba(ChartUtils.colors.rate, 0.02),
    lineWidth: 2,
    priceLineVisible: true,
    priceLineStyle: LightweightCharts.LineStyle.Dashed,
    lastValueVisible: true,
  });
  area.setData(combined);

  const lastVal = combined[combined.length - 1].value;
  ChartUtils.addChartLegend('chart-rates', [
    { label: 'EFFR', color: ChartUtils.colors.rate, value: `${lastVal.toFixed(2)}%` },
  ]);

  const viewFrom = '2008-01-01';
  const visibleBars = combined.filter(p => p.time >= viewFrom).length;
  chart.timeScale().applyOptions({ rightOffset: Math.ceil(visibleBars * 0.04) });
  chart.timeScale().setVisibleRange({ from: viewFrom, to: combined[combined.length - 1].time });

  addChartOverlay(chart, 'chart-rates', {
    regions: [
      { from: ERA.powellStart,  to: ERA.warshHearing, color: 'rgba(122,162,247,0.05)' },
      { from: ERA.warshHearing, to: '2030-01-01',     color: 'rgba(249,115,22,0.05)'  },
    ],
    lines: [
      { date: ERA.faitAdopted,  label: 'FAIT',  color: '#f59e0b' },
      { date: ERA.firstHike,    label: 'Hike',  color: '#ef4444' },
      { date: ERA.firstCut,     label: 'Cut',   color: '#34d399' },
      { date: ERA.warshHearing, label: 'Warsh', color: '#f97316' },
    ],
  });
}

// =============================================================================
// CHART 5: Reserve Balances + O/N RRP — last 5 years only
// =============================================================================

function renderReservesChart(data) {
  const wresbal   = data['WRESBAL'];
  const rrpontsyd = data['RRPONTSYD'];
  if (!wresbal?.length) return;

  const cutoff = nYearsAgo(5);
  const resFiltered = wresbal.filter(p => p.date >= cutoff);
  const rrpFiltered = rrpontsyd?.filter(p => p.date >= cutoff) ?? [];

  if (resFiltered.length < 2) return;

  const chart = makeChart('chart-reserves', 260);
  if (!chart) return;

  const resArea = chart.addSeries(LightweightCharts.AreaSeries, {
    lineColor: ChartUtils.colors.reserves,
    topColor: ChartUtils.hexToRgba(ChartUtils.colors.reserves, 0.3),
    bottomColor: ChartUtils.hexToRgba(ChartUtils.colors.reserves, 0.02),
    lineWidth: 2,
    priceLineVisible: true,
    priceLineStyle: LightweightCharts.LineStyle.Dashed,
    lastValueVisible: true,
  });
  resArea.setData(toChartPoints(resFiltered));

  if (rrpFiltered.length >= 2) {
    const rrpLine = chart.addSeries(LightweightCharts.LineSeries, {
      color: ChartUtils.colors.rrp,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    rrpLine.setData(toChartPoints(rrpFiltered));
  }

  const entries = [
    { label: 'Reserve Balances', color: ChartUtils.colors.reserves, value: `$${Math.round(resFiltered[resFiltered.length-1].value)}B` },
  ];
  if (rrpFiltered.length) entries.push({
    label: 'O/N RRP',
    color: ChartUtils.colors.rrp,
    value: `$${Math.round(rrpFiltered[rrpFiltered.length-1].value)}B`,
  });
  ChartUtils.addChartLegend('chart-reserves', entries);

  ChartUtils.fitWithRightPadding(chart, resFiltered.length, 0.04);
}

// =============================================================================
// META
// =============================================================================

function renderMeta(data) {
  const effr  = data['EFFR'];
  const walcl = data['WALCL'];
  const parts = [];
  if (effr?.length)  parts.push(`EFFR as of ${effr[effr.length - 1].date}`);
  if (walcl?.length) parts.push(`balance sheet as of ${walcl[walcl.length - 1].date}`);
  const el = document.getElementById('meta');
  if (el) el.textContent = parts.length ? parts.join(' · ') : 'Data loaded';
}

// =============================================================================
// MAIN
// =============================================================================

async function init() {
  try {
    const data = await loadFedChairData();
    renderMeta(data);
    renderScorecard(data);
    renderTimeline();

    for (const [fn, args] of [
      [renderBalanceSheetChart, [data]],
      [renderInflationChart,    [data]],
      [renderBreakevenChart,    [data]],
      [renderRateChart,         [data]],
      [renderReservesChart,     [data]],
    ]) {
      try { fn(...args); } catch (e) { console.error(`${fn.name}:`, e); }
    }
  } catch (err) {
    console.error('FedChair init error:', err);
    const el = document.getElementById('meta');
    if (el) el.textContent = `Error: ${err.message}`;
  }
}

init();
