// js/components/SignalCard.js — Renders a signal score card element.

import { signalColor, aboveMaColor, fmt, fmtPct } from '../core/utils.js';

/**
 * Build and return a DOM element for a macro asset card.
 *
 * @param {object} asset  - {symbol, name, price, pct_change, above_ma, ma_value}
 * @param {object} opts
 * @param {Function} opts.onClick  - called with asset when card is clicked
 * @returns {HTMLElement}
 */
export function buildAssetCard(asset, opts = {}) {
  const card = document.createElement('div');
  card.className = 'asset-card';
  card.dataset.symbol = asset.symbol;

  const color = aboveMaColor(asset.above_ma);
  const pctStr = asset.pct_change != null ? fmtPct(asset.pct_change) : '—';
  const pctColor = (asset.pct_change ?? 0) >= 0 ? '#4caf50' : '#f44336';

  card.innerHTML = `
    <div class="asset-symbol" style="color:${color}">${asset.symbol}</div>
    <div class="asset-name">${asset.name ?? ''}</div>
    <div class="asset-price">${asset.price != null ? fmt(asset.price, asset.price > 100 ? 2 : 4) : '—'}</div>
    <div class="asset-change" style="color:${pctColor}">${pctStr}</div>
    <div class="asset-ma-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">
      ${asset.above_ma === true ? 'Above MA' : asset.above_ma === false ? 'Below MA' : 'No data'}
    </div>
  `;

  if (opts.onClick) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => opts.onClick(asset));
  }

  return card;
}

/**
 * Build a regime / signal badge.
 *
 * @param {string} label   - signal text, e.g. "🟢 STRONG RISK ON"
 * @param {string} sublabel - optional secondary text
 * @returns {HTMLElement}
 */
export function buildSignalBadge(label, sublabel = '') {
  const color = signalColor(label);
  const el = document.createElement('div');
  el.className = 'signal-badge';
  el.style.cssText = `border:2px solid ${color};border-radius:8px;padding:12px 16px;text-align:center;`;
  el.innerHTML = `
    <div style="font-size:1.1rem;font-weight:700;color:${color}">${label}</div>
    ${sublabel ? `<div style="font-size:0.8rem;color:#888;margin-top:4px">${sublabel}</div>` : ''}
  `;
  return el;
}
