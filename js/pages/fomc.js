// js/pages/fomc.js — FOMC Policy Dashboard page (ES module).
import { renderNav }       from '../components/Navigation.js';
import { fetchFredBundle } from '../core/api.js';
import {
  createFomcChart, fitWithRightPadding, addChartLegend, addZoomControls, hexToRgba, colors,
} from '../core/chart-utils.js';

const LC = window.LightweightCharts;

const FOMC_SERIES = [
  'DFEDTARU', 'DFEDTARL', 'EFFR', 'IORB', 'SOFR', 'SOFR30DAYAVG',
  'WALCL', 'FEDTARMD', 'RRPONTSYD', 'WRESBAL', 'TREAST', 'WSHOMCB',
  'FEDFUNDS',
];

const fomcCharts = new Map();

function toChartPoints(points) {
  return points.map(p => ({ time: p.date, value: p.value }));
}

function filterAfter(points, isoDate) {
  return points ? points.filter(p => p.date >= isoDate) : [];
}

function nYearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function destroyChart(id) {
  if (fomcCharts.has(id)) {
    try { fomcCharts.get(id).remove(); } catch (_) {}
    fomcCharts.delete(id);
  }
}

function createBaseChart(containerId, height, overrides) {
  destroyChart(containerId);
  const el = document.getElementById(containerId);
  if (!el) return null;
  const chart = createFomcChart(el, height, overrides);
  fomcCharts.set(containerId, chart);
  return chart;
}

function buildDecisionTimeline(dfedtaru) {
  if (!dfedtaru || dfedtaru.length < 2) return [];
  const decisions = [];
  for (let i = 1; i < dfedtaru.length; i++) {
    const delta = Math.round((dfedtaru[i].value - dfedtaru[i - 1].value) * 100);
    if (delta !== 0) {
      decisions.push({
        date: dfedtaru[i].date, bps: delta,
        type: delta > 0 ? 'Hike' : 'Cut',
      });
    }
  }
  return decisions.reverse();
}

function renderSummaryCards(data, decisions) {
  const dfedtaru = data['DFEDTARU'];
  const dfedtarl = data['DFEDTARL'];
  const fedtarmd = data['FEDTARMD'];
  const walcl    = data['WALCL'];

  if (dfedtarl?.length && dfedtaru?.length) {
    const lo = dfedtarl[dfedtarl.length - 1].value;
    const hi = dfedtaru[dfedtaru.length - 1].value;
    document.getElementById('card-rate').textContent = `${lo.toFixed(2)}–${hi.toFixed(2)}%`;
  }

  if (decisions.length > 0) {
    const last  = decisions[0];
    const sign  = last.bps > 0 ? '+' : '';
    const color = last.type === 'Hike' ? colors.hike : colors.cut;
    const el    = document.getElementById('card-last-move');
    el.textContent = `${sign}${last.bps}bps`;
    el.style.color = color;
    document.getElementById('card-last-move-date').textContent = formatDate(last.date);
  }

  if (fedtarmd?.length) {
    const v   = fedtarmd[fedtarmd.length - 1].value;
    const dt  = fedtarmd[fedtarmd.length - 1].date;
    document.getElementById('card-sep').textContent = `${v.toFixed(2)}%`;
    const sub = document.querySelector('#card-sep + .muted');
    if (sub) sub.textContent = `As of ${formatDate(dt)}`;
  }

  if (walcl?.length) {
    const v = walcl[walcl.length - 1].value;
    document.getElementById('card-bs').textContent = `$${(v / 1_000_000).toFixed(2)}T`;
  }
}

function renderRateHistoryChart(data, decisions) {
  const fedfunds  = data['FEDFUNDS'] || [];
  const effr      = data['EFFR']     || [];
  const effrStart = effr.length > 0 ? effr[0].date : '2099-01-01';
  const pre       = fedfunds.filter(p => p.date < effrStart).map(p => ({ time: p.date, value: p.value }));
  const combined  = [...pre, ...toChartPoints(effr)];
  if (combined.length < 2) return;

  const chart = createBaseChart('chart-rate-history', 300);
  if (!chart) return;

  const area = chart.addSeries(LC.AreaSeries, {
    lineColor: colors.rate,
    topColor:    hexToRgba(colors.rate, 0.3),
    bottomColor: hexToRgba(colors.rate, 0.02),
    lineWidth: 2, priceLineVisible: true,
    priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 7 } }),
  });
  area.setData(combined);

  addChartLegend('chart-rate-history', [
    { label: 'EFFR', color: colors.rate, value: `${combined[combined.length - 1].value.toFixed(2)}%` },
  ]);

  const firstDate = combined[0].time;
  const markers = [...decisions].reverse()
    .filter(d => d.date >= firstDate)
    .map(d => ({
      time: d.date,
      position: d.type === 'Hike' ? 'aboveBar' : 'belowBar',
      color: d.type === 'Hike' ? colors.hike : colors.cut,
      shape: d.type === 'Hike' ? 'arrowUp' : 'arrowDown',
      text: `${d.bps > 0 ? '+' : ''}${d.bps}`, size: 0.8,
    }));
  markers.push({ time: '2026-06-17', position: 'aboveBar', color: '#f97316', shape: 'circle', text: 'Warsh', size: 0.8 });
  markers.sort((a, b) => (a.time < b.time ? -1 : 1));
  LC.createSeriesMarkers(area, markers);

  fitWithRightPadding(chart, combined.length, 0.05);
  addZoomControls(chart, 'chart-rate-history', [
    { label: '5Y', years: 5 }, { label: '10Y', years: 10 }, { label: 'Max', years: null },
  ]);
}

function renderRateCorridorChart(data) {
  const cutoff   = nYearsAgo(2);
  const dfedtaru = filterAfter(data['DFEDTARU'], cutoff);
  const dfedtarl = filterAfter(data['DFEDTARL'], cutoff);
  const effr     = filterAfter(data['EFFR'],     cutoff);
  if (dfedtaru.length < 2) return;

  const chart = createBaseChart('chart-rate-corridor', 240);
  if (!chart) return;

  const upper = chart.addSeries(LC.LineSeries, {
    color: colors.rate, lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: true,
  });
  upper.setData(toChartPoints(dfedtaru));

  const lower = chart.addSeries(LC.LineSeries, {
    color: hexToRgba(colors.rate, 0.6), lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: true,
  });
  lower.setData(toChartPoints(dfedtarl));

  if (effr.length >= 2) {
    const s = chart.addSeries(LC.LineSeries, {
      color: colors.effr, lineWidth: 2,
      priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
    });
    s.setData(toChartPoints(effr));
  }

  addChartLegend('chart-rate-corridor', [
    { label: 'Target Upper', color: colors.rate,                  value: `${dfedtaru[dfedtaru.length-1].value.toFixed(2)}%` },
    { label: 'Target Lower', color: hexToRgba(colors.rate, 0.6), value: `${dfedtarl[dfedtarl.length-1].value.toFixed(2)}%` },
    ...(effr.length ? [{ label: 'EFFR', color: colors.effr,      value: `${effr[effr.length-1].value.toFixed(2)}%` }] : []),
  ]);
  fitWithRightPadding(chart, dfedtaru.length);
  addZoomControls(chart, 'chart-rate-corridor', [
    { label: '1Y', years: 1 }, { label: '2Y', years: 2 },
  ], 1);
}

function renderSepChart(data) {
  const fedtarmd = data['FEDTARMD'];
  if (!fedtarmd || fedtarmd.length < 2) return;

  const chart = createBaseChart('chart-sep', 220);
  if (!chart) return;

  const line = chart.addSeries(LC.LineSeries, {
    color: hexToRgba(colors.rate, 0.4), lineWidth: 1,
    priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
  });
  line.setData(toChartPoints(fedtarmd));
  addChartLegend('chart-sep', [
    { label: 'SEP Median', color: colors.rate, value: `${fedtarmd[fedtarmd.length-1].value.toFixed(2)}%` },
  ]);
  LC.createSeriesMarkers(line, fedtarmd.map(p => ({
    time: p.date, position: 'inBar', color: colors.rate, shape: 'circle',
    size: 2, text: `${p.value.toFixed(2)}%`,
  })));
  fitWithRightPadding(chart, fedtarmd.length, 0.005);
  addZoomControls(chart, 'chart-sep', [
    { label: '5Y', years: 5 }, { label: 'Max', years: null },
  ]);
}

function renderReverseRepoChart(data) {
  const rrpo = data['RRPONTSYD'];
  if (!rrpo || rrpo.length < 2) return;

  const chart = createBaseChart('chart-rrpo', 220);
  if (!chart) return;

  const area = chart.addSeries(LC.AreaSeries, {
    lineColor: colors.rrp,
    topColor:    hexToRgba(colors.rrp, 0.35),
    bottomColor: hexToRgba(colors.rrp, 0.02),
    lineWidth: 2, priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
  });
  area.setData(toChartPoints(rrpo));
  addChartLegend('chart-rrpo', [
    { label: 'O/N RRP', color: colors.rrp, value: `$${rrpo[rrpo.length-1].value.toFixed(0)}B` },
  ]);
  fitWithRightPadding(chart, rrpo.length, 0.04);
  addZoomControls(chart, 'chart-rrpo', [
    { label: '3Y', years: 3 }, { label: '5Y', years: 5 }, { label: 'Max', years: null },
  ]);
}

function renderBalanceSheetChart(data) {
  const walcl  = data['WALCL'];
  const treast = data['TREAST'];
  const wshomcb = data['WSHOMCB'];
  if (!walcl || walcl.length < 2) return;

  const toB = pts => pts.map(p => ({ time: p.date, value: +(p.value / 1000).toFixed(1) }));

  const chart = createBaseChart('chart-balance-sheet', 280);
  if (!chart) return;

  const totalArea = chart.addSeries(LC.AreaSeries, {
    lineColor: colors.balSheet,
    topColor:    hexToRgba(colors.balSheet, 0.2),
    bottomColor: hexToRgba(colors.balSheet, 0),
    lineWidth: 2, priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
  });
  totalArea.setData(toB(walcl));

  if (treast?.length >= 2) {
    const s = chart.addSeries(LC.LineSeries, {
      color: colors.sofr, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    });
    s.setData(toB(treast));
  }
  if (wshomcb?.length >= 2) {
    const s = chart.addSeries(LC.LineSeries, {
      color: colors.mbs, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    });
    s.setData(toB(wshomcb));
  }

  const entries = [
    { label: 'Total Assets', color: colors.balSheet, value: `$${(walcl[walcl.length-1].value/1000).toFixed(0)}B` },
  ];
  if (treast?.length)   entries.push({ label: 'Treasuries', color: colors.sofr, value: `$${(treast[treast.length-1].value/1000).toFixed(0)}B` });
  if (wshomcb?.length)  entries.push({ label: 'MBS',        color: colors.mbs,  value: `$${(wshomcb[wshomcb.length-1].value/1000).toFixed(0)}B` });
  addChartLegend('chart-balance-sheet', entries);
  fitWithRightPadding(chart, walcl.length);
  addZoomControls(chart, 'chart-balance-sheet', [
    { label: '5Y', years: 5 }, { label: '10Y', years: 10 }, { label: 'Max', years: null },
  ]);
}

function renderReserveBalancesChart(data) {
  const wresbal = data['WRESBAL'];
  if (!wresbal || wresbal.length < 2) return;

  const chart = createBaseChart('chart-wresbal', 220);
  if (!chart) return;

  const area = chart.addSeries(LC.AreaSeries, {
    lineColor: colors.reserves,
    topColor:    hexToRgba(colors.reserves, 0.3),
    bottomColor: hexToRgba(colors.reserves, 0.02),
    lineWidth: 2, priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
  });
  area.setData(toChartPoints(wresbal));
  addChartLegend('chart-wresbal', [
    { label: 'Reserves', color: colors.reserves, value: `$${wresbal[wresbal.length-1].value.toFixed(0)}B` },
  ]);
  fitWithRightPadding(chart, wresbal.length, 0.03);
  addZoomControls(chart, 'chart-wresbal', [
    { label: '3Y', years: 3 }, { label: '5Y', years: 5 }, { label: 'Max', years: null },
  ]);
}

async function init() {
  renderNav();
  try {
    const bundle = await fetchFredBundle();
    const data   = {};
    for (const id of FOMC_SERIES) {
      if (bundle.series?.[id]) {
        data[id] = bundle.series[id].map(([date, value]) => ({ date, value }));
      }
    }

    const decisions = buildDecisionTimeline(data['DFEDTARU'] || []);
    renderSummaryCards(data, decisions);

    const dfedtaru = data['DFEDTARU'];
    const metaEl   = document.getElementById('meta');
    if (dfedtaru?.length) {
      const lastDate = dfedtaru[dfedtaru.length - 1].date;
      metaEl.textContent = `Last updated: ${lastDate} · ${decisions.length} rate decisions detected since 2008`;
    } else {
      metaEl.textContent = 'Data loaded';
    }

    for (const [fn, args] of [
      [renderRateHistoryChart,    [data, decisions]],
      [renderRateCorridorChart,   [data]],
      [renderSepChart,            [data]],
      [renderReverseRepoChart,    [data]],
      [renderBalanceSheetChart,   [data]],
      [renderReserveBalancesChart,[data]],
    ]) {
      try { fn(...args); } catch (e) { console.error(`${fn.name}:`, e); }
    }
  } catch (err) {
    console.error('FOMC init error:', err);
    document.getElementById('meta').textContent = `Error: ${err.message}`;
  }
}

document.addEventListener('DOMContentLoaded', init);
