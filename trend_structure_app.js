// =============================================================================
// TREND STRUCTURE — pure renderer for data/cache/trend_structure.json
// =============================================================================

let cache = null;

// ---------------------------------------------------------------------------
// Signal label (mirrors app.js:trendSignalLabel — ratio-based, unchanged)
// ---------------------------------------------------------------------------

function trendSignalLabel(score, maxTotal) {
  const r = score / maxTotal;
  const c = ChartUtils.colors;
  if (r >= 0.67)  return { label: '🟢 STRONG RISK ON',  color: c.signalStrongOn  };
  if (r >= 0.25)  return { label: '🟡 RISK ON',          color: c.signalOn        };
  if (r >= -0.17) return { label: '⚪ NEUTRAL',           color: c.signalNeutral   };
  if (r >= -0.58) return { label: '🟠 RISK OFF',          color: c.signalOff       };
  return           { label: '🔴 STRONG RISK OFF',         color: c.signalStrongOff };
}

// ---------------------------------------------------------------------------
// Trend direction from label string
// ---------------------------------------------------------------------------

function trendDirection(label) {
  if (label.includes('↗')) return 'up';
  if (label.includes('↘')) return 'down';
  return 'sideways';
}

// ---------------------------------------------------------------------------
// SVG sparkline — area + price line, no MA
// ---------------------------------------------------------------------------

function renderSparkline(svgEl, pts) {
  const W = svgEl.clientWidth || svgEl.getBoundingClientRect().width || 300;
  const H = 70;
  const PAD = { top: 4, right: 4, bottom: 4, left: 4 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  if (pts.length < 2) { svgEl.innerHTML = ''; return; }

  const minVal  = Math.min(...pts.map(p => p[1]));
  const maxVal  = Math.max(...pts.map(p => p[1]));
  const valRange = maxVal - minVal || 1;
  const minTime  = pts[0][0];
  const maxTime  = pts[pts.length - 1][0];
  const timeRange = maxTime - minTime || 1;

  const xS = t => PAD.left + ((t - minTime) / timeRange) * cw;
  const yS = v => PAD.top  + ch - ((v - minVal) / valRange) * ch;

  const pricePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xS(p[0]).toFixed(1)},${yS(p[1]).toFixed(1)}`).join(' ');
  const x0 = xS(pts[0][0]).toFixed(1);
  const xN = xS(pts[pts.length - 1][0]).toFixed(1);
  const bottomY = (PAD.top + ch).toFixed(1);
  const areaPath = `${pricePath} L${xN},${bottomY} L${x0},${bottomY} Z`;

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.innerHTML = `
    <path d="${areaPath}" fill="rgba(74,158,255,0.12)"/>
    <path d="${pricePath}" fill="none" stroke="#4a9eff" stroke-width="1.5" stroke-linejoin="round"/>
  `;
}

// ---------------------------------------------------------------------------
// Render a single asset card
// ---------------------------------------------------------------------------

function renderCard(asset) {
  const dir   = trendDirection(asset.trend_label);
  const score = asset.score > 0 ? `+${asset.score}` : `${asset.score}`;

  const card = document.createElement('div');
  card.className = 'trend-card';
  card.innerHTML = `
    <div class="trend-card-header">
      <span class="trend-symbol">${asset.symbol}</span>
      <span class="trend-asset-name">${asset.name}</span>
    </div>
    <div class="trend-label-row">
      <span class="trend-label ${dir}">${asset.trend_label}</span>
      <span class="trend-score">${score}</span>
    </div>
    <svg class="trend-sparkline" id="ts-spark-${asset.symbol.toLowerCase()}"></svg>
  `;

  requestAnimationFrame(() => {
    const svgEl = card.querySelector(`#ts-spark-${asset.symbol.toLowerCase()}`);
    if (svgEl && asset.price_points.length >= 2) {
      renderSparkline(svgEl, asset.price_points);
    }
  });

  return card;
}

// ---------------------------------------------------------------------------
// Render a timeframe
// ---------------------------------------------------------------------------

function renderTimeframe(tf) {
  const tfData = cache.timeframes[tf];
  if (!tfData) return;

  // Overall score
  const { label, color } = trendSignalLabel(tfData.total_score, tfData.max_score);
  const sign = tfData.total_score > 0 ? '+' : '';
  const scoreEl = document.getElementById('structure-score');
  const subEl   = document.getElementById('structure-sub');
  if (scoreEl) { scoreEl.textContent = `${label} (${sign}${tfData.total_score})`; scoreEl.style.color = color; }
  if (subEl)   { subEl.textContent = tfData.assets.map(a => `${a.symbol} ${trendDirection(a.trend_label) === 'up' ? '↗' : trendDirection(a.trend_label) === 'down' ? '↘' : '→'}`).join('  ·  '); }

  // Asset grid
  const grid = document.getElementById('asset-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const asset of tfData.assets) {
    grid.appendChild(renderCard(asset));
  }
}

// ---------------------------------------------------------------------------
// Timeframe toggle
// ---------------------------------------------------------------------------

function initToggle() {
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTimeframe(btn.dataset.tf);
    });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    const r = await fetch('data/cache/trend_structure.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cache = await r.json();

    const metaEl = document.getElementById('meta');
    if (metaEl) metaEl.textContent = `Generated ${cache.generated}`;

    initToggle();
    renderTimeframe('daily');
  } catch (err) {
    console.error('Failed to load trend structure cache:', err);
    const metaEl = document.getElementById('meta');
    if (metaEl) metaEl.textContent = 'Error loading data';
  }
}

document.addEventListener('DOMContentLoaded', init);
