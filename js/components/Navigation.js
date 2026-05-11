// js/components/Navigation.js — ES module navigation component.
// Replaces nav.js IIFE. Import and call render() from each page module.

const PAGES = [
  { href: 'index.html',          label: 'Divergence'   },
  { href: 'macro.html',          label: 'Macro Model'  },
  { href: 'credit.html',         label: 'Credit Spread'},
  { href: 'gov_data.html',       label: 'Gov Data'     },
  { href: 'fomc.html',           label: 'FOMC'         },
  { href: 'correlation.html',    label: 'Correlations' },
  { href: 'fed_chair.html',      label: 'Fed Chair'    },
  { href: 'trade.html',          label: 'Trade'        },
  { href: 'trend_structure.html',label: 'Trend'        },
];

/**
 * Render the site navigation into the first <nav class="site-nav"> element.
 * Call once from each page's init() or DOMContentLoaded handler.
 */
export function renderNav() {
  const nav = document.querySelector('nav.site-nav');
  if (!nav) return;
  const current = location.pathname.split('/').pop() || 'index.html';
  nav.innerHTML = PAGES.map(p =>
    `<a href="${p.href}" class="nav-link${current === p.href ? ' active' : ''}">${p.label}</a>`
  ).join('\n    ');
}
