// AutoFetcher 趨勢浮層模組（點擊欄標或數值卡顯示序列走勢與快速操作）

import { buildSeries } from './series.js';
import { lineChart } from './charts.js';
import { getLayout, addCard } from '../../shared/layout-store.js';
import { buildHash } from './logic.js';
import { parentIdOf } from '../../shared/series-index.js';

let activePopover = null;
let activeAnchor = null;
let activeDoc = null;
let onDocClick = null;
let onDocKeyDown = null;

/**
 * 關閉目前開啟的趨勢浮層
 */
export function closeTrendPopover() {
  if (activeDoc) {
    if (onDocClick) {
      activeDoc.removeEventListener('click', onDocClick);
    }
    if (onDocKeyDown) {
      activeDoc.removeEventListener('keydown', onDocKeyDown);
    }
    activeDoc = null;
  }
  onDocClick = null;
  onDocKeyDown = null;
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  activeAnchor = null;
}

/**
 * 開啟趨勢浮層
 * @param {string} seriesId - 序列 ID
 * @param {object} ctx - 報表上下文
 * @param {HTMLElement} anchorEl - 觸發之錨點元素
 */
export function openTrendPopover(seriesId, ctx, anchorEl) {
  // 再點一次觸發元素則關閉浮層
  if (activeAnchor === anchorEl) {
    closeTrendPopover();
    return;
  }

  // 同時只能存在一個浮層，先關掉舊的
  closeTrendPopover();

  activeAnchor = anchorEl;
  const doc = anchorEl?.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) return;
  activeDoc = doc;

  const popoverEl = doc.createElement('div');
  popoverEl.setAttribute('data-trend-popover', '');
  popoverEl.className = 'trend-popover';

  // 定位在 anchorEl 附近（沒有 getBoundingClientRect 時放在左上角，不丟例外）
  let top = 0;
  let left = 0;
  try {
    if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
      const rect = anchorEl.getBoundingClientRect();
      const win = anchorEl.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
      const pageX = win ? (win.scrollX || win.pageXOffset || 0) : 0;
      const pageY = win ? (win.scrollY || win.pageYOffset || 0) : 0;
      top = (rect.bottom || 0) + pageY + 4;
      left = (rect.left || 0) + pageX;
    }
  } catch {
    top = 0;
    left = 0;
  }

  popoverEl.style.position = 'absolute';
  popoverEl.style.top = `${top}px`;
  popoverEl.style.left = `${left}px`;
  popoverEl.style.zIndex = '1000';
  popoverEl.style.backgroundColor = 'var(--surface)';
  popoverEl.style.border = '1px solid var(--border)';
  popoverEl.style.borderRadius = 'var(--radius)';
  popoverEl.style.padding = '0.75rem';
  popoverEl.style.display = 'flex';
  popoverEl.style.flexDirection = 'column';
  popoverEl.style.gap = '0.5rem';

  // 1. 標題：這條序列的名稱（ctx.tasksById[seriesId].name，查不到就用 id）
  const seriesInfo = ctx?.tasksById?.[seriesId];
  const seriesName = seriesInfo?.name || seriesId;
  const titleEl = doc.createElement('div');
  titleEl.className = 'trend-popover-title';
  titleEl.style.fontWeight = 'bold';
  titleEl.textContent = seriesName;
  popoverEl.appendChild(titleEl);

  // 2. 折線圖與圖例容器
  const chartContainer = doc.createElement('div');
  chartContainer.className = 'trend-popover-chart';
  popoverEl.appendChild(chartContainer);

  const noteEl = doc.createElement('div');
  noteEl.className = 'trend-popover-note';
  popoverEl.appendChild(noteEl);

  const legendEl = doc.createElement('div');
  legendEl.className = 'trend-popover-legend';
  popoverEl.appendChild(legendEl);

  let currentSeriesIds = [seriesId];

  function renderChart(capped = false) {
    chartContainer.textContent = '';
    const seriesSource = currentSeriesIds.map(id => ({ taskId: id }));
    const seriesList = buildSeries(ctx?.records || [], seriesSource, {
      from: ctx?.range?.from,
      to: ctx?.range?.to
    });
    const svg = lineChart(seriesList, { width: 400, height: 160 });
    chartContainer.appendChild(svg);

    legendEl.textContent = '';
    if (currentSeriesIds.length > 1) {
      legendEl.style.display = 'flex';
      legendEl.style.flexWrap = 'wrap';
      legendEl.style.gap = '0.5rem';
      legendEl.style.fontSize = '0.8rem';
      currentSeriesIds.forEach((sid, idx) => {
        const item = doc.createElement('div');
        item.className = 'chart-legend-item';
        item.style.display = 'inline-flex';
        item.style.alignItems = 'center';
        item.style.gap = '0.25rem';

        const dot = doc.createElement('span');
        dot.className = 'chart-legend-dot';
        dot.style.display = 'inline-block';
        dot.style.width = '8px';
        dot.style.height = '8px';
        dot.style.borderRadius = '50%';
        dot.style.backgroundColor = `var(--chart-${(idx % 8) + 1})`;
        item.appendChild(dot);

        const label = doc.createElement('span');
        label.className = 'chart-legend-label';
        label.textContent = ctx?.tasksById?.[sid]?.name || sid;
        item.appendChild(label);

        legendEl.appendChild(item);
      });
    }

    if (capped) {
      noteEl.textContent = '已達上限 8 條，僅顯示前 8 條';
      noteEl.style.fontSize = '0.75rem';
      noteEl.style.color = 'var(--text-muted)';
    } else {
      noteEl.textContent = '';
    }
  }

  renderChart(false);

  // 3. 操作按鈕列
  const actionsEl = doc.createElement('div');
  actionsEl.className = 'trend-popover-actions';
  actionsEl.style.display = 'flex';
  actionsEl.style.gap = '0.5rem';
  actionsEl.style.marginTop = '0.25rem';

  // 按鈕「加入為折線卡」，帶 data-trend-add 屬性
  const addBtn = doc.createElement('button');
  addBtn.type = 'button';
  addBtn.setAttribute('data-trend-add', '');
  addBtn.textContent = '加入為折線卡';
  addBtn.addEventListener('click', async () => {
    const layout = await getLayout();
    const targetDashId = ctx?.dashId || layout?.dashboards?.[0]?.id;
    if (targetDashId) {
      await addCard(targetDashId, {
        type: 'line',
        source: currentSeriesIds.map(id => ({ taskId: id })),
        w: 12,
        h: 3
      });
    }
    closeTrendPopover();
  });
  actionsEl.appendChild(addBtn);

  // 按鈕「到歷史頁」，帶 data-trend-history 屬性
  const historyBtn = doc.createElement('button');
  historyBtn.type = 'button';
  historyBtn.setAttribute('data-trend-history', '');
  historyBtn.textContent = '到歷史頁';
  historyBtn.addEventListener('click', () => {
    const hash = buildHash({
      view: 'history',
      from: ctx?.range?.from,
      to: ctx?.range?.to,
      taskIds: [seriesId]
    });
    if (typeof window !== 'undefined') {
      window.location.hash = hash;
    }
    closeTrendPopover();
  });
  actionsEl.appendChild(historyBtn);

  // 按鈕「比較其他任務的同名值」，帶 data-trend-compare 屬性
  // 在 ctx.tasksById 裡找出 shortName 與這條序列相同、但 parentId 不同的序列
  const targetShortName = seriesInfo?.shortName;
  const targetParentId = seriesInfo?.parentId || parentIdOf(seriesId);
  const matchingSeriesIds = [];

  if (targetShortName && ctx?.tasksById) {
    for (const [id, info] of Object.entries(ctx.tasksById)) {
      if (id === seriesId) continue;
      const otherParentId = info?.parentId || parentIdOf(id);
      if (info?.shortName === targetShortName && otherParentId !== targetParentId) {
        matchingSeriesIds.push(id);
      }
    }
  }

  if (matchingSeriesIds.length > 0) {
    const compareBtn = doc.createElement('button');
    compareBtn.type = 'button';
    compareBtn.setAttribute('data-trend-compare', '');
    compareBtn.textContent = '比較其他任務的同名值';
    compareBtn.addEventListener('click', () => {
      let combined = [seriesId, ...matchingSeriesIds];
      let capped = false;
      if (combined.length > 8) {
        combined = combined.slice(0, 8);
        capped = true;
      }
      currentSeriesIds = combined;
      renderChart(capped);
      compareBtn.hidden = true;
    });
    actionsEl.appendChild(compareBtn);
  }

  popoverEl.appendChild(actionsEl);

  doc.body.appendChild(popoverEl);
  activePopover = popoverEl;

  // 關閉事件：再點一次觸發元素、按 Esc、或點浮層以外的地方
  onDocClick = (e) => {
    if (activeAnchor && (e.target === activeAnchor || activeAnchor.contains(e.target))) {
      return;
    }
    if (activePopover && activePopover.contains(e.target)) {
      return;
    }
    closeTrendPopover();
  };

  onDocKeyDown = (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      closeTrendPopover();
    }
  };

  doc.addEventListener('click', onDocClick);
  doc.addEventListener('keydown', onDocKeyDown);
}
