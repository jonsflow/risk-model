// nav.js — renders the site navigation from a central definition.
// Add <nav class="site-nav"></nav><script src="nav.js"></script> to each page.
(function () {
  const PAGES = [
    { href: 'index.html',    label: 'Divergence'    },
    { href: 'macro.html',    label: 'Macro Model'   },
    { href: 'credit.html',   label: 'Credit Spread' },
    { href: 'gov_data.html', label: 'Gov Data'      },
    { href: 'fomc.html',     label: 'FOMC'          },
    { href: 'correlation.html', label: 'Correlations' },
    { href: 'fed_chair.html',   label: 'Fed Chair'    },
    { href: 'trade.html',       label: 'Trade'        },
    { href: 'trend_structure.html', label: 'Trend'    },
  ];

  const current = location.pathname.split('/').pop() || 'index.html';
  const nav = document.querySelector('nav.site-nav');
  if (!nav) return;

  nav.innerHTML = PAGES.map(p =>
    `<a href="${p.href}" class="nav-link${current === p.href ? ' active' : ''}">${p.label}</a>`
  ).join('\n    ');
}());
