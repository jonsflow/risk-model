// =============================================================================
// CONFIG
// =============================================================================

let HISTORY_DAYS = 252;
let GOV_CATEGORIES = [];
let activeTab = 'overview';
let allData = {};

const TAB_DEFS = [
  { id: 'overview', label: 'Overview'    },
  { id: 'jpmorgan', label: 'JPMorgan'   },
  { id: 'nyfed',    label: 'NY Fed'     },
  { id: 'nfci',     label: 'Fed / NFCI' },
  { id: 'sahm',     label: 'Sahm Rule'  },
];

// =============================================================================
// DATA LOADING
// =============================================================================

async function loadConfig() {
  const r = await fetch('./fred_config.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to load fred_config.json: ${r.status}`);
  const config = await r.json();
  GOV_CATEGORIES = config.categories || [];
  return config;
}

async function loadFredCsv(seriesId) {
  const path = `./data/fred/${seriesId}.csv`;
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

async function loadAllCsvs(categories) {
  const seriesMap = new Map();
  for (const cat of categories) {
    for (const s of cat.series) {
      if (!seriesMap.has(s.id)) seriesMap.set(s.id, s);
    }
  }

  const results = {};
  await Promise.all(
    Array.from(seriesMap.keys()).map(async (id) => {
      try {
        results[id] = await loadFredCsv(id);
      } catch (e) {
        console.warn(`Could not load ${id}: ${e.message}`);
        results[id] = null;
      }
    })
  );
  return results;
}

// Load all FRED series from the pre-built bundle (1 request vs 20).
// Falls back to individual CSVs for local dev before the cache exists.
async function loadFredData() {
  try {
    const r = await fetch('./data/fred/fred_cache.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bundle = await r.json();
    const results = {};
    for (const [id, rows] of Object.entries(bundle.series)) {
      results[id] = rows.map(([date, value]) => ({ date, value }));
    }
    console.log(`Loaded fred_cache.json (${Object.keys(results).length} series, fetched ${bundle.fetched_at})`);
    return results;
  } catch (e) {
    console.warn(`fred_cache.json unavailable (${e.message}), falling back to individual CSVs`);
    return loadAllCsvs(GOV_CATEGORIES);
  }
}

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

function computeStats(points, display, freq) {
  if (!points || points.length < 2) {
    return { displayValue: 'N/A', displayLabel: '', change: null, changeStr: '', chgLabel: '' };
  }

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
      const yoy = ((current.value - priorPt.value) / Math.abs(priorPt.value)) * 100;
      const sign = yoy >= 0 ? '+' : '';
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
      const mom = ((current.value - prior.value) / Math.abs(prior.value)) * 100;
      const sign = mom >= 0 ? '+' : '';
      return {
        displayValue: `${sign}${mom.toFixed(2)}%`,
        displayLabel: 'MoM',
        change: mom,
        changeStr: '',
        chgLabel,
      };
    }
    return { displayValue: 'N/A', displayLabel: 'MoM', change: null, changeStr: '', chgLabel };
  }

  // level — raw value + freq-appropriate absolute change
  const prior = findPriorPoint(points, current.date, lookbackDays);
  const absChange = prior !== null ? current.value - prior.value : null;
  return {
    displayValue: formatValue(current.value),
    displayLabel: '',
    change: absChange,
    changeStr: absChange !== null ? `${absChange >= 0 ? '+' : ''}${formatValue(absChange)}` : '',
    chgLabel,
  };
}

function formatValue(v) {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 10)   return v.toFixed(2);
  return v.toFixed(3);
}

// =============================================================================
// SPARKLINE RENDERING
// =============================================================================

function renderSparkline(svgEl, points, color) {
  const W = svgEl.clientWidth || svgEl.getBoundingClientRect().width || 220;
  const H = 52;
  const PAD = { top: 3, right: 3, bottom: 3, left: 3 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const pts = points.slice(Math.max(0, points.length - HISTORY_DAYS));
  if (pts.length < 2) { svgEl.innerHTML = ''; return; }

  const values = pts.map(p => p.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const valRange = maxVal - minVal || 1;

  const n = pts.length;
  const xS = i => PAD.left + (i / (n - 1)) * cw;
  const yS = v => PAD.top + ch - ((v - minVal) / valRange) * ch;
  const bottomY = PAD.top + ch;

  const pricePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xS(i).toFixed(1)} ${yS(p.value).toFixed(1)}`).join(' ');
  const priceArea = `${pricePath} L ${xS(n - 1).toFixed(1)} ${bottomY} L ${xS(0).toFixed(1)} ${bottomY} Z`;

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.innerHTML = `
    <path d="${priceArea}" fill="${color}" opacity="0.15"/>
    <path d="${pricePath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  `;
}

// =============================================================================
// CARD & CATEGORY RENDERING
// =============================================================================

function renderSeriesCard(series, points, color) {
  const stats = computeStats(points, series.display, series.freq);

  const changeClass = stats.change === null ? '' : (stats.change >= 0 ? 'positive' : 'negative');
  const changeHTML = stats.changeStr
    ? `<span class="asset-change ${changeClass}" title="${stats.chgLabel}">${stats.changeStr} <span style="font-size:9px;opacity:0.7">${stats.chgLabel}</span></span>`
    : '';

  const labelHTML = stats.displayLabel
    ? `<span class="muted" style="font-size:11px;margin-left:4px">${stats.displayLabel}</span>`
    : '';

  const latestDate = points && points.length > 0 ? points[points.length - 1].date : '';
  const dateHTML = latestDate
    ? `<div class="muted" style="font-size:10px;margin-top:2px">${latestDate}</div>`
    : '';

  const cardId  = `gov-card-${series.id.toLowerCase()}`;
  const sparkId = `gov-spark-${series.id.toLowerCase()}`;

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
    <svg class="asset-sparkline" id="${sparkId}" height="52"></svg>
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
      const svgEl = document.getElementById(sparkId);
      const points = data[s.id];
      if (svgEl && points && points.length >= 2) {
        renderSparkline(svgEl, points, cat.color);
      }
    }
  }
}

// =============================================================================
// TAB SYSTEM
// =============================================================================

function buildTabUI() {
  const container = document.getElementById('tab-container');
  const bar = TAB_DEFS.map(t =>
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

const renderedTabs = new Set();

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
    case 'jpmorgan': renderJPMorganTab(panel); break;
    case 'nyfed':    renderNYFedTab(panel);    break;
    case 'nfci':     renderNFCITab(panel);     break;
    case 'sahm':     renderSahmTab(panel);     break;
  }
}

// =============================================================================
// TAB 1: OVERVIEW
// =============================================================================

function renderOverviewTab(panel) {
  // Chart history dropdown inside the overview panel
  const controls = document.createElement('div');
  controls.className = 'card';
  controls.style.marginTop = '18px';
  controls.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div class="pill">
        <div class="muted">Chart History</div>
        <select id="historySelect" class="control-select">
          <option value="252" ${HISTORY_DAYS === 252 ? 'selected' : ''}>1 year</option>
          <option value="504" ${HISTORY_DAYS === 504 ? 'selected' : ''}>2 years</option>
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

function rollingPercentile(points, windowSize, currentValue) {
  const recent = points.slice(Math.max(0, points.length - windowSize));
  const below = recent.filter(p => p.value < currentValue).length;
  return Math.round((below / recent.length) * 100);
}

// Compute z-score of most recent MoM change vs ~1yr of MoM changes
function computeMoMZScore(points, lookback) {
  if (!points || points.length < lookback + 2) return 0;
  const recent = points.slice(-lookback);
  const changes = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1].value !== 0) {
      changes.push((recent[i].value - recent[i - 1].value) / Math.abs(recent[i - 1].value));
    }
  }
  if (changes.length < 2) return 0;
  const lastChange = changes[changes.length - 1];
  const mean = changes.reduce((s, v) => s + v, 0) / changes.length;
  const std = Math.sqrt(changes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / changes.length);
  return std === 0 ? 0 : (lastChange - mean) / std;
}

// Convert z-score to 0–100 risk score (positive z = growing = lower risk)
function zToRiskScore(z) {
  return Math.round(clamp(50 - z * 15, 5, 95));
}

// ── Factor scorers ──────────────────────────────────────────────────────────

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
  const current = bamlPts[bamlPts.length - 1].value;
  return rollingPercentile(bamlPts, 1260, current); // 5yr daily window
}

function scoreEconomicMomentum(indproPts, rsafsPts) {
  const indproZ = computeMoMZScore(indproPts || [], 13);
  const rsafsZ  = computeMoMZScore(rsafsPts  || [], 13);
  return zToRiskScore((indproZ + rsafsZ) / 2);
}

function scoreLaborMarket(payemsPts, unratePts) {
  const payemsZ     = computeMoMZScore(payemsPts || [], 13);
  const payemsScore = zToRiskScore(payemsZ);

  // Sahm-like modifier from UNRATE
  let sahmModifier = 0;
  if (unratePts && unratePts.length >= 12) {
    const n    = unratePts.length;
    const ma3  = (unratePts[n-1].value + unratePts[n-2].value + unratePts[n-3].value) / 3;
    const min12 = Math.min(...unratePts.slice(n-12, n).map(p => p.value));
    const sahmVal = ma3 - min12;
    if (sahmVal >= 0.3) sahmModifier = 20;
    else if (sahmVal < 0) sahmModifier = -10;
  }

  return Math.round(clamp(payemsScore + sahmModifier, 5, 95));
}

function scoreFinancialConditions(vixPts, nfciPts) {
  const vixScore = vixPts && vixPts.length > 1
    ? rollingPercentile(vixPts, 1260, vixPts[vixPts.length - 1].value)
    : 50;

  const nfciScore = nfciPts && nfciPts.length > 1
    ? Math.round(clamp(50 + nfciPts[nfciPts.length - 1].value * 30, 5, 95))
    : 50;

  return Math.round((vixScore + nfciScore) / 2);
}

// =============================================================================
// LIGHTWEIGHT CHARTS HELPER
// =============================================================================

const govCharts = {};

function destroyGovChart(id) {
  if (govCharts[id]) {
    try { govCharts[id].remove(); } catch (e) {}
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

  const { LineSeries, AreaSeries, BaselineSeries } = window.LightweightCharts;

  const chart = ChartUtils.createDashboardChart(container, height, {
    grid: { vertLines: { color: '#2a2b2f' }, horzLines: { color: '#2a2b2f' } },
  });

  govCharts[containerId] = chart;

  const data = points.map(p => ({ time: p.date, value: p.value }));
  let series;

  const LC = window.LightweightCharts;

  if (opts.baseline !== undefined && typeof BaselineSeries !== 'undefined') {
    series = chart.addSeries(BaselineSeries, {
      baseValue:        { type: 'price', price: opts.baseline },
      topLineColor:     '#ef4444',
      topFillColor1:    'rgba(239,68,68,0.3)',
      topFillColor2:    'rgba(239,68,68,0.0)',
      bottomLineColor:  '#10b981',
      bottomFillColor1: 'rgba(16,185,129,0.0)',
      bottomFillColor2: 'rgba(16,185,129,0.3)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
  } else {
    series = chart.addSeries(AreaSeries, {
      lineColor:   color,
      topColor:    ChartUtils.hexToRgba(color, 0.3),
      bottomColor: ChartUtils.hexToRgba(color, 0),
      lineWidth: 2,
      priceLineVisible: true,
      priceLineStyle:   LC.LineStyle.Dashed,
      lastValueVisible: true,
    });
  }

  series.setData(data);

  if (opts.refLines) {
    for (const ref of opts.refLines) {
      series.createPriceLine({
        price: ref.value,
        color: ref.color || '#ef4444',
        lineWidth: 1,
        lineStyle: 2, // Dashed
        axisLabelVisible: true,
        title: ref.label || '',
      });
    }
  }

  ChartUtils.fitWithRightPadding(chart, data.length);

  if (opts.legend) {
    ChartUtils.addChartLegend(containerId, opts.legend);
  }

  return chart;
}

// =============================================================================
// TAB 2: JPMORGAN
// =============================================================================

function renderJPMorganTab(panel) {
  const factors = [
    {
      name:   'Yield Curve',
      proxy:  'T10Y2Y',
      color:  '#4a9eff',
      score:  scoreYieldCurve(allData['T10Y2Y']),
      points: allData['T10Y2Y'] || [],
    },
    {
      name:   'Credit Stress',
      proxy:  'BAMLH0A0HYM2',
      color:  '#f97316',
      score:  scoreCreditStress(allData['BAMLH0A0HYM2']),
      points: allData['BAMLH0A0HYM2'] || [],
    },
    {
      name:   'Economic Momentum',
      proxy:  'INDPRO + RSAFS',
      color:  '#10b981',
      score:  scoreEconomicMomentum(allData['INDPRO'], allData['RSAFS']),
      points: allData['INDPRO'] || [],
    },
    {
      name:   'Labor Market',
      proxy:  'PAYEMS + UNRATE',
      color:  '#a78bfa',
      score:  scoreLaborMarket(allData['PAYEMS'], allData['UNRATE']),
      points: allData['PAYEMS'] || [],
    },
    {
      name:   'Financial Conditions',
      proxy:  'VIXCLS + NFCI',
      color:  '#f59e0b',
      score:  scoreFinancialConditions(allData['VIXCLS'], allData['NFCI']),
      points: allData['VIXCLS'] || [],
    },
  ];

  const composite = Math.round(factors.reduce((s, f) => s + f.score, 0) / factors.length);
  const cColor = scoreColor(composite);
  const cLabel = scoreLabel(composite);

  // Composite score card
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

  // Factor cards
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
      <p style="margin:0 0 6px 0;font-size:11px">
        A positive spread signals normal credit transmission; inversion historically precedes recession by 12–18 months.
        Score is a step function at key structural breakpoints:
      </p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
T10Y2Y > +0.5%   →  score 10   (normal, credit intermediation intact)
T10Y2Y  0–0.5%   →  score 35   (flattening, watch closely)
T10Y2Y −1–0%     →  score 65   (inverted, recessionary signal)
T10Y2Y < −1%     →  score 90   (deeply inverted, high recession risk)</div>

      <p style="margin:0 0 6px 0"><strong style="color:#f97316">② Credit Stress — BAMLH0A0HYM2</strong></p>
      <p style="margin:0 0 6px 0;font-size:11px">
        ICE BofA US High Yield Option-Adjusted Spread. Widens sharply when credit markets price in default risk.
        Scored as a rolling percentile rank vs the past 5 years (~1,260 daily observations):
      </p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
score_CS = percentile_rank(HY_OAS_current, 5yr window)

e.g.: OAS at 5-year low  → score ~5  (tight, risk-on)
      OAS at 5-year median → score ~50 (neutral)
      OAS at 5-year high  → score ~95 (stressed, risk-off)</div>

      <p style="margin:0 0 6px 0"><strong style="color:#10b981">③ Economic Momentum — INDPRO + RSAFS</strong></p>
      <p style="margin:0 0 6px 0;font-size:11px">
        Month-over-month changes in industrial production and retail sales, z-scored against 1 year of MoM history,
        then averaged and mapped to a risk scale where positive growth = lower risk:
      </p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
MoM_i   = (x_t − x_{t−1}) / |x_{t−1}|
z_i     = (MoM_i − μ_{1yr}) / σ_{1yr}
z_avg   = (z_INDPRO + z_RSAFS) / 2
score_EM = clamp(50 − z_avg × 15, 5, 95)

e.g.: z = +2 (strong growth) → score 20  (low risk)
      z =  0 (trend growth)  → score 50  (neutral)
      z = −2 (contraction)   → score 80  (high risk)</div>

      <p style="margin:0 0 6px 0"><strong style="color:#a78bfa">④ Labor Market — PAYEMS + UNRATE</strong></p>
      <p style="margin:0 0 6px 0;font-size:11px">
        Payroll momentum z-score plus a Sahm-rule-inspired modifier based on the unemployment rate trend:
      </p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
z_payems    = (MoM_PAYEMS − μ_{1yr}) / σ_{1yr}
base_score  = clamp(50 − z_payems × 15, 5, 95)

sahm_proxy  = MA₃(UNRATE) − min₁₂(UNRATE)
modifier    = +20 if sahm_proxy ≥ 0.3   (labor deteriorating)
            = −10 if sahm_proxy < 0     (labor tightening)
            =   0 otherwise

score_LM = clamp(base_score + modifier, 5, 95)</div>

      <p style="margin:0 0 6px 0"><strong style="color:#f59e0b">⑤ Financial Conditions — VIXCLS + NFCI</strong></p>
      <p style="margin:0 0 6px 0;font-size:11px">
        VIX captures near-term implied volatility (fear gauge); NFCI captures broad systemic tightness.
        Both are percentile-ranked or z-score rescaled, then averaged:
      </p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
score_VIX  = percentile_rank(VIX, 5yr window)
score_NFCI = clamp(50 + NFCI × 30, 5, 95)
score_FC   = (score_VIX + score_NFCI) / 2

NFCI examples:  −0.5 → score 35 · 0 → 50 · +0.5 → 65 · +1.0 → 80</div>

      <p style="margin:0 0 8px 0;font-size:11px">
        This is an approximation of the JPMorgan methodology; the official model uses additional proprietary inputs
        and may apply dynamic weights based on the macro regime.
      </p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <a href="https://am.jpmorgan.com/us/en/asset-management/adv/insights/market-insights/guide-to-the-markets/" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">JPMorgan Guide to the Markets →</a>
        <a href="https://fred.stlouisfed.org/series/T10Y2Y" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">T10Y2Y on FRED →</a>
        <a href="https://fred.stlouisfed.org/series/BAMLH0A0HYM2" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">HY OAS on FRED →</a>
        <a href="https://fred.stlouisfed.org/series/NFCI" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">NFCI on FRED →</a>
      </div>
    </div>
  `;
  panel.appendChild(note);
}

// =============================================================================
// TAB 3: NY FED
// =============================================================================

function standardNormalCDF(x) {
  // Abramowitz & Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x >= 0 ? 1 - p : p;
}

function recessionProb(spread) {
  return standardNormalCDF(-0.5333 - 0.6330 * spread) * 100;
}

function probLabel(prob) {
  if (prob < 15) return 'Low';
  if (prob < 30) return 'Moderate';
  if (prob < 50) return 'Elevated';
  if (prob < 70) return 'High';
  return 'Very High';
}

function probColor(prob) {
  if (prob < 15) return '#10b981';
  if (prob < 30) return '#84cc16';
  if (prob < 50) return '#f59e0b';
  if (prob < 70) return '#f97316';
  return '#ef4444';
}

function renderNYFedTab(panel) {
  const t10y2yPts  = allData['T10Y2Y'] || [];
  const probSeries = t10y2yPts.map(p => ({
    date:  p.date,
    value: parseFloat(recessionProb(p.value).toFixed(2)),
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
        The <strong style="color:#e9e9ea">New York Fed Recession Probability Model</strong> is a probit regression
        published monthly by the Federal Reserve Bank of New York since 1996. It estimates the probability that the
        U.S. economy will be in recession 12 months ahead, using the yield curve spread as the sole predictor.
        Developed by Arturo Estrella and Frederic Mishkin (1996), the model demonstrated that the Treasury yield
        spread is among the most reliable and parsimonious leading recession indicators available.
      </p>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Probit model formula:</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
P(recession in 12 months | spread) = Φ(α + β × spread)

α = −0.5333   (intercept)
β = −0.6330   (coefficient — negative because inversion raises probability)
Φ = standard normal CDF

Intuition: each 1pp of additional inversion raises probability by ~Φ′ × 0.6330
           At spread = 0 (flat curve): P ≈ Φ(−0.5333) ≈ 21%</div>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">CDF approximation used (Abramowitz &amp; Stegun §26.2.17):</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
t = 1 / (1 + 0.2316419 × |x|)
φ(x) = (1/√2π) × e^(−x²/2)          [standard normal PDF]
Φ(x) ≈ 1 − φ(x) × t × (b₁ + b₂t + b₃t² + b₄t³ + b₅t⁴)

Coefficients:  b₁ = 0.319382   b₂ = −0.356564   b₃ = 1.781478
               b₄ = −1.821256  b₅ = 1.330274
Max error: |ε| &lt; 7.5 × 10⁻⁸</div>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Spread → probability lookup:</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
Spread    Probability   Signal
+2.0%  →     3%        Very low
+1.0%  →     8%        Low
+0.5%  →    14%        Low
 0.0%  →    21%        Moderate  ← flat curve baseline
−0.5%  →    30%        Watch
−1.0%  →    42%        Elevated
−1.5%  →    55%        High
−2.0%  →    67%        Very high
−3.0%  →    85%        Extreme</div>

      <p style="margin:0 0 10px 0"><strong style="color:#e9e9ea">Proxy note:</strong>
        The official NY Fed model uses the <strong>10Y minus 3-month</strong> spread (T10Y3M, available on FRED).
        This dashboard substitutes <strong>T10Y2Y</strong> because it is more widely traded, widely quoted by markets,
        and available with a longer FRED history. Probabilities will differ from the official NY Fed publication —
        treat this as directionally indicative, not a precise replication.
      </p>

      <p style="margin:0 0 8px 0"><strong style="color:#e9e9ea">Historical track record:</strong>
        The model signaled elevated risk before every U.S. recession since the 1960s with no false positives through 2006.
        It crossed 30% in 2006 ahead of the 2007–09 GFC and briefly in early 2020 before the COVID recession.
        The 2022–23 inversion pushed probabilities above 50% — the highest reading since 2007 — though no
        NBER-dated recession had been declared through early 2025.
      </p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <a href="https://www.newyorkfed.org/research/capital_markets/ycfaq" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">NY Fed Yield Curve FAQ →</a>
        <a href="https://www.newyorkfed.org/research/recession_probability" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">NY Fed Recession Probability (official) →</a>
        <a href="https://fred.stlouisfed.org/series/T10Y2Y" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">T10Y2Y on FRED →</a>
        <a href="https://fred.stlouisfed.org/series/T10Y3M" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">T10Y3M on FRED (official input) →</a>
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
  const nfciPts   = allData['NFCI']           || [];
  const bamlPts   = allData['BAMLH0A0HYM2']   || [];
  const t10y2yPts = allData['T10Y2Y']          || [];
  const vixPts    = allData['VIXCLS']          || [];
  const unratePts = allData['UNRATE']          || [];

  const currentNFCI = nfciPts.length     ? nfciPts[nfciPts.length - 1]     : null;
  const priorNFCI   = nfciPts.length >= 5 ? nfciPts[nfciPts.length - 5]   : null;

  // Fed composite score
  const creditPct = bamlPts.length > 1
    ? rollingPercentile(bamlPts, 1260, bamlPts[bamlPts.length - 1].value) : 50;
  const ycScore   = scoreYieldCurve(t10y2yPts);
  const vixPct    = vixPts.length > 1
    ? rollingPercentile(vixPts, 1260, vixPts[vixPts.length - 1].value) : 50;
  const urScore   = unratePts.length > 1
    ? Math.round(clamp(50 + (unratePts[unratePts.length - 1].value - 4) * 8, 5, 95)) : 50;
  const fedScore  = Math.round(0.35 * creditPct + 0.30 * ycScore + 0.20 * vixPct + 0.15 * urScore);
  const fsColor   = scoreColor(fedScore);
  const fsLabel   = scoreLabel(fedScore);

  const nfciTight = currentNFCI && currentNFCI.value > 0;
  const nfciColor = currentNFCI ? (nfciTight ? '#ef4444' : '#10b981') : '#a7a7ad';
  const nfciLabel = currentNFCI ? (nfciTight ? 'Tighter than avg' : 'Looser than avg') : 'N/A';
  const nfci4wkChg = (currentNFCI && priorNFCI) ? currentNFCI.value - priorNFCI.value : null;
  const chgColor = nfci4wkChg === null ? '#a7a7ad' : nfci4wkChg > 0 ? '#ef4444' : '#10b981';

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
        by the Federal Reserve Bank of Chicago (Brave &amp; Butters, 2011). It aggregates <strong>105 financial
        indicators</strong> spanning money markets, debt and equity markets, and traditional and shadow banking
        into a single z-score benchmarked against the average since 1971.
      </p>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Construction (dynamic factor model):</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
NFCI_t = Σᵢ wᵢ × zᵢ_t          [weighted sum of 105 normalized indicators]

zᵢ_t = (xᵢ_t − μᵢ) / σᵢ        [each indicator normalized to mean 0, std 1]

Weights wᵢ estimated via a dynamic factor model (Kalman filter)
that maximizes the common variance explained across all 105 series.

Reference level: 0 = average conditions 1971–present
Interpretation:  positive → tighter than avg · negative → looser than avg</div>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Three sub-indices (each its own factor):</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
Risk      (~45 series) — implied volatility, bid-ask spreads, funding stress,
                          interbank rates, CDS spreads, equity realized vol
Credit    (~30 series) — yield spreads (IG, HY, MBS, ABS), lending standards,
                          securitization volumes, commercial paper rates
Leverage  (~30 series) — debt-to-asset ratios, repo market activity,
                          broker-dealer leverage, shadow banking balance sheets</div>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Historical reference levels:</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
NFCI     Conditions          Historical context
−1.0     Very loose          Post-GFC QE era (2012–13, 2020–21)
−0.5     Loose               Late-cycle bull markets
 0.0     Average             Neutral baseline (1971 avg)
+0.5     Mildly tight        Early hiking cycles
+1.0     Tight               Recession onset territory
+2.0     Severely tight      GFC peak (Oct 2008), COVID shock (Mar 2020)
+5.0+    Crisis              1974, 1980, 2008 extremes</div>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Dashboard composite score formula:</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
S = 0.35 × credit_pct + 0.30 × yc_score + 0.20 × vix_pct + 0.15 × ur_score

credit_pct = percentile_rank(BAMLH0A0HYM2, 5yr)     [0–100]
yc_score   = step_function(T10Y2Y)                    [10/35/65/90]
vix_pct    = percentile_rank(VIXCLS, 5yr)             [0–100]
ur_score   = clamp(50 + (UNRATE − 4.0) × 8, 5, 95)  [anchored at 4% natural rate]

Note: not an official Federal Reserve model — simplified approximation only.</div>

      <p style="margin:0 0 8px 0">
        The <strong style="color:#e9e9ea">Adjusted NFCI (ANFCI)</strong> removes the portion of NFCI explained by
        current economic conditions, isolating purely financial factors. The ANFCI tends to lead the standard NFCI
        at turning points and is available on FRED. This dashboard uses the standard NFCI.
      </p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <a href="https://www.chicagofed.org/research/data/nfci/current-data" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">Chicago Fed NFCI (current data) →</a>
        <a href="https://www.chicagofed.org/research/data/nfci/about" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">NFCI methodology →</a>
        <a href="https://fred.stlouisfed.org/series/NFCI" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">NFCI on FRED →</a>
        <a href="https://fred.stlouisfed.org/series/ANFCI" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">ANFCI (adjusted) on FRED →</a>
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

  // Supporting sparklines row
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
        The <strong style="color:#e9e9ea">Sahm Rule</strong> was developed by economist
        <strong style="color:#e9e9ea">Claudia Sahm</strong> (former Federal Reserve economist, now at Bloomberg)
        as a simple, real-time recession indicator using only the unemployment rate. It was introduced in her 2019
        Brookings paper <em>"Direct Stimulus Payments to Individuals"</em> as a trigger for automatic fiscal
        stabilizers — releasing funds the moment a recession begins rather than waiting for NBER confirmation,
        which typically arrives 6–18 months after the fact.
      </p>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Formula:</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
MA₃(t) = [UNRATE(t) + UNRATE(t−1) + UNRATE(t−2)] / 3

min₁₂(t) = min{ UNRATE(t), UNRATE(t−1), ..., UNRATE(t−11) }

Sahm(t) = MA₃(t) − min₁₂(t)          [in percentage points]

Trigger: Sahm(t) ≥ 0.50 pp

Intuition: unemployment rising ≥ 0.5pp above its recent low
           signals a self-reinforcing deterioration in labor markets.</div>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Historical trigger record:</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
Recession          Triggered      Peak Sahm    NBER start
─────────────────────────────────────────────────────────
1969–70 recession  Dec 1969        ~1.3 pp     Dec 1969
1973–75 recession  Mar 1974        ~3.8 pp     Nov 1973
1980 recession     Apr 1980        ~2.0 pp     Jan 1980
1981–82 recession  Aug 1981        ~2.4 pp     Jul 1981
1990–91 recession  Aug 1990        ~1.3 pp     Jul 1990
2001 recession     Apr 2001        ~1.0 pp     Mar 2001
2007–09 recession  Jul 2008        ~5.7 pp     Dec 2007
2020 recession     Apr 2020       ~11.3 pp     Feb 2020
2024 (near-miss)   not triggered   ~0.43 pp    —</div>

      <p style="margin:0 0 10px 0">
        <strong style="color:#e9e9ea">Why it works mechanically:</strong>
        Unemployment rises slowly at first — marginal layoffs, voluntary turnover drying up.
        But once the 3-month average exceeds a recent 12-month low by 0.5pp, it has historically
        reflected self-reinforcing layoff cycles, not noise. The 12-month min anchors the baseline
        to the labor market's recent best state, making the signal regime-agnostic.
        The rule is <em>contemporaneous</em> — it identifies recession onset as it happens, not forecasts.
      </p>

      <p style="margin:0 0 6px 0"><strong style="color:#e9e9ea">Supporting indicator interpretation:</strong></p>
      <div style="background:#0d0e11;border:1px solid #2a2b2f;border-radius:6px;padding:10px 14px;font-family:'SF Mono',Consolas,monospace;font-size:11px;color:#e9e9ea;margin:0 0 12px 0;line-height:1.8">
ICSA (Initial Claims, weekly)
  → First to move. Spikes signal new layoff waves.
  → Watch level: sustained above 300K is historically concerning.
  → Released every Thursday for prior week.

CCSA (Continued Claims, weekly)
  → Measures difficulty of finding re-employment.
  → Rising CCSA after stable ICSA = workers stuck unemployed.
  → Lags ICSA by ~1–2 weeks.

PAYEMS (Nonfarm Payrolls, monthly)
  → Broadest labor demand measure (~80% of workforce).
  → Negative prints are rare outside recessions.
  → Often revised — first print is noisy, 3-month trend matters.</div>

      <p style="margin:0 0 8px 0">
        <strong style="color:#e9e9ea">2024 near-miss context:</strong>
        The Sahm indicator rose to ~0.43 in mid-2024, sparking widespread recession debate. Claudia Sahm
        herself cautioned that post-pandemic immigration-driven labor supply growth may have dampened
        unemployment sensitivity, potentially raising the practical trigger threshold. The indicator
        subsequently fell back as the labor market stabilized.
      </p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <a href="https://fred.stlouisfed.org/series/SAHMREALTIME" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">Sahm Rule (real-time) on FRED →</a>
        <a href="https://fred.stlouisfed.org/series/UNRATE" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">UNRATE on FRED →</a>
        <a href="https://fred.stlouisfed.org/series/ICSA" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">Initial Claims on FRED →</a>
        <a href="https://www.brookings.edu/articles/direct-stimulus-payments-to-individuals/" target="_blank" rel="noopener" style="color:#7aa2f7;text-decoration:none;font-size:11px">Sahm (2019) original paper →</a>
      </div>
    </div>
  `;
  panel.appendChild(noteCard);

  requestAnimationFrame(() => {
    renderGovChart('chart-sahm', sahmSeries, {
      color:    '#a78bfa',
      height:   250,
      refLines: [
        { value: 0.50, color: '#ef4444', label: 'Trigger (0.50)' },
      ],
      legend: currentSahm
        ? [{ label: 'Sahm', color: sahmColor, value: currentSahm.value.toFixed(2) }]
        : [],
    });

    // Supporting sparkline mini-cards
    const sparkGrid = document.getElementById('sahm-sparklines');
    if (!sparkGrid) return;

    const supportSeries = [
      { id: 'ICSA',   name: 'Initial Claims',   color: '#4a9eff',  pts: icsaPts,   units: 'K' },
      { id: 'CCSA',   name: 'Continued Claims', color: '#f97316',  pts: ccsaPts,   units: 'K' },
      { id: 'PAYEMS', name: 'Nonfarm Payrolls', color: '#10b981',  pts: payemsPts, units: 'K' },
    ];

    supportSeries.forEach(s => {
      if (!s.pts || !s.pts.length) return;
      const last    = s.pts[s.pts.length - 1];
      const sparkId = `sahm-spark-${s.id.toLowerCase()}`;
      const card    = document.createElement('div');
      card.className = 'asset-card';
      card.innerHTML = `
        <div class="asset-header">
          <span class="asset-symbol" style="font-size:11px">${s.id}</span>
          <span class="asset-name">${s.name}</span>
        </div>
        <div class="asset-price-row">
          <span class="asset-price">${formatValue(last.value)}</span>
        </div>
        <div class="muted" style="font-size:10px;margin-top:2px">${last.date}</div>
        <svg class="asset-sparkline" id="${sparkId}" height="52"></svg>
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
// MAIN
// =============================================================================

async function main() {
  const metaEl = document.getElementById('meta');

  try {
    await loadConfig();
    metaEl.textContent = 'Loading series…';
    allData = await loadFredData();

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

    // Render the initial (overview) tab
    renderedTabs.add('overview');
    renderTabContent('overview');

  } catch (err) {
    metaEl.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

main();
