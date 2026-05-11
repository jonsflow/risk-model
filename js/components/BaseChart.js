// js/components/BaseChart.js — Thin wrapper around LightweightCharts.
// Handles creation, ResizeObserver, and series helpers.

const LC = window.LightweightCharts;

export class BaseChart {
  /**
   * @param {HTMLElement} el   - container element
   * @param {number}      height
   * @param {object}      opts - LightweightCharts options (merged with defaults)
   */
  constructor(el, height, opts = {}) {
    this.el = el;
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
    this.chart = LC.createChart(el, _merge(base, opts));
    this._observer = new ResizeObserver(() =>
      this.chart.applyOptions({ width: el.clientWidth })
    );
    this._observer.observe(el);
  }

  addLineSeries(opts = {}) {
    return this.chart.addLineSeries(opts);
  }

  addHistogramSeries(opts = {}) {
    return this.chart.addHistogramSeries(opts);
  }

  fitContent() {
    this.chart.timeScale().fitContent();
  }

  fitWithPadding(dataLength, pct = 0.02) {
    this.chart.timeScale().applyOptions({ rightOffset: Math.ceil(dataLength * pct) });
    this.chart.timeScale().fitContent();
  }

  destroy() {
    this._observer.disconnect();
    this.chart.remove();
  }
}

function _merge(base, overrides) {
  const keys = ['layout', 'grid', 'crosshair', 'rightPriceScale', 'timeScale'];
  const result = Object.assign({}, base, overrides);
  for (const k of keys) {
    if (base[k] && overrides[k]) {
      result[k] = Object.assign({}, base[k], overrides[k]);
    }
  }
  return result;
}
