import { isSuccess } from './record-status.js';
import { fieldKeyOf } from './series-index.js';

// AutoFetcher 告警判定（SPEC §10）：純函式，去重與通知由呼叫端負責
export function evaluateAlerts(task, record, prevRecords, displayName) {
  const hits = [];
  if (!task.alerts || !Array.isArray(task.alerts) || task.alerts.length === 0) {
    return { hits };
  }

  const name = displayName || task.name || '';
  const currentSuccess = isSuccess(record);

  for (const alert of task.alerts) {
    if (!alert.enabled) continue;

    // 指定欄位時只對該欄位評估
    if (alert.field && (record.field || fieldKeyOf(record.taskId || '')) !== alert.field) {
      continue;
    }

    const { id, type, value } = alert;

    if (type === 'failStreak') {
      // failStreak 只在 record 不成功時可能命中
      if (currentSuccess) continue;

      // 從這一筆往回數連續失敗幾次（這一筆已確定不成功，所以從 1 起算）
      let streak = 1;
      for (let i = prevRecords.length - 1; i >= 0; i--) {
        if (isSuccess(prevRecords[i])) break;
        streak++;
      }

      if (streak >= value) {
        hits.push({
          alertId: id,
          type: type,
          message: `「${name}」告警：已連續失敗 ${streak} 次（門檻 ${value} 次）`
        });
      }
      continue;
    }

    // gt, lt, eq, deltaPct 只在 record 成功時評估
    if (!currentSuccess) continue;

    const currentValue = record.value;

    if (type === 'gt') {
      if (currentValue > value) {
        hits.push({
          alertId: id,
          type: type,
          message: `「${name}」告警：值 ${currentValue} 大於 ${value}`
        });
      }
    } else if (type === 'lt') {
      if (currentValue < value) {
        hits.push({
          alertId: id,
          type: type,
          message: `「${name}」告警：值 ${currentValue} 小於 ${value}`
        });
      }
    } else if (type === 'eq') {
      let isMatch = false;
      if (task.mode === 'text') {
        isMatch = String(currentValue) === String(value);
      } else {
        // 容忍浮點誤差：門檻隨數量級放大，否則大數只剩精確比較
        const scale = Math.max(1, Math.abs(currentValue), Math.abs(value));
        isMatch = Math.abs(currentValue - value) < Number.EPSILON * scale * 4;
      }

      if (isMatch) {
        hits.push({
          alertId: id,
          type: type,
          message: `「${name}」告警：值 ${currentValue} 等於 ${value}`
        });
      }
    } else if (type === 'deltaPct') {
      // 尋找最近一筆成功紀錄
      let prevSuccessRecord = null;
      for (let i = prevRecords.length - 1; i >= 0; i--) {
        if (isSuccess(prevRecords[i])) {
          prevSuccessRecord = prevRecords[i];
          break;
        }
      }

      if (prevSuccessRecord && prevSuccessRecord.value !== 0) {
        // 分母取絕對值：前一筆可能是負數（parseNumber 支援會計負數的括號寫法）
        const diff = Math.abs(currentValue - prevSuccessRecord.value);
        const pct = (diff / Math.abs(prevSuccessRecord.value)) * 100;
        if (pct >= value) {
          hits.push({
            alertId: id,
            type: type,
            message: `「${name}」告警：變動幅度 ${pct.toFixed(2)}% 超過門檻 ${value}%`
          });
        }
      }
    }
  }

  return { hits };
}
