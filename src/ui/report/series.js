import { isSuccess } from '../../shared/record-status.js';

/**
 * 將 YYYY-MM-DD 加上指定天數（以 UTC 計算，避免本機時區影響）
 */
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 產生從 from 至 to 的連續日期陣列（含端點）
 */
function getDaysInRange(from, to) {
  const days = [];
  let curr = from;
  while (curr <= to) {
    days.push(curr);
    curr = shiftDate(curr, 1);
  }
  return days;
}

/**
 * 對序列點進行百分比正規化（以首個非 null 點為 100）
 */
function applyNormalization(points, normalize) {
  if (normalize !== 'percentFromFirst') {
    return points;
  }
  let base = null;
  for (const pt of points) {
    if (pt.v !== null) {
      base = pt.v;
      break;
    }
  }
  if (base === null || base === 0) {
    return points;
  }
  return points.map(pt => ({
    t: pt.t,
    v: pt.v === null ? null : (pt.v / base) * 100
  }));
}

/**
 * 將抓取紀錄轉換為時間序列
 */
export function buildSeries(records, source, options = {}) {
  if (!Array.isArray(source) || source.length === 0) {
    return [];
  }

  const from = options.from;
  const to = options.to;
  const globalAgg = options.aggregation || 'raw';
  const normalize = options.normalize;

  return source.map(srcItem => {
    const taskId = srcItem.taskId;
    const agg = (srcItem.aggregation && srcItem.aggregation !== 'raw') ? srcItem.aggregation : (globalAgg || srcItem.aggregation || 'raw');

    // 篩選該任務且在日期範圍內的紀錄
    const matched = (records || []).filter(r => {
      if (!r || r.taskId !== taskId) return false;
      const dateStr = r.slot ? r.slot.slice(0, 10) : r.date;
      if (!dateStr) return false;
      if (from && dateStr < from) return false;
      if (to && dateStr > to) return false;
      return true;
    });

    let points = [];

    if (agg === 'raw') {
      const sorted = [...matched].sort((a, b) => (a.slot || '').localeCompare(b.slot || ''));
      points = sorted.map(r => ({
        t: r.slot,
        v: isSuccess(r) && typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null
      }));
    } else {
      // 每日聚合模式
      const days = (from && to) ? getDaysInRange(from, to) : [];
      const recordsByDay = new Map();
      for (const r of matched) {
        const d = r.slot ? r.slot.slice(0, 10) : r.date;
        if (!recordsByDay.has(d)) {
          recordsByDay.set(d, []);
        }
        recordsByDay.get(d).push(r);
      }

      points = days.map(day => {
        const dayRecs = recordsByDay.get(day) || [];
        const valids = dayRecs.filter(r => isSuccess(r) && typeof r.value === 'number' && Number.isFinite(r.value));

        if (valids.length === 0) {
          return { t: day, v: null };
        }

        let v = null;
        switch (agg) {
          case 'dailyLast': {
            const sorted = [...valids].sort((a, b) => (a.slot || '').localeCompare(b.slot || ''));
            v = sorted[sorted.length - 1].value;
            break;
          }
          case 'dailyMax':
            v = Math.max(...valids.map(r => r.value));
            break;
          case 'dailyMin':
            v = Math.min(...valids.map(r => r.value));
            break;
          case 'dailySum':
            v = valids.reduce((sum, r) => sum + r.value, 0);
            break;
          case 'dailyAvg':
            v = valids.reduce((sum, r) => sum + r.value, 0) / valids.length;
            break;
          default:
            v = null;
        }

        return { t: day, v };
      });
    }

    points = applyNormalization(points, normalize);

    return {
      taskId,
      points
    };
  });
}

/**
 * 解析查詢週期轉換為起訖日期
 */
export function resolvePeriod(period, rangeFrom, rangeTo, today) {
  const isNum = (typeof period === 'number' && Number.isFinite(period)) ||
    (typeof period === 'string' && /^\d+$/.test(period.trim()) && Number(period) > 0);
  const n = isNum ? Number(period) : NaN;

  if (Number.isFinite(n) && n > 0 && today) {
    return {
      from: shiftDate(today, -(n - 1)),
      to: today
    };
  }

  return {
    from: rangeFrom,
    to: rangeTo
  };
}

/**
 * 取得任務最新紀錄、前一筆與前一日最後一筆成功紀錄
 */
export function latest(records, taskId, today) {
  const matched = (records || []).filter(r => r && r.taskId === taskId);
  if (matched.length === 0) {
    return { current: null, prev: null, prevDay: null };
  }

  const sorted = [...matched].sort((a, b) => (a.slot || '').localeCompare(b.slot || ''));
  const current = sorted[sorted.length - 1];
  const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

  const currentDate = current.slot ? current.slot.slice(0, 10) : current.date;
  const earlierSuccess = sorted.filter(r => {
    const d = r.slot ? r.slot.slice(0, 10) : r.date;
    return d < currentDate && isSuccess(r);
  });
  const prevDay = earlierSuccess.length > 0 ? earlierSuccess[earlierSuccess.length - 1] : null;

  return { current, prev, prevDay };
}

/**
 * 將多任務紀錄依排程槽轉置為表格形狀
 */
export function pivot(records, taskIds, taskOrder) {
  if (!records || records.length === 0 || !taskIds || taskIds.length === 0) {
    return { columns: [], rows: [] };
  }

  const targetIds = new Set(taskIds);
  const columns = [];
  const seenCols = new Set();

  if (Array.isArray(taskOrder)) {
    for (const id of taskOrder) {
      if (targetIds.has(id) && !seenCols.has(id)) {
        seenCols.add(id);
        columns.push(id);
      }
    }
  }
  for (const id of taskIds) {
    if (!seenCols.has(id)) {
      seenCols.add(id);
      columns.push(id);
    }
  }

  if (columns.length === 0) {
    return { columns: [], rows: [] };
  }

  const relevant = records.filter(r => r && targetIds.has(r.taskId) && r.slot);
  if (relevant.length === 0) {
    return { columns, rows: [] };
  }

  const sortedRelevant = [...relevant].sort((a, b) => {
    const cmp = (a.slot || '').localeCompare(b.slot || '');
    if (cmp !== 0) return cmp;
    return (a.capturedAt || '').localeCompare(b.capturedAt || '');
  });

  const slots = Array.from(new Set(sortedRelevant.map(r => r.slot))).sort();
  const slotMap = new Map();

  for (const r of sortedRelevant) {
    if (!slotMap.has(r.slot)) {
      slotMap.set(r.slot, new Map());
    }
    const val = isSuccess(r) ? (r.value ?? null) : null;
    slotMap.get(r.slot).set(r.taskId, val);
  }

  const rows = slots.map(t => {
    const taskVals = slotMap.get(t);
    const values = {};
    for (const col of columns) {
      values[col] = taskVals && taskVals.has(col) ? taskVals.get(col) : null;
    }
    return { t, values };
  });

  return { columns, rows };
}
