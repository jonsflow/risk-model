/**
 * Trade Recommendations App
 * Reads trading_signals.json and walks through trading-rules.md framework
 * Outputs daily trade recommendations based on confluence scoring
 */

let cacheData = null;
let scoredTrades = null;

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

async function main() {
  try {
    // Fetch cache
    const response = await fetch('data/cache/trading_signals.json');
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
    cacheData = await response.json();

    // Render all steps
    renderHeader();
    renderDayQuality();

    // If day grade is C or F, render EOD with what we have and stop morning flow
    if (['C', 'F'].includes(cacheData.day_quality.grade)) {
      renderEodOutcomes(null);
      document.getElementById('step-2').style.display = 'none';
      document.getElementById('step-3').style.display = 'none';
      document.getElementById('step-4').style.display = 'none';
      document.getElementById('step-5').style.display = 'none';
      document.getElementById('step-6').style.display = 'none';
      return;
    }

    // Continue with remaining morning steps, then render EOD with scored data
    renderRegime();
    renderPatternScanner();
    const scored = scoreConfluences();
    scoredTrades = scored;
    renderRecommendations(scored);
    renderPositionCalc(scored);
    renderEodOutcomes(scored);

  } catch (error) {
    console.error('Error:', error);
    document.getElementById('step-1').innerHTML = `<div class="error">Error loading data: ${error.message}</div>`;
  }
}

// =============================================================================
// STEP 0: HEADER
// =============================================================================

function renderHeader() {
  const gen = new Date(cacheData.generated);
  const genStr = gen.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const grade = cacheData.day_quality.grade;
  const gradeColor = grade === 'A+' || grade === 'A' ? '#10b981' : grade === 'B' ? '#f59e0b' : '#ef4444';
  const gradeLabel = (grade === 'A+' || grade === 'A') ? 'Trading Day' : grade === 'B' ? 'Reduced Size' : 'No Trades';

  document.getElementById('headerMeta').textContent = `as of ${genStr}`;
  document.getElementById('dayQualityBadge').innerHTML = `<span style="background: ${gradeColor}; color: white; padding: 8px 16px; border-radius: 6px; display: inline-block;">${grade} — ${gradeLabel}</span>`;
}

// =============================================================================
// STEP 1: DAY QUALITY GATE
// =============================================================================

function renderDayQuality() {
  const grade = cacheData.day_quality.grade;
  const mods = cacheData.day_quality.modifiers;

  // Check for no-trade condition
  const isNoTrade = ['C', 'F'].includes(grade);

  let html = `<div style="margin-bottom: 16px;">`;

  if (isNoTrade) {
    html += `<div style="background: #2a1f1f; border-left: 4px solid #ef4444; padding: 12px; border-radius: 4px; margin-bottom: 16px;">
      <strong style="color: #991b1b;">🛑 NO TRADES TODAY</strong><br>
      Grade: <strong>${grade}</strong>`;
    if (grade === 'F' && Math.abs(mods.prior_day_move_pct) > 10) {
      html += `<br>Prior day move: ${mods.prior_day_move_pct.toFixed(2)}% (> 10% threshold)`;
    } else if (grade === 'C') {
      html += `<br>ATR below average AND volume below 20-day average`;
    }
    html += `</div>`;
  }

  html += `
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 12px;">
      <div class="pill">
        <div class="muted">ATR Above Avg</div>
        <span style="font-weight: bold; color: ${mods.atr_above_avg ? '#10b981' : '#ef4444'};">
          ${mods.atr_above_avg ? '✓' : '✗'}
        </span>
        <div class="muted" style="font-size: 0.8em; margin-top: 6px;">Enough range to produce tradeable swings.</div>
      </div>
      <div class="pill">
        <div class="muted">Volume > 20d Avg</div>
        <span style="font-weight: bold; color: ${mods.volume_above_20d ? '#10b981' : '#ef4444'};">
          ${mods.volume_above_20d ? '✓' : '✗'}
        </span>
        <div class="muted" style="font-size: 0.8em; margin-top: 6px;">Confirms institutional participation.</div>
      </div>
      <div class="pill">
        <div class="muted">Volume > 50d Avg</div>
        <span style="font-weight: bold; color: ${mods.volume_above_50d ? '#10b981' : '#ef4444'};">
          ${mods.volume_above_50d ? '✓' : '✗'}
        </span>
        <div class="muted" style="font-size: 0.8em; margin-top: 6px;">Both checks passing = A+ conviction day.</div>
      </div>
    </div>
    <div class="pill">
      <div class="muted">Prior Day Move (SPY)</div>
      <strong>${mods.prior_day_move_pct.toFixed(2)}%</strong>
      <div class="muted" style="font-size: 0.8em; margin-top: 6px;">&gt;10% = F (no trades). &gt;3% = B (reduced size).</div>
    </div>
  </div>`;

  document.getElementById('step1Content').innerHTML = html;
}

// =============================================================================
// STEP 2: MARKET REGIME
// =============================================================================

function renderRegime() {
  const regime = cacheData.regime;

  const regimeColors = {
    'Trending': '#3b82f6',
    'Ranging': '#f59e0b',
    'Choppy': '#ef4444'
  };

  const patternMenu = {
    'Trending': 'ORB, Gap Continuation, Engulfing (with trend)',
    'Ranging': 'Gap Fill, Outside Day Reversal, Engulfing at S/R',
    'Choppy': 'No patterns valid — sit out'
  };

  let html = `
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px;">
      <div class="pill">
        <div class="muted">Regime</div>
        <span style="font-weight: bold; background: ${regimeColors[regime.label]}; color: white; padding: 4px 8px; border-radius: 4px; display: inline-block;">
          ${regime.label}
        </span>
      </div>
      <div class="pill">
        <div class="muted">Direction</div>
        <strong>${regime.direction}</strong>
      </div>
      <div class="pill">
        <div class="muted">ATR Trend</div>
        <strong>${regime.atr_trend}</strong>
      </div>
      <div class="pill">
        <div class="muted">Index Alignment</div>
        <span style="color: ${regime.index_alignment === 'aligned' ? '#10b981' : '#ef4444'};">
          ${regime.index_alignment}
        </span>
      </div>
    </div>
    <div style="background: #22242a; padding: 12px; border-radius: 4px; border-left: 4px solid ${regimeColors[regime.label]};">
      <strong>Valid Patterns for ${regime.label} Regime:</strong><br>
      ${patternMenu[regime.label]}
    </div>
  `;

  document.getElementById('step2Content').innerHTML = html;
}

// =============================================================================
// STEP 3: PATTERN SCANNER
// =============================================================================

function renderPatternScanner() {
  const patterns = cacheData.active_patterns;
  const regime = cacheData.regime.label;
  const symbols = cacheData.symbols;

  const regimePatterns = {
    'Trending': ['ORB', 'Gap', 'Engulfing'],
    'Ranging': ['Gap', 'Outside Day'],
    'Choppy': []
  };

  const validPatterns = regimePatterns[regime] || [];

  let html = '';

  if (validPatterns.length === 0) {
    html = `<div style="background: #2a2414; padding: 12px; border-radius: 4px;">No patterns valid for ${regime} regime — sit out.</div>`;
  } else {
    // Filter patterns valid for this regime
    const filtered = patterns.filter(p => validPatterns.some(v => p.pattern.includes(v)));

    if (filtered.length === 0) {
      html = `<div class="muted">No patterns detected today.</div>`;
    } else {
      html = `<h3 style="margin-top: 0; color: #10b981;">✓ Patterns Detected</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="border-bottom: 2px solid #a7a7ad;">
            <th style="text-align: left; padding: 8px;">Symbol</th>
            <th style="text-align: left; padding: 8px;">Pattern</th>
            <th style="text-align: left; padding: 8px;">Direction</th>
            <th style="text-align: left; padding: 8px;">Notes</th>
          </tr>
        </thead>
        <tbody>`;

      filtered.forEach(p => {
        const dirColor = p.direction === 'up' ? '#10b981' : p.direction === 'down' ? '#ef4444' : '#6b7280';

        html += `
          <tr style="border-bottom: 1px solid #333;">
            <td style="padding: 8px; font-weight: bold;">${p.symbol}</td>
            <td style="padding: 8px;">${p.pattern}</td>
            <td style="padding: 8px; color: ${dirColor}; font-weight: bold;">${p.direction}</td>
            <td style="padding: 8px; font-size: 0.9em;">${p.notes}</td>
          </tr>`;
      });

      html += `</tbody></table>`;
    }

    // Show what's NOT in play
    html += `<h3 style="margin-top: 24px; color: #a7a7ad;">✗ No Patterns — Why</h3>`;
    html += `<table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="border-bottom: 2px solid #a7a7ad;">
          <th style="text-align: left; padding: 8px;">Symbol</th>
          <th style="text-align: left; padding: 8px;">Reason</th>
        </tr>
      </thead>
      <tbody>`;

    const patternsSymbols = new Set(patterns.map(p => p.symbol));
    const allSymbolsToShow = Object.keys(symbols);

    allSymbolsToShow.forEach(sym => {
      if (symbols[sym] && !patternsSymbols.has(sym)) {
        const data = symbols[sym];
        const reasons = [];

        if (!data.gap_significant && !data.outside_day && !data.patterns.orb_qualified) {
          reasons.push('No pattern detected');
        }
        if (data.rsi_14 > 35 && data.rsi_14 < 65) {
          reasons.push('RSI neutral (35-65)');
        }
        if (!data.atr_above_avg) {
          reasons.push('ATR below avg');
        }
        if (data.above_ma_20 === false && data.ma_20) {
          reasons.push('Price below 20-MA');
        }

        if (reasons.length > 0) {
          html += `
            <tr style="border-bottom: 1px solid #333; color: #6b7280;">
              <td style="padding: 8px; font-weight: bold;">${sym}</td>
              <td style="padding: 8px; font-size: 0.9em;">${reasons.join(' • ')}</td>
            </tr>`;
        }
      }
    });

    html += `</tbody></table>`;
  }

  document.getElementById('step3Content').innerHTML = html;
}

// =============================================================================
// HELPERS
// =============================================================================

function squeezeHTML(squeeze) {
  if (!squeeze) squeeze = { status: 'unknown', momentum_increasing: false };
  const colors = {
    strong:  '#ef4444',
    normal:  '#f97316',
    weak:    '#eab308',
    none:    '#10b981',
    unknown: '#6b7280'
  };
  const labels = {
    strong:  'Strong',
    normal:  'Normal',
    weak:    'Weak',
    none:    'Fired',
    unknown: 'N/A'
  };
  const color = colors[squeeze.status] || colors.unknown;
  const label = labels[squeeze.status] || 'N/A';
  const arrow = squeeze.status !== 'unknown' ? (squeeze.momentum_increasing ? ' ▲' : ' ▼') : '';
  return `<span style="color: ${color}; font-weight: bold;">${label}${arrow}</span>`;
}

// =============================================================================
// STEP 4: CONFLUENCE SCORING
// =============================================================================

function scoreConfluences() {
  const patterns = cacheData.active_patterns;
  const regime = cacheData.regime.label;

  const regimePatterns = {
    'Trending': ['ORB', 'Gap', 'Engulfing'],
    'Ranging': ['Gap', 'Outside Day'],
    'Choppy': []
  };

  const validPatterns = regimePatterns[regime] || [];

  // Filter to valid patterns and score each
  const scored = patterns
    .filter(p => validPatterns.some(v => p.pattern.includes(v)))
    .map(p => {
      const sym = p.symbol;
      const data = cacheData.symbols[sym];
      const squeeze = data.squeeze || { status: 'unknown', momentum: 0, momentum_increasing: false };
      const vwap = data.vwap || { vwap: null, above_vwap: null, distance_pct: null };
      const rsiDiv = data.rsi_divergence || { signal: 'unknown' };
      const tradeDay = new Date(cacheData.generated).getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri

      let score = 0;
      const checks = {
        'Volume > 20d avg':  !!data.volume_above_20d,
        'ATR above avg':     !!data.atr_above_avg,
        'RSI extreme':       (data.rsi_14 < 35) || (data.rsi_14 > 65),
        'MACD aligned':      p.direction === 'up' ? data.macd_histogram > 0 : data.macd_histogram < 0,
        'MA(20) aligned':    p.direction === 'up' ? !!data.above_ma_20 : !data.above_ma_20,
        'Day A or A+':       ['A', 'A+'].includes(cacheData.day_quality.grade),
        'Regime matches':    true,
        'Squeeze aligned':   squeeze.status !== 'none' && squeeze.status !== 'unknown' &&
                             (p.direction === 'up' ? squeeze.momentum_increasing === true : squeeze.momentum_increasing === false),
        'Weekday edge':      [2, 3, 4].includes(tradeDay)
      };

      Object.values(checks).forEach(c => { if (c) score++; });

      return {
        symbol: sym,
        pattern: p.pattern,
        direction: p.direction,
        score: score,
        data: data,
        checks: checks,
        squeeze: squeeze,
        vwap: vwap,
        rsiDiv: rsiDiv
      };
    })
    .sort((a, b) => b.score - a.score)
    .filter(x => x.score >= 3);  // Only show >= 3 confluence

  // Render step 4
  let html = '';

  if (scored.length === 0) {
    html = `<div class="muted">No trades with 3+ confluences found.</div>`;
  } else {
    html = `<div style="display: flex; flex-wrap: wrap; gap: 12px;">`;

    scored.forEach(trade => {
      const sizeLabel = trade.score >= 7 ? 'Full Size' : trade.score >= 5 ? '75% Size' : '50% Size';
      const sizeColor = trade.score >= 7 ? '#10b981' : trade.score >= 5 ? '#f59e0b' : '#3b82f6';
      const sqBadge = squeezeHTML(trade.squeeze);

      html += `
        <div style="border: 2px solid ${sizeColor}; border-radius: 6px; padding: 14px; width: 400px; box-sizing: border-box;">
          <div style="font-weight: bold; font-size: 1.05em;">${trade.symbol}</div>
          <div style="font-size: 0.85em; color: #a7a7ad; margin-bottom: 8px;">${trade.pattern}</div>
          <div style="margin-bottom: 10px;">
            <span style="background: ${sizeColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold;">
              ${trade.score}/9 ${getDotsHTML(trade.score, 9)}
            </span>
          </div>
          <div style="font-size: 0.8em; font-weight: bold; color: ${sizeColor}; margin-bottom: 6px;">${sizeLabel}</div>
          <div style="font-size: 0.8em;">`;

      Object.entries(trade.checks).forEach(([key, val]) => {
        html += `<div style="color: ${val ? '#10b981' : '#4b5563'};">${val ? '✓' : '✗'} ${key}</div>`;
      });

      html += `</div>
          <div style="margin-top: 8px; font-size: 0.8em;">Squeeze: ${sqBadge}</div>
        </div>`;
    });

    html += `</div>`;
  }

  document.getElementById('step4Content').innerHTML = html;

  return scored;
}

// =============================================================================
// STEP 5: TRADE RECOMMENDATIONS
// =============================================================================

function renderRecommendations(scored) {
  const regime = cacheData.regime.label;

  let html = '';

  if (scored.length === 0) {
    html = `<div class="muted">No trades with sufficient confluence today.</div>`;
  } else {
    html = `<div style="display: flex; flex-wrap: wrap; gap: 12px;">`;

    scored.forEach(trade => {
      const d = trade.data;
      const atr = d.atr_14;

      let entry, stop, target1, target2, target3;

      const isUp = trade.direction === 'up';
      const atrT1 = (atr * 1.5).toFixed(2);
      const atrT2 = (atr * 2.0).toFixed(2);
      const atrStop = atr.toFixed(2);
      const dir = isUp ? '+' : '−';

      if (trade.pattern === 'ORB') {
        entry   = `ORB in play — watch for breakout 10:00–11:30 AM`;
        stop    = `Opposite side of opening range`;
        target1 = `$${atrT1} from entry (1.5x ATR)`;
        target2 = `$${atrT2} from entry (2x ATR)`;
        target3 = `Trailing $${atrStop} (1x ATR)`;
      } else if (trade.pattern === 'Gap') {
        if (regime === 'Trending') {
          entry   = isUp ? `Buy on open momentum — gap continuation` : `Short on open momentum — gap continuation`;
          stop    = `${isUp ? '−' : '+'}$${atrStop} from entry (1x ATR)`;
        } else {
          entry   = isUp ? `Short at open — fade gap to fill` : `Buy at open — fade gap to fill`;
          stop    = `${isUp ? '+' : '−'}$${atrStop} from entry (1x ATR)`;
        }
        target1 = `${dir}$${atrT1} from entry (1.5x ATR)`;
        target2 = `${dir}$${atrT2} from entry (2x ATR)`;
        target3 = `Trailing $${atrStop} (1x ATR)`;
      } else if (trade.pattern === 'Outside Day') {
        // Tomorrow's trigger levels are today's known high/low
        entry   = isUp ? `Above $${d.high.toFixed(2)} (today's high)` : `Below $${d.low.toFixed(2)} (today's low)`;
        stop    = isUp ? `Below $${d.low.toFixed(2)} (today's low)` : `Above $${d.high.toFixed(2)} (today's high)`;
        target1 = `${dir}$${atrT1} from entry (1.5x ATR)`;
        target2 = `${dir}$${atrT2} from entry (2x ATR)`;
        target3 = `Trailing $${atrStop} (1x ATR)`;
      } else if (trade.pattern === 'Engulfing') {
        entry   = isUp ? `Above $${d.high.toFixed(2)} (engulfing candle high)` : `Below $${d.low.toFixed(2)} (engulfing candle low)`;
        stop    = isUp ? `Below $${d.low.toFixed(2)} (engulfing candle low)` : `Above $${d.high.toFixed(2)} (engulfing candle high)`;
        target1 = `${dir}$${atrT1} from entry (1.5x ATR)`;
        target2 = `${dir}$${atrT2} from entry (2x ATR)`;
        target3 = `Trailing $${atrStop} (1x ATR)`;
      } else {
        entry   = 'Pattern-specific entry';
        stop    = `$${atrStop} from entry (1x ATR)`;
        target1 = `${dir}$${atrT1} from entry (1.5x ATR)`;
        target2 = `${dir}$${atrT2} from entry (2x ATR)`;
        target3 = `Trailing $${atrStop} (1x ATR)`;
      }

      const sizeColor = trade.score >= 7 ? '#10b981' : trade.score >= 5 ? '#f59e0b' : '#3b82f6';
      const sqBadgeRec = squeezeHTML(trade.squeeze);

      const vwapColor = trade.vwap.above_vwap === null ? '#6b7280' : trade.vwap.above_vwap ? '#10b981' : '#ef4444';
      const vwapLabel = trade.vwap.vwap !== null
        ? `$${trade.vwap.vwap.toFixed(2)} (${trade.vwap.distance_pct > 0 ? '+' : ''}${trade.vwap.distance_pct}%)`
        : 'N/A';
      const rsidivColors = { bullish: '#10b981', bearish: '#ef4444', both: '#f97316', none: '#4b5563', unknown: '#6b7280' };
      const rsidivLabels = { bullish: '▲ Bullish', bearish: '▼ Bearish', both: '⚡ Both', none: 'None', unknown: 'N/A' };

      html += `
        <div style="border: 2px solid ${sizeColor}; border-radius: 6px; padding: 14px; width: 400px; box-sizing: border-box;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div>
              <strong style="font-size: 1.1em;">${trade.symbol}</strong>
              <span style="margin-left: 8px; background: ${sizeColor}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.8em;">
                ${trade.pattern} ${trade.direction}
              </span>
            </div>
            <span style="font-weight: bold; color: ${sizeColor}; font-size: 0.85em;">${trade.score}/9 ${getDotsHTML(trade.score, 9)}</span>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; font-size: 0.85em;">
            <div><div class="muted">Price</div><strong>$${d.close.toFixed(2)}</strong></div>
            <div><div class="muted">ATR (14)</div><strong>${atr.toFixed(2)}</strong></div>
          </div>

          <div style="background: #22242a; padding: 8px; border-radius: 4px; font-size: 0.85em; margin-bottom: 10px;">
            <div><strong>Entry:</strong> ${entry}</div>
            <div><strong>Stop:</strong> ${stop}</div>
            <div><strong>T1 (33%):</strong> ${target1}</div>
            <div><strong>T2 (33%):</strong> ${target2}</div>
            <div><strong>T3 (33%):</strong> ${target3}</div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 0.8em;">
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">RSI</div>
              <strong>${d.rsi_14.toFixed(1)}</strong>
              ${trade.rsiDiv.signal !== 'none' && trade.rsiDiv.signal !== 'unknown'
                ? `<div style="color: ${rsidivColors[trade.rsiDiv.signal]}; font-size: 0.85em; margin-top: 2px;">${rsidivLabels[trade.rsiDiv.signal]}</div>`
                : ''}
            </div>
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">MACD</div>
              <span style="color: ${d.macd_histogram > 0 ? '#10b981' : '#ef4444'};">
                ${d.macd_histogram > 0 ? '▲ Bull' : '▼ Bear'}
              </span>
            </div>
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">MA(20)</div>
              <span style="color: ${d.above_ma_20 ? '#10b981' : '#ef4444'};">
                ${d.above_ma_20 ? '▲ Above' : '▼ Below'}
              </span>
            </div>
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">Squeeze</div>
              ${sqBadgeRec}
            </div>
            <div style="background: #22242a; padding: 8px; border-radius: 8px;">
              <div class="muted">VWAP</div>
              <span style="color: ${vwapColor};">${vwapLabel}</span>
            </div>
          </div>
        </div>`;
    });

    html += `</div>`;
  }

  document.getElementById('step5Content').innerHTML = html;
}

// =============================================================================
// STEP 6: POSITION SIZE CALCULATOR
// =============================================================================

function renderPositionCalc(scored) {
  if (scored.length === 0) {
    document.getElementById('step6Content').innerHTML = '';
    return;
  }

  let html = `
    <div style="margin-bottom: 16px;">
      <label for="accountInput" class="muted">Account Size ($)</label>
      <input type="number" id="accountInput" value="50000" min="1000" step="1000"
             style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 1em;">
    </div>

    <div id="positionSizes" style="display: grid; gap: 12px;">
  `;

  scored.forEach(trade => {
    const atr = trade.data.atr_14;
    const stopDist = atr * 1.5;
    const sizeLabel = trade.score >= 6 ? '100%' : trade.score >= 4 ? '75%' : '50%';

    html += `
      <div class="pill" style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 12px;">
        <div>
          <div class="muted">${trade.symbol}</div>
          <strong class="symSize_${trade.symbol}">—</strong>
        </div>
        <div>
          <div class="muted">Risk</div>
          <strong class="symRisk_${trade.symbol}">—</strong>
        </div>
        <div>
          <div class="muted">Stop Dist</div>
          <strong>${stopDist.toFixed(2)}</strong>
        </div>
        <div>
          <div class="muted">Size Mod</div>
          <strong>${sizeLabel}</strong>
        </div>
      </div>
    `;
  });

  html += `</div>`;

  document.getElementById('step6Content').innerHTML = html;

  // Add event listener and calculate
  document.getElementById('accountInput').addEventListener('change', () => updatePositionSizes(scored));
  updatePositionSizes(scored);
}

function updatePositionSizes(scored) {
  const account = parseFloat(document.getElementById('accountInput').value) || 50000;
  const riskPerTrade = (account * 0.01);  // 1% risk

  scored.forEach(trade => {
    const atr = trade.data.atr_14;
    const stopDist = atr * 1.5;
    const confluenceMod = trade.score >= 6 ? 1.0 : trade.score >= 4 ? 0.75 : 0.5;
    const posSize = Math.floor((riskPerTrade / stopDist) * confluenceMod);

    const riskAmount = posSize * stopDist;

    document.querySelector(`.symSize_${trade.symbol}`).textContent = `${posSize} shares`;
    document.querySelector(`.symRisk_${trade.symbol}`).textContent = `$${riskAmount.toFixed(0)}`;
  });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function getDotsHTML(filled, total) {
  let dots = '';
  for (let i = 0; i < total; i++) {
    dots += i < filled ? '●' : '○';
  }
  return dots;
}

// =============================================================================
// SUB-TAB SWITCHING
// =============================================================================

function switchTradeTab(tab) {
  document.querySelectorAll('#tab-morning, #tab-eod').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`).style.display = 'block';
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
}

// =============================================================================
// END OF DAY TAB
// =============================================================================

function renderEodOutcomes(scored) {
  const el = document.getElementById('eodContent');
  if (!el) return;

  const sec = (title, body) => `
    <div style="margin-bottom: 24px;">
      <h3 style="margin: 0 0 12px 0; color: #94a3b8; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #2a2a3e; padding-bottom: 6px;">${title}</h3>
      ${body}
    </div>`;

  const pill = (label, value, color, note) => `
    <div class="pill" style="min-width: 0;">
      <div class="muted" style="font-size:0.8em;">${label}</div>
      <span style="font-weight: bold; color: ${color};">${value}</span>
      ${note ? `<div class="muted" style="font-size:0.75em; margin-top:4px;">${note}</div>` : ''}
    </div>`;

  const outcomeBadge = (ok, hitLabel, missLabel) =>
    ok ? `<span style="color:#10b981; font-weight:bold;">${hitLabel}</span>`
       : `<span style="color:#6b7280;">${missLabel}</span>`;

  let html = '';

  // Morning cache warning
  if (cacheData.cache_type === 'morning') {
    const genStr = new Date(cacheData.generated).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    html += `<div style="background:#1a1400; border:1px solid #7c6a00; border-radius:6px; padding:10px 14px; margin-bottom:20px; color:#f59e0b; font-size:0.9em;">
      Cache generated at ${genStr} — market may still be open. Full outcomes update after the 4 PM ET close.
    </div>`;
  }

  // ── SECTION 1: DAY QUALITY ──────────────────────────────────────────────
  const grade = cacheData.day_quality.grade;
  const mods  = cacheData.day_quality.modifiers;
  const gradeColor = grade === 'A+' || grade === 'A' ? '#10b981' : grade === 'B' ? '#f59e0b' : '#ef4444';
  const gradeLabel = (grade === 'A+' || grade === 'A') ? 'Tradeable day' : grade === 'B' ? 'Reduced size' : 'No trades';

  let dqBody = `<div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:10px;">
    ${pill('Day Grade', grade, gradeColor, gradeLabel)}
    ${pill('ATR vs Avg', mods.atr_above_avg ? 'Above ✓' : 'Below ✗', mods.atr_above_avg ? '#10b981' : '#ef4444', null)}
    ${pill('Vol > 20d', mods.volume_above_20d ? 'Yes ✓' : 'No ✗', mods.volume_above_20d ? '#10b981' : '#6b7280', null)}
    ${pill('Vol > 50d', mods.volume_above_50d ? 'Yes ✓' : 'No ✗', mods.volume_above_50d ? '#10b981' : '#6b7280', null)}
  </div>`;
  if (['C', 'F'].includes(grade)) {
    dqBody += `<div style="margin-top:10px; color:#ef4444; font-size:0.9em;">No trades taken — day did not meet quality gate.</div>`;
  }
  html += sec('1 — Day Quality', dqBody);

  // ── SECTION 2: MARKET REGIME ────────────────────────────────────────────
  const regime = cacheData.regime;
  const regimeColors = { 'Trending': '#3b82f6', 'Ranging': '#f59e0b', 'Choppy': '#ef4444' };
  const patternMenus = {
    'Trending': 'ORB, Gap Continuation, Engulfing (with trend)',
    'Ranging':  'Gap Fill, Outside Day, Engulfing at S/R',
    'Choppy':   'No patterns — sit out'
  };
  const rCol = regimeColors[regime.label] || '#6b7280';
  html += sec('2 — Market Regime', `
    <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-bottom:10px;">
      ${pill('Regime', regime.label, rCol, null)}
      ${pill('Direction', regime.direction, '#e2e8f0', null)}
      ${pill('ATR Trend', regime.atr_trend, '#e2e8f0', null)}
    </div>
    <div class="muted" style="font-size:0.85em;">Valid patterns today: <strong style="color:#e2e8f0;">${patternMenus[regime.label] || '—'}</strong></div>`);

  // ── SECTION 3: PATTERN OUTCOMES ─────────────────────────────────────────
  const patterns = cacheData.active_patterns;
  if (patterns.length === 0) {
    html += sec('3 — Pattern Outcomes', '<div class="muted">No patterns detected today.</div>');
  } else {
    const patternCards = patterns.map(p => {
      const oc = p.outcome || {};
      const lv = p.levels || {};
      const dirArrow = p.direction === 'up' ? '▲' : p.direction === 'down' ? '▼' : '—';
      const dirColor = p.direction === 'up' ? '#10b981' : p.direction === 'down' ? '#ef4444' : '#94a3b8';

      let outcomeHTML = '';
      if (oc.next_day) {
        outcomeHTML = `<div style="color:#f59e0b; font-size:0.85em; margin-top:8px;">Next session setup — ${oc.note || ''}</div>`;
      } else if (p.pattern === 'ORB') {
        const orbDirLabel = oc.direction === 'up' ? '▲ Up' : oc.direction === 'down' ? '▼ Down' : '—';
        outcomeHTML = `<div style="margin-top:8px; display:flex; gap:12px; flex-wrap:wrap; font-size:0.85em;">
          ${outcomeBadge(oc.breached, `Breached ${orbDirLabel}`, 'No breach')}
          &nbsp;
          ${outcomeBadge(oc.hit_t1, '✓ T1 hit', 'T1 not reached')}
        </div>`;
      } else if (p.pattern === 'Gap') {
        outcomeHTML = `<div style="margin-top:8px; font-size:0.85em;">
          ${outcomeBadge(oc.filled, '✓ Gap filled', 'Gap remains open')}
        </div>`;
      }

      let levelsHTML = '';
      if (p.pattern === 'ORB' && lv.orb_high != null) {
        levelsHTML = `<div class="muted" style="font-size:0.8em; margin-top:6px;">Range $${lv.orb_low} – $${lv.orb_high} &nbsp;|&nbsp; T1↑ $${lv.t1_up} / T1↓ $${lv.t1_down}</div>`;
      } else if (p.pattern === 'Gap') {
        levelsHTML = `<div class="muted" style="font-size:0.8em; margin-top:6px;">Fill target $${lv.fill_target} &nbsp;|&nbsp; Continuation T1 $${lv.t1_continuation}</div>`;
      } else if (lv.entry != null) {
        levelsHTML = `<div class="muted" style="font-size:0.8em; margin-top:6px;">Entry $${lv.entry} &nbsp;|&nbsp; Stop $${lv.stop} &nbsp;|&nbsp; T1 $${lv.t1}${lv.t2 ? ' / T2 $' + lv.t2 : ''}</div>`;
      }

      return `<div style="border:1px solid #2a2a3e; border-radius:6px; padding:12px 14px; margin-bottom:8px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-weight:bold;">${p.symbol}</span>
          <span style="color:#94a3b8; font-size:0.85em;">${p.pattern}</span>
          <span style="color:${dirColor}; font-weight:bold;">${dirArrow}</span>
          <span class="muted" style="font-size:0.8em; margin-left:auto;">${p.notes}</span>
        </div>
        ${levelsHTML}
        ${outcomeHTML}
      </div>`;
    }).join('');
    html += sec('3 — Pattern Outcomes', patternCards);
  }

  // ── SECTION 4: CONFLUENCE REVIEW ────────────────────────────────────────
  if (!scored || scored.length === 0) {
    html += sec('4 — Confluence Review', '<div class="muted">No trades met confluence threshold (3+).</div>');
  } else {
    const confCards = scored.map(trade => {
      const sizeColor = trade.score >= 7 ? '#10b981' : trade.score >= 5 ? '#f59e0b' : '#3b82f6';
      const sizeLabel = trade.score >= 7 ? 'Full Size' : trade.score >= 5 ? '75% Size' : '50% Size';
      let checksHTML = Object.entries(trade.checks).map(([k, v]) =>
        `<div style="color:${v ? '#10b981' : '#4b5563'}; font-size:0.8em;">${v ? '✓' : '✗'} ${k}</div>`
      ).join('');
      return `<div style="border:2px solid ${sizeColor}; border-radius:6px; padding:12px 14px; width:380px; box-sizing:border-box;">
        <div style="font-weight:bold;">${trade.symbol} — ${trade.pattern}</div>
        <div style="margin:6px 0;">
          <span style="background:${sizeColor}; color:white; padding:2px 8px; border-radius:4px; font-size:0.8em; font-weight:bold;">${trade.score}/9 ${getDotsHTML(trade.score, 9)}</span>
          <span style="margin-left:8px; font-size:0.8em; color:${sizeColor}; font-weight:bold;">${sizeLabel}</span>
        </div>
        ${checksHTML}
        <div style="margin-top:6px; font-size:0.8em;">Squeeze: ${squeezeHTML(trade.squeeze)}</div>
      </div>`;
    }).join('');
    html += sec('4 — Confluence Review', `<div style="display:flex; flex-wrap:wrap; gap:12px;">${confCards}</div>`);
  }

  // ── SECTION 5: TRADE LEVELS & OUTCOMES ──────────────────────────────────
  const tradablePatterns = patterns.filter(p => p.levels && Object.keys(p.levels).length > 0);
  if (tradablePatterns.length === 0) {
    html += sec('5 — Trade Levels & Outcomes', '<div class="muted">No level data available.</div>');
  } else {
    const tradeRows = tradablePatterns.map(p => {
      const lv = p.levels;
      const oc = p.outcome || {};
      const isNextDay = oc.next_day;

      let rowsHTML = '';
      if (p.pattern === 'ORB') {
        const hitColor = oc.hit_t1 ? '#10b981' : oc.breached ? '#f59e0b' : '#6b7280';
        rowsHTML = `
          <tr><td class="muted">Watch range</td><td>$${lv.orb_low} – $${lv.orb_high}</td><td style="color:${oc.breached ? '#e2e8f0' : '#6b7280'};">${oc.breached ? (oc.direction === 'up' ? '▲ broke up' : '▼ broke down') : 'No breach'}</td></tr>
          <tr><td class="muted">T1 (1.5× ATR)</td><td>↑$${lv.t1_up} / ↓$${lv.t1_down}</td><td style="color:${hitColor};">${oc.hit_t1 ? '✓ Hit' : '—'}</td></tr>
          <tr><td class="muted">T2 (2× ATR)</td><td>↑$${lv.t2_up} / ↓$${lv.t2_down}</td><td class="muted">—</td></tr>`;
      } else if (p.pattern === 'Gap') {
        const fillColor = oc.filled ? '#10b981' : '#6b7280';
        rowsHTML = `
          <tr><td class="muted">Fill target</td><td>$${lv.fill_target}</td><td style="color:${fillColor};">${oc.filled ? '✓ Filled' : 'Not filled'}</td></tr>
          <tr><td class="muted">Continuation T1</td><td>$${lv.t1_continuation}</td><td class="muted">—</td></tr>
          <tr><td class="muted">Continuation T2</td><td>$${lv.t2_continuation}</td><td class="muted">—</td></tr>`;
      } else {
        rowsHTML = `
          <tr><td class="muted">Entry</td><td>$${lv.entry}</td><td style="color:#f59e0b;">${isNextDay ? 'Next session' : '—'}</td></tr>
          <tr><td class="muted">Stop</td><td>$${lv.stop}</td><td class="muted">—</td></tr>
          <tr><td class="muted">T1 (1.5×)</td><td>$${lv.t1}</td><td class="muted">—</td></tr>
          ${lv.t2 ? `<tr><td class="muted">T2 (2×)</td><td>$${lv.t2}</td><td class="muted">—</td></tr>` : ''}`;
      }

      return `<div style="margin-bottom:16px;">
        <div style="font-weight:bold; margin-bottom:8px;">${p.symbol} — ${p.pattern}</div>
        <table style="font-size:0.85em; border-collapse:collapse; width:100%; max-width:500px;">
          <thead><tr style="color:#6b7280; font-size:0.8em;"><th style="text-align:left; padding:2px 12px 6px 0;">Level</th><th style="text-align:left; padding:2px 12px 6px 0;">Price</th><th style="text-align:left; padding:2px 0 6px 0;">Outcome</th></tr></thead>
          <tbody>${rowsHTML}</tbody>
        </table>
      </div>`;
    }).join('');
    html += sec('5 — Trade Levels & Outcomes', tradeRows);
  }

  el.innerHTML = html;
}

// =============================================================================
// INIT
// =============================================================================

main();
