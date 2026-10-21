# AF-24 第 24 輪規劃：體驗、重構、除錯、文件同步

> 狀態：**規劃完成，待使用者確認後開分支實作**
> 基準：dev@eabe46f（`npm test` 3323 綠、約 30 秒；manifest／package 0.22.0，schema 4）
> 來源：使用者要求的四個方向——(1) 使用者體驗 (2) 不過度設計下符合 SOLID／KISS／DRY (3) 盤點並清 bug (4) 文件與程式碼同步。
> 日期：2026-10-21 稽核與草案／2026-10-22 定案與複檢（Asia/Taipei）
> 核對方式：六個分區稽核子代理只讀回報 → Claude 逐條親驗高嚴重度主張；archive 與 evidence 未讀。
> 本輪目標版本：**0.23.0**（manifest 與 package.json 同步）。

## 作業總覽

| 作業 | 內容 | 規模 | 相依／順序 |
|---|---|---|---|
| A 衛生與文件基礎 | 重複檔、CLAUDE.md 結構圖、README、BACKLOG、SPEC §5 鍵、測試前綴說明 | S | 最先 |
| B 資料正確性 | 數值解析、schemaVersion、匯出日期、比較功能、Picker 存檔合併、回填、站台面板 | M | A 之後；B3 先於 G2 |
| C background 可靠性 | 錯過清單鎖、失敗收尾單一入口（重試範圍＋通知）、卡住接管擁有權、啟動韌性、徽章、multi／alarm 判斷單一來源 | M | B 之後；完成後跑煙霧 |
| D 選取模式鍵盤與群組一致 | 群組鍵盤走草稿佇列、Ctrl+Enter、取名互斥、Tab 還給焦點、aria、exit 全重設、檔內收斂 | M | C 之後；完成後跑煙霧 |
| E Report 一致性 | 儀表板序號守門、拖曳統一走 dnd.js、月曆、讀取失敗提示、上限與調色盤一份、頁籤鍵盤 | M | D 之後 |
| F popup／面板與命名 | 全部暫停重算燈號、暫停鈕文字、用詞統一、測試痕跡、主題即時切換、`#test-note`、站台存檔展開、命名收成 shared 一份 | S | E 之後 |
| G 結構整理（純搬移） | main.js 路由表＋兩個領域檔；picker.js 純函式 `form.js`；死碼清理 | M | 最後一個程式作業 |
| H SPEC 結構整理 | §2 拆子節、流水帳改現況句、§7 子標題、不同步清單逐條補寫 | M | 全部程式作業之後、收尾前 |

**委派模型**：使用者指定 **subagent 一律 sonnet／medium**（Agent 工具 `model: sonnet`、`effort: medium`）。整輪只用這一種；Claude 親寫每段規格、親驗每段、絕不採信執行端摘要。每段實作與其測試同一段交付。

**實作紀律**（摘自 CLAUDE.md，每段規格都附）：不得為了通過驗收改寫無關既有程式碼；正式碼不留測試後門；grep 類驗收比對基準數量；動到 background／content 的作業完成後跑 `./run_smoke.sh`；突變驗證還原只用檔案備份。

## 0. 核對表

標記：✅ Claude 親自核對成立；⚠️ 子代理核對、實作該段前先驗；❌ 不成立。

### 0.1 資料正確性

| # | 主張 | 核對 | 證據 |
|---|---|---|---|
| P1 | `parseNumber` 七種輸入靜默算錯：`1.5e3`→1.5、`−12`(U+2212)→12、`－12`→12、`1，234`→1、`1．5`→1、`- 12`→12、`.5`→5 | ✅ 實跑 | `shared/extract.js:81-121` |
| P2 | `schemaVersion` 缺省語意兩份：`init()` 視為 4、`getSchemaVersion()` 視為 1；缺版本號又有明文密碼的資料會跳過 1→2 加密 | ✅ | `storage.js:497` vs `:548`；`tests/a2_storage.test.js:150` 鎖定「缺省＝現行版本」 |
| P3 | v3→v4 無專屬遷移步驟 | ✅ 已釐清：v4 由 AF-22 B1 引入（多來源任務契約），舊形狀由 `task-source.normalizeTaskSources` 在讀取端正規化，**不改寫 storage**；只是 SPEC 沒寫 | `git log -S"SCHEMA_VERSION = 4"` → a14bc4a |
| P4 | 匯出預設「今天」用 UTC 算 | ✅ | `ui/report/settings.js:238,519`、`shared/export.js:207`；`export.js:38-48` 的日期迴圈內部一致用 UTC，不受影響 |
| P5 | 「與另一天比較」丟掉沒有 `slot` 的紀錄，且自寫 `extractTime` | ✅ | `ui/report/logic.js:218,229,238` |
| P6 | Picker 編輯存檔用開面板當下的 `ctx.task` 快照帶 `RUNTIME_FIELDS`，`saveTask` 整份覆蓋 | ✅ | `picker.js:808,877-882,3177-3179,3250`；`storage.js:685-710` |
| P7 | 批次路徑 `existing = { id }`，runtime 欄位全丟 | ✅ | `picker.js:3178` |
| P8 | `fillSchedule`／`render` 回填只在有值才寫，與自身註解矛盾 | ✅ | `picker.js:934-940,1010-1046` |
| P9 | 站台面板 PICKED 不比對來源分頁 | ✅ | `ui/site/site.js:48-58` |
| P10 | 站台存檔整份重建、`loginCheck` 寫死，匯入帶來的欄位一編輯就消失 | ⚠️ | `site.js:433-451` |

### 0.2 background 可靠性

| # | 主張 | 核對 | 證據 |
|---|---|---|---|
| P11 | `refreshMissed` 的 `lastSeenAt` 讀寫在鎖外，啟動與看門狗並行時 gap 重複累加、`lastSeenAt` 回拉 | ✅ | `missed.js:120-131,189` |
| P12 | multi 失敗分支在 `parse_error` 判斷之前，任何錯誤都重試 | ✅ | `fetcher.js:1663-1669` vs `:1704`；SPEC:780-781 |
| P13 | 自己 worker 的卡住接管與仍在跑的原抓取同槽各寫一筆；原抓取寫入前不核對擁有權；無 stuck 測試 | ⚠️ | `fetcher.js:169,244-249,1032-1062,1775` |
| P14 | 重試用盡幾乎不通知（只有單值 `not_found`） | ⚠️ | `fetcher.js:527,1691`；SPEC:744 |
| P15 | 啟動流程與通知點擊整段 `catch {}`；前一步丟例外 `ensureWatchdog` 被跳過 | ⚠️ | `main.js:976,990,2326,2353` |
| P16 | 重試分支結束不 `refreshBadge` | ⚠️ | `main.js:1036-1042` vs `:1076` |

### 0.3 選取模式

| # | 主張 | 核對 | 證據 |
|---|---|---|---|
| P17 | 群組模式鍵盤路徑（Backspace／Ctrl+Z／Shift+方向鍵）只改本地 `selectedList`，不經草稿佇列 | ✅ | `picker-mode.js:4008-4013→1786`、`:568-572` |
| P18 | 頁面端 `Ctrl/⌘+Enter` 在群組模式無反應 | ✅ | `:4014-4015` |
| P19 | `ENTER_PICK` 不先 `endGroupNamePick()` | ✅ | `content/main.js:652-662` |
| P20 | `Tab` 在表格上一律 `preventDefault`，鍵盤到不了「完成／取消」 | ✅ | `:4233-4240` |
| P21 | Shift 錨點在取消那格也更新 | ⚠️ | `:4565` |
| P22 | `exitPickMode` 沒重設 `draftRangeAnchor`／`draftPickDrainPaused`／`exitedDraftIdentity` | ⚠️ | `:5251-5252` vs `:5426-5573` |
| P23 | 工具列無 `aria-pressed`、無 `aria-live` | ⚠️ | `:1745-1751` |
| P24 | `pickMode === 'rowEach'` 死分支 | ⚠️ | `:628` |

### 0.4 Report 頁

| # | 主張 | 核對 | 證據 |
|---|---|---|---|
| P25 | `renderDashboard` 無 generation 守門 | ⚠️ | `dashboard.js:77,249,297` vs `:1108-1325` |
| P26 | 任務列與欄位設定拖曳 `pointercancel` 照樣寫回 | ✅ | `tasks.js:891-907`、`report.js:1309-1321` |
| P27 | 月曆拖曳無 `pointercancel`、拖出放開卡住；單點載入兩次 | ✅ | `report.js:1223-1248` |
| P28 | 圖表上限 8 與調色盤 `% 8` 各三份 | ✅ | `dashboard.js:849,916-917`、`trend-popover.js:168,181,261-262`、`cards.js:375`、`charts.js:48` |
| P29 | 儀表板讀取失敗 `.catch(() => {})` 靜默 | ⚠️ | `dashboard.js:428,1293` |
| P30 | `report.html:55` 用 `+` 當圖示；首頁預設 `hidden` 相反 | ⚠️ | `report.html:51,55,283` |
| P31 | 頁籤與月曆無鍵盤可達 | ⚠️ | `dashboard.js:1143,1212`、`report.js:1217`；help.html:539 已承諾「月曆日期可 Tab 移過去」，與程式不符 |

### 0.5 popup／面板

| # | 主張 | 核對 | 證據 |
|---|---|---|---|
| P32 | popup「全部暫停／恢復」後沿用舊 `health` | ✅ | `popup.js:373,437-444`；對照 `:117-120` |
| P33 | popup 正式碼留測試替身路徑 | ⚠️ | `popup.js:497-499` |
| P34 | 開著的 side panel 不跟主題即時切換 | ⚠️ | `theme-apply.js` 只有 `applyTheme`／`applySavedTheme` |
| P35 | CLAUDE.md「儲存鈕不 disabled」與 SPEC §6 例外矛盾 | ⚠️ | `site.js:342-343` |

### 0.6 重複與死碼

| # | 主張 | 核對 |
|---|---|---|
| P36 | 位置命名三份、`anchorOnly` 兩份、`POS_LABELS`／`POS_NAMES` 兩張表 | ⚠️ |
| P37 | fetcher 失敗收尾六處、`writeRecord` 失敗寫法十一處 | ⚠️ |
| P38 | 「是否 multi」五份，`alerts.js isMultiTask` 未 export | ⚠️ |
| P39 | alarm 名稱解析三處（`main.js parseTaskAlarm` 相容舊格式、`watchdog.js:88`、`popup.js:606`） | ⚠️ |
| P40 | picker-mode：套標示樣式 14 處、`updatePanel` 62 處、矩形範圍三份、單位選字四份 | ⚠️ |
| P41 | `handleMessage` 約 700 行 if 鏈分派 24 種訊息 | ✅ |
| P42 | 死碼 export（定義檔外零引用）：見作業 G3 清單 | ⚠️ 刪前逐一 grep |
| P43 | `pick-protocol.js` 無人 import | **❌**：`background/main.js` 有 import |
| P44 | `cards.js:603 dataset.tsv` 只有測試在讀 | ⚠️ |

### 0.7 文件與衛生

| # | 主張 | 核對 |
|---|---|---|
| P45 | 15 個 ` 2.js`／` 2.mjs` 複製殘留＋空目錄 `docs/evidence/af23 2/`；glob 不吃它們 | ✅ |
| P46 | 本機 `publish/` 停在 0.3.0 | ⚠️ |
| P47 | CLAUDE.md 結構圖缺 `pick-protocol`／`pick-draft`／`route`／`task-source`／`docs/evidence`；`:62` schemaVersion 3 | ✅ |
| P48 | README 0.7.0 段與現況相反；快捷鍵缺群組模式；`:67` 引 archive | ⚠️ |
| P49 | SPEC §2 551 行一個子標題、約 57 處流水帳、§7 子標題用輪次、§5 漏三鍵；304 個識別字全部存在 | ⚠️ |
| P50 | BACKLOG「舊術語註解 10 處」實剩 3 | ⚠️ |
| P51 | 240 個測試檔前綴無說明 | ✅ |

## 1. 使用者定案（2026-10-22）

| 決定 | 結論 |
|---|---|
| 委派 | subagent 一律 sonnet／medium |
| 拆檔 | 由 Claude 依架構評估，忌為拆而拆 → 見 §2 作業 G 的評估 |
| 其餘七項 | 授權 Claude 依評估處理 → 各作業「定案」節 |

## 2. 各作業

### 作業 A：衛生與文件基礎

**定案**
- A1 刪除 15 個 Finder 複製殘留檔與空目錄 `docs/evidence/af23 2/`；`.gitignore` 加 `* [0-9].*` 一條（擋 Finder「拷貝」命名）。
- A2 **本機 `publish/` 不動**（gitignored、無法確認使用者瀏覽器載入的是哪個路徑；誤刪會讓擴充功能身分斷掉）。README 安裝段已有說明，不改。
- A3 CLAUDE.md：結構圖補 `shared/pick-protocol.js`（選取協定：PICKED 訊息形狀與核對）、`pick-draft.js`（群組草稿 `pickDraft:<tabId>`）、`route.js`（選取期間路由核對）、`task-source.js`（多來源正規化）與 `docs/evidence/`；第 62 行 schemaVersion 3 → 4；加一段「測試檔命名」：前綴是輪次／段落代號（`a4`、`za1`…為早期固定守門，`af22_`／`af23_` 為輪次），**新測試一律 `af24_<主題>.test.js`**，守門類沿用既有檔。
- A4 README：刪 0.7.0 與 0.17.0 升級段（與現況相反或已被取代；歷史在 archive 的 PLAN）；快捷鍵段補群組模式「`Ctrl/⌘+Enter` 或面板『完成選取』」；第 67 行改成只引 `docs/SPEC.md`，不引 archive；右鍵選單名稱改為逐字列出五項。
- A5 BACKLOG：「舊術語註解 10 處」改 3 處並附位置；dnd 條目改寫（dashboard 已接入，剩任務列、欄位設定、月曆三處，本輪 E2 處理後刪條目）；「`#test-note` 不清」本輪 F6 處理後刪；新增「月曆鍵盤導航」「§6 登入頁判定改用密碼欄存在」「`storage.js` 拆模組」「`picker-mode.js` 拆模組」四條附觸發條件。
- A6 SPEC §5 鍵清單補 `alertCommitLog`、`executionInvalidations`、`fieldRepairOperations`（用途各一句）；§5 遷移段補「v4：任務多來源形狀，舊形狀讀取端正規化、不改寫 storage」。
- A7 版本號 0.23.0（manifest 與 package.json）。

**驗收**
- `git status --short | grep ' 2\.'` 為空；`ls "docs/evidence/af23 2"` 不存在。
- `npm test` 3323 綠不變（刪的是未追蹤檔）。
- `tests/a4_conventions.test.js` D3b 綠（兩處版本號一致）。
- grep：CLAUDE.md 含四個新檔名與 `docs/evidence`；`grep -c "schemaVersion 3" CLAUDE.md` = 0；README 不含 `docs/archive/`、含 `Ctrl/⌘+Enter`；SPEC 含三個鍵名。
- 既有 `tests/y5_help_page.test.js` 綠（README 與 help 無交叉守門，此項只確認沒碰壞）。

### 作業 B：資料正確性

**B1 數值解析（P1）**
- 定案：`parseNumber` 接受——Unicode 負號 U+2212 與全形 `－` 視同 `-`；全形 `，`／`．` 視同 `,`／`.`；負號與數字間允許**最多一個空白**；前導小數點 `.5`→0.5；科學記號只在 `e`／`E` 後緊接可選正負號與**至少一位數字**時成立（`1.5e3`→1500；`1e`、`3e-`、`12 e3` 不算）。其餘規則不變（會計括號、貨幣符號、日期排除、取最左片段）。
- 根因：正規化只做了數字、沒做標點與負號；正則不認指數與前導小數點。
- 升級影響：既有任務若頁面本來就長這樣，修正後值會變（正確）。寫進 README「升級注意 0.23.0」一句。
- 驗收：新測試 `af24_parse_number.test.js` 列七種錯值輸入的期望值＋七個反例（`10 - 12`→10、`v1.5.2`→1.5、`1e`→1、`2024e`→2024、`A-12`→-12 維持現狀、`(1，234)`→-1234、`１，２３４．５`→1234.5）；既有 `tests/c2_extract.test.js` 綠。突變：把「最多一個空白」改成任意空白 → `10 - 12` 案例要紅。

**B2 schemaVersion 缺省（P2／P3）**
- 定案：缺 `schemaVersion` 一律視為 **1**（`init` 與 `getSchemaVersion` 共用同一個 helper）；所有遷移步驟必須冪等（已加密的站台不再加密、v3 帳本已是新形狀就跳過）。新安裝走一遍遷移是空操作，最後寫 4。
- 根因：兩個入口各自猜預設值。
- 驗收：`af24_schema_default.test.js`：(a) 無版本號＋明文密碼 → init 後密碼已加密、版本 4；(b) 連跑 `init()` 兩次資料位元組相同；(c) 無版本號、空資料 → 版本 4。改寫 `a2_storage.test.js:150` 的測試名稱與斷言為「缺少視為 1 並補成現行版本」。`za1_locks` 綠。

**B3 Picker 存檔合併最新 runtime 欄位（P6／P7）**
- 定案：編輯既有任務（含批次帶 `taskId` 的路徑）存檔時，runtime 欄位（`RUNTIME_FIELDS` 五個）以**儲存當下 storage 內最新值**為準，不是開面板時的快照；路徑改走 `updateTasks(ids, mutator)`，mutator 回傳「表單重組的任務 + 最新 runtime 欄位」。新任務維持 `saveTask`。表單本身管得到的欄位（名稱、排程、規格、來源）照表單。
- 根因：違反 CLAUDE.md「跨兩次呼叫的讀→改→存一律 `updateTasks`」。
- 驗收：`af24_picker_save_merge.test.js`：開面板後模擬 popup 停用該任務與 fetcher 寫 `notFoundStreak: 2`，Picker 改名存檔 → `enabled === false`、`notFoundStreak === 2`、名稱已改；批次路徑同樣斷言。突變：把 mutator 改回用 `ctx.task` → 兩條都紅。`za1_locks`（寫入時鎖必須持有）綠。

**B4 回填每欄都寫（P8）**
- 定案：`render` 與 `fillSchedule` 對每個表單欄位**確定地寫**：來源沒有的欄位寫成空／預設（`regex` 空字串、`strategy` 回預設選項、`aggregate` 回預設、`times` 空、`everyMinutes` 預設）；舊策略 `<option>` 只在本次任務需要時加入，切到下一個任務時移除。
- 驗收：`af24_picker_refill.test.js`：同一份面板文件先 render 任務 A（regex＋interval）再 render 任務 B（無 strategy、daily）→ 表單讀回等於 B 的定義、`strategy` 下拉沒有 A 的舊選項。突變：把 `regex` 改回「有值才寫」→ 紅。

**B5 匯出預設日期用本地日期（P4）**
- 定案：`settings.js` 兩處與 `export.js:207` 的「今天」改用本地日期字串（專案已有 `slotOf`／`series.js` 的本地日期工具，用同一份，不新寫）。`export.js:38-48` 的迴圈維持（內部一致）。設定頁匯出區塊在按鈕旁顯示「將匯出 YYYY-MM-DD ～ YYYY-MM-DD」（反映留空時的實際區間）。
- 驗收：`af24_export_local_date.test.js`：固定時鐘為 UTC 23:30、時區 +8 → 預設 `to` 等於本地日期（隔天）；提示文字含該日期。突變：改回 `toISOString` → 紅。

**B6 比較功能用同一份時間換算（P5）**
- 定案：`compareDays` 改用 `series.effectiveTimeOf` 取 `HH:mm`；沒有 `slot` 的紀錄退到 `capturedAt` 換成本地時間，**不再丟棄**。SPEC §8.3 補一句。
- 驗收：`af24_compare_no_slot.test.js`：A 日有一筆無 slot、`capturedAt` 為 UTC 格式的手動紀錄 → 出現在比較表且時刻為本地 `HH:mm`；`logic.js` 不再有自己的 `extractTime`（grep = 0）。

**B7 站台面板驗來源分頁（P9）與存檔展開既有物件（P10）**
- 定案：`handlePickedMessage` 只接受 `tabId` 等於面板目前分頁的 PICKED（沒有 `tabId` 的訊息一律拒絕）；站台存檔「展開既有站台物件再覆寫表單管的欄位」，`loginCheck` 既有就保留、沒有才寫預設。
- 驗收：`af24_site_panel.test.js`：另一分頁的 PICKED 不改選擇器；匯入帶自訂 `loginCheck` 的站台 → 編輯存檔後仍在。既有 `tests/*site*.test.js` 綠。

### 作業 C：background 可靠性

**C1 錯過清單的 `lastSeenAt` 在鎖內推進（P11）**
- 定案：`lastSeenAt` 的讀取、窗口計算、合併清單、寫回 `lastSeenAt` 放在**同一次** `missed` 鍵的鎖內（鎖內只呼叫 `*Unlocked`，不取第二把鎖）；通知移到鎖外。`lastSeenAt` 只能單調遞增（寫入時取 `max(現值, toMs)`）。
- 驗收：`af24_missed_concurrent.test.js`：兩個 `refreshMissed()` 同時呼叫（不帶 `sinceMs`）、期間有一段 gap → gap `count` 只加一次、`lastSeenAt` 等於較大的 `toMs`。用 `za1` 的「寫入時鎖必須正被持有」替身驗（不用壓力測試）。突變：把寫回移到鎖外 → 替身當場炸。

**C2 失敗收尾單一入口：重試範圍與通知（P12／P14／P37）**
- 定案：fetcher 內新增一個失敗收尾函式（名稱由執行端定），所有失敗路徑（單值與 multi、離線、逾時、例外、登入失敗、解析錯誤）都經它；常數 `MAX_ATTEMPTS = 3`。規則：
  - 可重試：`not_found`、逾時、未知 `error`、離線 → `attempt < MAX_ATTEMPTS` 且非手動時排重試；用盡才寫失敗紀錄。
  - **不重試**：`login_failed`、`parse_error`（含 multi）→ 立刻寫失敗紀錄。
  - 通知（只在「寫失敗紀錄」那一刻、非手動、非 dryRun）：`login_failed` → `notifySiteFailure`（站台合併）；離線 → `notifyFailure('offline', 'offline')` 全域一則；其餘 → `notifyFailure('task:<父任務id>', status)`（既有 24 小時同 key 同狀態一次）；multi 任務一則，訊息含失敗值數。成功時沿用既有 `clearNotifyLog`。
- 根因：六處各自拷貝收尾，multi 分支排在不可重試判斷之前。
- 驗收：`af24_fetch_failure_policy.test.js`：(a) multi 的 `parse_error` 不排重試、立刻寫每值失敗紀錄；(b) 單值 `error` 第三次用盡後 `notifyFailure` 被呼叫一次、同狀態再失敗 24 小時內不再呼叫；(c) 手動抓取失敗零通知；(d) 離線三任務只有一則。grep：`attempt < 3` 字面在 `fetcher.js` 為 0、`scheduleRetry(` 呼叫點 ≤ 2。既有 `af22_r09_failures`、`r11_outcomes`、`d01_fetcher`、`e1_fetcher` 綠。

**C3 卡住接管與寫入擁有權（P13）**
- 定案：原抓取在**寫紀錄之前**核對自己的 runState 項目仍存在且 `boot`／`attempt`／`at` 與自己一致；被接管（項目被拿走或換人）就不寫紀錄、不寫帳本、不碰 health，只記 diag `run_taken_over`。接管方規則不變。SPEC §4.1 補寫「自己 worker 的接管條件」與這條擁有權規則。
- 驗收：`af24_run_ownership.test.js`：runTask 在擷取步驟掛起 → 模擬接管寫入 `interrupted` → 原抓取續跑完成 → 該槽只有一筆紀錄（`interrupted`），diag 有 `run_taken_over`。突變：拿掉核對 → 兩筆紀錄，紅。

**C4 啟動韌性與徽章（P15／P16）**
- 定案：`handleInstalled`／`handleStartup` 每一步各自 try／catch 並 `diag.log`，`ensureWatchdog` 必定執行；通知按鈕／點擊處理的 `catch` 記 diag；重試分支 `runTask` 完成後 `refreshBadge()`。
- 驗收：`af24_startup_resilience.test.js`：`rebuildAlarms` 丟例外 → `ensureWatchdog` 仍被呼叫、diag 有紀錄；重試 alarm 跑完 → `refreshBadge` 被呼叫一次。

**C5 單一來源（P38／P39）**
- 定案：`shared/alerts.js` 的 `isMultiTask` export，fetcher 與 main.js 五處改用它；alarm 名稱解析只留 `scheduler.parseAlarmName`（相容舊格式 `<id>:<n>` 搬進去），watchdog 與 popup 改用它（popup 走 `shared/` 可達的路徑：把 `parseAlarmName` 放到 `shared/schedule-math.js` 由 scheduler re-export，符合 CLAUDE.md「排程數學只有一份」）。
- 驗收：grep `task.mode === 'multi'`／`Array.isArray(task.fields)` 在 `background/` 與 `ui/popup/` 為 0；`split(':')` 在 `popup.js` 為 0；既有 `d5b_popup`、`ze1_health_popup`、watchdog 測試綠；新增一案：舊格式 alarm 名稱 watchdog 會清掉。

**作業 C 完成後：`./run_smoke.sh` 全綠**（CLAUDE.md：動 background 必跑煙霧）。

### 作業 D：選取模式鍵盤與群組一致

**D1 群組模式鍵盤走草稿佇列（P17／P21）**
- 定案（群組模式，即 `isImmediateDraftGroupMode()`）：
  - `Backspace`／`Delete`：移除**最後一筆草稿值**（草稿佇列插入順序的最後一筆，不是本地 `selectedList`），經與滑鼠「再點取消」同一條移除路徑送出；沒有草稿值就放給頁面。
  - `Ctrl/⌘+Z`：與 `Backspace` 同義（群組模式不維護復原快照，SPEC 寫明）。
  - `Shift+方向鍵`：經 `addDraftPickBatch` 加值（超量整批拒絕並提示，與滑鼠框選一致）。
  - Shift 錨點只在**加選**時更新，取消不更新。
  - `Ctrl/⌘+A` 維持現狀（加選、超量整批拒絕），SPEC 補寫。
- 根因：AF-22 加群組模式時只接了滑鼠路徑。
- 驗收：`af24_group_keyboard.test.js`（經 `content/main` 載入、用替身收 PICKED）：點兩格後 `Backspace` → 送出一則 remove、頁面標示剩一格、本地與草稿一致；`Shift+→` → 送出 add 且數量正確；超量 → 零送出且 `toolbarNotice` 有字；取消一格後 `Shift+點` 的範圍起點是最後一個已選格。既有 `af22_*`、`af23_c_picker*` 綠。

**D2 頁面端 `Ctrl/⌘+Enter` 完成（P18）**
- 定案：群組模式下 `Ctrl/⌘+Enter` 等同面板「完成選取」（送同一則訊息）；普通 `Enter` 維持「只操作焦點控制項」。
- 驗收：同上測試檔：`Ctrl+Enter` → 送出完成訊息一次；`Enter` → 零送出。

**D3 取名模式與選值模式雙向互斥（P19）**
- 定案：`ENTER_PICK` 先 `endGroupNamePick()`；取名模式按 `Esc` 結束時回一則訊息給面板（型別由執行端在 `shared/messages.js` 加，命名含 `GROUP_NAME` 字樣），面板收到就離開「等待取名」狀態。
- 驗收：`af24_name_pick_exclusive.test.js`：取名中送 ENTER_PICK → 取名監聽已拆（點一下只加值、不回填名稱）；取名中 `Esc` → 面板收到取消訊息。`tests/m2_chain.test.js` 補這個新訊息型別的發訊→收訊鏈。

**D4 `Tab` 還給焦點，模式改數字鍵（P20）**
- 定案：選取模式不再攔 `Tab`（瀏覽器原生在頁面與 overlay 按鈕間移動焦點）；四段模式改用 **`1`～`4`** 切換（對應工具列順序，停用的段按了要有提示，不靜默）；工具列按鈕顯示數字提示；`help.html` 與 README 同步；README「升級注意 0.23.0」寫明。
- 根因：Tab 被拿去切模式，與無障礙互斥。
- 驗收：`af24_pick_tab_focus.test.js`：表格上按 `Tab` 不被 `preventDefault`；`2` 切到整欄；非多值用途按 `2` → 提示文字出現、模式不變。`tests/y5_help_page.test.js` 綠（新 `data-ui-label` 對得到字串）。煙霧：`tests/smoke/` 新增一段「鍵盤從頁面 Tab 到完成鈕並 Enter 送出」。

**D5 工具列無障礙（P23）**
- 定案：作用中段 `aria-pressed="true"`；停用段 `aria-disabled` 之外點擊要有提示（既有 `toolbarNotice`）；面板文字區加 `aria-live="polite"`。
- 驗收：測試斷言三個屬性存在；`tests/p4_ui_css.test.js` 綠（色碼規則）。

**D6 exit 全重設與檔內收斂（P22／P24／P40）**
- 定案：`exitPickMode` 把全部模組狀態集中到一個 `resetState()`（含 P22 三個變數）；刪 `rowEach` 死分支；收斂為 `refreshMarks()`（14 處）、`rerender()`（62 處）、`rangePicks(...)`（三份）、`cellsOnAxis(...)`（排除標示雙迴圈與 `cellsOfPick` 共用）；單位選字收到 `describe.js` 一個函式（四處改用）。**不拆檔**（見作業 G 評估）。
- 驗收：既有「連續選兩次」類測試綠；grep：`applyPickedMarks(pickedTableEl)` 直接呼叫 ≤ 2、`rowEach` 為 0、`describe.js` 以外不得出現「整欄用列／整列用格」的單位字串字面（基準 4 → 0）。`node --check` 過。突變：在 `resetState` 拿掉 `draftRangeAnchor` → 新增的「exit 後不 enter 的取名路徑不帶舊錨點」測試紅。

**作業 D 完成後：`./run_smoke.sh` 全綠**。

### 作業 E：Report 一致性

**E1 儀表板序號守門（P25）**
- 定案：`renderDashboard` 每次進入取一個序號，所有 `await` 之後回來先核對仍是最新序號，不是就放棄本次繪製（不清格線、不改 `currentDashId`）。輕量重畫與 undo／redo 不受影響。
- 驗收：`af24_dashboard_generation.test.js`：A 的 `buildDashboardContext` 延遲、B 先完成 → 格線是 B 的卡片、`currentDashId === B`；A 完成後畫面不變。突變：拿掉核對 → 紅。

**E2 拖曳一律走 `dnd.js`（P26／P27）**
- 定案：任務列排序、欄位設定排序、月曆範圍選取改用 `dnd.js` 的協定；`dnd.js` 允許新增**一個**「同容器排序」的小助手（若既有 `createDragSource`／`registerDropTarget` 不夠），不得各頁再自寫 pointer 監聽。行為契約：`pointercancel` 一律 abort（不寫回、DOM 回到拖前順序）；月曆拖出格子外放開也會收尾；單點一格只載入一次。
- 驗收：grep `addEventListener('pointer` 在 `src/ui/report/` 除 `dnd.js` 外為 0（基準 4 處）；`af24_dnd_cancel.test.js`：任務列拖曳中 `pointercancel` → `applyOrder` 零呼叫、DOM 順序還原；欄位設定同；月曆 `pointercancel` 後再點一格 → 單日範圍、`routeCurrentState` 一次。既有 `j3_palette_drop`、`zd5_drawer_draft`、`af23_b2_atomic` 綠。分三段交付（任務列／欄位設定／月曆）。

**E3 讀取失敗提示與首頁（P29／P30）**
- 定案：儀表板讀取失敗顯示既有的橫幅樣式與「重試」鈕（沿用歷史頁 `showHistoryLoadError` 的做法，不新寫樣式）；`+` 改用 `icons.js`；`report.html` 儀表板 section 預設可見、歷史頁預設 `hidden`。
- 驗收：測試：`getLayout` 拒絕 → 橫幅出現、按重試後消失；grep `>+<` 在 `report.html` 為 0；`report.html` 歷史 section 帶 `hidden`。

**E4 上限與調色盤一份（P28／P44）**
- 定案：`MAX_CHART_SERIES` 為唯一上限（dashboard 兩處、trend-popover 三處改引用）；`charts.getChartColor` export，`cards`／`trend-popover` 改用；`dataset.tsv` 移除，測試改測 `buildTsv` 純函式（export 它）。
- 驗收：grep 字面 `8` 於上述五處為 0、`% 8` 為 0、`dataset.tsv` 於 `src/` 為 0；既有 `j2_drop_rules`、`m3_plan_gaps`、卡片 TSV 測試改測純函式後綠。

**E5 儀表板頁籤鍵盤可達（P31）**
- 定案：頁籤容器 `role="tablist"`、每個頁籤 `role="tab"`＋`tabindex`、`←`／`→` 切換、`Enter` 進入；改名鈕用與任務頁一致的「改名」圖示鈕，不再常駐 input。月曆鍵盤導航進 BACKLOG，`help.html:539` 的承諾改成實際行為（Tab 可到展開鈕；月曆用滑鼠或日期欄位）。
- 驗收：`af24_dashboard_tabs_a11y.test.js`：`→` 切到下一頁籤並 `renderDashboard`；`y5_help_page` 綠。

### 作業 F：popup／面板與命名

- F1（P32）「全部暫停／恢復」後重算 `health` 再 render；驗收：測試斷言 chip 文字變「已暫停」。
- F2 暫停鈕文字依目前狀態顯示「全部暫停」或「全部恢復」；popup 頁尾「開啟報表」與 SPEC §12.2 用詞統一為「報表」。驗收：測試兩種狀態的按鈕文字；`y5` 綠。
- F3（P33）移除 `url.toString` 替身路徑，改用既有 `openExtPage`；驗收：grep `chrome-extension://autofetcher` 在 `src/` 為 0；`d5b_popup` 改用替身注入後綠。
- F4（P34）`theme-apply.js` 新增 `watchTheme()`：以 `storage.subscribe` 監看設定鍵、變動即 `applyTheme`；Picker、站台、popup 三個常駐頁呼叫。驗收：測試：改設定後 `document.documentElement` 的主題屬性變；監聽只掛一次（render 100 次不累加）。
- F5（P35）站台面板儲存鈕不再 `disabled`，判斷不出分頁時走 `save-guard` 原因區；SPEC §6 刪例外句。驗收：測試：`currentOrigin` 空 → 儲存鈕可按、原因區有字、不寫入。
- F6（BACKLOG）換目標重畫時清 `#test-note`（併入既有 `resetTestDetail`）。驗收：測試斷言換目標後為空。
- F7（P36）新增 `shared/field-name.js`：`posSuffix(pos)`、`anchorOnly(...)`、純函式 `defaultFieldName(pick, n, pos)`（位置當參數，不讀 DOM）；`picker.js` 兩個函式與 `main.js defaultFieldName` 改呼叫它；`POS_LABELS`／`POS_NAMES` 只剩一張表。驗收：grep 兩張表名在 `picker.js`／`main.js` 為 0；`q5_picker_position`、`r4_picker_summary`、`m2_chain`、`zh3_terms_picker` 綠；manifest `web_accessible_resources` 不變（background 與 Picker 都不是 content 端，a4 D16 綠）。

### 作業 G：結構整理（純搬移、不改行為）

**評估（忌為拆而拆）**

| 候選 | 決定 | 理由 |
|---|---|---|
| `main.js` `handleMessage` 700 行 if 鏈 | **做**：改成 `{ [MSG.X]: handler }` 路由表；`handleMessage` 只留 `CONTENT_ALLOWED` 檢查、try／catch、分派 | 開閉原則：新訊息只加一條表項；不新增檔案也能做 |
| `main.js` 欄位修復（約 72–557 行）與群組草稿（約 558–760、1083–1560 行） | **做**：各搬成 `background/field-repair.js`、`background/pick-draft.js` | 兩者都是有明確邊界、自帶狀態（grant、journal、draft）的領域，與既有「一個領域一個檔」（fetch-tab、frames、notify…）同型；main.js 回到接線層 |
| `picker.js` 6406 行 | **只搬純函式**：`getFormData`／`buildSpec`／`buildSchedule`／`buildTask`／`RUNTIME_FIELDS` → `ui/picker/form.js`，`picker.js` re-export 不改測試 | 純函式零 DOM，搬了就能單獨測；其餘段落共享 `currentCtx` 等可變狀態，硬拆要先造 state 模組，本輪不值 |
| `picker-mode.js` 5581 行 | **不拆**（D6 做檔內收斂＋`resetState`） | content 端 import 閉包綁 manifest `web_accessible_resources`（a4 D16）、五個測試用 `readFileSync` 讀原始碼、模組狀態耦合深；拆檔的收益是可讀性，風險是真實瀏覽器才炸的載入問題。進 BACKLOG 附觸發條件 |
| `storage.js` 1803 行 | **不拆** | `za1` 以檔名白名單守 `chrome.storage.`；鎖語意靠「鎖內只呼叫 `*Unlocked`」在同檔內可見；拆開後反而要跨檔追。進 BACKLOG |

**定案**
- G1 路由表＋兩個領域檔；既有測試（`af22_c1a_draft`、`c1b_protocol`、`c2b_drain`、`r18_field_repair`、`af23_a_repair`、`af23_picker_*`、`d6_wiring`、`a4_conventions` 的靜態檢查）只改 import 路徑，不改斷言。
- G2 `ui/picker/form.js`（在 B3／B4 之後做，搬的是已修正的版本）。
- G3 死碼清理，**每一項刪前 grep `src/ tests/`，同檔內部有用的只拿掉 `export`**：`describe.describeFieldMode`／`describeFieldSource`、`field-match.sourceIdentityOf`／`sameSource`、`storage.setSessionValue`、`table.TABLE_SELECTOR`、`task-source.taskSourcesOf`／`TASK_FIELD_MODES`／`MAX_MULTI_DEPTH`、`preaction.PRE_ACTION_LABELS`、`panel.PANEL_PATHS`、`pick-draft.js` 無人用的 export。`pick-protocol.js` 不動。
- G4 CLAUDE.md 結構圖補三個新檔。
- 驗收：`npm test` 全綠且測試數 ≥ 作業 F 結束時的數字；`main.js` 行數 < 1200、`handleMessage` 內 `msg.type ===` 字面 ≤ 2；`a4_conventions` D13／D14／D16 綠；`node --check` 全部 src；死碼清單每項 grep 為 0 或只剩定義檔；`./run_smoke.sh` 全綠（main.js 是 background 入口）。

### 作業 H：SPEC 結構整理

- H1 §2 拆成「§2.1 右鍵選單」「§2.2 頁面內選取模式」「§2.3 側邊面板與 Picker 設定」「§2.4 共用 UI 規範」（原 §2.1 編號順延；程式碼註解引用的 `§2` 仍成立）。
- H2 約 57 處「以前／改成／AF-N 起」改寫成現況句；成因故事（例如 1157 附近「選取端以前存 DOM 索引…」）搬到 `docs/archive/SPEC-decisions.md` 既有檔；§7「### AF-22 多來源任務」改「### 多來源任務」。
- H3 逐條補寫本輪不同步清單：重試範圍與通知策略（C2）、自己 worker 的接管與擁有權（C3）、補抓 `reason:'late'` 路徑、拖曳取消一律不寫回（E2）、比較功能無 slot 規則（B6）、匯出預設區間（B5）、群組模式鍵盤語意與 Ctrl+A（D1）、Ctrl/⌘+Enter（D2）、取名與選值互斥（D3）、數字鍵切模式（D4）、§6 刪「密碼欄存在」判定句（進 BACKLOG）與儲存鈕例外句（F5）、§12.2 popup 全部暫停後重算燈號與用詞（F1／F2）、§5 v4 說明（A6）。
- 驗收：`grep -c "以前" docs/SPEC.md` 從基準降到 ≤ 5（保留描述「舊版本瀏覽器」等非流水帳用法）；`grep -c "AF-" docs/SPEC.md` 從 132 降到 ≤ 20；§ 標題數與程式碼註解引用的 `§N` 全部存在（grep 註解中的 `§\d+(\.\d+)?` 逐一比對）；H3 每條在 SPEC 找得到對應句（Claude 逐條 grep）。

## 3. 明確不做（本輪定案）

- `storage.js`、`picker-mode.js` 拆檔（理由見作業 G；進 BACKLOG）。
- 本機 `publish/` 的刪除或重產（A2）。
- 月曆鍵盤導航（進 BACKLOG）；§6「密碼欄存在」登入頁判定的 UI（進 BACKLOG）。
- `pick-protocol.js` 任何改動（P43 不成立）。
- 通知策略之外的告警規則改動。

## 4. 複檢（規劃完成後、委派前）

**使用者角度（挑剔但有理）**
- 「又改快捷鍵？」：Tab→數字鍵是第三次改選取模式操作（AF-7、AF-18）。接受的理由：Tab 被佔用讓鍵盤使用者永遠到不了完成鈕，這是可及性缺陷不是偏好；README 升級注意與教學頁同步，工具列顯示數字提示降低學習成本。
- 「通知會不會變吵？」：C2 只在「寫失敗紀錄那一刻」通知，24 小時同任務同狀態一次、離線全域一則、登入失敗站台合併、手動與 dryRun 零通知、遵守通知偏好。
- 「數值修正會不會讓舊歷史跳一段？」：會，且是從錯值跳到正確值；README 升級注意寫明七種受影響形狀。不回溯改舊紀錄（紀錄是事實快照）。
- 「群組模式 Backspace 刪的是哪一個？」：草稿插入順序的最後一筆，面板清單同步移除；與滑鼠「再點取消」同一條路徑，看到的結果一致。
- 「編輯任務時 popup 停用它，存檔後到底是啟用還停用？」：停用（B3：runtime 欄位以儲存當下為準），SPEC §2.3 寫明。

**程式面角度**
- B3 與 G2 同碰 `picker.js` 的 `buildTask`：順序 B3→G2，G2 搬的是修正後版本（已排進相依）。
- C2 與 C3 同在 fetcher 的收尾路徑：同一作業內 C2 先、C3 後，C3 的擁有權核對放在 C2 的單一入口之前。
- E2 三處拖曳與 E1 同碰 `dashboard.js`：E1 先；E2 分三段，每段獨立驗收。
- D3 新增訊息型別：`m2_chain` 補鏈結測試；型別預設不接受 content 送（CLAUDE.md），但這則是 content→面板，要列進 `CONTENT_ALLOWED`——規格要寫明，驗收 grep `CONTENT_ALLOWED` 含它。
- F7 新 `shared/field-name.js` 被 background 與 Picker 引用、不被 content 引用 → manifest 不變；若執行端誤加進 `web_accessible_resources`，a4 D16 會擋。
- C5 把 `parseAlarmName` 搬到 `shared/schedule-math.js`：popup 已 import `background/health.js`（既有先例），但搬到 shared 更符合「排程數學一份」；scheduler re-export 讓既有呼叫端不改。
- B2 改「缺省視為 1」會改動 `a2_storage.test.js:150` 的既有斷言：這是刻意推翻，理由寫在測試名稱。

**管理者角度**
- 規模：八個作業、約 30 個驗收點、預估新增測試檔 20 個以內。每作業一次 commit、可獨立回滾；G 與 H 排最後，前六個作業完成即可先併 dev 出 0.23.0，G／H 若超時可切到下一輪。
- 煙霧測試閘門：C、D、G 之後各跑一次（Mac 上 `.browsers/chrome` 已就緒）。
- 版本號在 A7 就升，避免 AF-6／AF-7 漏升重演。

**上帝視角（整體影響）**
- 四個拆分原則的坑：
  - 「什麼算一個／分母為零」：C2 的 multi 通知「失敗值數」在全部失敗與部分失敗都要有數字；零值失敗不通知（已寫）。D1 的「最後一筆草稿值」在草稿為空時放給頁面（已寫）。
  - 「破壞性判準的反例」：B1 的指數規則列了 `1e`、`2024e`、`12 e3` 反例；B4 的「確定地寫空」不得寫到表單沒有的欄位（新建任務時 `ctx.task` 為空走預設，既有測試守）。
  - 「單向閘門的繞過」：E1 序號守門——舊序號的繪製放棄後**不得**留下半畫的格線（契約寫「不清格線」即不動現狀）。C3 被接管的原抓取放棄寫入——若接管方其實失敗了（寫 interrupted 後 worker 又死），補抓機制靠帳本照常補（interrupted 不寫帳本，CLAUDE.md 既有規則），閘門可繞。
  - 「移除類的依賴方」：G3 每項刪前 grep（已寫）；E4 `dataset.tsv` 的依賴方是測試，改測純函式（已寫）；D4 移除 Tab 切模式的依賴方是 help.html 與 README（已寫）；F3 移除替身路徑的依賴方是 `d5b_popup` 測試（已寫改注入）。
- 既有資料：B2 遷移冪等（測試連跑兩次）；B1 不回溯；其餘不碰 storage 形狀，schema 維持 4。
- 跨段鏈結：D3 新訊息（content→面板）、C2 通知（fetcher→notify→OS）、F7 命名（shared→兩端）三條在終檢時逐一 grep 發訊端到收訊端。

複檢結論：以上發現已回寫各作業契約；無待決項。

## 5. 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A | Claude | b04a3db | grep 全過、a4 綠 | 改 src 註解沒跑 `zh3` 詞彙守門（它鎖保留處數量），B 段才發現；B 段補改最後幾處註解並把保留清單歸零。之後每作業 commit 前跑一次全量 |
| B1–B2 | Claude | ce232d5 | 新測試 26 條；突變兩處皆紅 | 突變實際由 `-  12`（兩個空白）案例抓到，非規劃寫的 `10 - 12` |
| B3–B7 | Claude | e299f09 | 全量 3362 綠；四處突變皆紅 | 見下方設計修正 |

| C1 | Claude | 6aecfce | 兩條並行測試；兩處突變皆紅 | 見設計修正 C1 |
| C2 | Claude | 6b54169 | 五條政策測試；兩處突變皆紅 | 全量時抓到「寫帳本中斷後恢復成成功仍發失敗通知」，改為只在寫下的結果確實失敗時通知；`af22_e2_results` 一條把所有通知當告警在數，改成只數告警 id |
| C3 | Claude | 7e68470 | 接管後只剩一筆 interrupted；突變紅 | — |
| C4–C5 | Claude | （同作業 C 收尾 commit） | 啟動韌性兩條、單一來源四條；突變紅 | P16 不成立（見設計修正）；popup 改走 `GET_NEXT_RUNS` |

| C 收尾 | Claude | cfbbdae | 全量 3376 綠；煙霧 14 套 PASS（Edge 本機未裝而略過） | 第一次煙霧用了 macOS 沒有的 `timeout` 指令，根本沒跑；改直接執行 |
| D-a | Claude | ffd56c0 | 群組鍵盤 5 條、互斥與轉發鏈 6 條；三處突變皆紅 | 起點測試第一版因起點被清成 null 而「碰巧」通過，改點 (1,1) 讓正確與錯誤結果可區分 |
| D-b/D-c | Claude | 5c9b0b2、030b349 | 數字鍵與 aria 5 條 | 5c9b0b2 把「跑全量」與 commit 串在一行，grep 成功就 commit，帶著 4 條失敗推上去；030b349 補改 y3/v5，之後測試與 commit 分兩步 |
| D-d | sonnet medium 子代理 | ea5f292 | Claude 重跑全量 3394 綠；`rangePicks` 突變紅 | refreshMarks 實為 11 處；`exitedDraftIdentity` 不清（它是給 exit 後遲到的 PICKED 核對用的，P22 此部分不成立） |

| D 收尾 | Claude | 03faa13 | 煙霧 14 套 PASS；新增 `af24_keyboard_pick` 真實瀏覽器只用鍵盤完成選取（Tab 7 下到「完成」），把 Tab 攔截加回去時紅 | 斷言第一版讀錯巢狀層（`ctx.ctx`），實際流程是通的 |
| E | Claude | 38160d7 | 全量 3407 綠；序號守門、sortable 取消、月曆取消三處突變皆紅 | 全量抓到 D 收尾時登記新煙霧腳本漏改 `af23_a_runner` 的清單守門，補上 |
| F | Claude | ff3e5a6 | 全量 3416 綠；popup 燈號重算突變紅 | 教學頁守門 `y5` 抓到「全部暫停 / 恢復」改名後沒同步，補上 |
| G | sonnet medium 子代理（路由表）＋ Claude（死碼） | 53161ce | 新舊 main.js 去縮排逐行比對只差分派結構；全量 3416 綠；煙霧 15 套 PASS | 見設計修正 G |

### 設計修正（實作中）

- **E2**：不把三處拖曳搬進 `dnd.js`。它是「來源→投放目標」協定（幽靈元素、命中判定、儀表板重畫時全域 `resetDnd` 會清掉所有目標），清單就地排序與月曆拉範圍都不是投放；硬套會過度設計，還可能被儀表板重畫清掉任務頁的目標。改為新增 `ui/report/sortable.js`（任務列、欄位設定兩處共用，順便拿掉欄位設定的 `elementFromPoint`），月曆就地修收尾。作業 A 寫進 BACKLOG 的「已搬進 dnd.js」一行已更正。
- **E5**：頁籤只做鍵盤可達（tablist、←／→、焦點跟隨），名稱輸入框維持常駐、不改成改名鈕（改動面大、牽動多條既有測試，收益只是外觀一致）。稽核 P31 對月曆的部分不成立：月曆日期格內本來就是可聚焦的按鈕，教學頁的說法是對的。
- **E4**：`dataset.tsv` 拿掉後，三條測試改成真的按「複製 TSV」、從剪貼簿替身讀出內容，比讀 DOM 屬性更貼近使用者行為。
- **F7**：不新增 `shared/field-name.js`，命名函式收進既有的 `describe.js`（它本來就是白話描述的唯一來源、已有 `withInnerLabel`，且已在 content 載入閉包內，不牽動 manifest）。
- **G**：依架構重新評估後只做路由表與死碼。欄位修復區塊依賴 main.js 的 `frameDescriptorOf`、`CONTENT_MESSAGE_TIMEOUT_MS`，它的 session 表又被後段的面板關閉流程直接操作；群組草稿協調同樣與 frame 狀態表交纏——搬成獨立檔要把模組狀態跨檔匯出，耦合沒有減少。Picker `form.js` 不搬：那幾個函式本來就已 export、已有單獨測試。稽核說 `pick-draft.js` 有約 10 個沒人用的 export，查證後多數被 `pick-protocol.js` 與測試使用；實際刪除 8 項、拿掉 export 12 項。

- **D1**：規劃寫「群組模式 Backspace／Ctrl+Z 移除最後一筆草稿值」。實作時發現草稿同步回來的值沒有頁面元素（`target: null`），鍵盤無法可靠地指出要移除哪個元素；改成「有值時攔下並說明取消出口（再點一次或在面板移除）、沒有值放給頁面」，不靜默。Shift＋方向鍵照規劃經草稿佇列加入。Shift 起點：取消的正好是起點時，退回這張表仍選著的最後一格。
- **D2**：頁面端 Ctrl/⌘＋Enter 不在 content 端重做完成流程，改送 `PICK_DRAFT_FINISH_REQUEST`（進 `CONTENT_ALLOWED`），background 核對選取階段後轉給面板，面板按自己的「完成選取」——完成仍只有面板一個入口。
- **D3**：取名取消沿用既有的 `PICK_GROUP_NAME_RESULT`，加 `cancelled: true`，不新增訊息型別。
- **D4**：數字鍵等同點工具列按鈕（沿用停用說明與意圖記憶），所以已選一格時按 `3` 會像點按鈕一樣把它換成整欄每格；舊的 Tab 切模式不轉換已選值，那條路已不存在（`y3` B2-5 改驗新語意）。
- **D6**：不做 `rerender()`（只是替 `updatePanel(panelEl, currentTargetEl)` 換名字、不減重複）與全面 `resetState()`（風險高於收益）；只補 exit 漏清的變數。

- **C1**：規劃寫「`lastSeenAt` 與合併清單在同一把鎖內」，但 CLAUDE.md 規定一把鎖只寫一個鍵、不得巢狀。改為兩件事各自冪等：gap 合併只加「比已記錄最後一格還新」的格子；`lastSeenAt` 改用鎖內只增不減的 `advanceLastSeenAt`。效果相同、不違反鎖規則。
- **C2**：通知不另分「離線全域一則」與「其他走 notifyFailure」，一律走既有的 `notifySiteFailure`（同任務同狀態 24 小時一次、同站台 5 分鐘合併），少一套規則。登入失敗不在這裡通知（站台連續失敗停用時 login.js 已通知一次）。`invalid_multi` 也列為不重試。框架找不到（frame not found）維持不重試，但改經同一入口、會通知。
- **C4**：稽核 P16「重試後不更新徽章」不成立——fetcher 每次寫 health 都會 `refreshBadge`；撤回該改動與測試。
- **C5**：popup 違反 CLAUDE.md「UI 不得自己解析 alarm 名稱」，改成問 background 的 `GET_NEXT_RUNS`（不是把解析函式搬到 shared）。很早期的 `<id>:<n>` alarm 由 `rebuildAlarms` 一併清掉，main.js 的相容解析刪除，背景只剩 `scheduler.parseAlarmName` 一份。`describe.js` 的 multi 判斷保留（它在 content 載入閉包內，引入 task-source 會牽動 manifest）。

- **B3**：除了 `RUNTIME_FIELDS`，`order`、`archivedFields` 也由別處維護（Report 排序、background 修復封存），一併取儲存當下最新值；最新值沒有的鍵不得從快照長回來（`enabled` 例外，缺省即啟用）。編輯中的任務若已被刪除，存檔改為報錯、不再重新建立。
- **B5**：不另加「將匯出 X～Y」提示——日期輸入框本身就顯示區間；改成留空時按下匯出把實際日期回填進輸入框。
- **B7**：同型普查發現 Picker 前置動作的「在頁面上選取」收訊端有同樣的跨分頁問題，一併修（背景轉發帶 `sourceTabId`，兩個收訊端同一條規則；Picker 端在分頁未知時維持相容）。

## 6. 體檢交接

（實作輪收官時填：全量測試數、全綠與否、與基線 3323 的差、煙霧測試結果。）
