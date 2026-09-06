# 任務:實作 detectKind——判斷一個 DOM 元素是數值、文字、表格、清單還是假表格

## 背景

AutoFetcher 是 Chrome 擴充功能(原生 JS ES module)。使用者在網頁上按右鍵後會進入
「選取模式」,滑鼠移到哪裡就高亮哪裡,右下角面板要即時說明「這是什麼」——
是一個數值、一段文字,還是一個可以做聚合的表格/清單。

同一份判定之後也會被 §7 區塊聚合(把表格某一欄加總)使用,所以要寫成純函式,
不碰 `chrome.*`、不碰 `window`,只吃傳進來的 DOM 元素。

`src/shared/extract.js` 已經有 `parseNumber(text)`,會處理千分位、貨幣符號、
百分號、全形數字、會計負數(小括號代表負)。數值判定**必須複用它**,不要自己再寫一份。

## 要做的事

在 `src/shared/block-detect.js` 匯出:

```js
export function detectKind(el)
```

回傳 `{ kind, value, rows, cols, headers }`,`kind` 是下列其中之一:

- `'table'`:元素是 `<table>`,或有 `role="grid"` / `role="table"`。
  - 若元素內還有更內層的 `<table>`,**描述最內層那一個**(巢狀表格常見於排版用表格)。
  - `rows` = 總列數(含表頭列),`cols` = 最寬那一列的格子數。
  - `headers` = 表頭文字陣列(`<th>`,或 `role="columnheader"`);沒有表頭時是**空陣列**,不是 undefined。
- `'list'`:元素是 `<ul>` 或 `<ol>`。`rows` = `<li>` 數量。
- `'grid'`:CSS 假表格。判定啟發式:元素底下的子元素**至少 3 個**,而且**每個子元素的
  子元素數量都相同且至少 2 個**。`rows` = 子元素數量,`cols` = 每個子元素的子元素數量。
  子元素數量只有 2 個時不算 grid(太容易誤判)。
- `'number'`:上面都不是,而且 `parseNumber(el.textContent)` 不是 `null`。`value` = 解析出的數字。
- `'text'`:其餘全部。`value` 為 `null`。

其他欄位在不適用時可以是 `undefined`(例如 `text` 沒有 rows/cols)。

`el` 傳 `null` 或 `undefined` 時不得拋例外,回傳 `{ kind: 'text', value: null }`。

判定順序很重要:先看是不是 table(含 ARIA 與巢狀)、再 list、再 grid,最後才用文字內容判 number/text。

## 不要做的事

- 不要修改 `src/shared/extract.js` 或任何其他既有檔案。
- 不要處理 Canvas / SVG 圖表(明確不在範圍)。
- 不要處理 `rowspan` / `colspan` 的展開(那是之後另一段的工作,這裡只要數格子)。
- 不要新增任何其他匯出的函式(內部輔助函式不匯出則不限)。

## 限制

- 只能修改:`src/shared/block-detect.js`
- 原生 JS ES module,不要 import 除 `./extract.js` 以外的任何東西,不要用任何套件。
- 純函式:不得出現 `chrome.`、`window.`、`document.`(只能用傳進來的 `el` 與它的屬性/方法)。
- 不要新增可選參數或 `= null` 的相依。
- 嚴格禁止過度設計:不要加設定項、不要加快取、不要加額外的 kind。
- 註解用繁體中文全形標點,每個函式上方一行說明,與專案現有風格一致。
- 元素可能沒有某些 DOM API(例如 `querySelectorAll`),存取前要防呆。
