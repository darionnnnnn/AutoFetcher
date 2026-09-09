# AF-10 第 10 輪規劃：side panel 設定面板、鎖表選取、表格判準合一、前置動作靈活化

> 狀態：規劃中（使用者已定案六點，待複檢與開工）
> 基準：dev@1fd301b（1748 綠，v0.8.0）
> 來源：使用者回饋 5 項 + 核對時順手發現 9 項
> 實作方式：**Claude 自己做**（agy 無額度）。仍照慣例：每階段先寫測試（含突變）再實作、一段一驗。
> 設計原則（使用者明示）：**使用者體驗與整體規劃優先於改動幅度**。

## 批次總覽

| 作業 | 內容 | 規模 | 相依 | 建議順序 |
|---|---|---|---|---|
| B-0 | side panel 可行性探針（實機驗證五個框架行為，拋棄式） | 小 | 無 | **0（開工第一件事）** |
| D | 表格判準收成一份 + 選取／擷取同一張表（P5） | 大 | 無 | 1 |
| C | 已選就鎖表、工具列判定改源、col/row 模式守門（P4） | 中 | D（索引 helper） | 2 |
| B | 設定面板改 side panel、面板生命週期 ↔ 頁面標示（P2、P3） | 大 | B-0 結論；與 C 同檔 `picker-mode.js`，C 先併 | 3 |
| A | 前置動作：hover 型、完整點擊事件、waitFor 可見性、單位與訊息（P1） | 中 | 無 | 4（可與 B 並行） |
| E | 收官：版本 0.9.0、SPEC/BACKLOG/CLAUDE.md/README、全量測試、煙霧 | 小 | A~D | 5 |

每個作業一個 commit（可獨立回滾）；B 是本輪風險最高的一塊，B-0 先把框架事實釘死，B-0 的結論若推翻設計就回到規劃文件改，不在實作中硬繞。

### 已查證的框架事實（Chrome sidePanel／storage 官方文件，2026-09-09）

- `sidePanel.open()`「只能在使用者動作內呼叫」，文件明列 `contextMenus.onClicked`、action 點擊、擴充功能頁與 content script 的手勢皆合法；**`runtime.onMessage` 內是否延續手勢文件未寫** → B-0 驗。
- `sidePanel.close()` Chrome **141+**、`sidePanel.onClosed` Chrome **142+**；現今 stable 已過 152（README 記載 152 封鎖 `--load-extension`），可當主路徑，但**缺少時要有退路**（Edge 版本可能落後）。
- `setOptions.path` 只允許「擴充功能包內的本地資源」，query string 無保證 → **一律不用 query string 傳參數**（`?ctx=`、`?taskId=`、`?origin=&tabId=` 三處都改走 `storage.session`）。
- `storage.session` 配額 10MB，預設 content script 不可讀（`TRUSTED_CONTEXTS`），擴充功能頁可讀；不需要放寬存取層級。
- `shared/storage.subscribe` 目前只轉發 `areaName === 'local'` 的變動（storage.js:545），session 的變動要另開通道。

### B-0 探針結果（2026-09-09，Chrome for Testing 152.0.7977.82，headful，獨立探針擴充功能）

| # | 問題 | 結果 |
|---|---|---|
| 1 | `sidePanel.open()` 在 `runtime.onMessage` 內 | **失敗**：`may only be called in response to a user gesture`。手勢**不跨 sendMessage** |
| 2 | 在擴充功能頁自己的點擊處理內直接 `open` | **成功** |
| 3 | `contextMenus.onClicked` 內 `open` | 無法自動化（原生選單），文件明列合法；**留實機煙霧驗**，退路：popup 入口 |
| 4 | 面板寬度 | **360px**（載入當下、版面後、`documentElement.clientWidth` 三者一致） |
| 5 | 切到別的分頁再切回 | **面板文件重載**（載入計數 1→2）→ **草稿是必要的，不是可選** |
| 6 | 宿主分頁重新整理 | 面板**不重載** |
| 7 | `sidePanel.onClosed` | 存在；`close()` 會觸發，帶正確 `tabId`/`windowId`；**切分頁不會誤觸發** |
| 8 | `sidePanel.close({tabId})` | 有效，面板 target 消失 |
| 9 | 全域 `setOptions({enabled:false})` 後分頁層 `enabled:true` | **仍可開** |
| 10 | `setOptions.path` 帶 query string | `setOptions`/`getOptions` 接受，**首次載入 `location.search` 有值，重載後變空**（Chrome 用 `default_path` 重載）→ **不可用 query 傳參數** |
| 11 | 面板頁的 `sender.tab` | **永遠 null**，無法由 background 反查 |
| 12 | 面板載入當下 `tabs.query({active:true})`／background 的 `tabs.onActivated` 追蹤 | **兩者都拿到切換前的舊分頁**（面板在切換完成前就開始載入） |
| 13 | 面板 `visibilitychange → visible` 時再解析 | **正確** |
| 14 | 面板 `chrome.windows.getCurrent()` | **穩定可靠**，跨重載不變 |

**因此推翻兩項原設計**：
- 原 B-3「面板以 `tabs.query({active:true})` 取得自己的 tabId」→ **不可用**（#12）。改為：面板取 `windows.getCurrent().id`（#14），在 **`visible` 時**（#13，不是載入時）向 background 問 `RESOLVE_PANEL_TAB{windowId}`，background 以 `tabs.query({active:true, windowId})` 回答；每次轉為可見都重解析一次（自癒）。
- 原 B-4 草稿「B-0 若證實會重載才做」→ **確認會重載（#5），列為必做**。

探針程式為拋棄式，放在 scratchpad，不進 repo。

### B-0 原本要驗的五件事（全部已答，對照上表；只有第 1 項的 contextMenus 分支留給實機煙霧）

1. `contextMenus.onClicked` 內 `sidePanel.open({tabId})` 是否成功；content script 點擊 → `runtime.sendMessage` → `onMessage` 內 `open` 是否被視為手勢。
2. 分頁切換時，tab 專屬的面板文件是否被卸載重載（決定草稿要不要自動存）；切回來 `onClosed` 有沒有誤觸發。
3. `sidePanel.close({tabId})` 與 `setOptions({tabId, enabled:false})` 何者能關掉開著的面板；關掉後 `onClosed` 是否觸發、`tabId` 是否正確。
4. 全域 `setOptions({enabled:false})` 後，工具列圖示右鍵「開啟側邊面板」是否消失；分頁層 `enabled:true` 是否仍可開。
5. 面板最小寬度實測值（Chrome 與 Edge），與使用者拖寬後是否記憶。

---

## 作業 D：表格判準收成一份（P5）

### 現況與核對結果

- 選取端 `content/picker-mode.js` 的 `upgradeTarget`（97–115）：滑鼠指到哪張表的格子就是哪張表，不看是否「純包裝」；擷取端 `shared/table.js` 的 `innermostTable`（67–100）只在「純包裝」才鑽。兩套判準。
- **靜默錯值路徑**：純包裝結構（`<td><table>…</table></td>`）下滑鼠落在包裝 `<td>` 的 padding／邊緣 → `closest(CELL)` 命中包裝格 → 目標＝外層表，索引以外層算、`locator` 指外層；擷取 `parseHtmlTable`（table.js:311）再 `innermostTable` 鑽到內層 → row0/col0 指內層第一格。無錯誤、無警示。`block-detect.detectKind`（:61）同樣對外層回報內層規模，面板數字與可選索引對不上。
- 「哪些列／格屬於這張表」三份判準（BACKLOG 已登記）：
  - `block-detect.js`：`isTableLike` 認 `<table>`+ARIA；`getRows` 的 `owner = el.querySelector('table')` 只取第一張後代表，多張並列小表會少算列。
  - `picker-mode.js`：`getTableRows`/`getRowCells` 有巢狀過濾、認 ARIA、`isHeaderRow` 認 `role=columnheader`；`isTableMode` 額外把 CSS 假表格算表格。
  - `table.js`：靠原生 `.rows`/`.cells`；`querySelectorAll` 退路無巢狀過濾（會把內層 `tr`/`td` 一併吃進來，索引整體位移）；`isHeaderRow` 不認 `role=columnheader`（ARIA 表頭列被當資料列，`getDataRows` 多一列，與 picker 端差一格）。
- 結構 A（外層每列某格各包一張小表）：`↑` 改選外層那一格時，外層格文字是內層整串接（`42MAX:462`），`p1_nested_cell.test.js:199` 只斷言索引不斷言值，默許髒值。
- 既有測試：`p1_nested_cell`、`q1_table_entry`、`c3_table`、`b5_block_detect`；缺「純包裝外層被指到 → 端到端擷取值」、ARIA 巢狀、picker 索引 vs `parseTable` 索引交叉測試。

### 定案

1. **`shared/table.js` 是「這張表有哪些列／格／表頭列」的唯一判準**，同時認 `<table>` 與 ARIA（`role=grid|table` / `row` / `cell|gridcell|columnheader|rowheader`），一律做巢狀過濾（列屬於「最近的表格祖先 === 這張表」，格屬於「最近的列祖先 === 這一列」），`role=columnheader` 整列視為表頭列。`picker-mode.js` 與 `block-detect.js` 自己那幾份刪除、改 import。
2. **「選取時的表」＝「擷取時的表」**：`upgradeTarget` 找到表之後，回傳前套同一份 `innermostTable`（純包裝 → 內層；否則維持）。`detectKind` 與 picker 索引因此同源。
3. `isTableMode`（含 CSS 假表格）維持 picker 專屬語意不動——它決定的是「要不要進表格模式」，不是「哪些列屬於這張表」；但 CSS 假表格的列格判準也走 table.js 的 `isCssGrid` 那一支（不另寫）。
4. `innermostTable` 的「純包裝」判準本身**不放寬**（AF-8 定案，`<td>總計<table>` 不算純包裝）。
5. 結構 A 的外層格串接髒值：**本輪不改解析**（那一格在 DOM 上就是那樣），改在選取面板的預覽以「這一格內含表格，會抓到整串文字」提示（`instructionLine` 之外的一行 notice），並在測試把預覽值斷言出來，讓髒值可見而非默許。
6. 三份合一後 `picker-mode.js` 的行為契約不變：`q1_table_entry`、`p1_nested_cell`、`p3_pick_toolbar` 全部維持綠（改的是實作來源不是行為）。

### 改動

1. `shared/table.js`：新增／改寫 `tableOf(el)`、`getTableRows(table)`、`getRowCells(row)`、`isHeaderRow(row)`、`isHeaderCell(cell)`、`cellOf(el)` 為公開 API（名稱暫定，執行時對齊 picker-mode 現名以減少改動）；`getAriaRows` 併入；`querySelectorAll` 退路加巢狀過濾。
2. `content/picker-mode.js`：刪自帶的 `getRowCells`/`isHeaderRow`/`getTableRows`/`tableOf`/`isHeaderCell`（**先 grep 全部呼叫點**，白名單涵蓋 `markCells`、`candidateAt`、`handleTableMouseMove`、`upgradeTarget`、`selectAllCells`、preselect 勾回等），`upgradeTarget` 加 `innermostTable`。
3. `shared/block-detect.js`：`getRows`/`describeTable` 改用 table.js，移除 `owner = querySelector('table')`。
4. BACKLOG 刪掉兩條（判準合一、picker-mode helper 併入）。

### 測試／驗收

- 新測試檔 `tests/s1_table_unify.test.js`（暫名）：
  - 純包裝外層：模擬滑鼠落在包裝 `<td>` 本身 → `upgradeTarget` 回內層表；`confirmPick` 送出的 `locator` 解析回來後走 `extract` block 分支，**取到的值 === 使用者指到的那一格文字**（端到端，鏈結測試）。突變：拿掉 `upgradeTarget` 的 `innermostTable` → 紅。
  - ARIA 巢狀（`role=table` 內含 `<table>`）與「`role=table` 內多張並列小表」：列數＝外層自己的列數。突變：拿掉巢狀過濾 → 紅。
  - `role=columnheader` 列：`getDataRows` 不含它；picker 與 table.js 的 `isHeaderRow` 對同一列回同值。
  - `querySelectorAll` 退路（無 `.rows` 的物件）對巢狀表格：不吃內層 `tr`。
  - 交叉測試：對 fixtures 內每張表，picker 的 `getTableRows(t).length === parseTable(t).cells.length + 表頭列數`（掃描型，**先斷言 fixture 集合非空**）。
- `grep -n "function getRowCells\|function isHeaderRow\|function getTableRows" src/content/picker-mode.js src/shared/block-detect.js` 零命中。
- 結構 A 預覽提示：`p1_nested_cell` 的「↑ 改選外層」案例補斷言面板 notice 出現、預覽值為串接字串。
- 全量測試綠且數量 ≥ 1748。

---

## 作業 C：已選就鎖表（P4）

### 現況與核對結果

- `updateToolbar`（picker-mode.js:394–430）用 hover 目標 `currentTargetEl` 判定是不是表格，不是 `pickedTableEl`。已選非空、滑鼠往右上角工具列移動，途中經過的頁面內容把目標換成非表格 → 三段 `aria-disabled`、`clearMarkedCells` 清掉 hover 標示。滑鼠**真的進到工具列上時**（1423–1425）是跳過不動的，問題全在抵達前。
- SPEC §2「已選了值就鎖在那張表」實作只有：巢狀關係鎖回（109–111）、換到平行另一張表就清空整批（713–723）、送出前補回（939–941）。非表格區域沒涵蓋。
- `pendingMode` 兌現（739–743）只設 `pickMode`，不做 `upgradeLastPickTo`，與直接點工具列的路徑結果不同；`pendingMode` 沒有取消出口。
- col/row 模式下滑鼠停在非表格元素：`candidateAt` 回 null，落到第 7 段鎖定該元素（1772），雙擊／Enter 送出 `describe(currentTargetEl)`——`pickMode` 被靜默丟棄，工具列還亮著整欄。
- 測試缺口：沒有「已選非空 → 滑鼠移到表格外 → 工具列狀態」的案例（`C-8` 測的是一開始就在非表格上）。

### 定案

1. **已選非空 = 鎖在 `pickedTableEl`**：hover 到任何非表格區域、或這張表的巢狀內外層，目標都不變、hover 標示不清、工具列不反灰；只有 hover 到**另一張不相干的表**才把目標換過去（讓使用者看得到可以換表），但**不清空已選**。
2. **換表要「點」不要「移」**（推翻 SPEC §2「滑鼠移到另一張表格時才清空」）：點另一張表的格子 = 取代（清空舊表已選、換 `pickedTableEl`、存復原快照、面板提示「已換到另一張表格，復原可回上一張」）。`Ctrl` 點另一張表的格子 = 同「點一下」（跨表不能加選，提示一句）。復原快照因此**跨表也有效**：快照存 `{ pickedTableEl 的 locator 描述, selectedList }`，還原時要把目標與 `pickedTableEl` 一起換回去（AF-9 定案「換表讓快照失效」改為「換表存快照」，理由：hover 不再有破壞性副作用後，唯一的破壞性動作就是這個點擊，它最需要反悔）。
3. **工具列停用判定改源**：已選非空 → 以 `pickedTableEl` 判定（永遠是表格，三段可用）；已選為空 → 維持以 hover 目標判定（既有 `C-8`、`pendingMode` 行為不變）。
4. **col/row 模式的守門**：模式為 col/row 且 hover 目標非表格時，`點一下` 不鎖定、`Enter`/雙擊不送出，面板指令句換成「整欄／整列只能在表格上選，先把滑鼠移到表格」；非表格元素只有在單格模式（或非多選用途）才可鎖定與送出。
5. `pendingMode` 兌現時**同時做 `upgradeLastPickTo`**（與直接點的路徑一致）；點「單格」段 = 取消 `pendingMode` 並清 notice。
6. 送出前補回（939–941）保留當保險，但加一條測試證明鎖表後它不會再被觸發（用替身斷言前置條件）。
7. **鍵盤 `↑`／`↓` 不受鎖表限制**（那是明確意圖，不是滑鼠路過）：`↑` 仍可走到外層表格或非表格父層、`↓` 沿原路回來；走到「另一張表」（含巢狀外層表）後 `Enter`/點格 = 換表取代（同定案 2，存快照），走到非表格後 `Enter` 在單格模式送出整個元素前**先提示一次**「這會丟掉已選的 N 個值」、再按一次才送（與既有「帶 preselect 且已選 ≥2 的點一下取代要先提示」同一條規則，不另寫）。`q1_table_entry` 的「已選外層值後移到內層不換表」維持：滑鼠路過內層不換，鍵盤 `↓` 進內層再 `Enter` 才算換表。
8. `repick` 帶 `preselect` 進來時已選非空 → 一進入就鎖在那張表（定案 1 自然涵蓋，測試要驗）。
9. 「另一張不相干的表」的判定 = 表格元素且與 `pickedTableEl` 無祖孫包含關係；表格縫隙、非表格區域、巢狀內外層都不算。

### 改動

1. `upgradeTarget`：`pickedTableEl` 存在且 `upgraded` 不是「另一張不相干的表」時回 `pickedTableEl`（非表格、巢狀內外層都算）。
2. `setTarget` 的換表清空（713–723）移除；改到 `onClick` 表格分支：`hostTable !== pickedTableEl` → 走「取代並存快照」。
3. `updateToolbar` 判定來源依定案 3。
4. `onClick` 第 7 段與 `confirmPick` 加 col/row 守門；`instructionLine` 加一句。
5. `pendingMode` 兌現補 `upgradeLastPickTo`；`cell` 段點擊清 `pendingMode`。
6. 復原快照結構加表格身分；`Ctrl+Z`／復原鈕還原時同步 `pickedTableEl` 與目標。
7. `exitPickMode` 重設清單補新狀態（沿用「連續選兩次」型測試）。

### 測試／驗收

- 新測試檔 `tests/s2_lock_table.test.js`：
  - 已選一格 → 派發 mousemove 到表格外的 `<p>` → 目標仍是那張表、工具列三段皆可用、`data-af-cell` 標示仍在；再點「整欄」→ 最後一項升級成整欄。突變：`updateToolbar` 改回看 hover 目標 → 紅。
  - 已選一格 → mousemove 到另一張表 → 已選不變、`pickedTableEl` 不變；點那張表的格子 → 已選只剩新格、`pickedTableEl` 換表、復原鈕出現；`Ctrl+Z` → 回舊表舊清單且目標回舊表。突變：拿掉快照的表格身分 → 紅。
  - `Ctrl` 點另一張表的格子 → 不加選、有提示。
  - col 模式 + 非表格 hover → 點一下不鎖定、Enter 不送出、指令句含「整欄／整列只能在表格上選」；單格模式同一元素可鎖定可送出。突變：拿掉守門 → 紅。
  - `pendingMode` 兌現後最後一項是整欄（不是單格）；點「單格」段 → `pendingMode` 為 null。
  - 送出前補回的保險：以替身包住 `setTarget`，斷言鎖表後 `confirmPick` 不再呼叫它。
  - 鍵盤：已選一格 → `↑` 到外層表 → 目標是外層（不被鎖回）→ `Enter`/點格 = 換表取代且有快照；`↑` 到非表格父層 → 單格模式 `Enter` 第一次只提示、第二次才送出整個元素。突變：`↑` 也套鎖表 → 紅。
  - `repick` 帶 `preselect` 進入 → 一進入 `pickedTableEl` 已設、mousemove 到 `<p>` 工具列仍可用。
  - 反例：點同一張表的巢狀內層格 → 走原有取代語意（不算換表、不存「換表」快照）；點表格縫隙 → 什麼都不做。
- 既有 `r3_pick_flow` 的 `C11-3c`（換到另一張表之後復原快照要作廢）**依定案 2 改寫**為「換表存快照」，並在 SPEC §2 明寫推翻。
- `p3_pick_toolbar`、`q1_table_entry` 其餘維持綠。

---

## 作業 B：設定面板改 side panel、視窗生命週期 ↔ 頁面標示（P2、P3）

### 現況與核對結果

- 新增走 `chrome.windows.create` popup 600×820（main.js:453），編輯走 `chrome.tabs.create` 普通分頁（tasks.js:313），站台登入走 popup（main.js:643）。三種載體。沒記 windowId、沒 `focused`、沒 `onRemoved`。Chrome MV3 無 `alwaysOnTop`。
- `confirmPick` 送出 PICKED 的同一 tick 就 `exitPickMode()` 拆光標示；`EXIT_PICK` 訊息定義了但無人發送（content 端接收在 main.js:221）。content script 在 PICKED 後仍活著，`onMessage` 不受影響。
- background 開窗時已知 `tabId`/`url`/frame 身分（main.js:437–443），材料齊備。
- 順手：`cancelled` 在轉發 preaction 之前 return（main.js:424），Picker 收不到取消；`repick` 存檔後不通知 Report、不 `rebuildAlarms`、開的新分頁不關；site 視窗關掉後目標分頁選取模式留著。
- 版面：`picker.html`／`site.html` 皆 `width:100%`、列類容器 `flex-wrap`，窄寬度基本可行；`.preaction-target max-width:90px` 一類在 360px 需微調。
- 測試：`chrome-mock.js` 有 `windows.*` 無 `sidePanel`；斷言 `windows.create` 參數的測試在 `b6_pick_wiring:79`、`m2_chain:45,62,401`、`o1_frame_pick:45`、`p1_nested_cell:352`、`d10_site_page:151`。

### 定案

1. **設定面板一律走 `chrome.sidePanel`**（manifest 加 `sidePanel` 權限與 `side_panel.default_path`；工具列圖示維持 popup，不設 `openPanelOnActionClick`）。新增、編輯、站台登入三條**同一載體**：面板停在目標分頁旁邊，永遠看得見、永遠不會被別的視窗蓋住——這就是「保持最上層」的正解，也讓 P3 的高亮與設定同時在眼前。
   **`chrome.sidePanel` 不存在時（舊版）退回既有 popup 視窗**，`open` 拋錯（手勢不成立）也退回 popup 並記一筆 `diag`——退路是執行期判斷，不是版本判斷。
2. **面板在使用者手勢當下就開**，四個入口各自在自己的手勢內呼叫 `open`：
   - 右鍵「選取要抓的內容」（`contextMenus.onClicked`，文件明列合法）→ `openPanel(tabId, 'picker')`，面板先顯示**等待態**「正在頁面上選取…」加一顆「取消選取」鈕（送 `EXIT_PICK`）；PICKED 到達後 ctx 寫進 session，面板切到表單。
   - popup 的「選取要抓的內容」鈕 → popup 自己在點擊內先 `openPanel`（action popup 的手勢合法）再送 `ENTER_PICK`，然後關 popup。
   - 右鍵「設定此站台登入」→ `openPanel(tabId, 'site')`。
   - Report 任務頁「編輯」→ 任務頁在點擊內直接 `openPanel(自己的 tabId, 'picker')` 並把 `{kind:'edit', taskId}` 寫進 session（擴充功能頁的手勢合法，不繞 background 免得手勢失效）。
   - **`openPanel` 是 side panel 的唯一入口**（`shared/panel.js`，四個呼叫端都 import；它負責 `setOptions({tabId, path, enabled:true})` → `open({tabId})` → 失敗退路）。
3. **session ctx 的形狀只有一種**（`shared/storage` 新增 `session` 小節，鍵 `panel:<tabId>`）：
   `{ kind: 'waiting'|'new'|'edit'|'site', purpose?, ctx?, taskId?, origin?, draft? }`。
   **面板判斷自己屬於哪個分頁的方式（B-0 #12~#14 實測定案）**：面板取 `chrome.windows.getCurrent().id`（跨重載穩定），
   **在 `document.visibilityState` 轉為 `visible` 時**（不是載入當下——載入時面板與分頁切換有競態，會拿到切換前的舊分頁）
   送 `RESOLVE_PANEL_TAB{windowId}`，background 以 `tabs.query({active:true, windowId})` 回答；
   **每次轉為可見都重解析一次**並在 tabId 改變時重新 render（自癒）。載入當下若已 `visible` 也走同一條路徑（統一入口，不寫兩份）。
   `storage.subscribe` 加 `area` 參數（預設 `'local'`，面板傳 `'session'`），不另寫一份 `onChanged` 監聽。
   `?ctx=`、`?taskId=`、`?origin=&tabId=` 三種 query 參數全部移除（**B-0 #10：query 在面板重載後會被丟棄，不能用來傳參數**；BACKLOG「ctx 改走 `storage.session`」結案）。
4. **面板上的表單有草稿（B-0 #5 實測：切分頁再切回會重載面板文件，必做）**：表單任何欄位變動（debounce 300ms）
   寫回 `panel:<tabId>.draft`，面板重新載入時還原——沒有這條就是「切去看一眼別的分頁，回來表單被清空」。
   儲存或取消才清草稿。草稿只存表單值（不存 ctx），還原順序是 ctx → 預設值 → 草稿覆蓋。
5. **面板已開、表單填到一半時，使用者又在頁面上選了新目標**（重複右鍵或 popup）：**不重置表單**，視為「換目標」——只換 `locator`/`picks`/`blockInfo`/`preview`/`nameHint`，名稱（若使用者改過）、排程、儀表板、進階設定全部保留，摘要卡即時重算，面板提示「已換成新目標」。這是 side panel 才做得到的事，也是 BACKLOG「從設定視窗回頁面加選一個值」的一半；面板加一顆「回頁面重選目標」鈕（`ENTER_PICK{purpose:'task', tabId}`，帶 `preselect` 把目前已選勾回去），完整結案那條 BACKLOG。
6. **頁面標示保留到面板關閉**：新增 content 狀態 `held`：已選的 `data-af-picked` 藍框與目標外框留著，工具列、面板、事件攔截、`userSelect`/`cursor` 覆寫全部拆掉，頁面可正常操作。`confirmPick`（`task`／`login-*`／`preaction`）送出後進 `held`；`repick` 維持直接退出。
   **`held` 標示分群**（`data-af-held="<purpose>"`）：`Esc`／取消／再次 `ENTER_PICK` 只清**同 purpose** 的舊標示與本輪 overlay，不動其他群（前置動作選到一半按 `Esc`，不可把任務目標的藍框一起抹掉）；`EXIT_PICK` 清全部。頁面重畫後標示消失屬可接受。
7. **面板關閉 = 清場**，三條通道，任一觸發都做同一件事（對該 tab 全部 frame 送 `EXIT_PICK`、清 session 鍵；重複觸發冪等）：
   - 主：`sidePanel.onClosed`（142+；**B-0 #7 實測：切分頁不會誤觸發**，可直接信任）。
   - 面板頁 `pagehide` 送 `PANEL_CLOSING{tabId}`（fire-and-forget，能喚醒 service worker）。
   - `tabs.onRemoved`（分頁關了節點也沒了，只清 session 鍵）。
   **不用 `runtime.connect` 的斷線當訊號**：分頁切換與 service worker 重啟都會斷線，會把還開著的面板誤判成已關閉。
   儲存成功後 1.5 秒自動關：`sidePanel.close({tabId})`（141+，**B-0 #8 實測有效**），缺少時退回 `setOptions({tabId, enabled:false})`，再不行就停在「已儲存」畫面並顯示「可以關閉此面板」。
8. **前置動作／重選的「在頁面上選取」**：面板不關、頁面進選取模式；選完 PICKED 回面板那一列（既有流程），頁面進 `held`（群 `preaction`）保留那顆按鈕的高亮。
9. 順手修：
   - `cancelled` 轉發順序：preaction／login-* 的取消要先轉發給面板再 return。
   - `repick` 存檔後 `rebuildAlarms` + `refreshBadge`（任務頁靠 `storage.subscribe` 刷新，已訂閱）；background 為 repick 開的分頁在 PICKED／取消後關閉（自己開的才關）。
   - site 面板關閉 → `EXIT_PICK`（定案 7 涵蓋）。
10. 面板寬度：以 **360px** 為最小可用寬度做版面（B-0 實測值為準），`ui.css`／`picker.html`／`site.html` 的固定 `max-width`／`min-width` 逐一檢視；摘要卡三行、多值清單一列（序號＋名稱＋位置＋結果）、底部動作列在 360px 不得溢出、不得橫向捲動。**不改視覺設計**，只調版面約束。
11. `windows.create` 的兩處 UI 呼叫（task、site）搬進 `openPanel` 的退路，`tabs.create` 編輯入口移除；`fetcher.js:305` 不動。**先 grep 全部依賴方**（tests 六處）。
12. SPEC §13 相容表加一列：side panel 需 Chrome／Edge 114+，`close`/`onClosed` 141/142+，缺少時的退路各是什麼；README 的安裝段同步一句。
13. **可觀測性**：`openPanel` 退路、`onClosed` 清場、PICKED 找不到面板（面板已關但頁面還在選）三種情況各記一筆 `diag`，設定頁的診斷區看得到——沒有這條，「面板沒開」在使用者眼中就是「右鍵沒反應」。

### 改動

1. `manifest.json`：`permissions` 加 `sidePanel`；`side_panel.default_path` 指 `ui/picker/picker.html`；啟動時全域 `setOptions({enabled:false})`（**B-0 #9 實測：全域停用後分頁層仍可開**，可安全採用，避免工具列右鍵出現空表單）。
2. `shared/panel.js`（新）：`openPanel(tabId, kind)` 唯一入口，含退路與 `diag`；`shared/storage.js`：`session` 小節（`getPanelCtx`/`setPanelCtx`/`clearPanelCtx`，暫名）與 `subscribe(handler, { area })`。
3. `background/main.js`：右鍵兩項改走 `openPanel`；PICKED `task` 分支改寫 session（面板已有 `new`/`edit` 表單時只換目標欄位）；`PANEL_CLOSING`、`sidePanel.onClosed`、`tabs.onRemoved` 三條清場收斂到同一個 `closePanelFor(tabId)`；`cancelled` 順序；repick 收尾。
4. `shared/messages.js`：`PANEL_CLOSING`、`CLOSE_PANEL`（面板請 background 關自己，儲存後用）。
5. `content/picker-mode.js`：`holdPicks(purpose)`；`exitPickMode({ keepHeld })`：預設清全部（`EXIT_PICK` 與測試用），`Esc`/取消/再次 `ENTER_PICK` 走 `keepHeld: 其他群`；狀態重設清單補 `held` 群集合。
6. `ui/picker/picker.js`／`picker.html`：等待態畫面、由 session 取 ctx 與草稿、換目標合併、「回頁面重選目標」鈕、`pagehide` 通知、儲存後 `CLOSE_PANEL`；`ui/site/site.js`／`site.html` 同（無草稿需求則只做 ctx 與關閉）。
7. `ui/popup/popup.js`：選取入口先 `openPanel` 再 `ENTER_PICK`。
8. `ui/report/tasks.js`：編輯改 `openPanel(自己的 tabId,'picker')` + 寫 `{kind:'edit'}`。
9. `tests/chrome-mock.js`：`sidePanel.{open,setOptions,close,onClosed}`、`storage.session`、`tabs.onRemoved`（已有則沿用）。
10. 舊測試六處改斷言 `sidePanel.open`／`setOptions`。

### 測試／驗收

- 新測試檔 `tests/s3_side_panel.test.js`：
  - 四個入口各自：`sidePanel.setOptions` 與 `open` 各被呼叫一次且 `tabId` 正確、`kind` 對；右鍵入口在 PICKED 前 session 是 `{kind:'waiting', purpose:'task'}`；PICKED 後變 `{kind:'new', ctx}` 且 ctx 含 `picks`/`locator`/`nameHint`（鏈結測試補進 `m2_chain`）。突變：拿掉 session 寫入 → 紅。
  - `chrome.sidePanel` 缺席 → `windows.create` 被呼叫（退路）且 `diag` 有一筆；`open` 拋錯 → 同。突變：拿掉退路 → 紅。
  - 三條清場通道各觸發一次 → 對該 tab 送 `EXIT_PICK`（D13：第三參數必帶）且 session 鍵被清；同一 tab 重複觸發不重複送（冪等）。突變：拿掉 `closePanelFor` 的任一通道 → 該通道案例紅。
  - 面板已是 `new` 表單、使用者改過名稱與排程 → 新 PICKED 到達 → session 的 `draft` 保留名稱／排程、`ctx.picks` 換新；面板 `render` 後摘要卡描述新目標、名稱欄仍是使用者改的。突變：改回整包覆蓋 → 紅。
  - 草稿：欄位變動後 session `draft` 更新；面板重新 `render` 從草稿還原。
  - 「回頁面重選目標」→ `ENTER_PICK{purpose:'task', tabId, preselect}`，`preselect` 等於目前 picks。
  - `windows.create` 在 `src/` 只允許出現在 `shared/panel.js` 與 `fetcher.js`（grep 斷言，放 `a4_conventions`）；`picker.html?`／`site.html?` 帶 query 的字串在 `src/` 零命中。
- `picker-mode`：`confirmPick`（task）後 `[data-af-picked]` 仍在、`[data-af-overlay]`／工具列／面板為 0、`body.style.userSelect` 已還原、頁面 `click` 不再被攔（派發 click 到連結，`defaultPrevented === false`）；`ENTER_PICK{purpose:'preaction'}` 後按 `Esc` → task 群的 `data-af-held` 仍在、preaction 的 overlay 清掉；`EXIT_PICK` → 全部為 0。突變：`confirmPick` 改回 `exitPickMode` → 紅；`Esc` 改清全部 → 紅。`repick` 送出後不留標示。
  - **跨案例污染防護**：既有 `l7_batch_b3:373` 等用 `exitPickMode()` 清場的測試維持語意（無參數＝全清）；新增的 held 測試自己在 `after` 呼叫 `exitPickMode()`。
- `cancelled` 順序：preaction 取消 → 面板收到 `{purpose:'preaction', cancelled:true}`。突變：把 return 移回前面 → 紅。
- repick：PICKED 後 `rebuildAlarms` 被呼叫、自己開的分頁被 `tabs.remove`、使用者原有分頁不被關。
- 版面：jsdom 測不了寬度，改在 `run_smoke.sh` 加一段：以 B-0 實測最小寬度截圖 picker（含多值清單與進階展開）與 site，人工核對；並在 `p4_ui_css` 加「`picker.html`／`site.html` 不含 `min-width` ≥ 360 的固定值」掃描（先斷言掃到的規則集合非空）。
- 煙霧（Chrome 與 Edge 各一次）：右鍵 → 面板開在旁邊顯示等待態 → 點格 → 面板切表單、藍框仍在 → 切去別的分頁再切回 → 表單內容還在 → 再右鍵選另一格 → 目標換了、名稱排程沒變 → 儲存 → 面板關、藍框消失。另一條：填到一半按面板的 X → 藍框消失。

---

## 作業 A：前置動作靈活化（P1）

### 現況與核對結果

- 三型 `waitFor`/`click`/`wait`（SPEC §4:420–431；`picker.js:1729`）。`click` 只 `el.click()`（content/main.js:135），不派發 pointer/mouse 事件、不 `scrollIntoView`。`waitFor` 只監聽 `childList`（main.js:170），不看 attributes、不判可見。
- background 逐動作 `locateFrame` 後送單一動作（fetcher.js:385–409）；`wait` 由 background 自己等。立即測試與正式抓取同一條路徑。
- 順手：`wait` UI 寫「等待秒數」欄位卻是毫秒；`waitFor` 逾時訊息 `preaction_timeout` 英文且不含第幾步；`collectValues` 的 `timeoutMs: NaN` 與 `buildTask` 兩層預設；`lastPreActionPickRow` 指向孤兒節點的防護。

### 定案

1. 新增動作型 **`hover`**（「移到元素上」）：`scrollIntoView` 後對目標派發 `pointerover`→`pointerenter`→`mouseover`→`mouseenter`→`mousemove`（`bubbles` 依規格，`*enter` 不冒泡要對祖先鏈逐一派發），並在頁面上**保持游標語意**：可設「停留毫秒」`holdMs`（預設 300，暫定），停留期間每 100ms 再派一次 `mousemove`（有些選單靠持續 hover）；停留結束不派發 `mouseout`（下一個動作通常是點選單，離開會讓它收起）。
2. **`click` 改派完整序列**：`scrollIntoView` → `pointerover/mouseover` → `pointerdown` → `mousedown` → `focus`（可聚焦時）→ `pointerup` → `mouseup` → `click()`；`el.click()` 仍在最後（保留原生 activation 行為）。
3. **`waitFor` = 出現且可見**：可見判準「在 DOM 中、`getClientRects().length > 0`、`visibility !== 'hidden'`」（暫定；jsdom 沒 layout，測試以替身注入判準）；MutationObserver 加 `attributes: true, attributeFilter: ['class','style','hidden','aria-hidden']`。新增選項 `visible`（預設 true，舊任務沒有這個鍵 = true；要等「存在即可」可關）。
4. **失敗訊息一律中文含第幾步與型別**：「前置動作第 2 步（等元素出現）逾時 20 秒」「前置動作第 3 步（點擊元素）找不到元素」；frame 定位失敗那句既有格式對齊。訊息一路走到紀錄 `error` 與立即測試的 `#errors`。
5. **`wait` 單位統一為秒**：UI 欄位「秒」、資料欄位改 `sec`（小數允許）；**舊資料相容**：讀到 `ms` 就換算，`buildTask` 存檔只寫 `sec`（讀寫都在 picker 與 fetcher，各一處換算，換算函式放 `shared/`）。
6. 使用者用 `hover → waitFor → click` 三列組合覆蓋「移過去等選單再點」；**不做複合型動作**（一列做三件事的設定會比三列更難懂，且失敗時不知道卡在哪一步）。
7. 順手：`timeoutMs` 預設只留 `buildTask` 一份（`collectValues` 不填就 undefined）；`lastPreActionPickRow` 回填前檢查 `isConnected`。
8. **誠實交代做不到的事**（寫進 SPEC §4 與 Picker 的前置動作說明一行）：合成事件 `isTrusted` 為 false，**純 CSS `:hover` 展開的選單不會因 `hover` 動作打開**，只認 `isTrusted` 的框架也不會反應。可行的替代路徑要一起寫給使用者：選單項目多半早在 DOM 裡，`waitFor`（關掉「要等到看得見」）→ `click` 直接點隱藏的項目通常有效。沒有這一行，使用者會以為功能壞了。
9. 設定匯出入（`shared/settings-io.js`）對 `preActions` 沒有型別白名單，`hover`／`sec` 原樣通過；**匯入舊檔的 `ms` 由讀取端換算**（同定案 5，同一個函式）。任務頁「前置 N」徽章不動。
10. 立即測試對前置動作的逐步結果：目前只回「第 N 步失敗」；成功時看不到每一步做了什麼。本輪在 dryRun 回傳加 `preActionTrace: [{step, type, ms, ok}]`（暫定欄位），Picker 的 `#test-note` 顯示「前置動作 3 步完成（1.2 秒）」——使用者調 hover 選單時最需要知道「hover 有做、是 click 沒點到」還是「hover 就失敗」。

### 改動

1. `content/main.js`：`handlePreActions` 加 `hover` 分支、`click` 改事件序列、`waitFor` 加可見性與 attributes 監聽；事件派發抽成同檔小 helper（`dispatchPointerSequence`，暫名）。
2. `background/fetcher.js`：`hover` 走與 `click` 相同的 frame 定位與 20 秒逾時；訊息格式化集中一處（含第幾步）。
3. `ui/picker/picker.js`／`picker.html`：下拉加「移到元素上」；欄位顯隱（hover：選取鈕 + 停留毫秒；waitFor：逾時秒 + 「要等到看得見」勾選；wait：秒）；`collectValues`／`buildTask`／回填三處。
4. `shared/`：`preActionMs`↔`sec` 換算與訊息格式（`shared/preaction.js`，暫名，兩端 import）。
5. SPEC §4 前置動作段改寫。

### 測試／驗收

- `tests/s4_preaction_hover.test.js`：
  - `hover`：目標收到的事件序列（型別與順序）如定案 1；祖先收到 `mouseenter`；`holdMs` 期間再派 `mousemove`（用假計時器）；結束不派 `mouseout`。突變：拿掉 `mouseenter` 派發 → 紅。
  - `click`：綁在 `pointerdown` 的 handler 被觸發；`el.click()` 仍被呼叫。突變：改回只 `click()` → 紅。
  - `waitFor`：元素已在 DOM 但 `hidden` → 不解決；移除 `hidden`（attributes 變動）→ 解決；`visible:false` 時 hidden 也解決。突變：拿掉 `attributes: true` → 紅。
  - 失敗訊息：逾時／找不到／frame 定位失敗三種，斷言含「第 N 步」與型別中文，並一路到 `fetcher` 寫入紀錄的 `error` 與 dryRun 回傳（鏈結）。
  - `wait`：`{sec:1.5}` 等 1500ms；舊 `{ms:3000}` 等 3000ms；`buildTask` 對舊列存出 `sec`。
- `f5_foreground_pre`、`o5_preaction_frame`、`o7_preaction_pick_entry` 維持綠（既有 click 用途的斷言若只驗 `click()` 被呼叫，維持）。
- grep 正式碼無 `preaction_timeout`／`preaction_not_found` 直接露出給使用者（只允許作內部代碼並被格式化）。
- dryRun 回傳含 `preActionTrace`，每步 `ok` 與 `ms`；Picker `#test-note` 顯示步數與總秒數（從 fetcher 一路斷言到畫面）。突變：拿掉 trace → 紅。
- 匯入含 `{type:'wait', ms:3000}` 的舊設定檔 → 執行等 3000ms；匯入 `{type:'hover'}` 不被丟棄。
- SPEC §4 與 Picker 說明含「純 CSS hover 選單不支援」與替代路徑那一句（文件稽核項）。

---

## 作業 E：收官

1. 版本 `0.8.0 → 0.9.0`（`manifest.json` 與 `package.json` 兩處）。
2. SPEC：§2（鎖表／換表語意、held 狀態、side panel）、§4（前置動作）、§7（判準合一）、§9（`sidePanel` 權限）、§13（114+）；BACKLOG 刪三條（判準合一、helper 併入、ctx 走 session）、加「面板寬度自訂／記憶」「hover 後 `mouseout` 收尾動作」（有需求再做）。
3. CLAUDE.md：side panel 唯一入口、表格判準唯一來源、`held` 狀態要在 `ENTER_PICK`／`EXIT_PICK` 兩端清。
4. 全量 `npm test` 與 `./run_smoke.sh`（Chrome for Testing）；煙霧要涵蓋 side panel 手勢與 360px 版面。結果寫進「體檢交接」。

---

## 明確不做（本輪定案）

- **焦點跟隨式的「最上層」**：使用者選 side panel，不做。
- **複合型前置動作**（一列 hover+等+點）：三列組合更清楚、失敗定位更準。
- **結構 A 外層格串接的解析改善**：DOM 上就是那樣，只做可見提示。
- **從面板回頁面加選一個值**（BACKLOG 既有）：side panel 讓它變容易，但新任務 ctx 暫存流程仍是另一輪的事；BACKLOG 觸發條件更新為「side panel 已就位，使用者反映時做」。
- **面板寬度記憶／自訂**：side panel 由瀏覽器管理寬度。
- **`repick` 改在面板內操作**：維持任務頁入口；但新任務面板的「回頁面重選目標」已做（定案 B-5），編輯既有任務時是否也給同一顆鈕（等於把 repick 搬進面板）→ BACKLOG，觸發條件「使用者反映任務頁的重選要另開分頁很麻煩」。
- **編輯任務時把面板開在目標網址的分頁上**（而不是 Report 分頁）：需要找分頁邏輯與「分頁不存在時怎麼辦」的分岔；BACKLOG，觸發條件「使用者反映編輯時想同時看到頁面」。
- **`hover` 之後的 `mouseout` 收尾動作**：目前不派發；BACKLOG，有站台需要「移開才關選單」時。
- **面板寬度記憶／自訂**：side panel 由瀏覽器管理寬度。
- **前置動作的複合型**與**結構 A 解析改善**：見上。

## 複檢（規劃完成後）

- **與既有設計的衝突**：(1) SPEC §2「滑鼠移到另一張表格時才清空」→ 作業 C 明寫推翻；(2) AF-9「換表讓復原快照失效」→ 作業 C 改為「換表存快照」並說明理由；(3) SPEC §2「Picker 視窗尺寸由 `background/main.js` 開窗時給（600×820）」與「頁面不得寫死寬度」→ 作業 B 改為 side panel，寬度由瀏覽器管；(4) BACKLOG「ctx 改走 `storage.session`」→ 作業 B 直接做；(5) CLAUDE.md「UI 不得直接呼叫 `chrome.storage`」→ session 讀寫也走 `shared/storage`。
- **批次之間**：C 與 B 同動 `picker-mode.js`（C 改 hover／click 狀態機，B 改送出後的收尾）——順序 C 先併，B 以 C 的結果為基準；D 的 helper 名稱定案後 C 才開工。A 與其他作業無共檔。
- **四個坑**：
  - 什麼算一個／分母為零：作業 D 交叉測試先斷言 fixture 非空；`p4_ui_css` 掃描先斷言規則集合非空；作業 C「另一張不相干的表」定義 = 與 `pickedTableEl` 無祖孫包含關係的表格元素。
  - 破壞性判準的反例：作業 C 唯一破壞性動作是「點另一張表的格子」，反例是「點同一張表的巢狀內層格」（不算換表，走原有取代語意）與「點表格縫隙」（什麼都不做）——兩者都列進測試。
  - 單向閘門：作業 B 的 `held` 狀態出口有兩條（面板關閉、下一次 `ENTER_PICK`），分頁關閉時節點隨頁面消失不需清；`storage.session` ctx 的清除有面板斷線與 `tabs.onRemoved` 兩條。作業 A 的 `visible` 預設 true 可關。
  - 移除類的依賴方：作業 D 刪 picker-mode／block-detect 的 helper 前 grep 全部呼叫點（已列白名單）；作業 B 移除 `windows.create` 三處與 `tabs.create` 編輯入口，依賴方是六個測試檔（已列）與 `fetcher.js:305`（不在移除範圍）。
- **升級／既有資料**：`wait` 的 `ms→sec` 讀寫相容；`waitFor` 無 `visible` 鍵 = true；舊任務其餘欄位零遷移。side panel 需 114+，舊版瀏覽器會在 `chrome.sidePanel` 不存在時報錯——`openPanel` 入口要判 `chrome.sidePanel` 存在，否則退回 `windows.create` popup（保留這一條退路即為「舊版相容」，`fetcher.js` 以外 `windows.create` 的 grep 斷言改為「只允許出現在 `openPanel` 的退路與 `fetcher.js`」）。
- **暫定事項清單**（執行時可推翻，需在執行紀錄寫理由）：`onMessage` 內的手勢是否延續、`onClosed` 是否在切分頁時誤觸發、全域 `enabled:false` 的必要性、儲存後關面板的做法、面板取得自己 tabId 的方式、最小寬度實測值、`holdMs` 預設 300、可見判準細節、`preActionTrace` 欄位、helper 名稱。
- 複檢完成，新增事項：舊版瀏覽器退路（已補進上一點）。

### 第二次複檢（四個角度，2026-09-09）

**整體專案角度**——補進規劃的：popup 也是選取入口（B-2）；三處 query 參數全改 session（B-3）；`storage.subscribe` 只聽 `local`（B-3）；設定匯出入無白名單、舊檔 `ms` 讀取端換算（A-9）；Edge 煙霧要跑（B 驗收）；README 相容說明（B-12）。
**程式面角度**——補進規劃的：`runtime.connect` 斷線不能當「面板關閉」訊號（分頁切換與 SW 重啟都會斷），改三通道冪等清場（B-7）；`held` 分群，`Esc` 不可抹掉別群（B-6）；鍵盤 `↑↓` 與鎖表的關係（C-7）；`preselect` 進入即鎖表（C-8）；`openPanel` 的退路是執行期判斷（B-1）；side panel 面板文件可能隨分頁切換重載 → 草稿（B-4）。
**尖銳使用者角度**——每句話對到一條定案：「右鍵一下我填一半的表單就沒了」→ B-5 換目標不重置；「切分頁回來表單清空」→ B-4 草稿；「關掉面板藍框還卡在頁面上」→ B-7；「hover 動作打不開我的選單」→ A-8 誠實說明加替代路徑；「測試成功了但我不知道 hover 有沒有做」→ A-10 逐步軌跡；「面板窄到欄位擠成一團」→ B-10 加煙霧截圖；「右鍵沒反應」→ B-13 診斷可見；「我選整欄它給我一個 div」→ C-4；「我按 ↑ 想選外層它不讓我」→ C-7。
**管理者角度**——B-0 探針放最前面，框架事實釘死才動 B；每作業一 commit 可獨立回滾；B 的三個框架行為若不成立各有寫明的退路（不會在實作中即興）；相容門檻（114／141／142）與退路寫進 SPEC §13 與 README；`diag` 讓實測回報有據可查；測試基線只增不減，被取代的舊斷言（六處 `windows.create`）改寫而非刪除。
本次複檢新增事項：B-0、B-3～B-5、B-7 改寫、B-13、C-7～C-9、A-8～A-10、明確不做三條。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| （開工後填） | | | | |
