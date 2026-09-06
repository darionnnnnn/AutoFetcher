# AF-4 第 4 輪規劃:排程對齊、表格報表補齊、拖曳資料來源

> 狀態:規劃中
> 基準:dev@31eb2ed(947 綠,manifest 0.2.0)
> 來源:使用者新需求(一~五分時段抓多站多值 → 自訂表格報表 → 拖曳規劃版面)

## 需求原文對應

| 使用者情境 | 現況能否 | 本輪處理 |
|---|---|---|
| 一~五 08:30~09:20 每 10 分鐘抓 A/B/C 三站各一值 | 欄位都有,但觸發時刻不對齊 08:30 | 作業 A |
| 一~五 09:00 在 A 頁對 E/F/G/H 四張表各取某欄最大值 | 可,4 個 block 任務(選欄 + max) | 不改;文件補「同頁多表 = 多任務」 |
| D 站一~五 09:30 抓一值 | 可 | 不改 |
| 報表 1:欄 = A/B/C 任務名、列 = 時間、第一欄標頭自訂 | pivot 有,但標頭寫死、欄序不可調 | 作業 B |
| 報表 2:四個最大值排成表格 | pivot 可(每日一列) | 作業 B 順帶受益 |
| 之後再加報表 | 多儀表板已有 | 不改 |
| 拖曳把資料拖進表格規劃版面 | 無 | 作業 C |

使用者確認:本專案以 HTML 元素選取為主(「X 軸」= HTML 表格的欄/列,不是圖表);拖曳一次涵蓋全部卡片型別;三個順手 bug 全修;容差合併要評估(見作業 B 定案)。

## 批次總覽

| 作業 | 內容 | 規模 | 相依 | 執行者 |
|---|---|---|---|---|
| A | interval 排程相位對齊、weekdays 缺省一致、Picker 依型別顯示欄位 | 中 | 無 | 地端 LLM |
| B | table 卡片:列軸標頭、欄序、列數上限、無 slot 一致、時間容差合併 | 中 | 無 | 地端 LLM |
| C | 拖曳資料來源:共用拖曳協定、來源側欄、投放到各型別卡片與空白格、拖出移除 | 大 | B(欄序模型) | agy |
| D | 文件:SPEC §4/§8 更新、BACKLOG 增刪 | 小 | A/B/C | Claude |

順序 A → B → C → D。委派模型:A、B 純函式與 UI 小改給地端 LLM(forge);**作業 C 起切換為 agy,不換回**(使用者定案,理由:拖曳接線跨三個模組,超過地端 700 行改寫上限)。

---

## 作業 A:排程對齊

### 現況與核對結果

- `src/background/scheduler.js:137`:interval 用 `periodInMinutes: N` 常駐 alarm,起點是 `rebuildAlarms` 執行當下;任何任務改動都先清空再重建全部 alarm,所有 interval 任務相位一起重置。使用者設 08:30~09:20/10 分,實際會落在 08:33、08:43…。
- `scheduler.js:76-81`:時段判定閉區間、跨午夜有處理;過濾在觸發端 `main.js:171`。
- `scheduler.js:66-69`:`shouldRunInterval` 沒有 `weekdays` 欄位就回 false;`rebuildAlarms`(line 133)對 `weekdays === undefined` 卻放行建 alarm。舊資料/匯入的任務會建了 alarm 永遠不執行。
- `src/ui/picker/picker.html:159-172`:間隔、時段、星期三組欄位不分排程型別全部顯示;存檔時只有 interval 分支寫 `window`。
- 測試:`tests/d1_scheduler.test.js` 18 條、`tests/c1_picker.test.js` 22 條;無「恰好等於 to 邊界」與「相位」案例。
- `src/background/watchdog.js:54-61`:看門狗補建 interval alarm 時**自己再寫一次** `periodInMinutes`,是 scheduler 之外的第二個建 alarm 入口;weekdays 判定又與 scheduler 不同(undefined 放行)。
- `src/background/missed.js:49`:錯過清單只列舉 daily 的 `times`,interval 任務**完全不進**錯過清單;看門狗第③步同樣只對 daily 有效。

### 定案

1. interval 改為**與 daily 同一套 one-shot `when` 重算**:每次觸發後算下一次;不再用 `periodInMinutes`。
2. 相位規則:有時段 → 從時段起點起每 N 分鐘(08:30、08:40…到 ≤ to 的最後一格);沒時段 → 對齊當日 00:00 起的 N 分鐘倍數(每 10 分鐘就是 :00/:10/:20…)。**這條推翻 SPEC §4「alarm `periodInMinutes: N`」。**
3. 槽(`slot`)= 對齊後的時刻,不是實際觸發時刻;冪等帳本沿用。
4. `weekdays` 缺省(undefined/空陣列)在 scheduler 與觸發端**都視為每天**,與 daily 一致。
5. Picker 依排程型別只顯示對應欄位;切換型別時已填值保留(不清空),存檔仍只寫該型別的欄位。
6. 現有 interval 任務升級路徑:`onInstalled` 的 `rebuildAlarms` 自然套用新算法,不需要遷移。

### 階段

**A1(地端)純函式 `nextIntervalRun(task, nowMs)`**
- 契約:回傳下一個對齊槽的毫秒時間;考慮星期、時段(含跨午夜)、閉區間;算出的時間必須 `> nowMs`(等於 now 也跳過,呼應 CLAUDE.md「算出來已過去要跳下一次」);今天沒有合法槽就往後找,最多找 8 天,找不到回 null(任務 weekdays 全空視為每天,所以 null 只會在 N 非法時出現)。
- 驗收(Claude 先寫測試,再委派):08:30~09:20/10 從 08:00 起算 → 08:30;從 08:31 → 08:40;從 09:20:00 → 隔一個合法日的 08:30(09:20 本身是最後一格,已等於 now 時跳過);從 09:15 → 09:20(閉區間含 to);跨午夜 22:00~02:00/30;星期六 → 下週一;無時段每 10 分鐘 08:33 → 08:40;weekdays undefined 視為每天。突變:把 `<= to` 改 `< to`、把對齊改成 `now + N` 都要紅。

**A2(地端)接線**
- 契約:`rebuildAlarms` 對 interval 建 one-shot `when`;alarm 觸發後(main.js)重算下一次;`shouldRunInterval` 保留當守衛但 weekdays 缺省放行;看門狗補建 interval alarm 改呼叫同一個 `nextIntervalRun`(建 one-shot `when`),**不得再有第二份週期算法**;錯過清單維持只處理 daily(interval 一個週末可累積上百槽,補抓沒有意義),寫進「明確不做」。
- 驗收:d1 既有 18 條不退;新增「interval 不得出現 `periodInMinutes`」「觸發後會重建下一個 alarm」。

**A3(地端)Picker 顯示切換**
- 契約:`schedule-type` 切換時,daily 只顯示時間清單 + 星期;interval 只顯示間隔 + 時段 + 星期;隱藏欄位的驗證不執行(daily 時時段格式不檢查);編輯既有任務回填後顯示正確。
- 驗收:c1 新增三條(切換顯示、隱藏欄位不驗證、回填)。

---

## 作業 B:table 卡片補齊與時間容差合併

### 現況與核對結果

- `src/ui/report/series.js:189` `pivot(records, taskIds, taskOrder)`:以 `r.slot` 字串為列鍵,沒有 slot 的紀錄整筆丟棄;`cards.js:262` 兩個參數都傳 `card.source`,所以欄序 = source 順序 = 抽屜 checkbox 掃描順序(全域任務順序),抽屜內不可調。
- `cards.js:265` 第一欄標頭寫死 `'時間'`。
- `cards.js:315` `limit` 只作用於 recent;pivot 無上限,一個月 interval 資料會渲染上千列。
- recent 模式已依 `card.source` 過濾(`cards.js:305-306`),Explore 的「不看來源」主張**不成立**,不納入。
- 不同任務 slot 差一分鐘就各自成列(需求 4 的容差合併議題)。
- 現有 table options:`mode`、`limit`;共通 `period`、`decimals`。

### 定案

1. **欄序 = `card.source` 陣列順序**(這是作業 C 拖曳插入位置的依據);抽屜的來源清單改為可上下調整順序,勾選新增的排最後。
2. 新選項 `rowHeader`(列軸標頭文字,預設「時間」,空字串視同預設)。
3. pivot 也吃 `limit`(列數,**由新到舊取前 N 列,顯示時仍由舊到新**;預設 50 暫定);`limit` 0 或非法回預設。
4. 無 slot 的紀錄:pivot 改為 `slot || capturedAt 截到分鐘(本地時間)`,與 recent 一致;`resolveCardRange` 對無 slot 的紀錄改用同一個「有效時刻」比對範圍,不再一律保留。
5. **時間容差合併:可行,做成選項 `bucketMinutes`**(0 = 精確比對,預設;可選 5/10/15/30/60)。評估如下:
   - 「以鄰近距離群聚」不可行:哪幾筆併一列取決於掃描順序,新增一筆會改變既有列的歸屬,結果不穩定。
   - 「固定桶」可行且確定性:列鍵 = 有效時刻向下對齊到 bucket 倍數(本地時間、當日 00:00 起算),列標籤顯示桶起點。
   - **同一任務同桶多筆**(例如每 1 分鐘抓、桶 5 分):取 `capturedAt` 最新的一筆成功值;全失敗才顯示 `—`;儲存格 `title` 註明「合併 N 筆,取最新」。
   - 分母為零:桶內沒有任何紀錄就不產生列(不會出現整列空白)。
   - 純選項,不改紀錄資料,可逆。
   - 對報表 1:A/B/C 同排程時 slot 相同,`bucketMinutes` 0 就已同列;此選項是給日後時間錯開的任務。
6. `renameDashboard` 空字串直接忽略(Claude 順手改,幾行)。

### 階段

**B1(地端)`series.js` 純函式**
- 契約:`pivot(records, taskIds, { taskOrder, bucketMinutes, limit })`(簽章調整暫定,執行端可保留舊位置參數加第四個 options,但要在回報說明);回傳 `{columns, rows:[{t, values, merged:{taskId: n}}]}`;`t` 為列鍵字串 `YYYY-MM-DDTHH:mm`;既有 h1 36 條不退。
- 驗收(Claude 先寫):無 slot 用 capturedAt 分鐘;bucket 5 把 09:01/09:03 併成 09:00 列;同任務同桶取最新成功;桶內全失敗為 null 且 merged 計數正確;limit 取最新 N 列後仍由舊到新;bucket 0 與舊行為逐筆相同。突變:把「最新」改「最早」、把向下對齊改四捨五入都要紅。

**B2(地端)cards + drawer**
- 契約:table 卡片讀 `rowHeader`/`bucketMinutes`/`limit`,TSV 複製第一欄跟著 `rowHeader`;抽屜多三個欄位,來源清單可上下移動並即時寫回 `card.source` 順序;`layout-store.normalizeCard` 對三個新選項給預設。
- 驗收:h3 新增(標頭、欄序跟 source、pivot 上限、bucket 生效)、i1 新增(順序按鈕改 source 順序)、g2 新增(預設值)。

---

## 作業 C:拖曳資料來源進卡片

### 現況與核對結果

- 拖曳現有三處各自內嵌:卡片移動/縮放(`dashboard.js:174-324`)、儀表板頁籤排序(`dashboard.js:670-723`)、任務清單排序(`tasks.js:333-345`);全是 Pointer Events,無共用模組,無任何攜帶 `taskId` 的跨區協定。
- 各型別來源模型:`number`/`gauge` 只用 `source[0]`;`line`/`bar`/`table` 多來源;`status` 用來源當任務篩選;`text` 無來源。
- 幾何純函式在 `layout.js`(`findFreeSlot`、`placeCard`、`compact`)。
- CLAUDE.md:拖曳一律 Pointer Events、只讀 `clientX/clientY/pointerId`、`setPointerCapture` 先檢查存在;不得用 HTML5 DnD。

### 定案

1. 編輯模式下,儀表板左側(視窗 < 900px 時改為底部可收合)顯示**資料來源側欄**:列出全部啟用中任務(名稱、模式圖示、可搜尋),每項是拖曳來源;瀏覽模式不顯示。
2. 拖曳協定抽成共用純邏輯 + 接線模組(`ui/report/dnd.js` 暫定):來源端提供 payload `{taskId}`,移動中畫跟隨的幽靈標籤,以 `document.elementFromPoint` 找目前落點的卡片或格線位置,合法目標高亮,放開時呼叫目標的 `onDrop(payload, position)`。
3. **投放規則(全部型別)**:

| 目標 | 行為 |
|---|---|
| `table` | 依放開的 X 位置插入到對應欄位之前(最右側即最後);已存在同任務則搬到新位置 |
| `line` / `bar` | 追加來源,去重;超過 8 條(`--chart-1~8`)拒絕並提示 |
| `number` / `gauge` | **取代**唯一來源(title 若是自動產生的任務名一併更新;使用者自訂標題不動) |
| `status` | 加入篩選清單,去重 |
| `text` | 非法目標,不高亮、放開無事 |
| 空白格線 | 建新卡:任務 `number`/`block` 模式 → `number` 卡;`text` 模式 → `table`(recent);放在最近的可放位置(`findFreeSlot` 從落點格子起找) |
| 側欄或版面外 | 取消 |

4. 新來源的 `aggregation` 取該卡片 `options.aggregation`,沒有則 `last`(沿用現有預設)。
5. **拖出移除**:table 卡片的欄標、line/bar 的圖例項可拖到卡片外放開即移除該來源(number/gauge 不可拖出,至少保留一個來源;table 拖到剩零欄允許,卡片顯示「拖任務進來」空狀態)。
6. 所有投放都進 undo 堆疊(與現有 ⌘Z 同一機制),並經 `layout-store.updateCard`/`addCard` 寫入,不得另闢寫入口。
7. 鍵盤替代仍列 BACKLOG(既有項目);抽屜勾選方式保留,兩條路徑寫同一個 `card.source`。

### 階段(agy;每段 1~2 檔)

**C1 共用拖曳協定 `dnd.js`**
- 契約:`createDragSource(el, getPayload)`、`registerDropTarget(el, {accepts(payload), onDragOver(payload, pos), onDrop(payload, pos), onLeave})`、`attachDropTargets` 純以 DOM 屬性 `data-drop-target` 尋找;移動門檻 4px 才算開始拖(避免與點擊衝突);幽靈元素樣式走 theme.css 變數;jsdom 無 PointerEvent 時能以 `MouseEvent` 派發測試(沿用 g3 的做法)。
- 驗收:新測試檔 `tests/j1_dnd.test.js`:門檻、目標高亮/離開、放開呼叫 `onDrop` 且帶 payload、版面外取消、`setPointerCapture` 不存在不炸。

**C2 側欄 + 投放到卡片**
- 契約:編輯模式渲染側欄(任務來自 `shared/storage`,不直接讀 chrome.storage);七種型別的投放規則逐條照定案 3;經 `updateCard` 寫入並進 undo。
- 驗收:`tests/j2_drop_cards.test.js`:每型別至少一條(含 table 插入位置、line 第 9 條拒絕、number 取代且自動標題更新/自訂標題不動、text 不高亮),undo 一次還原。

**C3 空白格建卡 + 拖出移除**
- 契約:定案 3 最後兩列與定案 5;新卡位置經 `findFreeSlot`;table 零欄空狀態。
- 驗收:`tests/j3_drop_create_remove.test.js`:number 模式建 number 卡、text 模式建 table 卡、位置不重疊、拖出移除、number 不可拖出、table 零欄顯示空狀態。

---

## 作業 D:文件(Claude)

- SPEC §4:interval 改為 one-shot 對齊槽,寫明相位規則與 weekdays 缺省;§4 表「同時多任務」不變。
- SPEC §8.2:table 卡片選項補 `rowHeader`/`bucketMinutes`/`limit`(pivot);欄序 = source 順序;新增「資料來源側欄與拖曳投放規則」小節(把定案 3 的表搬過去)。
- SPEC §2 補一句「同一頁多張表格 = 多個任務,各自命名」。
- BACKLOG:移除已做項;新增「pruneCardsForTask 刪整張卡片不可復原」(觸發:使用者反映)、「pivot 桶內多筆的其他合併策略(平均/最大)」。
- CLAUDE.md 不要做:補「拖曳一律經 `ui/report/dnd.js`,不得再各自內嵌 pointer 監聽」(C1 完成後把三處既有拖曳搬過去**不在本輪**,列 BACKLOG)。

## 明確不做(本輪定案)

- 一任務多元素(同頁四張表 = 四個任務)。
- interval 任務進錯過清單/補抓(槽太多;睡醒後從下一個對齊槽繼續即可)。
- 圖表(canvas/SVG)取值。
- 鄰近群聚式的容差合併(不確定性,見 B 定案 5)。
- 把既有三處拖曳改用 `dnd.js`(風險大於收益,列 BACKLOG)。
- 拖曳的鍵盤替代(既有 BACKLOG)。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A1 | 地端 | | | |
| A2 | 地端 | | | |
| A3 | 地端 | | | |
| B1 | 地端 | | | |
| B2 | 地端 | | | |
| C1 | agy | | | |
| C2 | agy | | | |
| C3 | agy | | | |
| D | Claude | | | |

## 規劃完成後複檢

- **與既有設計衝突**:A 定案 1 推翻 SPEC §4 的 `periodInMinutes: N`,已明寫;看門狗與錯過清單已親自核對:看門狗是第二個建 alarm 入口(A2 收斂為呼叫同一純函式),錯過清單本來就不含 interval(維持,列明確不做)。
- **批次之間**:B1 改 `pivot` 簽章,`cards.js`(B2)是唯一呼叫端(grep 確認只有 cards.js:262 與測試);C2 的 table 插入位置依賴 B 定案 1「欄序 = source 順序」,順序 B 先於 C 已保證。A3 與 B2 不碰同檔。
- **四個坑**:什麼算一個 — 桶內「一筆」= 有效時刻落在桶內的紀錄,空桶不成列;分母為零 — 已寫;破壞性判準 — 本輪無刪除資料的操作,拖出移除只改 `source` 且進 undo;單向閘門 — 無;移除類 — `periodInMinutes` 的依賴方 grep 結果只有 scheduler.js:137 與 watchdog.js:61 兩處,A2 白名單涵蓋兩者;測試 d1 有「interval 用 periodInMinutes」一條需反轉。
- **升級路徑**:既有 interval 任務靠 `onInstalled` 重建即可;既有 table 卡片靠 `normalizeCard` 補預設。
- 未發現其他事項。
