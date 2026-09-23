// AutoFetcher 報表卡片投放規則純函式模組
// 負責計算將任務拖放至儀表板卡片後的變更 patch（無 DOM、無相依）

import { buildSeriesIndex, parentIdOf } from '../../shared/series-index.js';

// 折線圖與長條圖的調色盤上限
export const MAX_CHART_SERIES = 8;

const TEXT_CHART_REASON = '文字值不能加入數字圖表';

// 拖曳端傳入同一份 buildSeriesIndex 結果即可依子序列判斷型別。
// 沒有型別資料時維持既有 legacy 行為，讓舊的單值拖曳契約不被改變。
function modeOf(id, opts = {}) {
  return opts.seriesIndex?.byId?.[id]?.mode;
}

function hasModeInfo(opts = {}) {
  return Boolean(opts.seriesIndex?.byId);
}

function numericIds(ids, opts = {}) {
  if (!hasModeInfo(opts)) return ids;
  return ids.filter(id => modeOf(id, opts) !== 'text');
}

function textSkippedNotice(count) {
  return count > 0 ? `已略過 ${count} 個文字值（${TEXT_CHART_REASON}）` : '';
}

// 處理表格卡片的任務投放
function applyTableDrop(card, taskId, opts = {}) {
  const source = card.source || [];
  const existingIndex = source.findIndex(s => s.taskId === taskId);

  if (existingIndex !== -1) {
    const existingItem = source[existingIndex];
    const next = source.filter((_, i) => i !== existingIndex);
    const targetIndex = typeof opts.index === 'number' && !Number.isNaN(opts.index)
      ? Math.max(0, Math.min(opts.index, next.length))
      : next.length;
    next.splice(targetIndex, 0, existingItem);

    const isSameOrder = next.length === source.length &&
      next.every((item, i) => item.taskId === source[i].taskId);
    if (isSameOrder) {
      return null;
    }
    return { source: next };
  }

  const aggregation = card.options?.aggregation || 'raw';
  const next = [...source];
  const targetIndex = typeof opts.index === 'number' && !Number.isNaN(opts.index)
    ? Math.max(0, Math.min(opts.index, next.length))
    : next.length;
  next.splice(targetIndex, 0, { taskId, aggregation });
  return { source: next };
}

// 處理折線圖與長條圖的任務投放
function applyChartDrop(card, taskId, opts = {}) {
  if (hasModeInfo(opts) && modeOf(taskId, opts) === 'text') {
    return { rejected: true, reason: TEXT_CHART_REASON };
  }
  const source = card.source || [];
  if (source.some(s => s.taskId === taskId)) {
    return null;
  }
  if (source.length >= MAX_CHART_SERIES) {
    return {
      rejected: true,
      reason: `圖表最多支援 ${MAX_CHART_SERIES} 個資料數列`
    };
  }
  const aggregation = card.options?.aggregation || 'raw';
  return {
    source: [...source, { taskId, aggregation }]
  };
}

// 處理單一來源卡片（數值、儀表盤）的任務投放
function applySingleSourceDrop(card, taskId, opts = {}) {
  if (hasModeInfo(opts) && modeOf(taskId, opts) === 'text') {
    return { rejected: true, reason: TEXT_CHART_REASON };
  }
  const currentSource = card.source || [];
  if (currentSource.length === 1 && currentSource[0].taskId === taskId) {
    return null;
  }
  const aggregation = card.options?.aggregation || 'raw';
  const patch = {
    source: [{ taskId, aggregation }]
  };
  if (card.title && opts.prevTaskName && card.title === opts.prevTaskName && opts.taskName !== undefined) {
    patch.title = opts.taskName;
  }
  return patch;
}

// 處理狀態卡片的任務投放
function applyStatusDrop(card, taskId) {
  const taskIds = Array.isArray(card.options?.taskIds) ? card.options.taskIds : [];
  if (taskIds.includes(taskId)) {
    return null;
  }
  return {
    options: {
      ...(card.options || {}),
      taskIds: [...taskIds, taskId]
    }
  };
}

// 依據卡片型別計算拖曳投放的更新 patch
export function applyDrop(card, taskId, opts = {}) {
  if (!taskId || typeof taskId !== 'string' || !card || typeof card !== 'object') {
    return null;
  }

  switch (card.type) {
    case 'table':
      return applyTableDrop(card, taskId, opts);
    case 'line':
    case 'bar':
      return applyChartDrop(card, taskId, opts);
    case 'number':
    case 'gauge':
      return applySingleSourceDrop(card, taskId, opts);
    case 'status':
      return applyStatusDrop(card, taskId);
    case 'text':
    default:
      return null;
  }
}

/**
 * 依據卡片型別計算一次投放多個來源的更新 patch
 * @param {Object} card
 * @param {string[]} ids
 * @param {Object} [opts]
 * @returns {Object|null}
 */
export function applyDropMany(card, ids, opts = {}) {
  if (!card || typeof card !== 'object' || !Array.isArray(ids) || ids.length === 0) {
    return null;
  }

  const validIds = ids.filter(id => typeof id === 'string' && id !== '');
  if (validIds.length === 0) {
    return null;
  }

  switch (card.type) {
    case 'table': {
      const currentSource = card.source ? [...card.source] : [];
      const initialOrder = currentSource.map(s => s.taskId);
      let insertIndex = typeof opts.index === 'number' && !Number.isNaN(opts.index)
        ? Math.max(0, Math.min(opts.index, currentSource.length))
        : currentSource.length;

      for (const id of validIds) {
        const existingIndex = currentSource.findIndex(s => s.taskId === id);
        let item;
        if (existingIndex !== -1) {
          item = currentSource[existingIndex];
          currentSource.splice(existingIndex, 1);
          if (existingIndex < insertIndex) {
            insertIndex--;
          }
        } else {
          const aggregation = card.options?.aggregation || 'raw';
          item = { taskId: id, aggregation };
        }
        const targetIndex = Math.max(0, Math.min(insertIndex, currentSource.length));
        currentSource.splice(targetIndex, 0, item);
        insertIndex = targetIndex + 1;
      }

      const isSameOrder = currentSource.length === initialOrder.length &&
        currentSource.every((item, i) => item.taskId === initialOrder[i]);
      if (isSameOrder) {
        return null;
      }
      return { source: currentSource };
    }

    case 'line':
    case 'bar': {
      const chartIds = numericIds(validIds, opts);
      const skippedText = validIds.length - chartIds.length;
      if (chartIds.length === 0) {
        return { rejected: true, reason: TEXT_CHART_REASON };
      }
      const source = card.source || [];
      const existingIds = new Set(source.map(s => s.taskId));
      const newIds = [];
      for (const id of chartIds) {
        if (!existingIds.has(id) && !newIds.includes(id)) {
          newIds.push(id);
        }
      }
      if (newIds.length === 0) {
        return skippedText > 0
          ? { rejected: true, reason: textSkippedNotice(skippedText) }
          : null;
      }
      if (source.length + newIds.length > MAX_CHART_SERIES) {
        return null;
      }
      const aggregation = card.options?.aggregation || 'raw';
      const patch = {
        source: [...source, ...newIds.map(taskId => ({ taskId, aggregation }))]
      };
      if (skippedText > 0) patch.notice = textSkippedNotice(skippedText);
      return patch;
    }

    case 'number':
    case 'gauge': {
      const sourceIds = numericIds(validIds, opts);
      if (sourceIds.length === 0) {
        return { rejected: true, reason: TEXT_CHART_REASON };
      }
      const patch = applyDrop(card, sourceIds[0], opts);
      // 這兩種卡片只有一個值的位置；多丟了幾個要說一聲，否則使用者以為其他值掉了
      if (patch && (validIds.length > 1 || sourceIds.length !== validIds.length)) {
        const label = opts?.nameOf ? opts.nameOf(sourceIds[0]) : sourceIds[0];
        const notices = [];
        if (validIds.length > 1) notices.push(`只用得到一個值，已使用「${label}」`);
        if (sourceIds.length !== validIds.length) notices.push(textSkippedNotice(validIds.length - sourceIds.length));
        patch.notice = notices.join('；');
      }
      return patch;
    }

    case 'status': {
      const currentTaskIds = Array.isArray(card.options?.taskIds) ? [...card.options.taskIds] : [];
      const newParentIds = [];
      for (const id of validIds) {
        const pid = parentIdOf(id);
        if (pid && !currentTaskIds.includes(pid) && !newParentIds.includes(pid)) {
          newParentIds.push(pid);
        }
      }
      if (newParentIds.length === 0) {
        return null;
      }
      return {
        options: {
          ...(card.options || {}),
          taskIds: [...currentTaskIds, ...newParentIds]
        }
      };
    }

    case 'text':
    default:
      return null;
  }
}

// 依任務模式決定拖放至空白格時建立的卡片型別
export function cardTypeForTask(task) {
  if (!task) {
    return 'number';
  }
  if (task.mode === 'multi' || task.spec?.mode === 'multi') {
    const index = buildSeriesIndex([task]);
    const children = index.childrenOf[task.id] || [];
    if (children.some(id => index.byId[id]?.mode === 'number' || index.byId[id]?.mode === 'block')) {
      return 'number';
    }
    return 'table';
  }
  if (Array.isArray(task.fields) && task.fields.length > 0) {
    return 'table';
  }
  if (task.mode === 'text') {
    return 'table';
  }
  return 'number';
}
