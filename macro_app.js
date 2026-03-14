// =============================================================================
// CONFIG
// =============================================================================

let LOOKBACK_DAYS = 20;
let MA_PERIOD = 50;

const STACKED_COLORS = [
  '#4a9eff', '#f97316', '#a855f7', '#10b981',
  '#f59e0b', '#ef4444', '#06b6d4', '#84cc16',
  '#ec4899', '#14b8a6', '#f43f5e',
];

let MACRO_CATEGORIES = [];

let activeTab = 'overview';

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

function renderStackedSparkline(svgEl, assetsData) {
  const W = svgEl.clientWidth || 300;
  const H = 80;
  const pad = { top: 6, right: 6, bottom: 6, left: 6 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.innerHTML = '';

  const series = assetsData
    .map((a, i) => ({
      symbol: a.symbol,
      color: STACKED_COLORS[i % STACKED_COLORS.length],
      pts: last(a.price_points, LOOKBACK_DAYS),
    }))
    .filter(s => s.pts.length >= 2);

  if (series.length === 0) return;

  const normalized = series.map(s => ({
    ...s,
    pts: s.pts.map(([t, v]) => [t, (v / s.pts[0][1] - 1) * 100]),
  }));

  const allT = normalized.flatMap(s => s.pts.map(p => p[0]));
  const allV = normalized.flatMap(s => s.pts.map(p => p[1]));
  const minT = Math.min(...allT), maxT = Math.max(...allT);
  const minV = Math.min(...allV), maxV = Math.max(...allV);
  const tRange = maxT - minT || 1;
  const vRange = maxV - minV || 1;

  const sx = t => pad.left + (t - minT) / tRange * cw;
  const sy = v => pad.top + (1 - (v - minV) / vRange) * ch;

  const zeroY = sy(0);
  const zl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  zl.setAttribute('x1', pad.left); zl.setAttribute('x2', pad.left + cw);
  zl.setAttribute('y1', zeroY);    zl.setAttribute('y2', zeroY);
  zl.setAttribute('stroke', '#444'); zl.setAttribute('stroke-width', '0.5');
  zl.setAttribute('stroke-dasharray', '3,2');
  svgEl.appendChild(zl);

  for (const s of normalized) {
    const d = s.pts.map(([t, v], i) =>
      `${i === 0 ? 'M' : 'L'}${sx(t).toFixed(1)},${sy(v).toFixed(1)}`
    ).join(' ');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', s.color);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linejoin', 'round');
    svgEl.appendChild(path);
  }
}

// =============================================================================
// CARD & CATEGORY RENDERING
// =============================================================================

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
// REGIME CARD RENDERING
// =============================================================================

const REGIME_DESCRIPTIONS = {
  '\uD83D\uDFE2 GOLDILOCKS':            'Growth above trend, inflation contained. Risk assets outperform — equities, credit, and small caps lead. Bonds lag.',
  '\uD83D\uDFE1 INFLATIONARY BOOM':     'Strong growth with rising prices. Commodities and real assets outperform. Nominal bonds struggle; equities mixed on pricing power.',
  '\uD83D\uDD35 RECESSION / DEFLATION': 'Growth below trend, inflation falling. Treasuries and defensives outperform. Credit spreads widen, equities under pressure.',
  '\uD83D\uDD34 STAGFLATION':           'Weak growth, high inflation — the worst macro backdrop. Gold and commodities hold value; equities and bonds both struggle.',
};

const FLAG_META = {
  carry_risk:       { label: '⚡ CARRY RISK',   color: '#f59e0b' },
  inflation_regime: { label: '📈 INFLATION',     color: '#ef4444' },
  credit_stress:    { label: '💥 CREDIT STRESS', color: '#ef4444' },
  china_divergence: { label: '🌐 CHINA',         color: '#8b5cf6' },
  vol_spike:        { label: '📊 VOL SPIKE',      color: '#f59e0b' },
};

const FLAG_DESCRIPTIONS = {
  carry_risk:       'HYG (high-yield credit) is below its MA. Credit markets are pricing in risk ahead of equities — historically a leading warning signal.',
  inflation_regime: 'Inflation score ≥60%. Multiple signals firing simultaneously: TIPS bid, long bonds weak, commodities elevated. Expect pressure on real returns.',
  credit_stress:    'Both HYG and LQD are below their MA. Investment-grade and high-yield credit selling off together — watch for spread widening and tighter financial conditions.',
  china_divergence: 'FXI (China equities) is moving opposite to SPY. China is decoupling from the US cycle, which raises risk for global EM exposure and supply-chain sensitive sectors.',
  vol_spike:        'UVXY or VIXY above their MA. Volatility products are being bid up — institutions are actively hedging, signaling elevated near-term risk-off sentiment.',
};

function buildRegimeMapSVG(rc) {
  const W = 180, H = 136;
  const PAD = { top: 12, right: 8, bottom: 20, left: 28 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;
  const midX = PAD.left + cw / 2;
  const midY = PAD.top  + ch / 2;

  const dotX = (PAD.left + (rc.inflation.pct / 100) * cw).toFixed(1);
  const dotY = (PAD.top  + (1 - rc.growth.pct / 100) * ch).toFixed(1);

  return `
    <rect x="${PAD.left}" y="${PAD.top}"  width="${cw/2}" height="${ch/2}" fill="rgba(16,185,129,0.09)"/>
    <rect x="${midX}"     y="${PAD.top}"  width="${cw/2}" height="${ch/2}" fill="rgba(234,179,8,0.09)"/>
    <rect x="${PAD.left}" y="${midY}"     width="${cw/2}" height="${ch/2}" fill="rgba(59,130,246,0.09)"/>
    <rect x="${midX}"     y="${midY}"     width="${cw/2}" height="${ch/2}" fill="rgba(239,68,68,0.09)"/>

    <rect x="${PAD.left}" y="${PAD.top}" width="${cw}" height="${ch}" fill="none" stroke="#2a2b2f" stroke-width="1"/>
    <line x1="${midX}"     y1="${PAD.top}"    x2="${midX}"        y2="${PAD.top+ch}" stroke="#2a2b2f" stroke-width="1"/>
    <line x1="${PAD.left}" y1="${midY}"       x2="${PAD.left+cw}" y2="${midY}"       stroke="#2a2b2f" stroke-width="1"/>

    <text x="${PAD.left+cw*0.25}" y="${PAD.top+ch*0.25}" text-anchor="middle" dominant-baseline="middle" fill="#10b981" font-size="8" font-weight="600" opacity="0.85">GOLDILOCKS</text>
    <text x="${PAD.left+cw*0.75}" y="${PAD.top+ch*0.25}" text-anchor="middle" dominant-baseline="middle" fill="#eab308" font-size="8" font-weight="600" opacity="0.85">INF. BOOM</text>
    <text x="${PAD.left+cw*0.25}" y="${PAD.top+ch*0.75}" text-anchor="middle" dominant-baseline="middle" fill="#3b82f6" font-size="8" font-weight="600" opacity="0.85">RECESSION</text>
    <text x="${PAD.left+cw*0.75}" y="${PAD.top+ch*0.75}" text-anchor="middle" dominant-baseline="middle" fill="#ef4444" font-size="8" font-weight="600" opacity="0.85">STAGFLATION</text>

    <line x1="${dotX}" y1="${PAD.top}"    x2="${dotX}"        y2="${PAD.top+ch}" stroke="#e9e9ea" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.35"/>
    <line x1="${PAD.left}" y1="${dotY}"   x2="${PAD.left+cw}" y2="${dotY}"       stroke="#e9e9ea" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.35"/>
    <circle cx="${dotX}" cy="${dotY}" r="4.5" fill="#e9e9ea" stroke="#0f0f10" stroke-width="1.5"/>

    <text x="${PAD.left+cw/2}" y="${H-4}" text-anchor="middle" fill="#a7a7ad" font-size="8">Inflation →</text>
    <text x="8" y="${PAD.top+ch/2}" text-anchor="middle" dominant-baseline="middle" fill="#a7a7ad" font-size="8" transform="rotate(-90 8 ${PAD.top+ch/2})">Growth ↑</text>
  `;
}

function renderRegimeCard(rc) {
  const el = document.getElementById('regime-card');
  if (!el) return;
  const description = REGIME_DESCRIPTIONS[rc.quadrant] || '';
  el.innerHTML = `
    <div class="regime-card-title">Market Regime</div>
    <div class="regime-quadrant">${rc.quadrant}</div>
    ${description ? `<div class="regime-description">${description}</div>` : ''}
    <div class="regime-axes">
      <div class="regime-axis">
        <span class="regime-axis-label">Growth</span>
        <div class="regime-axis-track">
          <div class="regime-axis-fill" style="width:${rc.growth.pct}%;background:#10b981"></div>
        </div>
        <span class="regime-axis-pct">${rc.growth.pct}%</span>
      </div>
      <div class="regime-axis">
        <span class="regime-axis-label">Inflation</span>
        <div class="regime-axis-track">
          <div class="regime-axis-fill" style="width:${rc.inflation.pct}%;background:#ef4444"></div>
        </div>
        <span class="regime-axis-pct">${rc.inflation.pct}%</span>
      </div>
    </div>
    <div class="regime-method-note">
      <strong>Growth</strong> — how many key risk assets (HYG, IWM, SPY, EEM, EMB, XLY vs XLP) are above their MA. High = broad expansion.<br><br>
      <strong>Inflation</strong> — TIPS bid, long Treasuries weak, commodities (GLD, USO, DBC) above MA. High = inflation priced in.
    </div>
  `;
}

function renderRegimeFlagsCard(rc) {
  const el = document.getElementById('regime-flags-card');
  if (!el) return;
  const activeFlags = Object.entries(rc.flags)
    .filter(([k, v]) => v && FLAG_META[k])
    .map(([k]) => ({ key: k, ...FLAG_META[k] }));
  const inner = activeFlags.length > 0
    ? activeFlags.map(f => `
        <div class="regime-flag-item">
          <span class="regime-flag" style="background:${f.color}22;color:${f.color}">${f.label}</span>
          <span class="regime-flag-desc">${FLAG_DESCRIPTIONS[f.key] || ''}</span>
        </div>`).join('')
    : '<div class="regime-no-flags">No active risk signals</div>';
  el.innerHTML = `
    <div class="regime-card-title">Risk Signals</div>
    <div class="regime-flag-list">${inner}</div>
  `;
}

function renderRegimeChartCard(rc) {
  const el = document.getElementById('regime-chart-card');
  if (!el) return;
  el.innerHTML = `
    <div class="regime-card-title">Regime Map</div>
    <svg viewBox="0 0 180 136" width="360" height="272" style="display:block;max-width:100%;margin-bottom:12px">
      ${buildRegimeMapSVG(rc)}
    </svg>
    <div class="regime-method-note">Each axis 0–100%. Crossing 50% sets the quadrant.</div>
  `;
}

// =============================================================================
// TAB UI
// =============================================================================

function buildTabUI(categories) {
  const container = document.getElementById('tab-container');
  const tabDefs = [
    { id: 'overview', label: 'Overview' },
    ...categories.map(c => ({ id: c.id, label: c.name }))
  ];

  const bar = tabDefs.map(t =>
    `<button class="tab-btn${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');
  const panels = tabDefs.map(t =>
    `<div class="tab-panel${t.id === activeTab ? ' active' : ''}" id="tab-${t.id}"></div>`
  ).join('');

  container.innerHTML = `<div class="tab-bar">${bar}</div><div class="tab-panels">${panels}</div>`;
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
}

// =============================================================================
// THEME DESCRIPTIONS
// =============================================================================

const THEME_DESCRIPTIONS = {
  'us-equities': {
    'Broad strength':    'All major indexes above MA — broad participation confirms risk-on.',
    'Large-cap led':     'SPY/QQQ holding up while IWM lags — flight to quality within equities.',
    'Small-cap led':     'IWM outperforming large caps — early-cycle or speculative risk appetite.',
    'Moderate strength': 'Majority above MA but not broad-based — selective, watch for follow-through.',
    'Broad weakness':    'All major cap-weighted indexes below MA — no safe haven within equities.',
    'Mixed':             'Mixed signals across market cap spectrum — no clear leadership.',
  },
  'us-sectors': {
    'Defensive rotation':  'XLV, XLP, XLU leading — institutions rotating to safety.',
    'Value / reflation':   'XLE, XLI, XLB leading — inflation or reflation trade in play.',
    'Growth / tech led':   'XLK, XLC driving gains — momentum and growth in control.',
    'Cyclical rotation':   'Cyclicals outperforming defensives — risk appetite improving.',
    'Broad weakness':      'Most sectors below MA — broad market deterioration.',
    'Mixed':               'No clear sector leadership — conflicting signals, wait for confirmation.',
  },
  'fixed-income': {
    'Flight to quality':  'Long Treasuries bid while credit lags — classic risk-off bond signal.',
    'Risk-on credit':     'HYG, LQD outperforming Treasuries — credit markets pricing in growth.',
    'Inflation breakout': 'TIP above MA, TLT weak — real yields compressing, inflation being priced in.',
    'Broad weakness':     'Most bonds below MA — rising rate environment or forced selling.',
    'Mixed signals':      'Conflicting signals across the curve and credit — no clear bond narrative.',
  },
  'commodities': {
    'Broad inflation bid': 'Energy, metals, and softs all bid — broad inflationary impulse.',
    'Precious metals bid': 'Gold and silver outperforming — safe-haven or inflation hedge demand.',
    'Energy led':          'USO/UNG outperforming metals — supply shock or demand recovery narrative.',
    'Broad weakness':      'Most commodities below MA — disinflationary or demand-contraction signal.',
    'Mixed':               'No dominant commodity theme — idiosyncratic drivers at work.',
  },
  'currencies': {
    'Dollar strength': 'UUP above MA — headwind for EM assets, commodities, and global risk.',
    'Dollar weakness': 'UUP below MA — tailwind for EM equities, gold, and global risk assets.',
    'Mixed':           'No clear dollar trend — watch for breakout to confirm macro bias.',
  },
  'volatility': {
    'Elevated vol':   'VIX above MA — hedging demand elevated, risk-off conditions in force.',
    'Vol suppressed': 'Vol products below MA — complacency or genuine calm, risk-on backdrop.',
  },
  'crypto': {
    'Risk-on':   'BTC and ETH both above MA — crypto aligned with broad risk appetite.',
    'Risk-off':  'BTC and ETH both below MA — crypto in drawdown, avoid risk.',
    'Diverging': 'BTC/ETH diverging — idiosyncratic drivers, caution warranted.',
  },
  'international': {
    'Global strength':  'All international ETFs above MA — synchronized global expansion.',
    'Global weakness':  'All international ETFs below MA — global growth concerns dominant.',
    'EM outperforming': 'EEM, FXI stronger than EFA — EM-specific tailwinds (dollar, commodities).',
    'DM outperforming': 'EFA outperforming EM — quality and stability preference.',
    'Mixed':            'Divergent signals across regions — country-specific drivers.',
  },
};

// =============================================================================
// OVERVIEW TAB
// =============================================================================

function renderOverviewTab(cache) {
  const panel = document.getElementById('tab-overview');
  panel.innerHTML = '';

  // Three regime cards in a row
  const regimeRow = document.createElement('div');
  regimeRow.className = 'regime-row';
  regimeRow.innerHTML = `
    <div class="overview-cat-card" id="regime-card"></div>
    <div class="overview-cat-card" id="regime-flags-card"></div>
    <div class="overview-cat-card" id="regime-chart-card"></div>
  `;
  panel.appendChild(regimeRow);

  if (cache.regime_card) {
    renderRegimeCard(cache.regime_card);
    renderRegimeFlagsCard(cache.regime_card);
    renderRegimeChartCard(cache.regime_card);
  }

  // Category cards grid
  const grid = document.createElement('div');
  grid.className = 'overview-cat-grid';

  for (const catData of cache.categories) {
    const catConfig = MACRO_CATEGORIES.find(c => c.id === catData.id);
    if (!catConfig) continue;

    const { above, total } = catData.breadth;
    const pct = total > 0 ? Math.round(above / total * 100) : 0;
    const invert = catConfig.invert || false;
    // For normal categories: green=above, red=below. Inverted (volatility): flip colors.
    const aboveColor = invert ? '#ef4444' : '#10b981';
    const belowColor = invert ? '#10b981' : '#ef4444';

    const theme = catData.theme || '';
    const desc = (THEME_DESCRIPTIONS[catData.id] || {})[theme] || '';

    const symbolColors = Object.fromEntries(
      catData.assets.map((a, i) => [a.symbol, STACKED_COLORS[i % STACKED_COLORS.length]])
    );

    const chipWithDot = (s, cls) =>
      `<span class="sym-chip ${cls}"><span class="chip-dot" style="background:${symbolColors[s] || '#888'}"></span>${s}</span>`;

    const leadersHTML = catData.leaders && catData.leaders.length > 0
      ? catData.leaders.map(s => chipWithDot(s, 'above')).join('')
      : '<span class="sym-chip-none">—</span>';

    const laggardsHTML = catData.laggards && catData.laggards.length > 0
      ? catData.laggards.map(s => chipWithDot(s, 'below')).join('')
      : '<span class="sym-chip-none">—</span>';

    const card = document.createElement('div');
    card.className = 'overview-cat-card';
    card.innerHTML = `
      <div class="overview-cat-header">
        <div class="overview-cat-title">
          <div class="category-dot" style="background:${catConfig.color}"></div>
          <span class="overview-cat-name">${catConfig.name}</span>
        </div>
      </div>
      <div class="split-bar-track">
        <div class="split-bar-seg" style="width:${pct}%;background:${aboveColor}"></div>
        <div class="split-bar-seg" style="width:${100 - pct}%;background:${belowColor}"></div>
      </div>
      <svg class="stacked-sparkline" id="stacked-ov-${catData.id}" height="80"></svg>
      <div class="overview-theme-label">${theme}</div>
      ${desc ? `<div class="overview-theme-desc">${desc}</div>` : ''}
      <div class="overview-chips-section">
        <div class="overview-chips-row">
          <span class="overview-chips-dir above">▲</span>
          <div class="overview-chips">${leadersHTML}</div>
        </div>
        <div class="overview-chips-row">
          <span class="overview-chips-dir below">▼</span>
          <div class="overview-chips">${laggardsHTML}</div>
        </div>
      </div>
      <div class="overview-cat-footer">
        <span class="overview-details-link">${above} / ${total} above ${cache.ma_period}-day MA &nbsp;·&nbsp; Detail ›</span>
      </div>
    `;

    card.style.cursor = 'pointer';
    card.addEventListener('click', () => switchTab(catData.id));
    grid.appendChild(card);

    requestAnimationFrame(() => {
      const svgEl = document.getElementById(`stacked-ov-${catData.id}`);
      if (svgEl) renderStackedSparkline(svgEl, catData.assets);
    });
  }

  panel.appendChild(grid);
}

// =============================================================================
// CATEGORY TAB
// =============================================================================

function renderCategoryTab(catData, catConfig, maPeriod) {
  const panel = document.getElementById(`tab-${catData.id}`);
  if (!panel) return;
  panel.innerHTML = '';

  const section = document.createElement('section');
  section.className = 'category';

  section.innerHTML = `
    <div class="category-header">
      <div class="category-dot" style="background:${catConfig.color}"></div>
      <h2>${catConfig.name}</h2>
    </div>
    <div class="assets-grid" id="assets-${catData.id}"></div>
  `;

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
        <span>${above} / ${total} above ${maPeriod}-day MA</span>
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
    const card = renderAssetCard(assetData, catConfig.color, maPeriod);
    assetsGrid.appendChild(card);
  }

  panel.appendChild(section);
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
  // Always-visible top bar
  const regimeEl = document.getElementById('macro-regime');
  const subEl    = document.getElementById('macro-score-sub');
  if (regimeEl) {
    regimeEl.textContent = cache.regime.label;
    regimeEl.style.color = REGIME_COLORS[cache.regime.label] || '#a7a7ad';
  }
  if (subEl) {
    subEl.textContent = `${cache.regime.above} of ${cache.regime.total} assets above ${cache.ma_period}-day MA (${cache.regime.pct}%)`;
  }

  renderOverviewTab(cache);

  for (const catData of cache.categories) {
    const catConfig = MACRO_CATEGORIES.find(c => c.id === catData.id);
    if (catConfig) renderCategoryTab(catData, catConfig, cache.ma_period);
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
    buildTabUI(MACRO_CATEGORIES);

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
