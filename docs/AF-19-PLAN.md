# AF-19 第 19 輪規劃：多重選取補強＋已儲存任務的修改體驗

> 狀態：全案完成，已體檢併 dev
> 基準：dev@278db75（2291 綠，v0.17.0）→ 本輪收尾升 **v0.18.0**
> 來源：使用者回饋兩條——(1) 前一輪多重選取以使用者操作邏輯再檢視一次；(2) 已儲存的任務改時間、改小項目很不方便，整批改時間做不到。
> 設計方案：使用者同意套 `ui-ux-pro-max`。採用的是操作規則（勾選欄＋動作列、刪除前確認、成功要回饋、進行中鎖按鈕、可見焦點、reduced-motion、勾選框帶 aria-label、就地編輯在 blur 驗證）；它建議的配色與字型**不採用**，`ui/theme.css` 仍是顏色唯一來源，因此不落 `design-system/` 目錄。
> 實作方式：agy 先做（開工前先查額度），額度用完 Claude 自己做並在執行紀錄註明切換點；subagent 一律 opus low（`scan-low`／`impl-low`）。Claude 先寫測試（含突變）再委派，每段獨立重驗；**每段驗收第一步是 `node --check` 全部改到的檔**，再跑該段測試與全量。

## 作業總覽

| 作業 | 內容 | 規模 | 相依 | 執行者 |
|---|---|---|---|---|
| A 儲存層整批 API | `saveTasks`／`deleteTasks`／`deleteLastValues`／`pruneSeries`，既有逐筆迴圈改走它 | 小 | — | agy |
| B 任務頁多選與整批動作 | 勾選框、全選、Shift 範圍、動作列（啟用／停用／改排程／刪除）、整批刪除對話框、就地改名、排程欄可點 | 中 | A、C | agy |
| C 整批改排程的面板檢視 | Picker `kind:'bulk'`：只露「多久抓一次」，套用到 N 個任務 | 中 | A | agy |
| D 編輯既有任務的修正 | 停用任務被復活、換目標洗掉值名稱／告警／前置動作、編輯模式的「回頁面重選」、孤兒序列、上下移理由 | 中 | A | Claude（跨端搬模組） |
| E 選取模式補強 | Esc／取消二段確認、面板高度、chip↔格子、Ctrl+A 提示、Delete、動作列不位移、工具列預告、Enter 提示、批次組名 | 中 | — | agy |
| F 拆成每個值一個任務 | Picker 多值表單一鍵轉成多任務清單 | 小 | — | agy |
| G 文件與收尾 | SPEC／BACKLOG／教學頁／CLAUDE.md／版本號 | 小 | 全部 | Claude |

建議順序：A → D → C → B → E → F → G（A 是所有整批寫入的地基；D 先做是因為 C／B 的存檔路徑要沿用「展開既有任務再覆寫」的口徑，不能再踩 `buildTask` 的坑）。

## 核對結果（步驟 1，皆已實際核對）

| # | 主張 | 判定 | 證據 |
|---|---|---|---|
| P1 | 編輯既有任務存檔會把停用的任務復活，並丟掉前景抓取等執行期欄位 | ❌ 成立 | `picker.js:457` `enabled: true` 寫死；`buildTask` 只保留 `id`／`order`／`frame`／`spec.attr,childSel,labelText`／`fields[].key`；`foreground` 由 `tasks.js:258` 寫入、`fetcher.js:390` 消費 |
| P2 | 編輯模式按「回頁面重選目標」會存成新任務 | ❌ 成立 | 編輯 ctx 只有 `{task, locator, url}`（`picker.js:2721-2730`），沒有 `.ctx` 鍵；`main.js:629-631` `retarget = keepDraft && existing.ctx` 為 false → 走完整 `render(ctx.ctx)`，`currentCtx.task` 消失 → `buildTask` 走 `randomUUID`。按鈕送的 `ENTER_PICK` 也不帶 `taskId`／`preselect`（`picker.js:2865-2873`）。而且面板開在 Report 分頁旁，`panelTabId` 是擴充功能頁，注入必失敗 |
| P3 | 新任務「回頁面重選」後值名稱、告警、前置動作全被洗掉，提示卻說「其他設定都留著」 | ❌ 成立 | `applyRetarget`（`picker.js:2751-2761`）只保住 `DRAFT_FIELDS`（名稱、排程、聚合、定位、儀表板、regex）與星期／卡片型別；`render` 對每個 pick 重生 key 與預設名（`:723-747`）、`#alert-list`／`#preaction-list` 一律 `replaceChildren()`（`:771`、`:781`）。`strategy`／`skip-*`／`pin-defaults` 在換目標路徑不被重設，這幾個沒事 |
| P4 | 多值任務移除一個值、或任務頁重選少掉的值，紀錄／lastValues／卡片來源變孤兒 | ❌ 成立 | `saveTask` 只驗 key（`storage.js:116-161`）；只有 `deleteTask` 清紀錄；`applyRepick`（`main.js:165-186`）只走新 picks、整包覆寫 `task.spec`；`pruneCardsForTask` 只比父 id（`layout-store.js:341`）；`lastValues` 鍵是序列 id（`fetcher.js:263`） |
| P5 | 任務頁沒有多選／整批；storage 沒有一次存多筆 | ❌ 成立 | `tasks.js` 只有列上的啟用開關與錯過橫幅勾選；`storage.js` 匯出清單無 `saveTasks`；`applyOrder`（`tasks.js:52-59`）與 popup `handleToggleAll`（`popup.js:240-248`）逐筆 `saveTask`＝2N 次 get＋N 次 set |
| P6 | Picker 排程區可以原地重用（不必抽出來） | ✅ | AF-18 的 `setBatchView` 已示範「只露共用區」（`picker.js:2943-2973`）；`buildSchedule`／`describeSchedule`／`nextIntervalRun` 乾淨可用；`updateSchedulePreview` 經 `getFormData` 讀整份表單但在同一個面板文件裡沒問題 |
| P7 | `REBUILD_ALARMS` 全清全建，整批只送一次即可 | ✅ | `main.js:548-554` → `scheduler.js:38-73`；AF-18 批次存檔就是這麼做（`picker.js:3188`） |
| P8 | 選取模式 `Esc` 直接整輪取消，無二段確認 | ❌ 成立 | `picker-mode.js:2761-2762` → `cancelPick()`（`:2169-2175`）；對照換表的 `replaceConfirmPending`（設 `:3284`、清 10 處） |
| P9 | 已選 chip 面板沒有高度上限，chip 與格子無雙向指涉 | ❌ 成立 | 面板 `panelEl` 固定右下、chip 容器 `listDiv` 只有 `flexWrap`（`:1249-1253`），全檔無 `maxHeight`；chip 只有 `×`（`buildPickChip` `:1142-1169`），無 hover／click 行為 |
| P10 | `Ctrl+A` 截斷無專屬提示、`Delete` 未綁定、動作列以 hidden 切換會位移、工具列取代最後一項無預告 | ⚠️ 皆成立 | `:2809-2839` 無總格數變數；`'Delete'` 零命中；`updatePanelActions`（`:1464-1507`）用 `hidden`；工具列四段有固定 `title`（`:3757-3782`）但不隨已選狀態變 |
| P11 | 選取中無法從單任務切到多任務 | ❌ 成立 | `batchMode` 只在 `enterPickMode` 寫一次（`:3708`），所有上游入口在進入前決定 |
| P12 | 批次組名頁面與 Picker 不一致 | ⚠️ 成立 | 頁面 `:1184-1186` 用元素文字前 20 字／`computeNameHint`；`buildPickPayload` 只在表格時帶 `nameHint`（`:1982-1985`）；Picker 用 `defaultTaskName(item)`（`picker.js:820-834`） |
| P13 | 多值清單上下移停用時沒有理由 | ⚠️ 成立 | `picker.js:1518-1526` 原生 `disabled`；BACKLOG 已記 |
| P14 | 既有測試不會因改成一次寫入而紅 | ✅ | `d5b_popup.test.js:121-138`、`f3_tasks.test.js:269-278` 只驗結果態與 `REBUILD_ALARMS` 有送，不數呼叫次數 |
| P15 | 就地改名有既有樣式可循 | ✅ | 儀表板頁籤（`dashboard.js:1020-1032`）：頁籤內放 `<input>`，`change` 存、`click`／`pointerdown` `stopPropagation`；`.task-link` 樣式已存在（`report.html:693`） |

明確不改的觀察：拖曳框選的清單順序固定列優先、與拖曳方向無關（與試算表一致）；已選非空時 `Enter` 不加入滑鼠下的格（語意一致，只補一句提示）；批次清單移到 0 列＝取消（SPEC 既有定案）。

---

## 作業 A：儲存層整批 API

### 現況與核對結果
- `saveTask` 每次 `get('tasks')`＋`set`（`storage.js:116-161`）；`deleteTask` 一次 `get(null)` 掃全部紀錄鍵再 `pruneCardsForTask`（`:163-188`）。
- 逐筆迴圈的呼叫端：`tasks.js` 的 `applyOrder`、`popup.js` 的 `handleToggleAll`。
- `pruneCardsForTask(taskId)` 只比 `parentIdOf(s.taskId)`（`layout-store.js:334-362`），來源歸零整卡移除；`lastValues` 沒有刪除 API。

### 定案
1. `shared/storage.js` 新增 **`saveTasks(list)`**：逐筆套用與 `saveTask` 相同的守門（id／name／url 非空、key 合法且不重複），**任一筆不合法就整批不寫**；例外的訊息文字與單筆完全相同（既有測試比對訊息），只多帶一個 `index` 屬性指出第幾筆；`order` 缺省者依序補「目前最大 +1」；一次 `get`、一次 `set`。`saveTask(task)` 改成呼叫 `saveTasks([task])`，行為與錯誤訊息不變。
2. 新增 **`deleteTasks(ids)`**：一次 `get(null)`，同時濾掉多個任務的紀錄，卡片清理逐 id 呼叫 `pruneCardsForTask`（版面讀寫量小，不另做批次版）。`deleteTask(id)` 改成呼叫 `deleteTasks([id])`。
3. 新增 **`deleteLastValues(keys)`**（鍵是序列 id）與 **`countRecordsForTasks(ids)`**（一次掃描回 `{ total, byId }`；`countRecordsForTask` 改成包裝它）。
4. `shared/layout-store.js` 新增 **`pruneSeries(seriesIds)`**：從所有卡片的 `source` 與 status 卡的 `options.taskIds` 移除這些序列 id；**來源歸零的卡片整張移除**（與 `pruneCardsForTask` 同一語意，不另造第二種）。兩者的「歸零即移除」判定收成同一份內部函式。
5. `applyOrder` 與 popup `handleToggleAll` 改走 `saveTasks`，`REBUILD_ALARMS` 仍只送一次。

### 改動
- `src/shared/storage.js`、`src/shared/layout-store.js`、`src/ui/report/tasks.js`（`applyOrder`）、`src/ui/popup/popup.js`（`handleToggleAll`）。

### 測試／驗收
- `saveTasks`：三筆一次寫入只有一次 `storage.local.set`（chrome-mock 數 `__calls`）；第二筆 key 重複 → 丟例外且 storage 完全不變（**突變**：把「先驗證再寫」對調成「邊驗邊寫」要紅）。
- `deleteTasks(['a','b'])`：紀錄鍵只掃一次 `get(null)`；兩個任務的序列紀錄都被濾掉、第三個任務的紀錄原樣。
- `countRecordsForTasks(['a','b'])`：只有一次 `get(null)`，`total` 等於兩者相加、`byId` 各自正確；單筆包裝的既有測試維持綠。
- `saveTasks` 第二筆不合法時例外訊息與 `saveTask` 單筆丟的一字不差，且 `e.index === 1`。
- `pruneSeries(['t#k1'])`：來源含 `t#k1`、`t#k2` 的卡片剩 `t#k2`；只含 `t#k1` 的卡片整張移除；不相干卡片位元組相同。
- `applyOrder` 與 `handleToggleAll` 既有測試維持綠，且新增「只有一次 `set`」斷言。

---

## 作業 B：任務頁多選與整批動作

### 現況與核對結果
- `#panel-tasks` 結構：`#missed-banner`、`.task-toolbar`（`#task-search`、`#task-failed-only`）、`#task-note`、`#task-list`、`#task-delete-dialog`（`report.html:1023-1046`）。
- 每列 `.task-row` 是 `flex-wrap`；拖曳排序在列的 `pointerdown` 綁定，`INPUT`／`BUTTON`／`A`／`SELECT` 上按下不啟動拖曳（`tasks.js:380-383`）。
- `renderTasks` 每次 storage 變動整份重畫（`report.js:1175` → `refreshCurrentView` → `loadAndRenderTasks`）；health 每次抓取都會變，所以**選取狀態不能存在 DOM 上**。
- 編輯鈕開面板的手勢寫法（`tasks.js:283-297`）：`tabs.getCurrent` → `setPanelCtx` → `openPanel`，要在點擊處理裡直接呼叫。

### 定案
1. **選取狀態**是 `tasks.js` 模組層的 id 集合，跨重畫保留；每次重畫把已不存在的 id 剔除。搜尋／只看失敗改變篩選時**不清空**選取（隱藏列仍算已選，計數說「已選 N 個」；其中不在目前篩選中的用一句「（k 個不在目前篩選中）」說明）。
2. 每列最前面一顆勾選框 `data-action="select"`，`aria-label` 是「選取「名稱」」；被選的列加 `.selected`（邊框用 `--primary`）。**`Shift`＋點**以「上一次點的列」到這列（依目前畫面順序）做範圍加選／取消（跟著被點那顆的新狀態）；錨點列不在目前畫面上（被篩掉或已刪）就當一般點擊。
3. 工具列加總勾選框 `#task-select-all`（`aria-label`「全選目前篩選結果」）：對目前篩選出的列全選／全取消；部分選取時 `indeterminate`。
4. 動作列 `#task-bulk-bar`（`role="toolbar"`，0 個已選時 `hidden`）：文字「已選 N 個」＋按鈕「啟用」「停用」「改排程」「刪除」「取消選取」。啟用／停用走 `saveTasks`（每筆展開既有任務只改 `enabled`）＋一次 `REBUILD_ALARMS`；進行中按鈕改字「停用中…」且整條動作列不可連按；完成後 `#task-note` 說「已停用 N 個任務」。
5. **整批刪除**：對話框改成吃 id 陣列——「確定要刪除 N 個任務嗎？此操作將一併刪除合計 M 筆歷史紀錄。」（筆數走 `countRecordsForTasks` 一次掃），三顆按鈕語意不變（「先匯出再刪除」仍是下載成功才刪；它匯出的是全部任務的紀錄，這是既有行為，本輪不改，進 BACKLOG）；刪完清掉這幾個 id 的選取。單一任務的「刪除」鈕走同一個對話框（陣列長度 1，訊息維持現在的單數句）。
6. **改排程**：寫 `setPanelCtx(tabId, { kind: 'bulk', taskIds })` 後 `openPanel(tabId, 'picker')`（與編輯鈕同一種手勢寫法，不得經 background 代開）。面板若已開著別的內容（例如編輯到一半）會被覆蓋，與現在按「編輯」的行為相同，不另加確認。
7. **就地改名**：名稱旁一顆小按鈕「改名」（`data-action="rename"`）；按了名稱換成 `<input>`（帶原值、全選、`aria-label`「任務名稱」），`Enter` 或失焦存檔、`Esc` 還原；空白不存並在 `#task-note` 說「名稱不能空白」；存檔是 `getTask` 取最新再只改 `name`（不重建排程，alarm 以 id 命名）。輸入框上的 `click`／`pointerdown` 要 `stopPropagation`（照儀表板頁籤的做法），否則會啟動拖曳排序。**改名中遇到重畫**（health 每次抓取都會變、任務頁整份重畫）：改名狀態存在模組層（`{ id, value }`），重畫時該列重建成輸入框、帶回輸入中的文字並還原焦點，不得把使用者打到一半的字洗掉。
8. **排程欄可點**：`.task-schedule` 改成 `button.task-link`（`data-action="edit-schedule"`，`title`「修改排程」），點了走第 6 條、`taskIds` 只有這一個；面板標題會說「修改「名稱」的排程」（見作業 C）。
9. 列上「編輯」「複製」「重選」「立即抓取」「刪除」維持不動；動作列與勾選框都不影響拖曳排序（`INPUT`／`BUTTON` 已被排除）。

### 改動
- `src/ui/report/report.html`（工具列、動作列、對話框、樣式：`.selected`、`#task-bulk-bar`、就地改名輸入框；只用 `theme.css` 變數）、`src/ui/report/tasks.js`。

### 測試／驗收（`tests/f3_tasks.test.js` 的 `fresh()` 樣板）
- 勾兩列 → `#task-bulk-bar` 可見且文字「已選 2 個」；`renderTasks` 再呼叫一次（模擬 health 變動）→ 兩列仍是 `.selected`（**突變**：把集合改成每次重畫重建要紅）。
- `Shift`＋點第 4 列（上一次點第 1 列）→ 1～4 全選；再 `Shift`＋點第 3 列（第 4 列現在是已選，點它變取消）→ 3～4 取消。
- 全選勾選框：搜尋剩 2 列時全選只選那 2 列；隱藏列已選時計數含「不在目前篩選中」。
- 「停用」：storage 只有一次 `set`、`REBUILD_ALARMS` 只送一次、被選的任務 `enabled === false`、未選的不變且 `foreground` 等欄位原樣（**突變**：改成逐筆 `saveTask` 要紅——數 `set` 次數）。
- 整批刪除：對話框訊息含「N 個任務」與合計筆數；確認後兩個任務與其紀錄都消失、第三個任務原樣；取消時 storage 位元組相同。
- 就地改名：`Enter` 後 storage 的 `name` 更新、`enabled`／`foreground` 不變；`Esc` 不寫；空白不寫且 `#task-note` 有句子；輸入框 `pointerdown` 不會觸發 `applyOrder`（**突變**：拿掉 `stopPropagation` 要紅）。改名中打了三個字再呼叫一次 `renderTasks` → 該列仍是輸入框、值是那三個字、`document.activeElement` 是它（**突變**：改名狀態改存 DOM 要紅）。
- `Shift`＋點時錨點列已被搜尋濾掉 → 只切換被點那一列。
- 整批刪除對話框只呼叫一次 `get(null)` 算筆數（chrome-mock 數呼叫）。
- 「改排程」與排程欄按鈕：`setPanelCtx` 的 session 內容是 `{ kind: 'bulk', taskIds: [...] }`，且 `openPanel` 被呼叫（用 `c.__setCurrentTab`）。

---

## 作業 C：整批改排程的面板檢視（`kind:'bulk'`）

### 現況與核對結果
- `renderFromPanelCtx` 分支：`waiting`／`batch`／`saved`／`edit`／`new`（`picker.js:2671-2746`），簽章是 `{kind, ctx, taskId, retarget, batch}`。
- `setBatchView(on)` 控制哪些區塊露出（`:2943-2973`）；`handleBatchSave` 是「逐項存＋一次 `REBUILD_ALARMS`＋`showSavedFeedback(count)`」（`:3147-3224`）。
- `validateForm` 把名稱、網址與排程混在一起驗（`:254-311`）；排程欄位的草稿在 `DRAFT_FIELDS` 內，面板重載會還原。
- `showSavedFeedback` 的 `count` 會把首句改成「已儲存 N 個任務。」（`:2245`）。

### 定案
1. 面板 ctx 新形狀 `{ kind: 'bulk', taskIds: string[], draft? }`；簽章加入 `taskIds`。開面板與套用時都以當下 storage 為準：`taskIds` 全部對不到 → 面板顯示一句「找不到要修改的任務」並提供關閉；部分對不到 → 只列出並套用找得到的，回饋說「已更新 4 個任務的排程（1 個已不存在）」。
2. **畫面**：只露 `#picker-title`、新區 `#bulk-section`（列出受影響的任務名稱，唯讀；`#bulk-note` 說明句）、`#schedule-section`、底部「取消」「套用到 N 個任務」（`#save` 改字）；`#name`、`#target-host`、`#setup-summary`、抓什麼、先試抓、儀表板、進階、「固定為預設值」、`#repick-target`、`#test-now` 全部隱藏。切換邏輯照 `setBatchView` 的做法另寫 `setBulkView(on)`，兩者互斥（`renderFromPanelCtx` 非 `bulk` 一律關掉它）。標題：1 個任務是「修改「名稱」的排程」，多個是「整批修改 N 個任務的排程」。
3. **預填**：所有任務的排程正規化後（`weekdays` 排序、`times` 排序去重、`window` 缺省視同無）全等 → 預填該排程，`#bulk-note` 說「N 個任務目前的排程相同」；不全等 → 預填 `order` 最小那個任務的，`#bulk-note` 說「所選任務的排程不同，目前顯示的是「名稱」的；套用後 N 個任務都會改成下面的設定」。**回填機制只有一份**：把 `render` 裡「`task.schedule` → 排程欄位」那一段（`picker.js:633-650`）抽成 `fillSchedule(schedule)`，`render` 與 bulk 都呼叫它，之後跑 `syncScheduleFields()`（chip、時段開關、預覽句）。**不套 `pickerDefaults`、不更新 `last`／`pinned`**（與編輯同一條規則）。
4. **驗證**：把排程規則從 `validateForm` 抽成 `validateSchedule(values)`（`validateForm` 改為呼叫它，錯誤訊息一字不改），bulk 只跑 `validateSchedule`。
5. **套用**：每筆 `getTask` 最新版展開後只換 `schedule`（**不經 `buildTask`**）→ `saveTasks` 一次 → `REBUILD_ALARMS` 一次 → `GET_NEXT_RUNS` 取這些任務裡最早的一個 → `showSavedFeedback` 首句「已更新 N 個任務的排程。」，1.5 秒自動關；任一筆存檔失敗整批不寫（`saveTasks` 的守門）並在 `#errors` 說原因、不關窗。所選任務**全部停用**時第二句不得退回白話句（會讓人以為會跑），改說「所選任務都停用中，不會排程；到任務頁啟用後才會抓」；部分停用時「下次抓取」只看啟用的那些。
6. 草稿：排程欄位已在 `DRAFT_FIELDS`，重載還原照舊；套用或取消時連 ctx 一起清。
7. `canStartPick`／`pickEntryOf` 對 `bulk` **視同 `edit`**（右鍵或 popup 入口被擋時的 notice 句改成「有一批任務的排程改到一半，請先套用或取消」）；`PICKED` 不可能落在 Report 分頁上，不另處理。
8. 教學頁不新增節，改在既有「看報表與儀表板」節的「遇到這些狀況」加一條；SPEC §8.4 與 §2〈面板的畫面狀態〉補 `bulk`。

### 改動
- `src/ui/picker/picker.html`（`#bulk-section`、`#bulk-note`）、`src/ui/picker/picker.js`（`renderFromPanelCtx` 分支、`setBulkView`、`renderBulk`、`handleBulkSave`、`validateSchedule`）、`src/background/main.js`（`pickEntryOf` 的 `bulk`）、`src/shared/storage.js`（session 形狀註解）。

### 測試／驗收
- ctx `{kind:'bulk', taskIds:['a','b']}` 兩任務排程相同 → `#schedule-type`／`#times`／星期與該排程一致、`#bulk-note` 含「相同」；排程不同 → 預填 `order` 較小者、note 含「不同」與該任務名稱（**突變**：正規化拿掉 `weekdays` 排序，`[1,2]` 與 `[2,1]` 要被判成不同而測試紅）。
- 露出區塊斷言：`#schedule-section` 可見，`#name`、`#block-section`、`#add-to-dashboard`、`#advanced-section`、`#repick-target`、`#test-now` 皆 `hidden`。
- 預填 interval 帶 `window` 的排程 → `#window-enabled` 勾起、`#window-fields` 可見、`#schedule-preview` 非空（證明走了 `fillSchedule`＋`syncScheduleFields`）；`render` 的既有排程回填測試（`c8_picker_schedule_fields`、`r2_schedule_ui`）維持綠。
- `taskIds` 三個裡一個不存在 → 清單兩列、套用後回饋含「（1 個已不存在）」；兩個全停用 → 回饋含「都停用中」且不含「下次抓取」。
- 套用：storage `set` 一次、`REBUILD_ALARMS` 一次、兩任務 `schedule` 相同且 `enabled`／`foreground`／`fields`／`locator` 原樣（**突變**：改成走 `buildTask` 要紅——斷言 `foreground` 仍在）；`pickerDefaults` 未變。
- 驗證失敗（interval 每 0 分鐘）：`#errors` 有訊息、storage 不變、面板未關。
- `pickEntryOf` 對 `bulk` 回擋，notice 句正確。

---

## 作業 D：編輯既有任務的修正

### 現況與核對結果
見核對表 P1～P4、P13。另外：`main.js` 的 `pickSpecOf`／`stripPos`／`sameSpec`／`keepPos`／`posOfTask`／`defaultFieldName`（`:56-128`）只有 background 用；Picker 的多值列由 `createFieldRow` 建、名稱守衛是 `input._afAutoName`（`picker.js:1653-1725`）。

### 定案
1. **執行期欄位跟著既有任務走**（修 P1）：`buildTask(values, locator, existing, frame)` 在 `existing` 存在時原樣帶過 `enabled`、`foreground`、`suggestForeground`、`notFoundStreak`、`precheckLeadMinutes`；**既有任務缺哪個鍵就不憑空加**（`enabled` 缺省照舊視為啟用）；新建維持 `enabled: true`、其餘不出現。清單寫成一個常數，`duplicateTask` 要刪的欄位（`notFoundStreak`、`order`）與它是同一份口徑的兩面，SPEC §2.1 記下來。**編輯停用中的任務**：標題列多一句狀態「此任務目前停用」（`#task-status-note`），儲存回饋第二句改成「此任務目前停用，不會排程；到任務頁啟用後才會抓」而不是「下次抓取：…」——以前存檔會意外復活所以看起來會跑，修好之後不能再讓白話句誤導。
2. **同一格就保留 key 與名稱，只有一份**（修 P3）：`pickSpecOf`／`stripPos`／`sameSpec` 搬到 `src/shared/field-match.js`，並新增 `reconcileFields(prevRows, picks)`：`prevRows` 是 `[{key, name, spec, auto}]`（`auto` 是當時的自動名），回傳每個 pick 的 `{key, name, auto, kept}`——比對到就沿用 key 與名稱，比不到就給新 key、名稱留 `null` 讓呼叫端算預設名。background 的 `applyRepick` 改用 shared 的三個函式（行為不變）；Picker 的換目標改用 `reconcileFields`。
3. **換目標保留清單擴大**：`applyRetarget` 先抄下多值列（key、名稱、自動名、spec）、`#alert-list` 與 `#preaction-list` 的表單值，`render` 後貼回：多值列照第 2 條對回（沒對到的新列用預設名，被移除的列消失），告警列與前置動作列原樣重建（告警的 `field` 對不到任何保留下來的 key 時那條告警的欄位下拉退回既有的「全部值」選項，值 `''`）。提示句改成「已換成新的目標；名稱、排程、告警、前置動作都留著」，有值被移除時接「，移除了 N 個對不到的值」。
4. **編輯模式隱藏「回頁面重選目標」**（修 P2）：`kind:'edit'` 與 `initFromQuery` 的 `?taskId=` 兩條都把 `#repick-target` 藏起來（與 `#test-now` 同處）；要換目標走任務頁的「重選」。BACKLOG「編輯既有任務時也能回頁面重選目標」保留，觸發條件改寫成「要先做『編輯時把面板開在目標網址的分頁上』」。
5. **孤兒序列**（修 P4）：編輯存檔（Picker `handleSave`，`existing` 有 `fields`）與任務頁重選（background `applyRepick`）都算出「舊 fields 有、新 fields 沒有」的 key，對其序列 id 呼叫 `pruneSeries` 與 `deleteLastValues`；**紀錄一律保留**到保留天數自然到期。Picker 的儲存回饋多一行「已移除 N 個值；它們的歷史紀錄會保留到保留天數到期」（放進 `saved` ctx 的 `warning` 之外另一鍵 `note`，同樣由 ctx 重畫）；background 側記一筆診斷 `fields_pruned`。
6. **上下移停用理由**（P13）：兩顆改 `aria-disabled` 並在被點時把理由寫進該列的 `[data-field-result]` 旁的提示（「已經是第一個」「已經是最後一個」），照工具列「停用不得靜默」那條規則；BACKLOG 該條刪除。

### 改動
- 新檔 `src/shared/field-match.js`；`src/background/main.js`（改 import、`applyRepick` 後段的孤兒清理與診斷）；`src/ui/picker/picker.js`（`buildTask`、`applyRetarget`、`handleSave` 的孤兒清理、edit 分支隱藏、上下移理由）；`src/shared/storage.js`／`layout-store.js` 用作業 A 的 API。

### 測試／驗收
- `buildTask(values, loc, {enabled:false, foreground:true, notFoundStreak:3})` → 三個欄位原樣；`existing` 沒有 `foreground` 鍵 → 產出也沒有；不帶 `existing` → `enabled === true` 且沒有 `foreground` 鍵（**突變**：清單少掉 `foreground` 要紅）。
- 編輯 `enabled:false` 的任務：`#task-status-note` 可見；存檔後 `saved` ctx 的文字含「目前停用」且不含「下次抓取」。
- `reconcileFields`：同一格改了 `pos`／`exclude` 仍視為同一格（key 沿用）；`inner` 不同視為不同格；新 pick 得到新 key 且 `name === null`。
- 換目標鏈結測試：多值任務三列改名 → 收到 `retarget` 的 payload 是四個 pick（含原三格）→ 三列名稱與 key 不變、第四列預設名；告警列數量與 `field` 不變；前置動作列原樣（**突變**：`applyRetarget` 貼回時跳過告警要紅）。
- edit ctx 渲染後 `#repick-target.hidden === true`；`?taskId=` 路徑同。
- 編輯移除一個值後存檔：`pruneSeries` 收到那條序列 id、`lastValues` 該鍵消失、紀錄鍵原樣、`saved` ctx 含 `note`；`applyRepick` 少一格時同樣清理並有 `fields_pruned` 診斷。
- `node --check` 全部檔案；既有 `tests/m2_chain.test.js` 補一條 retarget 的 `picks` → 列名稱鏈結。

---

## 作業 E：選取模式補強

### 現況與核對結果
見 P8～P12。`cancelPick` 有三個呼叫點（`Esc`、面板「取消」、右鍵選單「取消」）；`replaceConfirmPending` 的清除點共 10 處（`picker-mode.js:536, 580, 2833, 3290, 3315, 3332, 3681, 3719, 3904`）；面板結構是 `panelEl > [data-af-panel-body] + 動作列`，chip 容器是匿名 `listDiv`；`drawPicksOn` 由索引找格子一律走 `targetAtGrid`（`:811-880`）。

### 定案
1. **取消二段確認**：三個呼叫點（`Esc`、面板「取消」、右鍵選單「取消」）收成 `requestCancel()`。`selectedCount() >= 2`（批次模式算所有組的總數，與換表閾值同一個數字）且 `cancelConfirmPending` 未設 → 只設旗標（記下時間）並在面板說「再按一次 Esc（或再點取消）才會取消（會丟掉 N 個已選值）」；已設 → 真的 `cancelPick()`。**防長按與連按**：`keydown` 帶 `repeat` 的 `Esc` 一律忽略；第二次距第一次不滿 400 毫秒也只當第一次（否則習慣性連按兩下、或按住不放的 key repeat 會直接穿過確認）。**清除點與換表旗標同一批**：兩個旗標的清除收成一個 `clearPendingConfirms()` 取代那 10 處（改變已選集合、換組、進出選取模式），再加上 `Esc` 以外的任何按鍵；**右鍵開選單不清**（否則選單裡的「取消」永遠只是第一步），滑鼠移動不清（兩次 `Esc` 之間手會動）。用途是 `preaction`／`login-*` 時不適用（它們一次只選一個）。
   既有測試裡按一次 `Esc` 且當時已選 ≥2 的案例要改成兩次（先逐一核對：`b4_pick_mode:77,87`、`l7_batch_b3:253`、`m1_batch_b5c:186`、`s3_side_panel:255,369`、`v2_inner_pick:100`；`j1_dnd:136` 是 Report 頁的拖曳，不相干）。
2. **面板高度**：chip 容器最大高度 `40vh` 可捲是主要機制（批次每組的容器各自套）；`panelEl` 最大高度 `calc(100vh - 32px)`、`[data-af-panel-body]` `overflow-y: auto` 只是保險，正常情況不該同時出現兩層捲軸；動作列永遠看得見。閃避規則不變。
3. **chip ↔ 格子**：chip `mouseenter` 讓那個 pick 涵蓋的格子加 `data-af-chip-hover`（`COLORS` 裡既有的主色再加粗外框，不新增色碼）、`mouseleave` 移除；點 chip 本體（非 `×`）把第一個格子 `scrollIntoView({ block: 'nearest' })` 並同樣加強 1 秒。**找格子只能經 `drawPicksOn` 同一條路（`targetAtGrid`）**，抽成 `cellsOfPick(tableEl, pick)` 讓兩者共用；整欄／整列值的加強涵蓋它標示的所有格。每次 `applyPickedMarks` 重貼時不清這個標記（hover 中格子會重畫）。批次模式的元素組 chip 同理作用在 `g.el`。
4. **`Ctrl+A` 截斷提示**：掃描時數「符合條件的資料格總數」`scanned`，截斷時面板說「這張表有 S 格，只選到前 M 格（上限）」；未截斷維持現句。
5. **`Delete`**：與 `Backspace` 同一條（清單空的時候不攔）。
6. **動作列不位移**：「完成」「取消」固定在動作列最前面兩顆；「復原」「去掉第一格」「去掉最後一格」一律排在它們之後，出現與否不改前兩顆的位置（動作列仍只建一次）。
7. **工具列預告**：已選非空時四段的 `title` 改成「會把最後選的『X』換成整欄→一個值」之類（X 是最後一項的 chip 名稱）；清單空時還原成固定說明。在 `updatePanelActions` 同一處更新。
8. **`Enter` 提示**：已選非空且滑鼠停在未加選的格子上時，面板指令句接「（Enter＝完成，只送已選的 N 個；要加這一格請先點它）」。
9. **批次組名收斂**（P12）：**只在批次 payload 的元素組**補 `nameHint`（元素文字去空白前 20 字）；單任務的非表格 payload 維持不帶（SPEC §2「非表格不帶，由 Picker 退回文字錨定或預覽前 20 字」不動，否則所有單一元素任務的預設名都會變）。頁面組標題改成「任務 N（M 個值）：提示」，提示對表格組用 `computeNameHint`、元素組用同一個 20 字規則，與 payload 的 `nameHint` 同源（同一個函式算）。Picker 端 `defaultTaskName` 不動（單格仍優先用欄標題）。

### 改動
- `src/content/picker-mode.js`；教學頁 `ui/help/help.html` 對「取消」「復原」的句子同步（作業 G）。

### 測試／驗收（`tests/b4_pick_mode.test.js`／`y2_click_add.test.js` 的樣板）
- 選 2 格按 `Esc` → 仍在選取模式、面板有「再按一次」句、未送 `PICKED`；500 毫秒後再按 `Esc` → 送 `PICKED{cancelled:true}`。選 1 格按 `Esc` → 直接取消。選 2 格按 `Esc` 後再點加一格再 `Esc` → 只提示不取消（旗標已清；**突變**：加值前不清旗標要紅）。兩次 `Esc` 相隔 100 毫秒 → 不取消；`repeat: true` 的 `Esc` → 不取消也不設旗標（**突變**：拿掉間隔判定要紅）。`Esc` 後右鍵開選單再點「取消」→ 取消（右鍵不清旗標）。面板「取消」鈕走同一條。
- 單任務非表格 payload 仍不帶 `nameHint`（既有測試守著）。
- 60 個 pick 時 chip 容器 `style.maxHeight` 與 `overflowY` 已設、動作列仍是 `panelEl` 的直接子節點。
- chip `mouseenter` → 對應格子帶 `data-af-chip-hover`，`mouseleave` 移除；整欄 chip → 該欄每一資料格都帶；點 chip → `scrollIntoView` 被呼叫（jsdom 補樁）。
- `Ctrl+A` 對 150 格的表（`maxPicks` 100）→ 面板含「150 格」與「100 格」。
- `Delete` 在有已選時移除最後一項並存快照；清單空時不 `preventDefault`。
- 動作列子節點前兩顆永遠是 `[data-af-done]`、`[data-af-cancel]`（`trimReady` 前後各斷言一次）。
- 已選 1 格後工具列 `[data-af-tool="col"]` 的 `title` 含該 chip 名稱；清空後還原。
- 元素組 payload 帶 `nameHint`；面板組標題與 payload 的 `nameHint` 相同。

---

## 作業 F：Picker「拆成每個值一個任務」

### 現況與核對結果
- 批次面板 ctx 形狀 `{kind:'batch', items:[{key, locator, picks, blockInfo, preview, previewSamples, previewValue, nameHint, url, tabId, frameId?, frameUrl?}], draft?}`（`main.js:433-448`）；名稱由 `draft.batchNames[key]` 覆蓋（`picker.js:2996-3020`）；批次清單沒有數量上限，頁面組數上限 20。
- 多值表單的列在 `#field-list`，`row._spec` 是 `{cell}`／`{block}`。

### 定案
1. 多值表單（`kind:'new'`、列數 ≥2）的「一鍵命名」列旁加按鈕 `#split-tasks`「拆成每個值一個任務」；編輯既有任務與批次檢視不顯示。
2. 按下：以目前每一列組 `items`——每項複製目前 ctx 的共同欄位（`locator`、`blockInfo`、`url`、`tabId`、`frameId`／`frameUrl`、`nameHint`），`picks` 只放該列的 spec，不帶 `preview`／`previewValue`／`previewSamples`（那是整批的）；`draft.batchNames[key]` 寫成該列目前的名稱（不論是否手改），共用欄位（排程、儀表板、卡片型別、合成方式）經現有草稿機制帶過去；接著 `setPanelCtx(tabId, { kind:'batch', items, draft })`，面板照既有 `batch` 路徑重畫。頁面上的 `held` 標示不動。
3. 列數 >20 時按鈕 `aria-disabled` 並說「一次最多 20 個任務」（與頁面的組數上限同一個數字，寫成 shared 常數或兩處引用同一值）。
4. 反向「合併成一個任務」不做，進 BACKLOG。

### 改動
- `src/ui/picker/picker.html`、`src/ui/picker/picker.js`。

### 測試／驗收
- 三列（第二列改名「庫存」）按 `#split-tasks` → session 的 ctx `kind === 'batch'`、`items.length === 3`、每項 `picks.length === 1` 且與該列 spec 全等、`draft.batchNames` 三個鍵的值是三列名稱、`items[i]` 不含 `preview` 鍵；接著 `renderFromPanelCtx` 該 ctx → `#batch-list` 三列、名稱輸入框值分別是三個名稱、`#schedule-type` 與拆之前相同（**突變**：`items` 少帶 `locator` → `handleBatchSave` 存出的任務缺 `locator` 要紅，作鏈結測試）。
- 編輯既有任務時 `#split-tasks.hidden === true`；21 列時 `aria-disabled` 且點了有理由句。

---

## 作業 G：文件與收尾

1. `docs/SPEC.md`：§2 面板畫面狀態加 `bulk`；§2 選取模式加二段取消、面板高度、chip 互動、`Delete`、`Ctrl+A` 提示、動作列順序、工具列預告、Enter 提示、批次 `nameHint`；§2 換目標保留清單改寫；§2.1 編輯保留執行期欄位清單、編輯模式隱藏「回頁面重選目標」；§5 `saveTasks`／`deleteTasks`／`deleteLastValues`／`pruneSeries` 與孤兒序列規則；§8.4 多選、動作列、整批刪除、就地改名、排程欄可點；§7 補「值被移除時的序列處理」。
2. `docs/BACKLOG.md`：刪「多值清單的上／下移按鈕停用時也給不出理由」；改寫「從設定面板回頁面加選一個值」為已完成（刪除）、「編輯既有任務時也能回頁面重選目標」觸發條件改寫；新增「批次清單合併成一個任務」「chip 拖曳排序」「整批修改儀表板／前景抓取」「『先匯出再刪除』只匯被刪任務的紀錄」「整批改排程的復原」；「編輯時把面板開在目標網址的分頁上」既有，保留。
3. `ui/help/help.html`：既有「看報表與儀表板」節的摺疊區加「一次改好幾個任務的時間」三步；「我想在同一張表抓好幾個值」節加「選錯了想全部取消：Esc 要按兩次」與「拆成每個值一個任務」；新的介面字串（「改名」「改排程」「套用到 N 個任務」「拆成每個值一個任務」「全選目前篩選結果」）標 `data-ui-label`。
4. `CLAUDE.md`：慣例區加「任務存回 storage 時一律展開既有任務再覆寫表單擁有的欄位；執行期欄位清單在 `picker.js`」與「取消類二段確認的旗標要與換表旗標一起清」。
5. `src/manifest.json` 與 `package.json` 升 **0.18.0**；`npm test` 全綠且 ≥2291；`./run_smoke.sh` 跑一次（Chrome）。
6. 體檢交接：全量測試數、與 2291 的差、終檢兩份（程式碼／文件）結果記在下方「執行紀錄」。

---

## 明確不做（本輪定案）

| 項目 | 理由 |
|---|---|
| 整批修改儀表板／卡片型別、前景抓取、額外等待 | 對既有任務是「加卡片」不是改設定，容易重複建卡；後兩者連單任務表單都沒有欄位。進 BACKLOG |
| 編輯模式在 Report 分頁旁「回頁面重選目標」 | 要先做「編輯時把面板開在目標網址的分頁上」；本輪改成隱藏，任務頁「重選」已能用 |
| 移除值時刪除其歷史紀錄 | 不可逆；保留到保留天數到期 |
| 批次清單合併成一個任務 | 只在所有項同一張表時有意義，需求未出現。進 BACKLOG |
| chip 拖曳排序 | Picker 已有上下移；面板端再做一份順序控制是第二個入口 |
| 拖曳框選順序跟著拖曳方向 | 與試算表一致，維持列優先 |
| 整批操作的復原 | 啟用／停用可反向操作、刪除有確認與先匯出、改排程沒有復原（與單任務編輯相同） |
| 「先匯出再刪除」只匯出被刪的任務 | `buildExport` 沒有任務篩選，現在匯的是全部任務；既有行為，進 BACKLOG |
| 多值任務的值名稱在任務頁就地改 | 走編輯表單即可；任務頁只做任務名稱 |
| 任務頁名稱雙擊改名 | 列的 `pointerdown` 會啟動拖曳排序，雙擊會觸發兩次拖曳起訖；只留「改名」鈕 |
| 已選非空時 `Enter` 加入滑鼠下的格 | 語意會與「完成」衝突，只補提示句 |
| `ui-ux-pro-max` 建議的配色與字型 | `theme.css` 是顏色唯一來源，不換 |

## 規劃完成後複檢

- **與既有設計的衝突**：(a) SPEC §2「面板已經有表單時再選一次目標＝換目標，不重置」——本輪把「不重置」的範圍明寫（值名稱、告警、前置動作），是補齊不是推翻；(b) SPEC §2.1「編輯既有任務不套用任何預設值」——`bulk` 沿用同一條；(c) CLAUDE.md「存任務與加卡片分開」——bulk 不碰卡片，無衝突；(d) SPEC §2「取消／`Esc` 只清自己那一群」——二段確認只影響是否進入 `cancelPick`，`held` 分群邏輯不動；(e) `pruneCardsForTask` 的「歸零整卡移除」——`pruneSeries` 沿用同一語意並收成同一份判定。
- **批次之間的衝突**：A 的 `saveTasks` 被 B、C、popup 消費，介面在 A 定好（陣列進、例外出）；D 的 `buildTask` 改動與 C 的「不經 `buildTask`」互不影響；E 的 `clearPendingConfirms()` 取代 10 處清除點，與 F 無交集；B-8 排程欄按鈕依賴 C 的 `bulk` 分支，順序已排 C 在 B 前。
- **四個坑**：什麼算一個——「已選 N 個」以 id 計、Ctrl+A 的 S 以「符合條件的資料格」計（表頭與 `cIdx < 0` 不算）；分母為零——0 個已選時動作列 `hidden`、`taskIds` 對不到任務時面板說明；破壞性判準的反例——整批刪除只刪明確勾選的 id，隱藏列已選也會被刪，所以計數句必須說出「不在目前篩選中」的數量（驗收有列）；單向閘門——二段確認旗標會被任何動作清掉，不會卡死；移除類——`pickSpecOf` 等三個函式搬家後 `main.js` 是唯一舊消費端，白名單含它。
- **升級／既有資料**：無 schema 變動；`saveTask` 改成包裝 `saveTasks` 後錯誤訊息不變；既有任務缺 `foreground` 等欄位時 `buildTask` 不會憑空加鍵。
- 複檢完成，補了「隱藏列已選也會被整批刪除」這一條進 B 的驗收。
- **第二輪複檢**（使用者／程式／管理者／整體四個角度）補進文件的項目：改名中遇到重畫要保住輸入（B-7）、`Shift` 錨點被篩掉的退路（B-2）、整批筆數一次掃（A-3、B-5）、bulk 部分任務不存在與全部停用的回饋（C-1、C-5）、排程回填抽成 `fillSchedule` 一份（C-3）、編輯停用任務的狀態句與回饋（D-1）、告警退路選項措辭改「全部值」（D-3）、`Esc` 的 key repeat 與 400 毫秒間隔、右鍵不清旗標、既有 `Esc` 測試清單（E-1）、兩層捲軸的主次（E-2）、`nameHint` 收窄到批次元素組（E-9）、`saveTasks` 例外訊息與單筆一致（A-1）、缺鍵不憑空加（D-1）、每段先 `node --check`、明確不做四條。
- 既有限制順手記錄（不在本輪處理）：所有任務寫入都是整個 `tasks` 陣列的 read-modify-write，background 更新 `notFoundStreak` 與 UI 存檔之間本來就有競態窗口，整批寫入反而縮小它；`missed` 清單不隨任務刪除清理（由補抓流程重算）。

## 執行紀錄

委派模型：agy `gemini-3.8-flash-high`（整輪未切換）；subagent 一律 opus low（`scan-low`）。

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A 儲存層整批 API | agy | 一次過 | z1 25 則（Claude 另補 3 則次數測試）；全量 2313→綠 | 首個突變「邊驗邊寫」是等價突變（`set` 仍在迴圈後），改用「迴圈內寫入」重做才紅 3 則；`tasks.js` 單筆存檔也改成 `saveTasks([x])` 以過 grep 驗收，語意無害 |
| D 編輯既有任務的忠實度 | Claude | 一次過 | z2 31 則；三個突變各被抓到 | 既有 `s3_side_panel` B-10 是「從第一個 `repick-target` 往後掃 600 字」的文字掃描，被編輯模式的隱藏程式碼卡到；改成鎖定點擊綁定那一處，守的東西不變。D-3 測試前置原本直接 `render`，`retarget` 分支只在面板畫過一次後成立，改走 `renderFromPanelCtx` |
| C 整批改排程面板 | agy | 一次過 | z3 18 則；三個突變（星期不排序、丟執行期欄位、改用 validateForm）各被抓到 | 規格第 3 點原本對標題列的寫法自相矛盾，委派前改掉 |
| B 任務頁多選與整批動作 | agy | 一次過 | z4 27 則＋Claude 補 1 則（重畫多次後只寫一次）；突變：監聽每次都綁、重畫清空選取、改名不寫回狀態 | 「拿掉改名輸入框 `stopPropagation`」是等價突變：列的拖曳本來就略過 `INPUT` 目標 |
| E 選取模式補強 | agy | 一次過 | z5 23 則（9 則是不得退化的守門，先綠屬預期）；突變：拿掉 400ms、拿掉 repeat 守門、不記截斷 | E-6「完成／取消在前」現況已成立，只加守門測試。既有 6 處按 `Esc` 的測試都是已選 0～1 個或前置動作，不受影響，未改 |
| F 拆成每個值一個任務 | Claude（原定 agy） | 一次過 | z6 8 則；突變「少帶 locator」抓到 2 則（含存檔鏈結） | 實作約 40 行，規格＋委派的固定成本高於自做。上限 20 收成 `shared/messages.js` 的 `MAX_BATCH_TASKS`，頁面組數上限改引用它 |
| G 文件與收尾 | Claude | 完成 | 教學頁測試 14 綠、慣例測試綠 | SPEC §2／§2.1／§5／§8.4、BACKLOG（刪 2、改 1、增 6）、CLAUDE.md（地圖＋6 條慣例、基線 2424）、版本 0.18.0 |
| 終檢（程式碼） | scan-low | 18 條，成立 11 條已修 | 修後全量 2432 綠 | 見下方〈體檢交接〉 |
| 終檢（文件） | scan-low | 12 條，成立 9 條已修 | 教學頁 14 綠 | 見下方〈體檢交接〉 |

## 體檢交接

- **全量測試**：2432 則全綠（基線 2291，本輪 +141）。版本 0.18.0。
- **終檢抓到並修掉的**（兩份終檢重疊的合併計）：
  1. 整批改排程把整個標題列藏起來，標題「整批修改 N 個任務的排程」看不到——而且 Claude 寫的測試把「標題列要藏」寫進了斷言（規格第 3 點本身就自相矛盾）。改成只藏名稱、主機、停用提示與摘要卡。
  2. `fillSchedule` 只寫「有的鍵」：同一份面板文件從編輯 A 切到整批改排程，A 的時段與星期會殘留並被套用到所有被選的任務。改成每一欄確定寫入，補鏈結測試並突變驗證。
  3. 委派端把 `#errors` 搬進儲存回饋區，只因為 Claude 的測試在存檔成功後還讀它（為測試遷就正式碼）。退掉正式碼、改測試。
  4. 整批啟停寫入失敗時沒有任何訊息（未處理的 rejection）；編輯移除值時清理失敗被 `catch {}` 吞掉、回饋照樣說已移除。兩處都改成說出來。
  5. `applyRetarget` 的 `keyMap` 是死碼（Claude 寫的，鍵對不上）；`main.js` 多匯入 `sameSpec`。清掉。
  6. 排程欄按鈕漏了 `title`「修改排程」（規格 B-8）；改名剛打開沒有全選原值（B-7）。補上。
  7. 測試偏弱：拆分上限的斷言恆真（session 沒放東西）、工具列預告只比對一個字、缺「右鍵不清確認」與「清單換了但數量相同」兩則、缺真正從後台 `PICKED` 走到面板的換目標鏈結測試（規劃驗收寫了卻沒做）。全部補上並各做一次突變。
  8. 既有 `f3_tasks` 一則用「列裡第一個有 `title` 的元素」找錯誤訊息，被新的排程欄 `title` 搶先；改成找狀態欄。
- **終檢指出但定案保留的**：
  - chip 加強標記在重貼時一併清掉（推翻規劃「重貼不清」）：chip 在滑鼠換格時整批重建，舊 chip 的 `mouseleave` 不會觸發，不清會殘留；滑鼠在面板上時頁面不重貼，不影響滑過。已寫進 SPEC。
  - 批次組標題維持「任務 N：提示（M 個值）」（規劃想改格式，未改以免動到既有測試與使用者熟悉的樣子）。已寫進 SPEC。
  - 措辭與規劃例句不同的三處（刪除句多「這」、換目標與移除提示的語序）：SPEC 已照實作寫。
  - `saveTasks` 同一批兩筆相同 id 不擋（沒有任何呼叫端會這樣傳）；設定匯入與批次建立仍逐筆寫（前者要逐筆跳過壞任務、後者每項要各自加卡片，都是既有設計）。
  - 送出時 chip hover 蓋掉保留藍框：實讀程式後不成立（還原的外框就是已選藍框本身）。
- **真實瀏覽器煙霧測試**（`./run_smoke.sh`）：Chrome for Testing 與 Edge 兩邊全部通過（選取模式進出、真實滑鼠點選／雙擊送出、iframe、自動登入、排程、擷取等既有案例）。
  煙霧腳本沒有涵蓋本輪新增的任務頁多選、整批改排程面板與選取模式二段取消，這幾項只有 jsdom 測試，**需要使用者畫面實測**。

## 體檢輪修正（換模型體檢）

實作：Claude Opus 5 規劃／驗收＋agy `gemini-3.8-flash-high`；體檢：Claude Fable 5.1，subagent 為 opus low（`scan-low`）兩個，各附 jsdom 探針、每條標「已實測重現／推論」，並列出實作輪終檢已查過的清單不重查。

1. **`picker-mode.js` `requestCancel`：每 300 毫秒按一次 Esc 永遠取消不了**（探針實測按 8 次仍未取消；面板「取消」鈕同）。太快的第二下會把計時基準往後推。改成不重設計時。迴歸：z5「每 300 毫秒按一次，第三下要取消」。
2. **同上：數量不變的清單變動不重置確認**（工具列把最後一格換成整欄、右鍵排除／取消排除，實測之後的 Esc 直接取消）。判定從「比數量」改成「比清單內容簽章」，一次涵蓋所有路徑；換表的「再點一次」提示出現時取消的確認作廢。迴歸：z5「工具列換成整欄之後確認要重來」。
3. **`picker-mode.js` `confirmPick`：批次模式恰好一組元素時，單任務訊息多帶 `nameHint`**，違反「恰好 1 組時與非批次逐欄相同」。只在真的送出 `batch` 陣列時補。迴歸：z5 同名測試。另 `BATCH_LIMIT_NOTICE` 的 20 改引用共用常數。
4. **`tasks.js` 整批刪除對話框開著時改選取，確認鈕刪的是開啟當下那幾個**（實測：訊息說刪 a、b，畫面勾的已是 b、d，按確認刪掉 a、b）。選取一變就收掉對話框並說明。迴歸：z4 兩則（含單列刪除不受影響）。
5. **`tasks.js` 同時出現兩個改名輸入框**（共用一份 `renaming`，存其中一個會丟掉另一個的編輯；真實瀏覽器則是上一列失焦存檔重畫、第二顆按鈕的 click 不會來）。改成全列重畫、換列前先存上一列，並在 `pointerdown` 記下意圖、存檔後兌現。迴歸：z4「同一時間只會有一列在改名」。
6. **`tasks.js`「先匯出再刪除」下載失敗時對話框卡住、無訊息、unhandled rejection**（結構是既有的，本輪從單筆擴大到整批）。包 try/catch、說出來、不刪。迴歸：z4 同名測試。
7. **`main.js` `applyRepick`：單值任務重選成多值時，原本那條序列（id 就是任務 id）的卡片來源與 `lastValues` 沒清**——正是本輪要修的空白卡片症狀，走的是另一條路。`applyRepick` 改回傳孤兒序列 id。迴歸：z2 同名測試。
8. **`picker.js` `fillSchedule`（實作輪最後的手改）把「星期缺省＝每天」套到 daily**：daily 的星期必填（`nextDailyRun` 對空星期回 null）。先改成「都不勾」時全套測試有兩則因夾具不帶星期而存檔被擋，定案為「daily 缺星期明確回到表單預設的週一～五」（與全新面板文件的結果相同，又不沿用上一個任務的勾選）。迴歸：z3 同名測試。
9. `applyRetarget` 重設了使用者上下移過的順序（提示句說都留著）→ 沿用的值照原順序、新值接後面；多值換單值時提示句不再說「移除了 N 個」。`reconcileFields` 對認不得的 pick 不再與 `spec: null` 的舊值配對（`'null' === 'null'`）。`deleteTasks` 一併清被刪任務的 `lastValues`（資料已讀進來，不多一次讀取）。`splitIntoTasks`／`openBulkSchedule` 解不到分頁時說明而不是靜默。改名鈕移除永不執行的 `select` 退路分支。迴歸：z2 三則、z1 一則。
10. 文件：SPEC §7 補「值被移除時」的交叉指引（規劃 G-1 寫了、實作輪漏了）；CLAUDE.md 一條與既有「不要為了讓測試好寫…」重疊的規則併成一條。

探針已實測、無異常而不動的：面板 kind 切換矩陣 12 組全部正確復原、`cellsOfPick` 抽出後與基準版 278db75 在 12 個情境逐格相同、`exitPickMode` 重設所有新增模組變數、`handleSave` 不會誤走整批路徑。
不修、進 BACKLOG 的：`describeSchedule` 對「daily 且星期缺省」說「每天」、`fields` 與 `spec.fields` 不一致的舊資料。
jsdom 測不到、待使用者畫面實測：面板自動換角與兩層捲軸的實際表現、拖曳框選之後的 Esc。

測試：2445 則全綠（基線 2291，本輪 +154）。
