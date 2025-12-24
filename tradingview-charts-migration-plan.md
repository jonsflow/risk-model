# TradingView Lightweight Charts Migration Plan

## Overview

Explore replacing our custom SVG chart rendering with TradingView's Lightweight Charts library - a performant, feature-rich charting solution built on HTML5 Canvas.

## Current Implementation

**File**: `app.js:377-464` (`renderChart()` function)

Our current approach uses custom SVG rendering with:
- Manual path generation for price lines
- Custom scale functions for x/y axes
- SVG circles and dashed lines for swing high markers and trend lines
- Hand-coded grid lines and axis labels
- Fixed height charts (150px)

## Why Consider TradingView Lightweight Charts?

### Benefits
1. **Professional appearance** - Industry-standard financial charting
2. **Better performance** - Canvas-based rendering vs SVG (faster for large datasets)
3. **Built-in features**:
   - Interactive tooltips/crosshairs
   - Time scale with proper financial calendar handling
   - Responsive resizing
   - Multiple series types (Line, Area, Candlestick, etc.)
   - Price scale formatting
4. **Smaller bundle** - Only 35kB (v5.0+)
5. **Future flexibility** - Easy to add candlestick charts for intraday data
6. **Maintained library** - Active development by TradingView

### Potential Challenges
1. **External dependency** - Currently we have zero dependencies (pure vanilla JS)
2. **Learning curve** - New API to understand
3. **Custom features** - Need to verify we can still draw:
   - Swing high markers (gold dots)
   - Trend lines connecting 2 pivot points
   - Ratio charts
4. **Styling** - Must match our dark theme (#0f0f10 background, #e9e9ea text)

## Technical Integration

### CDN Setup
Add to `index.html` before `app.js`:
```html
<script src="https://unpkg.com/lightweight-charts@5.0.0/dist/lightweight-charts.standalone.production.js"></script>
```

**IMPORTANT**: Pin to specific version (5.0.0) to avoid breaking changes from auto-updates.

This creates a global `LightweightCharts` object (no build step required - perfect for our static site).

### Basic Usage Pattern

```javascript
// Create chart instance
const chart = LightweightCharts.createChart(document.getElementById('container'), {
  layout: {
    background: { color: '#17181b' },
    textColor: '#e9e9ea',
  },
  grid: {
    vertLines: { color: '#333' },
    horzLines: { color: '#333' },
  },
  width: containerWidth,
  height: 150,
});

// Add line series
const lineSeries = chart.addLineSeries({
  color: '#4a9eff',
  lineWidth: 2,
});

// Set data (time can be YYYY-MM-DD string or Unix timestamp)
lineSeries.setData([
  { time: '2024-01-01', value: 450.25 },
  { time: '2024-01-02', value: 451.80 },
  // ...
]);

// Add markers for swing highs
lineSeries.setMarkers([
  {
    time: '2024-01-15',
    position: 'aboveBar',
    color: '#ffd700',
    shape: 'circle',
    text: 'H',
  },
]);
```

## Migration Requirements

### Features We Must Preserve

1. **Swing High Markers**
   - Gold circles (#ffd700) at pivot points
   - Supported via `lineSeries.setMarkers()`
   - ✅ Direct API support

2. **Trend Line Between 2 Pivots**
   - Dashed gold line connecting last 2 swing highs
   - ⚠️ Need to investigate: possibly use `createPriceLine()` or custom plugin
   - Alternative: Use series primitives or custom overlay

3. **Three Charts Per Pair**
   - Symbol 1 price chart
   - Symbol 2 price chart
   - Ratio chart
   - ✅ Just create 3 chart instances

4. **Dynamic Resizing**
   - Charts must fit container width
   - ✅ Built-in: `chart.resize()` or `timeScale().fitContent()`

5. **Dark Theme Styling**
   - Background: #17181b (card background)
   - Grid: #333
   - Text: #e9e9ea
   - ✅ Fully customizable via options

### Data Format Conversion

Current: `[[unixTimestamp, price], ...]`

TradingView expects: `[{ time: unixTimestamp, value: price }, ...]`

Simple transformation:
```javascript
const tvData = points.map(([time, value]) => ({ time, value }));
```

## Implementation Plan

### Phase 1: Proof of Concept (this branch)
- [ ] Add CDN script to `index.html`
- [ ] Create new `renderChartTV()` function alongside existing `renderChart()`
- [ ] Test rendering a single chart with TradingView
- [ ] Verify markers work for swing highs
- [ ] Test dark theme styling

### Phase 2: Trend Line Solution
- [ ] Research how to draw custom lines between two points
- [ ] Options:
  - Price lines (if they support diagonal)
  - Custom plugin/primitive
  - Overlay SVG layer (hybrid approach)
- [ ] Implement trend line drawing

### Phase 3: Full Migration
- [ ] Replace all `renderChart()` calls with `renderChartTV()`
- [ ] Remove old SVG rendering code
- [ ] Test all divergence pairs (SPY-HYG, BTC-SPY, etc.)
- [ ] Test responsive behavior on mobile
- [ ] Test all dropdown options (lookback, pivot mode, swing window)

### Phase 4: Polish
- [ ] Add interactive tooltips showing exact prices
- [ ] Optimize chart sizing for mobile
- [ ] Consider adding time scale syncing between charts in same pair
- [ ] Update CLAUDE.md documentation

## Code Structure Changes

### `app.js` Changes

**Before:**
```javascript
renderChart(containerId, points, color, label, swingHighs);
```

**After:**
```javascript
renderChartTV(containerId, points, color, label, swingHighs);
```

**New function signature** (rough draft):
```javascript
function renderChartTV(containerId, points, color = "#4a9eff", label = "", swingHighs = null) {
  const container = document.getElementById(containerId);

  // Create chart
  const chart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#17181b' }, textColor: '#e9e9ea' },
    grid: { vertLines: { color: '#333' }, horzLines: { color: '#333' } },
    width: container.clientWidth,
    height: 150,
  });

  // Add line series
  const lineSeries = chart.addLineSeries({ color, lineWidth: 2 });

  // Convert data format
  const tvData = points.map(([time, value]) => ({ time, value }));
  lineSeries.setData(tvData);

  // Add swing high markers if provided
  if (swingHighs && swingHighs.length > 0) {
    const markers = swingHighs.map(sh => ({
      time: sh.time,
      position: 'aboveBar',
      color: '#ffd700',
      shape: 'circle',
      text: '',
    }));
    lineSeries.setMarkers(markers);

    // TODO: Add trend line between last 2 swing highs
  }

  return chart;
}
```

## ✅ RESOLVED: Trend Line Solution

TradingView provides a **trend-line plugin example** that does exactly what we need:
- Source: `plugin-examples/src/plugins/trend-line/trend-line.ts`
- API: `new TrendLine(chart, series, point1, point2, options)`
- Usage: `series.attachPrimitive(trendLine)`
- Supports: custom colors, width, labels, automatic coordinate conversion

**Implementation**: Copy the plugin code into our project (it's a standalone example, not in core library).

## Open Questions

1. **Chart instance management**: Should we store chart instances for cleanup/updates?
   - Currently we just overwrite innerHTML (destroys old chart)
   - With TradingView, might need to call `chart.remove()` before recreating

2. **Performance**: Will 9+ charts on one page (3 pairs × 3 charts) cause issues?
   - ✅ TradingView designed for multiple charts (35kB, canvas-based)
   - No warnings in docs about chart limits
   - **Decision**: Proceed - performance should be fine

3. **Mobile**: How do charts behave on small screens?
   - TradingView has responsive features
   - May need to adjust time scale visibility

## Decision Points

Before committing to full migration, validate:
- [ ] Trend line drawing is possible and looks good
- [ ] Dark theme styling matches our aesthetic
- [ ] Performance is acceptable with multiple charts
- [ ] Mobile experience is better or equivalent
- [ ] No breaking changes to our divergence detection logic

## Resources

- **Docs**: https://tradingview.github.io/lightweight-charts/docs
- **Markers Tutorial**: https://tradingview.github.io/lightweight-charts/tutorials/how_to/series-markers
- **GitHub**: https://github.com/tradingview/lightweight-charts
- **TrendLine Plugin**: https://github.com/tradingview/lightweight-charts/tree/master/plugin-examples/src/plugins/trend-line
- **CDN (pinned v5.0.0)**: https://unpkg.com/lightweight-charts@5.0.0/dist/lightweight-charts.standalone.production.js

## Version Pinning Strategy

**All dependencies must be pinned to specific versions** to prevent breaking changes:
- Lightweight Charts: `5.0.0` (latest stable as of Dec 2024)
- TrendLine plugin: Copy source code into our repo (no external dependency)
- Future updates: Manually test and update version number only after verification

## Next Steps

1. Add CDN script to `index.html`
2. Write proof-of-concept `renderChartTV()` function
3. Test on one chart to validate approach
4. Research trend line options
5. Decide: proceed with full migration or stick with SVG?
