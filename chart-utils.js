// =============================================================================
// chart-utils.js — Shared lightweight-charts helpers
// Exposes window.ChartUtils via IIFE — no build step required.
// =============================================================================

(function (global) {
  'use strict';

  const LC = global.LightweightCharts;

  // Whitelisted top-level keys that callers may override via the overrides arg.
  const OVERRIDE_KEYS = ['layout', 'grid', 'crosshair', 'rightPriceScale', 'timeScale'];

  function mergeOverrides(base, overrides) {
    if (!overrides) return base;
    const result = Object.assign({}, base);
    for (const key of OVERRIDE_KEYS) {
      if (overrides[key] !== undefined) {
        result[key] = Object.assign({}, base[key], overrides[key]);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // createDashboardChart
  // Dark solid background (#17181b), #333 grid, scroll/scale locked.
  // Attaches a ResizeObserver so the chart reflows on window resize.
  // ---------------------------------------------------------------------------
  function createDashboardChart(el, height, overrides) {
    const base = {
      layout: {
        background: { type: 'solid', color: '#17181b' },
        textColor: '#e9e9ea',
      },
      grid: {
        vertLines: { color: '#333' },
        horzLines: { color: '#333' },
      },
      handleScroll: false,
      handleScale: false,
      width: el.clientWidth,
      height,
    };

    const opts = mergeOverrides(base, overrides);
    const chart = LC.createChart(el, opts);
    new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
    return chart;
  }

  // ---------------------------------------------------------------------------
  // createFomcChart
  // Transparent background, #1e1e2e grid, Normal crosshair, timeVisible true.
  // ---------------------------------------------------------------------------
  function createFomcChart(el, height, overrides) {
    const base = {
      layout: {
        background: { color: 'transparent' },
        textColor: '#a7a7ad',
      },
      grid: {
        vertLines: { color: '#1e1e2e' },
        horzLines: { color: '#1e1e2e' },
      },
      crosshair: { mode: LC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2a3e' },
      timeScale: { borderColor: '#2a2a3e', timeVisible: true, minBarSpacing: 0.1 },
      handleScroll: false,
      handleScale: false,
      width: el.clientWidth,
      height,
    };

    const opts = mergeOverrides(base, overrides);
    const chart = LC.createChart(el, opts);
    new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
    return chart;
  }

  // ---------------------------------------------------------------------------
  // fitWithRightPadding
  // Bar-count based: rightOffset = pct of dataLength, then fitContent.
  // Use for dashboard charts where all series have uniform daily/hourly density.
  // pct defaults to 0.075. Increase for charts in narrow columns or with very
  // long histories where minBarSpacing compresses bars close to 0.1px each.
  // ---------------------------------------------------------------------------
  function fitWithRightPadding(chart, dataLength, pct) {
    pct = pct !== undefined ? pct : 0.02;
    chart.timeScale().applyOptions({ rightOffset: Math.ceil(dataLength * pct) });
    chart.timeScale().fitContent();
  }

  // ---------------------------------------------------------------------------
  // fitWithDateRangePadding
  // Without dataFrom/dataTo: fitContent() + extend `to` by pct (fallback).
  // With dataFrom/dataTo: bypasses fitContent entirely — sets the visible
  // range directly from the actual data bounds, adding pct padding on the
  // right. Use this for charts where fitContent's bar-spacing floor prevents
  // showing all historical data (e.g. 70-year series).
  // Handles both string dates ('YYYY-MM-DD') and UTCTimestamp (seconds).
  // ---------------------------------------------------------------------------
  function fitWithDateRangePadding(chart, pct, dataFrom, dataTo) {
    pct = pct !== undefined ? pct : 0.075;

    let from, fromMs, toMs, isTs;

    if (dataFrom !== undefined && dataTo !== undefined) {
      // Use caller-supplied bounds — no fitContent() call needed
      from   = dataFrom;
      isTs   = typeof dataTo === 'number';
      fromMs = isTs ? dataFrom * 1000 : +new Date(dataFrom + 'T00:00:00Z');
      toMs   = isTs ? dataTo   * 1000 : +new Date(dataTo   + 'T00:00:00Z');
    } else {
      chart.timeScale().fitContent();
      const vr = chart.timeScale().getVisibleRange();
      if (!vr) return;
      from   = vr.from;
      isTs   = typeof vr.to === 'number';
      fromMs = isTs ? vr.from * 1000 : +new Date(vr.from + 'T00:00:00Z');
      toMs   = isTs ? vr.to   * 1000 : +new Date(vr.to   + 'T00:00:00Z');
    }

    const paddedToMs = toMs + (toMs - fromMs) * pct;
    const paddedTo = isTs
      ? Math.floor(paddedToMs / 1000)
      : new Date(paddedToMs).toISOString().slice(0, 10);
    chart.timeScale().setVisibleRange({ from, to: paddedTo });
  }

  // ---------------------------------------------------------------------------
  // addChartLegend
  // Pins a flex row of [ColorLabel][Value] badges to the top-left of a chart
  // container. entries: [{ label, color, value }]
  // ---------------------------------------------------------------------------
  function addChartLegend(containerId, entries) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.style.position = 'relative';
    const row = document.createElement('div');
    row.style.cssText = 'position:absolute;top:8px;left:8px;z-index:10;pointer-events:none;display:flex;gap:6px;flex-wrap:wrap;';
    for (const { label, color, value } of entries) {
      const item = document.createElement('div');
      item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
      item.innerHTML = `
        <span style="background:${color};color:#000;font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;">${label}</span>
        <span style="background:rgba(23,24,27,0.85);border:1px solid #2a2a3e;color:${color};font-size:11px;font-weight:600;padding:2px 7px;border-radius:3px;">${value}</span>
      `;
      row.appendChild(item);
    }
    el.appendChild(row);
  }

  // ---------------------------------------------------------------------------
  // hexToRgba — '#rrggbb', 0–1 → 'rgba(r,g,b,a)'
  // ---------------------------------------------------------------------------
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ---------------------------------------------------------------------------
  // colors — single source of truth for all chart / signal colors
  // ---------------------------------------------------------------------------
  const colors = {
    // FOMC chart series
    rate:     '#f97316',  // Fed rate / target corridor / SEP
    effr:     '#e2e2e8',  // Effective fed funds (actual overnight)
    sofr:     '#7aa2f7',  // SOFR + Treasuries
    iorb:     '#2dd4bf',  // Interest on reserve balances
    rrp:      '#818cf8',  // Overnight reverse repo
    balSheet: '#a78bfa',  // Fed total assets
    reserves: '#34d399',  // Reserve balances
    mbs:      '#f59e0b',  // MBS holdings

    // Decision / direction markers
    hike:     '#f87171',
    cut:      '#34d399',

    // Credit spread chart
    credit:   '#f59e0b',

    // Risk signal labels (app.js + credit_app.js)
    signalStrongOn:  '#10b981',
    signalOn:        '#84cc16',
    signalNeutral:   '#a7a7ad',
    signalOff:       '#f59e0b',
    signalStrongOff: '#ef4444',
  };

  global.ChartUtils = { createDashboardChart, createFomcChart, fitWithRightPadding, fitWithDateRangePadding, addChartLegend, hexToRgba, colors };

}(window));
