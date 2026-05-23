// js/components/Navigation.js — ES module navigation component.
// Replaces nav.js IIFE. Import and call render() from each page module.

const PAGES = [
  { href: 'index.html',                label: 'Divergence'   },
  { href: 'pages/macro.html',          label: 'Macro Model'  },
  { href: 'pages/credit.html',         label: 'Credit Spread'},
  { href: 'pages/gov_data.html',       label: 'Gov Data'     },
  { href: 'pages/fomc.html',           label: 'FOMC'         },
  { href: 'pages/correlation.html',    label: 'Correlations' },
  { href: 'pages/fed_chair.html',      label: 'Fed Chair'    },
  { href: 'pages/trade.html',          label: 'Trade'        },
  { href: 'pages/trend_structure.html',label: 'Trend'        },
];

/**
 * Render the site navigation into the first <nav class="site-nav"> element.
 * Call once from each page's init() or DOMContentLoaded handler.
 */
export function renderNav() {
  const nav = document.querySelector('nav.site-nav');
  if (!nav) return;
  const current = location.pathname.split('/').pop() || 'index.html';
  nav.innerHTML = PAGES.map(p => {
    const file = p.href.split('/').pop();
    return `<a href="${p.href}" class="nav-link${current === file ? ' active' : ''}">${p.label}</a>`;
  }).join('\n    ');
}
