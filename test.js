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

(async function main() {
  try {
    const container = document.getElementById('chart-container');
    const spyPoints = await loadCsvPoints('./data/spy.csv');

    console.log('Loaded', spyPoints.length, 'points');

    const chart = createChart(container, {
      layout: {
        background: { type: 'solid', color: '#17181b' },
        textColor: '#e9e9ea',
      },
      grid: {
        vertLines: { color: '#333' },
        horzLines: { color: '#333' },
      },
      width: container.clientWidth,
      height: 300,
    });

    const lineSeries = chart.addSeries(LineSeries, {
      color: '#4a9eff',
      lineWidth: 2,
    });

    lineSeries.setData(spyPoints);

    // Add swing high markers
    const swingHighs = [
      { time: spyPoints[spyPoints.length - 20].time, price: spyPoints[spyPoints.length - 20].value },
      { time: spyPoints[spyPoints.length - 10].time, price: spyPoints[spyPoints.length - 10].value }
    ];

    const markers = swingHighs.map(sh => ({
      time: sh.time,
      position: 'aboveBar',
      color: '#ffd700',
      shape: 'circle',
      text: '',
    }));
    createSeriesMarkers(lineSeries, markers);

    // Add trend line
    const trendLine = new TrendLine(chart, lineSeries,
      { time: swingHighs[0].time, price: swingHighs[0].price },
      { time: swingHighs[1].time, price: swingHighs[1].price },
      { lineColor: '#ffd700', width: 2, showLabels: false }
    );
    lineSeries.attachPrimitive(trendLine);

    chart.timeScale().fitContent();

    console.log('Chart rendered successfully with markers and trend line');

  } catch (err) {
    console.error('ERROR:', err);
    document.getElementById('chart-container').innerHTML = '<pre style="color:red;padding:20px">' + err.message + '\n\n' + err.stack + '</pre>';
  }
})();
