# AF-7 第 7 輪規劃：單格選取修正、立即測試改走背景、選取工具列、外觀

> 狀態：四批次完成 + 體檢輪處理完畢，1541 綠（待併 dev）
> 基準：dev@98836d4（1464 綠）
> 來源：使用者回饋三項（iframe 內巢狀表格選錯值、立即測試「Receiving end does not exist」、選取模式要有軸向切換與排除已選項）＋ UX／外觀強化

## 核對結果總表

| # | 主張 | 判定 | 根因（實際核對過） |
|---|---|---|---|
| P1 | 點了 `123`，設定卻顯示 `645586435` | ✅ 三個根因疊加 | (a) `ui/picker/picker.js` 只處理 `picks[0].block`，單格 `picks[0].cell` 落到 `blockInfo` 分支被改寫成「整欄聚合」；(b) `content/picker-mode.js` 的 `confirmPick` 在表格模式下用整張表的 `textContent` 算 `preview`/`previewValue`；(c) `shared/block-detect.js`／`shared/table.js` 對含內層表格的表一律「取第一個內層 table」，使用者提供的監控頁（外層表每列的第 3 格各有一張 1×2 小表）被解析成 1 列 × 2 欄、預覽值 0（jsdom 實測）。 |
| P1' | 同型：單格任務重選 | ✅ | `background/main.js` 的 `preselectOf` 對 `spec.block = { cell }` 回傳 `[{ block: { cell } }]`，形狀錯，`applyPreselect` 靜默略過，重選勾不回原本那一格。 |
| P2 | 立即測試回 `Receiving end does not exist` | ✅ | `handleTestNow` 直接以選取當下的 `tabId`＋`frameId` 對頁面送 `EXTRACT`，不重新注入、不重新定位 frame；目標頁會自動刷新（截圖帶秒級時戳），iframe 一刷新 content script 就不在、`frameId` 也可能換。正式抓取（`fetcher.runTask`）是 `locateFrame` → `injectContent` → `EXTRACT`，兩條路徑不一致。錯誤印兩次是 `#preview` 與 `#errors` 各印一次。 |
| P3 | 右上角軸向切換、排除已選項 | 需設計 | 欄／列只靠 `Tab`（切換會清空已選）、聚合只在右鍵選單；面板 `pointer-events: none` 不可點。已選清單資料結構已支援 cell 與 block 混用（`spec.fields`），切換不必清空。SPEC §2「Tab 清空已選」要一併改寫。 |

## 定案（與使用者討論後）

1. 工具列三段：**單格／整欄（聚合）／整列（聚合）**；「每格各一個值」留在右鍵選單。
2. 切換模式**不清空**已選；只有滑鼠移到另一張表格才清（維持現狀）。
3. 面板列出全部已選項，每項有 ×；另有「移除最後一項」與 `Backspace`；**不按 Shift 點已選的格子＝取消該格**（不送出）。
4. 外觀套用 `ui-ux-pro-max` 產出（Dark Mode OLED／Inter／slate 色板／dense）。色板與 `theme.css` 暗色軌一致，**不改全域變數**，只做元件層；Report 頁不動。
5. 實作：agy 逐段委派；額度用完改由 Claude 自己做（起點註明在執行紀錄）。測試由 Claude 先寫再委派。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 | 順序 |
|---|---|---|---|---|
| A | 單格選取修正（P1 a/b/c + P1'） | 中（shared/table、block-detect、picker-mode、picker.js、background/main） | 無 | 1 |
| B | 立即測試改走背景（P2） | 小（messages、picker.js、background/main、fetcher opts） | 無 | 2 |
| C | 選取工具列＋已選清單（P3） | 中（picker-mode） | A（巢狀表格的格子解析） | 3 |
| D | 外觀：選取 overlay 與設定視窗 | 中（picker-mode 樣式、picker.html、site.html、新 `ui/ui.css`） | C（工具列／面板結構定了才上樣式） | 4 |

---

## 批次 A：單格選取修正

### 現況與核對結果

- `picker.js` `render()`：`picks.length === 1 && picks[0].block` → `currentBlock`；`picks[0].cell` 沒有分支，落到 `blockInfo`（`axis: 'col', index: colIndex`）。`getFormData` 只組 `{axis,index,headerText,aggregate}`。
- `picker-mode.js` `confirmPick`：`preview = currentTargetEl.textContent`（表格模式時是整張表）。
- `block-detect.detectKind`／`table.columnHeaders`／`getDataRows`／`parseHtmlTable`：四處各自寫「有內層 table 就取最內層」。
- `picker-mode.resolveCell`：`cell = target.closest('td…')`，內層小表的 td 不屬於外層表的列 → 回 `null` → 點擊退回「第 0 欄整欄」。
- `background/main.js` `preselectOf`：單格任務回錯形狀（見 P1'）。`applyRepick` 對單格是對的。

### 定案

- **單格是一等公民**：`spec.block = { cell }` 在 Picker 端的顯示、組裝、重選預選都要走得通。
- **巢狀表格的判準（純函式，唯一一份）**：外層表**只有在是「純包裝」時**才往內層鑽——外層表全部格子裡，恰好一格含有內層 table，且其餘格子文字皆為空白。否則外層表就是資料表，格內的內層 table 視為該格的內容（文字扁平化）。四處「取最內層」全部改呼叫這一份判準。
- **格子歸屬看目標表**：滑鼠所在的格子屬於哪一列／欄，以「目標表」為準：從指標元素往上找，第一個「所屬 table 就是目標表」的儲存格才是那一格（內層小表的 td 往上找到外層 td）。
- **`PICKED.preview` 是所選那一個值的文字**，不是容器的文字：單格 → 那一格文字；整欄／整列 → `「表頭」整欄 N 格` 形式的描述（`previewValue` 不算）；多值 → 第一個值的文字加 `（共 N 個值）`；非表格元素維持現狀。

### 改動

1. `shared/table.js`：新增「純包裝表 → 內層表」的判準（匯出，供 block-detect 與 picker-mode 共用），`columnHeaders`／`getDataRows`／`parseHtmlTable` 改走它。
2. `shared/block-detect.js`：`detectKind` 改走同一份判準。
3. `content/picker-mode.js`：`resolveCell` 以目標表為準找格子；`confirmPick` 的 `preview`/`previewValue` 改依 pick 產生。
4. `ui/picker/picker.js`：單格 pick → `currentBlock = { cell }`、`mode = block`、聚合下拉隱藏（一格沒有東西要聚合，與多值全為儲存格時同一規則）、`#block-summary` 顯示「表格，取「列標題 · 欄標題」這一格」；`getFormData`/`buildSpec` 對 `currentBlock.cell` 組 `block: { cell }`；編輯既有單格任務時同樣顯示。
5. `background/main.js`：`preselectOf` 對 `spec.block.cell` 回 `[{ cell }]`。
6. `docs/SPEC.md` §7：補「巢狀表格判準」一段；§2 補「`preview` 是所選值的文字」。

### 測試／驗收（Claude 先寫，紅 → 委派 → 綠 → 突變）

- A-1 `shared/table.js`：以使用者提供的 HTML 為 fixture（存 `tests/fixtures/nested-monitor.html`）：`parseTable(outer)` 資料列數 = IP 列數＋合計列＋fqdn 列（把 `服務主機` 那列算資料列，因為它是 `td` 不是 `th`），第 3 格文字 `42MAX:462`；`rowHeader` 第一筆 = `10.231.1.31`；純包裝表（`<table><tr><td><table>…</table></td></tr></table>`）仍鑽到內層；「一格含表、另一格有字」不鑽。突變：判準改回「有內層就鑽」→ 紅。
- A-2 `block-detect`：`detectKind(outer)` 的 `rows` ≥ IP 列數、`cols` = 4。
- A-3 `picker-mode`（jsdom）：目標表 = 外層表時，滑鼠指在內層小表的 `42` 上，`resolveCell` 回外層第 3 欄、該 IP 列；點擊送出的 `picks[0].cell.row.header === '10.231.1.31'`、`preview === '42MAX:462'`、`previewValue === 42`。突變：`resolveCell` 改回 `closest('td')` → 紅。
- A-4 `picker.js`：`render({ picks: [{ cell }] })` 後 `getFormData().block.cell` 深等於輸入、`buildSpec` 產生 `mode: 'block', block: { cell }`、聚合下拉 `hidden`、`#block-summary` 含「這一格」。突變：拿掉 cell 分支 → 紅。
- A-5 `background/main.js`：`preselectOf({ spec: { block: { cell } } })` 深等於 `[{ cell }]`。
- A-6 `m2_chain`：從 `PICKED{picks:[{cell}]}` 一路到 Picker `buildSpec` 的鏈結斷言。
- 既有 1464 全綠。

---

## 批次 B：立即測試改走背景

### 現況與核對結果

- `picker.js` `handleTestNow`：`chrome.tabs.sendMessage(ctx.tabId, EXTRACT, { frameId: ctx.frameId ?? 0 })`；`tests/o1_frame_pick.test.js` 兩條測試斷言這個直送行為（本輪改寫）。
- `fetcher.runTask(task, { dryRun: true })` 已存在：不寫紀錄、不進帳本、失敗回 `{ ok:false, error }`、成功回 `EXTRACT` 的原始結果（含 `fields`）。它自己找分頁（`tabs.query({ url })`）、等載入、登入檢查、`locateFrame`、`injectContent`。
- 既有慣例：`buildSpec` 是唯一規格組裝（`tests/l3_batch_d` 守門）；`RUN_TASK` 已是 background 的手動抓取入口，但要先有已儲存的任務。

### 定案

- 新增訊息型別 `TEST_TASK`（`shared/messages.js`）：Picker 把 `buildTask(values, locator, existing, frame)` 組好的**未儲存任務**送給 background，background 以 `runTask(task, { dryRun: true, reason: 'manual', tabId })` 執行後把結果原樣回傳。任務 id 用暫時值（`__test`），**不得寫入 storage**。
- `runTask` 新增 `opts.tabId`（暫定）：有給且該分頁仍存在就直接用它，否則走原本的 `tabs.query`。
- 錯誤只顯示一次：失敗時 `#errors` 顯示原因、`#preview` 顯示 `—`；成功時 `#errors` 清空。
- 立即測試在「編輯既有任務」時仍隱藏（維持 SPEC §2.1，開放與否進 BACKLOG）。

### 改動

1. `shared/messages.js`：`TEST_TASK`。
2. `ui/picker/picker.js`：`handleTestNow` 改送 `runtime.sendMessage({ type: TEST_TASK, task, tabId })`，不再 `tabs.sendMessage`；結果渲染沿用（多值逐值）。
3. `background/main.js`：`TEST_TASK` 分支；任務物件經最小驗證（有 `url`、`locator`、`spec`）。
4. `background/fetcher.js`：`opts.tabId`。
5. `tests/o1_frame_pick.test.js` 兩條「立即測試」改為斷言送出 `TEST_TASK` 且 `task.frame.url` 正確／最上層無 `frame`。
6. `docs/SPEC.md` §2.1：立即測試走背景、與正式抓取同一條路徑。

### 測試／驗收

- B-1 `picker.js`：`handleTestNow` 不呼叫 `chrome.tabs.sendMessage`；送出的 `task.spec` 深等於 `buildSpec(getFormData())`（`l3_batch_d` 的守門照舊成立）；`task.frame` 與 ctx 一致。失敗回應時 `#errors` 有文字、`#preview` 為 `—`，且錯誤字串在 DOM 中只出現一次。
- B-2 `background/main.js`：`TEST_TASK` 呼叫 `runTask` 時 `dryRun === true`；`saveTask`／`appendRecords` 零呼叫（突變：拿掉 dryRun → 紅）；`storage` 前後快照相等。
- B-3 `fetcher`：`opts.tabId` 存在時不呼叫 `tabs.query`；分頁不存在（`tabs.get` 拋）時退回 `tabs.query`。
- B-4 `a4_conventions`：既有 D13（`sendMessage` 必帶 frameId）照過。

---

## 批次 C：選取工具列與已選清單

### 現況與核對結果

- 面板 `pointer-events: none`；overlay 內元素在 `onMouseMove` 被跳過（代理層例外）；`onClick` 對任何點擊都 `confirmPick`（含點到 overlay 自己）。
- `tableAxis` 預設 `'col'`：滑鼠指到一格就整欄標橘；單擊無 Shift = 選那一格並送出。`Tab` 切軸並清空 `selectedList`。
- `samePick`／`addPick`／`togglePick` 已是唯一入口；`selectedList` 可混放 cell 與 block。

### 定案

- 選取模式新增 **`pickMode ∈ { cell, col, row }`**，預設 `cell`；取代 `tableAxis` 的角色（`currentAxis()` 對外仍回 `col`/`row`，`cell` 時回 `col`，維持 `blockInfo.axis` 相容）。
- **工具列**：overlay 內、`position: fixed` 右上角、`pointer-events: auto`，三段按鈕（`data-af-tool="cell|col|row"`），目前模式帶 `data-af-active`。目標不是表格時工具列仍在但停用（`aria-disabled`），提示「非表格：整個元素」。
- **`Tab`** 在三段間循環（cell → col → row → cell），**不清空已選**；只有進到另一張表格才清（現狀）。
- **點擊語意**：
  - `cell` 模式：點一格 = 選該格並送出（現狀）；**該格已在已選清單 → 改為移除它，不送出**。
  - `col`／`row` 模式：點一格 = 加入該欄／列的聚合 pick 並送出；已在清單 → 移除，不送出。
  - `Shift`+點：三種模式都是「切換加選／取消」不送出。
- **hover 標示跟著模式**：`cell` 只標那一格；`col`／`row` 標整欄／整列（現狀的橘框）。
- **面板改成可互動**：已選清單每項一個 chip（名稱＋×，`data-af-chip` 帶序號），「移除最後一項」按鈕（`data-af-remove-last`），`Backspace` 等同它；清單為空時顯示原本的提示文字。面板／工具列上的 mousemove 不改變目標；其上的 click 由自己的處理常式吃掉，**絕不落到 `confirmPick`**。
- 右鍵選單維持現有七項不變。
- `purpose !== 'task'`（repick／preaction／login-*）：工具列與 chip 一樣出現，但 `col`／`row` 停用（那些用途只選一個元素）。
- 上限、位置已變、frame 提示等既有面板文字保留。

### 改動

1. `content/picker-mode.js`：`pickMode` 狀態、工具列建立與事件、面板 chip 渲染、`Backspace`、`Tab` 循環、點擊語意、hover 標示；`confirmPick` 之前的守門（overlay 內點擊不送出）。
2. `docs/SPEC.md` §2：改寫「Tab 切換欄/列軸時清空已選」為新規則；補工具列、chip、點已選格取消、Backspace。

### 測試／驗收（jsdom）

- C-1 工具列：進入選取模式後 overlay 內存在三個 `[data-af-tool]`，預設 `cell` 為 active；點 `col` 後 `currentAxis() === 'col'` 且 hover 一格時 `[data-af-cell]` 數 = 資料列數；`cell` 模式 hover 只有 1 個 `[data-af-cell]`。
- C-2 不清空：Shift 加選兩格 → `Tab` → `selectedCount()` 仍為 2（突變：`Tab` 分支加回 `selectedList = []` → 紅）。
- C-3 點已選格取消：Shift 選 A → 無 Shift 點 A → `selectedCount() === 0` 且 `runtime.sendMessage` 未被呼叫。
- C-4 chip：加選三格後 `[data-af-chip]` 數 = 3；點第 2 個 chip 的 × → 清單剩下第 1、3（順序不變）；`Backspace` → 剩第 1；點 `[data-af-remove-last]` → 0。
- C-5 面板點擊不送出：點面板任意處，`runtime.sendMessage` 未被呼叫。
- C-6 `col` 模式無 Shift 點一格 → 送出的 `picks` 為 `[{ block: { axis:'col', index, headerText } }]`；`row` 同理。
- C-7 `purpose: 'repick'` 時 `col`／`row` 按鈕帶 `aria-disabled`，點了不改模式。
- C-8 `b4_pick_mode` 既有「Tab 切換成以列為軸」測試改寫成新語意，其餘既有測試全綠。

---

## 批次 D：外觀（選取 overlay 與設定視窗）

### 現況與核對結果

- `picker-mode.js`：色碼字面值（豁免檔），藍色實心面板、白底右鍵選單。
- `picker.html`／`site.html`：各自內嵌樣式，只用 `theme.css` 變數；沒有共用元件樣式檔。
- `theme.css` 已有亮／暗雙軌與 `data-theme` 覆寫；`ui-ux-pro-max` 建議（OLED 深色、slate、Inter、accent 綠、dense 間距）與暗軌數值幾乎相同。

### 定案

- **不改 `theme.css` 全域變數**（Report 頁、匯出 HTML 的退路都靠它）。新增 `ui/ui.css`：共用元件樣式（按鈕 primary/ghost/danger、pill、segmented control、card、chip、sticky footer、表單欄位、`[hidden]`、`prefers-reduced-motion`），只吃 `theme.css` 變數，**零色碼字面值**。`picker.html`、`site.html` 載入它並移除重複的內嵌樣式；`popup`／`report` 本輪不動。
- Picker 設定視窗版面：頂部標題列（任務名稱／目標主機）、內容以卡片分節、預覽區改成「數值卡」（等寬字、大字級、狀態色只用 `--ok`/`--warn`/`--danger`）、底部 sticky 動作列（儲存 primary、立即測試 ghost、取消 ghost）；值清單每列有序號、名稱輸入、上下移、移除，hover 有 `--hover` 底色；間距用 `--space-*`，字級最小 `--text-xs`（12px）。亮／暗兩軌都要能看。
- 選取 overlay（注入網頁，拿不到 theme.css）：色碼集中在檔頭一個常數物件（值取自 `theme.css` 暗軌：`#0f172a`/`#1e293b`/`#334155`/`#f8fafc`/`#94a3b8`/`#3b82f6`/`#fbbf24`/`#22c55e`/`#ef4444`），其餘程式碼只引用常數。面板與工具列：半透明深底、細邊框、圓角 8px、陰影；工具列 segmented pill；chip 深底淺字＋×；右鍵選單同色系；hover／focus 150ms 過渡；工具列與 chip 的可點面積最小 28px 高（桌面滑鼠）。
- 無 emoji 當圖示；× 用文字字元即可。

### 改動

1. 新增 `src/ui/ui.css`；`picker.html`、`site.html` 改載入並瘦身內嵌樣式（保留頁面專屬的少量規則）。
2. `picker.html` 結構調整（標題列、卡片、sticky footer、預覽卡）；**所有既有 id 不變**（`c1_picker` 列了必須存在的 id）。
3. `content/picker-mode.js` 樣式常數化與新版面。
4. `manifest.json` 若 `web_accessible_resources` 需列新 css 則補（picker.html 是擴充功能頁，通常不用）。
5. `CLAUDE.md`：`ui/ui.css` 是共用元件樣式；`docs/SPEC.md` §2 補 overlay 色碼常數規則。

### 測試／驗收

- D-1 `a4_conventions`：`src/` 色碼字面值掃描照過（`ui.css` 零色碼；picker-mode 的色碼只出現在檔頭常數區——以「色碼只出現在第一個 `const` 物件內」斷言）。
- D-2 `c1_picker`：必須存在的 id 清單全在；`[hidden]` 規則存在於 `ui.css`。
- D-3 `picker.html`／`site.html` 都 `<link>` 到 `../ui.css`；`prefers-reduced-motion` 區塊存在。
- D-4 `b4_pick_mode`：工具列／面板／選單元素仍以 `data-af-*` 可尋得（樣式改動不破功能）。
- D-5 實機：`./run_smoke.sh` 全過；人工看亮／暗兩軌截圖。

---

## 明確不做（本輪定案）

| 項目 | 理由／觸發 |
|---|---|
| 立即測試對「編輯既有任務」開放 | 走背景後技術上可行；等使用者要時再開（進 BACKLOG） |
| 工具列第四段「每格各一個值」 | 右鍵選單已有；工具列三段就夠，擠了反而難點 |
| Report／popup 換新樣式 | 範圍大；`ui.css` 建好後下一輪可沿用 |
| 每個值各自的聚合方式 | 既有 BACKLOG |
| ~~巢狀表格「第二層以上」的多層包裝~~ | **本輪範圍擴大**：實作是 `while` 迴圈遞迴多層（含 `visited` 防環），成本與一層相同且更安全，SPEC §7 已照多層寫。此列作廢 |
| overlay 面板可拖曳 | 固定右下／右上即可 |

## 作業總覽（委派）

- 委派模型：**agy**（AF-6 同）；額度用完由 Claude 自己接手，起點記在執行紀錄，不換回。
- 順序 A → B → C → D；每段 Claude 先寫測試（紅），再委派實作，回來獨立重驗＋突變。
- 委派期間 Claude 不動 repo；規格檔只放該段的背景、契約、限制、驗收。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A-1 shared 巢狀判準 | agy | 通過 | 自跑 A-1/A-2 綠、突變 otherCellsEmpty 殺死 | Claude 補 resolveHtmlTable:容器 div 包表格時欄名/資料列會變空(agy 沒察覺),另加護欄測試 |
| A-2 選取模式格子歸屬與預覽 | agy | 通過 | 自跑 A-3 綠、兩處守門突變各殺死 2/1 條 | 無 |
| A-3 Picker 單格一等公民 | agy | 通過 | 全套 1485 綠、三處守門突變各殺死 3/1/1 條 | getFormData 為了測試改成 export(可接受,render/buildSpec 本就外露) |
| B 立即測試走背景 | agy | 通過 | 全套 1498 綠、三處守門突變各殺死 6/6/12 條 | Claude 改寫 c1_picker 一條釘住舊契約的測試（規格禁止 agy 動 tests）；暫時任務 id 由 `__test` 改 `__preview`，避免誤觸慣例掃描 |
| C 選取工具列與已選清單 | agy | 通過 | 全套 1515 綠、四處守門突變各殺死 1 條（面板守門為等價突變，改測 overlay 整段仍殺死） | Claude 改寫 4 條釘住舊契約的測試（b4 三條、l7 一條）；另修 r1 一條寫死日期的既有測試，跨日就會變紅 |
| D 外觀與共用樣式 | agy（claude-sonnet-4-6，Gemini 額度用盡後切換，起點在本段） | 通過 | 全套 1530 綠、五處守門突變各殺死 1 條 | Claude 修：agy 給 picker.html/site.html/ui.css 都加了 BOM（已清）；序號用 `attr(data-field-index)` 但無人設定，改 CSS 計數器並補 D-5 護欄；D-4 焦點斷言原本自我矛盾（把 :focus-visible 排除在檢查外），補強後才殺得死突變；另補核取方塊 `accent-color` |

## 規劃複檢

- 與既有設計衝突：SPEC §2「Tab 清空已選」被 C 推翻（理由：資料結構已支援混用，清空只是舊限制），§7「巢狀 table 取最內層」被 A 改為「純包裝才鑽」；兩處都在該批次改動清單裡。
- 批次間：A 改 `resolveCell`、C 改點擊語意，同檔不同函式，A 先做。D 改 `picker.html` 結構但 id 不變，B 的 `#preview`/`#errors` 語意不受影響。
- 拆分原則四坑：「純包裝」判準寫明了「一個都沒有時」（沒有內層 table 就是自己）與反例（一格含表、另一格有字）；`opts.tabId` 分頁不存在的退路寫了；C 的點已選格取消對非 task 用途只剩單格模式，行為一致；沒有移除類項目（`Tab` 仍在、`currentAxis()` 保留）。
- 升級／既有資料：`spec.block.cell` 形狀不變，舊任務零遷移。
- 複檢完成，補了 P1'（`preselectOf` 形狀）與 C-7（非 task 用途停用欄列）。

## 體檢輪（兩份獨立終檢的處置）

煙霧測試 Chrome + Edge 全過。程式碼與文件各開一份獨立終檢，每項發現先實測確認機制成立才修。

| 發現 | 實測結果 | 處置 |
|---|---|---|
| `exitPickMode` 漏清「已選屬於哪張表」 | 成立且嚴重：同一頁連續選兩次，第二個任務存成「第一張表的 locator + 第二張表的列欄索引」 | 補重設；測試改驗「連續選兩次」的行為，不只驗 DOM 清乾淨 |
| 已達上限時點格子會靜靜送出、丟掉剛點的那一格 | 成立（批次 C 改走 `addPick` 之後才出現） | 加不進去就停在原地提示，不送出 |
| 滑鼠移到格子縫隙後記住的格子是舊值 | 成立：之後切換模式會把標示畫回舊位置 | 解析不到格子時放掉它並清標示 |
| 單格預覽顯示成「42 (42)」 | 成立：預覽文字是字串、預覽數值是數字，直接比永遠不相等 | 比較前正規化成字串 |
| `Backspace` 無條件攔截 | 成立：選取模式開在有輸入框的頁面時打不了字 | 只有清單非空才攔 |
| 純包裝判準的反例 `<td>總計<table>…</table></td>` | 成立：外層那格的「總計」被丟掉 | 那一格除了內層表格不得有自己的文字 |
| `role="table"` 包住真 `<table>` 時列數歸零 | 成立（批次 A 的列過濾造成的退化） | 判準改成「往上找到的第一張表是容器自己或它裡面那一張」 |
| 立即測試不核對分頁現在的網址 | 成立：分頁被導去別站仍會在那裡測 | 比對 `origin + pathname`，對不上就退回找分頁流程 |
| 定案「非表格時提示」沒實作 | 成立 | 面板補「非表格：抓整個元素」並補測試斷言 |
| 兩條測試對空集合跑迴圈（字級掃描、`attr()` 護欄） | 成立：改壞也不會紅 | 字級改驗 `theme.css` 的 token 值；`attr()` 護欄補正向斷言 |
| 「哪些列／格屬於這張表」有三份寫法 | 成立 | 本輪只修出錯的那一份；合併風險大於收益，已進 BACKLOG |
| 非 task 用途 chip 不會累積 | 成立，但**是設計如此**（那些用途只選一個元素） | 不改行為，SPEC 寫明 |

體檢輪九處守門各做一次突變，全部殺得死對應測試。全套 **1541 綠**。
