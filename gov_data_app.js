// =============================================================================
// CONFIG
// =============================================================================

let HISTORY_DAYS = 252;

let GOV_CATEGORIES = [];

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
  // Collect unique series IDs
  const seriesMap = new Map();
  for (const cat of categories) {
    for (const s of cat.series) {
      if (!seriesMap.has(s.id)) {
        seriesMap.set(s.id, s);
      }
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
  if (pts.length < 2) {
    svgEl.innerHTML = '';
    return;
  }

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

  const cardId = `gov-card-${series.id.toLowerCase()}`;
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

function renderCategory(cat, allData) {
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
    const points = allData[s.id] || [];
    const card = renderSeriesCard(s, points, cat.color);
    grid.appendChild(card);
  }

  return section;
}

// =============================================================================
// RE-RENDER SPARKLINES ON HISTORY CHANGE
// =============================================================================

function reRenderAllSparklines(allData) {
  for (const cat of GOV_CATEGORIES) {
    for (const s of cat.series) {
      const sparkId = `gov-spark-${s.id.toLowerCase()}`;
      const svgEl = document.getElementById(sparkId);
      const points = allData[s.id];
      if (svgEl && points && points.length >= 2) {
        renderSparkline(svgEl, points, cat.color);
      }
    }
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const metaEl = document.getElementById('meta');
  const container = document.getElementById('gov-categories');

  try {
    await loadConfig();

    metaEl.textContent = 'Loading series…';
    const allData = await loadAllCsvs(GOV_CATEGORIES);

    // Count loaded series
    const loadedCount = Object.values(allData).filter(v => v && v.length > 0).length;
    const totalCount  = Object.keys(allData).length;

    // Find most recent date across all series
    let latestDate = '';
    for (const pts of Object.values(allData)) {
      if (pts && pts.length > 0) {
        const d = pts[pts.length - 1].date;
        if (d > latestDate) latestDate = d;
      }
    }

    metaEl.textContent = `${loadedCount}/${totalCount} series loaded · latest data: ${latestDate || 'unknown'}`;

    // Render categories
    container.innerHTML = '';
    for (const cat of GOV_CATEGORIES) {
      container.appendChild(renderCategory(cat, allData));
    }

    // Wire history dropdown
    document.getElementById('historySelect').addEventListener('change', e => {
      HISTORY_DAYS = parseInt(e.target.value, 10);
      reRenderAllSparklines(allData);
    });

  } catch (err) {
    metaEl.textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

main();
