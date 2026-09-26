// js/pages/trade.js — Trade Recommendations page (ES module).
//
// The live page for one session. It loads trading_signals_<date>.json and
// renders each stage as it lands: premarket (Steps 1-3), the open, and the
// opening range (Steps 4-5). A stage whose data isn't there yet shows the
// generator's not-available message. The recap is pages/trade_recap.html.
import { renderNav } from '../components/Navigation.js';
import { todayET, isWeekend, hasStage, stageMessage, loadSession, gradeColor, gradeLabel,
         getDotsHTML, noticeHTML, fillSymbolSelector } from '../core/trade-common.js';

let session        = null;   // the loaded trading_signals_<date>.json
let selectedSymbol = 'SPY';
let viewingDate    = null;

// -----------------------------------------------------------------------------
// Regime → favoured patterns.
//
// The mapping itself lives in config/trading_config.json and is resolved by the
// generator, which stamps `regime.favored` and a per-pattern `regime_match`.
// Everything below is presentation only: keys → display text. Do not reintroduce
// a pattern list here — four divergent copies of this mapping is exactly the bug
// this replaced (Steps 2 and 3 said "sit out" while Steps 4 and 5 scored trades).
// -----------------------------------------------------------------------------
const PATTERN_LABELS = {
  orb:              'ORB',
  gap_fill:         'Gap Fill',
  gap_continuation: 'Gap Continuation',
  engulfing:        'Engulfing',
  outside_day:      'Outside Day',
};

// Day quality is a preference, not a veto — same rule as regime fit. A C or F
// day used to hide Steps 2-6 outright, which discarded setups regardless of
// their own quality and left the page blank below Step 1. The grade already
// costs a confluence point ("Day A or A+" in scoreConfluences); that is the
// price. Setups are shown, flagged low probability.
function lowProbabilityHTML(view) {
  const grade = view.day_quality?.grade;
  if (!['C', 'F'].includes(grade)) return '';
  return `
    <div style="background: #2a1414; border-left: 4px solid #ef4444; padding: 10px 12px; border-radius: 4px; margin-bottom: 12px;">
      <strong style="color: #ef4444;">Low probability day — Grade ${grade}</strong>
      <div class="muted" style="font-size: 0.85em; margin-top: 4px;">
        Below the quality threshold for active trading. Setups are shown so you can judge them
        on their own merits — expect lower hit rates, and size down or stand aside.
      </div>
    </div>`;
}

function favoredLabel(regime) {
  const fav = regime?.favored;
  if (!fav?.patterns?.length) return '—';
  const names = fav.patterns.map(k => PATTERN_LABELS[k] || k).join(', ');
  return fav.note ? `${names} (${fav.note})` : names;
}

// Sizing has two inputs in the framework (docs/trading-rules.md): the day grade
// sets a posture for the whole session, and each trade's confluence score scales
// within it. Regime is not one of them — Step 2 gates which patterns are valid,
// never the size. Both live here so Step 1 and Step 4 cannot drift apart.
// Sizing is decided by the generator from config/trading_config.json — the
// tables that used to live here are gone, along with the ATR multiples and the
// confluence cutoff. What remains is the wording for a factor the generator
// hands us, so the backtester and the page cannot disagree about size.
const POSTURE_WORDS = [
  { min: 1,    label: 'Full',      note: 'full size' },
  { min: 0.5,  label: 'Half',      note: 'reduce size 50%' },
  { min: 0,    label: 'No trades', note: 'sit out' },
];

function dayPosture(view) {
  const f = view.day_quality?.posture_factor;
  if (f == null) return { label: '—', factor: 1, note: '' };
  const w = POSTURE_WORDS.find(x => f >= x.min) || POSTURE_WORDS[POSTURE_WORDS.length - 1];
  return { label: w.label, factor: f, note: w.note };
}

/** Effective size for one setup, as the generator computed it. */
function effectiveSize(pattern) {
  const pct = pattern?.sizing?.effective_pct;
  if (pct == null) return '—';
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

// Last-day candle structure: inside (compression) / outside (expansion) / normal.
function dayTypeHTML(dayType) {
  const map = {
    inside:  { label: 'Inside (compression)', color: '#eab308' },
    outside: { label: 'Outside (expansion)',  color: '#f97316' },
    normal:  { label: 'Normal',               color: '#6b7280' },
  };
  const d = map[dayType] || map.normal;
  return `<span style="color:${d.color}; font-weight:bold;">${d.label}</span>`;
}

function squeezeHTML(squeeze) {
  if (!squeeze) squeeze = { status: 'unknown', momentum_increasing: false };
  const sqColors = { strong: '#ef4444', normal: '#f97316', weak: '#eab308', none: '#10b981', unknown: '#6b7280' };
  const labels   = { strong: 'Strong', normal: 'Normal', weak: 'Weak', none: 'Fired', unknown: 'N/A' };
  const color  = sqColors[squeeze.status] || sqColors.unknown;
  const label  = labels[squeeze.status]  || 'N/A';
  const arrow  = squeeze.status !== 'unknown' ? (squeeze.momentum_increasing ? ' ▲' : ' ▼') : '';
  return `<span style="color: ${color}; font-weight: bold;">${label}${arrow}</span>`;
}

function switchTradeTab(tab) {
  document.querySelectorAll('#tab-morning, #tab-logic').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'logic') loadLogicTab();
}
window.switchTradeTab = switchTradeTab;

// Build a prefilled GitHub "new issue" URL to propose a trade-logic change,
// capturing the context the viewer is currently looking at.
const REPO_SLUG = 'jonsflow/risk-model';
// Build a prefilled GitHub "new issue" URL. Two flavors:
//   'logic' — propose a change to the signal logic (Logic tab)
//   'data'  — report displayed data that looks wrong/confusing (Morning)
function issueUrl(kind) {
  const d = session ? buildView(session) : {};
  const sym = document.getElementById('symbolSelector')?.value || '—';
  const r = d.regime || {};
  const regime = r.label ? `${r.label} ${r.direction || ''} (ATR ${r.atr_trend || '—'})`.trim() : '—';
  const ctx = [
    '---', '_Context when filed:_',
    `- Session: ${d.session_date || '—'}`,
    `- Symbol viewed: ${sym}`,
    `- Regime: ${regime}`,
    `- Day quality: ${d.day_quality?.grade || '—'}`,
  ];
  let title, label, body;
  if (kind === 'data') {
    title = '[Trade data] ';
    label = 'trade-data';
    body = ['### What looks wrong or confusing', '<!-- Which number/section, and what you expected -->', '',
            '### Where', '<!-- Which step or stage · which symbol -->', '', ...ctx].join('\n');
  } else {
    title = '[Trade logic] ';
    label = 'trade-logic';
    body = ['### Area', '<!-- Gap · ORB · Regime · Day Quality · Outside Day · Other -->', '',
            '### Current behavior', '<!-- What the model does today — see the Signal Logic datasheet -->', '',
            '### Proposed change', '', '### Rationale / evidence', '', '### What would invalidate this', '', ...ctx].join('\n');
  }
  const params = new URLSearchParams({ title, body, labels: label });
  return `https://github.com/${REPO_SLUG}/issues/new?${params.toString()}`;
}

// Load the signal-logic datasheet once, from its single source file.
let _logicLoaded = false;
async function loadLogicTab() {
  if (_logicLoaded) return;
  _logicLoaded = true;
  const host = document.getElementById('logicContent');
  try {
    const res = await fetch('pages/trade_logic.html');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    // Pull the datasheet's content cards, dropping the standalone page's
    // title card (first — redundant with the tab) and back-link footer (last).
    const cards = Array.from(doc.querySelectorAll('body > .card'));
    const body = cards.slice(1, -1);
    host.innerHTML = '';

    // "Propose a change" bar — opens a prefilled GitHub issue.
    const bar = document.createElement('div');
    bar.className = 'card';
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-color:#2f5a8c;';
    bar.innerHTML = '<div><b>Have a different view?</b> ' +
      '<span class="muted" style="font-size:0.85em;">Propose a change to the trade logic — opens a prefilled GitHub issue with the current context.</span></div>';
    const a = document.createElement('a');
    a.textContent = '💡 Propose a change';
    a.target = '_blank'; a.rel = 'noopener';
    a.style.cssText = 'background:#2f5a8c;color:#e2e8f0;border-radius:6px;padding:6px 14px;font-size:0.85em;text-decoration:none;white-space:nowrap;';
    a.href = issueUrl('logic');
    a.addEventListener('click', () => { a.href = issueUrl('logic'); }); // refresh context at click
    bar.appendChild(a);
    host.appendChild(bar);

    body.forEach(c => host.appendChild(c));
  } catch (err) {
    _logicLoaded = false;
    host.innerHTML = `<span style="color:#ef4444">Could not load signal logic (${err.message}). ` +
      `<a href="pages/trade_logic.html" style="color:#7aa2f7">Open datasheet directly →</a></span>`;
  }
}

// =============================================================================
// VIEW MODEL
// =============================================================================
// One flat view over the session file's stages, so the step renderers don't
// each walk the file. Every field here comes from a stage that has landed:
// premarket fields from `premarket`, the open from `open`, scored setups from
// `opening_range`. The recap is not read on this page.

function buildView(s) {
  const pm = s.premarket || {};
  const symbols = {};
  for (const [sym, d] of Object.entries(pm.symbols || {})) {
    symbols[sym] = {
      ...(d.preopen || {}),
      premarket:  d.premarket || {},
      gap:        d.gap || {},
      last_print: d.last_print,
      adr_20d:    d.adr_20d,
      adr_8d:     d.adr_8d,
      prev_range: d.prev_range,
      day_type:   d.day_type,
    };
  }
  return {
    session_date:  s.session_date,
    generated:     s.generated,
    market_closed: s.market_closed,
    premarket_window_end: pm.window_end,
    day_quality:   pm.day_quality || {},
    regime:        pm.regime || {},
    structure:     pm.structure_check || {},
    vix:           pm.vix,
    vol_regime:    pm.vol_regime,
    symbols,
    watchlist:     pm.watchlist || [],
    open:          s.open || {},
    opening_range: s.opening_range || {},
  };
}

// =============================================================================
// HEADER
// =============================================================================

function renderHeader(view) {
  const gen    = new Date(view.generated);
  const genStr = gen.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const grade = view.day_quality.grade;
  const color = view.market_closed ? '#6b7280' : gradeColor(grade);
  const label = view.market_closed ? 'Market Closed' : gradeLabel(grade);

  document.getElementById('headerMeta').textContent = `${view.session_date} · as of ${genStr}`;
  document.getElementById('dayQualityBadge').innerHTML =
    `<span style="background: ${color}; color: white; padding: 8px 16px; border-radius: 6px; display: inline-block;">${view.market_closed ? 'Weekend' : grade} — ${label}</span>`;

  const stage = (name, windowEnd, landed) =>
    `${name} ${windowEnd ? `to ${windowEnd} ET` : ''} ${landed ? '✓' : '· not available'}`;
  document.getElementById('morningWindowLabel').textContent = [
    stage('Premarket', view.premarket_window_end, true),
    stage('Open', view.open.window_end, hasStage(session, 'open')),
    stage('Opening range', view.opening_range.window_end, hasStage(session, 'opening_range')),
  ].join('  ·  ');
}

// =============================================================================
// STEP 1: DAY QUALITY GATE
// =============================================================================

function renderDayQuality(view) {
  const grade     = view.day_quality.grade;
  const scores    = view.day_quality.scores || {};
  const volRegime = view.vol_regime || {};

  if (view.market_closed) {
    document.getElementById('step1Content').innerHTML = `
      <div style="background: #1e2330; border-left: 4px solid #6b7280; padding: 12px; border-radius: 4px;">
        <strong style="color: #9ca3af;">Market Closed — Weekend</strong><br>
        <span class="muted">No grading until Monday.</span>
      </div>`;
    return;
  }

  const scoreColor = (s) => s === 2 ? '#10b981' : s === 1 ? '#f59e0b' : '#ef4444';
  const scoreDots  = (s) => [0,1,2].map(i =>
    `<span style="color:${i < s ? scoreColor(s) : '#374151'}">●</span>`
  ).join('');

  const regimeColors = { Low: '#3b82f6', Normal: '#10b981', Elevated: '#f59e0b', Extreme: '#ef4444' };
  const regimeColor  = regimeColors[volRegime.label] || '#6b7280';

  const total   = scores.total ?? '–';
  const max     = scores.max   ?? 8;
  const hasData = scores.has_data !== false;

  const gradeColor = (grade === 'A+' || grade === 'A') ? '#10b981' : grade === 'B' ? '#f59e0b' : '#ef4444';
  const gradeLabel = grade === 'A+' ? 'Strong' : grade === 'A' ? 'Favorable' : grade === 'B' ? 'Selective' : 'Sit Out';

  const gapRange  = scores.gap_range  || {};
  const struc     = scores.structure  || {};
  const adrScore  = scores.adr        || {};
  // Alignment is scored at the end of the opening range; until then the grade
  // holds it at the neutral 1 the generator stamps.
  const alignment  = view.opening_range.alignment || null;
  const alignScore = alignment || scores.alignment || {};

  const noDataMsg = '<span class="muted" style="font-size:0.8em;">No pre-market data</span>';
  const fmtVal = (n, suffix = '') => n != null ? n + suffix : '–';

  let html = '';

  // --- SPY price + overnight range chart (Step 1 always shows SPY) ---
  const spyD  = view.symbols['SPY'] || {};
  const pmD   = spyD.premarket || {};
  const prX   = gapRange.prior_close;
  const eoX   = gapRange.last_print;
  const pmH   = pmD.high;
  const pmL   = pmD.low;
  const lastPx = spyD.close;

  if (prX != null) {
    // Both stamped by the generator; the page used to subtract these itself.
    const gapDol  = gapRange.gap_signed ?? null;
    const gapPctV = gapRange.gap_pct ?? null;
    const gc      = gapDol == null || gapDol === 0 ? '#6b7280' : gapDol > 0 ? '#10b981' : '#ef4444';
    const gSign   = gapDol != null && gapDol >= 0 ? '+' : '';
    const gArr    = gapDol == null || gapDol === 0 ? '→' : gapDol > 0 ? '↑' : '↓';

    let ps = `<div style="background:#1a1f2e; border-radius:6px; padding:14px 16px; margin-bottom:16px;">`;
    ps += `<div style="display:flex; gap:24px; align-items:flex-end; flex-wrap:wrap;">
      <div>
        <div class="muted" style="font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">Prev Close</div>
        <strong style="font-size:1.7em; letter-spacing:-0.01em;">$${prX.toFixed(2)}</strong>
      </div>`;
    if (eoX != null) {
      ps += `
      <div>
        <div class="muted" style="font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">Last Print${view.premarket_window_end ? ` (${view.premarket_window_end})` : ''}</div>
        <strong style="color:${gc};">$${eoX.toFixed(2)}</strong>
      </div>`;
      if (gapDol !== null) {
        ps += `<div style="display:flex; align-items:flex-end;">
          <span style="background:${gc}18; border:1px solid ${gc}55; color:${gc}; padding:5px 11px; border-radius:4px; font-weight:bold; font-size:0.88em;">
            ${gArr} Gap ${gSign}$${Math.abs(gapDol).toFixed(2)} (${gSign}${gapPctV?.toFixed(2)}%)
          </span>
        </div>`;
      }
    }
    const posture = dayPosture(view);
    ps += `
      <div>
        <div class="muted" style="font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">Size Posture</div>
        <strong style="color:${gradeColor};">${posture.label}</strong>
        ${posture.note ? `<div class="muted" style="font-size:0.72em; margin-top:1px;">${posture.note}</div>` : ''}
      </div>`;
    if (pmH != null && pmL != null) {
      ps += `
      <div>
        <div class="muted" style="font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">PM Range</div>
        <strong style="color:#64748b;">$${pmL.toFixed(2)} – $${pmH.toFixed(2)}</strong>
      </div>`;
    }
    ps += `</div></div>`;
    html += ps;
  }
  // --- end price section ---

  if (volRegime.label) {
    html += `<div style="margin-bottom: 12px;">
      <span class="muted" style="margin-right: 8px;">Vol Regime:</span>
      <span style="background: ${regimeColor}; color: white; padding: 3px 10px; border-radius: 4px; font-weight: bold; font-size: 0.9em;">${volRegime.label}</span>
      <span class="muted" style="margin-left: 8px; font-size: 0.85em;">${volRegime.atr_percentile_1y}th pct of 1-year ATR range</span>
    </div>`;
  }

  html += `
  <div style="background: #1e2330; border-left: 4px solid ${gradeColor}; padding: 12px; border-radius: 4px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
    <div>
      <strong style="color: ${gradeColor};">Grade ${grade} — ${gradeLabel}</strong>
      ${grade === 'C' ? '<br><span class="muted" style="font-size:0.9em;">Score below threshold for active trading</span>' : ''}
      <br><span class="muted" style="font-size:0.85em;">Pre-open call from prior sessions + premarket</span>
    </div>
    <span style="font-size: 1.5em; font-weight: bold; color: ${gradeColor};">${total}/${max}</span>
  </div>`;

  // "What actually happened" lives on the EOD tab, which already renders it.
  // Morning Setup states the thesis; the verdict is not a morning fact.

  // VIX context row
  const vix = view.vix || {};
  if (vix.current != null) {
    const vixColor = vix.ratio > 1.2 ? '#ef4444' : vix.ratio > 1.0 ? '#f59e0b' : '#10b981';
    const vixLabel = vix.ratio > 1.2 ? 'Elevated' : vix.ratio > 1.0 ? 'Above avg' : 'Below avg';
    html += `<div style="margin-bottom:12px; display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;">
      <span class="muted">VIX:</span>
      <strong style="color:${vixColor};">${vix.current}</strong>
      <span class="muted" style="font-size:0.8em;">${vix.ratio}× 20d avg (${vix.avg_20d}) — ${vixLabel}</span>
      ${vix.as_of ? `<span class="muted" style="font-size:0.75em;">as of ${vix.as_of}</span>` : ''}
    </div>`;
  }

  html += `<div class="metric-grid" style="margin-bottom: 12px;">

    <div class="pill">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div class="muted">Gap + PM Range</div>
        <span>${scoreDots(gapRange.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(gapRange.score ?? 0)}; font-size:1.1em;">
        ${gapRange.score ?? 0}/2
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">
        ${gapRange.gap_pts != null
          ? `Gap $${gapRange.gap_pts} (${gapRange.gap_ratio}× 20d med) · PM ${gapRange.pm_range_ratio != null ? gapRange.pm_range_ratio + '× 20d avg' : '–'}`
          : noDataMsg}
      </div>
    </div>

    <div class="pill">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div class="muted">Structure</div>
        <span>${scoreDots(struc.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(struc.score ?? 0)}; font-size:1.1em;">
        ${struc.regime ?? '–'}
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">Last day: ${dayTypeHTML(struc.day_type)}</div>
    </div>

    <div class="pill">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div class="muted">Intraday Range <span style="font-size:0.85em;">(ex-gap)</span></div>
        <span>${scoreDots(adrScore.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(adrScore.score ?? 0)}; font-size:1.1em;">
        ${adrScore.ratio != null ? (adrScore.ratio > 1.1 ? '▲ Expanding' : adrScore.ratio < 0.9 ? '▼ Contracting' : '→ Flat') : '–'}
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">
        ${adrScore.adr_8d != null ? `8d $${adrScore.adr_8d} · 20d $${adrScore.adr_20d}` : '–'}
      </div>
    </div>

    <div class="pill">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div class="muted">Index Alignment <span style="font-size:0.85em;">(opening range)</span></div>
        <span>${scoreDots(alignScore.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(alignScore.score ?? 0)}; font-size:1.1em;">
        ${!alignment ? 'Not available' : alignScore.score === 2 ? 'Aligned' : alignScore.score === 1 ? 'Partial' : 'Diverging'}
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">
        ${alignment
          ? Object.entries(alignment.detail || {}).map(([s, d]) => `${s} ${d === 'up' ? '▲' : d === 'down' ? '▼' : '→'}`).join(' · ')
          : `Neutral in the grade until ${view.opening_range.window_end || 'the opening range'}`}
      </div>
    </div>

  </div>`;

  // ADR pill — SPY only, shows 20-day average daily range vs yesterday's actual range
  const spySym   = view.symbols['SPY'] || {};
  const adr20    = spySym.adr_20d;
  const adr8     = spySym.adr_8d;
  const prevRng  = spySym.prev_range;
  if (adr20 != null && prevRng != null) {
    const ratio      = +(prevRng / adr20).toFixed(2);
    const compressed = prevRng < adr20;
    const rangeColor = compressed ? '#10b981' : '#ef4444';
    // Intraday range trend: 8d vs 20d high-low (gap-excluded). More range = more
    // tradeable follow-through, so expanding is green to match the score pill.
    const trendDir   = adr8 != null ? (adr8 > adr20 ? '▲ Expanding' : adr8 < adr20 ? '▼ Contracting' : '→ Flat') : '–';
    const trendColor = adr8 != null ? (adr8 > adr20 ? '#10b981' : adr8 < adr20 ? '#ef4444' : '#6b7280') : '#6b7280';
    html += `
    <div class="pill" style="margin-bottom: 12px; display: flex; gap: 16px 32px; align-items: flex-start; flex-wrap: wrap;">
      <div>
        <div class="muted" style="font-size:0.8em; margin-bottom:2px;">Avg Daily Range (20d)</div>
        <strong style="font-size:1.1em;">$${adr20}</strong>
      </div>
      <div>
        <div class="muted" style="font-size:0.8em; margin-bottom:2px;">Yesterday's Range</div>
        <strong style="color:${rangeColor};">$${prevRng}</strong>
        <span class="muted" style="font-size:0.8em; margin-left:6px;">${ratio}× ADR · ${compressed ? 'below avg' : 'above avg'}</span>
      </div>
      <div>
        <div class="muted" style="font-size:0.8em; margin-bottom:2px;">Intraday Range Trend</div>
        <strong style="color:${trendColor};">${trendDir}</strong>
        ${adr8 != null ? `<span class="muted" style="font-size:0.75em; margin-left:6px;">$${adr8} 8d avg</span>` : ''}
      </div>
    </div>`;
  }

  if (!hasData) {
    html += `<div class="muted" style="font-size:0.8em;">
      ⚠ No pre-market bars available — Grade based on Gap + Structure only.
    </div>`;
  }

  document.getElementById('step1Content').innerHTML = html;
}

// =============================================================================
// STEP 2: MARKET REGIME
// =============================================================================

function renderRegime(view) {
  const regime = view.regime;

  const regimeColors = { 'Trending': '#3b82f6', 'Ranging': '#f59e0b', 'Choppy': '#ef4444' };

  document.getElementById('step2Content').innerHTML = `
    <div class="metric-grid" style="margin-bottom: 16px;">
      <div class="pill">
        <div class="muted">Regime</div>
        <span style="font-weight: bold; background: ${regimeColors[regime.label]}; color: white; padding: 4px 8px; border-radius: 4px; display: inline-block;">
          ${regime.label}
        </span>
      </div>
      <div class="pill">
        <div class="muted">Direction</div>
        <strong>${regime.direction}</strong>
      </div>
      <div class="pill">
        <div class="muted">ATR Trend</div>
        <strong>${regime.atr_trend}</strong>
      </div>
      <div class="pill">
        <div class="muted">Hourly Structure</div>
        <span style="color: ${view.structure.contradicts ? '#ef4444' : '#10b981'};">
          ${view.structure.hourly ?? '–'}
        </span>
        ${view.structure.contradicts
          ? `<div style="color:#ef4444; font-size:0.8em; margin-top:4px;">Contradicts daily ${view.structure.daily_direction}</div>`
          : ''}
      </div>
      <div class="pill">
        <div class="muted">Last Day</div>
        ${dayTypeHTML(regime.day_type)}
      </div>
    </div>
    <div style="background: #22242a; padding: 12px; border-radius: 4px; border-left: 4px solid ${regimeColors[regime.label]};">
      <strong>Favoured Patterns for ${regime.label} Regime:</strong><br>
      ${favoredLabel(regime)}
      <div class="muted" style="font-size: 0.85em; margin-top: 6px;">
        A regime mismatch costs one confluence point — it does not disqualify a setup.
      </div>
    </div>`;
}

// =============================================================================
// STEP 3: PATTERN SCANNER
// =============================================================================

function renderPatternScanner(view) {
  const patterns = view.watchlist;
  const regime   = view.regime.label;
  const data     = view.symbols[selectedSymbol];

  // Every detected pattern is listed. Regime is a preference, not a veto: the
  // Fit column shows the one-point cost of an off-regime setup rather than
  // hiding the setup outright.
  const symPatterns = patterns.filter(p => p.symbol === selectedSymbol);

  if (symPatterns.length === 0) {
    const reasons = [];
    if (!data) {
      document.getElementById('step3Content').innerHTML =
        `<div class="muted" style="padding: 12px;">No premarket data for ${selectedSymbol}.</div>`;
      return;
    }
    if (!data.gap?.gap_significant) reasons.push('No significant gap');
    if (data.rsi_14 > 35 && data.rsi_14 < 65) reasons.push('RSI neutral');
    if (!data.pm_range_active)                 reasons.push('PM range below avg');
    if (data.above_ma_20 === false)             reasons.push('Below 20-MA');

    document.getElementById('step3Content').innerHTML = `
      ${lowProbabilityHTML(view)}
      <div style="color: #6b7280; padding: 12px;">
        No ${selectedSymbol} patterns detected.
        ${reasons.length ? `<span class="muted" style="font-size:0.85em;"> · ${reasons.join(' · ')}</span>` : ''}
      </div>`;
    return;
  }

  let html = `${lowProbabilityHTML(view)}
    <table style="width: 100%; border-collapse: collapse;">
    <thead>
      <tr style="border-bottom: 2px solid #a7a7ad;">
        <th style="text-align: left; padding: 8px;">Pattern</th>
        <th style="text-align: left; padding: 8px;">Direction</th>
        <th style="text-align: left; padding: 8px;">Fit</th>
        <th style="text-align: left; padding: 8px;">Notes</th>
      </tr>
    </thead>
    <tbody>`;

  symPatterns.forEach(p => {
    const dc = p.direction === 'up' ? '#10b981' : p.direction === 'down' ? '#ef4444' : '#6b7280';
    const fit = p.regime_match;
    const fitHTML = fit
      ? `<span style="color: #10b981;">✓ ${regime}</span>`
      : `<span style="color: #f59e0b;" title="Costs one confluence point">△ off-regime</span>`;
    html += `
      <tr style="border-bottom: 1px solid #333;">
        <td style="padding: 8px; font-weight: bold;">${p.pattern}</td>
        <td style="padding: 8px; color: ${dc}; font-weight: bold;">${p.direction}</td>
        <td style="padding: 8px; font-size: 0.9em;">${fitHTML}</td>
        <td style="padding: 8px; font-size: 0.9em;">${p.notes}</td>
      </tr>`;
  });

  html += `</tbody></table>`;
  document.getElementById('step3Content').innerHTML = html;
}

// =============================================================================
// STEP 4: CONFLUENCE SCORING
// =============================================================================

function scoreConfluences(view) {
  if (!hasStage(session, 'opening_range')) {
    document.getElementById('step4Content').innerHTML =
      `<div class="muted">${stageMessage(session, 'opening_range')}</div>`;
    return [];
  }
  const patterns = view.opening_range.patterns || [];

  // The score is computed and stamped by the generator from pre-open inputs
  // only, so it is a fact about that morning rather than something re-derived
  // here against whatever the cache happens to hold now. Scoring in the browser
  // read today's close and full-day volume out of `symbols[sym]`, which made the
  // afternoon's score differ from the morning's and let a backtest replaying
  // these files rank setups using the outcome. Caches written before the score
  // existed have no `confluence` and are skipped.
  const scored = patterns
    .filter(p => p.symbol === selectedSymbol && p.confluence)
    .map(p => {
      const sym      = p.symbol;
      const data     = view.symbols[sym];
      const squeeze  = data.squeeze        || { status: 'unknown', momentum: 0, momentum_increasing: false };
      const rsiDiv   = data.rsi_divergence || { signal: 'unknown' };

      const { score, max, checks } = p.confluence;
      const tradeDay = new Date(view.session_date + 'T12:00:00').getDay();
      const weekdayEdge = [2, 3, 4].includes(tradeDay);
      return { symbol: sym, pattern: p.pattern, direction: p.direction, levels: p.levels,
               sizing: p.sizing, plan: p.plan, qualifies: p.qualifies,
               score, max, checks, data, squeeze, rsiDiv, weekdayEdge };
    })
    .sort((a, b) => b.score - a.score)
    // `qualifies` is the generator's verdict, from sizing.min_confluence.
    .filter(x => x.qualifies);

  let html = '';

  if (scored.length === 0) {
    html = `<div class="muted">No trades with 3+ confluences found.</div>`;
  } else {
    html = `<div style="display: flex; flex-wrap: wrap; gap: 12px;">`;

    scored.forEach(trade => {
      const sc      = trade.score >= 6 ? '#10b981' : trade.score >= 4 ? '#f59e0b' : '#3b82f6';
      const szLabel = trade.sizing?.tier_label || '—';
      // Only worth stating when the day scales it — on a full-size day the
      // effective size is the confluence size, and repeating it is noise.
      const grade   = view.day_quality?.grade;
      const eff     = dayPosture(view).factor === 1 ? null : effectiveSize(trade);
      const wdBadge = trade.weekdayEdge
        ? `<span style="background:#22242a; border:1px solid #10b981; color:#10b981; padding:1px 7px; border-radius:3px; font-size:0.75em; margin-left:6px;">Tue–Thu ✓</span>`
        : `<span style="background:#22242a; border:1px solid #4b5563; color:#4b5563; padding:1px 7px; border-radius:3px; font-size:0.75em; margin-left:6px;">Mon/Fri</span>`;

      html += `
        <div class="trade-card" style="border: 2px solid ${sc}; border-radius: 6px; padding: 14px;">
          <div style="font-weight: bold; font-size: 1.05em;">${trade.symbol}</div>
          <div style="font-size: 0.85em; color: #a7a7ad; margin-bottom: 8px;">${trade.pattern}</div>
          <div style="margin-bottom: 10px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
            <span style="background: ${sc}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold;">
              ${trade.score}/${trade.max} ${getDotsHTML(trade.score, trade.max)}
            </span>
            ${wdBadge}
          </div>
          <div style="font-size: 0.8em; font-weight: bold; color: ${sc}; margin-bottom: 6px;">
            ${szLabel}
            ${eff !== null ? `<span class="muted" style="font-weight:normal;"> → effective ${eff}</span>` : ''}
          </div>
          <div style="font-size: 0.8em;">`;

      Object.entries(trade.checks).forEach(([key, val]) => {
        html += `<div style="color: ${val ? '#10b981' : '#4b5563'};">${val ? '✓' : '✗'} ${key}</div>`;
      });

      html += `</div>
          <div style="margin-top: 8px; font-size: 0.8em;">Squeeze: ${squeezeHTML(trade.squeeze)}</div>
        </div>`;
    });

    html += `</div>`;
  }

  document.getElementById('step4Content').innerHTML = html;
  return scored;
}

// =============================================================================
// STEP 5: TRADE RECOMMENDATIONS
// =============================================================================

function renderRecommendations(view, scored) {
  if (!hasStage(session, 'opening_range')) {
    document.getElementById('step5Content').innerHTML =
      `<div class="muted">${stageMessage(session, 'opening_range')}</div>`;
    return;
  }
  let html = lowProbabilityHTML(view);

  if (scored.length === 0) {
    html += `<div class="muted">No trades with sufficient confluence today.</div>`;
  } else {
    html += `<div style="display: flex; flex-wrap: wrap; gap: 12px;">`;

    scored.forEach(trade => {
      // `d` comes from the morning view, so it already holds pre-open values
      // only — no need to reach for a separate copy.
      const d     = trade.data;
      const atr   = d.atr_14;
      const isUp  = trade.direction === 'up';
      const plan  = trade.plan || {};
      const atrT1 = (plan.t1_distance ?? 0).toFixed(2);
      const atrT2 = (plan.t2_distance ?? 0).toFixed(2);
      const atrSt = (plan.stop_distance ?? 0).toFixed(2);
      const mT1   = plan.t1_atr ?? '';
      const mT2   = plan.t2_atr ?? '';
      const mSt   = plan.stop_atr ?? '';
      const dir   = isUp ? '+' : '−';
      const pat   = trade.pattern;
      const priorClose = d.prior_close;
      // Engulfing and Outside Day fire on a completed bar and execute next
      // session, so their trigger prices come from the generator's `levels`
      // rather than being re-derived from a session high/low the morning view
      // does not carry.
      const lv    = trade.levels || {};
      const lvEntry = lv.entry != null ? `$${(+lv.entry).toFixed(2)}` : '—';
      const lvStop  = lv.stop  != null ? `$${(+lv.stop).toFixed(2)}`  : '—';

      let entry, stop, target1, target2, target3;

      if (pat.includes('Gap Fill')) {
        const orbEntry = pat.includes('ORB');
        entry   = orbEntry ? `${isUp ? 'Short' : 'Buy'} ORB breakout — fade gap to prior close` : `${isUp ? 'Short at open' : 'Buy at open'} — fade gap to prior close`;
        stop    = `${isUp ? '+' : '−'}$${atrSt} from entry (${mSt}x ATR)`;
        target1 = `Prior close $${priorClose.toFixed(2)} (gap fill)`;
        target2 = `${dir}$${atrT1} from entry (${mT1}x ATR)`;
        target3 = `Trailing $${atrSt} (${mSt}x ATR)`;
      } else if (pat.includes('Gap Continuation')) {
        const orbEntry = pat.includes('ORB');
        entry   = orbEntry ? `${isUp ? 'Buy' : 'Short'} ORB breakout — continuation` : `${isUp ? 'Buy on open momentum' : 'Short on open momentum'} — gap continuation`;
        stop    = `${isUp ? '−' : '+'}$${atrSt} from entry (${mSt}x ATR)`;
        target1 = `${dir}$${atrT1} from entry (${mT1}x ATR)`;
        target2 = `${dir}$${atrT2} from entry (${mT2}x ATR)`;
        target3 = `Trailing $${atrSt} (${mSt}x ATR)`;
      } else if (pat === 'ORB') {
        entry   = `Close above $${lv.or_high} or below $${lv.or_low} — breakout window to 11:30 AM`;
        stop    = `Opposite side of opening range`;
        target1 = `$${atrT1} from entry (${mT1}x ATR)`;
        target2 = `$${atrT2} from entry (${mT2}x ATR)`;
        target3 = `Trailing $${atrSt} (${mSt}x ATR)`;
      } else if (pat === 'Outside Day') {
        entry   = `${isUp ? 'Above' : 'Below'} ${lvEntry} (outside-day extreme) — next session`;
        stop    = `${isUp ? 'Below' : 'Above'} ${lvStop}`;
        target1 = `${dir}$${atrT1} from entry (${mT1}x ATR)`;
        target2 = `${dir}$${atrT2} from entry (${mT2}x ATR)`;
        target3 = `Trailing $${atrSt} (${mSt}x ATR)`;
      } else if (pat === 'Engulfing') {
        entry   = `${isUp ? 'Above' : 'Below'} ${lvEntry} (engulfing candle) — next session`;
        stop    = `${isUp ? 'Below' : 'Above'} ${lvStop}`;
        target1 = `${dir}$${atrT1} from entry (${mT1}x ATR)`;
        target2 = `${dir}$${atrT2} from entry (${mT2}x ATR)`;
        target3 = `Trailing $${atrSt} (${mSt}x ATR)`;
      } else {
        entry   = 'Pattern-specific entry';
        stop    = `$${atrSt} from entry (${mSt}x ATR)`;
        target1 = `${dir}$${atrT1} from entry (${mT1}x ATR)`;
        target2 = `${dir}$${atrT2} from entry (${mT2}x ATR)`;
        target3 = `Trailing $${atrSt} (${mSt}x ATR)`;
      }

      const sc           = trade.score >= 6 ? '#10b981' : trade.score >= 4 ? '#f59e0b' : '#3b82f6';
      const pmRsi        = d.rsi_14;
      const pmMacd       = d.macd_histogram;
      const pmAboveMa    = d.above_ma_20;
      const pmSqueeze    = trade.squeeze;
      const pmRsiDiv     = trade.rsiDiv;
      const rsidivColors = { bullish: '#10b981', bearish: '#ef4444', both: '#f97316', none: '#4b5563', unknown: '#6b7280' };
      const rsidivLabels = { bullish: '▲ Bullish', bearish: '▼ Bearish', both: '⚡ Both', none: 'None', unknown: 'N/A' };

      html += `
        <div class="trade-card" style="border: 2px solid ${sc}; border-radius: 6px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <strong style="font-size: 1.1em;">${trade.symbol}</strong>
              <span style="margin-left: 8px; background: ${sc}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.8em;">
                ${trade.pattern} ${trade.direction}
              </span>
            </div>
            <span style="font-weight: bold; color: ${sc}; font-size: 0.85em;">${trade.score}/${trade.max} ${getDotsHTML(trade.score, trade.max)}</span>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; font-size: 0.85em;">
            <div><div class="muted">Prior Close</div><strong>$${priorClose.toFixed(2)}</strong></div>
            <div><div class="muted">ATR (14)</div><strong>${atr.toFixed(2)}</strong></div>
          </div>

          <div style="background: #22242a; padding: 8px; border-radius: 4px; font-size: 0.85em; margin-bottom: 10px;">
            <div><strong>Entry:</strong> ${entry}</div>
            <div><strong>Stop:</strong> ${stop}</div>
            <div><strong>T1 (33%):</strong> ${target1}</div>
            <div><strong>T2 (33%):</strong> ${target2}</div>
            <div><strong>T3 (33%):</strong> ${target3}</div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 0.8em;">
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">RSI</div>
              <strong>${pmRsi.toFixed(1)}</strong>
              ${pmRsiDiv.signal !== 'none' && pmRsiDiv.signal !== 'unknown'
                ? `<div style="color: ${rsidivColors[pmRsiDiv.signal]}; font-size: 0.85em; margin-top: 2px;">${rsidivLabels[pmRsiDiv.signal]}</div>`
                : ''}
            </div>
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">MACD</div>
              <span style="color: ${pmMacd > 0 ? '#10b981' : '#ef4444'};">
                ${pmMacd > 0 ? '▲ Bull' : '▼ Bear'}
              </span>
            </div>
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">MA(20)</div>
              <span style="color: ${pmAboveMa ? '#10b981' : '#ef4444'};">
                ${pmAboveMa ? '▲ Above' : '▼ Below'}
              </span>
            </div>
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">Squeeze</div>
              ${squeezeHTML(pmSqueeze)}
            </div>
          </div>
        </div>`;
    });

    html += `</div>`;
  }

  document.getElementById('step5Content').innerHTML = html;
}

// =============================================================================
// OPEN AND OPENING RANGE
// =============================================================================

function renderOpen(view) {
  const el = document.getElementById('openContent');
  const o  = view.open.symbols?.[selectedSymbol];
  if (!hasStage(session, 'open')) {
    el.innerHTML = `<div class="muted">${stageMessage(session, 'open')}</div>`;
    return;
  }
  if (!o) {
    el.innerHTML = `<div class="muted">No opening bar for ${selectedSymbol}.</div>`;
    return;
  }
  const g   = o.gap || {};
  const gc  = g.gap_type === 'up' ? '#10b981' : g.gap_type === 'down' ? '#ef4444' : '#6b7280';
  const lean = { toward_fill: 'Toward the fill', with_gap: 'With the gap', flat: 'Flat' }[o.first_bar] || 'No gap';
  el.innerHTML = `
    <div class="metric-grid">
      <div class="pill"><div class="muted">First bar (${o.bar.time})</div>
        <strong>O ${o.bar.open} · H ${o.bar.high} · L ${o.bar.low} · C ${o.bar.close}</strong></div>
      <div class="pill"><div class="muted">Gap vs prior close ($${o.prior_close})</div>
        <strong style="color:${gc};">${g.gap_pct != null ? `${g.gap_pct > 0 ? '+' : ''}${g.gap_pct}%` : '–'}</strong>
        <div class="muted" style="font-size:0.8em; margin-top:4px;">${g.gap_ratio != null ? `${g.gap_ratio}× median gap` : ''}</div></div>
      <div class="pill"><div class="muted">First bar leans</div><strong>${lean}</strong>
        ${o.filled_in_first_bar ? '<div style="color:#10b981; font-size:0.8em; margin-top:4px;">Filled in the first bar</div>' : ''}</div>
    </div>
    <div class="muted" style="font-size:0.8em; margin-top:8px;">Recorded for later assessment — no targets.</div>`;
}

function renderOpeningRange(view) {
  const el = document.getElementById('orContent');
  const or = view.opening_range;
  if (!hasStage(session, 'opening_range')) {
    el.innerHTML = `<div class="muted">${stageMessage(session, 'opening_range')}</div>`;
    return;
  }
  const r  = or.symbols?.[selectedSymbol];
  const al = or.alignment || {};
  const alColor = al.score === 2 ? '#10b981' : al.score === 1 ? '#f59e0b' : '#ef4444';
  const alDetail = Object.entries(al.detail || {})
    .map(([s, d]) => `${s} ${d === 'up' ? '▲' : d === 'down' ? '▼' : '→'}`).join(' · ');
  el.innerHTML = `
    <div class="metric-grid">
      <div class="pill"><div class="muted">Range (09:30–${or.window_end})</div>
        <strong>${r ? `$${r.low} – $${r.high}` : '–'}</strong>
        <div class="muted" style="font-size:0.8em; margin-top:4px;">${r ? `$${r.range} wide` : `No bars for ${selectedSymbol}`}</div></div>
      <div class="pill"><div class="muted">ORB</div>
        <strong style="color:${r?.qualified ? '#10b981' : '#6b7280'};">${r ? (r.qualified ? 'Qualified' : 'Not qualified') : '–'}</strong>
        <div class="muted" style="font-size:0.8em; margin-top:4px;">Range &gt; 0.75× ATR avg</div></div>
      <div class="pill"><div class="muted">Targets</div>
        <strong style="font-size:0.9em;">${r ? `▲ $${r.levels.t1_up} / $${r.levels.t2_up}` : '–'}</strong>
        <div style="font-size:0.9em;"><strong>${r ? `▼ $${r.levels.t1_down} / $${r.levels.t2_down}` : ''}</strong></div></div>
      <div class="pill"><div class="muted">Index Alignment</div>
        <strong style="color:${alColor};">${al.label || '–'}</strong>
        <div class="muted" style="font-size:0.8em; margin-top:4px;">${alDetail}</div></div>
    </div>`;
}

// =============================================================================
// MAIN RENDER ORCHESTRATION
// =============================================================================

const STEP_IDS = ['step-2', 'step-3', 'step-open', 'step-or', 'step-4', 'step-5'];

function showSteps(visible) {
  STEP_IDS.forEach(id => { document.getElementById(id).style.display = visible ? '' : 'none'; });
}

function renderAll() {
  const view = buildView(session);
  showSteps(!view.market_closed);
  renderHeader(view);
  renderDayQuality(view);
  if (view.market_closed) return;

  renderRegime(view);
  renderPatternScanner(view);
  renderOpen(view);
  renderOpeningRange(view);
  const scored = scoreConfluences(view);
  renderRecommendations(view, scored);
}

function renderEmpty(dateStr, title, detail) {
  session = null;
  showSteps(false);
  document.getElementById('headerMeta').textContent = dateStr;
  document.getElementById('dayQualityBadge').innerHTML = '';
  document.getElementById('morningWindowLabel').textContent = '';
  document.getElementById('step1Content').innerHTML = noticeHTML(title, detail);
}

async function loadAndRender(dateStr) {
  viewingDate = dateStr;
  document.getElementById('recapLink').href = `pages/trade_recap.html?date=${dateStr}`;
  if (isWeekend(dateStr)) {
    renderEmpty(dateStr, 'Market Closed — Weekend', 'No session to plan. Pick a weekday.');
    return;
  }
  session = await loadSession(dateStr);
  if (!session) {
    renderEmpty(dateStr, 'No data yet',
      `The generator hasn't written ${dateStr}. The premarket stage appears after the first run of the day.`);
    return;
  }
  if (!session.premarket) {
    renderEmpty(dateStr, 'Written in the old format',
      `${dateStr} predates the stage layout. Regenerate it with scripts/backfill_trading_history.py --force.`);
    return;
  }
  if (!hasStage(session, 'premarket')) {
    renderEmpty(dateStr, 'Premarket not available', stageMessage(session, 'premarket'));
    return;
  }
  const selector = document.getElementById('symbolSelector');
  selectedSymbol = fillSymbolSelector(selector, Object.keys(session.premarket?.symbols || {}), selectedSymbol);
  renderAll();
}

// =============================================================================
// INIT
// =============================================================================

async function init() {
  renderNav();

  // Wire tab switching
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTradeTab(btn.dataset.tab));
  });

  // Wire "report a data issue" links (refresh context at click)
  document.querySelectorAll('a.report-data-issue').forEach(link => {
    link.href = issueUrl('data');
    link.addEventListener('click', () => { link.href = issueUrl('data'); });
  });

  const selector = document.getElementById('symbolSelector');
  selector.addEventListener('change', () => {
    selectedSymbol = selector.value;
    if (session) renderAll();
  });

  const today  = todayET();
  const picker = document.getElementById('tradeDatePicker');
  picker.value = today;
  picker.max   = today;

  const load = async (dateStr) => {
    try {
      await loadAndRender(dateStr);
    } catch (error) {
      console.error('Error loading date:', error);
      document.getElementById('step1Content').innerHTML =
        `<div class="error">Error loading data: ${error.message}</div>`;
    }
  };
  picker.addEventListener('change', () => load(picker.value));
  document.getElementById('tradeDateToday').addEventListener('click', () => {
    picker.value = today;
    load(today);
  });

  await load(today);
}

document.addEventListener('DOMContentLoaded', init);
