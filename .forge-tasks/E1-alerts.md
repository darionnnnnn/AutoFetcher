# 任務:實作 evaluateAlerts——判斷一筆抓取紀錄有沒有觸發使用者設定的告警

## 背景

AutoFetcher 是 Chrome 擴充功能(原生 JS ES module)。使用者可以對每個任務設定告警條件,
例如「值超過 1000 通知我」「跟上次比漲跌超過 20% 通知我」「連續失敗 3 次通知我」。

這個檔案只做**判定**,是純函式:不碰 `chrome.*`、不發通知、不寫任何東西。
「同一條件 60 分鐘內只通知一次」的去重是呼叫端(background/fetcher.js)的事,不要在這裡做。

`src/shared/record-status.js` 匯出 `isSuccess(record)`,認定 `ok` / `fallback` / `late`
三種狀態算成功。**判斷成功與否一律用它**,不要自己比對字串。

## 要做的事

在 `src/shared/alerts.js` 匯出:

```js
export function evaluateAlerts(task, record, prevRecords)
```

- `task.alerts` 是設定陣列,每個元素 `{ id, type, value, enabled }`;
  沒有 `alerts` 或是空陣列時回 `{ hits: [] }`。
- `record` 是這次剛抓到的紀錄(可能成功也可能失敗)。
- `prevRecords` 是這個任務**先前**的紀錄陣列,由舊到新排序,不含 `record` 本身。

回傳 `{ hits }`,`hits` 是命中的條件陣列,每個元素 `{ alertId, type, message }`,
順序照 `task.alerts` 的順序。`enabled === false` 的條件直接略過。

五種 `type`:

| type | 命中條件 |
|---|---|
| `gt` | 這次的值 **大於** `value`(等於不算) |
| `lt` | 這次的值 **小於** `value`(等於不算) |
| `eq` | 這次的值等於 `value`。數值要容忍浮點誤差(例如 `0.1 + 0.2` 必須算等於 `0.3`);`task.mode === 'text'` 時改比字串 |
| `deltaPct` | 與**最近一筆成功紀錄**的值相比,漲或跌的百分比 **大於等於** `value`(漲跌都要算,取絕對值) |
| `failStreak` | 從這一筆往回數,**連續非成功**的紀錄數(含這一筆)**大於等於** `value` |

規則:

- `gt`/`lt`/`eq`/`deltaPct` 只在 `record` **成功**時評估;失敗的紀錄沒有值可以比,一律不命中。
- `failStreak` 只在 `record` **不成功**時可能命中;成功的紀錄一定不命中。
- `deltaPct` 找不到前一筆成功紀錄時不命中(不得拋例外);前一筆的值是 `0` 時也不命中
  (除以 0 沒有意義)。
- `message` 是給人看的一句話,**必須包含實際值與設定的門檻**,例如
  `「電費」告警:值 1234 超過 1000`。文案自己擬,繁體中文。
- **不得改動傳進來的 `task`、`record`、`prevRecords`**(純函式,不能有副作用)。

## 不要做的事

- 不要做 60 分鐘去重(呼叫端負責)。
- 不要發通知、不要寫 storage、不要 import `chrome` 相關的任何東西。
- 不要修改任何其他既有檔案。
- 不要新增其他匯出的函式(內部輔助函式不匯出則不限)。

## 限制

- 只能修改:`src/shared/alerts.js`
- 原生 JS ES module,只能 import `./record-status.js`,不要用任何套件。
- 不要新增可選參數或 `= null` 的相依。
- 嚴格禁止過度設計:不要加設定項、不要加新的 type、不要加國際化層。
- 註解用繁體中文全形標點,每個函式上方一行說明。
