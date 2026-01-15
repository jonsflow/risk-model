async function loadCsvPoints(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${path}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift(); // Date,Open,High,Low,Close,Volume
  const points = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 5) continue;

    let date, close;
    [date, , , , close] = parts;

    if (!date || !close || date === "Date" || close === "Close") continue;
    const t = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000);
    const c = Number(close);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    points.push([t, c]);
  }
  points.sort((a, b) => a[0] - b[0]);
  return points;
}

function renderChartTV(containerId, points, color = "#4a9eff", label = "", swingHighs = null) {
  const container = document.getElementById(containerId);

  const chart = LightweightCharts.createChart(container, {
    layout: {
      background: { color: '#17181b' },
      textColor: '#e9e9ea',
    },
    grid: {
      vertLines: { color: '#333' },
      horzLines: { color: '#333' },
    },
    width: container.clientWidth,
    height: 300,
  });

  const lineSeries = chart.addLineSeries({
    color: color,
    lineWidth: 2,
  });

  const tvData = points.map(([time, value]) => ({ time, value }));
  lineSeries.setData(tvData);

  if (swingHighs && swingHighs.length > 0) {
    const markers = swingHighs.map(sh => ({
      time: sh.time,
      position: 'aboveBar',
      color: '#ffd700',
      shape: 'circle',
      text: '',
    }));
    lineSeries.setMarkers(markers);

    if (swingHighs.length >= 2) {
        const trendLine = new TrendLine(chart, lineSeries,
            { time: swingHighs[0].time, price: swingHighs[0].price },
            { time: swingHighs[1].time, price: swingHighs[1].price },
            { lineColor: '#ffd700', width: 2, showLabels: false }
        );
        lineSeries.attachPrimitive(trendLine);
    }
  }

  return chart;
}

(async function main() {
  try {
    const spyPoints = await loadCsvPoints('./data/spy.csv');
    const swingHighs = [
        { time: spyPoints[spyPoints.length - 20][0], price: spyPoints[spyPoints.length - 20][1] },
        { time: spyPoints[spyPoints.length - 10][0], price: spyPoints[spyPoints.length - 10][1] }
    ];
    renderChartTV('chart-container', spyPoints, '#4a9eff', 'SPY', swingHighs);
  } catch (err) {
    console.error(err);
  }
})();
