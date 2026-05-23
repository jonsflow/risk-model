// js/pages/gov_data.js — Government Data (FRED) page (ES module).
import { renderNav }                                               from '../components/Navigation.js';
import { fetchFredBundle, fetchCache }                             from '../core/api.js';
import {
  createDashboardChart, fitWithRightPadding, addChartLegend,
  hexToRgba, computePercentile,
} from '../core/chart-utils.js';

const LC = window.LightweightCharts;

let HISTORY_DAYS   = 252;
let GOV_CATEGORIES = [];
let activeTab      = 'overview';
let allData        = {};

const TAB_DEFS = [
  { id: 'overview', label: 'Overview'    },
  { id: 'jpmorgan', label: 'JPMorgan'   },
  { id: 'nyfed',    label: 'NY Fed'     },
  { id: 'nfci',     label: 'Fed / NFCI' },
  { id: 'sahm',     label: 'Sahm Rule'  },
];

const renderedTabs = new Set();

// =============================================================================
// STATS COMPUTATION
// =============================================================================

const FREQ_LOOKBACK_DAYS = { daily: 1, weekly: 6, monthly: 25 };
const FREQ_LABEL         = { daily: '1d chg', weekly: '1wk chg', monthly: '1mo chg' };

function findPriorPoint(points, currentDate, lookbackDays) {
  const cutoff = new Date(currentDate);
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (let i = points.length - 2; i >= 0; i--) {
    if (points[i].date <= cutoffStr) return points[i];
  }
  return null;
}

function formatValue(v) {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 10)   return v.toFixed(2);
  return v.toFixed(3);
}

function computeStats(points, display, freq) {
  if (!points || points.length < 2)
    return { displayValue: 'N/A', displayLabel: '', change: null, changeStr: '', chgLabel: '' };

  const current      = points[points.length - 1];
  const lookbackDays = FREQ_LOOKBACK_DAYS[freq] || 2;
  const chgLabel     = FREQ_LABEL[freq] || '1d chg';

  if (display === 'pct_yoy') {
    const oneYearAgo = new Date(current.date);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const cutoffStr = oneYearAgo.toISOString().slice(0, 10);
    let priorPt = null;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].date <= cutoffStr) { priorPt = points[i]; break; }
    }
    if (priorPt && priorPt.value !== 0) {
      const yoy   = ((current.value - priorPt.value) / Math.abs(priorPt.value)) * 100;
      const sign  = yoy >= 0 ? '+' : '';
      const prior = findPriorPoint(points, current.date, lookbackDays);
      const absChange = prior ? current.value - prior.value : null;
      return {
        displayValue: `${sign}${yoy.toFixed(2)}%`,
        displayLabel: 'YoY',
        change: absChange,
        changeStr: absChange !== null ? `${absChange >= 0 ? '+' : ''}${formatValue(absChange)}` : '',
        chgLabel,
      };
    }
    return { displayValue: 'N/A', displayLabel: 'YoY', change: null, changeStr: '', chgLabel };
  }

  if (display === 'pct_mom') {
    const prior = findPriorPoint(points, current.date, lookbackDays);
    if (prior && prior.value !== 0) {
      const mom  = ((current.value - prior.value) / Math.abs(prior.value)) * 100;
      const sign = mom >= 0 ? '+' : '';
      return { displayValue: `${sign}${mom.toFixed(2)}%`, displayLabel: 'MoM', change: mom, changeStr: '', chgLabel };
    }
    return { displayValue: 'N/A', displayLabel: 'MoM', change: null, changeStr: '', chgLabel };
  }

  // level
  const prior     = findPriorPoint(points, current.date, lookbackDays);
  const absChange = prior !== null ? current.value - prior.value : null;
  return {
    displayValue: formatValue(current.value),
    displayLabel: '',
    change: absChange,
    changeStr: absChange !== null ? `${absChange >= 0 ? '+' : ''}${formatValue(absChange)}` : '',
    chgLabel,
  };
}

// =============================================================================
// SPARKLINE RENDERING
// =============================================================================

function renderSparkline(svgEl, points, color) {
  const W   = 300;
  const H   = 52;
  const PAD = { top: 3, right: 3, bottom: 3, left: 3 };
  const cw  = W - PAD.left - PAD.right;
  const ch  = H - PAD.top - PAD.bottom;

  const pts = points.slice(Math.max(0, points.length - HISTORY_DAYS));
  if (pts.length < 2) { svgEl.innerHTML = ''; return; }

  const values   = pts.map(p => p.value);
  const minVal   = Math.min(...values);
  const maxVal   = Math.max(...values);
  const valRange = maxVal - minVal || 1;
  const n        = pts.length;

  const xS     = i => PAD.left + (i / (n - 1)) * cw;
  const yS     = v => PAD.top + ch - ((v - minVal) / valRange) * ch;
  const bottomY = PAD.top + ch;

  const pricePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xS(i).toFixed(1)} ${yS(p.value).toFixed(1)}`).join(' ');
  const priceArea = `${pricePath} L ${xS(n - 1).toFixed(1)} ${bottomY} L ${xS(0).toFixed(1)} ${bottomY} Z`;

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.setAttribute('preserveAspectRatio', 'none');
  svgEl.innerHTML = `
    <path d="${priceArea}" fill="${color}" opacity="0.15"/>
    <path d="${pricePath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  `;
}

// =============================================================================
// CARD & CATEGORY RENDERING
// =============================================================================

function renderSeriesCard(series, points, color) {
  const stats  = computeStats(points, series.display, series.freq);
  const changeCls = stats.change === null ? '' : (stats.change >= 0 ? 'positive' : 'negative');
  const changeHTML = stats.changeStr
    ? `<span class="asset-change ${changeCls}" title="${stats.chgLabel}">${stats.changeStr} <span style="font-size:9px;opacity:0.7">${stats.chgLabel}</span></span>`
    : '';
  const labelHTML = stats.displayLabel
    ? `<span class="muted" style="font-size:11px;margin-left:4px">${stats.displayLabel}</span>`
    : '';
  const latestDate = points && points.length > 0 ? points[points.length - 1].date : '';
  const dateHTML   = latestDate ? `<div class="muted" style="font-size:10px;margin-top:2px">${latestDate}</div>` : '';
  const cardId     = `gov-card-${series.id.toLowerCase()}`;
  const sparkId    = `gov-spark-${series.id.toLowerCase()}`;

  const card = document.createElement('div');
  card.className = 'asset-card';
  card.id = cardId;
  card.innerHTML = `
    <div class="asset-header">
      <span class="asset-symbol" style="font-size:11px">${series.id}</span>
      <span class="asset-name">${series.name}</span>
    </div>
    <div class="asset-price-row">
      <span class="asset-price">${stats.displayValue}${labelHTML}</span>
      ${changeHTML}
    </div>
    ${dateHTML}
    <svg class="asset-sparkline" id="${sparkId}" width="100%" height="52"></svg>
    <div class="muted" style="font-size:10px;text-align:right;margin-top:2px">${series.units}</div>
  `;

  if (points && points.length >= 2) {
    requestAnimationFrame(() => {
      const svgEl = document.getElementById(sparkId);
      if (svgEl) renderSparkline(svgEl, points, color);
    });
  }

  return card;
}

function renderCategory(cat, data) {
  const section = document.createElement('div');
  section.className = 'card';
  section.style.marginTop = '18px';

  const heading = document.createElement('h2');
  heading.style.cssText = `color:${cat.color};margin:0 0 14px 0;font-size:16px`;
  heading.textContent = cat.name;
  section.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'assets-grid';
  section.appendChild(grid);

  for (const s of cat.series) {
    const points = data[s.id] || [];
    grid.appendChild(renderSeriesCard(s, points, cat.color));
  }

  return section;
}

function reRenderAllSparklines(data) {
  for (const cat of GOV_CATEGORIES) {
    for (const s of cat.series) {
      const sparkId = `gov-spark-${s.id.toLowerCase()}`;
      const svgEl   = document.getElementById(sparkId);
      const points  = data[s.id];
      if (svgEl && points && points.length >= 2) renderSparkline(svgEl, points, cat.color);
    }
  }
}

// =============================================================================
// LIGHTWEIGHT CHARTS HELPER
// =============================================================================

const govCharts = {};

function destroyGovChart(id) {
  if (govCharts[id]) {
    try { govCharts[id].remove(); } catch (_) {}
    delete govCharts[id];
  }
}

function renderGovChart(containerId, points, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  destroyGovChart(containerId);
  container.innerHTML = '';

  const height = opts.height || 250;
  const color  = opts.color  || '#4a9eff';

  const chart = createDashboardChart(container, height, {
    grid: { vertLines: { color: '#2a2b2f' }, horzLines: { color: '#2a2b2f' } },
  });
  govCharts[containerId] = chart;

  const data = points.map(p => ({ time: p.date, value: p.value }));
  let series;

  if (opts.baseline !== undefined) {
    series = chart.addSeries(LC.BaselineSeries, {
      baseValue:        { type: 'price', price: opts.baseline },
      topLineColor:     '#ef4444',
      topFillColor1:    'rgba(239,68,68,0.3)',
      topFillColor2:    'rgba(239,68,68,0.0)',
      bottomLineColor:  '#10b981',
      bottomFillColor1: 'rgba(16,185,129,0.0)',
      bottomFillColor2: 'rgba(16,185,129,0.3)',
      lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    });
  } else {
    series = chart.addSeries(LC.AreaSeries, {
      lineColor:        color,
      topColor:         hexToRgba(color, 0.3),
      bottomColor:      hexToRgba(color, 0),
      lineWidth: 2, priceLineVisible: true, priceLineStyle: LC.LineStyle.Dashed, lastValueVisible: true,
    });
  }

  series.setData(data);

  if (opts.refLines) {
    for (const ref of opts.refLines) {
      series.createPriceLine({
        price: ref.value, color: ref.color || '#ef4444',
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: ref.label || '',
      });
    }
  }

  fitWithRightPadding(chart, data.length);
  if (opts.legend) addChartLegend(containerId, opts.legend);

  return chart;
}

// =============================================================================
// SCORING HELPERS
// =============================================================================

function scoreColor(score) {
  if (score <= 25) return '#10b981';
  if (score <= 45) return '#84cc16';
  if (score <= 60) return '#f59e0b';
  if (score <= 80) return '#f97316';
  return '#ef4444';
}

function scoreLabel(score) {
  if (score <= 25) return 'Low Risk';
  if (score <= 45) return 'Moderate';
  if (score <= 60) return 'Elevated';
  if (score <= 80) return 'High Risk';
  return 'Extreme Risk';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function computeMoMZScore(points, lookback) {
  if (!points || points.length < lookback + 2) return 0;
  const recent  = points.slice(-lookback);
  const changes = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].value !== 0)
      changes.push((recent[i].value - recent[i - 1].value) / Math.abs(recent[i - 1].value));
  }
  if (changes.length < 2) return 0;
  const lastChange = changes[changes.length - 1];
  const mean       = changes.reduce((s, v) => s + v, 0) / changes.length;
  const std        = Math.sqrt(changes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / changes.length);
  return std === 0 ? 0 : (lastChange - mean) / std;
}

function zToRiskScore(z) { return Math.round(clamp(50 - z * 15, 5, 95)); }

function scoreYieldCurve(t10y2yPts) {
  if (!t10y2yPts || !t10y2yPts.length) return 50;
  const val = t10y2yPts[t10y2yPts.length - 1].value;
  if (val > 0.5)  return 10;
  if (val >= 0)   return 35;
  if (val >= -1)  return 65;
  return 90;
}

function scoreCreditStress(bamlPts) {
  if (!bamlPts || bamlPts.length < 2) return 50;
  return computePercentile(bamlPts, bamlPts[bamlPts.length - 1].value, 1260);
}

function scoreEconomicMomentum(indproPts, rsafsPts) {
  return zToRiskScore((computeMoMZScore(indproPts || [], 13) + computeMoMZScore(rsafsPts || [], 13)) / 2);
}

function scoreLaborMarket(payemsPts, unratePts) {
  const payemsScore = zToRiskScore(computeMoMZScore(payemsPts || [], 13));
  let sahmModifier  = 0;
  if (unratePts && unratePts.length >= 12) {
    const n     = unratePts.length;
    const ma3   = (unratePts[n-1].value + unratePts[n-2].value + unratePts[n-3].value) / 3;
    const min12 = Math.min(...unratePts.slice(n-12, n).map(p => p.value));
    const sahmVal = ma3 - min12;
    if (sahmVal >= 0.3)  sahmModifier = 20;
    else if (sahmVal < 0) sahmModifier = -10;
  }
  return Math.round(clamp(payemsScore + sahmModifier, 5, 95));
}

function scoreFinancialConditions(vixPts, nfciPts) {
  const vixScore  = vixPts && vixPts.length > 1
    ? computePercentile(vixPts, vixPts[vixPts.length - 1].value, 1260) : 50;
  const nfciScore = nfciPts && nfciPts.length > 1
    ? Math.round(clamp(50 + nfciPts[nfciPts.length - 1].value * 30, 5, 95)) : 50;
  return Math.round((vixScore + nfciScore) / 2);
}

// =============================================================================
// TAB SYSTEM
// =============================================================================

function buildTabUI() {
  const container = document.getElementById('tab-container');
  const bar    = TAB_DEFS.map(t =>
    `<button class="tab-btn${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');
  const panels = TAB_DEFS.map(t =>
    `<div class="tab-panel${t.id === activeTab ? ' active' : ''}" id="tab-${t.id}"></div>`
  ).join('');

  container.innerHTML = `<div class="tab-bar" style="margin-top:18px">${bar}</div><div class="tab-panels">${panels}</div>`;
  container.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );
}

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${tabId}`));

  if (!renderedTabs.has(tabId)) {
    renderedTabs.add(tabId);
    renderTabContent(tabId);
  }
}

function renderTabContent(tabId) {
  const panel = document.getElementById(`tab-${tabId}`);
  if (!panel) return;
  switch (tabId) {
    case 'overview': renderOverviewTab(panel);  break;
    case 'jpmorgan': renderJPMorganTab(panel);  break;
    case 'nyfed':    renderNYFedTab(panel);     break;
    case 'nfci':     renderNFCITab(panel);      break;
    case 'sahm':     renderSahmTab(panel);      break;
  }
}

// =============================================================================
// TAB 1: OVERVIEW
// =============================================================================

function renderOverviewTab(panel) {
  const controls = document.createElement('div');
  controls.className = 'card';
  controls.style.marginTop = '18px';
  controls.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div class="pill">
        <div class="muted">Chart History</div>
        <select id="historySelect" class="control-select">
          <option value="252"  ${HISTORY_DAYS === 252  ? 'selected' : ''}>1 year</option>
          <option value="504"  ${HISTORY_DAYS === 504  ? 'selected' : ''}>2 years</option>
          <option value="1260" ${HISTORY_DAYS === 1260 ? 'selected' : ''}>5 years</option>
        </select>
      </div>
    </div>
  `;
  panel.appendChild(controls);

  for (const cat of GOV_CATEGORIES) {
    panel.appendChild(renderCategory(cat, allData));
  }

  document.getElementById('historySelect').addEventListener('change', e => {
    HISTORY_DAYS = parseInt(e.target.value, 10);
    reRenderAllSparklines(allData);
  });
}

// =============================================================================
// TAB 2: JPMORGAN
// =============================================================================

function renderJPMorganTab(panel) {
  const factors = [
    { name: 'Yield Curve',           proxy: 'T10Y2Y',              color: '#4a9eff', score: scoreYieldCurve(allData['T10Y2Y']),                             points: allData['T10Y2Y']          || [] },
    { name: 'Credit Stress',         proxy: 'BAMLH0A0HYM2',        color: '#f97316', score: scoreCreditStress(allData['BAMLH0A0HYM2']),                     points: allData['BAMLH0A0HYM2']    || [] },
    { name: 'Economic Momentum',     proxy: 'INDPRO + RSAFS',       color: '#10b981', score: scoreEconomicMomentum(allData['INDPRO'], allData['RSAFS']),      points: allData['INDPRO']          || [] },
    { name: 'Labor Market',          proxy: 'PAYEMS + UNRATE',      color: '#a78bfa', score: scoreLaborMarket(allData['PAYEMS'], allData['UNRATE']),          points: allData['PAYEMS']          || [] },
    { name: 'Financial Conditions',  proxy: 'VIXCLS + NFCI',       color: '#f59e0b', score: scoreFinancialConditions(allData['VIXCLS'], allData['NFCI']),   points: allData['VIXCLS']          || [] },
  ];

  const composite = Math.round(factors.reduce((s, f) => s + f.score, 0) / factors.length);
  const cColor    = scoreColor(composite);
  const cLabel    = scoreLabel(composite);

  const compositeCard = document.createElement('div');
  compositeCard.className = 'card';
  compositeCard.style.marginTop = '18px';
  compositeCard.innerHTML = `
    <div style="font-size:13px;color:#a7a7ad;margin-bottom:8px">JPMorgan Risk Framework · Composite Score</div>
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="font-size:44px;font-weight:700;color:${cColor};font-variant-numeric:tabular-nums">${composite}</div>
      <div>
        <div style="font-size:20px;font-weight:600;color:${cColor}">${cLabel}</div>
        <div style="font-size:12px;color:#a7a7ad;margin-top:2px">Equal-weight avg of 5 factors · 0 = low risk · 100 = extreme risk</div>
      </div>
    </div>
    <div style="background:#2a2b2f;border-radius:6px;height:10px;margin-top:14px;overflow:hidden">
      <div style="width:${composite}%;background:${cColor};height:100%;border-radius:6px"></div>
    </div>
  `;
  panel.appendChild(compositeCard);

  const grid = document.createElement('div');
  grid.className = 'risk-cards-container';
  panel.appendChild(grid);

  factors.forEach((f, idx) => {
    const fc      = scoreColor(f.score);
    const fl      = scoreLabel(f.score);
    const sparkId = `jpm-spark-${idx}`;

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div style="font-size:14px;font-weight:600;color:#e9e9ea">${f.name}</div>
          <div style="font-size:11px;color:#a7a7ad;margin-top:2px">${f.proxy}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:26px;font-weight:700;color:${fc}">${f.score}</div>
          <div style="font-size:11px;color:${fc}">${fl}</div>
        </div>
      </div>
      <div style="background:#2a2b2f;border-radius:4px;height:6px;margin:8px 0;overflow:hidden">
        <div style="width:${f.score}%;background:${fc};height:100%;border-radius:4px"></div>
      </div>
      <svg id="${sparkId}" height="52" style="width:100%;display:block;margin-top:8px"></svg>
    `;
    grid.appendChild(card);

    if (f.points.length >= 2) {
      requestAnimationFrame(() => {
        const svgEl = document.getElementById(sparkId);
        if (svgEl) renderSparkline(svgEl, f.points, fc);
      });
    }
  });

  const note = document.createElement('div');
  note.className = 'card';
  note.style.marginTop = '18px';
  note.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#e9e9ea;margin-bottom:10px">About This Model</div>
    <div style="font-size:12px;color:#a7a7ad;line-height:1.7">
      <p style="margin:0 0 10px 0">
        JPMorgan's cross-asset risk framework evaluates macro and financial conditions across five independent
        dimensions, then combines them into a single composite risk score. The approach is rooted in JPMorgan's
        published research on <em>regime detection</em> — identifying whether markets are in risk-on, transitional,
        or risk-off environments before positioning across asset classes.
      </p>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Composite formula (equal weight):</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
Composite = (score_YC + score_CS + score_EM + score_LM + score_FC) / 5

Range: 0–100   where 0 = low risk, 100 = extreme risk
Bands: 0–25 Low · 25–45 Moderate · 45–60 Elevated · 60–80 High · 80–100 Extreme</div>

      <p style="margin:0 0 6px 0"><strong style="color:#4a9eff">① Yield Curve — T10Y2Y</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
T10Y2Y > +0.5%   →  score 10   (normal)
T10Y2Y  0–0.5%   →  score 35   (flattening)
T10Y2Y −1–0%     →  score 65   (inverted)
T10Y2Y < −1%     →  score 90   (deeply inverted)</div>

      <p style="margin:0 0 6px 0"><strong style="color:#f97316">② Credit Stress — BAMLH0A0HYM2</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
score_CS = percentile_rank(HY_OAS_current, 5yr window)</div>

      <p style="margin:0 0 6px 0"><strong style="color:#10b981">③ Economic Momentum — INDPRO + RSAFS</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
z_avg   = (z_INDPRO + z_RSAFS) / 2
score_EM = clamp(50 − z_avg × 15, 5, 95)</div>

      <p style="margin:0 0 6px 0"><strong style="color:#a78bfa">④ Labor Market — PAYEMS + UNRATE</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
sahm_proxy = MA₃(UNRATE) − min₁₂(UNRATE)
modifier   = +20 if sahm_proxy ≥ 0.3 · −10 if sahm_proxy < 0
score_LM   = clamp(base_score + modifier, 5, 95)</div>

      <p style="margin:0 0 6px 0"><strong style="color:#f59e0b">⑤ Financial Conditions — VIXCLS + NFCI</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
score_VIX  = percentile_rank(VIX, 5yr)
score_NFCI = clamp(50 + NFCI × 30, 5, 95)
score_FC   = (score_VIX + score_NFCI) / 2</div>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <a href="https://am.jpmorgan.com/us/en/asset-management/adv/insights/market-insights/guide-to-the-markets/" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">JPMorgan Guide to the Markets →</a>
        <a href="https://fred.stlouisfed.org/series/T10Y2Y" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">T10Y2Y on FRED →</a>
        <a href="https://fred.stlouisfed.org/series/BAMLH0A0HYM2" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">HY OAS on FRED →</a>
      </div>
    </div>
  `;
  panel.appendChild(note);
}

// =============================================================================
// TAB 3: NY FED
// =============================================================================

function standardNormalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x >= 0 ? 1 - p : p;
}

function recessionProb(spread) { return standardNormalCDF(-0.5333 - 0.6330 * spread) * 100; }
function probLabel(prob) { return prob < 15 ? 'Low' : prob < 30 ? 'Moderate' : prob < 50 ? 'Elevated' : prob < 70 ? 'High' : 'Very High'; }
function probColor(prob) { return prob < 15 ? '#10b981' : prob < 30 ? '#84cc16' : prob < 50 ? '#f59e0b' : prob < 70 ? '#f97316' : '#ef4444'; }

function renderNYFedTab(panel) {
  const t10y2yPts  = allData['T10Y2Y'] || [];
  const probSeries = t10y2yPts.map(p => ({
    date: p.date, value: parseFloat(recessionProb(p.value).toFixed(2)),
  }));

  const current     = t10y2yPts.length ? t10y2yPts[t10y2yPts.length - 1] : null;
  const currentProb = current ? recessionProb(current.value) : null;

  const statRow = document.createElement('div');
  statRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;margin-top:18px';

  if (currentProb !== null) {
    const pc = probColor(currentProb);
    const pl = probLabel(currentProb);
    statRow.innerHTML = `
      <div class="card" style="flex:1;min-width:180px">
        <div class="muted" style="font-size:12px;margin-bottom:4px">Recession Probability</div>
        <div style="font-size:36px;font-weight:700;color:${pc}">${currentProb.toFixed(1)}%</div>
        <div style="font-size:13px;color:${pc};margin-top:2px">${pl}</div>
      </div>
      <div class="card" style="flex:1;min-width:180px">
        <div class="muted" style="font-size:12px;margin-bottom:4px">T10Y2Y Spread (proxy)</div>
        <div style="font-size:36px;font-weight:700;color:#e9e9ea">${current.value.toFixed(2)}%</div>
        <div class="muted" style="font-size:12px;margin-top:2px">As of ${current.date}</div>
      </div>
    `;
  } else {
    statRow.innerHTML = `<div class="card" style="flex:1"><div class="muted">T10Y2Y data unavailable</div></div>`;
  }
  panel.appendChild(statRow);

  const chartCard = document.createElement('div');
  chartCard.className = 'card';
  chartCard.style.marginTop = '14px';
  chartCard.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#e9e9ea;margin-bottom:12px">Recession Probability Over Time</div>
    <div id="chart-nyfed" style="width:100%;height:250px"></div>
  `;
  panel.appendChild(chartCard);

  const noteCard = document.createElement('div');
  noteCard.className = 'card';
  noteCard.style.marginTop = '14px';
  noteCard.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#e9e9ea;margin-bottom:10px">About This Model</div>
    <div style="font-size:12px;color:#a7a7ad;line-height:1.7">
      <p style="margin:0 0 10px 0">
        The <strong style="color:#e9e9ea">New York Fed Recession Probability Model</strong> (Estrella &amp; Mishkin, 1996)
        estimates the probability that the U.S. economy will be in recession 12 months ahead using the yield curve spread.
      </p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
P(recession in 12 months | spread) = Φ(−0.5333 − 0.6330 × spread)

Spread    Probability
+1.0%  →     8%    Low
 0.0%  →    21%    Moderate (flat curve baseline)
−1.0%  →    42%    Elevated
−2.0%  →    67%    Very high</div>
      <p style="margin:0 0 8px 0"><strong style="color:#e9e9ea">Proxy note:</strong>
        Uses T10Y2Y instead of the official T10Y3M — treat as directionally indicative, not a precise replication.</p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <a href="https://www.newyorkfed.org/research/recession_probability" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">NY Fed Recession Probability (official) →</a>
        <a href="https://fred.stlouisfed.org/series/T10Y2Y" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">T10Y2Y on FRED →</a>
      </div>
    </div>
  `;
  panel.appendChild(noteCard);

  requestAnimationFrame(() => {
    renderGovChart('chart-nyfed', probSeries, {
      color:    '#ef4444',
      height:   250,
      refLines: [
        { value: 30, color: '#f59e0b', label: 'Watch (30%)' },
        { value: 50, color: '#ef4444', label: 'Elevated (50%)' },
      ],
      legend: currentProb !== null
        ? [{ label: 'Rec. Prob.', color: probColor(currentProb), value: `${currentProb.toFixed(1)}%` }]
        : [],
    });
  });
}

// =============================================================================
// TAB 4: FED / NFCI
// =============================================================================

function renderNFCITab(panel) {
  const nfciPts   = allData['NFCI']         || [];
  const bamlPts   = allData['BAMLH0A0HYM2'] || [];
  const t10y2yPts = allData['T10Y2Y']        || [];
  const vixPts    = allData['VIXCLS']        || [];
  const unratePts = allData['UNRATE']        || [];

  const currentNFCI = nfciPts.length     ? nfciPts[nfciPts.length - 1]   : null;
  const priorNFCI   = nfciPts.length >= 5 ? nfciPts[nfciPts.length - 5] : null;

  const creditPct = bamlPts.length > 1
    ? computePercentile(bamlPts, bamlPts[bamlPts.length - 1].value, 1260) : 50;
  const ycScore   = scoreYieldCurve(t10y2yPts);
  const vixPct    = vixPts.length > 1
    ? computePercentile(vixPts, vixPts[vixPts.length - 1].value, 1260) : 50;
  const urScore   = unratePts.length > 1
    ? Math.round(clamp(50 + (unratePts[unratePts.length - 1].value - 4) * 8, 5, 95)) : 50;
  const fedScore  = Math.round(0.35 * creditPct + 0.30 * ycScore + 0.20 * vixPct + 0.15 * urScore);
  const fsColor   = scoreColor(fedScore);
  const fsLabel   = scoreLabel(fedScore);

  const nfciTight   = currentNFCI && currentNFCI.value > 0;
  const nfciColor   = currentNFCI ? (nfciTight ? '#ef4444' : '#10b981') : '#a7a7ad';
  const nfciLabel   = currentNFCI ? (nfciTight ? 'Tighter than avg' : 'Looser than avg') : 'N/A';
  const nfci4wkChg  = (currentNFCI && priorNFCI) ? currentNFCI.value - priorNFCI.value : null;
  const chgColor    = nfci4wkChg === null ? '#a7a7ad' : nfci4wkChg > 0 ? '#ef4444' : '#10b981';

  const statRow = document.createElement('div');
  statRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;margin-top:18px';
  statRow.innerHTML = `
    <div class="card" style="flex:1;min-width:160px">
      <div class="muted" style="font-size:12px;margin-bottom:4px">NFCI (z-score)</div>
      <div style="font-size:36px;font-weight:700;color:${nfciColor}">${currentNFCI ? currentNFCI.value.toFixed(3) : 'N/A'}</div>
      <div style="font-size:12px;color:${nfciColor};margin-top:2px">${nfciLabel}</div>
    </div>
    <div class="card" style="flex:1;min-width:160px">
      <div class="muted" style="font-size:12px;margin-bottom:4px">4wk Change</div>
      <div style="font-size:36px;font-weight:700;color:${chgColor}">
        ${nfci4wkChg !== null ? (nfci4wkChg > 0 ? '+' : '') + nfci4wkChg.toFixed(3) : 'N/A'}
      </div>
      <div class="muted" style="font-size:12px;margin-top:2px">4 weeks ago → now</div>
    </div>
    <div class="card" style="flex:1;min-width:160px">
      <div class="muted" style="font-size:12px;margin-bottom:4px">Fed Model Score</div>
      <div style="font-size:36px;font-weight:700;color:${fsColor}">${fedScore}</div>
      <div style="font-size:12px;color:${fsColor};margin-top:2px">${fsLabel}</div>
      <div style="background:#2a2b2f;border-radius:4px;height:5px;margin-top:8px;overflow:hidden">
        <div style="width:${fedScore}%;background:${fsColor};height:100%;border-radius:4px"></div>
      </div>
    </div>
  `;
  panel.appendChild(statRow);

  const chartCard = document.createElement('div');
  chartCard.className = 'card';
  chartCard.style.marginTop = '14px';
  chartCard.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#e9e9ea;margin-bottom:12px">NFCI Over Time</div>
    <div id="chart-nfci" style="width:100%;height:250px"></div>
  `;
  panel.appendChild(chartCard);

  const noteCard = document.createElement('div');
  noteCard.className = 'card';
  noteCard.style.marginTop = '14px';
  noteCard.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#e9e9ea;margin-bottom:10px">About This Model</div>
    <div style="font-size:12px;color:#a7a7ad;line-height:1.7">
      <p style="margin:0 0 10px 0">
        The <strong style="color:#e9e9ea">National Financial Conditions Index (NFCI)</strong> is published weekly
        by the Federal Reserve Bank of Chicago, aggregating 105 financial indicators into a single z-score
        benchmarked against the average since 1971. Positive = tighter than average; negative = looser.
      </p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
Dashboard composite score:
S = 0.35 × credit_pct + 0.30 × yc_score + 0.20 × vix_pct + 0.15 × ur_score

Historical levels:  −1.0 = Very loose  · 0 = Average · +1.0 = Tight · +2.0 = Severely tight</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <a href="https://www.chicagofed.org/research/data/nfci/current-data" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">Chicago Fed NFCI →</a>
        <a href="https://fred.stlouisfed.org/series/NFCI" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">NFCI on FRED →</a>
      </div>
    </div>
  `;
  panel.appendChild(noteCard);

  requestAnimationFrame(() => {
    renderGovChart('chart-nfci', nfciPts, {
      height:   250,
      baseline: 0,
      legend: currentNFCI
        ? [{ label: 'NFCI', color: nfciColor, value: currentNFCI.value.toFixed(3) }]
        : [],
    });
  });
}

// =============================================================================
// TAB 5: SAHM RULE
// =============================================================================

function computeSahmSeries(unratePoints) {
  const results = [];
  for (let i = 12; i < unratePoints.length; i++) {
    const ma3   = (unratePoints[i].value + unratePoints[i-1].value + unratePoints[i-2].value) / 3;
    const min12 = Math.min(...unratePoints.slice(i-11, i+1).map(p => p.value));
    results.push({ date: unratePoints[i].date, value: parseFloat((ma3 - min12).toFixed(3)) });
  }
  return results;
}

function renderSahmTab(panel) {
  const unratePts = allData['UNRATE'] || [];
  const icsaPts   = allData['ICSA']   || [];
  const ccsaPts   = allData['CCSA']   || [];
  const payemsPts = allData['PAYEMS'] || [];

  const sahmSeries    = unratePts.length >= 13 ? computeSahmSeries(unratePts) : [];
  const currentSahm   = sahmSeries.length ? sahmSeries[sahmSeries.length - 1] : null;
  const currentUnrate = unratePts.length  ? unratePts[unratePts.length - 1]   : null;
  const ma3 = unratePts.length >= 3
    ? (unratePts[unratePts.length-1].value + unratePts[unratePts.length-2].value + unratePts[unratePts.length-3].value) / 3
    : null;

  const triggered  = currentSahm && currentSahm.value >= 0.5;
  const sahmColor  = triggered ? '#ef4444' : '#10b981';
  const sahmStatus = triggered ? '⚠ TRIGGERED' : 'NOT TRIGGERED';

  const statRow = document.createElement('div');
  statRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;margin-top:18px';
  statRow.innerHTML = `
    <div class="card" style="flex:1;min-width:160px">
      <div class="muted" style="font-size:12px;margin-bottom:4px">Sahm Indicator</div>
      <div style="font-size:36px;font-weight:700;color:${sahmColor}">${currentSahm ? currentSahm.value.toFixed(2) : 'N/A'}</div>
      <div style="font-size:12px;color:${sahmColor};margin-top:2px">${sahmStatus}</div>
    </div>
    <div class="card" style="flex:1;min-width:160px">
      <div class="muted" style="font-size:12px;margin-bottom:4px">UNRATE</div>
      <div style="font-size:36px;font-weight:700;color:#e9e9ea">${currentUnrate ? currentUnrate.value.toFixed(1) + '%' : 'N/A'}</div>
      <div class="muted" style="font-size:12px;margin-top:2px">${currentUnrate ? currentUnrate.date : ''}</div>
    </div>
    <div class="card" style="flex:1;min-width:160px">
      <div class="muted" style="font-size:12px;margin-bottom:4px">3-Month MA</div>
      <div style="font-size:36px;font-weight:700;color:#e9e9ea">${ma3 !== null ? ma3.toFixed(2) + '%' : 'N/A'}</div>
      <div class="muted" style="font-size:12px;margin-top:2px">Avg of last 3 months</div>
    </div>
  `;
  panel.appendChild(statRow);

  const chartCard = document.createElement('div');
  chartCard.className = 'card';
  chartCard.style.marginTop = '14px';
  chartCard.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#e9e9ea;margin-bottom:12px">Sahm Rule Indicator</div>
    <div id="chart-sahm" style="width:100%;height:250px"></div>
  `;
  panel.appendChild(chartCard);

  const sparkRow = document.createElement('div');
  sparkRow.className = 'card';
  sparkRow.style.marginTop = '14px';
  sparkRow.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#e9e9ea;margin-bottom:12px">Supporting Indicators</div>
    <div class="assets-grid" id="sahm-sparklines"></div>
  `;
  panel.appendChild(sparkRow);

  const noteCard = document.createElement('div');
  noteCard.className = 'card';
  noteCard.style.marginTop = '14px';
  noteCard.innerHTML = `
    <div style="font-size:13px;font-weight:600;color:#e9e9ea;margin-bottom:10px">About This Indicator</div>
    <div style="font-size:12px;color:#a7a7ad;line-height:1.7">
      <p style="margin:0 0 10px 0">
        The <strong style="color:#e9e9ea">Sahm Rule</strong> (Claudia Sahm, 2019) identifies recession onset in real-time
        using the unemployment rate — when the 3-month average rises ≥0.5pp above its prior 12-month low.
      </p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
MA₃(t) = [UNRATE(t) + UNRATE(t−1) + UNRATE(t−2)] / 3
min₁₂(t) = min{ UNRATE over prior 12 months }
Sahm(t) = MA₃(t) − min₁₂(t)    →  Trigger: ≥ 0.50 pp</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <a href="https://fred.stlouisfed.org/series/SAHMREALTIME" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">Sahm Rule (real-time) on FRED →</a>
        <a href="https://fred.stlouisfed.org/series/UNRATE" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">UNRATE on FRED →</a>
      </div>
    </div>
  `;
  panel.appendChild(noteCard);

  requestAnimationFrame(() => {
    renderGovChart('chart-sahm', sahmSeries, {
      color:    '#a78bfa',
      height:   250,
      refLines: [{ value: 0.50, color: '#ef4444', label: 'Trigger (0.50)' }],
      legend: currentSahm
        ? [{ label: 'Sahm', color: sahmColor, value: currentSahm.value.toFixed(2) }]
        : [],
    });

    const sparkGrid = document.getElementById('sahm-sparklines');
    if (!sparkGrid) return;

    const supportSeries = [
      { id: 'ICSA',   name: 'Initial Claims',   color: '#4a9eff', pts: icsaPts,   units: 'K' },
      { id: 'CCSA',   name: 'Continued Claims', color: '#f97316', pts: ccsaPts,   units: 'K' },
      { id: 'PAYEMS', name: 'Nonfarm Payrolls', color: '#10b981', pts: payemsPts, units: 'K' },
    ];

    supportSeries.forEach(s => {
      if (!s.pts || !s.pts.length) return;
      const lastPt  = s.pts[s.pts.length - 1];
      const sparkId = `sahm-spark-${s.id.toLowerCase()}`;
      const card    = document.createElement('div');
      card.className = 'asset-card';
      card.innerHTML = `
        <div class="asset-header">
          <span class="asset-symbol" style="font-size:11px">${s.id}</span>
          <span class="asset-name">${s.name}</span>
        </div>
        <div class="asset-price-row">
          <span class="asset-price">${formatValue(lastPt.value)}</span>
        </div>
        <div class="muted" style="font-size:10px;margin-top:2px">${lastPt.date}</div>
        <svg class="asset-sparkline" id="${sparkId}" width="100%" height="52"></svg>
        <div class="muted" style="font-size:10px;text-align:right;margin-top:2px">${s.units}</div>
      `;
      sparkGrid.appendChild(card);
      requestAnimationFrame(() => {
        const svgEl = document.getElementById(sparkId);
        if (svgEl) renderSparkline(svgEl, s.pts, s.color);
      });
    });
  });
}

// =============================================================================
// INIT
// =============================================================================

async function init() {
  renderNav();
  const metaEl = document.getElementById('meta');

  try {
    const config = await fetchCache('config/fred_config.json');
    GOV_CATEGORIES = config.categories || [];

    metaEl.textContent = 'Loading series…';

    const bundle = await fetchFredBundle();
    for (const [id, rows] of Object.entries(bundle.series)) {
      allData[id] = rows.map(([date, value]) => ({ date, value }));
    }

    const loadedCount = Object.values(allData).filter(v => v && v.length > 0).length;
    const totalCount  = Object.keys(allData).length;

    let latestDate = '';
    for (const pts of Object.values(allData)) {
      if (pts && pts.length > 0) {
        const d = pts[pts.length - 1].date;
        if (d > latestDate) latestDate = d;
      }
    }

    metaEl.textContent = `${loadedCount}/${totalCount} series loaded · latest data: ${latestDate || 'unknown'}`;

    buildTabUI();
    renderedTabs.add('overview');
    renderTabContent('overview');

  } catch (err) {
    metaEl.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
