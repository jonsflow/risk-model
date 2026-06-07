// js/core/utils.js — Shared formatting, colors, and signal utilities.
// Single source of truth; replaces duplicated helpers across 9 app files.

export const COLORS = {
  green:   '#4caf50',
  yellow:  '#ffc107',
  orange:  '#ff9800',
  red:     '#f44336',
  gray:    '#888',
  blue:    '#64b5f6',
  white:   '#e9e9ea',
};

// ------------------------------------------------------------------
// Number formatting
// ------------------------------------------------------------------

export function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(decimals);
}

export function fmtPct(n, decimals = 1) {
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(decimals)}%`;
}

export function fmtPrice(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ------------------------------------------------------------------
// Color helpers
// ------------------------------------------------------------------

export function scoreColor(score, thresholds = [0.7, 0.55, 0.45, 0.25]) {
  const [strong, moderate, neutral, weak] = thresholds;
  if (score >= strong)   return COLORS.green;
  if (score >= moderate) return COLORS.yellow;
  if (score >= neutral)  return COLORS.gray;
  if (score >= weak)     return COLORS.orange;
  return COLORS.red;
}

export function signalColor(signal = '') {
  if (!signal) return COLORS.gray;
  const s = signal.toUpperCase();
  if (s.includes('BEARISH'))      return COLORS.red;
  if (s.includes('BULLISH'))      return COLORS.green;
  if (s.includes('RISK ON'))      return COLORS.green;
  if (s.includes('RISK OFF'))     return COLORS.red;
  if (s.includes('NEUTRAL'))      return COLORS.gray;
  if (s.includes('GOLDILOCKS'))   return COLORS.green;
  if (s.includes('STAGFLATION'))  return COLORS.red;
  if (s.includes('INFLATIONARY')) return COLORS.yellow;
  if (s.includes('RECESSION'))    return COLORS.blue;
  if (s.includes('ALIGNED'))      return COLORS.blue;
  if (s.includes('MIXED'))        return COLORS.orange;
  return COLORS.gray;
}

export function aboveMaColor(aboveMa) {
  if (aboveMa === true)  return COLORS.green;
  if (aboveMa === false) return COLORS.red;
  return COLORS.gray;
}

export function correlationColor(corr) {
  if (corr == null) return COLORS.gray;
  const abs = Math.abs(corr);
  if (abs >= 0.7) return corr > 0 ? COLORS.green  : COLORS.red;
  if (abs >= 0.4) return corr > 0 ? COLORS.yellow : COLORS.orange;
  return COLORS.gray;
}

// ------------------------------------------------------------------
// Moving average (client-side, for FRED / credit pages)
// ------------------------------------------------------------------

export function calculateMA(data, period) {
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j].value;
    result.push({ time: data[i].time, value: sum / period });
  }
  return result;
}

// ------------------------------------------------------------------
// Date helpers
// ------------------------------------------------------------------

export function formatDate(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function daysAgo(isoStr) {
  if (!isoStr) return null;
  return Math.round((Date.now() - new Date(isoStr).getTime()) / 86_400_000);
}

// ------------------------------------------------------------------
// Signal label helpers
// ------------------------------------------------------------------

export function riskLabel(pct) {
  if (pct >= 70) return '🟢 STRONG RISK ON';
  if (pct >= 55) return '🟡 RISK ON';
  if (pct >= 45) return '⚪ NEUTRAL';
  if (pct >= 25) return '🟠 RISK OFF';
  return '🔴 STRONG RISK OFF';
}

export function gradeColor(grade) {
  const map = { 'A+': COLORS.green, A: COLORS.green, B: COLORS.yellow, C: COLORS.orange, F: COLORS.red };
  return map[grade] ?? COLORS.gray;
}
