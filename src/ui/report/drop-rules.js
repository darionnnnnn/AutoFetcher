// AutoFetcher 報表卡片投放規則純函式模組
// 負責計算將任務拖放至儀表板卡片後的變更 patch（無 DOM、無相依）

// 折線圖與長條圖的調色盤上限
export const MAX_CHART_SERIES = 8;

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
function applyChartDrop(card, taskId) {
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
      return applyChartDrop(card, taskId);
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

// 依任務模式決定拖放至空白格時建立的卡片型別
export function cardTypeForTask(task) {
  if (task && task.mode === 'text') {
    return 'table';
  }
  return 'number';
}
