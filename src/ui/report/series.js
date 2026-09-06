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
      // 與樞紐表同一套有效時刻,否則同一份資料在折線與表格會有兩種答案
      const dateStr = effectiveTimeOf(r).slice(0, 10) || r.date;
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
        const d = effectiveTimeOf(r).slice(0, 10) || r.date;
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
            const sorted = [...valids].sort((a, b) =>
              (effectiveTimeOf(a) || '').localeCompare(effectiveTimeOf(b) || ''));
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

  // 排序用有效時刻:只看 slot 的話,手動觸發/補抓(沒有 slot)會被當成最舊,
  // 數值卡片就會顯示舊值,而表格顯示新值
  const sorted = [...matched].sort((a, b) =>
    (effectiveTimeOf(a) || '').localeCompare(effectiveTimeOf(b) || ''));
  const current = sorted[sorted.length - 1];
  const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

  const currentDate = effectiveTimeOf(current).slice(0, 10) || current.date;
  const earlierSuccess = sorted.filter(r => {
    const d = effectiveTimeOf(r).slice(0, 10) || r.date;
    return d < currentDate && isSuccess(r);
  });
  const prevDay = earlierSuccess.length > 0 ? earlierSuccess[earlierSuccess.length - 1] : null;

  return { current, prev, prevDay };
}

/**
 * 紀錄用於「新舊比較」的毫秒時間:capturedAt 優先(它才是真正抓到的時刻),
 * 退回有效時刻;兩者都不可解析時視為最舊。
 */
function sortKeyOf(record) {
  if (record?.capturedAt) {
    const ms = Date.parse(record.capturedAt)
    if (Number.isFinite(ms)) return ms
  }
  const eff = effectiveTimeOf(record);
  if (!eff) return -Infinity;
  const ms = Date.parse(eff);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * 紀錄的「有效時刻」(YYYY-MM-DDTHH:mm):slot 優先,沒有就用 capturedAt 截到分鐘。
 * 這是全專案唯一一份;cards.js 的期間篩選與 pivot 的分列都用它,不可各寫一份。
 */
export function effectiveTimeOf(record) {
  if (!record) return '';
  // slot 本來就是本地時間字串,原樣採用
  if (record.slot) {
    const slot = String(record.slot).slice(0, 16);
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot) ? slot : '';
  }
  // capturedAt 是 new Date().toISOString() 的產物(UTC,帶 Z),
  // 直接切字串會和本地時間的 slot 差好幾個時區,必須換算回本地時刻
  if (record.capturedAt) return toLocalMinute(record.capturedAt);
  return '';
}

/**
 * 把時間字串換算成本地時間的 YYYY-MM-DDTHH:mm;無法解析時回空字串。
 * 不帶 Z 也不帶 offset 的字串視為本地時間(舊資料)。
 */
function toLocalMinute(value) {
  const raw = String(value);
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw);
  if (!hasZone) {
    const plain = raw.slice(0, 16);
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(plain) ? plain : '';
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 將多任務紀錄依排程槽轉置為表格形狀
 */
export function pivot(records, taskIds, taskOrderOrOptions) {
  if (!records || records.length === 0 || !taskIds || taskIds.length === 0) {
    return { columns: [], rows: [] };
  }

  let taskOrder = [];
  let bucketMinutes = 0;
  let limit = 0;

  if (Array.isArray(taskOrderOrOptions)) {
    taskOrder = taskOrderOrOptions;
  } else if (taskOrderOrOptions && typeof taskOrderOrOptions === 'object') {
    taskOrder = taskOrderOrOptions.taskOrder || [];
    bucketMinutes = taskOrderOrOptions.bucketMinutes || 0;
    limit = taskOrderOrOptions.limit || 0;
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

  // 1. 找出所有有效紀錄並計算有效時刻
  const processedRecords = [];
  for (const r of records) {
    if (!r || !targetIds.has(r.taskId)) continue;

    const timeStr = effectiveTimeOf(r);
    if (!timeStr) continue;

    let bucketKey = timeStr;

    // 2. 處理 bucketMinutes:時分向下對齊到當日 00:00 起算的倍數,日期原樣保留
    if (Number.isInteger(bucketMinutes) && bucketMinutes > 0) {
      const hh = Number(timeStr.slice(11, 13));
      const mm = Number(timeStr.slice(14, 16));
      const alignedMinutes = Math.floor((hh * 60 + mm) / bucketMinutes) * bucketMinutes;
      const pad = (n) => String(n).padStart(2, '0');
      bucketKey = `${timeStr.slice(0, 10)}T${pad(Math.floor(alignedMinutes / 60))}:${pad(alignedMinutes % 60)}`;
    }

    processedRecords.push({ ...r, bucketKey });
  }

  if (processedRecords.length === 0) {
    return { columns, rows: [] };
  }

  // 3. 分組與計算
  // 使用 Map 儲存每一列的資料
  // key: bucketKey, value: { taskMap: Map<taskId, {value, capturedAt}>, merged: Map<taskId, count> }
  const bucketMap = new Map();

  // 排序 processedRecords 以確保處理順序（雖然主要靠 bucketKey 分組，但為了正確取最新值，需按 capturedAt 排序）
  // 取最新是逐筆比較 sortKeyOf,與處理順序無關,所以這裡不需要先排序
  for (const r of processedRecords) {
    if (!bucketMap.has(r.bucketKey)) {
      bucketMap.set(r.bucketKey, {
        taskMap: new Map(), // taskId -> { value, capturedAt }
        merged: new Map()   // taskId -> count
      });
    }
    const bucket = bucketMap.get(r.bucketKey);

    // 更新 merged 計數
    const currentCount = bucket.merged.get(r.taskId) || 0;
    bucket.merged.set(r.taskId, currentCount + 1);

    // 更新值 (取 capturedAt 最大且成功的)
    const existing = bucket.taskMap.get(r.taskId);
    const rCapturedAt = sortKeyOf(r);
    
    // 判斷是否要覆蓋：如果目前這筆是成功的，且 (目前沒紀錄 或 這筆比舊的更晚)
    // 這裡的「最新」定義是 capturedAt 最大
    if (isSuccess(r)) {
      if (!existing || rCapturedAt > existing.capturedAt) {
        bucket.taskMap.set(r.taskId, {
          value: r.value,
          capturedAt: rCapturedAt
        });
      }
    }
    // 失敗的紀錄只算進 merged,不寫入 taskMap:
    // 該任務在這一桶一筆成功都沒有時,下面就會取到 null
  }

  // 4. 產生 Rows
  // 取得所有出現過的 bucketKey 並排序 (由舊到新)
  const sortedBucketKeys = Array.from(bucketMap.keys()).sort();

  let rows = sortedBucketKeys.map(t => {
    const bucket = bucketMap.get(t);
    const values = {};
    for (const col of columns) {
      const taskData = bucket.taskMap.get(col);
      values[col] = taskData ? (taskData.value ?? null) : null;
    }
    
    const merged = {};
    for (const [taskId, count] of bucket.merged.entries()) {
      merged[taskId] = count;
    }

    return { t, values, merged };
  });

  // 5. 處理 Limit (保留時間最新的 N 列)
  if (Number.isInteger(limit) && limit > 0) {
    if (rows.length > limit) {
      // 找出最後 N 個，但維持原本的順序 (由舊到新)
      // 這裡的「最新」是指 bucketKey 的時間順序
      rows = rows.slice(rows.length - limit);
    }
  }

  return { columns, rows };
}
