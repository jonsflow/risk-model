// js/components/SparklineChart.js — Reusable inline sparkline chart.
// Used on macro, gov_data, and correlation pages.

import { BaseChart } from './BaseChart.js';

const LC = window.LightweightCharts;

/**
 * Render a sparkline with an optional MA overlay into a container element.
 *
 * @param {HTMLElement} el         - container
 * @param {Array}       priceData  - [{time, value}] (LightweightCharts format)
 * @param {Array}       maData     - [{time, value}] or null
 * @param {object}      opts
 * @param {string}      opts.priceColor
 * @param {string}      opts.maColor
 * @param {number}      opts.height
 */
export function renderSparkline(el, priceData, maData = null, opts = {}) {
  const {
    priceColor = '#64b5f6',
    maColor    = '#ffc107',
    height     = 60,
  } = opts;

  const chart = new BaseChart(el, height, {
    layout:          { background: { type: 'solid', color: 'transparent' }, textColor: '#e9e9ea' },
    grid:            { vertLines: { visible: false }, horzLines: { visible: false } },
    leftPriceScale:  { visible: false },
    rightPriceScale: { visible: false },
    timeScale:       { visible: false },
  });

  const priceSeries = chart.addLineSeries({
    color:       priceColor,
    lineWidth:   1,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  priceSeries.setData(priceData);

  if (maData && maData.length > 0) {
    const maSeries = chart.addLineSeries({
      color:       maColor,
      lineWidth:   1,
      lineStyle:   LC.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    maSeries.setData(maData);
  }

  chart.fitContent();
  return chart;
}
