# 任務:實作 aggregateCells——把一整欄(或一整列)的文字聚合成一個數值

## 背景

AutoFetcher 是 Chrome 擴充功能(原生 JS ES module)。使用者可以指定「抓這張表格的
某一欄,取加總」。這個檔案負責最後那一步:拿到一串**字串**(表格那一欄的每一格),
把它們解析成數字再聚合。

`src/shared/extract.js` 已經有 `parseNumber(text)`,會處理千分位、貨幣符號(含 NT$)、
百分號、全形數字、會計負數(整串被小括號包住代表負數),解析不出來時回 `null`。
**一定要用它**,不要自己再寫一份解析。

## 要做的事

在 `src/shared/aggregate.js` 匯出:

```js
export function aggregateCells(values, aggregate)
```

- `values`:字串陣列。
- `aggregate`:`'max'` | `'min'` | `'avg'` | `'sum'` | `'count'`,**沒給時預設 `'sum'`**。

回傳 `{ value, used, skipped }`:

- 先用 `parseNumber` 把每個元素解析成數字,解析不出來(`null`)的**跳過**。
- `used` = 成功解析的格子數,`skipped` = 跳過的格子數。
- `value`:
  - `sum` 全部相加;`max` / `min` 取極值;`avg` 平均(總和除以 `used`);
    `count` 就是 `used` 這個數字。
  - **一個都解析不出來時(`used === 0`)`value` 是 `null`**,呼叫端會把它當成解析失敗。
  - `aggregate` 不是上面五種其中之一時,`value` 也是 `null`(不要自己猜)。
- **不得改動傳進來的 `values` 陣列**(例如不要就地 `sort`)。

## 不要做的事

- 不要修改任何其他既有檔案。
- 不要處理表格的解析(那是 `table.js` 的事)。
- 不要新增其他匯出的函式。
- 不要加中位數、標準差之類規格沒要求的聚合方式。

## 限制

- 只能修改:`src/shared/aggregate.js`
- 原生 JS ES module,只能 import `./extract.js`,不要用任何套件。
- 純函式:不得出現 `chrome.`、`window.`、`document.`。
- 不要新增可選參數或 `= null` 的相依(`aggregate` 的預設值除外)。
- 嚴格禁止過度設計:不要加設定項、不要加快取、不要加自訂比較函式。
- 註解用繁體中文全形標點,每個函式上方一行說明。
