const { createChart, LineSeries, createSeriesMarkers } = window.LightweightCharts;

async function loadCsvPoints(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${path}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  lines.shift();
  const points = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    const close = parts[4];
    if (!date || !close || date === "Date") continue;
    const t = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000);
    const c = Number(close);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    points.push({ time: t, value: c });
  }
  return points;
}

// Fixed N: a point must beat all N neighbors on each side
function findPivotsFixed(points, N) {
  const pivots = [];
  for (let i = N; i < points.length - N; i++) {
    const curr = points[i].value;
    const leftHigh  = points.slice(i - N, i).every(p => curr > p.value);
    const rightHigh = points.slice(i + 1, i + N + 1).every(p => curr > p.value);
    const leftLow   = points.slice(i - N, i).every(p => curr < p.value);
    const rightLow  = points.slice(i + 1, i + N + 1).every(p => curr < p.value);
    if (leftHigh && rightHigh) pivots.push({ ...points[i], type: 'high' });
    else if (leftLow && rightLow) pivots.push({ ...points[i], type: 'low' });
  }
  return pivots;
}

// ZigZag %: only registers a new pivot when price reverses >= pct% from the last extreme
function findPivotsZigZag(points, pct) {
  const pivots = [];
  let dir = 0;          // 1 = up leg, -1 = down leg
  let extremeIdx = 0;   // index of current extreme
  const threshold = pct / 100;

  for (let i = 1; i < points.length; i++) {
    const curr = points[i].value;
    const ext  = points[extremeIdx].value;
    if (dir === 0) {
      if (curr >= ext * (1 + threshold))      { dir =  1; extremeIdx = i; }
      else if (curr <= ext * (1 - threshold)) { dir = -1; extremeIdx = i; }
    } else if (dir === 1) {
      if (curr > ext) { extremeIdx = i; }
      else if (curr <= ext * (1 - threshold)) {
        pivots.push({ ...points[extremeIdx], type: 'high' });
        dir = -1; extremeIdx = i;
      }
    } else {
      if (curr < ext) { extremeIdx = i; }
      else if (curr >= ext * (1 + threshold)) {
        pivots.push({ ...points[extremeIdx], type: 'low' });
        dir = 1; extremeIdx = i;
      }
    }
  }
  return pivots;
}

// ATR-based: derives N from recent ATR relative to median bar move, then runs Fixed-N
function findPivotsATR(points, multiplier) {
  if (points.length < 15) return findPivotsFixed(points, 1);
  const moves = points.slice(1).map((p, i) => Math.abs(p.value - points[i].value));
  const sorted = [...moves].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const atr = moves.slice(-14).reduce((s, v) => s + v, 0) / 14;
  const N = Math.max(1, Math.round((atr / median) * multiplier));
  return findPivotsFixed(points, N);
}

// Prominence %: N=1 pivots filtered to those that stand out >= pct% from nearby opposing extreme
function findPivotsProminence(points, pct) {
  const raw = findPivotsFixed(points, 1);
  const threshold = pct / 100;
  return raw.filter(p => {
    const idx = points.findIndex(q => q.time === p.time);
    const window = points.slice(Math.max(0, idx - 5), idx + 6).map(q => q.value);
    if (p.type === 'high') {
      const floorVal = Math.min(...window);
      return (p.value - floorVal) / p.value >= threshold;
    } else {
      const ceilVal = Math.max(...window);
      return (ceilVal - p.value) / ceilVal >= threshold;
    }
  });
}

function getPivots(points, mode, param) {
  if (mode === 'fixed1')     return findPivotsFixed(points, 1);
  if (mode === 'fixed2')     return findPivotsFixed(points, 2);
  if (mode === 'zigzag')     return findPivotsZigZag(points, param);
  if (mode === 'atr')        return findPivotsATR(points, param);
  if (mode === 'prominence') return findPivotsProminence(points, param);
  return findPivotsFixed(points, 1);
}

const PIVOT_DEFAULTS = { fixed1: null, fixed2: null, zigzag: 1.5, atr: 1.0, prominence: 0.5 };

let allPoints = [];
let chart = null;
let lineSeries = null;
let markersPlugin = null;

function render(lookback, mode, param) {
  const pts = allPoints.slice(-lookback);

  if (!chart) {
    const container = document.getElementById('chart-container');
    chart = createChart(container, {
      layout: { background: { type: 'solid', color: '#17181b' }, textColor: '#e9e9ea' },
      grid: { vertLines: { color: '#333' }, horzLines: { color: '#333' } },
      width: container.clientWidth,
      height: container.clientHeight,
      handleScroll: false,
      handleScale: false,
    });
  }

  if (lineSeries) chart.removeSeries(lineSeries);
  lineSeries = chart.addSeries(LineSeries, {
    color: '#4a9eff',
    lineWidth: 2,
    lastValueVisible: true,
    priceLineVisible: true,
    title: 'Current Price',
  });
  lineSeries.setData(pts);
  markersPlugin = null;

  // rightOffset in bars proportional to data length so the right strip is
  // always ~7% of chart width regardless of how many bars are shown.
  // Formula: strip% = rightOffset / (pts.length + rightOffset)
  // Solving for rightOffset = pts.length * 0.07 / 0.93 ≈ pts.length * 0.075
  chart.timeScale().applyOptions({ rightOffset: Math.ceil(pts.length * 0.075) });
  chart.timeScale().fitContent();

  const pivots = getPivots(pts, mode, param);

  // Seed from first bar so first pivot compares against the window's opening price
  // (first/last bars are excluded from pivot detection but used as reference)
  let lastHigh = { value: pts[0].value };
  let lastLow  = { value: pts[0].value };
  const markers = [];
  const labelColors = { HH: '#14b8a6', LH: '#f97316', LL: '#ff4d4d', HL: '#4ade80' };

  for (const p of pivots) {
    if (p.type === 'high') {
      const label = p.value > lastHigh.value ? 'HH' : 'LH';
      if (label === 'HH') lastHigh = { ...p, label };  // only advance on new high
      markers.push({ time: p.time, position: 'aboveBar', color: labelColors[label], shape: 'circle', text: label });
    } else {
      const label = p.value < lastLow.value ? 'LL' : 'HL';
      if (label === 'LL') lastLow = { ...p, label };   // only advance on new low
      markers.push({ time: p.time, position: 'belowBar', color: labelColors[label], shape: 'circle', text: label });
    }
  }

  markers.sort((a, b) => a.time - b.time);
  markersPlugin = createSeriesMarkers(lineSeries, markers);
}

(async function main() {
  try {
    allPoints = await loadCsvPoints('../data/spy.csv');
    console.log('Loaded', allPoints.length, 'points');

    const selLookback = document.getElementById('lookback');
    const selMode     = document.getElementById('pivot-mode');
    const inputParam  = document.getElementById('pivot-param');

    function rerender() {
      const mode  = selMode.value;
      const param = parseFloat(inputParam.value) || PIVOT_DEFAULTS[mode];
      render(Number(selLookback.value), mode, param);
    }

    selMode.addEventListener('change', () => {
      const def = PIVOT_DEFAULTS[selMode.value];
      inputParam.value = def ?? '';
      inputParam.disabled = def === null;
      rerender();
    });

    selLookback.addEventListener('change', rerender);
    inputParam.addEventListener('change', rerender);

    // Initial render
    inputParam.value = PIVOT_DEFAULTS[selMode.value] ?? '';
    inputParam.disabled = PIVOT_DEFAULTS[selMode.value] === null;
    render(Number(selLookback.value), selMode.value, PIVOT_DEFAULTS[selMode.value]);
  } catch (err) {
    console.error('ERROR:', err);
    document.getElementById('chart-container').innerHTML =
      '<pre style="color:red;padding:20px">' + err.message + '</pre>';
  }
})();
