# AF-14 第 14 輪規劃：純數值列標題不當錨點＋試抓失敗匯出診斷包

> 狀態：實作完成，待體檢與收尾
> 基準：dev@7e47e1e（1874 綠，v0.12.0）
> 來源：使用者實站回報——目標在 iframe 內、frame 已正確定位，「先試抓看看」仍回
> 「標題「4318」找不到；若這張表每天新增一列，請到任務設定改用位置定位」。

## 根因（已核對）

- 錯誤訊息只會由 `shared/extract.js` 的 `headerGoneMessage` 產生，代表 `locateFrame` 已命中、
  content script 已解析到那張表，失敗點是**列定位**，與 iframe 無關。
- 目標是一張**單列、無表頭**的巢狀表（`table.type2`：`<tr><td>4269</td><td>38605</td></tr>`）。
  `shared/table.js` 的 `rowHeader()` 取「該列第一個非空格子」當列標題，選取當下第一格是 4318，
  就被存成 `cell.row.header: "4318"`；今天第一格變成 4269，`locateByHeader` 要求完全相同 → `not_found`。
- SPEC §7 的「第一格會變動時硬性失敗是刻意的」防的是每天插一列的表，但沒區分
  「第一格是標籤」與「第一格本身就是資料」；後者沒有任何東西能當錨點。
- 同一判準還有三個副作用：預設任務名稱變成「4318」（命名鏈是欄標題→列標題→nameHint，欄標題為空）；
  編輯任務回選（preselect）用 `rowHeader(row) === rHeader` 找列會勾不回去；
  回選重存時 `actualRowHeader = rHeader || rowHeader(targetRow)` 又把當下第一格塞回 header。
- 試抓失敗幾乎沒有診斷訊號：`EXTRACT` 失敗只回 `error/message`，`snippet` 只在 locator 解析失敗才有；
  `diag` 環形緩衝不記 dryRun。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 | 執行者 |
|---|---|---|---|---|
| A | 純數值列標題不當錨點（判準一份、四個消費端、舊任務零遷移、失敗訊息帶現況、選取端當場提示） | 中 | 無 | agy |
| B | 試抓失敗匯出診斷包（content → fetcher → Picker 按鈕 → `export.download`） | 中 | A 的訊息改好後一起驗 | agy |
| C | 文件、版本 0.13.0、BACKLOG、煙霧案 | 小 | A、B | Claude |

建議順序 A → B → C。整輪委派模型只用 agy；測試由 Claude 先寫、含突變。
subagent（核對／終檢）依 plan-before-dev 分層：`scan-low`（opus + low）。

## 已定案的待決（2026-09-10）

1. 作業 A 走「**嚴格純數值**列標題不當錨點 ＋ 選取端當場提示 ＋ 失敗訊息帶現況列標題」。
   不採「標題找不到但表只有一列就退回 index 標 fallback」：`fallback` 屬警示狀態會每天黃燈，且多列數值表照樣壞。
2. 排程失敗的完整診斷包（`lastDebug:<taskId>`）本輪不做，進 BACKLOG；
   排程紀錄的 `error` 因作業 A 的訊息改在 `extract.js` 一處而同樣受惠。
3. 純數值判定**不對年份（19xx／20xx）開例外**：多一條例外就多一種猜錯，靠選取端提示讓使用者自己改。
4. 診斷包為 JSON 單檔；表格 HTML 片段上限 4000 字（暫定），截斷時標 `truncated: true`，不靜默截。

---

## 批次 A：純數值列標題不當錨點

### 現況與核對結果

- `src/shared/table.js:372` `rowHeader(row)`：第一個非空格子文字；同時被拿來顯示 `label`（位置定位的來源列）與當錨點。
- `src/shared/extract.js:166` `locateByHeader`：`header` 非空就必須完全相同，否則 `not_found`（`headerGoneMessage`）。
- 存 header／headerText 的呼叫點（皆在 `src/content/picker-mode.js`）：191、196、203、207、210、1110、1111、1119、1128、1136、1154、1346、1358、1372、1373、1477–1482（preselect 重存）、1489–1519（block preselect）、2000（單格升級整列）。
- 命名鏈：`src/ui/picker/picker.js:909` `singleCellName`（欄標題→列標題）、`src/background/main.js:55` `defaultFieldName`（多值的預設值名）。
- `parseNumber` **不能當判準**：實測 `'2024年度'`→2024、`'No.4318'`→4318、`'A-100'`→-100，這三個都是合法的穩定標題。
- `fallback` 在 `shared/record-status.js` 屬 `WARN_STATUSES`，`fetcher.js:205` 拿它當警示燈。
- 現有測試：`tests/q7_label_records.test.js:76`、`tests/r4_picker_summary.test.js:113` 斷言訊息開頭「標題「…」找不到」——訊息**加尾巴**不會破壞它們（要核對是全等還是包含）。

### 定案

- **判準只有一份**：`shared/table.js` 新增兩個具名匯出（名稱已定死，測試會 import，不得改名）：
  `isAnchorText(text)`（這段文字能不能當定位錨點）與 `anchorHeader(row)`（可當錨點才回文字，否則回 `''`）。
  **純數值**＝去掉千分位逗號與空白後，整段符合「可選負號＋數字＋可選小數」（含 `1,234`、`-5`、`3.5`、`4318`）。
  **反例必須可當錨點**：`2024年度`、`No.4318`、`A-100`、`09/02`、`2026-09-02`、`合計`、`美金`。
  空字串不是錨點。
- `rowHeader()` 本身**不改**（`label` 顯示仍要看到 4269 那種值）；新增 `anchorHeader(row)`：可當錨點才回文字，否則回 `''`。
- **四個消費端全部改走它**：
  1. 選取端寫入 spec 的 `row.header`／`block.headerText`（上列所有呼叫點；欄標題那一側也套同一判準——欄標題是純數值同樣不當錨點）。
  2. preselect 回選與重存（1463 比對、1477 `actualRowHeader`、1507／1519 block）：header 為空時**只用 index**，重存不得再補回純數值的標題。
  3. 擷取端 `locateByHeader`：spec 帶進來的 `header` 若是純數值，視同空字串（**舊任務零遷移**：存了 `"4318"` 的任務不用重存，走 index，狀態 `ok`，不是 `fallback`）。
  4. 命名鏈 `singleCellName` 與 `defaultFieldName`：純數值的列／欄標題不進名稱，退回下一層（`nameHint`／「值 N」）。
- **失敗訊息帶現況**（`headerGoneMessage`）：「標題「X」找不到；目前這張表的列標題是：A、B、C（最多列 5 個，超過加「…共 N 列」）；若這張表每天新增一列，請到任務設定改用位置定位（…）」。
  欄標題找不到時同樣列出目前欄標題。既有測試若是全等比對，改成「以原句開頭」的斷言，**不得放寬成只驗 `not_found`**。
- **選取端當場提示**：Picker 摘要卡（`#summary-target`）在「任一被選格子的列（或欄）標題被判為純數值」時多顯示一句：
  「這一列的第一格是數字（4318），不會拿它當標題，改以第 N 筆位置抓取；若這張表會新增列，請改用列定位。」
  顯示條件、文字都由 `shared/describe.js` 產生（白話描述只有一份）。
  「列定位」下拉本輪**不搬出進階區**（動版面的收益不確定），提示句末尾改為可點的「改用列定位」連結，
  點了展開進階區並把焦點放到 `#row-pos`。
- **整列聚合（`block.axis:'row'`）與整欄同樣受影響**，同一套規則、同一組驗收。
- SPEC §7 改寫：「**文字型**標題找不到維持硬性失敗（刻意）；**純數值**標題不視為標題，改以索引定位，並在選取時明示。」
  原句「第一格會變動時會硬性失敗」保留但加上「（純數值除外）」。

### 改動（給執行端的行為契約，不寫行號）

- A-1 判準與擷取端：`table.js` 判準純函式 ＋ `anchorHeader`；`extract.js` 的 `locateByHeader` 對純數值 header 視同空；`headerGoneMessage` 帶現況列／欄標題。
  **同型遺漏（規劃後補）**：`extractBlockFromTable` 的**欄分支自己複製了一份** `findClosestIndex` ＋ `headerGoneMessage`，
  沒走 `locateByHeader`。A-1 要把它**收斂成呼叫 `locateByHeader`**（`pos` 已由 `extractCrossCell` 在前面處理，行為等價），
  否則整欄聚合會是唯一一個沒套新判準的路徑。
- A-2 選取端：`picker-mode.js` 所有存 header／headerText 的點改走 `anchorHeader`／判準；preselect 回選與重存不補回純數值標題；`ENTER_PICK`／`exitPickMode` 狀態不新增（不留新的跨表殘留）。
- A-3 命名與提示：`singleCellName`、`defaultFieldName` 退回下一層；`describe.js` 新增提示句；Picker 摘要卡顯示與「改用列定位」連結。

### 測試 / 驗收（Claude 先寫，執行端自驗）

- 判準：上列正例／反例逐一斷言；**突變**：把判準改成永遠回 true，反例測試必須紅。
- 擷取端：單列表 `<td>4318</td><td>38605</td>` 存 `row.header:"4318"` 的舊 spec，DOM 改成 4269 後擷取得到 38605、`status: 'ok'`（不是 `fallback`）。
- 既有守門必須維持綠：列標題是「日圓」等文字型、表格前插一列 → 跟著標題走 `fallback`；標題整個不見 → `not_found` 且訊息以原句開頭、並含「目前這張表的列標題是：」與實際標題。
- 選取端：對單列數值表選格 → 送出的 `picks[].cell.row.header === ''`、`index` 正確；preselect 帶 `header:''` 回選 → 勾回同一格且重存後 header 仍為空；**連續選兩張表**不殘留（照 CLAUDE.md 慣例）。
- 命名：欄標題空、列標題純數值 → 任務名稱等於 `nameHint`；多值預設名為「值 N」。
- 提示句：從 `describe.js` 產生端一路斷言到 `#summary-target` 文字；純數值以外的表**不出現**這句。
- 鏈結：`tests/m2_chain.test.js` 補「選取端送出的 header 為空 → 擷取端走 index」一條。
- 訊息：`fetcher.js` 寫進紀錄的 `error` 與 Picker 試抓區顯示的都是新訊息（產生端到畫面）。

---

## 批次 B：試抓失敗匯出診斷包

### 現況與核對結果

- `src/content/main.js:30` `handleExtract`：resolve 失敗回 `snippet`；`extractValue` 失敗只轉發 `{ok:false, error, message}`。
- `src/background/fetcher.js`：dryRun 在 552（正常回傳）、536（`frame_not_found`）、764（例外）三個出口；`preActionTrace` 只在有前置動作時附上。
- `src/background/frames.js:66` `locateFrame` 只回 `{frameId}` 或 `null`，候選清單與命中層級不對外。
- `src/ui/picker/picker.js:2113` `handleTestNow`：失敗顯示 `#errors`、`#test-note`；沒有任何匯出入口。
- `src/shared/export.js:505` `download({filename, content})` 走 `chrome.downloads`＋`saveAs: true`；manifest 已有 `downloads` 權限。
- `shared/diag.js` 是 500 筆環形緩衝，字串型；不適合放結構化大包。

### 定案

- **只做「立即測試」**（dryRun）；排程失敗的完整包進 BACKLOG（見上）。
- **`debug` 不寫 storage、不寫 `diag`、不進紀錄**；只存在於這一次 `TEST_TASK` 的回應與 Picker 的記憶體，使用者按「匯出診斷」才落地。
- 診斷包內容（JSON 單檔，`autofetcher-diag-<任務名或 preview>-<yyyyMMdd-HHmm>.json`）：
  - `version`（manifest）、`at`（ISO）、`tabUrl`（`chrome.tabs.get` 的實際網址，不是任務設定的）
  - `task`：`spec`、`locator`、`frame`、`preActions`（**不含**登入資料；任務物件裡若有 `siteId` 只留 id）
  - `frame`：`candidates`（`listFrames` 的 `{frameId, url}` 清單）、`matchedBy`（`'exact' | 'path' | 'locator' | 'top' | null`）、`frameId`
  - `preActionTrace`（有就帶）
  - `error`：`{ error, message }`
  - `page`（content 端提供，只在擷取失敗時）：`resolvedLayer`、`table`＝`parseTable` 摘要（`source`、`headers`、`rowHeaders`（`rowHeader` 那一份，不是錨點）、`cells` 前 20 列、`rowCount`、`colCount`、`partial`）、
    `html`＝**解析到的那張表**（`innermostTable` 結果；非表格時是目標元素）的 `outerHTML` 前 4000 字、`truncated`
- `locateFrame` 回傳形狀擴充成 `{ frameId, matchedBy, candidates }`（現有呼叫端只讀 `frameId`，不受影響；`null` 失敗時 fetcher 自己補 `candidates`）。
  **`frameId` 仍不得存進任務**（SPEC §3）。
- Picker 試抓區：失敗時在 `#errors` 下方顯示「匯出診斷」按鈕（`btn-secondary`），旁邊一句「內含目標表格的 HTML 片段與頁面網址」；
  成功或尚未測試時 `hidden`。按下走 `export.download`；再次按「立即測試」時清掉上一份。
- 訊息 `debug` 欄位是新的跨模組欄位：content → background（`EXTRACT` 回應）→ Picker（`TEST_TASK` 回應）。

### 改動

- B-1 產生端：`content/main.js` 擷取失敗附 `debug.page`；`frames.js` 回傳擴充；`fetcher.js` 三個 dryRun 出口都組 `debug`（含 `frame_not_found` 與例外出口——例外時 `page` 缺席但 `frame`／`preActionTrace`／`tabUrl` 要在）。
- B-2 消費端：Picker 按鈕、檔名、`download` 接線、清除時機、privacy 一句話。

### 測試 / 驗收

- 產生端：擷取失敗回應含 `debug.page.table.headers/rowHeaders/cells/rowCount`、`html` 長度 ≤ 4000 且 `truncated` 正確（用 4001 字的表驗）；擷取成功**不帶** `debug`。
- `locateFrame`：三層各一案斷言 `matchedBy` 與 `candidates`；失敗回 `null` 時 fetcher 的 `debug.frame.candidates` 仍有清單。
- fetcher 三個 dryRun 出口都帶 `debug`；非 dryRun 路徑**不得**帶 `debug`、紀錄物件無 `debug` 鍵、`diag` 不多任何一筆。
- Picker：失敗 → 按鈕可見且 `download` 被呼叫一次、內容可 `JSON.parse` 且含 `version`／`tabUrl`／`error`；成功 → 按鈕 `hidden`；連按兩次測試不重複產生。
- 鏈結：`tests/m2_chain.test.js` 補 `debug` 從 content 回應到 Picker 匯出內容的一條。
- D13：新增的 `sendMessage` 一律帶 `{frameId}`；D14：正式碼不得出現測試後門。
- **突變**：把 `truncated` 永遠設 false，4001 字案必須紅；把成功路徑也塞 `debug`，「成功不帶」案必須紅。

---

## 批次 C：文件、版本、煙霧（Claude 親做）

- `src/manifest.json` 與 `package.json` 升 **0.13.0**。
- SPEC：§2.1 命名鏈與摘要卡提示句；§3 診斷包內容清單與「不落地、不進 diag」；§7 錨點規則改寫（見批次 A 定案末條）；§4 試抓失敗流程加「匯出診斷」。
- CLAUDE.md「不要做」加一條：**列／欄標題要當錨點必須過 `table.js` 的判準**，不得直接拿 `rowHeader()` 的字串存進 spec。
- BACKLOG 新增：排程失敗保留最新一份診斷包（`lastDebug:<taskId>`）、「列定位」下拉搬出進階區；更新「立即測試以新分頁執行」的觸發條件加註「已有診斷包可先看 `tabUrl` 與 `frame.candidates`」。
- 煙霧 `run_smoke.sh`：補「單列數值表、選取後第一格改值、試抓仍取到第二格」一案（這次的問題是單元層全綠、實站才壞）。
- PLAN 寫「體檢交接」節（全量測試數、與 1874 的差）。

## 明確不做（本輪定案）

- 年份型純數值不開例外（定案 3）。
- 排程失敗的完整診斷包（定案 2，進 BACKLOG）。
- 「標題找不到但只有一列就退回 index 標 fallback」（會每天黃燈）。
- 「列定位」下拉搬出進階區（進 BACKLOG，先用提示句連結代替）。
- `debug` 在成功時也回傳（沒有消費端）。

## 規劃完成後複檢

- 與 SPEC §7 衝突：已明寫本輪推翻「第一格變動一律硬性失敗」的純數值部分，文字型維持。
- 批次 A 與 B 都改 `fetcher.js` 與 `extract.js` 的訊息：A 先改訊息、B 只讀不改，順序 A → B 無衝突。
- 「什麼算一個」：純數值定義列出正例／反例；現況列標題列出上限 5 與「共 N 列」的表示法。
- 破壞性判準：無（不刪不覆蓋既有資料；舊任務零遷移靠擷取端視同空）。
- 單向閘門：無。
- 移除類：無（`rowHeader()` 不移除、`locateFrame` 只擴充回傳）。
- 補問：**`row.header` 存空字串**是既有 spec 已允許的形狀（`locateByHeader` 對空 header 走 index），不需要新欄位；
  若執行端發現某些消費端把空 header 當「沒選」處理，要在執行紀錄回報，不得自行改成存 `null`。
- 複檢完成，除上一條提醒外無新增事項。

## 執行紀錄

委派模型：agy `claude-opus-4-6-thinking`（Gemini 組週額度為 0，使用者授權改用 Claude 組；
A-2 尾聲該組也用罄，A-3 之後由 Claude 自己實作）。

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A-1 | agy opus-4.6 | 通過 | u1 16 綠、全套 1890 綠、突變 2 發皆紅 | 無。判準與訊息都照契約；欄分支的複製版已收斂 |
| A-2 | agy opus-4.6 | 通過 | u2 7 綠、選取模式既有 84 綠、全套 1897 綠 | agy 在最後撞到額度上限，未跑完全套；由 Claude 補跑。**驗收時發現退化**：面板已選 chip 讀同一個 header，變成顯示「儲存格」——併入 A-3 修 |
| A-3 | Claude | 通過 | u3 9 綠、全套 1906 綠、突變 4 發皆紅 | 規劃外新增 `rawHeader`（顯示用原文）與 chip 顯示修正；`buildSpec` 濾掉它並有測試把關 |
| B | Claude | 通過 | u4 10 綠、全套 1916 綠、突變 4 發皆紅 | **`locateFrame` 失敗回傳由 `null` 改為物件**，四個呼叫端一起改判定；`o2_frames` 的形狀斷言跟著更新（守門未放鬆）。**修掉一個真 bug**：例外出口的 `tabId` 不在作用域，原本就會在前置動作失敗時炸掉（三個既有測試因此紅，已修） |
| C | Claude | 完成 | 版本 0.13.0 兩處同步、SPEC §3/§7、BACKLOG 三項、CLAUDE.md 兩條、煙霧兩案 | 煙霧新案：純數值標題的舊任務要抓得到、擷取失敗要附得出現況 |

### 過程中發現、規劃時沒寫到的事

1. **`extractBlockFromTable` 的欄分支自己複製了一份定位邏輯**（規劃後、委派前補進 A-1）。
2. **`rawHeader` 這個顯示用欄位是必要的**：A-2 之後 header 變成空字串，面板 chip 與摘要卡就沒有東西可顯示。
   同時它**不得進規格**——這正是本輪要修的問題的來源形狀，已用測試把關。
3. **`locateFrame` 的 `null` 判定散在四處**：擴充回傳形狀時漏改任何一處，失敗都會被當成成功。
4. **`tabId` 作用域**是既有 bug，不是本輪造成，但被本輪的診斷包呼叫路徑照出來。
5. **測試環境的接線盲區**：`chrome-mock` 沒有 `runtime.id`，`picker.js` 模組層級的事件接線在測試裡不會執行，
   等於所有按鈕的接線都沒有測試涵蓋。本輪用一條讀原始碼的斷言擋住匯出鈕這一個，
   其餘按鈕仍是盲區（可考慮下輪讓 mock 帶 `runtime.id`，但那會讓既有測試開始執行接線，風險要評估）。

## 體檢交接

- **全量測試**：`npm test` → **1916 綠 / 0 紅**（基準 dev@7e47e1e 是 1874 綠，本輪 +42）。
- **真實瀏覽器**：`./run_smoke.sh` **Chrome 與 Edge 全過**，新增兩案（純數值標題舊任務取到 38605、擷取失敗附得出診斷現況）皆通過。
- 版本 0.13.0（`src/manifest.json` 與 `package.json` 同步）。
- 分支 `feature/AF-14`，commit：A-1 `6e516f7`、A-2 `208ab65`、A-3 `0fc34a6`、B `ea2f182`、C 待提交。
- 尚未做：換模型體檢（兩份獨立終檢）、併回 dev。
