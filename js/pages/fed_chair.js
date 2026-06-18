// js/pages/fed_chair.js — Fed Chair Transition Dashboard (ES module).
import { renderNav }       from '../components/Navigation.js';
import { fetchFredBundle } from '../core/api.js';
import {
  createFomcChart, fitWithRightPadding, addChartLegend, hexToRgba, colors,
} from '../core/chart-utils.js';

const LC = window.LightweightCharts;

const FEDCHAIR_SERIES = [
  'WALCL', 'TREAST', 'WSHOMCB',
  'WRESBAL', 'RRPONTSYD',
  'FEDFUNDS', 'EFFR',
  'PCEPILFE', 'CPILFESL',
  'T10YIE', 'T5YIE',
  'T10Y2Y',
];

const CHART_START = '2007-01-01';

const ERA = {
  powellStart:    '2018-02-05',
  covidQE:        '2020-03-15',
  faitAdopted:    '2020-08-27',
  firstHike:      '2022-03-17',
  qtBegins:       '2022-06-01',
  firstCut:       '2024-09-19',
  faitAbandoned:  '2025-08-22',
  warshHearing:   '2026-04-21',
  powellLastFomc: '2026-04-29',
  warshConfirmed: '2026-05-13',
  warshFirstFomc: '2026-06-17',
};

const TIMELINE = [
  { date: '2018-02-05', event: 'Powell confirmed as Fed Chair',              context: 'Balance sheet ~$4.4T · Rate: 1.25–1.5%',              era: 'powell' },
  { date: '2019-07-31', event: 'First Powell-era cut (−25bps)',               context: 'Insurance cut; trade war concerns',                    era: 'powell' },
  { date: '2020-03-15', event: 'Emergency cuts to 0–0.25%; unlimited QE',    context: 'COVID shock; balance sheet begins surge toward $9T',   era: 'powell' },
  { date: '2020-08-27', event: 'FAIT adopted at Jackson Hole',                context: 'Warsh later calls this the direct cause of 2022 surge', era: 'powell' },
  { date: '2021-11-03', event: 'Taper announced; QE wind-down begins',       context: 'Balance sheet near $8.6T · CPI at 6.2%',              era: 'powell' },
  { date: '2022-03-17', event: 'First hike of cycle (+25bps)',                context: 'Rate: 0.25–0.5% · Headline CPI above 8%',             era: 'powell' },
  { date: '2022-06-01', event: 'QT begins ($47.5B/mo → $95B/mo cap)',        context: 'Drawdown starts from ~$9T peak',                       era: 'powell' },
  { date: '2023-07-27', event: 'Last hike: 5.25–5.5% (22-year high)',        context: 'Core PCE still ~4.2% at peak rate',                    era: 'powell' },
  { date: '2024-09-19', event: 'First cut of easing cycle (−50bps)',         context: 'Fed pivots; Core PCE still above 2%',                  era: 'powell' },
  { date: '2025-08-22', event: 'FAIT abandoned — strict 2% target restored', context: 'Jackson Hole 2025; ahead of Warsh era',                era: 'powell' },
  { date: '2026-04-21', event: 'Warsh Senate confirmation hearing',          context: '"QT for cuts" · eliminate dot plot · vows independence', era: 'warsh' },
  { date: '2026-04-29', event: "Powell's last FOMC meeting",                 context: 'Rates held 3.50–3.75%. Final meeting under Powell.',      era: 'powell' },
  { date: '2026-05-13', event: 'Warsh confirmed as Fed Chair',               context: 'Senate confirmation vote. Powell remains on Board of Governors.', era: 'warsh' },
  { date: '2026-06-17', event: 'Warsh first FOMC: rates held, statement overhaul', context: 'Held 3.50–3.75% (12-0). Statement cut to ~130 words, forward guidance removed. Dot plot: 9/18 project ≥1 hike. Five task forces announced.', era: 'warsh' },
];

const fedChairCharts = new Map();

function toChartPoints(points) {
  return points.map(p => ({ time: p.date, value: p.value }));
}

function nYearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

function computeMonthlyYoY(points) {
  return points.slice(12).map((p, i) => ({
    date:  p.date,
    value: +((p.value / points[i].value - 1) * 100).toFixed(2),
  }));
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
  const chart = createFomcChart(el, height);
  fedChairCharts.set(containerId, chart);
  return chart;
}

// ------------------------------------------------------------------
// Era overlay — vertical region bands + line markers
// ------------------------------------------------------------------

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

  function coordFor(ts, dateStr) {
    const c = ts.timeToCoordinate(dateStr);
    if (c !== null) return c;
    const base = new Date(dateStr);
    for (let d = 1; d <= 14; d++) {
      for (const sign of [1, -1]) {
        const t = new Date(base);
        t.setDate(t.getDate() + sign * d);
        const iso = t.toISOString().slice(0, 10);
        const v   = ts.timeToCoordinate(iso);
        if (v !== null) return v;
      }
    }
    return null;
  }

  function render() {
    const w = container.clientWidth;
    if (!w) return;
    overlay.innerHTML = '';
    const ts = chart.timeScale();

    for (const r of regions) {
      let x1 = coordFor(ts, r.from) ?? 0;
      let x2 = coordFor(ts, r.to)   ?? w;
      x1 = Math.max(0, Math.round(x1));
      x2 = Math.min(w, Math.round(x2));
      if (x2 <= x1) continue;
      const div = document.createElement('div');
      div.style.cssText = `position:absolute;top:0;bottom:0;left:${x1}px;width:${x2 - x1}px;background:${r.color}`;
      overlay.appendChild(div);
    }

    for (let i = 0; i < lines.length; i++) {
      const m  = lines[i];
      const x  = coordFor(ts, m.date);
      if (x === null || x < 0 || x > w) continue;
      const lx = Math.round(x);

      const line = document.createElement('div');
      line.style.cssText = `position:absolute;top:0;bottom:34px;left:${lx}px;width:1px;background:${m.color};opacity:0.7`;
      overlay.appendChild(line);

      const label = document.createElement('div');
      label.style.cssText = `position:absolute;bottom:20px;left:${lx}px;transform:translateX(-50%);font-size:10px;color:${m.color};white-space:nowrap;font-weight:600`;
      label.textContent = m.label;
      overlay.appendChild(label);
    }
  }

  chart.timeScale().subscribeVisibleTimeRangeChange(render);
  new ResizeObserver(() => requestAnimationFrame(render)).observe(container);
}

// ------------------------------------------------------------------
// Scorecard
// ------------------------------------------------------------------

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
      display: v => `$${(v / 1_000_000).toFixed(2)}T → target ~$4.2T (gap: $${((v / 1_000_000) - 4.2).toFixed(2)}T)`,
      warshTake: 'Pre-COVID level (~$4.2T) is the implicit floor — accelerating QT is his primary lever',
      status(v) {
        const t = v / 1_000_000;
        if (t > 7.5) return { text: 'Very Elevated', color: '#ef4444' };
        if (t > 6.0) return { text: 'Elevated',      color: '#f59e0b' };
        return              { text: 'Declining',      color: '#34d399' };
      },
    },
    {
      label: 'Core PCE (YoY%)',
      raw: pceYoY?.length ? pceYoY[pceYoY.length - 1].value : null,
      display: v => `${v.toFixed(1)}%`,
      warshTake: 'Strict 2% — no averaging, no overshoot tolerance',
      status(v) {
        if (v > 2.5) return { text: 'Above Target',   color: '#ef4444' };
        if (v > 2.0) return { text: 'Slightly Above', color: '#f59e0b' };
        return              { text: 'At Target',       color: '#34d399' };
      },
    },
    {
      label: '10Y Breakeven',
      raw: t10yie?.length ? t10yie[t10yie.length - 1].value : null,
      display: v => `${v.toFixed(2)}%`,
      warshTake: 'Must stay anchored at 2% — de-anchoring = policy failure',
      status(v) {
        if (v > 2.7) return { text: 'De-Anchored', color: '#ef4444' };
        if (v > 2.3) return { text: 'Elevated',    color: '#f59e0b' };
        return              { text: 'Anchored',     color: '#34d399' };
      },
    },
    {
      label: 'Yield Curve (10Y−2Y)',
      raw: t10y2y?.length ? t10y2y[t10y2y.length - 1].value : null,
      display: v => `${v.toFixed(2)}%`,
      warshTake: 'QT should steepen by unwinding QE-era term premium distortion',
      status(v) {
        if (v < -0.1) return { text: 'Inverted',     color: '#ef4444' };
        if (v < 0.3)  return { text: 'Flat',          color: '#f59e0b' };
        return               { text: 'Normal Slope', color: '#34d399' };
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
    return `
      <div class="card">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">${m.label}</div>
        <div style="font-size:24px;font-weight:bold;margin-bottom:6px;color:${s.color}">${m.display(m.raw)}</div>
        <div style="display:inline-block;background:${s.color}22;color:${s.color};font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;margin-bottom:10px">${s.text}</div>
        <div class="muted" style="font-size:11px;line-height:1.5">Warsh: ${m.warshTake}</div>
      </div>`;
  }).join('');
}

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

// ------------------------------------------------------------------
// Charts
// ------------------------------------------------------------------

function renderBalanceSheetChart(data) {
  const walcl = data['WALCL'];
  if (!walcl?.length) return;

  const toB = pts => pts.filter(p => p.date >= CHART_START).map(p => ({ time: p.date, value: +(p.value / 1000).toFixed(1) }));

  const chart = makeChart('chart-balance-sheet', 300);
  if (!chart) return;
  chart.applyOptions({ handleScroll: { pressedMouseMove: true, horzTouchDrag: true, mouseWheel: false } });

  const area = chart.addSeries(LC.AreaSeries, {
    lineColor: colors.balSheet,
    topColor:    hexToRgba(colors.balSheet, 0.25),
    bottomColor: hexToRgba(colors.balSheet, 0),
    lineWidth: 2, priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
  });
  area.setData(toB(walcl));

  area.createPriceLine({
    price: 4200, color: '#f97316', lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
    axisLabelVisible: true, title: 'Pre-COVID (~Warsh target)',
  });

  const treast = data['TREAST'];
  const wshomcb = data['WSHOMCB'];
  const entries = [{ label: 'Total Assets', color: colors.balSheet, value: `$${(walcl[walcl.length-1].value/1000).toFixed(0)}B` }];
  if (treast?.length)  entries.push({ label: 'Treasuries', color: colors.sofr, value: `$${(treast[treast.length-1].value/1000).toFixed(0)}B` });
  if (wshomcb?.length) entries.push({ label: 'MBS',        color: colors.mbs,  value: `$${(wshomcb[wshomcb.length-1].value/1000).toFixed(0)}B` });
  addChartLegend('chart-balance-sheet', entries);
  fitWithRightPadding(chart, walcl.length, 0.04);

  addChartOverlay(chart, 'chart-balance-sheet', {
    regions: [
      { from: ERA.powellStart,    to: ERA.warshConfirmed, color: 'rgba(122,162,247,0.05)' },
      { from: ERA.warshConfirmed, to: '2030-01-01',       color: 'rgba(249,115,22,0.05)'  },
    ],
    lines: [
      { date: ERA.powellStart,    label: 'Powell',      color: '#7aa2f7' },
      { date: ERA.covidQE,        label: 'COVID QE',    color: '#ef4444' },
      { date: ERA.qtBegins,       label: 'QT',          color: '#34d399' },
      { date: ERA.warshConfirmed, label: 'Warsh',       color: '#f97316' },
      { date: ERA.warshFirstFomc, label: 'First FOMC',  color: '#f97316' },
    ],
  });
}

function renderInflationChart(data) {
  const pcepilfe = data['PCEPILFE'];
  const cpilfesl = data['CPILFESL'];

  const pceYoY = pcepilfe?.length >= 13 ? computeMonthlyYoY(pcepilfe).filter(p => p.date >= CHART_START) : [];
  const cpiYoY = cpilfesl?.length >= 13 ? computeMonthlyYoY(cpilfesl).filter(p => p.date >= CHART_START) : [];
  if (!pceYoY.length && !cpiYoY.length) return;

  const chart = makeChart('chart-inflation', 260);
  if (!chart) return;

  const pceColor = '#7aa2f7';
  const cpiColor = '#34d399';

  if (pceYoY.length >= 2) {
    const s = chart.addSeries(LC.LineSeries, { color: pceColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    s.setData(toChartPoints(pceYoY));
  }
  if (cpiYoY.length >= 2) {
    const s = chart.addSeries(LC.LineSeries, { color: cpiColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    s.setData(toChartPoints(cpiYoY));
  }

  const refData = pceYoY.length ? pceYoY : cpiYoY;
  const target  = chart.addSeries(LC.LineSeries, {
    color: '#ef4444', lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: false,
  });
  target.setData([{ time: refData[0].date, value: 2.0 }, { time: refData[refData.length - 1].date, value: 2.0 }]);

  const entries = [];
  if (pceYoY.length) entries.push({ label: 'Core PCE', color: pceColor, value: `${pceYoY[pceYoY.length-1].value.toFixed(1)}%` });
  if (cpiYoY.length) entries.push({ label: 'Core CPI', color: cpiColor, value: `${cpiYoY[cpiYoY.length-1].value.toFixed(1)}%` });
  entries.push({ label: 'Target', color: '#ef4444', value: '2.0%' });
  addChartLegend('chart-inflation', entries);
  fitWithRightPadding(chart, Math.max(pceYoY.length, cpiYoY.length), 0.04);

  addChartOverlay(chart, 'chart-inflation', {
    regions: [
      { from: ERA.powellStart,    to: ERA.warshConfirmed, color: 'rgba(122,162,247,0.05)' },
      { from: ERA.warshConfirmed, to: '2030-01-01',       color: 'rgba(249,115,22,0.05)'  },
    ],
    lines: [
      { date: ERA.powellStart,    label: 'Powell', color: '#7aa2f7' },
      { date: ERA.firstHike,      label: 'Hike',   color: '#ef4444' },
      { date: ERA.warshConfirmed, label: 'Warsh',  color: '#f97316' },
    ],
  });
}

function renderBreakevenChart(data) {
  const t10yie = (data['T10YIE'] || []).filter(p => p.date >= CHART_START);
  const t5yie  = (data['T5YIE']  || []).filter(p => p.date >= CHART_START);
  if (!t10yie.length) return;

  const chart = makeChart('chart-breakevens', 260);
  if (!chart) return;

  const c10 = '#7aa2f7';
  const c5  = '#2dd4bf';

  const s10 = chart.addSeries(LC.LineSeries, { color: c10, lineWidth: 2, priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true });
  s10.setData(toChartPoints(t10yie));

  if (t5yie?.length >= 2) {
    const s5 = chart.addSeries(LC.LineSeries, { color: c5, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    s5.setData(toChartPoints(t5yie));
  }

  const anchor = chart.addSeries(LC.LineSeries, {
    color: '#ef4444', lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: false,
  });
  anchor.setData([{ time: t10yie[0].date, value: 2.0 }, { time: t10yie[t10yie.length - 1].date, value: 2.0 }]);

  const entries = [{ label: '10Y BEI', color: c10, value: `${t10yie[t10yie.length-1].value.toFixed(2)}%` }];
  if (t5yie?.length) entries.push({ label: '5Y BEI', color: c5, value: `${t5yie[t5yie.length-1].value.toFixed(2)}%` });
  entries.push({ label: 'Anchor', color: '#ef4444', value: '2.0%' });
  addChartLegend('chart-breakevens', entries);
  fitWithRightPadding(chart, t10yie.length, 0.04);

  addChartOverlay(chart, 'chart-breakevens', {
    regions: [
      { from: ERA.powellStart,    to: ERA.warshConfirmed, color: 'rgba(122,162,247,0.05)' },
      { from: ERA.warshConfirmed, to: '2030-01-01',       color: 'rgba(249,115,22,0.05)'  },
    ],
    lines: [
      { date: ERA.powellStart,    label: 'Powell', color: '#7aa2f7' },
      { date: ERA.firstHike,      label: 'Hike',   color: '#ef4444' },
      { date: ERA.firstCut,       label: 'Cut',    color: '#34d399' },
      { date: ERA.warshConfirmed, label: 'Warsh',  color: '#f97316' },
    ],
  });
}

function renderRateChart(data) {
  const fedfunds  = data['FEDFUNDS'] || [];
  const effr      = data['EFFR']     || [];
  const effrStart = effr.length ? effr[0].date : '2099-01-01';
  const pre       = fedfunds.filter(p => p.date >= CHART_START && p.date < effrStart).map(p => ({ time: p.date, value: p.value }));
  const combined  = [...pre, ...toChartPoints(effr)];
  if (combined.length < 2) return;

  const chart = makeChart('chart-rates', 260);
  if (!chart) return;
  chart.applyOptions({ handleScroll: { pressedMouseMove: true, horzTouchDrag: true, mouseWheel: false } });

  const area = chart.addSeries(LC.AreaSeries, {
    lineColor: colors.rate,
    topColor:    hexToRgba(colors.rate, 0.3),
    bottomColor: hexToRgba(colors.rate, 0.02),
    lineWidth: 2, priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
  });
  area.setData(combined);

  addChartLegend('chart-rates', [
    { label: 'EFFR', color: colors.rate, value: `${combined[combined.length - 1].value.toFixed(2)}%` },
  ]);

  const viewFrom   = '2008-01-01';
  const visible    = combined.filter(p => p.time >= viewFrom).length;
  chart.timeScale().applyOptions({ rightOffset: Math.ceil(visible * 0.04) });
  chart.timeScale().setVisibleRange({ from: viewFrom, to: combined[combined.length - 1].time });

  addChartOverlay(chart, 'chart-rates', {
    regions: [
      { from: ERA.powellStart,    to: ERA.warshConfirmed, color: 'rgba(122,162,247,0.05)' },
      { from: ERA.warshConfirmed, to: '2030-01-01',       color: 'rgba(249,115,22,0.05)'  },
    ],
    lines: [
      { date: ERA.powellStart,    label: 'Powell',      color: '#7aa2f7' },
      { date: ERA.faitAdopted,    label: 'FAIT',        color: '#f59e0b' },
      { date: ERA.warshConfirmed, label: 'Warsh',       color: '#f97316' },
      { date: ERA.warshFirstFomc, label: 'First FOMC',  color: '#f97316' },
    ],
  });
}

function renderReservesChart(data) {
  const wresbal   = data['WRESBAL'];
  const rrpontsyd = data['RRPONTSYD'];
  if (!wresbal?.length) return;

  const cutoff     = nYearsAgo(5);
  const resFiltered = wresbal.filter(p => p.date >= cutoff);
  const rrpFiltered = rrpontsyd?.filter(p => p.date >= cutoff) ?? [];
  if (resFiltered.length < 2) return;

  const chart = makeChart('chart-reserves', 260);
  if (!chart) return;

  const resArea = chart.addSeries(LC.AreaSeries, {
    lineColor: colors.reserves,
    topColor:    hexToRgba(colors.reserves, 0.3),
    bottomColor: hexToRgba(colors.reserves, 0.02),
    lineWidth: 2, priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
  });
  resArea.setData(toChartPoints(resFiltered));

  if (rrpFiltered.length >= 2) {
    const rrpLine = chart.addSeries(LC.LineSeries, {
      color: colors.rrp, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    });
    rrpLine.setData(toChartPoints(rrpFiltered));
  }

  const entries = [{ label: 'Reserve Balances', color: colors.reserves, value: `$${Math.round(resFiltered[resFiltered.length-1].value)}B` }];
  if (rrpFiltered.length) entries.push({ label: 'O/N RRP', color: colors.rrp, value: `$${Math.round(rrpFiltered[rrpFiltered.length-1].value)}B` });
  addChartLegend('chart-reserves', entries);
  fitWithRightPadding(chart, resFiltered.length, 0.04);

  addChartOverlay(chart, 'chart-reserves', {
    regions: [
      { from: ERA.powellStart,    to: ERA.warshConfirmed, color: 'rgba(122,162,247,0.05)' },
      { from: ERA.warshConfirmed, to: '2030-01-01',       color: 'rgba(249,115,22,0.05)'  },
    ],
    lines: [
      { date: ERA.powellStart,    label: 'Powell', color: '#7aa2f7' },
      { date: ERA.warshConfirmed, label: 'Warsh',  color: '#f97316' },
    ],
  });
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

async function init() {
  renderNav();
  try {
    const bundle = await fetchFredBundle();
    const data   = {};
    for (const id of FEDCHAIR_SERIES) {
      if (bundle.series?.[id]) {
        data[id] = bundle.series[id].map(([date, value]) => ({ date, value }));
      }
    }

    const effr  = data['EFFR'];
    const walcl = data['WALCL'];
    const parts = [];
    if (effr?.length)  parts.push(`EFFR as of ${effr[effr.length - 1].date}`);
    if (walcl?.length) parts.push(`balance sheet as of ${walcl[walcl.length - 1].date}`);
    const metaEl = document.getElementById('meta');
    if (metaEl) metaEl.textContent = parts.length ? parts.join(' · ') : 'Data loaded';

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

document.addEventListener('DOMContentLoaded', init);
