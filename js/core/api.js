// js/core/api.js — Unified fetch wrapper for all JSON cache files.
// Replaces scattered fetch() calls across 9 app files.

const BASE = '';  // served from repo root via GitHub Pages

/**
 * Fetch a JSON cache file with a simple error boundary.
 * @param {string} path - relative path, e.g. 'data/cache/macro_50_50.json'
 * @returns {Promise<any>}
 */
export async function fetchCache(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

/**
 * Fetch a FRED series bundle.
 * @returns {Promise<{fetched_at: string, series: Record<string, [string, number][]>}>}
 */
export function fetchFredBundle() {
  return fetchCache('data/fred/fred_cache.json');
}

/**
 * Fetch divergence cache for the given parameters.
 */
export function fetchDivergence(lookback, pivotMode, swing) {
  return fetchCache(`data/cache/divergence_${lookback}_${pivotMode}_${swing}.json`);
}

/**
 * Fetch macro cache for the given parameters.
 */
export function fetchMacro(lookback, maPeriod) {
  return fetchCache(`data/cache/macro_${lookback}_${maPeriod}.json`);
}

/**
 * Fetch the trading signals cache.
 */
export function fetchTradingSignals() {
  return fetchCache('data/cache/trading_signals.json');
}

/**
 * Fetch the correlations cache.
 */
export function fetchCorrelations() {
  return fetchCache('data/cache/correlations.json');
}

/**
 * Fetch the trend structure cache.
 */
export function fetchTrendStructure() {
  return fetchCache('data/cache/trend_structure.json');
}

/**
 * Fetch the last-updated timestamp.
 * @returns {Promise<string>}
 */
export async function fetchLastUpdated() {
  const res = await fetch('data/last_updated.txt');
  return res.ok ? res.text() : 'Unknown';
}
