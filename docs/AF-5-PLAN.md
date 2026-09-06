# AF-5 第 5 輪規劃:抓取結果可見、一任務多值、Picker 精簡、視覺升級
> 狀態:規劃中(第 4 版,情境走查後;待使用者確認後開分支)
> 基準:dev@7249189(1138 綠)
> 來源:使用者實測回饋 5 項 + 評估中發現的 bug + 視覺升級需求
> 本文只寫符號名不寫行號(行號在實作中會漂,委派端以符號定位)。

## 回饋核對表

| # | 回饋 | 結果 | 根因 |
|---|---|---|---|
| P1 | 新增抓取欄位後卡片重複 | ⚠️ 設計如此但體感錯 | Picker number 模式預設勾「數字 + 折線」(`applyDefaultCardTypes`),每勾一項 `addCard` 一次;`addCard` 無去重;右鍵再選同欄位是新 taskId 再長兩張 |
| P2 | 立即抓取後報表沒值 | ✅ 三個缺陷疊加 | (a) Report 頁零 storage 變更監聽,`RUN_TASK` 按鈕不等結果無回饋;(b) 抓取成功從不把 health 寫回 `ok`,`renderNumberCard` 只要 health 非成功就「—」;(c) 手動觸發用當分鐘 slot 走冪等帳本,同分鐘第二次靜默略過;前兩次失敗只排重試不寫紀錄 |
| P3 | 表格欄位無法多選 | ✅ | `picker-mode.js` 單一目標狀態機,無 shift / 框選 / 右鍵 |
| P4/P5 | 流程複雜、預設不足 | ⚠️ 部分 | 最短路徑只差「任務名稱」,但名稱無預設、14 組欄位攤開、預設週一到五 |

## 評估與複審中發現的既有 bug(全部納入本輪)

| # | 問題 | 位置 | 納入 |
|---|---|---|---|
| X1 | Picker「立即測試」不帶 block 規格,對整張表跑數值策略 | `picker.js handleTestNow` vs `buildTask` | D |
| X2 | 策略下拉 attr / child / label 選了必失敗 | `picker.html` | D |
| X3 | **content 回傳白名單丟掉 `used/skipped/partial`**,fetcher 的 `partial` 黃燈是死碼 | `content/main.js handleExtract` | A |
| X4 | **多層表頭攤平**:`parseTable` 把所有表頭列格子塞進同一個 `headers`,`headers[index]` 對不到欄;`indexOf(headerText)` 永遠找第一個同名表頭。匯率表「現金/即期 × 買入/賣出」選即期買入會被漂移偵測換成現金買入並標 `fallback` | `shared/table.js parseTable`、`extract.js` block 分支、`picker-mode.js getHeaderText`、`block-detect.js describeTable` | B2 |
| X5 | **套範本會清空儀表板**:`buildTemplate` 只認 `mode==='number'`,全是 block 任務時回 `[]`,`applyTemplate` 先 `cards=[]` 再加零張 | `templates.js` | B5 |
| X6 | **抽屜丟來源**:`renderSources` 只列 `tasks` 內找得到的 id,`getFormData` 從勾選框重建 `source`;來源 id 不在任務清單就被靜默移除 | `drawer.js` | B5 |
| X7 | 匯出 HTML 只抓 `theme.css` 第一個 `:root`,失敗退回 16 個 token 的硬編碼清單,k1 測試只驗 chart-1~8 抓不到退化 | `export.js loadThemeCss` | E |
| X8 | 編輯既有任務時「立即測試」永遠隱藏(`initFromQuery` 沒有 tabId) | `picker.js` | D(明寫維持隱藏並說明) |
| X9 | SPEC §4.1 寫「每 20 秒延壽」,程式只在開始呼叫一次 `getPlatformInfo` | `fetcher.js` | 只改 SPEC 對齊現況,延壽迴圈進 BACKLOG |
| X10 | `getSettings` 回傳儲存值不合併 `DEFAULT_SETTINGS`,新增設定鍵對舊使用者是 `undefined` | `storage.js` | D(Picker 端自帶內建預設) |

## 定案

1. 多欄選取:Shift 點擊加選 **與** 拖曳框選都做;右鍵選單。
2. **一任務多值,採「子序列 id」接法**;不採「N 個獨立任務」。
3. **值的單位是儲存格**(見下節「待決 1」);整欄 / 整列聚合仍可選。
4. 命名一次:任務名稱只填一次(有預設),每個值名稱預設由表頭組成、可逐一改;顯示「任務名 · 值名」。
5. 報表拖曳:側欄列出任務與其值;拖整個任務 = 全部值;拖單一值 = 一欄;拖整個任務到空白格線 = 含全部值的樞紐表。
6. Picker 預設值 `settings.pickerDefaults = { last, pinned }`,pinned > last > 內建。
7. 手動抓取:不查帳本、**不寫帳本**、不重試、一律寫紀錄。
8. `partial`:數值卡有有效值就顯示,燈號黃。

### 子序列 id 模型(定案 2 的契約)

**核對到的事實**:紀錄名稱查找共 12 處(`dashboard.js buildDashboardContext` 的 `tasksById` 與 `onDrop` 的標題跟隨、`report.js joinTaskNames` / `renderPivot` / `renderCompare`、`export.js formatJson` / `formatCsv` / HTML 報表、`tasks.js` 錯過橫幅、`cards.js getCardTitle` / 表格 TSV、`popup.js` lastValues);以 id **列舉**序列的另有 6 處(歷史頁篩選勾選框、歷史樞紐與比較的欄集合、狀態卡預設清單、`templates.js buildTemplate`、`drawer.js renderSources`、側欄);以 taskId 刪除/計數/清卡 3 處。`series.js` 全部把 `record.taskId` 當不透明字串。

**甲乙兩案**(甲:紀錄加 `field` 欄位改複合鍵;乙:紀錄 `taskId` 直接存 `<taskId>#<key>`):乙讓單值任務零改動、聚合路徑零改動、卡片 `source` 形狀不變,漏改處只會顯示成 id 不會算錯。**採乙**。

**契約**
- `task.fields?: [{ key, name, cell?: {row:{index, header}, col:{index, header}}, block?: {axis, index, headerText} }]`;`cell` 與 `block` 二擇一。≥ 2 個值才有 `fields`;單一值維持今日 `spec.block`(零 migration)。`key` 建立時產生、改名不改;`fields` 順序可調(B4)。
- 子序列 id = `<task.id>#<key>`;組合 / 拆解 / 名稱解析**只有一份** `shared/series-index.js`(`seriesIdOf`、`parentIdOf`(無 `#` 回自身)、`buildSeriesIndex(tasks)` → `{ byId, parents, childrenOf, seriesIds(依任務 order × fields 順序) }`,每筆 `{id, parentId, name, shortName, fieldKey, mode}`)。`#` 為保留字元,`saveTask` 拒絕含 `#` 的 `task.id` 與缺失/重複的 `key`;設定匯入逐任務 try/catch,單筆被拒不中止整批。
- **父任務 id**:排程 alarm、帳本 `runs`、inflight、missed、health、`GET_NEXT_RUNS`、`MARK_READ`、預檢、diag、`notFoundStreak`。守門測試:alarm 名稱永不含 `#`。
- **子序列 id**:紀錄、`lastValues`、`alertLog`、通知 id、卡片 `source`、歷史篩選 `state.taskIds`。紀錄身分 = `(taskId, capturedAt)`;同一次多值寫入的 `capturedAt` 相同也不衝突(id 不同),但 `deleteRecord` 與匯入去重都以此為鍵,不得改。
- `writeRecord` 改為接父 id 參數寫帳本與 health,不再從 `record.taskId` 推(否則多值任務的冪等會失效)。
- 匯出:CSV `taskId` 欄與日檔 `tasks[<id>]` 鍵出現子序列 id,`name` 為完整序列名;schema 版本不變,SPEC §5 註明。

## 情境走查(第 4 版)

**情境一**:從三家銀行抓美金、日幣、英鎊的買入 / 賣出,每天在報表看差異,點一下看趨勢。

| 步驟 | 走規劃後的路徑 | 缺口 → 補強 |
|---|---|---|
| 1. 台銀牌告頁右鍵 → 選取 | 進選取模式,Shift 點 6 格(美金/日幣/英鎊 × 買入/賣出)或框選兩次 | 框選必須是**累加**不是取代,否則第二次框選會清掉第一次(→ B3-2) |
| 2. Picker | 名稱預設「臺灣銀行牌告匯率」,6 個值預設「美金 · 買入」…;預設每天 09:00;儲存 | 銀行表格第一格常是國旗圖或空白 → 列頭取**第一個非空文字格**(→ B2-1)。銀行約 09:05 才更新牌告,09:00 會抓到前一天 → 預設時間改 **09:30**(暫定,→ D-1) |
| 3. 另兩家銀行同樣操作 | 3 任務 × 6 值 = 18 條序列 | 三家的值短名都叫「美金 · 買入」,同一張表混三家時欄標會撞名 → 短名只在全部來源同一父任務時使用,否則「任務 · 值」(→ C-3) |
| 4. 儀表板看每天差異 | 每任務一張樞紐表(列 = 日、欄 = 6 值)+ 一張折線 | 樞紐表只有值沒有差異 → 表格卡新選項 **`showDelta`**(每格附與上一列的差,正負著色);多值預設樞紐表開啟(→ B5-2)。interval 任務要看「每天」→ 抽屜提示用 `bucketMinutes` 1440 |
| 5. 跨銀行比美金買入 | 側欄搜尋「美金 · 買入」找到三家的子列,各拖進一張折線 | 可行但要拖三次 → 趨勢浮層加「比較其他任務的同名值」一鍵加入(→ B5-8) |
| 6. 點報表看趨勢 | 歷史頁摘要列點任務名已有臨時折線(現況) | 儀表板樞紐表**欄標**與**數值卡**在非編輯模式點一下沒有反應 → 新增**趨勢浮層**:目前範圍的折線 + 「加入為折線卡」+ 「到歷史頁」(→ B5-8) |
| 7. 與另一天比較 | 歷史頁「與另一天比較」 | 欄集合改用 `seriesIds` 後即可用(B5-5 已涵蓋) |
| 8. 18 欄的表 | 12 欄格線放 18 欄 | 首欄固定 + 橫向捲動(E-2 已涵蓋);短名規則見步驟 3 |

**情境二(反向驗證,單值不退化)**:某頁一個總量數字,右鍵 → 單擊確認 → Picker 只需按儲存 → 一張數字卡 → 立即抓取即時看到值。路徑上沒有任何多值分支,單值任務資料格式零改動。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 | 執行者 |
|---|---|---|---|---|
| A | 抓取結果看得見(P2 + X3) | 中 | 無 | 委派 |
| C | 儀表板去重與預設卡(P1) | 小 | 無 | 委派 |
| D | Picker 精簡與預設值(P4/P5 + X1/X2/X8/X10) | 中 | 無 | 委派 |
| B1 | 序列索引與儲存層 | 中 | 無 | 委派 |
| B2 | 表頭解析單一來源 + 擷取端多值(X4) | 大 | B1 | 委派 |
| B3 | 選取模式多選 | 大 | 無 | 委派 |
| B4 | Picker 多值表單 | 中 | B1、B3、D | 委派 |
| B5 | 報表接線(側欄、拖曳、抽屜、範本、歷史頁、任務頁、popup;X5/X6) | 大 | B1、C | 委派 |
| E | 視覺升級(X7) | 中 | 全部完成後 | Claude 自做或委派 |

順序 **A → C → D → B1 → B2 → B3 → B4 → B5 → E**。**本輪目標是全部完成**;若時程真的不足,只允許 E 的第 2、3 項延到 AF-6,X7 修正與凍結清單不延。

**委派模型**:`agy` 整輪一種;額度不足改地端 LLM 並註明起點。測試 Claude 先寫並做突變。`tests/chrome-mock.js` 需補 `storage.onChanged` 事件(A-5 驗收前提)。

---

## 批次 A:抓取結果看得見

### 現況與核對結果
- `tasks.js` 立即抓取與 `popup.js` 都只 `sendMessage(RUN_TASK)`;`main.js` handler 以 `slotOf(Date.now())` 呼叫 `runTask` 且固定回 `{ok:true}`,`__testOpts` 展開在最後(會覆蓋任何硬寫的 reason)。
- `runTask`:帳本命中即 `return null`(佇列前後各一次);三個失敗分支(`not_found` / 未知錯誤 / 例外)在 `attempt < 3` 時只 `scheduleRetry` 並 `return null`。`reason` 目前只影響 `'late'` 狀態標記(`catchUpOne/All` 傳入)。
- 成功路徑只在 `partial` 時 `setTaskHealth` + `refreshBadge`;`setTaskHealth` 永遠寫入不刪除,存 `ok` 與 `computeHealth`、`isSuccess(health)`、popup 的判斷都相容。
- X3:`handleExtract` 只轉發 `value/raw/status/strategyUsed/layer`,`used/skipped/partial` 從未到 fetcher。
- `health.js` RED/YELLOW 集合與 `record-status.js` 成功集合分兩檔。
- `src/ui/` 零 `storage.onChanged`;`dashboard.js` 有 `editing` 旗標與匯出的存取子;`renderDashboard` 開頭已 `resetDnd()`,重繪不累積拖曳註冊。

### 改動
1. **手動抓取**:`RUN_TASK` handler 傳 `reason:'manual'`(在 `__testOpts` 之後不可被覆蓋)並回傳 `{ ok, outcome:'done'|'failed', status, value, error }`。`runTask` 在 manual 時:不讀帳本、**不寫帳本**(寫了會偷走同分鐘的排程槽,讓正式 alarm 被冪等擋掉、missed 掃描也視為已跑)、三個重試分支改為直接寫失敗紀錄、不動 `notFoundStreak`、`res.status` 照寫(漂移仍是 `fallback`)。紀錄 `slot` 仍為當分鐘(保住 `effectiveTimeOf`);同分鐘兩次手動在樞紐表合併為一列取最新成功,可接受並寫進 SPEC。
2. **成功寫回 health**(存 `ok`,不刪 entry):狀態 → health 的對應只有一份:`ok`→`ok`、`fallback`/`late`→黃(原因文字)、`partial`→黃 `partial`、失敗狀態→紅。每次寫入後 `refreshBadge`。
3. **狀態集合單一來源**:`record-status.js` 提供成功集、警示集、`isRed`;`health.js` 引用它。
4. **數值卡與計量卡**:health 查詢改用 `parentIdOf(source[0].taskId)`(多值卡片今日會查不到 health);只有「最新紀錄非成功」或 `isRed(health)` 才顯示「—」;黃色照顯示值,`title` 帶原因。
5. **X3 修正**:`handleExtract` 改為轉發擷取結果全部欄位(白名單改黑名單或直接展開),並加測試「`partial:true` 能到 fetcher」。
6. **Report 自動重繪**:`shared/storage.js` 提供 `subscribe(handler)` 單一入口(監看 `rec:*` 前綴、`health`、`layout`、`tasks`、`missed`、`lastValues`;**排除** `runs`、`diag`、session inflight),去抖 ≤ 500ms 暫定。Report 只重繪目前頁籤;`dashboard.js` 的 `editing` 存取子為真時不重繪,離開編輯模式補繪一次;`report.js` 不得另存一份旗標。
7. **立即抓取回饋**:任務頁與 popup 等回傳並就地顯示(抓到 X / 失敗原因),執行中按鈕停用;`chrome-mock` 的 `sendMessage` 需能回傳 payload。
8. SPEC §4(manual 語意)、§4.1(X9 對齊現況)、§12.1(health 對應表)改寫。

### 測試 / 驗收
- manual:帳本已有該 slot 仍執行且寫紀錄、帳本不新增鍵、失敗不建 retry alarm 且寫失敗紀錄、`notFoundStreak` 不變;排程路徑冪等測試(`d2_fetcher`「同一 slot 第二次略過」)維持綠。
- health:成功後為 `ok`;`fallback` 後為黃;`partial` 後卡片仍顯示值(新增反例測試,現無);`isRed` 顯示「—」。突變:拿掉成功寫 ok → 紅;cards 黃色判定改回舊行為 → 紅;`handleExtract` 白名單改回 → `partial` 測試紅。
- 訂閱:寫入後對應 render 一次(去抖合併);`editing` 為真不呼叫;`runs` 變更不觸發。`grep -rn 'chrome.storage' src/ui` 零命中。
- 既有測試需改:`d5b_popup`、`f3_tasks`(立即抓取現在要等 payload)。
- 真實瀏覽器:停在儀表板頁,從 popup 按立即抓取,不重新整理即看到新值。

## 批次 C:儀表板去重與預設卡

### 現況與核對結果
- `applyDefaultCardTypes` number 模式勾 `number+line`;`handleSave` 每勾一項 `addCard`;`addCard` 無去重;`applyTemplate` 是取代。
- `getCardTitle` 無自訂標題時用來源名 → 同名兩張。
- 既有測試 `g2_layout_store`「addCard 自動配 id 與空位」對同一張卡加兩次斷言 2 張;`j1_picker_dash` 三條斷言 `number+line` 預設。

### 改動
1. 單值預設:number / block 只勾 `number`;text 勾 `table`。多值預設:一張樞紐表(全部值)+ 一張折線(全部值)(暫定)。
2. `addCard` 去重:同儀表板「同型別且來源集合相同(順序無關)」→ 跳過並回既有卡片。
3. 標題:序列卡片預設標題 = 完整序列名(「台銀匯率 · 美金買入」);同儀表板同名不同型別,第二張起顯示時附型別後綴,不寫入 `card.title`。樞紐表與折線圖例的標籤:**全部來源同一父任務時用 `shortName`(值名),否則用完整名**;`title` 一律完整名。

### 測試 / 驗收
- 去重三情境;突變:拿掉去重 → 紅。改寫 `g2`(用不同來源)與 `j1` 三條。SPEC §8.2 第 1 點與「同一任務可出現在多張卡片」語意改寫。

## 批次 D:Picker 精簡與預設值

### 現況與核對結果
- `picker.html` 14 組欄位攤開;`validateForm` 名稱必填;預設週一到五 09:00。
- X1:`handleTestNow` 自組 spec 且只在 `ctx` 路徑(有 `tabId`)可用,`initFromQuery` 永遠隱藏它(X8)。
- `buildTask` 無條件從表單複製 `regex/attr/childSel/labelText`,下拉移除選項後既有任務重存會丟策略。
- `saveSettings` 淺層合併:寫 `{pickerDefaults:{last}}` 會蓋掉 `pinned`。X10:`getSettings` 不合併預設。
- `c1_picker` 斷言 picker.html 必備 id 清單;`c8` 斷言排程欄位 `hidden` 切換;`b7` 斷言 `overflow-y:auto` 與固定儲存鈕。

### 改動
1. **預設值**:`pickerDefaults = { last, pinned }`(欄位:排程型別、時間、間隔、星期、時段、聚合、目標儀表板、卡片型別,暫定);讀寫一律 read-modify-write 巢狀物件;內建預設「每天 09:30」(暫定;銀行牌告多在 09:00 後才更新)放在 Picker 端(不放 `DEFAULT_SETTINGS`,X10)。編輯既有任務不套用。
2. **固定為預設值** checkbox;設定頁「清除固定的預設值」。隨設定匯出入(`exportAll` 已整包匯出 `settings`,不需改)。
3. **名稱預設**:表格 → `<caption>` > 最近標題元素 > 頁面 title(暫定);單一元素 → locator 文字錨定 > 預覽前 20 字。
4. **摺疊進階設定**(策略、regex、時段、告警、前置動作):以 `hidden` 切換,**所有既有 id 保留**(c1/c8 依賴);編輯既有任務含非預設值時展開。
5. X2:下拉移除三項;`buildTask` 在編輯時保留 `existing.spec` 中表單沒有對應控制項的鍵(不丟資料),UI 顯示唯讀提示。BACKLOG 改寫。
6. X1:抽出匯出的 `buildSpec(values)`,`buildTask` 與 `handleTestNow` 共用。X8:編輯路徑維持隱藏立即測試,SPEC §8.4 明寫。
7. 儀表板區塊維持,預設依 C。

### 測試 / 驗收
- 預設值優先序三情境;固定後取 pinned;清除後回 last;`pinned` 在寫 `last` 時不被蓋掉(突變:改回淺層 → 紅)。名稱三規則;空名仍擋。
- `handleTestNow` 送出 spec === `buildSpec` 產出(突變:拆兩份 → 紅)。既有任務含 attr 策略重存後 spec 不變。c1/c8/b7 維持綠。

## 批次 B1:序列索引與儲存層

### 改動
1. `shared/series-index.js`(純函式,註解不得出現形如色碼的範例,a4 會擋)。
2. 12 處名稱查找 + 6 處 id 列舉改走索引(列舉的具體行為在 B5;B1 先提供索引與 `tasksById` 雙檢視:`byId` 含序列、`parents` 只含父任務)。狀態卡、`MARK_READ`、健康清單用 `parents`。
3. `deleteTask`、`countRecordsForTask`、`pruneCardsForTask` 改 `parentIdOf` 比對(`options.taskIds` 為父 id,`parentIdOf` 是 no-op)。
4. `saveTask` 正規化與拒絕規則(見契約);`settings-io` 匯入逐任務 try/catch 並回報跳過數。
5. `writeRecord(record, parentId)`;`setLastValue` 以序列 id。popup 顯示多值任務時列出各值最後值(暫定:最多 3 行,其餘「+N」)。
6. 歷史頁 hash:`state.taskIds` 含 `#` 的 round-trip 測試(`buildHash/parseHash` 必須編碼)。
7. SPEC §5、CLAUDE.md(序列 id 單一來源、`#` 保留、父/子 id 分工表)。

### 測試 / 驗收
- 索引:單值名稱不變;多值「任務 · 值」;`seriesIds` 順序 = 任務 order × fields 順序;`parentIdOf` 無 `#` 回自身。
- 刪除多值任務清掉全部子序列與卡片,`abc` vs `abcd` 不誤刪。`saveTask` 拒絕 `#` id、缺 key、重複 key;匯入一筆壞任務不中止其他。
- hash round-trip。突變:12 處任一改回直接查 `tasks` → 對應測試紅。

## 批次 B2:表頭解析單一來源 + 擷取端多值

### 現況與核對結果
- X4(見上表)。`block-detect.describeTable` 也自己攤平所有 `th`。
- `extract.js` block 分支單一 `block`;fetcher 四個結果分支(`ok` / `not_found` / `parse_error` / 其他);`processAlerts` 以 `getTask(record.taskId)` 查任務(序列 id 會查不到,告警靜默不觸發),`evaluateAlerts` 把 `task.name` 烤進訊息,去重 `alertLog[task.id]`、通知 id `${task.id}:alert:…`,`main.js` 點通知時用正則取 id 帶進歷史篩選。
- `writeRecord` 每筆各做一次 7 天 `getRecordsInRange`、整日陣列讀寫、`runs` 與 `lastValues` 整包讀寫 → N 值 = N 倍。
- 預檢只看頂層 `res.ok` / `res.error`,`detail` 取 `snippet||raw||error`。

### 改動
1. **表頭單一來源**:`shared/table.js` 提供 `columnHeaders(table)`(取**最後一個**表頭列、依 colspan 展開對齊資料欄;上層群組表頭以「群組 · 欄」組合成 `fullHeader`)與 `rowHeader(row)`(**第一個非空文字格**;國旗圖或空白格跳過);`extract`、`picker-mode.getHeaderText`、`block-detect` 三處都改走它。
2. **漂移偵測**:先看 `headers[index] === headerText` → 直接用、狀態 `ok`;不同才搜尋;多個同名 → 取離原 index 最近者並標 `fallback`;找不到 → `not_found`。儲存格值要列、欄兩個表頭都解析成功。
3. `extract.js`:`spec.fields[]` → 回 `{ ok:true, fields:{ key:{ok, value, raw, status, error, used, skipped} }, partial }`;**表格找到就 `ok:true`,即使全部值失敗**(retry 只給表格層級的 `not_found`);單一 `spec.block` 路徑不動。儲存格值:`aggregate` 不適用,`value` = 該格解析數字(text 模式回字串)。
4. `fetcher.runTask`:一次載入、一次 EXTRACT、**批次寫入**(一次 `appendRecord` 寫整組、一次 `getRecordsInRange` 給全部值的告警、一次 `runs`、一次 `lastValues`);個別值失敗 → 寫該值失敗紀錄、不重試、不動 `notFoundStreak`;`reason==='late'` 時 run 層級 `late` 覆蓋值層級 `fallback`(與今日相同,SPEC 註明);帳本狀態 = 任一值成功記 `ok`,否則最差狀態。
5. 父任務 health:全失敗紅(原因取最多的錯誤);部分失敗黃 `partial`「N 個值抓不到」;全成功走 A-2。diag 每次 run 一筆,列失敗的 key。
6. 告警:`evaluateAlerts(task, record, prevRecords, displayName)`;`task.alerts[].field?` 缺省 = 每值各評估;`alertLog` 與通知 id 以序列 id;`prevRecords` 篩選維持 `r.taskId === record.taskId`(序列正確,不可改 parent,否則 deltaPct 跨值污染);`main.js` 通知點擊帶序列 id 進歷史篩選(B5 的篩選要接受)。
7. 預檢對應:`ok && 任一值成功` → `ok`;`ok && 全失敗` → 依錯誤映射 `selector_lost`/`parse_error`,`detail` 列失敗值名;頂層 `ok:false` 與今日相同。`slot:'precheck'` 維持只在 dryRun。
8. SPEC §4、§4.2、§7、§10 改寫。

### 測試 / 驗收
- X4:兩層表頭 + 同名欄位的 fixture(仿匯率表),選第 4 欄「買入」→ `ok` 不是 `fallback`;欄位真的搬家 → `fallback` 且值正確;兩個同名欄搬家 → 取最近。突變:改回 `indexOf` → 紅。
- 兩值一次 EXTRACT 產兩筆、同 slot、`appendRecord` 只呼叫一次;一值 not_found → 該值失敗紀錄、health `partial`、無 retry;表格 not_found → 無紀錄、有 retry。
- 告警 `field` 篩選、去重鍵為序列 id、deltaPct 不跨值。預檢三情境。突變:「每值各寫一筆」改成只寫第一筆 → 紅。

## 批次 B3:選取模式多選

### 現況與核對結果
- `picker-mode.js` 只掛 `mousemove/keydown/click`(capture),`exitPickMode` 對稱移除,`b4_pick_mode` 斷言掛與移除數量相等;`onClick` 無條件 `confirmPick`(框選放開時的 click 會直接確認);無 `contextmenu`(`content/main.js` 在冒泡階段記錄 `lastTarget`);`markCells` 以元素參照與 inline `outline` 標示,表格重繪(匯率 ticker、虛擬捲動)後高亮留在脫離的節點上。
- repick 由任務頁開新分頁,`initialTarget` 只有 `lastTarget`(新分頁為空)→ 沒有預選對象。

### 改動
1. **值單位**:預設一個儲存格 = 一個值;右鍵選單:「選這一格 / 選這一欄 → 每格一值 | 整欄一值(聚合)/ 選這一列 → 每格一值 | 整列一值(聚合)/ 完成 / 取消」;非表格「選取此元素 / 取消」。已選集合同一表格內可混用格與欄列聚合,**上限 20 個值(暫定)**,超過提示。
2. Shift + 點擊 加/減選一格;按住拖過多格 = 矩形範圍**累加**進已選集合(第二次框選不清掉第一次);無 Shift 單擊維持「選一格並立即確認」;拖曳放開後的 `click` 要抑制(下一 tick 清旗標)。`mousedown/mouseup/contextmenu` 都在 `enterPickMode` 掛、`exitPickMode` 卸(維持對稱測試);選取期間 `body` 加 `user-select:none`、`mousedown` preventDefault,離開還原。
3. 鍵盤:Enter 完成、Esc 取消、Tab 切軸(清空已選)、**Shift + 方向鍵**沿軸延伸選取。
4. 面板:「已選 N 個值:美金 · 買入、美金 · 賣出」;已選格第二種顏色(此檔豁免)。**重繪韌性**:選取狀態只存索引,標示以索引重新解析(`MutationObserver` 或每次 mousemove 重標),不存元素參照。
5. `PICKED` 新增 `picks: [{cell?|block?, ...headers}]`;`blockInfo` 保留給 `repick/preaction/login-*`,守門測試:`purpose !== 'task'` 永不收到多選。
6. `ENTER_PICK` 帶 `locator` 與 `preselect: [{key, cell|block}]`:content 先 `resolve(locator)` 當 `initialTarget`,再以 index 為主、表頭為驗證預選;不一致時面板警示。

### 測試 / 驗收
- jsdom:加選/減選、矩形框選、放開不誤確認、切軸清空、Enter 的 `picks` 順序 = 選取順序、右鍵各項、Shift 方向鍵、非表格無多選、上限 20、`preselect` 命中與不一致警示、表格節點替換後重標、掛卸對稱。突變:`picks` 退回單一 → 紅。既有 `b4` 的「點擊也算確認」維持(無 Shift 單擊)。

## 批次 B4:Picker 多值表單

### 現況與核對結果
- `render(ctx)` 對有 `task` 且 `spec.block` 缺失的情況把 `currentBlock` 設 null 但 mode 留 `block`,`getFormData` 會產出 `axis/index` 皆 undefined 的 block → **編輯多值任務若不處理會把 spec 毀掉**。`currentBlock` 是模組狀態無 setter。
- `addAlertRow` 固定 4 元素,`buildTask` 告警白名單無 `field`。`ctx` 走 URL query(N 個 picks 會撐大 URL)。視窗固定 480×760。

### 改動
1. `picks.length ≥ 2`:`#block-section` 內放值清單(每列:名稱輸入,預設 `fullHeader` 或「列頭 · 欄頭」;上下移動;移除),聚合方式只對 `block` 型的值顯示。值清單從 DOM(`[data-field-row]`)讀,不用模組狀態;同名值自動加序號。b7 的區塊摘要語意保留給單值。
2. `getFormData` 產出 `fields`,`buildTask` 寫 `fields` 不寫 `spec.block`;`render` 由 `task.fields` 回填;儲存前顯示摘要「將建立 1 個任務、N 個值」確認(N ≥ 2)。
3. 告警列加「套用到:全部 / 某值」;`buildTask` 白名單加 `field`。
4. `ctx` 改走 `chrome.storage.session`(background 寫、picker 讀後清),URL 只帶 key。視窗內值清單獨立捲動。
5. 立即測試(建立路徑)逐值顯示該格 / 聚合值。

### 測試 / 驗收
- 兩 picks → 一任務兩 fields、key 唯一、名稱各自;改名不改 key;重排改 `fields` 順序;移除值後 fields 少一而紀錄不動;**編輯多值任務不動任何欄位直接儲存 → `fields` 逐位相等**(突變:回到舊 `currentBlock` 路徑 → 紅)。

## 批次 B5:報表接線

### 現況與核對結果
- 側欄 `renderPalette` 每任務一列,payload `{taskId,label}`,`data-mode`/搜尋比對 textContent;`accepts()` 以 `applyDrop(card, payload.taskId)` 判定;空白格線 `tasks.find(t=>t.id===payload.taskId)` + `cardTypeForTask(task)`;移除以 `data-task-id` 精確比對。`dnd.js` 不看 payload 內容(只讀 `label`),**不需改**。
- X6 抽屜;X5 範本;歷史篩選 `cb.value=t.id` + `filterRecords` 精確相等;歷史樞紐與比較用 `sortedTasks.map(t=>t.id)` 當欄集合;`summarize` 依 `taskId` 分組。
- `j2_drop_rules` 28 條用單一字串簽章;`j3/j4` 斷言側欄結構與空白格線建卡型別。

### 改動
1. 側欄:多值任務可展開,子列 payload `{taskId: 序列 id, label: 完整序列名}`(標題跟隨規則依賴完整名),父列 `{taskId: 父 id, seriesIds:[...], label}`;子列自帶 `data-*`;搜尋命中子列時展開父列。
2. `drop-rules`:新增 `applyDropMany(card, ids, opts)`(**新增不改簽章**);父列投放 → 表格 / 折線 / 長條全部加入(折線超過 8 條整批拒絕並提示)、數字 / 計量取第一個值並提示「已使用:美金 · 買入」、狀態卡以 `parentIdOf`、空白格線建樞紐表(`mode:'pivot'`,12×4 暫定);`cardTypeForTask` 契約改為輸入序列索引項。
3. **X6 抽屜**:來源清單由索引產生,兩層(任務 → 值,父層全選 / 全移除);`getFormData` 重建 `source` 時**保留清單上找不到的既有 id**(不再靜默丟);`isNumeric && mode==='text'` 規則以索引的 `mode`;回歸測試「開關抽屜不動 `source`」。
4. **X5 範本**:`buildTemplate` 走索引(多值任務每值一欄 / 一線);回 `[]` 時 `applyTemplate` **不清空**並提示。
5. 歷史頁:篩選勾選框兩層(父 = 全選子);樞紐與比較的欄集合 = `seriesIds`;`summarize` 每序列一列(名稱「任務 · 值」);`taskName` 欄允許兩行;通知點擊帶序列 id 可篩。
6. 任務頁:值名 chips;立即抓取逐值回饋;重選帶 `locator + preselect`。popup 依 B1-5。
7. **表格卡 `showDelta` 選項**:樞紐表每格附與上一列同欄的差(有上一列成功值才算;缺值不補、不算),正負以 `--ok`/`--danger` 著色,`title` 顯示前值;抽屜可切換;C-1 的多值預設樞紐表開啟。TSV 複製不含差值。
8. **趨勢浮層**(非編輯模式):點樞紐表欄標或數值卡 → 浮層畫該序列在目前範圍的折線(重用 `charts.js`),附「加入為折線卡」(經 `addCard`,去重規則同 C-2)、「到歷史頁」(帶序列 id 篩選)、**「比較其他任務的同名值」**(把其他父任務中 `shortName` 相同的序列加進同一張折線,上限 8)。編輯模式下點擊維持原行為(不開浮層)。
9. SPEC §8.2(第 3、4、9 點與 `table` 型別選項表)、§8.3、§8.4、§12.2 改寫。

### 測試 / 驗收
- `applyDropMany` 各型別;超過 8 條拒絕且不改 source;既有 `j2` 28 條不動。
- `showDelta`:純函式層計算差值(缺前值 → 無差值;前值失敗 → 往前找最近成功值不超過一列,暫定);渲染著色 class 用既有 `over-warn`/新 class,不出現色碼。趨勢浮層:點欄標開啟、含正確序列、「同名值」只加其他父任務且上限 8、編輯模式不開啟。抽屜:多值樞紐表開抽屜改標題後 `source` 逐位相等(突變:改回勾選重建 → 紅)。範本:全 block 任務套「總覽」→ 卡片不為零、儀表板未被清空。歷史篩選父勾選 = 子全選。`j3/j4` 改寫。
- 真實瀏覽器:匯率表 Shift 選美金 × 買入、賣出兩格 → 一任務兩值 → 樞紐表兩欄 + 折線兩線;立即抓取後兩欄都有值;拖整個任務到新折線圖一次兩線;抽屜改標題後兩欄還在。

## 批次 E:視覺升級

### 現況與核對結果
- `theme.css` 只有基礎色與圖表盤;`report.html` 內含全部樣式。X7 匯出只抓第一個 `:root`,硬編碼退路 16 個 token,匯出檔另有自己的內嵌樣式表(`.report-table` 等)。
- 測試除 id / data-* 外也釘 **class**:`editing`、`.ghost`、`single-column`、`threshold-hit`、`over-warn`、`collapsed`、`.chart-legend-dot`、`active`、`failed`、`has-fail`、`has-records`;data-*:`data-palette-task`、`data-task-id`、`data-mode`、`data-card-id`、`data-card-type`、`data-remove-source`、`data-source-row`、`data-preaction-row`、`data-alert-row`、`data-af-*`;`b7` 釘 picker 的 `overflow-y:auto` 與固定儲存鈕。

### 改動(行為不變)
1. `theme.css` 新 token(次表面、兩級陰影、字階、間距、等寬、主色淡底、聚焦環、狀態淡底),**全部亮色 token 留在第一個 `:root` 區塊**;X7:退路清單同步補齊,`k1` 加一條新 token 斷言抓退化。
2. Report:應用列、底線頁籤、分段範圍列、卡片層次、數值卡大字 + 差異 chip、圖表淡格線、表格斑馬紋 + 固定表頭 + 首欄固定(樞紐表寬時)+ 數字靠右、狀態 chip、按鈕三級、空狀態引導。歷史頁 `taskName` 欄兩行顯示。
3. Picker、站台設定、popup 同 token;匯出 HTML 的內嵌樣式表同步。
4. **凍結清單**:上列 id / class / data-* 一律不改。

### 測試 / 驗收
- `npm test` 全綠、a4 不放行新色碼;亮/暗各截圖對照;`./run_smoke.sh` 通過;`k1` 新斷言綠。

---

## 使用者已定案(第 3 版三項)
1. 值的單位改為「儲存格」:採。
2. 多值上限 20、popup 前 3 個值、樞紐表 12×4:採暫定值。
3. E 留在本輪,目標全部完成。

## 第 4 版新增暫定值(不同意請說)
- 內建預設排程時間 09:30(原 09:00)。
- 多值任務預設樞紐表開啟 `showDelta`。
- 趨勢浮層「比較同名值」以 `shortName` 相同判定。

## 明確不做(本輪定案)
- 甲案(紀錄加 `field` 欄位);每值各自聚合(儲存格值本來就不聚合,欄列聚合值全任務一份);單值任務事後升級成多值(重選建新任務);圖表 X 軸可選;排程觸發失敗立即寫紀錄;既有三處拖曳搬到 `dnd.js`;20 秒延壽迴圈(X9 進 BACKLOG)。

## 複檢(第 3 版)
- 四角度複審採納:後端側 62 條中不成立 1 條(自動重繪累積拖曳註冊,`renderDashboard` 已 `resetDnd`)、其餘併入;UI 側 58 條全部併入或列為明確不做。
- 與既有設計衝突:SPEC §2「一個任務只抓一個元素」改為「一個元素、可多個值」;§8.2 `source` 語意擴大不改形狀;§12.1 health 對應表為新;§4.1 X9 對齊現況。
- 批次間:B1 提供 `parents/byId` 雙檢視,B5 消費;A-4 與 B1-2 都碰 `cards.js` health 查詢,A 先做 `parentIdOf`(B1 前該函式先以「無 `#` 回自身」的最小版存在於 `series-index.js`,B1 不改簽章)。
- 四個坑:manual 不寫帳本的反例(偷槽)已寫;`abc/abcd`;`pinned` 清除路徑;移除策略的既有資料保留;`key` 拒絕條件;上限 20 的「什麼算一個」= 一個值(格或聚合);範本回空不清空。
- 第 4 版複檢:`showDelta` 只在純函式層算、缺值規則沿用 §8.6「不補 0、不內插」;趨勢浮層建卡走 `addCard` 不另算位置(CLAUDE.md 規則);短名規則同時影響 C-3 與 B5-1 的 label 契約,兩處都已改為「同父任務才用短名」。複檢完成,無新增待決。

## 執行紀錄
| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| | | | | |

## 體檢交接
(實作輪收官時填:測試總數、全綠與否、與 1138 基線的差)
