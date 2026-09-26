// js/pages/trade_recap.js — Trade Recap page (ES module).
//
// Loads trading_signals_<date>.json and renders its `recap` section: each
// stage's calls graded against the finished session. Until the session's data
// is complete the recap carries the generator's not-available message, and
// this page shows it rather than a partial day.
import { renderNav } from '../components/Navigation.js';
import { todayET, isWeekend, hasStage, stageMessage, loadSession, gradeColor, gradeLabel,
         getDotsHTML, noticeHTML, fillSymbolSelector } from '../core/trade-common.js';

let session        = null;
let selectedSymbol = 'SPY';

const sec = (title, body) => `
  <div class="card">
    <h2>${title}</h2>
    ${body}
  </div>`;

const cell = (label, value, color) => `
  <div>
    <div class="muted" style="font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;">${label}</div>
    <strong style="color:${color || '#e5e7eb'};">${value}</strong>
  </div>`;

const row = (content) => `<div style="display:flex; flex-wrap:wrap; gap:18px; margin-bottom:10px;">${content}</div>`;

// Forecast vs outcome: the premarket day grade against what the session
// delivered, on the same 0-8 scale.
function dayHTML() {
  const r   = session.recap.day_realized;
  const spy = session.recap.symbols?.SPY;
  const pre = session.premarket.symbols?.SPY;
  if (!r) return '<div class="muted">No SPY bar for this session.</div>';

  const chg    = spy && pre ? +(spy.close - pre.prior_close).toFixed(2) : null;
  const chgPct = chg != null ? +(chg / pre.prior_close * 100).toFixed(2) : null;
  const chgCol = chg == null || chg === 0 ? '#6b7280' : chg > 0 ? '#10b981' : '#ef4444';
  const sign   = chg == null ? '' : chg >= 0 ? '+' : '−';

  const expColor = { expansion: '#10b981', normal: '#f59e0b', compression: '#ef4444' }[r.expansion] || '#6b7280';
  const expLabel = { expansion: 'Expansion', normal: 'Normal', compression: 'Compression' }[r.expansion] || '–';
  const drift = (r.forecast_total != null && r.total != null) ? r.total - r.forecast_total : null;
  const driftHTML = drift === null ? ''
    : drift >= 2  ? `<span style="color:#10b981;">delivered ${drift} pts above the premarket call</span>`
    : drift <= -2 ? `<span style="color:#ef4444;">delivered ${Math.abs(drift)} pts below the premarket call</span>`
    : '<span class="muted">in line with the premarket call</span>';

  return `
    ${spy ? row(
      cell('SPY Close', `$${spy.close.toFixed(2)}`) +
      (chg != null ? cell('vs Prior Close', `${sign}$${Math.abs(chg).toFixed(2)} (${sign}${Math.abs(chgPct)}%)`, chgCol) : '')
    ) : ''}
    <div style="background:#22242a; border-left:4px solid ${gradeColor(r.grade)}; border-radius:4px; padding:12px 14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <strong style="color:${gradeColor(r.grade)};">What actually happened — ${r.grade} (${gradeLabel(r.grade)})</strong>
        <span style="font-size:1.2em; font-weight:bold; color:${gradeColor(r.grade)};">${r.total}/${r.max}</span>
      </div>
      ${row(
        cell('Range', `$${r.range?.toFixed(2)} (${r.range_pct?.toFixed(2)}%)`) +
        cell('vs ATR', `${r.atr_multiple?.toFixed(2)}x`, r.atr_multiple >= 1 ? '#10b981' : '#6b7280') +
        cell('Profile', expLabel, expColor) +
        cell('Close in range', `${Math.round((r.close_location ?? 0) * 100)}%`) +
        cell('Trend day', r.trend_day ? 'Yes' : 'No', r.trend_day ? '#10b981' : '#6b7280')
      )}
      <div style="font-size:0.9em;">${r.verdict}</div>
      <div style="font-size:0.85em; margin-top:4px;">
        Premarket call: <strong style="color:${gradeColor(r.forecast_grade)};">${r.forecast_grade} (${r.forecast_total}/8)</strong>
        · regime ${session.premarket.regime?.label ?? '–'} — ${driftHTML}
      </div>
    </div>`;
}

function symbolHTML() {
  const s = session.recap.symbols?.[selectedSymbol];
  if (!s) return `<div class="muted">No completed bar for ${selectedSymbol}.</div>`;
  const e = s.eod_outcome || {};
  const orb = e.orb_high == null ? '–'
    : e.orb_breached ? `${e.orb_direction === 'up' ? '▲ Broke up' : '▼ Broke down'}${e.orb_hit_t1 ? ' · T1 hit' : ''}`
    : 'No breach';
  const call = s.first_bar_call;
  return row(
    cell('O / H / L / C', `${s.open} / ${s.high} / ${s.low} / ${s.close}`) +
    cell('Day Range', `$${e.day_range} (${e.day_atr_multiple}× ATR)`) +
    cell('Gap', e.gap_filled ? 'Filled' : 'Not filled', e.gap_filled ? '#10b981' : '#6b7280') +
    cell(`Opening Range${e.orb_high != null ? ` $${e.orb_low}–$${e.orb_high}` : ''}`, orb) +
    (call ? cell('First-bar call', `${call.call === 'toward_fill' ? 'Toward fill' : 'With gap'} — ${call.correct ? '✓ right' : '✗ wrong'}`,
                 call.correct ? '#10b981' : '#ef4444') : '')
  );
}

function outcomeLabel(pattern, oc) {
  if (pattern === 'Gap Fill') return oc.filled ? ['✓ Filled', '#10b981'] : ['Not filled', '#f59e0b'];
  if (pattern === 'Gap Continuation') {
    if (oc.hit_t2_continuation) return ['✓ T2 Hit', '#10b981'];
    if (oc.hit_t1_continuation) return ['✓ T1 Hit', '#10b981'];
    return ['No target', '#f59e0b'];
  }
  if (pattern === 'ORB') {
    if (oc.hit_t1)   return ['✓ T1 Hit', '#10b981'];
    if (oc.breached) return [`Breached ${oc.direction}`, '#f59e0b'];
    return ['No breach', '#6b7280'];
  }
  if (!oc.triggered) return ['Not triggered', '#6b7280'];
  if (oc.hit_t2)     return ['✓ T2 Hit', '#10b981'];
  if (oc.hit_t1)     return ['✓ T1 Hit', '#10b981'];
  if (oc.stop_hit)   return ['✗ Stopped', '#ef4444'];
  return ['Triggered, open', '#f59e0b'];
}

function levelsHTML(lv) {
  if (lv.or_high != null) return `Range $${lv.or_low} – $${lv.or_high} · T1 ▲$${lv.t1_up} ▼$${lv.t1_down}`;
  if (lv.fill_target != null) return `Last print $${lv.last_print} → fill $${lv.fill_target}`;
  if (lv.t1_continuation != null) return `Last print $${lv.last_print} · T1 $${lv.t1_continuation} · T2 $${lv.t2_continuation}`;
  if (typeof lv.entry === 'number') return `Entry $${lv.entry} · Stop $${lv.stop} · T1 $${lv.t1}${lv.t2 ? ` · T2 $${lv.t2}` : ''}`;
  return '';
}

// Each graded call joined back to the call itself, so its levels and score
// show beside the outcome.
function callsHTML() {
  const source = hasStage(session, 'opening_range')
    ? session.opening_range.patterns || [] : session.premarket.watchlist || [];
  const calls = (session.recap.patterns || []).filter(p => p.symbol === selectedSymbol);
  if (!calls.length) return `<div class="muted">No setups were called for ${selectedSymbol}.</div>`;
  return `<div style="display:flex; flex-wrap:wrap; gap:12px;">${calls.map(c => {
    const src = source.find(p => p.symbol === c.symbol && p.pattern === c.pattern) || {};
    const [label, color] = outcomeLabel(c.pattern, c.outcome || {});
    const conf = src.confluence;
    const dirArrow = c.direction === 'up' ? '▲' : c.direction === 'down' ? '▼' : '—';
    return `
      <div class="trade-card" style="border: 2px solid ${color}; border-radius: 6px; padding: 14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:8px;">
          <strong>${c.pattern} ${dirArrow}</strong>
          <span style="color:${color}; font-weight:bold; font-size:0.85em;">${label}</span>
        </div>
        <div class="muted" style="font-size:0.8em; margin-bottom:6px;">${src.notes || ''}</div>
        <div style="font-size:0.85em;">${levelsHTML(src.levels || {})}</div>
        ${conf ? `<div style="font-size:0.8em; margin-top:6px;">Confluence ${conf.score}/${conf.max} ${getDotsHTML(conf.score, conf.max)}
          ${src.qualifies ? '· qualified' : '· below threshold'}</div>` : ''}
        <div class="muted" style="font-size:0.75em; margin-top:6px;">Called at ${c.stage === 'opening_range' ? 'opening range' : 'premarket'}</div>
      </div>`;
  }).join('')}</div>`;
}

function render() {
  const el = document.getElementById('recapContent');
  el.innerHTML =
    sec('Day — Premarket Call vs Outcome', dayHTML()) +
    sec(`${selectedSymbol} — Session`, symbolHTML()) +
    sec(`${selectedSymbol} — Calls Graded`, callsHTML());
}

async function load(dateStr) {
  const el = document.getElementById('recapContent');
  document.getElementById('liveLink').href = `pages/trade.html`;
  document.getElementById('headerMeta').textContent = dateStr;
  history.replaceState(null, '', `?date=${dateStr}`);
  if (isWeekend(dateStr)) {
    el.innerHTML = noticeHTML('Market Closed — Weekend', 'No session to recap. Pick a weekday.');
    return;
  }
  session = await loadSession(dateStr);
  if (!session) {
    el.innerHTML = noticeHTML('No data', `The generator hasn't written ${dateStr}.`);
    return;
  }
  if (!session.premarket) {
    el.innerHTML = noticeHTML('Written in the old format',
      `${dateStr} predates the stage layout. Regenerate it with scripts/backfill_trading_history.py --force.`);
    return;
  }
  if (!hasStage(session, 'recap')) {
    el.innerHTML = noticeHTML('Recap not available', stageMessage(session, 'recap'), '#eab308');
    return;
  }
  const selector = document.getElementById('symbolSelector');
  selectedSymbol = fillSymbolSelector(selector, Object.keys(session.recap.symbols || {}), selectedSymbol);
  document.getElementById('headerMeta').textContent =
    `${dateStr} · as of ${new Date(session.generated).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  render();
}

async function init() {
  renderNav();
  const today  = todayET();
  const picker = document.getElementById('recapDatePicker');
  const start  = new URLSearchParams(location.search).get('date') || today;
  picker.value = start;
  picker.max   = today;

  const run = async (d) => {
    try { await load(d); }
    catch (err) {
      console.error(err);
      document.getElementById('recapContent').innerHTML = `<div class="error">Error loading data: ${err.message}</div>`;
    }
  };
  picker.addEventListener('change', () => run(picker.value));
  document.getElementById('symbolSelector').addEventListener('change', (e) => {
    selectedSymbol = e.target.value;
    if (session) render();
  });
  await run(start);
}

document.addEventListener('DOMContentLoaded', init);
