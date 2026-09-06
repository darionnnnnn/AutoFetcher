# AF-4 第 4 輪規劃:排程對齊、表格報表補齊、拖曳資料來源

> 狀態:全案完成已併 dev(體檢:Claude Fable 5.1;實作:Claude Opus 5 + gemma-4 + agy)
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
  (**實作時未照做**:`cards.js` 的渲染端已處理 undefined,再補一份等於兩個事實來源;預設值只留渲染端。)
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
2. 拖曳協定抽成共用純邏輯 + 接線模組(`ui/report/dnd.js`):來源端提供 payload `{taskId}`,移動中畫跟隨的幽靈標籤,找到目前落點的卡片或格線位置,合法目標高亮,放開時呼叫目標的 `onDrop(payload, position)`。
   **實作時推翻初稿的 `document.elementFromPoint` 與 `data-drop-target` 屬性尋址**:jsdom 沒有
   `elementFromPoint`(整組測試會掛),改成走訪已註冊目標比對矩形;這個做法額外讓「上層目標拒收就往下找」
   成立,而那正是拖出移除放在別張卡片上能運作的前提。
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

4. 新來源的 `aggregation` 取該卡片 `options.aggregation`,沒有則 `raw`。
   (規劃初稿寫 `last` 是筆誤:`shared/aggregate.js` 沒有這個聚合,專案各處的既有預設是 `raw`。)
5. **拖出移除**:table 卡片的欄標、line/bar 的圖例項可拖到卡片外放開即移除該來源(number/gauge 不可拖出,至少保留一個來源;table 拖到剩零欄允許,卡片顯示「拖任務進來」空狀態)。
6. 所有投放都進 undo 堆疊(與現有 ⌘Z 同一機制),並經 `layout-store.updateCard`/`addCard` 寫入,不得另闢寫入口。
7. 鍵盤替代仍列 BACKLOG(既有項目);抽屜勾選方式保留,兩條路徑寫同一個 `card.source`。

### 階段(agy;每段 1~2 檔)

**C1 共用拖曳協定 `dnd.js`**
- 契約:`createDragSource(el, getPayload)`、`registerDropTarget(el, {accepts(payload), onDragOver(payload, pos), onDrop(payload, pos), onLeave})`、~~`attachDropTargets` 純以 DOM 屬性 `data-drop-target` 尋找~~(已推翻,見定案 2 註記);移動門檻 4px 才算開始拖(避免與點擊衝突);幽靈元素樣式走 theme.css 變數;jsdom 無 PointerEvent 時能以 `MouseEvent` 派發測試(沿用 g3 的做法)。
- 驗收:新測試檔 `tests/j1_dnd.test.js`:門檻、目標高亮/離開、放開呼叫 `onDrop` 且帶 payload、版面外取消、`setPointerCapture` 不存在不炸。

**C2 側欄 + 投放到卡片**
- 契約:編輯模式渲染側欄(任務來自 `shared/storage`,不直接讀 chrome.storage);七種型別的投放規則逐條照定案 3;經 `updateCard` 寫入並進 undo。
- 驗收(實際切成三檔:`j2_drop_rules` 純規則、`j3_palette_drop` 側欄與接線、`j4_drop_create_remove` 建卡與移除):每型別至少一條(含 table 插入位置、line 第 9 條拒絕、number 取代且自動標題更新/自訂標題不動、text 不高亮),undo 一次還原。

**C3 空白格建卡 + 拖出移除**
- 契約:定案 3 最後兩列與定案 5;新卡位置經 `findFreeSlot`;table 零欄空狀態。
- 驗收:`tests/j4_drop_create_remove.test.js`:number 模式建 number 卡、text 模式建 table 卡、位置不重疊、拖出移除、number 不可拖出、table 零欄顯示空狀態。

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
| A1 | 地端(gemma-4) | pass,1 輪 79s | 12 條新測試 + 4 項突變全紅 + 全套 959 綠 | 預設 Qwen 端點回 507 載不進,改用 gemma-4;產出含 60 行死碼(在 for...of 中對同一陣列 push,靠 Date 溢位成 NaN 才停),測試全綠也看不出,Claude 刪除並改為逐天早退 |
| A2a | 地端(gemma-4) | pass,1 輪 99s | diff 逐行乾淨,無偷改無註解流失 | 無 |
| A2b(main.js 接線) | Claude | 完成 | 10 條新測試 + 3 項突變全紅 | main.js 428 行超過 forge 整檔重寫上限,八行改動改由 Claude 自做 |
| A3 | Claude | 完成 | 7 條新測試 + 2 項突變全紅,全套 976 綠 | picker.js 800 行超過委派上限,改由 Claude 自做 |
| B1 | 地端(gemma-4) | pass,1 輪 95s | 14 條新測試 + 4 項突變全紅 | 產出用 `new Date(字串)` 解析本地時間(規格明文禁止)且該欄位是死碼、一個空的 else 死區塊、漏 `?? null`;Claude 三處清掉 |
| B2a(cards.js) | Claude | 完成 | 13 條新測試 + 6 項突變(1 項等價,換真突變後紅) | cards.js 562 行超過 forge 整檔重寫上限 |
| B2b(drawer + html) | Claude | 完成 | 13 條新測試 + 6 項突變全紅,全套 1015 綠 | drawer.js 503 行同樣超過上限。`normalizeCard` 未加三個新選項的預設:cards.js render 已處理 undefined,再加一份等於兩個事實來源 |
| C1 | agy(gemini-3.8-flash-high) | pass,1 輪 | 13 條測試 + 8 項突變全紅;白名單、無 BOM/NUL 皆核對 | 產出乾淨,無過度設計 |
| C2a(drop-rules) | agy | pass,1 輪 | 26 條測試 + 5 項突變(1 項等價:測試引用同一常數)| 補一條「上限固定為 8」的硬斷言;`splice` 本身會夾上界,補負數索引測試才抓得到夾範圍 |
| C2b(側欄+接線) | agy | pass,1 輪 | 15 條測試 + 8 項突變 | 落點插入欄位**原本沒有測到**(jsdom 表頭矩形為 0,一律走追加),Claude 補三條 stub 矩形的測試才驗到;瀏覽模式那條原本沒真的拖曳,改成從隱藏側欄實際拖一次 |
| C3 | agy | pass,1 輪 + Claude 修正 | 15 條測試 + 5 項突變(1 項等價:把手是 button,既有判斷已擋)| **抓到真缺陷**:`dnd.js` 命中判定沒跳過「不接受」的目標,拖出移除放在別張卡片上會整個落空,卡片內的防護變成死碼。修法:命中改成往下找第一個接受的目標,並讓格線在指標壓在卡片上時拒收 taskId(否則變成在拒收的卡片底下偷長新卡)。另刪掉 dashboard 重複的 `findFreeSlot`(`addCard` 自己會找空位)|
| D | Claude | 完成 | SPEC §2/§4/§8.2、CLAUDE.md、BACKLOG 皆更新 | — |
| 終檢 14 項 | Claude(Opus 5) | 完成 | 見〈併回前終檢〉 | commit `2421e87` |
| 定案落實核對 2 項 | Claude(Opus 5) | 完成 | 見〈定案落實核對〉 | commit `6582812` |
| 體檢輪 | Claude(Fable 5.1) | 完成 | 見〈體檢輪修正〉 | 換模型後獨立掃描 |

## 規劃完成後複檢

- **與既有設計衝突**:A 定案 1 推翻 SPEC §4 的 `periodInMinutes: N`,已明寫;看門狗與錯過清單已親自核對:看門狗是第二個建 alarm 入口(A2 收斂為呼叫同一純函式),錯過清單本來就不含 interval(維持,列明確不做)。
- **批次之間**:B1 改 `pivot` 簽章,`cards.js`(B2)是唯一呼叫端(grep 確認只有 cards.js:262 與測試);C2 的 table 插入位置依賴 B 定案 1「欄序 = source 順序」,順序 B 先於 C 已保證。A3 與 B2 不碰同檔。
- **四個坑**:什麼算一個 — 桶內「一筆」= 有效時刻落在桶內的紀錄,空桶不成列;分母為零 — 已寫;破壞性判準 — 本輪無刪除資料的操作,拖出移除只改 `source` 且進 undo;單向閘門 — 無;移除類 — `periodInMinutes` 的依賴方 grep 結果只有 scheduler.js:137 與 watchdog.js:61 兩處,A2 白名單涵蓋兩者;測試 d1 有「interval 用 periodInMinutes」一條需反轉。
- **升級路徑**:既有 interval 任務靠 `onInstalled` 重建即可;既有 table 卡片靠 `normalizeCard` 補預設。
- 未發現其他事項。


## 併回前終檢(兩份獨立 Explore:程式碼 + 文件契約)

跑完 `git diff dev...HEAD` 全量審查,**抓到 14 項要處理的落差**,全部已修並各自補測試與突變驗證。

**最嚴重(高)**:`capturedAt` 是 `new Date().toISOString()` 的 **UTC**,`slot` 是**本地時間**,
本輪的「沒有 slot 就用 capturedAt 截到分鐘」把兩者混在同一個字串空間比較。
台北 09:00 的紀錄會跑到凌晨 1 點那一列、期間篩選會漏掉早上的補抓紀錄、桶內取最新會判反。
更糟的是**測試 fixture 用的全是產品不會產生的格式**(`+08:00` 或不帶時區),把這個 bug 完整遮住;
換成真實的 `Z` 格式後才紅。修法:`effectiveTimeOf` 正確換算,`buildSeries` 一併沿用同一份。

**其餘已修**:重試不帶原始槽(同一次排程會變兩列)、晚觸發用 now 判斷時段(會丟掉排定合法的最後一格)、
表格最後一欄拖不動(`accepts` 用空 opts 問等於問「搬到最後有沒有變化」)、最近 N 筆模式拿固定表頭算插入索引、
status 卡片加得進拿不出(且移除路徑寫死 `source`)、`pointercancel` 不接會留下幽靈與高亮、
多點觸控不比對 `pointerId`、矩形命中判定兩份、樞紐表未設 limit 就無上限、新卡片不看落點、
側欄沒有模式標示、`renameDashboard` 空字串、圖例色號用過濾後索引會整排位移、
`series.js` 的死欄位與無保護解析、抽屜容差文案與固定桶語意不符。

**審查提出但判定不需改的**:
- DST:另寫 `tests/j9_dst_interval.test.js` 用 `America/New_York` 實測春秋兩次轉換,
  四條全過(不會停擺、時刻嚴格遞增、回撥當天排得滿),原判斷過於保守。
- weekdays 空陣列語意反轉:維持本輪定案(缺省=每天),但這確實是既有資料的靜默行為變更,
  已寫進 SPEC §4;Picker 對 interval 沒有強制至少勾一天,若使用者反映「暫停失效」再處理。
- `renderDashboard` 內 `updateEditingUI()` 對舊 DOM 操作:確為多餘,但無害且移除會動到既有編輯模式路徑,
  不在本輪動。

**突變驗證**:對 15 個守門點做突變,12 項當場紅;3 項存活逐一查證——
兩項是等價突變(測試幾何剛好使結果相同、放開座標會覆蓋最終目標),補強測試後紅;
一項揭露 `pivot` 裡的排序其實是多餘的(取最新是逐筆比較,與順序無關),已刪。

**收官**:`npm test` 1125 綠(其後兩批修正與體檢輪見下,最終 **1138 綠**,基線 947 → +191),真實瀏覽器煙霧測試 13 項全過。


## 定案落實核對(最後一次,實作全部完成後)

再開一份獨立 Explore 逐條比對「定案 → 程式碼」,結果:

- 作業 A 全 11 條、作業 B 全 9 條、作業 C 全 16 條,除下列四處字面差異外**全部落實**;
  「明確不做」六項逐一查證,確實都沒有被偷偷實作。
- **核對過程自己另外抓到兩項真落差並已修**(commit `6582812`):
  1. 「有效時刻只有一份」其實還有三份:`buildSeries` 的每日聚合、`latest` 的排序與前一日比較都還在只看 `slot`。
     後果是沒有 slot 的紀錄在數值卡片被當成最舊、在每日聚合整筆消失,與表格給出不同答案。
  2. 側欄的窄視窗規則**根本不存在**,而我原本的驗證測試是跨整份檔案的鬆散比對,
     任何一條 `@media` 都能讓它通過(同義反覆)。已補規則與收合鈕,並把測試改成逐個 media 區塊解析。
- **與定案字面不同但刻意如此的四處**(文件已就地更正):
  `normalizeCard` 不補預設(避免兩個事實來源)、拖曳尋址不用 `elementFromPoint`(jsdom 沒有,
  且改法讓「上層拒收往下找」成立)、`aggregation` fallback 是 `raw`(初稿的 `last` 是筆誤)、
  C2/C3 的測試檔切成三檔。


## 體檢交接與體檢輪修正(換模型:實作 Opus 5 → 體檢 Fable 5.1)

兩份獨立 Explore(獵 bug 針對最後兩個手改 commit;架構契合與文件普查)各掃一次,抓到並修掉:

| 哪裡 | 症狀 | 怎麼修 | 迴歸測試 |
|---|---|---|---|
| `series.js` raw 序列 | `t` 仍是裸 `slot`,無 slot 的紀錄進了篩選卻在 X 軸印出 `undefined`、全塌成同一格、排到最前 | 排序與 `t` 都改用 `sortKeyOf`/`effectiveTimeOf` | `k1` 第 1、2 條 |
| `cards.js` 最近 N 筆 | 時間欄與排序仍是 `slot \|\| capturedAt` 原字串,UTC 直接顯示且排錯 | 改用 `effectiveTimeOf` | `k1` 第 3 條 |
| `export.js` 紀錄表 | 終檢宣稱修掉的 UTC/本地混用,在匯出報表原封不動 | 改用 `effectiveTimeOf` | `k1` 第 4 條 |
| `effectiveTimeOf` | slot 格式不合就回空、不退到 capturedAt(整筆消失);Date/數字輸入回空但 `sortKeyOf` 卻算得出來,分組與排序不一致 | 格式不合退路到 capturedAt;非字串走 `Date.parse` | `k1` 第 5、6 條 |
| `latest` | 同一有效分鐘內靠陣列原始順序決定新舊,與 `pivot` 是第二套規則 | 改用 `sortKeyOf` | `k1` 第 7 條 |
| `dnd.js` `onPointerCancel` | 沒比對 `pointerId`,第二根手指被判成捲動會無辜取消食指的拖曳 | 補檢查;與 Escape 合併成 `abortDrag` | `j1` 新增 1 條 |
| `pivot` 雙簽章 | 陣列分支只剩 `report.js` 一個呼叫端 | 呼叫端改 options,刪陣列分支 | `h5` 改守新契約 |
| `dashboard.js` | `gridCellAt` 的 `h` 只有 `void h`;`updateEditingUI` 在清空 grid 前呼叫,把手迴圈打在舊 DOM | 刪參數;呼叫移到卡片掛完之後 | 既有 g3/j3/j4 |
| `dnd.js` | `DRAG_THRESHOLD_PX` 匯出但無外部消費者 | 改模組內常數 | — |

架構掃描確認**已收斂只剩一份**:矩形命中、有效時刻、移除把手、成功判定、重疊判定、找空位。
判定保留不動:`isFreeAt`(三行、語意清楚)、`MAX_CHART_SERIES` 匯出(測試硬斷言用)、`isDragging` 匯出(測試觀察用)、
五處空 `catch {}`(全是 API 缺失或 handler 例外不該中斷清理)、歷史頁的第二份樞紐表渲染(定位不同,已共用 `pivot()`,SPEC §8.3 補說明)。
三項既有缺口記進 BACKLOG(歷史頁分組略過無 slot、匯出夾帶隱藏把手、刪任務後重試 alarm 殘留)。

文件普查:SPEC 去掉輪次敘事與變更史句、補 recent 預設 10、零欄空狀態限定樞紐表、`addCard` 位置通則、改名 trim;
CLAUDE.md 合併兩條 `periodInMinutes`、三條規則改為指向 SPEC、基線 1138;README 補本輪功能與基線;BACKLOG「本輪」改 AF-4。

體檢後 `npm test` **1138 綠**,煙霧測試 13 項全過,9 項突變全紅(1 項補測試後紅)。
