# AF-15 第 15 輪規劃：巢狀結構的格內子路徑（inner）

> 狀態：規劃中（2026-09-14 定案；同日四角度複檢後改版 v2，等使用者確認後開分支）
> 基準：dev@c5303b3（1936 綠，v0.13.0）
> 來源：使用者回饋——監控頁「外層表每一列的某一格各包一張小表」時，無法選到「外層每一列 × 小表裡同一位置」這個整欄
> 實作方式：agy（每階段一份規格檔；Claude 先寫測試、每段獨立重驗、突變測試）

## 根因（已核對）

選取的最小粒度是「目標表的一格」。巢狀時只有兩個目標可選：

| 目標 | 現況 | 為什麼不對 |
|---|---|---|
| 內層小表（`upgradeTarget` 預設） | 1 列 × 2 欄，「整欄」只有 1 格 | 每一列各一張小表、彼此獨立，聚不到外層每一列 |
| 外層表（按 `↑`） | 那一欄的每一格是整張小表，文字串接成 `401MAX:426`（探針實測） | 抓到的是碰巧排在最前面的數字，面板只給「這一格內含表格」警語 |

使用者要的第三種單位「外層每一列 × 格內同一位置」在 `spec.cell` / `spec.block`（SPEC §7）裡不存在；
選取端 `resolveCell` 往上走到「屬於目標表的格子」就停，子格資訊被丟掉。

複檢時再核對到三件事，都改進了下面的定案：

1. **`↑` 到外層表之後，滑鼠一動目標就跳回內層小表**：[picker-mode.js:1585](../src/content/picker-mode.js:1585) 每次 `mousemove` 都重跑 `upgradeTarget`，
   而它的「內外層鎖回同一張表」只在**已經選了值**（`pickedTableEl`）時生效。還沒點任何一格之前按 `↑`，下一次 `mousemove` 就把目標升回內層表、`backStack` 也被清掉。
   原規劃「按 ↑ 再點那一格」在第一次點之前就走不到——這是規劃時該 grep 卻沒 grep 的（教訓：保護「之後」要先問「之前」）。
2. **重選路徑逐欄挑 pick**：[main.js:36](../src/background/main.js:36) `pickSpecOf` 明寫「逐欄挑，不得整包照抄」，`inner` 不列進去就會在重選時被丟掉，而且不會有任何訊號。
3. **`innerLabel` 進規格會重演 AF-14 的 `rawHeader`**：`sameSpec` 是全等比對，純顯示字串只要下次重選算出來不一樣（小表換了欄標題），`key` 就重生、歷史序列斷掉。改為**不進規格**（見 C 批定案）。

順手核對到的既有 bug：**資料列含 `colspan` 時，選取端存 DOM 索引、擷取端用展開後的網格索引**
（探針：`<tr><td colspan=2>ab</td><td>c1</td></tr>` 點 `c1`，選取端存索引 1、表頭 `B`；擷取端網格索引 1 是 `ab`，靜默抓錯格）。
`inner` 要從網格索引找回 DOM 格子，正好需要同一份換算，本輪一併修。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 | 執行者 |
|---|---|---|---|---|
| A | 純函式層：網格索引 ↔ DOM 格子換算、`inner` 路徑的產生與解析、擷取端接 `inner` | 中 | 無 | agy |
| B1 | 選取端核心：明確選定的表的鎖、`resolveCell` 子單位與網格索引、標示、pick 帶 `inner`、`samePick` | 大 | A | agy |
| B2 | 選取端周邊：preselect 回勾、指令句與警語、工具列提示、右鍵與範圍加選、`exitPickMode` 重設 | 中 | B1 | agy |
| C | 命名與描述鏈、Picker 值清單與規格組裝、重選存回、診斷包 | 中 | A、B1 | agy |
| D | 文件、版本、煙霧案 | 小 | A–C | Claude |

建議順序 A → B1 → B2 → C → D。C 只消費 A 的介面與 B1 的 pick 形狀，可與 B2 並行驗收，但 agy 一次只派一段。

## 已定案的待決（2026-09-14）

1. 採用方案 A「格內子路徑 `inner`」；不做解析端展平（方案 B）、不做只限小表列欄的窄版（方案 C）。
2. 子單位：外層格內有巢狀表就取**最內層格子**；沒有巢狀表就取**滑鼠下的元素本身**。子路徑的鍵盤伸縮本輪不做（BACKLOG）。
3. 進入外層模式只靠面板提示句加 `↑`，右鍵選單不加項目。
4. 整欄／整列聚合時，路徑解析不到的列算 `skipped`；全部解析不到才 `not_found`。
5. `colspan` 索引不一致的既有 bug 本輪一併修。
6. 實作用 agy。
7. （複檢改版）`↑`／`↓` 選定的表要**鎖住**，滑鼠在它的內外層之間移動不換目標；規則與已選值的鎖合成同一份判定。
8. （複檢改版）`innerLabel` **不進規格**：只在 `PICKED` 訊息的 pick 頂層帶一次，Picker 拿它當預設名稱；規格裡只有路徑，位置說明由路徑算出「小表第 r 列第 c 格」。

## 批次 A：純函式層（`shared/table.js`、`shared/extract.js`）

### 現況與核對結果

- [table.js:47](../src/shared/table.js:47) `tableOf` / `cellOf` / `rowCellsOf`：DOM 層級的格子判準，唯一一份。
- [table.js:475](../src/shared/table.js:475) `parseHtmlTable`：資料列以 `rowspan`/`colspan` 展開成網格，`cells[r][c]` 是網格索引；**`parseAriaTable` 與 `parseCssGrid` 不展開**（ARIA 的 `aria-colspan` 沒有處理）。
- [picker-mode.js:161](../src/content/picker-mode.js:161) `resolveCell`：`cIdx = cellsInRow.indexOf(cell)`，是 DOM 索引；[picker-mode.js:1038](../src/content/picker-mode.js:1038) `getCellText`、[picker-mode.js:297](../src/content/picker-mode.js:297) `applyPickedMarks` 同樣用 DOM 索引。**兩端不一致**（探針已證實）。
- [extract.js:229](../src/shared/extract.js:229) `extractCellFromTable` 與 [extract.js:303](../src/shared/extract.js:303) `extractBlockFromTable` 只讀 `table.cells` 的文字，**拿不到 DOM 格子**；`dataRows`（列元素）已經傳進來。
- [selector.js:3](../src/shared/selector.js:3) `getTagIndex`（同層同標籤第幾個，從 1 起算）與 `getHierarchy`：專案既有的結構路徑寫法，**未匯出**。
- `parseNumber('MAX:426')` 是 426（探針），小表的文字不需要另外處理。

### 定案

- **`inner` 的形狀**：`[{ tag, index }, …]`，從「外層那一格」的**直接子元素**起算、到子單位為止的路徑；`tag` 小寫、`index` 是同層同標籤第幾個（從 1 起算）。
  空陣列與缺省都視為「沒有 inner」；**形狀不合法**（不是陣列、任一段缺 `tag` 或 `index` 不是 ≥1 的整數）在擷取端視同解析不到 → `not_found` 並說明，**不得靜默退回整格文字**（那正是本輪要消滅的錯值）。
- **同層同標籤計數只有一份**：`selector.js` 的 `getTagIndex` 匯出給 `table.js` 用（或搬進 `table.js` 由 `selector.js` 匯入），不得寫第二份計數。
- **產生與解析各只有一份**，放 `shared/table.js`（名字暫定，執行端可改但要在回報寫明）：
  `innerPathOf(cell, target)`（`target` 不在 `cell` 裡回 `null`；`target === cell` 回 `[]`）、
  `resolveInner(cell, path)`（走不到回 `null`；每一步都要求「同標籤第 index 個」存在；`path` 形狀不合法回 `null`）。
- **網格索引 ↔ DOM 格子的換算只有一份**，放 `shared/table.js`：
  `gridIndexOf(row, cell)`（該列中這個格子展開後的起始欄索引）與 `cellAtGridIndex(row, idx)`（展開後落在 `idx` 的那個 DOM 格子；被 `colspan` 涵蓋就是那一格；沒有回 `null`）。
  **只對 HTML `td`/`th` 展開 `colspan`**；ARIA 列與 CSS 假表格的列一律「網格索引 = DOM 索引」——擷取端的 `parseAriaTable`/`parseCssGrid` 本來就不展開，兩端要一致。
  只看**這一列自己**的 `colspan`，不處理上一列 `rowspan` 佔位（見「明確不做」）。
- **擷取端接 `inner`**（`cell.inner` 與 `block.inner`）：
  - 列、欄的定位規則完全不變（`locateByHeader` / 位置定位 / 純數值標題規則）。
  - 定位到 `(r, c)` 後：有 `inner` 才走 DOM——`dataRows[r]` → `cellAtGridIndex(row, c)` → `resolveInner(cell, inner)` → 那個元素的 `textContent`（去頭尾空白）當 `raw`。沒有 `inner` 維持讀 `table.cells`（零行為變化）。
  - `dataRows` 缺省或長度不足時，有 `inner` 的請求一律 `not_found`。
  - **單格**：路徑解析不到 → `{ ok:false, error:'not_found', message }`，訊息說「這一格裡找不到原本的位置（小表第 r 列第 c 格／內層 span）；目前這一格的文字是：…」（前 40 字，空的就說「是空的」）；解析到但解析不出數字 → `parse_error`（現況同）。
  - **整欄／整列聚合**：對每一格各自解析；解析不到的格**不進 values、計入 `skipped`**；一格都解析不到 → `not_found`（訊息同上並說「N 格都找不到」）。
    `used` 是解析出數字的格數、`skipped` 是「解析不到路徑」加「解析不出數字」的格數。
  - 整欄／整列再帶 `pos`（`extractCrossCell`）同樣帶著 `inner` 走。
  - `label`（位置定位時的列標題）規則不變。

### 改動

1. `shared/table.js` 新增四個匯出純函式；`selector.js` 匯出 `getTagIndex`；不改既有函式的行為。
2. `shared/extract.js`：`extractCellFromTable` / `extractBlockFromTable` / `extractCrossCell` 接 `inner`。
3. 舊規格（沒有 `inner`）的擷取結果**一個位元都不變**：用既有 `c2`/`c5`/`q2`/`u1` 全綠加本檔的 `deepEqual` 守門。

### 測試 / 驗收（Claude 先寫 `tests/v1_inner_extract.test.js`，執行端自驗）

- `innerPathOf` / `resolveInner` 往返：使用者的結構（外層 `td` > `table` > `tbody` > `tr` > `td`×2，第二格內含 `span`；DOM 用 `innerHTML` 建，讓瀏覽器自動補的 `tbody` 進路徑）對最內層格子產生的路徑再解析回同一個元素；`target` 不在格內回 `null`；`target === cell` 回 `[]`；形狀不合法回 `null`。
- `gridIndexOf` / `cellAtGridIndex`：探針那張 `colspan=2` 的表，`c1` 的網格索引是 2；`cellAtGridIndex(row, 1)` 是 `ab` 那一格；越界回 `null`；**ARIA 列帶 `aria-colspan` 時不展開**（索引 = DOM 索引）。
- 擷取：使用者的結構，`cell.inner` 指到小表第 2 格 → `raw` 是 `MAX:426`、`value` 426；`block.inner` 整欄聚合 `max`，第一列那格沒有小表 → `skipped` 1、`used` 1、`value` 426；三列都沒有小表 → `not_found` 且訊息含「找不到」與「3 格」。
- 單格 `inner` 解析不到 → `not_found`，`message` 含那一格現在的文字；`inner` 形狀不合法 → `not_found`（不是整格文字）。
- 守門：沒有 `inner` 的規格對同一張表的結果與改動前逐欄位相等（`deepEqual`）。
- 突變（Claude 做）：把「解析不到就 `not_found`」改成退回 `table.cells` 文字，測試要紅；把 `cellAtGridIndex` 改成 `cells[idx]`，`colspan` 案要紅；把 ARIA 也展開，ARIA 案要紅。

## 批次 B1：選取端核心（`content/picker-mode.js`）

### 現況與核對結果

- [picker-mode.js:100](../src/content/picker-mode.js:100) `upgradeTarget`：滑鼠在格子上就升成該格所屬最內層表；內外層鎖回已選那張只在 `selectedList.length > 0 && pickedTableEl` 時生效；`↑` 帶 `deliberate: true` 跳過鎖。
- [picker-mode.js:1585](../src/content/picker-mode.js:1585) `onMouseMove`：目標變了就 `backStack = []` 並 `setTarget`。**`↑` 之後第一次 `mousemove` 就把目標升回內層表**（複檢發現 1）。
- [picker-mode.js:141](../src/content/picker-mode.js:141) `resolveCell`：從 `target` 往上找到「屬於 `tableEl` 的格子」就停。
- [picker-mode.js:230](../src/content/picker-mode.js:230) `markCells`、[picker-mode.js:297](../src/content/picker-mode.js:297) `applyPickedMarks`：DOM 索引取格子。
- [picker-mode.js:1379](../src/content/picker-mode.js:1379) `samePick` 只比列欄索引；[picker-mode.js:1971](../src/content/picker-mode.js:1971) `pickKey` 同。
- `exitPickMode` 送出後把 `[data-af-picked]` 轉成 `data-af-held`——標記貼在哪個元素上，藍框就留在哪。

### 定案

- **明確選定的表（`deliberateTableEl`）**：`↑`／`↓` 設定的目標若是表格，記為明確選定；`upgradeTarget` 的「內外層鎖回同一張」判定改為
  `anchor = pickedTableEl || deliberateTableEl`，`anchor` 存在且與滑鼠算出的表互為祖先／後代時回 `anchor`。
  解除時機：滑鼠算出的表與 `anchor` **沒有**包含關係（不相干的表）時解除並照現況跟著滑鼠；滑鼠移到非表格區域不解除（與已選值的鎖同：走到工具列途中不能掉）；`Esc`／送出／`exitPickMode` 重設。
  `pickedTableEl` 一旦存在就以它為準（已選的值永遠優先）。`backStack` 在目標沒變時不清，`↓` 因此還走得回內層。
- **目標的升級規則不變**：還沒 `↑` 之前滑鼠停在小表格子上，目標仍是內層小表。
- **子單位**（目標是外層表、滑鼠在外層格的後代上時）：
  - 外層格內**有巢狀表**（`cellWrapsTable`）→ 子單位是 `cellOf(滑鼠元素)`，且它必須在外層格之內、是最內層格子；滑鼠停在外層格自己（padding）或內層表的縫隙上 → 沒有子單位，維持現況（整格）。
  - 外層格內**沒有巢狀表** → 子單位是滑鼠下的元素本身；滑鼠停在外層格自己 → 沒有子單位。
  - 子單位 = 外層格本身時等同沒有 `inner`。
  - 適用於 HTML 表、ARIA 表與 CSS 假表格（格子就是選取端算出的那個格元素）。
- **標示**：有子單位時只框子單位（單格模式）；整欄／整列模式對每一列 `cellAtGridIndex` 後 `resolveInner` 同一條路徑，解析到才框，解析不到的列不框。已選標記（`data-af-picked`）同理貼在子單位上——送出後的 `held` 藍框因此自然留在子單位。
- **pick 形狀**：`cell.inner` / `block.inner`；沒有子單位就不帶這個鍵（不帶空陣列，舊形狀零變化）。**pick 只存路徑，不存元素參照**（SPEC §2「不存元素參照」）；模組狀態可以記目前的子單位元素，但要在 `exitPickMode` 重設。
- **索引改用網格索引**：`resolveCell` 的 `cIdx` 改為 `gridIndexOf(row, cell)`；`markCells`、`getCellText`、`getBlockPreview`、`applyPickedMarks` 取格子一律 `cellAtGridIndex`。這是 `colspan` bug 的修法。
- **`samePick`**：儲存格比列、欄與 `inner`（路徑長度相等且逐段 `tag`/`index` 相等；缺省與空陣列視為相等）；聚合比軸、索引與 `inner`。同一格的「整格」與「格內第 2 格」是兩個不同的值。`pickKey` 帶路徑字串。
- 點一下、`Ctrl` 加選、雙擊、`Enter` 快速路徑、`upgradeLastPickTo`（單格升整欄／整列時把 `inner` 帶到 `block`）、`confirmPick` 的空清單直送路徑，全部帶當下的 `inner`。
- **`preview`**：有 `inner` 的單格取子單位文字；整欄描述「整欄 N 格」的 N 是路徑解析得到的格數。

### 改動

1. 新增 `deliberateTableEl` 狀態與其設定／解除點；`upgradeTarget` 的鎖判定改用合成的 `anchor`。
2. `resolveCell` 回傳多帶 `subEl` 與 `inner`（沒有子單位時兩者缺省）；`cIdx` 改網格索引。
3. `markCells` / `applyPickedMarks` / `getCellText` / `getBlockPreview` / `makeCellPick` / `candidateAt` / `upgradeLastPickTo` / `confirmPick` 接 `inner` 與網格索引。
4. `samePick` / `pickKey` 加 `inner`。
5. `exitPickMode` 重設本批新增的所有模組狀態。

### 測試 / 驗收（Claude 先寫 `tests/v2_inner_pick.test.js`，執行端自驗）

- **鎖**：使用者的結構（外層 3 列：第 1 列該格純文字、第 2、3 列各包 1×2 小表）。進入選取模式、`mousemove` 到第 2 列小表第 2 格 → 目標是內層表；按 `↑` → 目標是外層表；**再 `mousemove` 到同一個格子 → 目標仍是外層表**；`mousemove` 到頁面另一張不相干的表 → 目標換成那張表（鎖解除）；`↓` 回內層表。
- **子單位**：外層表為目標、滑鼠在小表第 2 格 → 只有那個內層 `td` 帶 `data-af-cell`（外層 `td` 不帶）；點一下 → `selectedPicks()[0].cell.inner` 是到小表第 2 格的路徑、`col.index` 是外層的欄索引、pick 裡沒有任何 DOM 節點。
- 切「整欄」→ 第 2、3 列的小表第 2 格帶 `data-af-cell`，第 1 列沒有任何標記；`Enter` 送出 → `PICKED.picks[0].block` 帶 `axis:'col'`、外層欄索引、同一條 `inner`，`preview` 是「整欄 2 格」。
- 同一格的「整格」與「格內第 2 格」可以同時在已選清單；`Ctrl` 點同一個子單位 → 移除。
- 滑鼠停在外層格自己（`td` 的 padding）→ 標整格、pick 沒有 `inner`。
- 沒有巢狀表的外層格（`td > div > span`）：滑鼠在 `span` → 子單位是 `span`、`inner` 是 `[div 1, span 1]`。
- 先點一格再按「整欄」→ `block.inner` 與那一格相同。
- 送出後（`hold`）`data-af-held` 在子單位上，不在外層 `td` 上。
- `colspan` 表：點 `c1` → `col.index` 是 2（網格索引）、`col.header` 是 `C`；擷取端對同一規格抓到 `c1`（**跨端鏈結**）。
- 連續兩次進入選取模式（第一次 `↑` 又選了子單位就 `Esc`）→ 第二次沒有殘留的鎖與 `inner`。
- 守門：`b4`/`q4`/`q6`/`r3`/`s1`/`s2`/`u2`/`p1`/`p3` 全綠（舊形狀零變化）。
- 突變（Claude 做）：拿掉 `deliberateTableEl` 的鎖，「再 `mousemove` 仍是外層表」要紅；`resolveCell` 不回 `inner`，整欄案要紅；`samePick` 不比 `inner`，同格兩值案要紅；`cIdx` 改回 `indexOf`，`colspan` 案要紅。

## 批次 B2：選取端周邊（`content/picker-mode.js`）

### 現況與核對結果

- [picker-mode.js:733](../src/content/picker-mode.js:733) `instructionLine`：面板指令句唯一一份；[picker-mode.js:56](../src/content/picker-mode.js:56) `NESTED_CELL_NOTICE`。
- [picker-mode.js:1428](../src/content/picker-mode.js:1428) `applyPreselect` 沒有 `inner`。
- [picker-mode.js:1625](../src/content/picker-mode.js:1625) `Ctrl+A`、[picker-mode.js:2055](../src/content/picker-mode.js:2055) `addRange`、[picker-mode.js:2113](../src/content/picker-mode.js:2113) 拖曳框選、[picker-mode.js:1320](../src/content/picker-mode.js:1320) 右鍵「每格各一個值」都經 `makeCellPick(r, c)`。
- [picker-mode.js:354](../src/content/picker-mode.js:354) `getPickName`：面板 chip 的名字（列 · 欄）。

### 定案

- **面板指令句**（仍只有一句）：
  - 目標是內層小表、且它在某張外層表的格子裡（`tableOf(內層表.parentElement)` 存在）→ 「這是外層表格裡的小表：要抓外層每一列的這個位置，按 ↑ 切到外層表再點那一格」。
  - 目標是外層表、滑鼠在內含表格的外層格自己上 → 「這一格內含表格，會抓到整串文字；要抓裡面某一格，把滑鼠移到那一格上（只會框那一格）」。
- **工具列提示**：目標是「外層表格子裡的小表」且它只有 1 個資料列時，點「整欄」或右鍵「整欄聚合」→ 照做，但面板加一句
  「這張小表只有 1 列，整欄只有 1 格；要跨外層每一列請按 ↑ 切到外層表」（`toolbarNotice`）。尖銳的使用者第一個會踩的就是「整欄選到 1 格」。
- **範圍類加選帶哪個 `inner`**：`Shift` 矩形範圍、拖曳框選、右鍵「這一欄／這一列每格各一個值」以**錨點那一格的 `inner`**（`Shift` 是最後一個已選格、拖曳是 `mousedown` 那一格、右鍵是滑鼠所在格）套到範圍內每一格，解析不到的格**不建 pick**。
  **`Ctrl+A` 不帶 `inner`**（全選整格；「全選子單位」進 BACKLOG）。
- **面板 chip**（`getPickName`）：有 `inner` 的值在「列 · 欄」後加「 · 」加 `innerLabel(inner)` 的字串（C 批的純函式；B2 先用「格內第 n 格」暫代，C 批換成共用函式——B2 的規格檔要明寫這一行之後會被 C 改掉，不要寫成第二份）。
- **preselect 回勾**：帶 `inner` 的項目，列欄定位照舊（`locateByHeader`），再 `resolveInner`；解析不到就略過那一項並亮既有的「位置已變」提示。
- **`exitPickMode`** 要重設本批新增的所有模組狀態。

### 改動

1. `instructionLine`、`NESTED_CELL_NOTICE`、`toolbarNotice` 依定案改句；`syncNestedNotice` 的重畫條件加「子單位有無改變」。
2. `addRange` / `onMouseUp` / `handleMenuAction` 的 `col-each`/`row-each` 帶錨點 `inner`；`Ctrl+A` 明寫不帶。
3. `applyPreselect` 接 `inner`。
4. `getPickName` 接 `inner`。

### 測試 / 驗收（Claude 先寫 `tests/v3_inner_pick_edges.test.js`，執行端自驗）

- 指令句三種情境各一條斷言（內層小表／外層格自己／外層表有子單位）。
- 內層小表 1 列時點「整欄」→ 已選 1 個、面板含「只有 1 列」與「按 ↑」。
- 右鍵「每格各一個值」（滑鼠在第 2 列小表第 2 格、目標外層表）→ 已選 2 個（第 1 列略過），各帶 `inner`。
- `Shift` 範圍與拖曳框選各一條：範圍內每格帶錨點的 `inner`，解析不到的格不建 pick。
- `Ctrl+A` → 每個 pick 都沒有 `inner`。
- preselect 帶 `inner` → 勾回同一個子單位（`data-af-picked` 在子單位上）；路徑解析不到 → 略過並 `headerChangedNotice`。
- chip 文字含「格內」。
- 突變（Claude 做）：`applyPreselect` 丟掉 `inner` 要紅；`col-each` 不帶 `inner` 要紅。

## 批次 C：命名、描述、Picker、重選、診斷包

### 現況與核對結果

- 命名鏈：[picker.js:914](../src/ui/picker/picker.js:914) `singleCellName`、[picker.js:936](../src/ui/picker/picker.js:936) `defaultPickName`、[picker.js:1469](../src/ui/picker/picker.js:1469) `fieldNameText`、[main.js:70](../src/background/main.js:70) `defaultFieldName`；位置說明 [picker.js:1485](../src/ui/picker/picker.js:1485) `fieldWhereText`；白話句 [describe.js:129](../src/shared/describe.js:129) `describeTarget`。**六處**都是「列 · 欄」的組字。
- [main.js:36](../src/background/main.js:36) `pickSpecOf`：**逐欄挑**，`inner` 不列就丟（複檢發現 2）。
- [picker.js:252](../src/ui/picker/picker.js:252) `buildSpec`：`item.cell = f.cell` 整個物件抄進規格——pick 頂層多帶的鍵不會進去，但 `cell` 裡多帶的會。
- `sameSpec`/`stripPos`（重選時比對是不是同一個值）是全等比對，只比列欄。
- 診斷包 [content/main.js:37](../src/content/main.js:37) `pageDebugOf`：表格摘要沒有 `inner` 相關資訊。
- `settings-io` 匯出版本 1，匯入只驗版本；舊版擴充功能匯入帶 `inner` 的任務會忽略它、抓整格文字。

### 定案

- **`innerLabel` 不進規格**（複檢發現 3）。分工：
  - `shared/describe.js` 匯出純函式 `innerLabel(inner)`：路徑最後一段是 `td`/`th` 且路徑裡有 `tr` → 「小表第 r 列第 c 格」（r 是最後一個 `tr` 的 `index`、c 是最後一段的 `index`）；否則「內層 <tag> n」（例如「內層 span」，n 大於 1 才顯示）。不需要 DOM，六個消費端都能用。
  - `PICKED` 訊息的 pick **頂層**可帶 `innerLabel`（選取端用 DOM 算：小表有錨點欄標題就是「小表 · <欄標題>」，否則同純函式）——它只活在訊息與面板 ctx，`pickSpecOf` 與 `buildSpec` 都**不抄**它。
  - 命名（`singleCellName` / `defaultPickName` / `defaultFieldName`）讀 pick 頂層的 `innerLabel`，沒有才退 `innerLabel(inner)`；說明與白話（`fieldNameText` / `fieldWhereText` / `describeTarget`）只讀規格，一律 `innerLabel(inner)`。六處組字都是「列 · 欄 · 格內標籤」，位置定位與純數值規則不變（標籤本身過 `isAnchorText`，純數值退回純函式結果）。
- `pickSpecOf` 逐欄多挑 `inner`（合法陣列才抄；否則不抄）。
- `buildSpec` 把 `inner` 寫進 `spec.fields[].cell/block` 與單值的 `spec.block`；規格裡**不得**出現 `innerLabel`（測試 grep 守門）。
- `sameSpec` 比 `inner`（`stripPos` 保留 `inner`）。
- 診斷包 `page.table` 多帶 `innerProbe`：規格有 `inner` 時，對每一列解析同一條路徑的結果（`resolved: true|false` 與前 40 字），最多 20 列；沒有 `inner` 不帶這個鍵。
- Picker 的「整欄的值不給選欄定位」等既有規則不變。

### 改動

1. `shared/describe.js`：`innerLabel`、`describeTarget` 接第三段。
2. `ui/picker/picker.js`：五個命名／說明函式接標籤；`sameSpec` 比 `inner`；`buildSpec` 帶 `inner`。
3. `background/main.js`：`pickSpecOf` 挑 `inner`；`defaultFieldName` 接標籤。
4. `content/picker-mode.js`：pick 產生時算頂層 `innerLabel`；`getPickName` 改用共用函式。**白名單只允許這兩處**。
5. `content/main.js`：`pageDebugOf` 帶 `innerProbe`。

### 測試 / 驗收（Claude 先寫 `tests/v4_inner_naming.test.js`，執行端自驗）

- `innerLabel`：小表路徑 → 「小表第 1 列第 2 格」；`[div 1, span 1]` → 「內層 span」；`[span 2]` → 「內層 span 2」。
- 六個消費端對同一個帶 `inner` 的值產出同一段格內標籤（逐一斷言，**掃到的消費端數要等於 6**）。
- 規格裡沒有 `innerLabel`：`buildSpec` 產出與 `pickSpecOf` 產出都 grep 不到這個鍵；PICKED 的 pick 頂層帶它時 Picker 的預設名稱用它。
- `sameSpec`：同列欄、不同 `inner` → 不同值；重選保留 `pos` 的既有案不變。
- **鏈結測試**（補進 `m2_chain` 或本檔）：PICKED（帶 `inner`）→ 面板 ctx → `buildSpec` → `extractValue` 抓到 `MAX:426`；repick 路徑 PICKED → `pickSpecOf` → `task.spec` 仍有 `inner`。
- 診斷包：帶 `inner` 的規格失敗時 `page.table.innerProbe` 有每一列的結果；沒有 `inner` 時沒有這個鍵。
- 守門：`c1`/`c8`/`r1`/`r4`/`u3`/`u4`/`m2` 全綠。
- 突變（Claude 做）：`pickSpecOf` 不挑 `inner` 要紅；`sameSpec` 不比 `inner` 要紅；任一消費端漏接標籤要紅。

## 批次 D：文件、版本、煙霧（Claude 親做）

- SPEC §2：選取模式加「明確選定的表」鎖、「子單位」與三句指令句、工具列提示；§3 診斷包加 `innerProbe`；§7 加 `inner` 形狀、擷取規則（`skipped` 語意、形狀不合法）、網格索引唯一一份與「ARIA／假表格不展開」、`innerLabel` 只在訊息層；記一句「`colspan` 修正會讓舊任務在有 `colspan` 資料列的表上改抓到使用者當初點的那一格」；記一句「舊版擴充功能匯入帶 `inner` 的任務會忽略它」。
- CLAUDE.md 加三條：「格內子路徑的產生／解析、網格索引換算、同層計數各只有一份」「`innerLabel` 只在 `PICKED` 訊息頂層，不進規格（`sameSpec` 是全等比對）」「`↑` 選定的表要鎖，`mousemove` 的升級不得覆寫明確意圖」。
- BACKLOG：子路徑鍵盤伸縮；`gridIndexOf` 不處理上一列 `rowspan` 佔位；右鍵選單「改抓外層每一列」；`Ctrl+A` 帶子單位；小表多列時取每一列（路徑段落萬用）；`aria-colspan` 展開。
- 版本 0.14.0 兩處同步。
- 煙霧案：使用者的結構（fixture 一頁），選外層整欄 `max` → 426；`colspan` 表點 `c1` 抓到 `c1`。

## 明確不做（本輪定案）

- 解析端展平（方案 B）：小表列數不一時展不平、規則對使用者不可見、不涵蓋非表格巢狀。
- 子路徑的鍵盤伸縮（在 `span` 與 `td` 之間切）：定案 2 只取兩種子單位。
- 右鍵選單新增「改抓外層每一列的這個位置」：面板提示句加 `↑` 已足夠，八項選單太擠。
- `gridIndexOf` 處理上一列 `rowspan` 佔位：需要整張表的網格；本輪只處理同一列的 `colspan`。
- 內層小表自己的列、欄定位（依小表表頭漂移）：`inner` 是結構路徑，小表內插欄就會失效；使用者的小表沒有表頭。
- **小表有多列時取每一列**（監控頁一台主機多個告警）：路徑固定到「第 r 列」，標籤會說「小表第 1 列第 2 格」讓使用者知道只取那一列；要取每一列需要路徑段落萬用，進 BACKLOG。
- `Ctrl+A` 帶子單位。
- ARIA `aria-colspan` 展開：擷取端本來就不展開，兩端一致即可。

## 規劃完成後複檢（v2，四角度）

**專案角度**
- `upgradeTarget` 的「滑鼠在格子上就升成最內層表」不變；本輪只加「明確選定的表」鎖與外層表模式下的子單位，SPEC §2「巢狀表格預設取內層」仍成立。鎖的判定與已選值的鎖合成一份，不是第二套。
- AF-14 的「選取端原文照存、定位是擷取端的事」在 `inner` 上同樣成立；AF-14 刪 `rawHeader` 的理由（全等比對）直接推翻了 v1 的 `innerLabel` 進規格，改成訊息層。
- 「唯一一份」清單：路徑產生／解析、網格索引換算、同層計數、標籤純函式各一份；六個命名／說明消費端全部接同一個。
- 批次之間：B1 與 B2、C 都改 `picker-mode.js`，B2 只碰周邊函式、C 只碰 pick 產生處與 `getPickName`（白名單寫死）；A 的函式名暫定，後續規格檔抄 A 回報的實際名字。

**程式角度**
- `↑` 之後 `mousemove` 跳回內層——v1 的流程在第一次點之前就不成立，v2 加鎖並有突變測試。
- `pickSpecOf` 逐欄挑——v1 漏了重選路徑，v2 補進 C 批與鏈結測試。
- ARIA／假表格不展開 `colspan`——v1 的 `gridIndexOf` 沒說清楚會讓 ARIA 表兩端分岔，v2 明寫。
- `inner` 形狀不合法（匯入的設定檔手改過）的分母為零情況——v2 明寫 `not_found`，不靜默退回整格。
- 元素參照不進 pick——v2 明寫，測試斷言 pick 裡沒有 DOM 節點。

**使用者角度（尖銳但有理）**
- 「整欄選到 1 格」——v2 加工具列提示句指路。
- 「小表有三個告警只抓到第一個」——標籤明說「小表第 1 列第 2 格」，多列取值進 BACKLOG 並在「明確不做」留痕。
- 「為什麼要按 ↑，不能直接點」——維持定案 3，理由是面板一句話教學就是全部教學；提示句在內層小表那一刻就出現。
- 「抓不到時要告訴我現在那一格長什麼樣」——`not_found` 訊息帶那一格的文字，診斷包帶每一列的 `innerProbe`。
- 「換了電腦匯入舊版會怎樣」——SPEC 記一句，不做遷移。

**管理者角度**
- B 拆成 B1／B2，各自一份規格檔與測試檔，agy 每段 1～2 個機制。
- 每批可獨立 commit／回滾：A 沒有生產端時是惰性的；B1 沒有 C 時規格仍抓得到值（只是命名退回「第 n 格」）。
- 風險與對策：agy 改測試湊綠（Claude 先寫測試、突變測試、獨立重驗）；agy 額度（開工前先查，用罄換模型並在執行紀錄註明起點）；委派期間 Claude 不動 repo。
- 舊任務零變化由既有套件加 `deepEqual` 守門；唯一刻意改變的是 `colspan` 修正，D 批文件記一句。

複檢完成：發現三條機制問題（已改定案 7、8 與 A 批的 ARIA 條款）、補了十一條契約，無未決事項。

## 執行紀錄

委派模型：agy（起點模型待開工前查額度後填）。

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A | | | | |
| B1 | | | | |
| B2 | | | | |
| C | | | | |
| D | Claude | | | |

### 過程中發現、規劃時沒寫到的事

（實作中補）

## 併回前終檢

（兩份獨立審查：程式碼、文件；結果記這裡）
