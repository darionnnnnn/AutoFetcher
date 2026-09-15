# AF-17 規劃：頭尾空白自動略過 ＋ 立即測試明細表

> 狀態：實作完成、終檢中（分支 `feature/AF-17`；尚未併 dev，收尾與換模型體檢留給 `project-closeout`）
> 基準：dev@f01f27c（2117 綠，v0.15.0）
> 來源：使用者回饋——「抓取整欄/列時需要排除部分資料，但點選測試後看不到抓到哪些格、是否正確排除」
> 1. 讓使用者自己選擇是否自動排除頭尾空欄位（預設選取）
> 2. 加上顯示測試抓到的表格，讓使用者確認要排除前後幾格

## 作業總覽

| 作業 | 內容 | 規模 | 相依 | 執行者 |
|---|---|---|---|---|
| A | 頭尾連續空白格自動略過（`skip.blank`，預設開） | 中 | — | agy（開工前先查額度；額度不足改派 `impl-low`，整輪不再換回） |
| B | 立即測試明細表：每個整欄／整列值回傳逐格處置，Picker 以 `<details>` 展開表格 | 中 | A-1 先定 `items` 形狀 | agy |
| C | 文件、版本 0.16.0、體檢交接 | 小 | A、B 完成 | Claude 親做 |

建議順序：A-1 → A-2 → B-1 → C。A-2 與 B-1 都改 `picker.js`，不得並行委派。
測試由 Claude 先寫（含突變）再委派；每段規格檔只放該段契約。

### 定案總表（與使用者討論後）

| 待決 | 定案 | 理由 |
|---|---|---|
| 「頭尾空欄位」指什麼 | **頭尾連續的空白格**（`textContent` trim 後為空）自動不計入；tfoot 預設排除維持原樣、不加開關 | tfoot 已有右鍵取消，加開關是第二個入口；空白格本來就不進聚合，這一項真正改變的是 `skip` 的計數基準與預覽口徑，讓「略過開頭 N」不必把空列數進去 |
| 設定存在哪 | **併進既有 `skip` 物件**：`skip: { head, tail, blank: true }`，不另開 block 鍵 | `skip` 已有五個搬運點（Picker 收集兩處、background 重選兩處、`stripPos`），全部經 `putSkip`／`skipOf` 一份判準；併進去等於零新增搬運點，AF-15／AF-16「每段自己都綠、規格裡就是沒有」的坑直接消失 |
| 缺省怎麼算 | `blank` 只有字面 `true` 才算開；缺省、`null`、`false` 都是關 | 舊規格擷取結果一個位元不變；新建任務 Picker 預設勾、存檔明寫 `true` |
| 明細怎麼呈現 | 面板預覽區下方的 `<details>` 展開表格 | side panel 360px，`<dialog>` 沒有多出空間；回頁面上色進 BACKLOG（要新訊息進 frame、多值混色、換頁時機） |
| 明細怎麼取得 | 擷取端**一律**隨整欄／整列結果回傳 `items`，不走 dryRun 旗標、不走訊息欄位 | 紀錄寫入是白名單挑欄位（`fetcher.js` 622–650）本來就不會夾帶；`raw` 已經是全部格子 join 的字串，成本只多一點；避開「訊息欄位改行為」（AF-12 拔掉的那一類） |
| 空白格數要不要進紀錄 | **只進預覽，不進紀錄**（結果多帶 `blank`，`fetcher` 白名單不抄） | 紀錄格式與匯出多一鍵的代價大於收益；歷史頁口徑不變 |
| 明細表點一列設略過 | 不做，進 BACKLOG | 第二個改 `skip` 的入口；頁面右鍵已能排除單列 |
| 白話描述（`describe.js`）要不要說「自動略過空白」 | 不說 | 它是衛生預設不是表的形狀；幾乎每個新任務都帶會變成噪音。Picker 勾選框與明細表看得到 |
| `ui-ux-pro-max` | 不套 | 只是在既有面板元件內加一個勾選框與一張表，沿用 `picker.html` 既有樣式與 `theme.css` 變數 |

## 作業 A：頭尾連續空白格自動略過

### 現況與核對結果

- 擷取端沒有這個機制：`extract.js:336-550 extractBlockFromTable` 定位 → 產生 `items` → 套 `skip` → 套 `exclude` → `aggregateCells`；空白格由 `aggregate.js` 的 `parseNumber('')→null` 計成 `skipped`，`count` 也不算它。**所以數值結果與是否略過空白無關**，差別只有：預覽「非數字 S 格」把空白與文字混算；`skip` 的 head／tail 以含空白的完整清單計數。
- `skip` 的判準只有 `table.js:275 skipOf`／`:290 putSkip`；呼叫端五處：`picker.js:150,178`（收集）、`:644`（編輯回填）、`main.js:146,176`（重選保留）、`main.js:59 stripPos`（剝掉再比對）。`describe.js:132` 只解構 `head`／`tail`。
- `#skip-head`／`#skip-tail` 在 `[data-skip-row]`（`picker.html:365`），顯示條件與聚合下拉同一個布林（`picker.js:1511-1531`）；監聽 id 清單在 `picker.js:1387,1395`。
- 既有的自動排除只有 tfoot（`picker-mode.js:179 withFooterExclude`，SPEC §2「表尾合計預設排除」）；本輪不動它。

### 定案

見定案總表。補充：
- **「空白」的判準**：清單項 `ok === true` 且 `raw` 去掉空白字元（含全形空白、NBSP）後為空字串。`inner` 解析不到（`ok:false`）的**不算空白**，仍是「找不到子路徑」。
- **只剝頭尾連續**：清單中段的空白格不動，維持計入 `skipped`。
- **順序**：定位 → 產生清單 → **剝頭尾空白**（開著時）→ 套 `skip` → 套 `exclude` → 聚合。「頭尾」與 `skip` 一樣對著表的形狀算，但空白剝掉之後 `skip` 才數，使用者要略過的「第一列文字表頭」才會是「開頭 1 列」。
- `exclude` 的「找得到」判準（索引在排除前的完整清單裡）**仍以剝空白之前的完整清單**為準：排除項指到一個被剝掉的空白列算找到、只算一次、不亮黃燈（與 skip 重疊同一規則）。
- 結果多帶 `blank`（被剝掉的頭尾空白格數，0 不放鍵）；**不計入 `excluded`**（AF-16 教訓：只設略過的人不能看到「排除 1 格」，同理沒設任何東西的人不能看到「略過與排除 2 格」）。
- 全部都是空白 → `not_found`，訊息「這一欄的 N 列都是空白格」（整列「這一列的 N 格都是空白格」）。
- 剝掉之後 `head + tail ≥ 剩餘數` → 既有訊息後接「（這一欄去掉頭尾 B 列空白後只有 N 列）」；`blank` 為 0 時訊息與現在一字不差。
- **關著時的擷取結果與現在逐位元相同**（`items` 除外，見作業 B）。
- Picker：`[data-skip-row]` 內加勾選框 `#skip-blank`（標籤「自動略過頭尾空白」），**新建預設勾**；`skipFromForm` 回 `{ head, tail, blank }`；編輯既有任務時從 `skipOf(skipSource).blank` 回填（缺省＝不勾，顯示真實狀態）；換目標時 `render` 重跑不重設它（與 `#skip-head` 同待遇）；監聽 id 清單加進去。儲存摘要 `skipNote` 不變。
- 預覽 `blockCountsText`：`blank > 0` 時在「非數字 S 格」後接「、空白 B 格」；為 0 時字串與現在一字不差。
- 設定檔相容：匯出格式版本不變；0.15 以前匯入帶 `blank` 的任務會忽略它、空白格照舊計成 `skipped`，不另做遷移。

#### 實作前核對補充（開工時普查後定案）

- **`skip` 的儲存形狀**：`putSkip` 在 `head>0 || tail>0 || blank===true` 時放鍵；放的物件**一律帶 `head` 與 `tail`**（與 AF-16 相同），**`blank: true` 只在開著時才加**，關著時形狀與現在一字不差。既有測試全等比對的都是 `{head, tail}`（`w1:266-270`、`w2:123,141,153`），這樣它們不受影響。`skipOf` 一律回 `{ head, tail, blank }`，沒有測試全等比對它的回傳。
- **`excluded` 的算法**改成「被 `skip` 與 `exclude` 移掉的筆數」，**不含 `trimmed`**；不能再沿用 `initialCount - remaining.length`，否則頭尾空白會被算進「略過與排除」。
- **失敗回傳帶 `items` 的完整清單**：清單非空之後的**所有**失敗都帶，共五種：略過後沒有剩下、全部空白、全被排除、剩下的全部找不到子路徑、全部非數字（`parse_error`）。清單為空的既有失敗不帶。
- **略過數超過剩餘時的處置標記**：在去掉頭尾空白後的清單裡，位置小於 `head` 的標 `skipHead`，其餘標 `skipTail`。
- **普查確認不受影響**：沒有測試對整欄／整列結果整包全等比對（`v1:237-239` 比的是儲存格，不帶 `items`）；`describe.js` 與 background 重選只解構 `head`／`tail`，只設 `blank` 的規格不會被說成「略過」；background 單值（`fetcher.js:728-755`）與多值寫紀錄都是逐欄挑選。
- **預設勾選帶來的既有測試預期變化**：`tests/w4_picker_skip.test.js` 的「兩欄都是 0 時規格不帶 skip 鍵」從真實表單讀值，預設勾選後規格會帶 `{head:0, tail:0, blank:true}`。這是本輪定案的預期變化，**委派端不得修改既有測試**，A-2 驗收時由 Claude 逐條確認後更新期望值並記入執行紀錄。`b7_picker_block:68` 與 `l3_batch_d:170` 直接傳入規格、不經表單，不受影響。
- **Git Bash 查 agy 額度**：`/quota` 會被 Git Bash 的路徑轉換改寫成 `C:/Program Files/Git/quota`，agy 收到的是一般提示詞。要加 `MSYS_NO_PATHCONV=1`。

### 改動（階段）

**A-1（`shared/table.js`、`shared/extract.js`；測試 `tests/x1_skip_blank.test.js`）**
1. `skipOf` 回傳多一個 `blank`（布林，只認字面 `true`）；`putSkip` 在 `head>0 || tail>0 || blank===true` 時放鍵，只抄這三個欄位。既有呼叫端解構 `{head, tail}` 不受影響。
2. `extractBlockFromTable` 依上面順序剝頭尾空白、回 `blank`、兩則訊息。
3. 本階段一併產出作業 B 的 `items`（形狀見 B），因為處置是在同一條流程裡決定的，拆開會寫兩遍分類。

**A-2（`ui/picker/picker.html`、`ui/picker/picker.js`；測試 `tests/x2_blank_picker.test.js`）**
4. 勾選框、`skipFromForm`、編輯回填、監聽、`blockCountsText` 的「空白 B 格」。

`background/main.js` 與 `describe.js` **零改動**（`putSkip(block, 舊 skip 物件)` 會自然帶著 `blank`；`stripPos` 整個 `skip` 都剝）；驗收要斷言這一點（重選保留、`sameSpec` 不因 `blank` 變動而重生 key）。

### 測試／驗收（Claude 先寫，含突變）

- `skipOf`：`{blank:true}`→true；`{blank:'true'}`、`{blank:1}`、缺省、`null`→false；`putSkip({}, {blank:true})` 放鍵且形狀是 `{head:0, tail:0, blank:true}`；`putSkip({}, {head:1, blank:false})` 形狀是 `{head:1, tail:0}`、不帶 `blank` 鍵；`putSkip({}, {head:0,tail:0,blank:false})` 不放鍵。
- 擷取：欄 `['', ' ', '10', '', '20', ' ']` 開著 → `used 2, skipped 1（中段空白）, blank 3`、value 30；關著 → `used 2, skipped 4`、無 `blank` 鍵，且與 dev@f01f27c 的結果 deep-equal（移除 `items` 後比）。
- 開著＋`skip.head=1`：欄 `['', '標題', '1', '2']` → 略過的是「標題」不是空白列，value 3。**突變**：把剝空白挪到 `skip` 之後要紅。
- 全空白 → `not_found` 與指定訊息；剝完不夠略過 → 訊息含「去掉頭尾 B 列空白後只有 N 列」；`blank=0` 時訊息與現在相同（用既有 w1 測試的字串比）。
- `exclude` 指到被剝掉的空白列 → 狀態 `ok`、不亮黃、只算一次。
- `inner` 解析不到的頭尾格不被當空白剝掉（`skipped` 計入、`blank` 無鍵）。
- Picker：新建預設勾且規格 `skip.blank===true`（單值整欄與多值兩條收集路徑）；取消勾＋head/tail 0 → 規格無 `skip` 鍵；編輯 `skip:{tail:1}` 的舊任務 → 勾選框不勾、tail 回填 1；編輯 `skip:{blank:true}` → 勾；位置定位藏起 skip 列時規格不寫 `skip`（既有規則）。
- `main.js`：重選時舊任務 `skip:{blank:true}` 保回新規格；`sameSpec` 對只差 `blank` 的兩份 spec 回 true（突變：`stripPos` 不刪 `skip` 要紅）。
- 預覽字串：`blank` 為 0 時與現在一字不差（既有 w4 測試不改）；>0 時含「空白 B 格」。
- `node --check` 全部改動檔；`npm test` 只增不減。

## 作業 B：立即測試明細表

### 現況與核對結果

- `picker.js:2272 blockCountsText` 只給 used／skipped／excluded 三個數；擷取端的清單（`extract.js:377-410`）算完就丟。
- dryRun 回傳是整包轉發：`content/main.js:111 handleExtract` 展開 `...extracted`、`fetcher.js:593` 展開 `...res`，多值在 `res.fields[key]`。正式抓取 `fetcher.js:622-650` 逐欄挑進紀錄，不會夾帶新鍵。`buildDebug` 只吃 `error`／`message`。
- **實作前核對補充（開工時發現，規劃原本漏掉）**：整包轉發只對**單值**成立。多值任務的逐值結果在擷取端 `extract.js:576-630` 以**白名單**組出（成功抄 `used`／`skipped`／`excluded`／`message`／`label`，失敗只抄 `error`／`raw`／`message`）。不改這裡的話，多值的 `items` 與 `blank` 在擷取端就被丟掉，Picker 永遠收不到，而單值測試全綠。**A-1 必須在這份白名單的成功與失敗兩條都加上 `items`、成功那條加上 `blank`**，驗收以多值任務斷言兩鍵存在。
- 頁面上的 `data-af-picked`／`data-af-excluded` 是「設定」的標示（`applyPickedMarks`），略過頭尾在頁面上看不出來。
- `picker.html` 沒有表格樣式與 `<dialog>`；`ui.css` 只服務已被使用的類別（本輪樣式寫在 `picker.html` 自己的 `<style>`）。
- 立即測試只開放新建任務（BACKLOG 既有項），明細表同樣只在新建時看得到；不擴大。

### 定案

- **`items` 的形狀（暫定）**：整欄／整列（非 `pos` 取格）結果一律帶 `items: [{ index, header, raw?, number?, use }]`，順序即清單順序：
  - `index`：另一軸索引（整欄＝資料列索引、整列＝網格欄索引）；`header`：另一軸標題字串（整欄＝列標題、整列＝欄標題，沒有就空字串）。
  - `raw`：格子文字（`ok:false` 的沒有）；`number`：`use==='used'` 時解析出的數字。
  - `use` 八態（暫定名）：`used` 採用／`nonnumeric` 非數字／`blank` 中段空白（或關著時的任何空白）／`trimmed` 頭尾空白已自動略過／`skipHead`／`skipTail`／`excluded`／`unresolved` 找不到子路徑。
  - **處置與聚合口徑必須一致**：`items` 中 `used` 的數量 === 結果 `used`；`nonnumeric+blank+unresolved` === `skipped`；`skipHead+skipTail+excluded` === `excluded`；`trimmed` === `blank`。這是鏈結不變式，測試逐一斷言。
  - **只要清單已經產生，失敗回傳也帶 `items`**（「略過後沒有剩下」「全部空白」「全被排除」三種）——這正是使用者最需要看表的時候；處置照當時判定得到的填（例如全部 `skipHead`／`skipTail`／`trimmed`）。清單為空的既有失敗（本來就沒有格子）不帶。
  - `pos` 取格（`extractCrossCell`）與儲存格不帶 `items`。
- **不進紀錄、不進 diag**：`fetcher` 白名單不改；測試斷言寫入的紀錄沒有 `items` 與 `blank`。
- **Picker 呈現**：`#preview-section` 內、`#test-note` 之後加 `<details id="test-detail" hidden>`，`<summary>` 文字「看抓到的格子（N 格）」（多值為各值總和）；內容容器 `[data-test-detail-body]`，每個有 `items` 的值一個 `<section data-detail-field>`（多值時帶值名稱標題，單值不帶），各一張 `<table>`：欄「#」（`index+1`）、「列標題」或「欄標題」（依軸）、「內容」、「數字」、「處置」；每列 `data-use` 帶八態之一，處置欄文字：採用／非數字／空白／頭尾空白（已自動略過）／略過開頭／略過結尾／排除／找不到子路徑。
  - 測試開始時清空並 `hidden`；結果回來只要任一值帶 `items` 就顯示（成功與失敗都是）；預設收合。
  - 內容欄以 CSS 截斷（`text-overflow: ellipsis`），完整文字放 `title`；表格外層 `max-height` 加捲動；非採用列用 `--text-muted`、`excluded` 用 `--warn`。零色碼字面值。
  - 一律 `textContent`，不用 `innerHTML`。列數不設上限（收合著，SPEC 註記）。
- **單位選字不新增第六份**：處置欄文字不含單位；標題欄名只依軸選「列標題／欄標題」。

### 改動（階段）

**B-1（`ui/picker/picker.html`、`ui/picker/picker.js`；測試 `tests/x3_test_detail.test.js`、`tests/m2_chain.test.js` 補 `items`）**
1. `<details>` 結構與樣式。
2. `handleTestNow` 成功／失敗兩條路都渲染明細（單值看 `res.items`，多值看 `res.fields[key].items`）；開始時清空。
3. `m2_chain` 補：content `handleExtract` 回覆 → `fetcher` dryRun 回傳 → Picker 表格列數與 `data-use`，一路斷言。

（`items` 的產生在 A-1。）

### 測試／驗收

- A-1 的 x1 補：八態各至少一列的合成表（含 `inner` 解析不到、tfoot 進 `exclude`、中段空白、頭尾空白、head/tail 各 1）→ 逐列 `use` 正確，四條口徑不變式成立。**突變**：把 `skipHead` 與 `trimmed` 的判定順序對調要紅；把 `used` 的 `number` 改成 `raw` 字串要紅。
- 三種失敗回傳帶 `items` 且沒有一列是 `used`；「本來就沒有格子」不帶。
- `fetcher` 排程路徑：`appendRecords` 收到的紀錄沒有 `items`／`blank` 鍵（突變：把白名單改成展開 `...r` 要紅）。
- Picker：單值成功 → `#test-detail` 可見、列數＝`items.length`、summary 含格數、每列 `data-use` 與處置文字對應、`title` 是完整 `raw`；多值 → 兩個 `section`、各自標題；失敗（`not_found` 帶 `items`）→ 仍顯示；下一次測試開始即清空並 `hidden`；沒有 `items` 的結果（儲存格任務）→ 維持 `hidden`。
- `node --check`；`npm test` 只增不減；`tests/a4_conventions`（D14 無後門、色碼、`[hidden]`）照舊通過。

## 作業 C：文件與版本（Claude 親做）

- SPEC §7「略過頭尾 `skip` 與點選排除 `exclude`」段：加 `blank` 的判準、順序、`blank` 計數口徑、兩則訊息、`items` 形狀與四條不變式、「失敗也帶」、不進紀錄；§7 Picker 值清單段：勾選框、預設、回填、`<details>` 明細表；§2 tfoot 段加一句「頭尾空白是擷取端的 `skip.blank`，兩者互不取代」。
- BACKLOG 新增：「測試結果回頁面上色（採用／略過／排除三色）」、「明細表點一列設成略過起訖」、「ARIA／CSS 假表格的空白判準若與 `<table>` 不一致時」。
- CLAUDE.md：`skip` 的形狀多 `blank`、一律經 `skipOf`／`putSkip`；`items` 是預覽專用、`fetcher` 白名單不得抄；八態口徑不變式。
- `src/manifest.json` 與 `package.json` → 0.16.0。
- 體檢交接：全量 `npm test` 數字、與 2117 的差。

## 明確不做（本輪定案）

- tfoot 預設排除加開關（右鍵取消已夠用）。
- 依標題關鍵字排除合計列（BACKLOG 既有）。
- 空白格數進紀錄／歷史頁／匯出。
- 明細表點一列設略過（BACKLOG）。
- 測試結果回頁面上色（BACKLOG）。
- 立即測試對編輯既有任務開放（BACKLOG 既有）。
- `describe.js` 白話提及自動略過空白。

## 規劃完成後複檢

- **與既有設計的衝突**：SPEC §2「不在擷取端偷偷跳過 tfoot：使用者看不到、`count` 會少一筆卻沒人說」——本輪在擷取端剝空白格是否違反同一原則？不違反：空白格本來就不進 `count`（`parseNumber('')→null`），數值零變動；而且 `blank` 計數會在預覽說出來、明細表逐格看得到、Picker 有開關。SPEC 加一句說明兩者差別。
- **`skip` 的既有語意**：AF-16 定「`skip` 對著完整的表算」；本輪改成「先剝空白再算」——**推翻一半**，明寫在 SPEC：開著時對「去掉頭尾空白後的表」算、關著時不變。舊任務缺省＝關，零影響。
- **藏起 skip 列時規格不寫 `skip`**（位置定位）：`blank` 併在 `skip` 內自然一起不寫，不必另加守衛。
- **多值展開路徑 `delete block.skip` 再 `putSkip`**（`picker.js:149-150`）：`blank` 跟著整包重寫，舊值不殘留。
- **作業間衝突**：A-1 產出 `items`、B-1 消費；形狀在本文件定死，B-1 規格抄同一段。A-2 與 B-1 同檔，順序執行。
- **分母為零**：全空白清單 → 剝完為空 → 專屬 `not_found`；`items` 全 `trimmed`。
- **破壞性判準反例**：「空白」只認 trim 後空字串；`0`、`-`、`—`、`N/A` 都不是空白（是非數字），測試列進反例。
- **單向閘門**：無。
- **移除類**：無。
- 複檢完成，上述四點已寫進定案；無其他新增事項。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A-1 | agy gemini-3.8-flash-high | 一次過；只改兩個白名單檔 | x1 27 綠；突變 11 組全紅（剝空白與略過的順序、分類順序、number 型別、excluded 算法、blank 判準、putSkip 形狀、多值兩條白名單、只剝開頭、空白判準看 ok、全空白訊息）；全量 2144 中 1 紅 | agy 回報「fail 0」不實。紅的是 `v1_inner_extract` 守門測試裡第二段整欄結果的全等比對，多帶 `items` 是本輪定案的預期變化；普查只看到同一測試前三行的儲存格比對而漏掉。Claude 改測試為先斷言 `items` 有 9 格再剝掉比對，實作不動 |
| A-2 | agy gemini-3.8-flash-high | 一次過；只改兩個白名單檔、11 行 | x2 18 綠；突變 9 組 8 紅（收集不讀勾選框、藏起來仍帶、編輯不回填、預覽不說空白、預覽寫空白 0 格、HTML 不預設勾、單值重選不保回、多值重選不套）；全量 2162 中 3 紅 | 存活那組「比對時不剝 skip」是**等價突變**：`sameSpec` 先經 `pickSpecOf` 逐欄挑選，而它本來就不抄 `skip`，剝不剝結果相同，不補測試。3 紅都在 `w4_picker_skip`，原因只有「新建預設勾選，規格多帶 `blank:true`」，agy 依規格未改測試並如實列出。Claude 更新：兩條測頭尾數字判準的先取消勾選以保留原意，多值那條期望值補 `blank:true` |
| B-1 | agy gemini-3.8-flash-high | 一次過；只改兩個白名單檔、182 行 | x3 13 綠、m2_chain 鏈結綠；全量 2176 全綠；突變 12 組 11 紅（失敗不畫、開始不收合、多值不放名稱、欄名不依軸、處置文字對調、空陣列也顯示、內容不設 title、格數只算第一段、內容改 innerHTML、排除列不用警告色、試抓回傳丟掉 items） | 存活那組「畫表前不清空」是**等價突變**：`handleTestNow` 開始時已清空同一個容器，畫表函式裡那次清空是重複的，不影響結果。「試抓回傳丟掉 items」在實作前無法區分（鏈結測試本來就紅在畫面段），實作後重跑確認變紅。另有兩條「items 與 blank 不寫進紀錄」守門在實作前就綠，突變把兩份紀錄白名單改成夾帶後各多紅一條 |
| C | Claude | SPEC §2 表尾段、§7 略過段／擷取順序／結果欄位／Picker 值清單段；BACKLOG 三項；CLAUDE.md 兩條規則與基線；版本 0.16.0 | 文件腳本每處替換斷言恰好命中一次；慣例與版本守門 41 綠 | 腳本把 CLAUDE.md 寫成「AF-1~AF-17 已歸檔」太早，PLAN 要到收尾才搬 archive，已改回 AF-16 |

## 體檢交接

- **全量測試**：`npm test` 2176 綠、0 紅（基線 2117，+59）。版本號 0.16.0 只動兩個 JSON，未新增測試。
- **新增測試**：`x1_skip_blank` 27、`x2_blank_picker` 18、`x3_test_detail` 13、`m2_chain` +1。
- **Claude 改動的既有測試**（都是本輪定案的預期變化，實作未為測試遷就）：`v1_inner_extract` 守門第二段整欄比對先斷言 `items` 再剝掉比對；`w4_picker_skip` 兩條測頭尾數字判準的先取消預設勾選、多值那條期望值補 `blank:true`。
- **突變**：A-1 11/11 紅；A-2 9 組 8 紅（1 組等價）；B-1 12 組 11 紅（1 組等價）＋紀錄白名單 2 組紅。等價突變的理由見執行紀錄。
- **agy 表現**：三段都一次過、白名單無越界、無 BOM／CR／NUL。A-1 回報「fail 0」不實（實際 1 紅，是測試普查漏看）；A-2 如實列出 3 紅。
- **Git Bash 查 agy 額度要加 `MSYS_NO_PATHCONV=1`**，否則 `/quota` 被改寫成路徑、agy 當一般提示詞回答（本輪開工時踩到）。
- **終檢**：（兩份獨立檢查結果待填）
- **留給體檢者注意**：畫表函式開頭與 `handleTestNow` 開始各清空一次明細容器（重複但無害）；`classifyUse` 參數多達八個，若要收斂屬體檢取捨，不影響行為。
