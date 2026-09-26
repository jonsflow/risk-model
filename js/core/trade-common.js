// js/core/trade-common.js — shared by the live trade page and the recap page.
//
// Both pages load one session file, data/cache/trading_signals_<date>.json,
// written by pipeline/generators/trading_generator.py. It holds one section per
// stage (premarket, open, opening_range, recap); a stage whose data isn't there
// yet carries a standard not-available message instead of results.

export const STAGES = ['premarket', 'open', 'opening_range', 'recap'];

export function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function isWeekend(dateStr) {
  const day = new Date(dateStr + 'T12:00:00').getDay();
  return day === 0 || day === 6;
}

// A stage whose data isn't there yet is written as
// { status: 'not_available', window_end, message } — the page shows the
// message and no data for that stage.
export function hasStage(session, stage) {
  const section = session?.[stage];
  return !!section && Object.keys(section).length > 0 && section.status !== 'not_available';
}

export function stageMessage(session, stage) {
  return session?.[stage]?.message || '';
}

/** The session file for dateStr, or null if the generator hasn't written it. */
export async function loadSession(dateStr) {
  const res = await fetch(`data/cache/trading_signals_${dateStr}.json`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  return res.json();
}

export const gradeColor = (g) =>
  (g === 'A+' || g === 'A') ? '#10b981' : g === 'B' ? '#f59e0b' : '#ef4444';

export const gradeLabel = (g) =>
  g === 'A+' ? 'Strong' : g === 'A' ? 'Favorable' : g === 'B' ? 'Selective' : 'Sit Out';

export function getDotsHTML(filled, total) {
  let dots = '';
  for (let i = 0; i < total; i++) dots += i < filled ? '●' : '○';
  return dots;
}

export function noticeHTML(title, detail, color = '#6b7280') {
  return `<div style="background:#1e2330; border-left:4px solid ${color}; padding:12px 14px; border-radius:4px;">
    <strong style="color:${color};">${title}</strong><br>
    <span class="muted">${detail}</span>
  </div>`;
}

/** Fill a <select> with the session's symbols, keeping `selected` if present. */
export function fillSymbolSelector(selector, symbols, selected) {
  selector.innerHTML = '';
  symbols.forEach(sym => {
    const opt = document.createElement('option');
    opt.value = sym;
    opt.textContent = sym;
    if (sym === selected) opt.selected = true;
    selector.appendChild(opt);
  });
  return symbols.includes(selected) ? selected : (symbols[0] || selected);
}
