import { parseNumber } from './extract.js';

// AutoFetcher 區塊聚合（SPEC §7）：把一欄或一列的文字聚合成一個數值
export function aggregateCells(values, aggregate = 'sum') {
  const parsedNumbers = [];
  let used = 0;
  let skipped = 0;

  // 解析所有字串元素
  for (const val of values) {
    const num = parseNumber(val);
    if (num !== null) {
      parsedNumbers.push(num);
      used++;
    } else {
      skipped++;
    }
  }

  // 如果沒有任何有效的數字，或聚合方式不合法，回傳 null
  const validAggregates = ['max', 'min', 'avg', 'sum', 'count'];
  if (used === 0 || !validAggregates.includes(aggregate)) {
    return { value: null, used, skipped };
  }

  let resultValue;

  // 根據指定的聚合方式計算結果
  switch (aggregate) {
    case 'sum':
      resultValue = parsedNumbers.reduce((acc, curr) => acc + curr, 0);
      break;
    case 'max':
      resultValue = Math.max(...parsedNumbers);
      break;
    case 'min':
      resultValue = Math.min(...parsedNumbers);
      break;
    case 'avg':
      resultValue = parsedNumbers.reduce((acc, curr) => acc + curr, 0) / used;
      break;
    case 'count':
      resultValue = used;
      break;
    default:
      resultValue = null;
  }

  return {
    value: resultValue,
    used,
    skipped
  };
}
