// =============================================================================
// CONFIG
// =============================================================================

let LOOKBACK_DAYS = 20;
let MA_PERIOD = 50;

let MACRO_CATEGORIES = [];

// =============================================================================
// UTILITIES
// =============================================================================

async function loadLastUpdated() {
  try {
    const r = await fetch('./data/last_updated.txt', { cache: "no-store" });
    if (!r.ok) return "unknown";
    const utcString = await r.text();
    const utcDate = new Date(utcString.replace(' UTC', 'Z').replace(' ', 'T'));
    return utcDate.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
  } catch (err) {
    return "unknown";
  }
}

function last(arr, n) {
  return arr.slice(Math.max(0, arr.length - n));
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

async function loadConfig() {
  const r = await fetch('./macro_config.json', { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to load macro_config.json: ${r.status}`);
  const config = await r.json();
  MACRO_CATEGORIES = config.macro_categories || [];
  console.log(`Loaded macro config: ${MACRO_CATEGORIES.length} categories`);
  return config;
}

// =============================================================================
// SPARKLINE RENDERING
// =============================================================================

function renderSparkline(svgEl, pts, maPoints, color) {
  const W = svgEl.clientWidth || svgEl.getBoundingClientRect().width || 220;
  const H = 52;
  const PAD = { top: 3, right: 3, bottom: 3, left: 3 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  // Use recent window for display
  const recentPts = last(pts, LOOKBACK_DAYS);
  if (recentPts.length < 2) {
    svgEl.innerHTML = '';
    return;
  }

  // Filter MA to the display window
  const windowStart = recentPts[0][0];
  const recentMA = maPoints.filter(p => p[0] >= windowStart);

  // Combined price + MA values for unified y-scale
  const allValues = [
    ...recentPts.map(p => p[1]),
    ...recentMA.map(p => p[1])
  ];
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const valRange = maxVal - minVal || 1;

  const times = recentPts.map(p => p[0]);
  const minTime = times[0];
  const maxTime = times[times.length - 1];
  const timeRange = maxTime - minTime || 1;

  const xS = t => PAD.left + ((t - minTime) / timeRange) * cw;
  const yS = v => PAD.top + ch - ((v - minVal) / valRange) * ch;
  const topY    = PAD.top;
  const bottomY = PAD.top + ch;

  // Price line path
  const pricePath = recentPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xS(p[0]).toFixed(1)} ${yS(p[1]).toFixed(1)}`).join(' ');

  // Price area polygon (closed at the bottom)
  const x0 = xS(recentPts[0][0]).toFixed(1);
  const xN = xS(recentPts[recentPts.length - 1][0]).toFixed(1);
  const priceArea = `${pricePath} L ${xN} ${bottomY} L ${x0} ${bottomY} Z`;

  // MA path + area-based clip paths for green/red shading
  let maPath = '';
  let areaSVG = '';

  if (recentMA.length >= 2) {
    maPath = recentMA.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xS(p[0]).toFixed(1)} ${yS(p[1]).toFixed(1)}`).join(' ');

    const mX0 = xS(recentMA[0][0]).toFixed(1);
    const mXN = xS(recentMA[recentMA.length - 1][0]).toFixed(1);

    const aboveClip = `${maPath} L ${mXN} ${topY} L ${mX0} ${topY} Z`;
    const belowClip = `${maPath} L ${mXN} ${bottomY} L ${mX0} ${bottomY} Z`;

    const uid = svgEl.id;
    areaSVG = `
      <defs>
        <clipPath id="cp-above-${uid}"><path d="${aboveClip}"/></clipPath>
        <clipPath id="cp-below-${uid}"><path d="${belowClip}"/></clipPath>
      </defs>
      <path d="${priceArea}" fill="rgba(16,185,129,0.18)" clip-path="url(#cp-above-${uid})"/>
      <path d="${priceArea}" fill="rgba(239,68,68,0.18)"  clip-path="url(#cp-below-${uid})"/>
    `;
  }

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.innerHTML = `
    ${areaSVG}
    <path d="${pricePath}" fill="none" stroke="${color}" stroke-width="1.5"/>
    ${maPath ? `<path d="${maPath}" fill="none" stroke="#9ca3af" stroke-width="1" stroke-dasharray="3,2" opacity="0.8"/>` : ''}
  `;
}

// =============================================================================
// CARD & CATEGORY RENDERING
// =============================================================================

function renderCategory(category) {
  const section = document.createElement('section');
  section.className = 'category';
  section.id = `category-${category.id}`;

  section.innerHTML = `
    <div class="category-header">
      <div class="category-dot" style="background:${category.color}"></div>
      <h2>${category.name}</h2>
    </div>
    <div class="assets-grid" id="assets-${category.id}"></div>
  `;

  return section;
}

function renderAssetCard(assetData, color, maPeriod) {
  const { symbol, name, price, pct_change, above_ma, price_points, ma_points } = assetData;

  const priceStr = price != null ? `$${price.toFixed(2)}` : 'N/A';

  let changeHTML = '';
  if (pct_change != null) {
    const sign = pct_change >= 0 ? '+' : '';
    const cls  = pct_change >= 0 ? 'positive' : 'negative';
    changeHTML = `<span class="asset-change ${cls}">${sign}${pct_change.toFixed(2)}%</span>`;
  }

  let signalLabel = 'NO DATA';
  let signalClass = 'neutral';
  if (above_ma === true) {
    signalLabel = `ABOVE ${maPeriod}-DAY MA`;
    signalClass = 'above';
  } else if (above_ma === false) {
    signalLabel = `BELOW ${maPeriod}-DAY MA`;
    signalClass = 'below';
  }

  const card = document.createElement('div');
  card.className = 'asset-card';
  card.id = `asset-card-${symbol.toLowerCase()}`;
  card.innerHTML = `
    <div class="asset-header">
      <span class="asset-symbol">${symbol}</span>
      <span class="asset-name">${name || symbol}</span>
    </div>
    <div class="asset-price-row">
      <span class="asset-price">${priceStr}</span>
      ${changeHTML}
    </div>
    <svg class="asset-sparkline" id="sparkline-${symbol.toLowerCase()}" height="52"></svg>
    <div class="asset-signal ${signalClass}">${signalLabel}</div>
  `;

  requestAnimationFrame(() => {
    const svgEl = document.getElementById(`sparkline-${symbol.toLowerCase()}`);
    if (svgEl && price_points && price_points.length >= 2) {
      renderSparkline(svgEl, price_points, ma_points || [], color);
    }
  });

  return card;
}

// =============================================================================
// CACHE RENDERING
// =============================================================================

const REGIME_COLORS = {
  '\uD83D\uDFE2 STRONG RISK ON': '#10b981',
  '\uD83D\uDFE1 RISK ON':        '#84cc16',
  '\u26AA NEUTRAL':               '#a7a7ad',
  '\uD83D\uDFE0 RISK OFF':       '#f59e0b',
  '\uD83D\uDD34 STRONG RISK OFF': '#ef4444',
};

function applyMacroCache(cache) {
  const regimeEl = document.getElementById('macro-regime');
  const subEl    = document.getElementById('macro-score-sub');
  if (regimeEl) {
    regimeEl.textContent = cache.regime.label;
    regimeEl.style.color = REGIME_COLORS[cache.regime.label] || '#a7a7ad';
  }
  if (subEl) {
    subEl.textContent = `${cache.regime.above} of ${cache.regime.total} assets above ${cache.ma_period}-day MA (${cache.regime.pct}%)`;
  }

  const grid = document.getElementById('categories-grid');
  grid.innerHTML = '';

  for (const catData of cache.categories) {
    const catConfig = MACRO_CATEGORIES.find(c => c.id === catData.id);
    if (!catConfig) continue;

    const section = renderCategory(catConfig);
    grid.appendChild(section);

    const { above, total } = catData.breadth;
    if (total > 0) {
      const pct = above / total;
      let barColor;
      if      (pct >= 0.70) barColor = '#10b981';
      else if (pct >= 0.50) barColor = '#84cc16';
      else if (pct >= 0.30) barColor = '#f59e0b';
      else                  barColor = '#ef4444';

      const bar = document.createElement('div');
      bar.className = 'breadth-score-bar';
      bar.innerHTML = `
        <div class="breadth-score-label">
          <span>${above} / ${total} above ${cache.ma_period}-day MA</span>
          <span style="color:${barColor};font-weight:600">${Math.round(pct * 100)}%</span>
        </div>
        <div class="breadth-bar-track">
          <div class="breadth-bar-fill" style="width:${Math.round(pct * 100)}%;background:${barColor}"></div>
        </div>
      `;
      section.insertBefore(bar, section.querySelector(`#assets-${catData.id}`));
    }

    const assetsGrid = section.querySelector(`#assets-${catData.id}`);
    for (const assetData of catData.assets) {
      const card = renderAssetCard(assetData, catConfig.color, cache.ma_period);
      assetsGrid.appendChild(card);
    }
  }
}

async function loadAndRender() {
  const r = await fetch(`./data/cache/macro_${LOOKBACK_DAYS}_${MA_PERIOD}.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Cache missing: macro_${LOOKBACK_DAYS}_${MA_PERIOD}.json — run: python3 generate_cache.py`);
  applyMacroCache(await r.json());
}

// =============================================================================
// INITIALIZATION
// =============================================================================

(async function main() {
  try {
    await loadConfig();

    const lastUpdated = await loadLastUpdated();
    document.getElementById('meta').textContent = `Last updated: ${lastUpdated}`;

    await loadAndRender();

    document.getElementById('lookbackSelect').addEventListener('change', async (e) => {
      LOOKBACK_DAYS = parseInt(e.target.value, 10);
      await loadAndRender();
    });

    document.getElementById('maPeriodSelect').addEventListener('change', async (e) => {
      MA_PERIOD = parseInt(e.target.value, 10);
      await loadAndRender();
    });

  } catch (err) {
    document.getElementById('meta').textContent = 'Cache missing — run: python3 generate_cache.py';
    console.error(err);
  }
})();
