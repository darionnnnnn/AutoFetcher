// AutoFetcher 卡片渲染模組（將卡片設定與資料渲染為 DOM 元素）

import { buildSeries, resolvePeriod, latest, pivot, effectiveTimeOf } from './series.js';

// 樞紐表未指定列數上限時的預設(避免長時間區間渲染上千列)
const DEFAULT_PIVOT_ROWS = 50;
import { lineChart, barChart, gauge, sparkline } from './charts.js';
import { isSuccess, isRed, isWarn } from '../../shared/record-status.js';
import { parentIdOf } from '../../shared/series-index.js';
import { openTrendPopover } from './trend-popover.js';

const SUPPORTED_TYPES = new Set(['number', 'line', 'bar', 'table', 'gauge', 'text', 'status']);

/**
 * 格式化數值（共用工具）
 */
function formatNumber(val, decimals) {
  if (val == null || typeof val !== 'number' || !Number.isFinite(val)) {
    return '—';
  }
  if (typeof decimals === 'number' && Number.isFinite(decimals)) {
    return val.toFixed(decimals);
  }
  // 沒指定小數位時去掉浮點運算的尾巴（31.400000000000002 要顯示成 31.4）。
  // 只處理有小數的值，整數原樣輸出——對大整數做有效位數截斷會改到真正的數字
  if (Number.isInteger(val)) return String(val);
  return String(Number(val.toPrecision(12)));
}

const CARD_TYPE_SUFFIXES = {
  number: '數值',
  line: '趨勢',
  bar: '長條',
  table: '明細',
  gauge: '量表',
  status: '狀態'
};

/**
 * 依卡片 source 算出來源名稱（多來源以頓號串接）
 */
function getCardSourceName(card, ctx) {
  const sources = card?.source || [];
  const names = sources
    .map(s => (s && s.taskId ? (ctx?.tasksById?.[s.taskId]?.name || s.taskId) : ''))
    .filter(Boolean);
  return names.length > 0 ? names.join('、') : '';
}

/**
 * 取得卡片標題（自訂標題優先；否則以來源名稱為主，
 * 若同一儀表板內排在前面已有同名但不同型別的卡片，就補上型別後綴以便分辨）
 */
function getCardTitle(card, ctx) {
  if (card.title != null && String(card.title).trim() !== '') {
    return String(card.title);
  }
  const baseName = getCardSourceName(card, ctx);
  if (!baseName) {
    return '';
  }

  if (Array.isArray(ctx?.cards)) {
    let cardIndex = ctx.cards.indexOf(card);
    if (cardIndex === -1 && card?.id) {
      cardIndex = ctx.cards.findIndex(c => c && c.id === card.id);
    }
    if (cardIndex > 0) {
      const hasConflict = ctx.cards.slice(0, cardIndex).some(c =>
        c &&
        c.type !== card.type &&
        getCardSourceName(c, ctx) === baseName
      );
      if (hasConflict) {
        const suffix = CARD_TYPE_SUFFIXES[card.type];
        if (suffix) {
          return `${baseName} · ${suffix}`;
        }
      }
    }
  }

  return baseName;
}

/**
 * 解析卡片生效的起訖日期範圍
 */
function resolveCardRange(card, ctx) {
  return resolvePeriod(card.options?.period, ctx?.range?.from, ctx?.range?.to, ctx?.today);
}

/**
 * 建立卡片外層骨架（容器、標頭、標題、期間小標、齒輪按鈕、內容區）
 */
function createCardShell(card, ctx) {
  const cardEl = document.createElement('div');
  cardEl.className = 'report-card';
  cardEl.dataset.cardId = card.id ?? '';
  cardEl.dataset.cardType = card.type ?? '';

  const headerEl = document.createElement('div');
  headerEl.className = 'card-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = getCardTitle(card, ctx);
  headerEl.appendChild(titleEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'card-meta';

  const period = card.options?.period;
  const isNumericPeriod = typeof period === 'number' && Number.isFinite(period);
  if (isNumericPeriod) {
    const periodBadge = document.createElement('span');
    periodBadge.className = 'card-period';
    periodBadge.textContent = `近 ${period} 天`;
    metaEl.appendChild(periodBadge);
  }

  const actionsEl = document.createElement('div');
  actionsEl.className = 'card-actions';

  const configBtn = document.createElement('button');
  configBtn.type = 'button';
  configBtn.className = 'card-btn-config';
  configBtn.dataset.action = 'config';
  configBtn.setAttribute('aria-label', '設定');
  configBtn.textContent = '⚙';
  actionsEl.appendChild(configBtn);

  metaEl.appendChild(actionsEl);
  headerEl.appendChild(metaEl);
  cardEl.appendChild(headerEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'card-body';
  cardEl.appendChild(bodyEl);

  return { cardEl, headerEl, bodyEl, actionsEl, configBtn };
}

/**
 * 渲染數值卡片
 */
function renderNumberCard(card, ctx, { cardEl, bodyEl }) {
  const taskId = card.source?.[0]?.taskId;
  const { current, prev, prevDay } = taskId ? latest(ctx.records, taskId, ctx.today) : { current: null, prev: null, prevDay: null };
  // health 掛在父任務上（一個任務可以有多個值，卡片來源可能是子序列 id）
  const health = taskId ? ctx.health?.[parentIdOf(taskId)] : null;

  // 只有「最新一筆不成功」或「health 是紅燈」才蓋掉值；
  // 黃燈（備援、遲到、只抓到部分）照樣顯示抓到的值，原因放 title
  const isFailed = (current && !isSuccess(current)) || isRed(health);
  const hasValidValue = !isFailed && current != null && typeof current.value === 'number' && Number.isFinite(current.value);

  const displayEl = document.createElement('div');
  displayEl.className = 'card-number-display';

  const valEl = document.createElement('span');
  valEl.className = 'card-number-value';

  if (hasValidValue) {
    valEl.textContent = formatNumber(current.value, card.options?.decimals);
    // 黃燈仍顯示值，但要讓使用者看得到這個值是怎麼來的
    if (isWarn(health) && health?.reason) {
      valEl.setAttribute('title', health.reason);
    }
    displayEl.appendChild(valEl);

    if (card.options?.unit) {
      const unitEl = document.createElement('span');
      unitEl.className = 'card-number-unit';
      unitEl.textContent = ` ${card.options.unit}`;
      displayEl.appendChild(unitEl);
    }
  } else {
    valEl.textContent = '—';
    if (health?.reason) {
      valEl.setAttribute('title', health.reason);
    }
    displayEl.appendChild(valEl);
  }

  if (!ctx?.editing && taskId) {
    valEl.classList.add('clickable');
    valEl.addEventListener('click', () => {
      openTrendPopover(taskId, ctx, valEl);
    });
  }

  bodyEl.appendChild(displayEl);

  // 差異比較
  if (hasValidValue) {
    const baseRec = card.options?.compare === 'prevDay' ? prevDay : prev;
    if (baseRec && typeof baseRec.value === 'number' && Number.isFinite(baseRec.value)) {
      const diff = current.value - baseRec.value;
      if (diff > 0) {
        const diffEl = document.createElement('span');
        diffEl.className = 'card-number-diff diff-up';
        diffEl.textContent = `↑ ${formatNumber(diff, card.options?.decimals)}`;
        bodyEl.appendChild(diffEl);
      } else if (diff < 0) {
        const diffEl = document.createElement('span');
        diffEl.className = 'card-number-diff diff-down';
        diffEl.textContent = `↓ ${formatNumber(Math.abs(diff), card.options?.decimals)}`;
        bodyEl.appendChild(diffEl);
      }
    }
  }

  // 閾值判定
  if (hasValidValue && Array.isArray(card.options?.thresholds)) {
    for (const t of card.options.thresholds) {
      if (!t) continue;
      let hit = false;
      if (t.op === 'gte') {
        hit = current.value >= t.value;
      } else if (t.op === 'lte') {
        hit = current.value <= t.value;
      } else if (t.op === 'gt') {
        hit = current.value > t.value;
      } else if (t.op === 'lt') {
        hit = current.value < t.value;
      } else if (t.op === 'eq') {
        hit = current.value === t.value;
      }

      if (hit) {
        valEl.classList.add('threshold-hit');
        if (t.color) {
          valEl.style.setProperty('--card-accent', t.color);
          cardEl.style.setProperty('--card-accent', t.color);
        }
        break;
      }
    }
  }

  // 迷你走勢圖
  if (card.options?.sparkline === true) {
    const periodRange = resolveCardRange(card, ctx);
    const seriesList = buildSeries(ctx.records, card.source, {
      from: periodRange.from,
      to: periodRange.to,
      aggregation: card.options?.aggregation || 'raw'
    });
    const points = seriesList[0]?.points || [];
    const sparkSvg = sparkline(points, {
      yMin: card.options?.yMin,
      yMax: card.options?.yMax
    });
    bodyEl.appendChild(sparkSvg);
  }
}

/**
 * 渲染折線圖與長條圖卡片
 */
/**
 * 建立「拖出移除」把手(只有一份;table 欄標、圖表圖例、狀態清單共用)
 */
function makeRemoveHandle(taskId, editing) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.setAttribute('data-remove-source', '');
  handle.setAttribute('data-task-id', taskId);
  handle.className = 'remove-source-handle';
  handle.hidden = !editing;
  handle.textContent = editing ? '×' : '';
  return handle;
}

function renderChartCard(card, ctx, { bodyEl }) {
  const periodRange = resolveCardRange(card, ctx);
  const seriesList = buildSeries(ctx.records, card.source, {
    from: periodRange.from,
    to: periodRange.to,
    aggregation: card.options?.aggregation,
    normalize: card.options?.normalize
  });

  // viewBox 的長寬比要貼近卡片實際的格子比例，否則等比縮放後會在左右留一大片空白
  const cols = Number.isFinite(Number(card.w)) ? Number(card.w) : 6;
  const rows = Number.isFinite(Number(card.h)) ? Number(card.h) : 3;
  const chartOpts = {
    width: Math.max(320, cols * 110),
    height: Math.max(140, rows * 70),
    yMin: card.options?.yMin,
    yMax: card.options?.yMax,
    unit: card.options?.unit
  };

  const svg = card.type === 'line' ? lineChart(seriesList, chartOpts) : barChart(seriesList, chartOpts);

  if (typeof ctx?.onPointClick === 'function') {
    const points = svg.querySelectorAll('[data-t]');
    for (const ptEl of points) {
      ptEl.style.cursor = 'pointer';
      ptEl.addEventListener('click', () => {
        const t = ptEl.getAttribute('data-t') || '';
        const taskId = ptEl.getAttribute('data-task-id') || '';
        ctx.onPointClick({ taskId, date: t.slice(0, 10) });
      });
    }
  }

  // 圖例列（每條序列一個圖例項目，附帶拖出移除把手）
  // 色號一律用 card.source 的「原始索引」，因為 buildSeries 不過濾，
  // 過濾後再編號會讓髒資料之後的所有圖例顏色整排位移
  const sources = card.source || [];
  if (sources.some(s => s && s.taskId)) {
    const legendEl = document.createElement('div');
    legendEl.className = 'card-chart-legend';

    sources.forEach((s, idx) => {
      if (!s || !s.taskId) return;
      const itemEl = document.createElement('div');
      itemEl.className = 'chart-legend-item';

      const dotEl = document.createElement('span');
      dotEl.className = 'chart-legend-dot';
      dotEl.style.backgroundColor = `var(--chart-${(idx % 8) + 1})`;
      itemEl.appendChild(dotEl);

      const labelEl = document.createElement('span');
      labelEl.className = 'chart-legend-label';
      labelEl.textContent = ctx?.tasksById?.[s.taskId]?.name || s.taskId;
      itemEl.appendChild(labelEl);

      itemEl.appendChild(makeRemoveHandle(s.taskId, Boolean(ctx?.editing)));
      legendEl.appendChild(itemEl);
    });

    bodyEl.appendChild(legendEl);
  }

  bodyEl.appendChild(svg);
}

/**
 * 渲染表格卡片（樞紐模式或最近紀錄模式）
 */
function renderTableCard(card, ctx, { cardEl, bodyEl, actionsEl, configBtn }) {
  const isPivot = card.options?.mode === 'pivot';
  const periodRange = resolveCardRange(card, ctx);

  // 依期間範圍篩選紀錄
  const filteredRecords = (ctx?.records || []).filter(r => {
    if (!r) return false;
    // 有效時刻只有一份,在 series.js
    const d = effectiveTimeOf(r).slice(0, 10) || r.date || '';
    if (!d) return true;
    if (periodRange.from && d < periodRange.from) return false;
    if (periodRange.to && d > periodRange.to) return false;
    return true;
  });

  const table = document.createElement('table');
  table.className = 'card-table';
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);

  let tsvHeaders = [];
  let tsvRows = [];

  if (isPivot) {
    const taskIds = (card.source || []).map(s => s && s.taskId).filter(Boolean);
    if (taskIds.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'card-table-empty';
      emptyEl.textContent = '尚無資料來源，請從左側拖曳任務加入';
      bodyEl.appendChild(emptyEl);
      return;
    }

    // 欄序就是 card.source 的順序(拖曳插入欄位靠它)
    const { columns, rows } = pivot(filteredRecords, taskIds, {
      taskOrder: taskIds,
      bucketMinutes: card.options?.bucketMinutes,
      // 沒設上限時仍要有預設,否則一個月的 interval 資料會渲染上千列
      limit: (typeof card.options?.limit === 'number' && card.options.limit > 0)
        ? card.options.limit
        : DEFAULT_PIVOT_ROWS
    });

    // 表頭：第一欄是列軸標頭（可自訂，預設「時間」），後續是各任務名稱
    const rowHeader = typeof card.options?.rowHeader === 'string' && card.options.rowHeader.trim() !== ''
      ? card.options.rowHeader.trim()
      : '時間';
    tsvHeaders = [rowHeader, ...columns.map(id => ctx?.tasksById?.[id]?.name || id)];
    const headTr = document.createElement('tr');

    const rowTh = document.createElement('th');
    rowTh.textContent = rowHeader;
    headTr.appendChild(rowTh);

    for (const id of columns) {
      const th = document.createElement('th');
      const titleSpan = document.createElement('span');
      titleSpan.textContent = ctx?.tasksById?.[id]?.name || id;
      th.appendChild(titleSpan);

      th.appendChild(makeRemoveHandle(id, Boolean(ctx?.editing)));

      if (!ctx?.editing) {
        th.classList.add('clickable');
        th.addEventListener('click', (e) => {
          if (e.target?.closest?.('[data-remove-source]')) return;
          openTrendPopover(id, ctx, th);
        });
      }

      headTr.appendChild(th);
    }
    thead.appendChild(headTr);

    const showDelta = Boolean(card.options?.showDelta);

    // 表身各列
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const r = rows[rowIndex];
      const tr = document.createElement('tr');
      const timeTd = document.createElement('td');
      timeTd.textContent = r.t ?? '';
      tr.appendChild(timeTd);

      const rowTsv = [r.t ?? ''];

      for (const col of columns) {
        const val = r.values?.[col];
        const td = document.createElement('td');
        // 這一格由多筆合併而來時說明來源筆數，避免使用者以為只抓了一次
        const mergedCount = r.merged?.[col];
        if (typeof mergedCount === 'number' && mergedCount > 1) {
          td.title = `合併 ${mergedCount} 筆，取最新的成功值`;
        }
        if (val != null && typeof val === 'number' && Number.isFinite(val)) {
          const formatted = formatNumber(val, card.options?.decimals);
          td.textContent = formatted;
          rowTsv.push(formatted);

          if (showDelta && rowIndex > 0) {
            const prevRow = rows[rowIndex - 1];
            const prevVal = prevRow?.values?.[col];
            if (prevVal != null && typeof prevVal === 'number' && Number.isFinite(prevVal)) {
              const diff = val - prevVal;
              const roundedDiff = Math.round(diff * 1e8) / 1e8;
              if (roundedDiff !== 0) {
                const deltaEl = document.createElement('span');
                deltaEl.setAttribute('data-delta', '');
                deltaEl.className = roundedDiff > 0 ? 'delta-up' : 'delta-down';
                const formattedDelta = typeof card.options?.decimals === 'number' && Number.isFinite(card.options.decimals)
                  ? Math.abs(diff).toFixed(card.options.decimals)
                  : String(Math.abs(roundedDiff));
                deltaEl.textContent = `${roundedDiff > 0 ? '↑' : '↓'} ${formattedDelta}`;
                deltaEl.title = `前值 ${formatNumber(prevVal, card.options?.decimals)}`;
                td.appendChild(document.createTextNode(' '));
                td.appendChild(deltaEl);
              }
            }
          }
        } else if (val != null) {
          td.textContent = String(val);
          rowTsv.push(String(val));
        } else {
          td.textContent = '—';
          rowTsv.push('');
        }
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
      tsvRows.push(rowTsv);
    }
  } else {
    // recent 模式
    const sourceTaskIds = new Set((card.source || []).map(s => s && s.taskId).filter(Boolean));
    const matched = filteredRecords.filter(r => sourceTaskIds.size === 0 || sourceTaskIds.has(r.taskId));

    // 由新到舊排序
    const sorted = [...matched].sort((a, b) => effectiveTimeOf(b).localeCompare(effectiveTimeOf(a)));

    const limit = typeof card.options?.limit === 'number' && card.options.limit > 0 ? card.options.limit : 10;
    const sliced = sorted.slice(0, limit);

    tsvHeaders = ['時間', '任務', '值', '狀態'];
    const headTr = document.createElement('tr');
    for (const h of tsvHeaders) {
      const th = document.createElement('th');
      th.textContent = h;
      headTr.appendChild(th);
    }
    thead.appendChild(headTr);

    for (const r of sliced) {
      const tr = document.createElement('tr');

      const timeTd = document.createElement('td');
      timeTd.textContent = effectiveTimeOf(r);
      tr.appendChild(timeTd);

      const taskTd = document.createElement('td');
      const taskName = ctx?.tasksById?.[r.taskId]?.name || r.taskId || '';
      taskTd.textContent = taskName;
      tr.appendChild(taskTd);

      const valTd = document.createElement('td');
      let valDisplay = '—';
      let valRaw = '';
      if (typeof r.value === 'number' && Number.isFinite(r.value)) {
        const formatted = formatNumber(r.value, card.options?.decimals);
        valDisplay = card.options?.unit ? `${formatted} ${card.options.unit}` : formatted;
        valRaw = formatted;
      } else if (r.raw != null) {
        valDisplay = String(r.raw);
        valRaw = String(r.raw);
      }
      valTd.textContent = valDisplay;
      tr.appendChild(valTd);

      const statusTd = document.createElement('td');
      statusTd.textContent = r.status || '—';
      tr.appendChild(statusTd);

      tbody.appendChild(tr);
      tsvRows.push([effectiveTimeOf(r), taskName, valRaw, r.status || '']);
    }
  }

  bodyEl.appendChild(table);

  const fullData = [tsvHeaders, ...tsvRows];
  const tsvContent = buildTsv(fullData);
  if (cardEl) {
    cardEl.dataset.tsv = tsvContent;
  }

  // 複製 TSV 按鈕
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'card-btn-copy';
  copyBtn.dataset.action = 'copy-tsv';
  copyBtn.textContent = '複製 TSV';

  const nav = typeof navigator !== 'undefined' ? navigator : (typeof window !== 'undefined' ? window.navigator : null);
  const hasClipboard = Boolean(nav && nav.clipboard && typeof nav.clipboard.writeText === 'function');
  if (!hasClipboard) {
    copyBtn.hidden = true;
  }

  copyBtn.addEventListener('click', () => {
    const currentNav = typeof navigator !== 'undefined' ? navigator : (typeof window !== 'undefined' ? window.navigator : null);
    if (currentNav?.clipboard?.writeText) {
      currentNav.clipboard.writeText(tsvContent).catch(() => {});
    }
  });

  actionsEl.insertBefore(copyBtn, configBtn);
}

/**
 * 渲染儀表圖卡片
 */
function renderGaugeCard(card, ctx, { bodyEl }) {
  const taskId = card.source?.[0]?.taskId;
  const { current } = taskId ? latest(ctx.records, taskId, ctx.today) : { current: null };
  const val = current && typeof current.value === 'number' && Number.isFinite(current.value) ? current.value : null;

  const svg = gauge({
    value: val,
    min: card.options?.min ?? 0,
    max: card.options?.max ?? 100,
    warn: card.options?.warn,
    unit: card.options?.unit
  });

  bodyEl.appendChild(svg);
}

/**
 * 將粗體字法（**粗體**）轉換為 DOM 節點並加入容器
 */
function appendFormattedText(parent, str) {
  if (!str) return;
  const parts = str.split(/(\*\*[^*]+?\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      parent.appendChild(strong);
    } else if (part.length > 0) {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

/**
 * 渲染文字卡片（僅支援粗體與清單，不解譯 HTML）
 */
function renderTextCard(card, ctx, { bodyEl }) {
  const content = card.options?.content;
  if (typeof content !== 'string' || !content) {
    return;
  }

  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('- ')) {
      const ul = document.createElement('ul');
      while (i < lines.length && lines[i].startsWith('- ')) {
        const li = document.createElement('li');
        appendFormattedText(li, lines[i].slice(2));
        ul.appendChild(li);
        i++;
      }
      bodyEl.appendChild(ul);
    } else {
      const p = document.createElement('p');
      appendFormattedText(p, line);
      bodyEl.appendChild(p);
      i++;
    }
  }
}

/**
 * 渲染狀態清單卡片
 */
function renderStatusCard(card, ctx, { bodyEl }) {
  const parents = ctx?.parentTasksById || {};
  const taskIds = Array.isArray(card.options?.taskIds)
    ? [...new Set(card.options.taskIds.map(id => parentIdOf(id)))]
    : Object.keys(ctx?.parentTasksById || {});

  const list = document.createElement('div');
  list.className = 'status-list';

  for (const id of taskIds) {
    const task = parents[id] || { id, name: id };
    const taskName = task.name || id;
    const healthStatus = ctx?.health?.[id]?.status || '—';
    const nextRun = ctx?.nextRuns?.[id] || '—';
    const missedCount = (ctx?.missed || []).filter(m => m && m.taskId === id).length;

    const item = document.createElement('div');
    item.className = 'status-item';
    item.dataset.taskId = id;

    const nameEl = document.createElement('span');
    nameEl.className = 'status-name';
    nameEl.textContent = taskName;
    item.appendChild(nameEl);

    const stateEl = document.createElement('span');
    stateEl.className = 'status-state';
    stateEl.textContent = healthStatus;
    item.appendChild(stateEl);

    const nextEl = document.createElement('span');
    nextEl.className = 'status-next';
    nextEl.textContent = nextRun;
    item.appendChild(nextEl);

    if (missedCount > 0) {
      const missedEl = document.createElement('span');
      missedEl.className = 'status-missed';
      missedEl.textContent = `錯過 ${missedCount}`;
      item.appendChild(missedEl);
    }

    // 加得進去就要拿得出來
    item.appendChild(makeRemoveHandle(id, Boolean(ctx?.editing)));

    list.appendChild(item);
  }

  bodyEl.appendChild(list);
}

/**
 * 將二維陣列轉為 TSV 字串（以 tab 分隔欄、\n 分隔列，結尾不加換行）
 */
export function buildTsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }
  return rows
    .map(row => (Array.isArray(row) ? row.map(cell => (cell == null ? '' : String(cell))).join('\t') : ''))
    .join('\n');
}

/**
 * 渲染單一卡片 DOM 元素
 */
export function renderCard(card, ctx) {
  if (!card || typeof card !== 'object') {
    const fallback = document.createElement('div');
    fallback.className = 'report-card card-error';
    fallback.textContent = '卡片設定不正確';
    return fallback;
  }

  const shell = createCardShell(card, ctx);

  if (!SUPPORTED_TYPES.has(card.type)) {
    const errorEl = document.createElement('div');
    errorEl.className = 'card-error';
    errorEl.textContent = `不支援的卡片型別：${card.type}`;
    shell.bodyEl.appendChild(errorEl);
    return shell.cardEl;
  }

  switch (card.type) {
    case 'number':
      renderNumberCard(card, ctx, shell);
      break;
    case 'line':
    case 'bar':
      renderChartCard(card, ctx, shell);
      break;
    case 'table':
      renderTableCard(card, ctx, shell);
      break;
    case 'gauge':
      renderGaugeCard(card, ctx, shell);
      break;
    case 'text':
      renderTextCard(card, ctx, shell);
      break;
    case 'status':
      renderStatusCard(card, ctx, shell);
      break;
  }

  return shell.cardEl;
}
