// js/components/Navigation.js — ES module navigation component.
// Replaces nav.js IIFE. Import and call render() from each page module.

const GROUPS = [
  { label: 'Market Flows', pages: [
    { href: 'index.html',                  label: 'Divergence'    },
    { href: 'pages/trend_structure.html',  label: 'Trend'         },
    { href: 'pages/macro.html',            label: 'Asset Classes' },
    { href: 'pages/correlation.html',      label: 'Correlations'  },
  ]},
  { label: 'Federal Reserve', pages: [
    { href: 'pages/fomc.html',      label: 'FOMC'      },
    { href: 'pages/fed_chair.html', label: 'Fed Chair' },
  ]},
  { label: 'Economic Data', pages: [
    { href: 'pages/gov_data.html', label: 'Gov Data'      },
    { href: 'pages/credit.html',   label: 'Credit Spread' },
  ]},
];

const STANDALONE = [
  { href: 'pages/trade.html', label: 'Trade' },
];

/**
 * Render the site navigation into the first <nav class="site-nav"> element.
 * Call once from each page's init() or DOMContentLoaded handler.
 */
export function renderNav() {
  const nav = document.querySelector('nav.site-nav');
  if (!nav) return;

  const currentFile = location.pathname.split('/').pop() || 'index.html';
  const currentGroup = GROUPS.find(g => g.pages.some(p => p.href.split('/').pop() === currentFile));

  const topNavHTML = GROUPS.map(g => {
    const isActive = g === currentGroup;
    return `<a href="${g.pages[0].href}" class="nav-link${isActive ? ' active' : ''}">${g.label}</a>`;
  }).join('') + STANDALONE.map(p => {
    const isActive = p.href.split('/').pop() === currentFile;
    return `<a href="${p.href}" class="nav-link${isActive ? ' active' : ''}">${p.label}</a>`;
  }).join('');

  nav.innerHTML = topNavHTML;

  if (currentGroup) {
    const tabBarHTML = `<div class="tab-bar">${currentGroup.pages.map(p => {
      const isActive = p.href.split('/').pop() === currentFile;
      return `<button class="tab-btn${isActive ? ' active' : ''}" onclick="location.href='${p.href}'">${p.label}</button>`;
    }).join('')}</div>`;
    nav.insertAdjacentHTML('afterend', tabBarHTML);
  }
}
