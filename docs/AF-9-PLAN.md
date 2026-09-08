# AF-9 第 9 輪規劃：零學習曲線的設定流程

> 狀態：實作完成，終檢中
> 基準：dev@5ea5914（1677 綠，v0.7.0）
> 來源：使用者回饋五項（設定視窗版面、工具列選不到、iframe 流程、間隔時段、設定可視化）
> ＋ 以「第一次使用不看說明就會、三個月後回來不用重學」為目標的流程重整。
> 設計依據：`ui-ux-pro-max` 查詢結果只採結構與互動原則（漸進揭露、避免複雜導覽、標籤可見、
> 送出有回饋、可點區 ≥ 28px、reduced-motion）；**配色不採用其建議，維持 `ui/theme.css` 唯一來源**。

## 回饋核對摘要（步驟 1 結果）

| 回饋 | 判定 | 根因 |
|---|---|---|
| P1 捲軸卡中間、視窗太窄 | ✅ | 視窗 480 寬、`picker.html` 的 `body` 寫死 360px；`site.html` 同型（480px） |
| P2 點整欄後選不到 | ✅ | ①鎖定（`lockedEl`）時 mousemove 不更新，點工具列不解鎖；②目標非表格時三段停用，點了靜默無效 |
| P3 iframe 流程 | ⚠️ | 在 iframe 內容上直接右鍵已可直接進入該 frame；使用者是在 iframe 載入前就進了選取模式 |
| P4 間隔要能設時段 | ⚠️ | `schedule.window` 已支援，欄位藏在「進階」 |
| P5 看得出設了什麼 | ⚠️ | 只有多值時有一行摘要，排程零摘要 |

## 定案（與使用者討論後）

- 設計 skill：採用 `ui-ux-pro-max`（範圍如上）。
- P3：不改鑽入流程；面板加教學句指向「Esc → 讓內容出現 → 在內容上右鍵」。
- 點格後點「整欄／整列」＝**取代**成該格所屬整欄／整列。
- 排程：不做 daily 混合多時段；維持 daily 多時刻 + interval 單時段。
- 儲存後顯示「已儲存，下次 HH:mm 抓取」＋「開啟報表」一秒半再關窗。
- 使用說明：**不做獨立教學頁**；popup 只留一行連結指向 Report 設定頁既有說明區（若無，連到任務頁空狀態）。教學責任由「狀態驅動的一句指令」承擔。
- 點擊語意維持 AF-8 試算表語意，補「取代可復原」。
- 儀表板預設改為「加入預設儀表板、卡片數字＋折線」（暫定，執行端依 layout-store 事實調整）。
- 「數值類型」「目標網址」是程式已知事實，搬進「進階」，摘要卡用一句話表達。
- popup 加主要按鈕「在這個頁面選取」（`ENTER_PICK{purpose:'task', tabId, frameId:0}`，background 既有路徑）。

## 作業總覽

| 作業 | 內容 | 規模 | 相依 | 執行者 |
|---|---|---|---|---|
| B 排程與描述函式 | `shared/describe.js`（目標／排程白話句唯一來源）、`nextIntervalRun` 搬 `shared/`、排程區改版（時間 chip、時段勾選、觸發預覽）、任務頁沿用 | 中 | 無 | agy |
| C 選取模式 | 鎖定 bug、整欄取代、取代可復原、動作列建一次、面板閃避、狀態指令句、iframe 教學句、停用提示 | 中 | 無 | agy |
| A 設定視窗重排 | 流式寬度、三張卡＋摘要卡、數值類型／網址進進階、儀表板預設、多值列每值結果與一鍵命名、儲存回饋 | 大 | B（摘要句） | 地端 LLM 先試，卡住轉 agy |
| D 入口與收尾 | popup「在這個頁面選取」＋說明連結、`site.html` 寬度、版本號 0.8.0、SPEC/BACKLOG | 小 | A、B、C | 地端 LLM |

建議順序：B → C → A → D。整輪委派模型：B、C 用 agy；A、D 先地端 LLM（中途切換須註明起點且不換回）。

---

## 作業 B：排程與描述函式

### 現況與核對結果
- `background/scheduler.js:159` `nextIntervalRun(task, nowMs)` 純函式，讀 `schedule.everyMinutes / weekdays / window.from / window.to`；UI 不能引用 background 模組。
- `ui/picker/picker.js:350-360` `buildTask` 已寫 `schedule.window`；驗證在 193-221（同填同空、`TIME_RE`）。
- `picker.html:279-280` 時段欄位在 `<details id="advanced-section">` 內。
- `ui/report/tasks.js:213-221` 排程文字只寫「每日 HH:mm」「每 N 分鐘」，沒有星期與時段。
- `#times` 是逗號分隔文字框。

### 定案
- 新增 `shared/describe.js`：`describeSchedule(schedule)` 與 `describeTarget(task 或 picker 值)` 兩個純函式，**全站唯一**的白話描述來源（picker 摘要卡、任務頁、popup、儲存回饋都用它）。
- `nextIntervalRun` 與其輔助函式搬到 `shared/schedule-math.js`（名稱暫定），`background/scheduler.js` 改為 import 並 re-export，呼叫端零改動。
- 排程區（在「多久抓一次」卡內）：
  - 型別切換維持下拉（每日固定時間／固定間隔）。
  - 每日：`<input type="time">` ＋「加入」鈕，時刻顯示為 chip（含移除 ×），去重、排序；儲存形狀仍是 `times: ['09:30', ...]`。
  - 間隔：一列「每 [N] 分鐘」，下方勾選「只在 [from] ～ [to] 之間」；未勾時不寫 `window`，勾了才顯示兩個 `type="time"` 欄位並要求同填。
  - 星期改成七顆可切換 chip（`aria-pressed`），形狀仍是 `weekdays` 陣列。
  - 觸發預覽（`#schedule-preview`，`role="status"`）：以 `describeSchedule` 為第一行；interval 另列出以「今天 00:00」為基準的前 6 個觸發時刻與當日總次數（用 `nextIntervalRun` 迭代；時段跨午夜時只列今天的段）。輸入不合法時顯示錯誤句而非空白。
- 任務頁排程欄與 popup 的排程文字改用 `describeSchedule`。

### 描述句契約（`describeSchedule`）
- daily：「每日 09:30、15:00，週一～五」；七天全勾寫「每天」；不連續星期以頓號列出。
- interval 有時段：「08:30～09:20 之間每 10 分鐘，週一～五」；無時段：「每 10 分鐘，每天」。
- 缺 `schedule` 或型別未知：「未排程」。`weekdays` 缺省或空陣列＝每天（與 `nextIntervalRun` 同一規則）。

### 改動
1. 新增 `shared/describe.js`、`shared/schedule-math.js`；`background/scheduler.js` 改 import。
2. `picker.html` 排程區重排（時段欄位從進階搬出）；`picker.js` 讀值／驗證／回填改接新控制項，`buildTask` 輸出形狀不變。
3. `tasks.js`、`popup.js` 排程文字改呼叫 `describeSchedule`。

### 測試／驗收
- `describeSchedule` 純函式測試：上述四種句型＋七天全勾＋空 weekdays＋未排程，逐句相等。
- `nextIntervalRun` 既有測試（`d14_interval_align`、`d15_interval_wiring`）全綠；`background/scheduler.js` grep 不到函式本體（只剩 import/re-export）。
- picker 表單：加入 09:30、09:30、15:00 → chip 兩顆且排序；移除後 `buildTask.times` 同步。interval 勾時段填 08:30/09:20/每 10 → 預覽含「08:30」「09:20」「共 6 次」；取消勾選 → `buildTask` 無 `window`。
- 編輯既有 interval 任務（帶 window）→ 勾選為勾、欄位回填。
- 突變：把 `describeSchedule` 的「每天」判定改壞，測試要紅；把預覽迭代的「嚴格大於現在」改成 ≥，`d14` 要紅。
- 任務頁測試：interval 任務含時段時列文字含「之間」。

---

## 作業 C：選取模式

### 現況與核對結果
- `content/picker-mode.js:1319` 鎖定時 mousemove 直接 return；工具列 click（1490-1509）不解鎖。
- 工具列停用（`aria-disabled`）被點時靜默 return（1492-1494）。
- 沒有「已選單格 → 點整欄」的升級邏輯；pick 形狀：cell `{cell:{row,col}}`、col/row `{block:{axis,index,headerText}}`。
- `updatePanel` 每次 hover 重建「完成／取消」（BACKLOG 記載，本輪納入）。
- `Ctrl+Z` ＝ 移除最後一項；「點一下取代」在 preselect ≥2 時才有二次確認。
- 面板固定右下角；鑽入 iframe 後 `initialTarget` 為 null，面板只寫「把滑鼠移到要抓的內容上」。

### 定案
- 切換工具列模式一律解除鎖定並重畫標示。
- 已選清單**最後一項是單格**且點「整欄」／「整列」：以該格的欄／列索引與表頭產生 `{block:{axis,index,headerText}}` **取代**那一格（其餘已選不動）；最後一項不是單格或清單空時只切模式。
- 取代可復原：任何「取代」（點一下取代整批、單格升級整欄）都把被換掉的清單存成一份復原快照；面板顯示「已換成這一格（復原）」，`Ctrl/⌘+Z` 或點「復原」還原整批並清掉快照；沒有快照時 `Ctrl+Z` 維持「移除最後一項」。快照在 `exitPickMode` 與任何加選／移除後清空（只保留到下一個動作之前）。
- 停用的段被點到：不改模式，面板一句原因（「先把滑鼠移到表格上」／「這個用途一次只選一個」）。
- 動作列（完成／取消／復原）建一次，之後只更新文字、`aria-disabled`、主色樣式；有已選時「完成」用主色。
- 面板閃避：游標進入面板外圍 24px（暫定）且不是在面板上操作時，面板移到左下角；再靠近再換回。**面板上有焦點或滑鼠正在面板內時不移動**。
- 面板第一行改為狀態驅動的**動作指令句**，唯一一份規則：
  - 目標為空或非表格且非 iframe 代理層：「點你要抓的那個值；內容還沒出現？按 Esc，先操作頁面讓它載入，再在它上面按右鍵」
  - 表格、未選：「點你要的那一格；點表頭可選整欄」
  - 表格、已選 N：「已選 N 個值，再點可換、Ctrl 點可加，好了按完成」
  - iframe 代理層：維持「進入這個框架」
  - preaction / login：維持既有句。
- SPEC §2 的滑鼠語意表新增「已選單格 → 點工具列整欄／整列＝取代成該欄／列」一列，並記「取代可復原」。

### 改動
1. `content/picker-mode.js`：工具列 click 分支解鎖＋升級取代＋停用提示；復原快照與 `Ctrl+Z` 順序；動作列一次建立；面板閃避；指令句函式。
2. `tests/p3_pick_toolbar.test.js` 補：鎖定→點整欄→hover 資料格有 `data-af-cell`；單格已選→點整欄→已選長度 1 且為 `block.axis==='col'` 同索引；停用段被點面板出現原因句。
3. 新測試檔（復原）：點 A、點 B（取代）→ `Ctrl+Z` → 已選是 A；再 `Ctrl+Z` → 空；加選後快照清空。
4. 新測試（動作列）：連續 hover 三格後 `[data-af-done]` 是同一個節點；完成文字更新。
5. 面板閃避測試：mousemove 到面板外圍座標 → 面板 `style.left` 非空／`right` 為空；滑鼠在面板內不移動。
6. 指令句測試：四種狀態各斷言第一行文字。

### 測試／驗收
- 上述測試全綠，且突變：把「解鎖」那行拿掉 → 鎖定測試紅；把取代改成 push → 升級測試紅；把快照清空拿掉 → 「加選後快照清空」紅。
- `exitPickMode` 重設清單要含新增狀態（快照、面板位置、動作列參照）；「連續選兩次」既有測試維持綠。
- grep 正式碼無 `__test`、測試檔名、`Error().stack`。

---

## 作業 A：設定視窗重排

### 現況與核對結果
- `picker.html` body 360px 固定；七個分節平鋪；`#save-summary` 只在多值時顯示；`#block-summary` 在區塊區內。
- `TEST_TASK` 走 `runTask(dryRun)`，多值回 `values` 陣列（SPEC §4），picker 只顯示第一個值。
- 儀表板預設「不加入」；`layout-store` 有 `getDefaultDashboardId`。
- 儲存後直接關窗。

### 定案
- `body` 寬 100%、視窗開 560×820（暫定）；捲軸貼齊右緣。
- 版面：標題列（任務名稱可直接編輯，取代「任務名稱」欄位）→ **摘要卡**（三行：抓什麼／多久抓／放哪裡，`role="status"`，任何欄位變動即時重算；文字來自 `describeTarget`、`describeSchedule`）→ 卡 1「抓什麼」（值清單、列／欄定位、聚合方式、即時預覽與立即測試）→ 卡 2「多久抓一次」（作業 B 的排程區）→ 卡 3「放哪裡」（儀表板、卡片型別 chip）→ 進階（數值類型、目標網址唯讀、策略、正規式、告警、前置動作、固定為預設值）。
- 多值清單每列：序號、名稱輸入、位置說明（「列標題 · 欄標題」或位置定位字樣）、測試結果格（未測 `—`；成功綠值；失敗紅 `—` 且 `title` 為錯誤句）。立即測試回來以 `values[].name` 對應到列（名稱重複時依序對應）。
- 一鍵命名：「用欄標題」「用『列 · 欄』」兩顆小鈕，只重設 `_afAutoName` 未被手改的列（沿用既有基準值機制）。
- 儀表板預設：新任務預設選預設儀表板、卡片「數字＋折線」；編輯既有任務不套用預設（維持 §2.1 規則）；`pickerDefaults.last/pinned` 含這兩個值。
- 儲存回饋：儲存成功 → 表單區替換成「已儲存。下次抓取：HH:mm（來自 `GET_NEXT_RUNS`；取不到就用 `describeSchedule`）」＋「開啟報表」鈕，1.5 秒後關窗；點「開啟報表」立即開報表並關窗。失敗維持在 `#errors` 顯示。
- 所有既有欄位 id 不變（測試與 `buildSpec`/`buildTask` 依賴）；只有換外層容器與新增元素。

### 改動
1. `background/main.js` 兩處 `windows.create` 尺寸；`picker.html` 版面與 `<style>`；`ui.css` 新增摘要卡與 chip 切換樣式（**必須有頁面使用**）。
2. `picker.js`：摘要卡更新函式（呼叫 `shared/describe.js`）、多值列結果對應、一鍵命名、儀表板預設、儲存回饋。
3. `site.html` 寬度改流式（同型缺陷，併此段）。

### 測試／驗收
- `picker.html`/`site.html` grep 不到 `width: 360px`、`width: 480px`。
- 摘要卡：填入單格 ctx → 第一行含「這一格」；改排程為 interval 含時段 → 第二行含「之間」；改儀表板 → 第三行變動。
- 多值：模擬 `TEST_TASK` 回 `values` 兩筆一成一敗 → 兩列結果格分別為值與 `—`＋`title`。
- 一鍵命名：手改第 2 列後按「用『列 · 欄』」→ 第 1 列變、第 2 列不變。
- 新任務預設儀表板選項非 `none` 且卡片 number、line 勾選；編輯既有任務不變。
- 儲存回饋：儲存後 DOM 出現「已儲存」與「開啟報表」；`window.close` 在 1.5 秒後被呼叫（假時鐘）。
- 既有 picker 測試全綠（欄位 id 未變）。突變：摘要卡更新函式不呼叫 `describeSchedule` → 摘要測試紅。

---

## 作業 D：入口與收尾

### 定案
- popup 頂部主要按鈕「在這個頁面選取」：查目前分頁，送 `ENTER_PICK{purpose:'task', tabId, frameId:0}`；`chrome://` 等不能注入的頁面顯示「這個頁面無法選取」不報錯。按鈕下一行小字連結「怎麼用？」→ 開 Report 任務頁（空狀態已有三步驟引導句）。
- 版本 0.8.0（`manifest.json` 與 `package.json`）。
- SPEC §2（滑鼠語意表、面板指令句、工具列升級、復原、閃避、視窗版面）、§2.1（儀表板預設）、§4（描述函式與 `schedule-math`）、§8.4／§12.2（描述函式沿用）更新；BACKLOG 移除「動作列建一次」，新增「從設定視窗回頁面加選」「面板可拖曳（閃避不夠時）」。

### 測試／驗收
- popup 測試：按鈕存在、點擊送出的訊息 `purpose==='task'` 且帶 `tabId`；`chrome://` 顯示提示。
- `a4_conventions` D3b 版本一致。
- 全量測試 ≥ 1677＋本輪新增，零紅。

---

## 明確不做（本輪定案）
- daily 混合多時段、interval 多時段。
- 從設定視窗回頁面加選（新任務尚無 id；BACKLOG，觸發：使用者反映存了才想加值）。
- 點擊語意改成「點一下切換」（維持 AF-8 定案，以復原補救）。
- 獨立使用說明頁。
- 面板拖曳（先做閃避）。
- iframe 代理層隨版面重排更新（維持 BACKLOG；P3 以教學句處理）。

## 規劃完成後複檢
- 與既有設計衝突：`Ctrl+Z` 語意由「移除最後一項」改為「先復原取代」——SPEC §2 明寫舊語意，本輪推翻並更新；`p3` C-2「切換不清空」測試與「單格升級取代」相容（升級只動最後一項且需已選單格）。儀表板預設改變 `BUILTIN_DEFAULTS`，`pickerDefaults.last` 舊資料缺此鍵時退回內建，不影響舊使用者。
- 批次衝突：A 依賴 B 的 `shared/describe.js`；A 與 B 都改 `picker.html` 排程區——B 先完成，A 只搬容器不改排程控制項。C 與 A 不重疊檔案。
- 漏掉的細節：面板閃避在面板有焦點時不動（已寫）；復原快照的清空時機（已寫）；`values` 名稱重複的對應（已寫依序）；`GET_NEXT_RUNS` 取不到的退路（已寫）。
- 複檢完成，無新增事項。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| B 排程與描述 | Claude（agy 無額度，改自行實作） | 完成 dev+24 → 1701 綠 | r1_describe 13 例、r2_schedule_ui 11 例；突變 5 處全紅 | ①popup 本來就沒有排程文字，PLAN「popup 沿用 describeSchedule」是空條目，改為只有任務頁沿用。②時段欄位改「勾選才展開」與 c8 舊測試衝突，依定案更新該測試。③額外抽出 `buildSchedule`（存檔與預覽共用），避免兩份組裝 |
| C 選取模式 | Claude | 完成 → 1719 綠 | r3_pick_flow 18 例；突變 7 處，1 處未紅 | 未紅那處查出是**死程式碼**（目標是表格時不可能處於鎖定），已移除，改驗停用分支的解鎖。另新增規劃沒寫的 `pendingMode`：點停用的整欄會記住意圖，滑鼠移到表格自動套用——否則從最上層進選取模式時點整欄仍然完全沒反應 |
| A 設定視窗 | Claude | 完成 → 1732 綠 | r4_picker_summary 11 例；突變 4 處全紅 | ①p6 版面測試因重排過時，依定案改寫。②j1 兩例因「單值預設數字＋折線」過時，依定案改寫。③`showSavedFeedback` 的延遲關窗會關到別人的視窗（jsdom 共用全域 window），加上視窗歸屬判定。④下次執行時間的查詢移到「儲存中」期間，否則「儲存中不可連按」出現空窗 |
| D 入口與收尾 | Claude | 完成 → 1736 綠 | r5_popup_entry 4 例；突變 1 處紅 | 視窗尺寸取 600×820（PLAN 暫定 560×820），配合三張卡的欄寬 |
| 煙霧測試 | Claude | Chrome 與 Edge 全部通過 | `./run_smoke.sh` | 面板指令句在真實瀏覽器可見 |
