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

// N=1 pivot detection: higher/lower than both immediate neighbors, skip first and last
function findPivots(points) {
  const pivots = [];
  for (let i = 1; i < points.length - 1; i++) {
    const curr = points[i].value;
    if (curr > points[i - 1].value && curr > points[i + 1].value)
      pivots.push({ ...points[i], type: 'high' });
    else if (curr < points[i - 1].value && curr < points[i + 1].value)
      pivots.push({ ...points[i], type: 'low' });
  }
  return pivots;
}

let allPoints = [];
let chart = null;
let lineSeries = null;
let markersPlugin = null;

function render(lookback) {
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
  lineSeries = chart.addSeries(LineSeries, { color: '#4a9eff', lineWidth: 2 });
  lineSeries.setData(pts);
  markersPlugin = null;
  chart.timeScale().fitContent();

  const pivots = findPivots(pts);

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
    allPoints = await loadCsvPoints('./data/spy.csv');
    console.log('Loaded', allPoints.length, 'points');

    const sel = document.getElementById('lookback');
    render(Number(sel.value));
    sel.addEventListener('change', () => render(Number(sel.value)));
  } catch (err) {
    console.error('ERROR:', err);
    document.getElementById('chart-container').innerHTML =
      '<pre style="color:red;padding:20px">' + err.message + '</pre>';
  }
})();
