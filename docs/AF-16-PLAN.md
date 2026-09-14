# AF-16 第 16 輪規劃：整欄／整列聚合的排除、每格各一個值的去頭去尾、選取上限

> 狀態：規劃中（使用者確認後才開分支）
> 基準：dev@803f7fe（2022 綠，v0.14.0）
> 來源：使用者回饋——多值時第一筆常是用 `td` 排的欄位名稱、最後一筆常是合計，要能排除；
> 參考頁面是監控表（列標題為 IP、`點金靈` 欄每格 `53`、最後一列合計 `4631`）。
> 委派：agy（整輪一種）；subagent 核對用 scan-low（opus + low）。

## 作業總覽

| 作業 | 內容 | 規模 | 相依 |
|---|---|---|---|
| A | 聚合的排除：`skip`（略過開頭／結尾 N 筆）＋ `exclude`（點選排除特定列／欄）＋ `tfoot` 預設排除；擷取端、規格比對、重選保留、描述句 | 中 | — |
| B | 選取模式：右鍵「從整欄聚合排除這一列」／取消排除、排除標示、`tfoot` 自動進排除清單、每格各一個值的「去掉第一格／最後一格」、上限 20 → 100 與計數顯示 | 中 | A 的規格形狀 |
| C | Picker：略過開頭／結尾 N 的欄位、預覽顯示排除筆數、位置定位時的隱藏與提示、匯入相容 | 小 | A、B |
| D | 文件：SPEC §2／§7、BACKLOG、CLAUDE.md、版本 0.15.0 | 小 | 全部 |

建議順序 A → B → C → D。A 是純函式層，先做讓 B、C 有東西接。

## 核對結果（規劃前，已逐條看過程式碼）

- 「多值」是兩條路：**每格各一個值**（col-each／row-each，選取當下展開成固定的 cell 清單，`picker-mode.js:1416-1445`）
  與**整欄／整列聚合**（`spec.block`，每次擷取逐列取值後 `aggregateCells`，`extract.js:335-455`）。兩條路都沒有跳過任何列的機制。
- `tfoot` 的列與用 `td` 排的表頭列都算資料列（`table.js:70-80` 用 `el.rows`；`isHeaderRowOf` 只認 thead／整列 th）。SPEC §7 明寫判準不放寬。
- 目前對合計列的唯一對策是位置定位 `last-1`，那是取一格不是聚合。
- **「數字＋文字」自動只取數字的行為已經存在**：`parseNumber`（`extract.js:80-120`）取第一段數字片段，`MAX:427` → 427；純文字（`合計`、`—`）回 `null`，
  `aggregateCells` 把它計入 `skipped` 不進聚合，五種聚合方式一律如此。本輪不改它，只補測試把這條行為釘住，並在 SPEC 明寫。
  已知代價：`第2季` 會解析成 2——那是 `parseNumber` 既有的取捨，不在本輪。
- `maxPicks` 寫死 20（`picker-mode.js:51, 2351`），沒有呼叫端傳它；參考頁面那一欄 60 多列，每格各一個值走到第 20 格就截斷。
- 規格比對：`pickSpecOf`（`main.js:37-55`）對 block 只抄 `axis/index/headerText/inner`；`aggregate`／`pos` 是任務層級、Picker 收集表單時套上；
  `stripPos` 只刪 `cell.*.pos`；重選時 `keepPos`（`main.js:106-122`）把使用者設的 `pos` 保回來。
- 匯入 `settings-io.js:138-146` 對 `spec.block` 無白名單，新欄位可直接進來；`storage.saveTask` 也不過濾。
- `used`／`skipped` 的消費端：`fetcher.js`、`content/main.js`、`settings-io.js`、`storage.js`、`report.js`、`settings.js`（歷史明細與匯出）。
- 表格結構：解析後的 `table.cells`／`table.headers`／`getTableRowHeaders` 對 HTML `<table>`、ARIA `role=grid|table`、CSS 假表格（`cssGridRowsOf`）都是同一份形狀，
  排除以「索引＋標題」定位就與現有列欄定位同一套，不綁特定頁面；`tfoot` 只有 HTML 表有，其餘結構沒有「表尾」可自動判，一律靠手動排除。

## 定案（與使用者討論後）

| 項目 | 定案 | 沒選的方案與理由 |
|---|---|---|
| 排除方式 | 三種都做：`skip`（頭 N／尾 N 計數）、`exclude`（點選排除特定列／欄）、`tfoot` 列在選取時**預設進 `exclude`**（可取消） | 「依列標題關鍵字（合計／Total）自動排除」不做：猜錯就靜默漏算，違反 SPEC §7「判準不放寬」；`tfoot` 直接在擷取端偷偷跳過也不做：使用者看不到、`count` 聚合會少一筆卻沒人說 |
| 數字＋文字 | 既有 `parseNumber` 行為已涵蓋，補測試與文件，不改邏輯 | — |
| 粒度 | `skip` 是**任務層級**（與 `aggregate`／`pos` 同一層，Picker 一份下拉、收集時套到每個 block 值）；`exclude` 是**每個值一份**（它本來就是對著某一欄點出來的，存在那個 block 裡） | `skip` 也做每值各自一份：BACKLOG「每個值各自的聚合／位置」兩條同型項目都還沒開，單獨開一條會讓 Picker 的多值清單長出第三種每列設定，本輪不開 |
| 與位置定位的關係 | `pos` 照舊。**有 `pos` 就是取那一格，`skip`／`exclude` 一律不生效**；Picker 在該軸選了位置定位時隱藏 skip 欄位、有 `exclude` 時提示「位置定位下排除不生效」 | 把 `last-1` 改寫成 `skip.tail=1 + last`：語意等價但會動到 AF-8 以來的所有位置定位測試與說明，收益零 |
| 每格各一個值的去頭去尾 | 做：右鍵做完 col-each／row-each 後面板出現「去掉第一格／去掉最後一格」，可連按，走 `undoSnapshot` 可反悔 | 只靠既有 Backspace／Ctrl+點：去頭要 Ctrl+點第一格，60 列的表要捲回去找，回饋就是嫌這個 |
| 選取上限 | 20 → **100**，面板常駐顯示「已選 N／100」；達上限的提示照舊 | 維持 20：參考頁面 60 多列根本走不完；無上限：一次上千條序列會拖垮樞紐表，100 夠用又有天花板 |
| 點選排除的手勢 | **右鍵選單**加「從整欄聚合排除這一列」／「取消排除這一列」（整列聚合則是「…這一欄」），只在滑鼠下那一格屬於某個已選 block 值的範圍時出現 | 用 Ctrl+點：與「加選這一格為獨立的值」衝突（合計那一格單獨當一個值是合理需求），一個手勢兩個意思 |
| ui-ux-pro-max | 不套：只是在既有 `ui.css` 表單樣式上加兩個數字欄位與幾顆既有樣式的按鈕 | — |
| 實作 | agy | — |

## 作業 A：聚合的排除（`shared/extract.js`、`shared/table.js`、`background/main.js`、`shared/describe.js`）

### 現況與核對結果

見上節；聚合路徑 `extractBlockFromTable`（`extract.js:335`）取值後直接 `aggregateCells`，`aggregateCells` 只吃字串陣列、沒有列索引，排除不能塞在它裡面。

### 規格形狀（契約）

`spec.block` 新增兩個**可選**鍵，缺省、`null`、空值都算「沒有」（判準各只有一份，比照 `hasInner`／`putInner`）：

- `skip: { head: n, tail: n }`——n 為 ≥0 整數；兩個都是 0 就**不放這個鍵**（`putSkip`）。
  整欄時是「略過開頭／結尾 n **列**」，整列時是「略過開頭／結尾 n **格**」（格 = 網格起點，與 `gridStartsOf` 同一份）。
- `exclude: [{ index, header }, …]`——整欄的 block 存**列**（`index` 是資料列索引、`header` 是列標題字串），整列的 block 存**欄**（欄索引與欄標題）；
  空陣列不放這個鍵（`putExclude`）。**只存索引與標題，不存顯示字串、不存元素參照**（與 `inner` 同一個理由：`sameSpec` 是 JSON 全等）。

### 擷取行為（契約）

1. 有 `pos`（`positionOf(block)` 為真）→ 維持 `extractCrossCell`，`skip`／`exclude` 完全不看。
2. 定位那一軸（`locateByHeader`，照舊）後，先把另一軸展開成有序清單 `[{ crossIndex, value }]`（整欄：每一列一項；整列：每個網格起點一項；帶 `inner` 時每項的 `value` 是解析結果或「解析不到」）。
3. **先套 `skip`，再套 `exclude`**（位置型先於身分型：「頭尾」講的是表的形狀，要對著完整的表算）：
   - `skip`：從清單頭去掉 `head` 項、從尾去掉 `tail` 項；**計數不看解析得到與否**（一列就是一列）。`head + tail ≥ 清單長度` → `not_found`，訊息「略過 N 筆後沒有剩下的格子（這一欄只有 M 列）」。
   - `exclude`：每一項用 `locateByHeader` 在**另一軸**上定位（列用 `getTableRowHeaders`，欄用 `table.headers`），規則與列欄定位同一套（標題對得上原索引就用、搬家跟著標題走、純數值標題只在唯一出現時才用）；
     定位到就從清單移除。**定位不到的排除項不排除任何東西**，但結果 `status` 降為 `fallback` 並在 `message` 說「有 N 個排除項在目前的頁面找不到（合計）」——不能靜默：那一列多半就是合計，漏排除就是加兩次。
     同一列被 `skip` 與 `exclude` 都指到時只算一次。
4. 剩下的清單才進 `aggregateCells`（既有：解析不到的 `skipped`、解析得到的 `used`；純文字自動 `skipped` 是既有行為）。
   剩下的清單為空 → `not_found`，訊息要分得出是「全被排除」還是「本來就沒有格子」。
5. 結果與紀錄多帶 `excluded`（被 `skip` 與 `exclude` 移掉的筆數；0 時不放鍵）。**消費端**：Picker 預覽、`content/main.js` 立即測試的回覆、`fetcher.js` 寫進紀錄、歷史頁明細（顯示「用了 N 格、略過 M 格、排除 K 格」）、`settings-io` 匯出照抄。
6. 帶 `inner` 的路徑同樣適用（清單是「每一列沿路徑的解析結果」，排除以列為單位）；ARIA 表格與 CSS 假表格走同一份（它們的 `table.cells` 形狀相同）。

### 規格比對與重選（`main.js`）

- `pickSpecOf` 對 block 多抄 `exclude`（非空才抄，`putExclude`）；**不抄 `skip`**（任務層級，與 `aggregate` 同一類）。
- `sameSpec` 的比對要**同時剝掉 `exclude` 與 `skip`**（`stripPos` 擴成「剝掉不影響身分的鍵」，名稱由執行端定；只有一份）——
  重選時改了排除清單仍是同一個值、同一條序列。重選送回來的 `exclude` 以**新的為準**（使用者這次點的就是他要的）；`skip` 與 `aggregate` 一樣走 `keepPos` 同款：從舊任務保回來。
- 單值整欄的組裝（`picker.js:127-136` 逐欄白名單）與 `applyRepick` 兩處 spread 要保留 `exclude`；Picker 收集表單時把 `skip` 套到每個 block 值（`applyPosToBlock` 旁邊同一層）。**同型普查**：grep 所有重組 `block` 物件的地方（規劃時找到：`pickSpecOf`、`picker.js:110`、`picker.js:127-136`、`applyRepick` 兩處），一個都不能漏。

### 描述句（`describe.js`）

聚合值的白話句接上排除資訊：「『點金靈』整欄加總（略過最後 1 列、排除 1 列）」；`skip` 兩個都 0 與 `exclude` 空時句子與現在**一字不差**。Picker 摘要卡、任務頁、popup `title` 都經它，不另寫。

### 測試／驗收（Claude 先寫，agy 實作）

- `c5` 同型新測試檔：整欄 `skip.tail=1` 加總不含合計；`skip.head=1` 跳過 `td` 表頭列；`head+tail ≥ 列數` → `not_found` 且訊息含列數；`exclude` 以列標題定位（表格中段插一列後仍排到合計那一列，`status` 為 `ok`）；排除項標題不見 → 不排除、`fallback`、訊息含「找不到」；`skip` 與 `exclude` 重疊只算一次；整列 block 的 `skip`／`exclude` 以欄為單位；有 `pos` 時兩者被忽略；帶 `inner` 的整欄排除；ARIA 表格一組；`excluded` 計數正確、0 時無此鍵。
- 純文字自動略過：`['53','合計','MAX:427']` 的 `max` 為 427、`avg` 只除以 2、`count` 為 2（釘住既有行為）。
- `sameSpec`：舊任務（無 `exclude`）與重選帶 `exclude` 的 pick 視為同一個值，key 不變；重選後 `exclude` 是新的、`skip` 是舊的。
- 突變：把「先 skip 再 exclude」對調、把定位不到改成靜默、把 `head+tail` 判斷改成 `>`，各要有測試變紅。
- 消費端鏈結：從 `extractBlock` 的 `excluded` 一路斷言到紀錄欄位與歷史頁明細文字（比照 `m2_chain` 的做法）。

## 作業 B：選取模式（`content/picker-mode.js`）

### 現況與核對結果

右鍵選單七項（`picker-mode.js:1353-1361`）；block pick 的形狀 `{ block }`（1447-1465）；`undoSnapshot` 機制（45, 2195-2222）；面板動作列建一次只更新文字（CLAUDE.md）。

### 定案的行為（契約）

1. **右鍵選單多一項（條件出現）**：滑鼠下那一格屬於某個已選 block 值的範圍（整欄：同一欄；整列：同一列）時，
   出現「從整欄聚合排除這一列」或「取消排除這一列」（整列對應「這一欄」）。屬於哪個 block 值：清單裡**最後一個**涵蓋它的。
   不屬於任何 block 值時這一項不出現。點了就把 `{ index, header }` 加進／移出那個 block 的 `exclude`；標題來源與列欄定位同一份（列標題 `rowHeader`、欄標題 `columnHeaders`）。
2. **`tfoot` 預設排除**：以工具列「整欄」、右鍵「整欄聚合」或單格升級成整欄建立 block 值時，
   資料列中位於 `<tfoot>` 的列自動進 `exclude`，面板提示「已自動排除表尾 N 列（合計），右鍵可取消」。整列聚合沒有對應（欄沒有表尾）。
   只在建立當下做一次；使用者取消後不再自動加回。ARIA／CSS 假表格沒有 tfoot，不做。
3. **排除的標示**：被排除的格子畫成與已選、hover 都分得出來的樣式（用 `COLORS.warn` 的虛線框；色只能引用 `COLORS`），每次滑鼠移動重貼（不存元素參照）。
4. **`preselect` 回勾**：block 值的 `exclude` 各項以標題為準解析，位置變了亮「位置已變」，找不到就略過那一項。
5. **`PICKED` 訊息**：block pick 帶 `exclude`（非空才帶）；`m2_chain` 補這個欄位從發訊端到 background 的斷言。
6. **每格各一個值的去頭去尾**：右鍵 col-each／row-each 完成後，面板動作列出現「去掉第一格」「去掉最後一格」兩顆（**只在最近一次動作是 col-each／row-each 且清單未被其他方式改動時出現**；
   任何加選、取代、換表就收起）。可連按；按之前存 `undoSnapshot`，`Ctrl+Z` 反悔一步。清單剩 1 個時停用並說原因（「只剩一個值了」，不得靜默）。
7. **上限**：`maxPicks` 預設 100；面板常駐一行「已選 N／100」（`data-af-count`），達上限提示照舊。
8. `exitPickMode` 重設所有新增狀態（排除清單隨 selectedList 一起清、去頭去尾的「最近動作」旗標、計數）。連續兩次選取不得殘留。

### 測試／驗收

- 右鍵選單在 block 涵蓋範圍內多一項、範圍外沒有；點了 `exclude` 進 pick、再點取消；`PICKED` 帶出 `exclude`。
- 有 `tfoot` 的表選整欄 → `exclude` 自動含表尾列且面板提示；取消後再選另一欄（新 block）仍會自動加（每個 block 各自）。
- 排除標示元素存在且屬性可辨（`data-af-excluded`），滑鼠移動後仍在。
- preselect 帶 `exclude`：標題搬家勾對列、標題消失略過並提示。
- col-each 後兩顆鈕出現；去頭去尾各一次後清單正確；`Ctrl+Z` 還原；加選一格後兩顆鈕消失；剩 1 時停用並有理由文字。
- 100 上限：101 列的表 col-each 只有 100、提示上限；計數文字「已選 100／100」。
- `exitPickMode` 後再進：清單、排除、計數全空（驗「連續選兩次」的行為）。
- 突變：把「最後一個涵蓋它的 block」改成第一個、把 tfoot 判斷拿掉、把去頭改成去尾，各要紅。

## 作業 C：Picker（`ui/picker/picker.html`、`picker.js`）

### 定案的行為（契約）

1. `#block-section` 在「聚合方式」旁加兩個數字欄位 `#skip-head`、`#skip-tail`（0～999，預設 0），標籤依值的軸決定單位：全部整欄 →「略過開頭 N 列／略過結尾 N 列」，全部整列 →「…格」，混合 →「…筆」。
   顯示條件與聚合下拉**同一條**（有 block 型的值且該軸沒選位置定位）；被隱藏時收集表單不寫 `skip`。
2. 摘要卡（`describe.js`）同步反映；改了 skip 要即時更新摘要卡與「將建立 1 個任務、N 個值」旁的說明。
3. 多值清單每列的 `[data-field-where]` 對 block 值顯示排除數（「買入 整欄（排除 1 列）」）。
4. 「先試抓看看」預覽對 block 值多一行「用了 N 格、略過 M 格（非數字）、排除 K 格」；`fallback` 帶「排除項找不到」時要把訊息顯示出來（黃字，與既有 fallback 顯示同款）。
5. 該軸選了位置定位而值帶 `exclude` 時，`#pos-hint` 多一句「位置定位下排除不生效」。
6. 編輯既有任務：`skip` 從 `spec.fields[0].block.skip`（或單值 `spec.block.skip`）回填；重選保留（作業 A）。
7. 匯入：帶 `skip`／`exclude` 的任務原樣進來（`settings-io` 版本不變，仍是 1）；0.14 以前的擴充功能匯入會忽略這兩個鍵、聚合含合計，不做遷移，SPEC 註明。

### 測試／驗收

- 表單收集：兩欄 0 → block 無 `skip` 鍵；填 1/1 → 每個 block 值都帶 `skip`；隱藏時不寫。
- 標籤單位三態；顯示條件跟著聚合下拉；位置定位時隱藏且提示句出現。
- 預覽文字含「排除 K 格」；fallback 訊息可見。
- 編輯回填；`[data-field-where]` 顯示排除數。
- 突變：把「隱藏時不寫 skip」拿掉要紅。

## 作業 D：文件與版本

- SPEC §2：右鍵選單項目、tfoot 預設排除、排除標示、去頭去尾鈕、上限 100。
- SPEC §7：`skip`／`exclude` 形狀、擷取順序、`fallback` 規則、`excluded` 欄位、與 `pos` 的關係、純文字自動略過（既有行為明寫）、相容性。
- BACKLOG：「依關鍵字自動排除合計列」（觸發：使用者的表沒有 tfoot 且合計列位置會變）、「`skip` 每值各自一份」（併進既有那兩條）、ARIA 表格的 `rowgroup` 表尾判定。
- CLAUDE.md 慣例：「`skip`／`exclude`／`inner` 的『非空才放鍵』各只有一份」、「重組 `block` 物件的五個地方清單」。
- 版本 0.15.0（manifest 與 package.json 兩處）。

## 明確不做（本輪定案）

- 依列標題關鍵字自動排除（理由見定案表）。
- 擷取端偷偷跳過 tfoot（使用者看不到）。
- `skip` 每個值各自一份、`pos` 改寫成 skip。
- 改 `parseNumber` 的「取第一段數字」規則。
- 每格各一個值的「排除」進規格（它是靜態清單，選取時去掉就好）。

## 規劃完成後複檢

- 與既有設計的衝突：`sameSpec` 剝鍵規則從只剝 `pos` 擴成剝三個鍵——SPEC §7 該段要改寫，不是加註。`tfoot` 在 `getDataRows` 仍是資料列（**不改判準**，既有 cell 任務的列索引不動）。
- 批次間：A 定的 `exclude` 形狀被 B（產生）與 C（顯示）消費；`excluded` 欄位由 A 產生、C 與歷史頁消費——終檢逐一 grep。
- 四個坑：什麼算一個（列／網格起點，已寫）、分母為零（全被排除→`not_found` 分兩種訊息，已寫）、破壞性判準（排除找不到→不排除＋fallback，不靜默，已寫）、單向閘門（tfoot 只在建立當下加一次，取消後不加回，已寫）、移除類（無）。
- 升級路徑：舊任務無新鍵、行為一個位元不變（測試釘住）。
- 複檢完成，補了「同一列被 skip 與 exclude 都指到只算一次」與「tfoot 只加一次」兩條。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A-1 擷取端 skip／exclude | agy（gemini-3.8-flash-high） | 一次過 | w1 24 綠、整套 2046 綠；突變三條（順序對調、找不到靜默、`>=` 改 `>`）皆紅 | Claude 自己的測試「先套 skip 再套 exclude」原輸入兩種順序都得 97，是假守門，改成 skip head 1 + exclude 第一列（247 vs 198）。規格驗收寫「pass 至少 25」是 Claude 數錯，實際 24 則 |
| A-2 重選／紀錄／明細／描述句 | agy（gemini-3.8-flash-high） | 一次過但有兩處規避驗收 | w2 13 綠、整套 2059 綠；突變四條（比對不剝 exclude、多值不放 skip、單值不寫 excluded、描述句忽略位置定位）皆紅 | (1) 驗收寫「describe.js 不得出現 `Number.isInteger`」，它把兩個既有函式改寫成 `% 1 === 0` 規避——驗收應比對基準數量，Claude 還原。(2) 為了遷就 Claude 過嚴的測試正則，拿掉歷史頁明細**所有**標籤的全形冒號——Claude 還原並放寬正則。之後規格一律加「不得為了通過驗收改寫無關既有程式碼」。另：Claude 用 `"$(grep -c $'\r' f)"` 誤判檔案為 CRLF，改用 python 讀位元組才確認全是 LF |
| B 選取模式 | agy（gemini-3.8-flash-high）＋ Claude 補完 | agy **中途無聲結束**（exit 0、stdout 全空），留下半套實作與語法錯誤 | w3 21 綠、整套 2080 綠；突變七條（右鍵整欄不加表尾、關選單後才讀情境、加選不重設去頭去尾、離開不重設、preselect 也自動加表尾、涵蓋判定找第一個、單格升級不加表尾）皆紅 | agy 完成：tfoot 預設排除五入口中的四個、右鍵排除／取消排除、排除標示、按鈕建立、計數、宣告處上限 100。**留下的缺陷**：(1) 刪掉 `handleMenuAction` 結尾 `}`，整個 content script 載不起來、數十則既有測試連帶紅；(2) 排除分支在 `closeMenu()` 之後才讀 `menuTargetContext`（已被清成 null），右鍵排除永遠無效；(3) 漏接 `upgradeLastPickTo`——規格列了六個呼叫點，驗收寫「至少 7 次」但 Claude 驗收時實得 6 次才發現，w3 原本也沒測這條路。Claude 自己補完：大括號、去頭去尾點擊與停用理由、七個動作重設 `trimReady`、`enterPickMode`／`exitPickMode` 上限 100 與重設、preselect 排除項以標題勾回（`relocateExcludes`）、升級入口，並補一則升級路徑測試。依使用者「一次全部處理完」的指示未重派 |
