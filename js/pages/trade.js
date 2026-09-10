// js/pages/trade.js — Trade Recommendations page (ES module).
import { renderNav } from '../components/Navigation.js';

let cacheData      = null;
let scoredTrades   = null;
let latestDate     = null;
let selectedSymbol = 'SPY';
let viewingDate    = null;   // Date the user is currently looking at (vs todayET)

// The generator states which run produced this file: 'premarket' | 'intraday' |
// 'eod'. Only an 'eod' file describes a finished session. Older cache files
// predate the field, so fall back to the previous eod_outcome sniff for those —
// but never prefer the sniff, since a mid-session run populates eod_outcome with
// partial-day numbers that look complete.
function sessionPhase() {
  return cacheData.phase || null;
}

function isEodReady() {
  const phase = sessionPhase();
  if (phase) return cacheData.session_complete === true || phase === 'eod';
  const spy = cacheData.symbols?.SPY || {};
  return Object.keys(spy.eod_outcome || {}).length > 0;
}

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

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isMarketOpenForDate(dateStr) {
  // Returns true if the session for dateStr is complete. The generator decides
  // this from the ET wall clock at generation time; we just read its verdict.
  if (isWeekend(dateStr)) return false;
  if (dateStr === todayET()) return isEodReady();
  // A historical date is complete — unless this file was generated mid-session
  // for that date and never refreshed.
  return sessionPhase() ? isEodReady() : true;
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

function eodGuardHTML(dateStr) {
  if (isWeekend(dateStr)) {
    return `<div style="background:#1e2330; border-left:4px solid #6b7280; padding:14px 16px; border-radius:4px; margin-bottom:16px;">
      <strong style="color:#9ca3af;">Market Closed — Weekend</strong><br>
      <span class="muted">No end-of-day data available for ${dateStr}. Select a weekday or check back Monday.</span>
    </div>`;
  }
  const phase = sessionPhase();
  const detail = phase === 'intraday'
    ? `The ${dateStr} session is still open. Intraday values change until the close — end-of-day results are withheld until 4:15 PM ET so a partial day isn't shown as a final one.`
    : `${dateStr} hasn't opened yet. The plan below is built from prior sessions and premarket only. End-of-day results appear after 4:15 PM ET.`;
  const title = phase === 'intraday' ? 'Session In Progress' : 'Pre-Open — Plan Only';
  return `<div style="background:#1e2330; border-left:4px solid #eab308; padding:14px 16px; border-radius:4px; margin-bottom:16px;">
    <strong style="color:#eab308;">${title}</strong><br>
    <span class="muted">${detail}</span>
  </div>`;
}

// Forecast vs outcome. day_quality is the call made before the open from prior
// sessions only; day_realized is what the session delivered. Showing both is the
// only way to tell whether the morning model is any good — a "Choppy / Selective"
// call on a day that ran 1.8x ATR is a miss, and it should be visible as one.
function realizedHTML() {
  const r = cacheData.day_realized;
  if (!r || !r.grade) return '';

  const gc = (g) => (g === 'A+' || g === 'A') ? '#10b981' : g === 'B' ? '#f59e0b' : '#ef4444';
  const expColor = { expansion: '#10b981', normal: '#f59e0b', compression: '#ef4444' }[r.expansion] || '#6b7280';
  const expLabel = { expansion: 'Expansion', normal: 'Normal', compression: 'Compression' }[r.expansion] || '–';

  // Gap between what was forecast and what happened, in grade-score points.
  const drift = (r.forecast_total != null && r.total != null) ? r.total - r.forecast_total : null;
  const driftHTML = drift === null ? ''
    : drift >= 2  ? `<span style="color:#10b981;">delivered ${drift} pts above the pre-open call</span>`
    : drift <= -2 ? `<span style="color:#ef4444;">delivered ${Math.abs(drift)} pts below the pre-open call</span>`
    : `<span class="muted">in line with the pre-open call</span>`;

  const cell = (label, value, color) => `
    <div>
      <div class="muted" style="font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">${label}</div>
      <strong style="color:${color || '#e5e7eb'};">${value}</strong>
    </div>`;

  return `
  <div style="margin-top:14px; background:#22242a; border-left:4px solid ${gc(r.grade)}; border-radius:4px; padding:12px 14px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <strong style="color:${gc(r.grade)};">What actually happened — ${r.grade}</strong>
      <span style="font-size:1.2em; font-weight:bold; color:${gc(r.grade)};">${r.total}/${r.max}</span>
    </div>
    <div style="display:flex; flex-wrap:wrap; gap:18px; margin-bottom:10px;">
      ${cell('Range', `$${r.range?.toFixed(2)} (${r.range_pct?.toFixed(2)}%)`)}
      ${cell('vs ATR', `${r.atr_multiple?.toFixed(2)}x`, r.atr_multiple >= 1 ? '#10b981' : '#6b7280')}
      ${cell('Profile', expLabel, expColor)}
      ${cell('Close in range', `${Math.round((r.close_location ?? 0) * 100)}%`)}
      ${cell('Trend day', r.trend_day ? 'Yes' : 'No', r.trend_day ? '#10b981' : '#6b7280')}
    </div>
    <div style="font-size:0.9em;">${r.verdict}</div>
    <div style="font-size:0.85em; margin-top:4px;">
      Pre-open call: <strong style="color:${gc(r.forecast_grade)};">${r.forecast_grade} (${r.forecast_total}/8)</strong> — ${driftHTML}
    </div>
  </div>`;
}

function isWeekend(dateStr) {
  const day = new Date(dateStr + 'T12:00:00').getDay();
  return day === 0 || day === 6;
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

function getDotsHTML(filled, total) {
  let dots = '';
  for (let i = 0; i < total; i++) dots += i < filled ? '●' : '○';
  return dots;
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
  document.querySelectorAll('#tab-morning, #tab-eod, #tab-logic').forEach(p => p.classList.remove('active'));
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
//   'data'  — report displayed data that looks wrong/confusing (Morning/EOD)
function issueUrl(kind) {
  const d = cacheData || {};
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
            '### Where', '<!-- Morning Setup / End of Day · which symbol -->', '', ...ctx].join('\n');
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
// STEP 0: HEADER
// =============================================================================

// =============================================================================
// VIEW MODELS
// =============================================================================
// The morning/EOD boundary used to exist only as a comment, and the comment was
// wrong: it claimed the per-symbol indicators were written from bars prior to
// session_date, when they come from the session's own bar. Every renderer read
// one shared global, so nothing stopped a morning panel from displaying the
// close — and several did.
//
// These two builders make the boundary structural. Morning renderers are handed
// `buildMorningView()` and cannot reach a session field, because the object they
// receive does not contain one. Adding a leak now requires adding a field here.

function buildMorningView(c) {
  const symbols = {};
  for (const [sym, d] of Object.entries(c.symbols || {})) {
    // `preopen` is the generator's pre-open copy of the daily indicators;
    // `premarket` is the overnight bar range. Both existed before the bell.
    // The session's own open/high/low/close deliberately do not survive.
    symbols[sym] = { ...(d.preopen || {}), premarket: d.premarket || {}, date: d.date };
  }
  return {
    session_date:   c.session_date,
    phase:          c.phase,
    market_closed:  c.market_closed,
    generated:      c.generated,
    day_quality:    c.day_quality,
    regime:         c.regime,
    vix:            c.vix,
    vol_regime:     c.vol_regime,
    windows:        c.windows,
    symbols,
    // `outcome` is the verdict on each setup and belongs to the EOD tab.
    active_patterns: (c.active_patterns || []).map(({ outcome, ...rest }) => rest),
  };
}

// The EOD tab is the one view allowed to see what the session did, so it reads
// the cache unchanged.
function buildSessionView(c) { return c; }

function renderHeader() {
  const gen    = new Date(cacheData.generated);
  const genStr = gen.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const grade      = cacheData.day_quality.grade;
  const gradeColor = cacheData.market_closed ? '#6b7280'
    : (grade === 'A+' || grade === 'A') ? '#10b981'
    : grade === 'B' ? '#f59e0b' : '#ef4444';
  const gradeLabel = cacheData.market_closed ? 'Market Closed'
    : grade === 'A+' ? 'Strong'
    : grade === 'A'  ? 'Favorable'
    : grade === 'B'  ? 'Selective' : 'Sit Out';

  document.getElementById('headerMeta').textContent = `as of ${genStr}`;
  document.getElementById('dayQualityBadge').innerHTML =
    `<span style="background: ${gradeColor}; color: white; padding: 8px 16px; border-radius: 6px; display: inline-block;">${cacheData.market_closed ? 'Weekend' : grade} — ${gradeLabel}</span>`;

  const w = cacheData.windows || {};
  const fmtWindow = (win) => {
    if (!win?.from) return null;
    return win.from === win.to ? `${win.from} ET` : `${win.from}–${win.to} ET`;
  };

  const pmLabel   = fmtWindow(w.premarket);
  const orbLabel  = fmtWindow(w.opening_range);
  const sessLabel = fmtWindow(w.session);
  const lhLabel   = fmtWindow(w.last_hour);

  const morningParts = [
    pmLabel  && `Pre-market ${pmLabel}`,
    orbLabel && `Opening range ${orbLabel}`,
    'Regime & quality from daily close',
  ].filter(Boolean);
  const eodParts = [
    lhLabel   && `Last hour ${lhLabel}`,
    sessLabel && `VWAP from session ${sessLabel}`,
    'Outcomes from daily OHLCV',
  ].filter(Boolean);

  document.getElementById('morningWindowLabel').textContent = morningParts.join(' · ');
  document.getElementById('eodWindowLabel').textContent     = eodParts.join(' · ');
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
  const alignScore = scores.alignment || {};

  const noDataMsg = '<span class="muted" style="font-size:0.8em;">No pre-market data</span>';
  const fmtVal = (n, suffix = '') => n != null ? n + suffix : '–';

  let html = '';

  // --- SPY price + overnight range chart (Step 1 always shows SPY) ---
  const spyD  = view.symbols['SPY'] || {};
  const pmD   = spyD.premarket || {};
  const prX   = gapRange.prior_close;
  const eoX   = gapRange.est_open;
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
        <div class="muted" style="font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">RTH Open</div>
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
      ${vix.as_of && vix.as_of !== view.session_date
        ? `<span class="muted" style="font-size:0.75em;">close of ${vix.as_of}</span>`
        : ''}
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
        <div class="muted">Index Alignment <span style="font-size:0.85em;">(today's session)</span></div>
        <span>${scoreDots(alignScore.score ?? 0)}</span>
      </div>
      <span style="font-weight:bold; color:${scoreColor(alignScore.score ?? 0)}; font-size:1.1em;">
        ${alignScore.score === 2 ? 'Aligned' : alignScore.score === 1 ? 'Partial' : 'Diverging'}
      </span>
      <div class="muted" style="font-size:0.8em; margin-top:4px;">
        ${Object.entries(alignScore.detail || {}).map(([s, d]) => `${s} ${d === 'up' ? '▲' : d === 'down' ? '▼' : '→'}`).join(' · ') || 'SPY · QQQ · IWM'}
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
        <div class="muted">Index Alignment</div>
        <span style="color: ${regime.index_alignment === 'aligned' ? '#10b981' : '#ef4444'};">
          ${regime.index_alignment}
        </span>
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
  const patterns = view.active_patterns;
  const regime   = view.regime.label;
  const data     = view.symbols[selectedSymbol];

  // Every detected pattern is listed. Regime is a preference, not a veto: the
  // Fit column shows the one-point cost of an off-regime setup rather than
  // hiding the setup outright.
  const symPatterns = patterns.filter(p => p.symbol === selectedSymbol);

  if (symPatterns.length === 0) {
    const reasons = [];
    if (!data.gap_significant && !data.outside_day && !(data.patterns && data.patterns.orb_qualified))
      reasons.push('No pattern detected');
    if (data.rsi_14 > 35 && data.rsi_14 < 65) reasons.push('RSI neutral');
    if (!data.atr_above_avg)                   reasons.push('PM range below avg');
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
  const patterns = view.active_patterns;

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
      const vwap     = data.vwap           || { vwap: null, above_vwap: null, distance_pct: null };
      const rsiDiv   = data.rsi_divergence || { signal: 'unknown' };

      const { score, max, checks } = p.confluence;
      const tradeDay = new Date(view.generated).getDay();
      const weekdayEdge = [2, 3, 4].includes(tradeDay);
      return { symbol: sym, pattern: p.pattern, direction: p.direction, levels: p.levels,
               sizing: p.sizing, plan: p.plan, qualifies: p.qualifies,
               score, max, checks, data, squeeze, vwap, rsiDiv, weekdayEdge };
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
        entry   = `ORB in play — watch for breakout 10:00–11:30 AM`;
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
// EOD TAB
// =============================================================================

function renderEodOutcomes(scored) {
  const el = document.getElementById('eodContent');
  if (!el) return;

  // Guard: this tab describes the finished session, so it stays empty until the
  // session is complete — per the cache phase contract. isMarketOpenForDate only
  // answers whether the date trades at all, which is true all through a live
  // session, so completeness has to be checked too.
  if ((viewingDate && !isMarketOpenForDate(viewingDate)) || !isEodReady()) {
    el.innerHTML = eodGuardHTML(viewingDate || todayET());
    return;
  }

  const sec = (title, body) => `
    <div style="margin-bottom: 24px;">
      <h3 style="margin: 0 0 12px 0; color: #94a3b8; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #2a2a3e; padding-bottom: 6px;">${title}</h3>
      ${body}
    </div>`;

  const pill = (label, value, color, note) => `
    <div class="pill" style="min-width: 0;">
      <div class="muted" style="font-size:0.8em;">${label}</div>
      <span style="font-weight: bold; color: ${color};">${value}</span>
      ${note ? `<div class="muted" style="font-size:0.75em; margin-top:4px;">${note}</div>` : ''}
    </div>`;

  let html = '';

  // Section 1: Day Quality + SPY close
  const grade      = cacheData.day_quality.grade;
  const scores     = cacheData.day_quality.scores || {};
  const gradeColor = (grade === 'A+' || grade === 'A') ? '#10b981' : grade === 'B' ? '#f59e0b' : '#ef4444';
  const gradeLabel = grade === 'A+' ? 'Strong' : grade === 'A' ? 'Favorable' : grade === 'B' ? 'Selective' : 'Sit Out';
  const scoreColor = (s) => s === 2 ? '#10b981' : s === 1 ? '#f59e0b' : '#ef4444';

  const eodSpyClose  = cacheData.symbols?.['SPY']?.close;
  const eodPrevClose = scores.gap_range?.prior_close;
  const eodChangeDol = (eodSpyClose != null && eodPrevClose != null) ? +(eodSpyClose - eodPrevClose).toFixed(2) : null;
  const eodChangePct = (eodChangeDol != null && eodPrevClose) ? +(eodChangeDol / eodPrevClose * 100).toFixed(2) : null;
  const eodColor     = eodChangeDol == null || eodChangeDol === 0 ? '#6b7280' : eodChangeDol > 0 ? '#10b981' : '#ef4444';
  const eodSign      = eodChangeDol != null && eodChangeDol >= 0 ? '+' : '';

  let spyCloseRow = '';
  if (eodSpyClose != null) {
    spyCloseRow = `<div style="display:flex; align-items:center; gap:16px; margin-bottom:12px; background:#22242a; border-radius:6px; padding:10px 14px;">
      <div>
        <div class="muted" style="font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">SPY Close</div>
        <strong style="font-size:1.3em;">$${eodSpyClose.toFixed(2)}</strong>
      </div>
      ${eodChangeDol !== null ? `<span style="background:${eodColor}18; border:1px solid ${eodColor}55; color:${eodColor}; padding:4px 10px; border-radius:4px; font-weight:bold; font-size:0.88em;">
        ${eodChangeDol > 0 ? '↑' : eodChangeDol < 0 ? '↓' : '→'} ${eodSign}$${Math.abs(eodChangeDol).toFixed(2)} (${eodSign}${eodChangePct?.toFixed(2)}%) vs prev close
      </span>` : ''}
    </div>`;
  }

  let dqBody = spyCloseRow + `<div class="metric-grid">
    ${pill('Day Grade',   `${grade} (${scores.total ?? '–'}/${scores.max ?? 8})`, gradeColor, gradeLabel)}
    ${pill('Gap+PM Range', scores.gap_range?.score != null ? `${scores.gap_range.score}/2` : '–', scoreColor(scores.gap_range?.score ?? 0), null)}
    ${pill('Structure',   scores.structure?.regime ?? '–', scoreColor(scores.structure?.score ?? 0), null)}
    ${pill('Alignment',   scores.alignment?.score === 2 ? 'Aligned' : scores.alignment?.score === 1 ? 'Partial' : 'Diverging', scoreColor(scores.alignment?.score ?? 0), null)}
  </div>`;
  if (['C', 'F'].includes(grade)) {
    dqBody += `<div style="margin-top:10px; color:#ef4444; font-size:0.9em;">Low probability day — below the quality threshold for active trading.</div>`;
  }
  dqBody += realizedHTML();
  html += sec('1 — Day Quality', dqBody);

  // Section 2: Market Regime
  const regime       = cacheData.regime;
  const regimeColors = { 'Trending': '#3b82f6', 'Ranging': '#f59e0b', 'Choppy': '#ef4444' };
  const rCol = regimeColors[regime.label] || '#6b7280';
  html += sec('2 — Market Regime', `
    <div class="metric-grid" style="margin-bottom:10px;">
      ${pill('Regime', regime.label, rCol, null)}
      ${pill('Direction', regime.direction, '#e2e8f0', null)}
      ${pill('ATR Trend', regime.atr_trend, '#e2e8f0', null)}
    </div>
    <div class="muted" style="font-size:0.85em;">Favoured patterns today: <strong style="color:#e2e8f0;">${favoredLabel(regime)}</strong></div>`);

  // Section 3: Pattern Outcomes
  const patterns = cacheData.active_patterns.filter(p => p.symbol === selectedSymbol);
  if (patterns.length === 0) {
    html += sec('3 — Pattern Outcomes', `<div class="muted">No patterns detected for ${selectedSymbol} today.</div>`);
  } else {
    const patternCards = patterns.map(p => {
      const oc       = p.outcome || {};
      const lv       = p.levels  || {};
      const dirArrow = p.direction === 'up' ? '▲' : p.direction === 'down' ? '▼' : '—';
      const dirColor = p.direction === 'up' ? '#10b981' : p.direction === 'down' ? '#ef4444' : '#94a3b8';

      let outcomeLabel, outcomeColor;
      const hasOrbLevels = lv.orb_high != null;
      const hasGapFields = lv.fill_target != null || lv.t2_continuation != null || 'filled' in oc;
      if (oc.no_trade) {
        outcomeLabel = `No trade — ${oc.reason || 'setup did not qualify'}`;
        outcomeColor = '#6b7280';
      } else if (oc.next_day) {
        outcomeLabel = 'Next session'; outcomeColor = '#f59e0b';
      } else if (p.pattern.includes('ORB') && hasOrbLevels) {
        if (oc.hit_t1)        { outcomeLabel = '✓ T1 Hit'; outcomeColor = '#10b981'; }
        else if (oc.breached) { outcomeLabel = 'Breached';  outcomeColor = '#f59e0b'; }
        else                  { outcomeLabel = 'No breach'; outcomeColor = '#6b7280'; }
      } else if (p.pattern.includes('Gap') && hasGapFields) {
        const isContinuation = p.pattern.includes('Continuation');
        if (isContinuation) {
          if (oc.hit_t2_continuation)      { outcomeLabel = '✓ T2 Hit'; outcomeColor = '#10b981'; }
          else if (oc.hit_t1_continuation) { outcomeLabel = '✓ T1 Hit'; outcomeColor = '#10b981'; }
          else if (oc.filled)              { outcomeLabel = 'Filled (thesis broke)'; outcomeColor = '#ef4444'; }
          else                             { outcomeLabel = 'Held, no target'; outcomeColor = '#f59e0b'; }
        } else {
          outcomeLabel = oc.filled ? '✓ Filled' : 'Not filled';
          outcomeColor = oc.filled ? '#10b981' : '#f59e0b';
        }
      } else {
        outcomeLabel = '—'; outcomeColor = '#6b7280';
      }

      let levelsInner = '';
      if (lv.orb_high != null) {
        levelsInner = `
          <div><strong>Range:</strong> $${lv.orb_low} – $${lv.orb_high}</div>
          <div><strong>T1↑:</strong> $${lv.t1_up} &nbsp;/&nbsp; <strong>T1↓:</strong> $${lv.t1_down}</div>
          <div><strong>T2↑:</strong> $${lv.t2_up} &nbsp;/&nbsp; <strong>T2↓:</strong> $${lv.t2_down}</div>`;
        if (lv.fill_target != null) {
          levelsInner += `<div><strong>Gap fill:</strong> $${lv.fill_target}</div>`;
        }
      } else if (lv.fill_target != null) {
        levelsInner = `
          <div><strong>Fill target:</strong> $${lv.fill_target}</div>`;
      } else if (lv.t2_continuation != null) {
        levelsInner = `
          <div><strong>Open:</strong> $${lv.today_open}</div>
          <div><strong>Cont. T1:</strong> $${lv.t1_continuation} &nbsp;|&nbsp; <strong>T2:</strong> $${lv.t2_continuation}</div>`;
      } else if (typeof lv.entry === 'number') {
        levelsInner = `
          <div><strong>Entry:</strong> $${lv.entry}</div>
          <div><strong>Stop:</strong> $${lv.stop}</div>
          <div><strong>T1:</strong> $${lv.t1}${lv.t2 ? ` &nbsp;|&nbsp; <strong>T2:</strong> $${lv.t2}` : ''}</div>`;
      }

      return `
        <div class="trade-card" style="border: 2px solid ${dirColor}; border-radius: 6px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div>
              <strong style="font-size: 1.1em;">${p.symbol}</strong>
              <span style="margin-left: 8px; background: ${dirColor}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.8em;">
                ${p.pattern} ${dirArrow}
              </span>
            </div>
            <span style="color: ${outcomeColor}; font-weight: bold; font-size: 0.85em;">${outcomeLabel}</span>
          </div>
          <div class="muted" style="font-size: 0.8em; margin-bottom: 8px;">${p.notes}</div>
          ${levelsInner ? `<div style="background: #22242a; padding: 8px; border-radius: 4px; font-size: 0.85em;">${levelsInner}</div>` : ''}
        </div>`;
    }).join('');
    html += sec('3 — Pattern Outcomes', `<div style="display: flex; flex-wrap: wrap; gap: 12px;">${patternCards}</div>`);
  }

  // Section 4: Confluence Review
  if (!scored || scored.length === 0) {
    html += sec('4 — Confluence Review', '<div class="muted">No trades met confluence threshold (3+).</div>');
  } else {
    const confCards = scored.map(trade => {
      const sc      = trade.score >= 6 ? '#10b981' : trade.score >= 4 ? '#f59e0b' : '#3b82f6';
      const szLabel = trade.sizing?.tier_label || '—';
      const checksHTML = Object.entries(trade.checks).map(([k, v]) =>
        `<div style="color:${v ? '#10b981' : '#4b5563'}; font-size:0.8em;">${v ? '✓' : '✗'} ${k}</div>`
      ).join('');
      return `
        <div class="trade-card" style="border: 2px solid ${sc}; border-radius: 6px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div>
              <strong style="font-size: 1.1em;">${trade.symbol}</strong>
              <span style="margin-left: 8px; background: ${sc}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.8em;">
                ${trade.pattern} ${trade.direction === 'up' ? '▲' : trade.direction === 'down' ? '▼' : '—'}
              </span>
            </div>
            <span style="font-weight: bold; color: ${sc}; font-size: 0.85em;">${trade.score}/8 ${getDotsHTML(trade.score, 8)}</span>
          </div>
          <div style="font-size: 0.8em; font-weight: bold; color: ${sc}; margin-bottom: 8px;">${szLabel}</div>
          <div style="font-size: 0.8em;">${checksHTML}</div>
          <div style="margin-top: 8px; font-size: 0.8em;">Squeeze: ${squeezeHTML(trade.squeeze)}</div>
        </div>`;
    }).join('');
    html += sec('4 — Confluence Review', `<div style="display: flex; flex-wrap: wrap; gap: 12px;">${confCards}</div>`);
  }

  // Section 5: Trade Levels & Outcomes
  const tradablePatterns = patterns.filter(p => p.levels && Object.keys(p.levels).length > 0);
  if (tradablePatterns.length === 0) {
    html += sec('5 — Trade Levels & Outcomes', '<div class="muted">No level data available.</div>');
  } else {
    const tradeCards = tradablePatterns.map(p => {
      const lv          = p.levels;
      const oc          = p.outcome || {};
      const d           = cacheData.symbols[p.symbol];
      const eod         = d.eod_outcome || {};
      const isNextDay   = oc.next_day;
      const scoredEntry = scored ? scored.find(s => s.symbol === p.symbol && s.pattern === p.pattern) : null;
      const score       = scoredEntry ? scoredEntry.score : 0;
      const sc          = score >= 6 ? '#10b981' : score >= 4 ? '#f59e0b' : score >= 2 ? '#3b82f6' : '#6b7280';
      const dirArrow    = p.direction === 'up' ? '▲' : p.direction === 'down' ? '▼' : '—';

      let levelsInner = '';
      const row = (label, value, tail) =>
        `<div style="display:flex; justify-content:space-between;"><span>${label} ${value}</span>${tail}</div>`;

      if (lv.orb_high != null) {
        const bColor  = oc.breached ? (oc.direction === 'up' ? '#10b981' : '#ef4444') : '#6b7280';
        const t1Color = oc.hit_t1 ? '#10b981' : oc.breached ? '#f59e0b' : '#6b7280';
        const breachTail = `<span style="color:${bColor};">${oc.breached ? (oc.direction === 'up' ? '▲ Broke up' : '▼ Broke down') : 'No breach'}</span>`;
        const t1Tail     = `<span style="color:${t1Color};">${oc.hit_t1 ? '✓ Hit' : '—'}</span>`;
        levelsInner =
          row('<strong>Range:</strong>', `$${lv.orb_low} – $${lv.orb_high}`, breachTail) +
          row('<strong>T1↑</strong>',    `$${lv.t1_up} &nbsp;/&nbsp; <strong>T1↓</strong> $${lv.t1_down}`, t1Tail) +
          row('<strong>T2↑</strong>',    `$${lv.t2_up} &nbsp;/&nbsp; <strong>T2↓</strong> $${lv.t2_down}`, '<span class="muted">—</span>');
        if (lv.fill_target != null) {
          const fillColor = oc.filled ? '#10b981' : '#6b7280';
          const fillTail  = `<span style="color:${fillColor};">${oc.filled ? '✓ Filled' : 'Not filled'}</span>`;
          levelsInner += row('<strong>Gap fill:</strong>', `$${lv.fill_target}`, fillTail);
        } else if (lv.t2_continuation != null) {
          const t1cTail = oc.hit_t1_continuation ? '<span style="color:#10b981;">✓ Hit</span>' : '<span class="muted">—</span>';
          const t2cTail = oc.hit_t2_continuation ? '<span style="color:#10b981;">✓ Hit</span>' : '<span class="muted">—</span>';
          levelsInner += row('<strong>Cont. T1:</strong>', `$${lv.t1_continuation}`, t1cTail);
          levelsInner += row('<strong>Cont. T2:</strong>', `$${lv.t2_continuation}`, t2cTail);
        }
      } else if (lv.fill_target != null) {
        const fillColor = oc.filled ? '#10b981' : '#6b7280';
        const fillTail  = `<span style="color:${fillColor};">${oc.filled ? '✓ Filled' : 'Not filled'}</span>`;
        levelsInner = row('<strong>Fill target:</strong>', `$${lv.fill_target}`, fillTail);
      } else if (lv.t2_continuation != null) {
        const t1Tail = oc.hit_t1_continuation
          ? '<span style="color:#10b981;">✓ Hit</span>'
          : (oc.filled ? '<span style="color:#ef4444;">Missed</span>' : '<span class="muted">—</span>');
        const t2Tail = oc.hit_t2_continuation
          ? '<span style="color:#10b981;">✓ Hit</span>'
          : (oc.filled ? '<span style="color:#ef4444;">Missed</span>' : '<span class="muted">—</span>');
        const filledTail = oc.filled
          ? '<span style="color:#ef4444;">Filled (thesis broke)</span>'
          : '<span style="color:#10b981;">✓ Held</span>';
        levelsInner =
          row('<strong>Open:</strong>',     `$${lv.today_open}`, filledTail) +
          row('<strong>Cont. T1:</strong>', `$${lv.t1_continuation}`, t1Tail) +
          row('<strong>Cont. T2:</strong>', `$${lv.t2_continuation}`, t2Tail);
      } else if (typeof lv.entry === 'number') {
        levelsInner =
          row('<strong>Entry:</strong>',       `$${lv.entry}`, `<span style="color:#f59e0b;">${isNextDay ? 'Next session' : '—'}</span>`) +
          row('<strong>Stop:</strong>',        `$${lv.stop}`,  '<span class="muted">—</span>') +
          row('<strong>T1 (1.5×):</strong>',   `$${lv.t1}`,    '<span class="muted">—</span>') +
          (lv.t2 ? row('<strong>T2 (2×):</strong>', `$${lv.t2}`, '<span class="muted">—</span>') : '');
      }

      return `
        <div class="trade-card" style="border: 2px solid ${sc}; border-radius: 6px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <strong style="font-size: 1.1em;">${p.symbol}</strong>
              <span style="margin-left: 8px; background: ${sc}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.8em;">
                ${p.pattern} ${dirArrow}
              </span>
            </div>
            ${score > 0 ? `<span style="font-weight: bold; color: ${sc}; font-size: 0.85em;">${score}/8 ${getDotsHTML(score, 8)}</span>` : ''}
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; font-size: 0.85em;">
            <div><div class="muted">Close</div><strong>$${d.close}</strong></div>
            <div><div class="muted">ATR (14)</div><strong>${d.atr_14}</strong></div>
          </div>
          <div style="background: #22242a; padding: 8px; border-radius: 4px; font-size: 0.85em; margin-bottom: 10px;">
            ${levelsInner}
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 0.8em;">
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">Day Range</div>
              <strong>$${eod.day_range}</strong>
            </div>
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">ATR Multiple</div>
              <strong>${eod.day_atr_multiple}×</strong>
            </div>
          </div>
        </div>`;
    }).join('');
    html += sec('5 — Trade Levels & Outcomes', `<div style="display: flex; flex-wrap: wrap; gap: 12px;">${tradeCards}</div>`);
  }

  // Section 6: Prior Session Setups — resolves the previous bar's next-session
  // patterns (Engulfing, Outside Day) against today's high/low.
  const priorEntries = Object.entries(cacheData.symbols || {})
    .flatMap(([sym, sd]) => (sd.prior_setups || []).map(r => ({ symbol: sym, ...r })))
    .filter(r => r.symbol === selectedSymbol);

  if (priorEntries.length === 0) {
    html += sec('6 — Prior Session Setups', `<div class="muted">No next-day setup fired on ${selectedSymbol}'s prior bar.</div>`);
  } else {
    const priorCards = priorEntries.map(r => {
      const dirArrow = r.direction === 'up' ? '▲' : '▼';
      const dirColor = r.direction === 'up' ? '#10b981' : '#ef4444';

      let label, color;
      if (!r.triggered)     { label = 'Not triggered';   color = '#6b7280'; }
      else if (r.hit_t2)    { label = '✓ T2 Hit';        color = '#10b981'; }
      else if (r.hit_t1)    { label = '✓ T1 Hit';        color = '#10b981'; }
      else if (r.stop_hit)  { label = '✗ Stopped';       color = '#ef4444'; }
      else                  { label = 'Triggered, open'; color = '#f59e0b'; }

      const row = (lbl, val, tail) =>
        `<div style="display:flex; justify-content:space-between;"><span><strong>${lbl}:</strong> ${val}</span>${tail}</div>`;
      const check = (cond, hit) => cond
        ? `<span style="color:${hit ? '#10b981' : '#ef4444'};">${hit ? '✓ Hit' : '✗ Hit'}</span>`
        : '<span class="muted">—</span>';

      const rowsInner =
        row('Entry', `$${r.entry}`, `<span style="color:${r.triggered ? '#10b981' : '#6b7280'};">${r.triggered ? '✓ Triggered' : 'Not reached'}</span>`) +
        row('Stop',  `$${r.stop}`,  check(r.triggered, r.stop_hit)) +
        row('T1',    `$${r.t1}`,    check(r.triggered, r.hit_t1)) +
        (r.t2 != null ? row('T2', `$${r.t2}`, check(r.triggered, r.hit_t2)) : '');

      return `
        <div class="trade-card" style="border: 2px solid ${dirColor}; border-radius: 6px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <strong style="font-size: 1.1em;">${r.symbol}</strong>
              <span style="margin-left: 8px; background: ${dirColor}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.8em;">
                ${r.pattern} ${dirArrow}
              </span>
            </div>
            <span style="font-weight: bold; color: ${color}; font-size: 0.85em;">${label}</span>
          </div>
          <div style="background: #22242a; padding: 8px; border-radius: 4px; font-size: 0.85em;">${rowsInner}</div>
        </div>`;
    }).join('');
    html += sec('6 — Prior Session Setups', `<div style="display: flex; flex-wrap: wrap; gap: 12px;">${priorCards}</div>`);
  }

  el.innerHTML = html;
}

// =============================================================================
// MAIN RENDER ORCHESTRATION
// =============================================================================

function renderAll() {
  ['step-2','step-3','step-4','step-5'].forEach(id => {
    document.getElementById(id).style.display = '';
  });

  // Built once per render. Morning renderers get `morning` and can only see
  // pre-open fields; the EOD tab reads the full cache directly.
  const morning = buildMorningView(cacheData);

  renderHeader();
  renderDayQuality(morning);

  if (cacheData.market_closed) {
    ['step-2','step-3','step-4','step-5'].forEach(id => {
      document.getElementById(id).style.display = 'none';
    });
    // Clear EOD tab
    const eodEl = document.getElementById('eodContent');
    if (eodEl) eodEl.innerHTML = eodGuardHTML(viewingDate || todayET());
    return;
  }

  // Steps 2-6 read regime, active_patterns and the per-symbol indicators, all of
  // which the generator writes in every phase from bars prior to session_date.
  // None of them reads eod_outcome — only the EOD tab does, and it guards itself.
  // So they render whatever the phase, and the plan is available pre-open.
  if (!isEodReady()) {
    document.getElementById('step1Content').insertAdjacentHTML('beforeend',
      `<div class="muted" style="margin-top:12px; font-size:0.85em;">
        ${sessionPhase() === 'intraday'
          ? 'Session in progress — the plan below is built from prior sessions and premarket. Outcomes appear after the post-close report.'
          : "Pre-open — the plan below is built from prior sessions and premarket. Outcomes appear after the post-close report."}
      </div>`);
  }

  renderRegime(morning);
  renderPatternScanner(morning);
  const scored = scoreConfluences(morning);
  scoredTrades = scored;
  renderRecommendations(morning, scored);
  renderEodOutcomes(scored);
}

function renderWeekend(dateStr) {
  viewingDate = dateStr;
  ['step-2','step-3','step-4','step-5'].forEach(id =>
    document.getElementById(id).style.display = 'none');
  document.getElementById('headerMeta').textContent = dateStr;
  document.getElementById('dayQualityBadge').innerHTML =
    `<span style="background: #6b7280; color: white; padding: 8px 16px; border-radius: 6px; display: inline-block;">Weekend — Market Closed</span>`;
  document.getElementById('step1Content').innerHTML = `
    <div style="background: #1e2330; border-left: 4px solid #6b7280; padding: 12px; border-radius: 4px;">
      <strong style="color: #9ca3af;">Market Closed — Weekend</strong><br>
      <span class="muted">No grading until Monday.</span>
    </div>`;
  // Also clear the EOD tab so it doesn't show stale data from a prior session
  const eodEl = document.getElementById('eodContent');
  if (eodEl) eodEl.innerHTML = eodGuardHTML(dateStr);
}

async function loadAndRender(dateStr) {
  viewingDate = dateStr || todayET();
  if (isWeekend(dateStr)) {
    renderWeekend(dateStr);
    return;
  }

  const url = (dateStr === latestDate || !dateStr)
    ? 'data/cache/trading_signals.json'
    : `data/cache/trading_signals_${dateStr}.json`;

  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 404) {
      ['step-2','step-3','step-4','step-5'].forEach(id =>
        document.getElementById(id).style.display = 'none');
      document.getElementById('step1Content').innerHTML =
        `<div style="color: #9ca3af; padding: 12px;">No data available for ${dateStr}.</div>`;
      // Clear EOD tab so it doesn't show stale data
      const eodEl = document.getElementById('eodContent');
      if (eodEl) eodEl.innerHTML = eodGuardHTML(viewingDate);
      return;
    }
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  cacheData = await response.json();
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

  try {
    const response = await fetch('data/cache/trading_signals.json');
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
    cacheData = await response.json();

    latestDate = cacheData.symbols?.SPY?.date || todayET();
    const today = todayET();

    // Populate symbol selector
    const selector = document.getElementById('symbolSelector');
    Object.keys(cacheData.symbols).forEach(sym => {
      const opt = document.createElement('option');
      opt.value = sym;
      opt.textContent = sym;
      if (sym === selectedSymbol) opt.selected = true;
      selector.appendChild(opt);
    });
    selector.addEventListener('change', () => {
      selectedSymbol = selector.value;
      // renderAll rebuilds the morning view and passes it to every renderer.
      // Calling the renderers directly here left them on their pre-view-model
      // signatures, and re-applied a C/F veto the page no longer honours.
      renderAll();
    });

    const picker = document.getElementById('tradeDatePicker');
    picker.value = today;
    picker.max   = today;

    picker.addEventListener('change', async () => {
      try {
        await loadAndRender(picker.value);
      } catch (error) {
        console.error('Error loading date:', error);
        document.getElementById('step1Content').innerHTML =
          `<div class="error">Error loading data: ${error.message}</div>`;
      }
    });

    document.getElementById('tradeDateToday').addEventListener('click', async () => {
      picker.value = today;
      await loadAndRender(today);
    });

    if (isWeekend(today)) {
      viewingDate = today;
      renderWeekend(today);
    } else if (today === latestDate) {
      viewingDate = today;
      renderAll();
    } else {
      await loadAndRender(today);
    }

  } catch (error) {
    console.error('Error:', error);
    document.getElementById('step-1').innerHTML =
      `<div class="error">Error loading data: ${error.message}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
