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

function detectStructure(pivots) {
  const highs = pivots.filter(p => p.type === 'high');
  const lows  = pivots.filter(p => p.type === 'low');
  let hh = null, ll = null, lh = null, hl = null;

  if (highs.length > 0) {
    hh = highs.reduce((a, b) => b.value > a.value ? b : a);
    const minDist = 1 / hh.value;  // 1 point as % of HH price
    const lhList = highs.filter(h => h.value < hh.value * (1 - minDist) && h.time > hh.time);
    if (lhList.length > 0) lh = lhList.reduce((a, b) => b.value > a.value ? b : a);
  }

  if (lows.length > 0) {
    ll = lows.reduce((a, b) => b.value < a.value ? b : a);
    // HL: lowest pivot LOW after LL that is still above LL (deepest retest before reversal)
    const hlLows = lows.filter(l => l.time > ll.time && l.value > ll.value);
    if (hlLows.length > 0) {
      hl = hlLows.reduce((a, b) => a.value < b.value ? a : b);
    } else {
      // fallback: first pivot HIGH after LL (e.g. 20d window ends right after LL)
      const hlHighs = highs.filter(h => h.time > ll.time);
      if (hlHighs.length > 0) hl = hlHighs.reduce((a, b) => a.time < b.time ? a : b);
    }
  }

  return { hh, ll, lh, hl };
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
  const { hh, ll, lh, hl } = detectStructure(pivots);

  if (hh) {
    const hhDate = new Date(hh.time * 1000).toISOString().slice(0, 10);
    const pivotTimes = new Map(pivots.map(p => [p.time, p]));
    const fromHH = pts.filter(p => p.time >= hh.time);
    console.log(`\n--- 20d points from HH (${hhDate} @ ${hh.value.toFixed(2)}) ---`);
    for (const p of fromHH) {
      const date = new Date(p.time * 1000).toISOString().slice(0, 10);
      const piv = pivotTimes.get(p.time);
      const pivLabel = piv ? piv.type : '';
      const structLabel = p.time === hh?.time ? 'HH' : p.time === ll?.time ? 'LL' : p.time === lh?.time ? 'LH' : p.time === hl?.time ? 'HL' : '';
      console.log(`${date}  ${p.value.toFixed(2)}  ${pivLabel}  ${structLabel}`);
    }
  }

  const markers = [];
  if (hh) markers.push({ time: hh.time, position: 'aboveBar', color: '#ffd700', shape: 'circle', text: 'HH' });
  if (lh) markers.push({ time: lh.time, position: 'aboveBar', color: '#4ade80', shape: 'circle', text: 'LH' });
  if (ll) markers.push({ time: ll.time, position: 'belowBar', color: '#ff4d4d', shape: 'circle', text: 'LL' });
  if (hl) markers.push({ time: hl.time, position: 'belowBar', color: '#fb923c', shape: 'circle', text: 'HL' });

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
