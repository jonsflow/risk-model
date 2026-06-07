// js/components/TabContainer.js — Reusable tab UI component.
// Used on divergence, macro, trade, and gov_data pages.

/**
 * Initialize a tab container.
 *
 * @param {string}   containerSelector   - CSS selector for the tab bar
 * @param {string}   panelContainerSelector - CSS selector for the panels wrapper
 * @param {Function} onTabChange         - called with (tabId, tabEl) on switch
 * @returns {{ setActive: Function }}
 */
export function initTabs(containerSelector, panelContainerSelector, onTabChange) {
  const bar = document.querySelector(containerSelector);
  if (!bar) return { setActive: () => {} };

  const tabs = Array.from(bar.querySelectorAll('.tab-btn,[data-tab]'));
  const panels = panelContainerSelector
    ? Array.from(document.querySelectorAll(`${panelContainerSelector} [data-tab-panel]`))
    : [];

  function setActive(id) {
    tabs.forEach(t => {
      const tid = t.dataset.tab || t.dataset.tabTarget;
      t.classList.toggle('active', tid === id);
    });
    panels.forEach(p => {
      p.style.display = p.dataset.tabPanel === id ? '' : 'none';
    });
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab || tab.dataset.tabTarget;
      setActive(id);
      if (onTabChange) onTabChange(id, tab);
    });
  });

  return { setActive };
}

/**
 * Build a tab bar DOM element from a list of tab definitions.
 *
 * @param {Array<{id: string, label: string}>} tabDefs
 * @param {string} activeId - initially active tab id
 * @returns {HTMLElement}
 */
export function buildTabBar(tabDefs, activeId) {
  const bar = document.createElement('div');
  bar.className = 'tab-bar';
  for (const { id, label } of tabDefs) {
    const btn = document.createElement('button');
    btn.className = `tab-btn${id === activeId ? ' active' : ''}`;
    btn.dataset.tab = id;
    btn.textContent = label;
    bar.appendChild(btn);
  }
  return bar;
}
