# AF-8 第 8 輪規劃：表格模式進入規則、位置定位（第一／最後一筆）、iframe 前置步驟提示

> 狀態：全案完成，待體檢與併 dev（分支 `feature/AF-8`）
> 基準：dev@38f5b97（1558 綠，v0.6.0）
> 來源：使用者實測回饋五條（twse 市場成交資訊頁、巢狀表格監控頁）
> 委派：agy（`gemini-delegate`）；agy 沒額度時由 Claude 自己實作。整輪只用一種，中途切換註明起點。

## 回饋核對表

| # | 回饋 | 判定 | 根因 |
|---|---|---|---|
| P1 | 巢狀表格選不到內層 td，一直選到「tr」 | ✅ | 表格模式鎖在外層表後 `resolveCell`（`content/picker-mode.js:103`）只認屬於目標表的格子，內層 td 往上找到的是外層 td（內容就是整張小表）。`↓` 回不去（`backStack` 空）。AF-7 定案「格子歸屬以目標表格為準」（SPEC §2）的副作用 |
| P2 | 右上角三段工具列點不動 | ✅ | `onMouseMove`（`picker-mode.js:1067`）把原始 `event.target` 直接當目標；停在 td 上時 `detectKind(td)` 判成「數值」，`updateToolbar`（`:308`）因非表格把三段全停用。表格模式只在目標**就是**表格元素時啟動，所有測試都用 `initialTarget: table` 進入，沒有一條測「滑鼠移到格子」 |
| P5 | 選成交金額，名稱卻是左邊那格的數字 | ✅ | 同 P2：目標是 td，`computeNameHint`（`:597`）對非表格回 `undefined`，Picker（`ui/picker/picker.js:495`）退到 `locator.anchor.text` |
| P3 | 進 iframe 前應提示加前置步驟 | ⚠️ 需求成立、現況零支援 | 兩條路（iframe 內右鍵、`DESCEND_FRAME`）都把 `frameUrl` 帶進 Picker（`background/main.js:286`），Picker 沒有任何提示。「立即測試」沿用目前分頁（iframe 已開）會過，排程開新分頁才失敗 |
| P4 | 該列／該欄第一筆、最後一筆 | ⚠️ 新功能 | `spec.cell` / `spec.block` 只有 `index + header`（SPEC §7）；每天增長的表格用日期當 row header，隔天 `locateByHeader` 找不到就 `not_found` |

評估中另外抓到：

- **B1**：`extractBlockFromTable`（`shared/extract.js:216`）的 `row` 軸不用 `headerText`，只吃 index；SPEC §7 說「欄與列同一套規則」。整列聚合任務在表格前面新增一列後靜默抓錯列。本輪一併修（批次 C 的位置定位本來就要重寫這段）。
- **B2**：P2 修法若不分用途，前置動作／登入「點某個 td 當頁籤」的目標會被升成表格容器，locator 指錯。修法限定 `task` 與 `repick`。
- **B3**：「立即測試」對 iframe 任務在目前分頁必過，與排程行為分岔。本輪只在提示文字說明，改成「以新分頁測試」進 BACKLOG。

## 定案（與使用者討論後）

1. **位置定位選項**：列與欄各自可選「依表頭（現況）／第一筆／最後一筆／倒數第二筆」。
   第一筆 = 第一個資料列（欄），表頭列不算；倒數第二筆是因為最後一列常是合計。
   放 Picker 視窗「區塊」區，任務層級、多值任務全部值共用（與聚合方式同層級）；每個值各自設定進 BACKLOG。
2. **語意**：位置定位是為了每天在最前或最後新增一筆的表格，擷取時**每次重算**該位置。
   儲存格模式 `row` 用位置、`col` 仍可用表頭（成交金額 × 最後一列）；整欄／整列模式下位置定位取**那一格**（該欄 × 該位置列），不聚合。
3. **單值儲存格的預設任務名稱**：「欄標題」（例：成交金額）；只有列標題沒有欄標題時用列標題。
   多值任務維持任務名用 `nameHint`、每個值用「列標題 · 欄標題」；位置定位的值名稱用「欄標題（最後一列）」這種寫法，不放會變動的列標題。
4. **P3 提示時機**：Picker 開啟時（兩條進 iframe 的路都經過），不在鑽 iframe 那一刻。
5. **委派**：agy，沒額度 Claude 自己做。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 | 建議順序 |
|---|---|---|---|---|
| A | 表格模式進入規則：滑鼠停在格子 → 目標升為最內層表格（P1、P2、P5 根因） | 中，`picker-mode.js` + 測試 | 無 | 1 |
| F | 選取模式操作習慣（點選／雙擊確認／Ctrl 加選／Shift 範圍／點表頭選整欄列／完成取消鈕／狀態提示） | 大，`picker-mode.js` + 測試 + SPEC §2 | A | 2 |
| B | 命名規則：單值儲存格用欄標題、位置定位的值名 | 小，`picker.js` | C 的規格形狀 | 3 |
| C | 位置定位（第一／最後／倒數第二）：規格、擷取、Picker UI、預覽、preselect；順修 B1；Picker 視窗的說明文字與回饋 | 大，`extract.js` + `picker.js` + `main.js` + `picker-mode.js`（preselect） | 無 | 3 |
| D | iframe 前置步驟提示 | 小，`picker.js` + `picker.html` | 無 | 5 |
| E | 文件、版本 0.7.0、收尾 | 小 | A~D、F | 6 |

批次 B 的順序改為 4（在 C 之後）。

## UX 方針（`ui-ux-pro-max` 檢視結果）

以「瀏覽器擴充功能、生產力工具、深色注入層」查詢，採納與不採納如下：

- **採納**（對應資料庫的 UX 指引）：
  - 鍵盤可達與可見焦點：面板與工具列的按鈕都是真正的 `<button>`，`Tab` 走得到、`:focus-visible` 有焦點環（overlay 用 `element.style` 逐項設，焦點環在 `focus`/`blur` 事件上切換 `outline`）。
  - 互動回饋：可點的東西一律 `cursor: pointer`，格子上 `cursor: cell`；hover 有 100～150ms 的底色過渡；`prefers-reduced-motion` 時關閉過渡。
  - 可點高度至少 28px（既有）、面板按鈕間距 8px 以上。
  - 空狀態要給指引：面板沒有已選值時顯示「怎麼開始」，不是空白。
  - 提示可略過：教學提示只佔面板一行、不擋操作、不需要關閉。
  - 狀態要能被讀出：Picker 的 `#errors`、`#frame-hint`、測試結果用 `role="status"` / `role="alert"`。
  - 送出要有回饋：「立即測試」按下後按鈕進入停用＋「測試中…」，結果回來才恢復；儲存亦同。
  - 每個輸入都有可見標籤（位置定位下拉的 `<label for>`）。
- **不採納**：資料庫給的配色（teal／orange）與 Inter 字型。專案顏色唯一來源是 `ui/theme.css`，注入層只能引用 `COLORS` 常數；字型沿用 `inherit`，注入在別人的網頁上不載入外部字型。
- 未持久化 design-system 檔（專案已有自己的 token 來源，見 CLAUDE.md）。

## 批次 F：選取模式操作習慣（一般電腦操作習慣）

### 現況與核對結果

- 單格模式**點一下就送出**（`confirmPick`，`picker-mode.js:643`）；已選過的格再點 = 移除（`togglePick`）。
- `Shift` + 點 = 加選；拖曳 = 矩形框選（`onMouseUp:1325`）；`Shift` + 方向鍵四方向加選。
- 表頭格（`th`）不可點：`markCells` 對 `isHeaderCell` 不標示、`resolveCell` 只算資料列。
- 確認只有 `Enter` 與右鍵選單的「完成」；取消只有 `Esc` 與右鍵。面板沒有按鈕，只有文字提示（`updatePanel:470`）。
- 沒有 `dblclick` 監聽、沒有焦點樣式、沒有 `title` 提示、指標一律預設（只有按鈕 `pointer`）。
- 非表格元素：點一下也直接送出。

### 定案

**滑鼠語意（`purpose === 'task'`）**

| 操作 | 表格格子 | 非表格元素 |
|---|---|---|
| 點一下 | **選取這一格，取代**目前已選（已選清單變成只有它） | 鎖定這個元素（高亮停止跟隨滑鼠，面板顯示「已選：…」） |
| 再點同一格 | 維持已選（不移除） | 維持 |
| `Ctrl`＋點（macOS `Cmd`） | 加選／取消這一格 | 不適用（非表格一次一個） |
| `Shift`＋點 | 從**最後一個已選格**到這格的矩形範圍加選；沒有已選時同「點一下」 | 不適用 |
| 拖曳 | 矩形框選，累加（既有） | 無 |
| 雙擊 | 選取這一格並**送出** | 送出 |
| 點 `th`（表頭列） | 選取整欄（依目前工具列是「整欄」語意，即 `block.axis: 'col'`）；`Ctrl` 同樣加選 | 無 |
| 點 `th`（資料列第一格、`scope="row"` 或該列唯一的 `th`） | 選取整列 | 無 |
| 點空白處（不在任何表格與已鎖定元素上） | 不清空已選，只是換 hover | 解除鎖定，回到跟隨滑鼠 |

- `preaction`、`login-*`：**維持點一下即送出**（本來就只選一個），雙擊等同。
  `repick` **跟 `task` 同一套**：它會帶 preselect 進來、`applyRepick` 也吃多個 picks（SPEC §8.4），多值任務重選必須能 Ctrl 加選再完成；「repick 選一個就送出」這句 SPEC §2 舊文與 §8.4 矛盾，本輪以 §8.4 為準改寫。
- iframe 代理層：**點一下即鑽入**（那是導覽不是選取），不套「先選再確認」。
- **快速路徑保留**：已選清單空、滑鼠停在某格時按 `Enter` = 選那一格並送出（鍵盤使用者不必先點）；面板「完成」鈕沒有 hover 可用，維持停用。
- 非表格「鎖定」狀態下 `↑`／`↓` 照常運作並維持鎖定（鎖定的是「不跟隨滑鼠」，不是凍結目標）。
- `Ctrl`＋`Z` 等同「移除最後一項」（`Backspace` 的別名，同樣清單空時不攔）。
- 提示文字裡的修飾鍵寫成「Ctrl／⌘」。
- 工具列三段仍在，語意不變：決定 hover 標示範圍與「點一下」選的單位（單格／整欄／整列）。點 `th` 是捷徑，不改工具列的模式。
- 已選上限維持 `maxPicks`；到上限時點格子不送出、面板提示（既有）。

**鍵盤**

- `Enter` 送出、`Esc` 取消（既有）；`Ctrl`＋`A`：目標是表格時全選該表所有資料格（受上限截斷並提示）。
- `Shift`＋方向鍵：從目前格延伸範圍（既有行為保留）。
- `Tab`：**實作時降級**——`Tab` 維持只循環工具列三段（既有行為，五個測試檔依賴），
  「`Tab` 走到面板按鈕」進 BACKLOG。改為修真正的根因：`mousedown` 原本對 overlay 自己的按鈕也
  `preventDefault`，按鈕因此永遠拿不到焦點、焦點環是死規則；現在按鈕點得到焦點。
  `Enter` 落在面板按鈕上時**不**當成「送出」（這條有做）。
- `Backspace` 移除最後一項（既有）。

**面板（右下角）**

- 底部固定兩個按鈕：主色「完成」＋ 次要「取消」，完成鈕文字帶已選數：「完成（3 個值）」；沒有已選且目標非表格時是「完成（這個元素）」；沒有已選且目標是表格時「完成」停用（`aria-disabled`），提示「先點一格」。
- 面板依狀態換一行提示（只一行，不擋操作）：
  - 沒選、目標表格：「點一格選取 · Ctrl 加選 · Shift 範圍 · 拖曳框選 · 點表頭選整欄」
  - 已選 ≥1：「雙擊或 Enter 完成 · Ctrl 點可取消 · Backspace 移除最後一項」
  - 非表格：「點一下鎖定這個元素 · 雙擊或 Enter 完成 · ↑ 放大 ↓ 縮小」
  - iframe 代理層：既有文案。
- chip 清單、「移除最後一項」既有；chip 的 × 鈕有 `title="移除"`。

**指標與 hover**

- 表格資料格 `cursor: cell`、`th` 上 `cursor: pointer` 並帶 `title="選整欄"`／`"選整列"`（以 `title` 提示，不另做 tooltip 元件）；非表格 `cursor: crosshair`。
  離開選取模式一律還原（既有 `originalUserSelect` 的做法擴到 `cursor`：只在 `body` 設一次，`exitPickMode` 還原）。
- 待選標示（黃）→ 已選標示（主色）切換用 100ms 過渡；`matchMedia('(prefers-reduced-motion: reduce)')` 為真時不設 `transition`。

**與批次 A 的關係**：A 決定「什麼時候進表格模式」，F 決定「進了之後怎麼點」。F 依賴 A（點 td 要先能進表格模式）。

**SPEC §2 改寫**：「點擊即確認」段、「點一個已選過的格 = 移除」段、`Shift` 加選段全部改為上表；「面板是可互動的已選清單」補「完成／取消」鈕；鍵盤清單補 `Ctrl+A`、`Tab` 範圍。

### 改動

1. `content/picker-mode.js`：`onClick` 改為選取語意、新增 `dblclick` 監聽（capture、`preventDefault`）、`th` 判定、`Ctrl`/`Shift` 分流、非表格「鎖定」狀態（新狀態一律進 `exitPickMode` 重設）、面板按鈕與提示、焦點環、指標、過渡。
2. `docs/SPEC.md` §2。
3. 既有測試改寫：`b4_pick_mode`、`p3_pick_toolbar`、`l7_batch_b3`、`b6_pick_wiring`、`m2_chain` 中所有「點一下就送出」的案例改為「點一下＋Enter」或雙擊。

### 測試 / 驗收（新檔 `tests/q4_pick_habits.test.js`）

- 點一格 → `selectedList` 長度 1、**沒有**送出 `PICKED`；再點另一格 → 仍長度 1 且是新格；`Ctrl`＋點第三格 → 長度 2；`Ctrl`＋點已選 → 移除。
- `Shift`＋點：先點 (0,0)，`Shift` 點 (2,2) → 9 格，順序列優先。
- 雙擊 → 送出 `PICKED` 且 `picks` 含那一格；`repick` 用途點一下即送出（不變）。
- 點表頭列 `th` → `picks[0].block.axis === 'col'` 且 `headerText` 正確；點資料列的 `th` → `axis: 'row'`。
- 非表格：點一下鎖定（滑鼠移到別處目標不變）、點空白解鎖、雙擊送出。
- 面板：無已選＋表格 → 完成鈕 `aria-disabled`；選 3 格 → 文字含「3」；點完成 → 送出；點取消 → `PICKED{cancelled:true}`。
- `Ctrl+A` 在 3×3 表 → 9 格；在 `maxPicks: 5` 下 → 5 格且面板含「上限」。
- ~~`Tab` 從工具列最後一段 → 焦點到「完成」鈕~~（降級進 BACKLOG，見上）；
  改驗：overlay 自己的按鈕 `mousedown` 不得被 `preventDefault`（否則拿不到焦點）、
  頁面上的 `mousedown` 仍要擋、焦點停在「取消」鈕上按 `Enter` 不得送出。
- 指標：進入後表格格子 `cursor` 為 `cell`、`th` 有 `title`；`exitPickMode` 後 `body.style.cursor` 還原為原值。
- reduced-motion：`matchMedia` 替身回 `matches: true` → 標示元素 `style.transition` 為空。
- 突變：把 `onClick` 改回直接 `confirmPick` → 第一條必紅；把 `Ctrl` 判定拿掉 → 加選案必紅。
- 連續兩次選取不殘留：第一次鎖定非表格元素後 `exitPickMode`，第二次進入不處於鎖定。
- preselect 取代確認：帶 3 個 preselect 進入，點一格 → 清單仍 3 個且面板含「將取代」；再點同一格 → 清單變 1。
- 拖曳框選放開後 200ms 內的 `dblclick` 不送出。

## 批次 A：表格模式進入規則

### 現況與核對結果

- `onMouseMove`（`picker-mode.js:1067~1087`）：目標表格已存在且包含 `target` 時走 `handleTableMouseMove`，否則 `setTarget(target)` 原樣。
- `setTarget`（`:495`）只用 `tableOf(el)` 判斷「是否換表清空」，不升級目標。
- `enterPickMode`（`:1446`）`setTarget(opts.initialTarget)`，右鍵預選（`content/main.js:186`）記的是原始元素，同樣不會進表格模式。
- `↑`（`:1136`）走 `parentElement`，`↓` 走 `backStack`。
- `pickedTableEl` 規則：已選值後滑鼠移到另一張不相關的表才清空，巢狀（互相包含）不清。

### 定案

- **升級規則**：`purpose` 為 `task` 或 `repick` 時，目標元素是儲存格（`CELL_SELECTOR`）或在儲存格內（文字節點的包裝、`<a>`、`<span>`）→ 目標升為 `tableOf(那個儲存格)`，即**最內層**表格；`hover` 的格子就是那個儲存格。
  表格元素本身、`tbody`、`tr` 進來時也升為所屬表格。`preaction`、`login-*` 維持原始元素（B2）。
- **巢狀**：目標表格 T 已鎖定、滑鼠停到 T 內部另一張表 S 的格子時：
  - `selectedList` 空 → 目標切到 S（內層優先，P1 的情境）。
  - `selectedList` 非空且 `pickedTableEl` 是 T → 維持 T，格子歸屬以 T 為準（AF-7 規則保留，避免 A 表索引配 B 表定位）。
- **`↑` 從內層表**：沿 `parentElement` 走到外層 td/tr/tbody 時，同樣套用升級規則，所以按一次 `↑` 直接到外層表格，不會停在 td；`↓` 沿 `backStack` 回內層表。到 `body` 停住（不變）。
- **右鍵預選**：`initialTarget` 同樣過升級規則，右鍵在格子上進來就是表格模式、hover 格子已標示。
- `kindOf` 快取、`exitPickMode` 重設清單不變；新加的狀態（若有）一律加進 `exitPickMode`。
- SPEC §2「滑鼠移到某一格時標示範圍跟著模式走」改寫為「滑鼠停在格子上即進入該表格的表格模式」，並補巢狀規則；AF-7 的「格子歸屬以目標表格為準」限縮為「已有已選值時」。

### 改動

1. `content/picker-mode.js`：新增「目標升級」判定（一份函式，`onMouseMove`、`setTarget` 入口、`↑` 共用），依 `currentPurpose` 分流。
2. `docs/SPEC.md` §2 對應段落。

### 測試 / 驗收（新檔 `tests/q1_table_entry.test.js`）

- 滑鼠 `mousemove` 到一般表格的 td：目標是 `<table>`、三段工具列無 `aria-disabled`、該 td 帶 `data-af-cell`、`confirmPick` 送出的 `picks[0].cell` 索引正確、`nameHint` 有值。
- 滑鼠移到 td 內的 `<span>`：同上。
- 巢狀：外層表每列一格包小表。移到內層 td → 目標是內層表，`preview` 是那一格的文字（不是整張小表的串接）；按 `↑` → 目標是外層表；`↓` 回內層表。
- 巢狀 + 已選：先 Shift 選外層表一格，再移到內層 td → 目標仍是外層表，選到的是外層 td。
- `purpose: 'preaction'` 移到 td → 目標仍是 td（`isTableMode` 假）。
- 右鍵預選 `initialTarget: td` → 進入即表格模式。
- 連續兩次選取（第一次巢狀內層、`exitPickMode`、第二次一般表）不殘留。
- 突變：把升級判定改成永遠回原元素 → 上述第一條必紅。
- 既有 `p3_pick_toolbar`、`b4`、`l7` 全綠。

## 批次 C：位置定位（第一／最後／倒數第二）

### 現況與核對結果

- 規格形狀（SPEC §7）：`cell = { row: {index, header}, col: {index, header} }`、`block = { axis, index, headerText, aggregate }`。
- `locateByHeader`（`extract.js:147`）：header 空 → 直接用 index；非空 → 找不到就 `not_found`。
- `extractBlockFromTable`（`:216`）row 軸不看 header（B1）。
- Picker：`#block-section` 內只有 `#block-summary` 與 `#block-aggregate`（`picker.html:197`）；`buildSpec` 組規格；`buildTask` 存任務。
- preselect：`preselectOf`（`main.js:85`）從任務規格組 `picks`，`applyPreselect`（`picker-mode.js:~990`）以表頭勾回；`applyRepick`（`main.js:47`）重選後覆寫 `spec.block` / `spec.fields`。
- 預覽：`getCellText`／`getBlockPreview`（`picker-mode.js:610`）。

### 定案

- **規格形狀**（暫定，執行端可依實作事實調整並回報）：軸物件加 `pos`，值 `'first' | 'last' | 'last-1'`；有 `pos` 時 `index`／`header` 可缺省、擷取時不看。
  - 儲存格：`cell.row = { pos: 'last' }`、`cell.col = { index, header }`。
  - 整欄／整列：`block = { axis: 'col', index, headerText, pos: 'last' }` = 該欄 × 最後一列那一格；`axis: 'row'` + `pos` = 該列 × 該位置欄那一格。**有 `pos` 時不聚合、`aggregate` 忽略**。
  - 多值 `spec.fields[].cell` 同形狀。**位置是任務層級設定**：Picker 儲存時把同一個 `pos` 寫進每一個值的對應軸（規格本身每軸各自帶，執行端不需要另存任務層級欄位）。
- **擷取語意**：以 `parseTable` 的資料列（已排除表頭列）為準，`first` = 索引 0、`last` = 最後、`last-1` = 倒數第二；資料列不足（`last-1` 但只有 1 列）→ `not_found`。欄軸同理，以該列的格數為準。
  取到的格子空字串或解析不了 → `parse_error`（不往前找非空格，使用者要的就是那個位置）。狀態一律 `ok`（位置定位沒有備援概念）。
- **B1**：row 軸的整列聚合改走 `locateByHeader`（表頭對得上照用、搬家跟著走並 `fallback`、不見 `not_found`），與 col 軸同一份。
  表頭找不到時的 `error` 文字帶標題與解法：「列標題『115/09/07』找不到；若這張表每天新增一列，請改用位置定位」（欄軸同理）。
- **紀錄可追溯**：儲存格與位置定位的紀錄新增 `label`（暫定名）：列軸用位置時 = 那一列的列標題，欄軸用位置時 = 那一欄的欄標題，兩軸都用位置時「列 · 欄」；依表頭定位時不寫（規格裡已有）。
  Report 歷史頁的數值 `title` 顯示「來源列：…」。多值任務每個值各自帶。
- **Picker UI**：`#block-section` 加兩個下拉 `#row-pos`「列定位」與 `#col-pos`「欄定位」，選項「依表頭／第一筆／最後一筆／倒數第二筆」，預設「依表頭」。
  進入時若使用者點的格子就在最後一個資料列，`#row-pos` 自動帶「最後一筆」並在 `#block-summary` 說明「你選的是最後一列，已改為每次取最後一筆；若那是合計列請改倒數第二筆」；第一列同理帶「第一筆」。點在中間列不自動帶。
  整欄／整列模式（`block.axis`）同樣顯示；`pos` 非「依表頭」時聚合下拉隱藏（一格不用聚合）。
  編輯既有任務時從規格回填（多值取第一個值的 `pos`）。
- **`#block-summary` 與即時預覽**：文字寫成「表格，取「成交金額」× 最後一列」；「立即測試」走 background 真擷取，不另算。
- **Picker 視窗的說明與回饋（UX 方針落地）**：
  - 兩個下拉各有 `<label for>`，下方一行說明文字（次要色）：「表格每天在最後加一列 → 選最後一筆；最後一列是合計 → 選倒數第二筆」；選「依表頭」時說明改為「以你點的那一列的標題定位；標題會變（例如日期）時請改用位置」。
  - 自動帶入時的提示放 `#block-summary`，`role="status"`。
  - 「立即測試」按下後按鈕 `disabled` 並改字「測試中…」，結果回來才還原；「儲存」按下後同樣停用直到寫入完成。`#errors` 加 `role="alert"`。
  - 預覽卡成功時 `data-state="ok"`（既有），失敗時錯誤文字緊貼預覽卡下方（既有 `#errors` 位置不動）。
- **preselect / repick**：`preselectOf` 原樣帶 `pos`；`applyPreselect` 收到帶 `pos` 的軸時以當下資料列算出索引再勾（不比對表頭）；`applyRepick` 保留原任務的 `pos`（重選只換位置與表頭，不洗掉使用者的定位方式）。
- **選取模式的預覽**：`getCellText`／`getBlockPreview` 對帶 `pos` 的規格算當下位置。
- 舊任務零遷移：沒有 `pos` 就是現況行為。

### 改動

1. `shared/extract.js`：位置解析一份函式（列與欄共用），`extractCellFromTable`、`extractBlockFromTable` 接上；B1。
2. `ui/picker/picker.html` + `picker.js`：兩個下拉、自動帶入、摘要文字、`buildSpec` 寫入每個值、回填。
3. `background/main.js`：`preselectOf`／`applyRepick` 保留 `pos`。
4. `content/picker-mode.js`：`applyPreselect`、預覽函式支援 `pos`。
5. `docs/SPEC.md` §7 規格形狀與語意、§2.1 Picker 說明。

### 測試 / 驗收（`tests/q2_position.test.js` + 既有 `c5_block_extract` 補案）

- 五列表格（含 thead）：`row.pos` 為 `first`／`last`／`last-1` 各取到正確列；再插一列到最前與最後，同一規格取到的仍是「位置」上的值。
- `last-1` 在只有一列的表 → `not_found`；`last` 那格是空字串 → `parse_error`。
- `col.pos: 'last'` × 列表頭：表格右邊多一欄後仍取最後一欄。
- 整欄 + `pos: 'last'`：只回那一格、`aggregate: 'sum'` 被忽略、`used` 為 1。
- B1：整列聚合 `headerText` 對得上原索引 `ok`；列搬家 `fallback` 且值正確；表頭不見 `not_found`。突變：把 row 軸的 `locateByHeader` 拿掉 → 搬家案必紅。
- Picker：點最後一列進入 → `#row-pos` 值 `last`、摘要含「最後一列」；點中間列 → `depending`；儲存後 `task.spec` 每個值的 `row.pos` 都是 `last`；`pos` 非依表頭時 `#block-aggregate` 隱藏；編輯既有帶 `pos` 的任務回填正確。
- preselect：任務 `row.pos: 'last'` 開重選 → 勾在最後一個資料列；repick 後 `pos` 仍在。
- 鏈結測試（`tests/m2_chain.test.js` 補）：`pos` 從 `PICKED`→Picker→`buildTask`→`extractValue` 一路斷言；設定匯出再匯入後 `pos` 仍在。
- 錯誤文字：整列聚合表頭不見 → `error` 含該標題與「位置定位」字樣。
- `label`：`row.pos: 'last'` 擷取結果帶 `label` = 最後一列的列標題；`fetcher` 寫進紀錄；歷史頁該筆 `title` 含「來源列」；依表頭定位的紀錄沒有 `label`。

## 批次 B：命名規則

### 現況與核對結果

- 單值：`picker.js:495` `nameHint` → `anchor.text` → 預覽前 20 字。
- 多值（`:555`）：`列標題 · 欄標題`，同名加序號。

### 定案

- 單值且規格是儲存格：任務名稱預設 = 欄標題；欄標題空 → 列標題；兩者皆空 → `nameHint` → 現有退路。
- 單值整欄／整列聚合：維持 `nameHint`（整張表的聚合，表名比較貼切）。
- 多值：任務名 `nameHint`；值名 `列標題 · 欄標題`；該軸帶 `pos` 時改用固定字：`first`「第一列」、`last`「最後一列」、`last-1`「倒數第二列」（欄軸同理），例「成交金額（最後一列）」。
  名稱在 Picker 開啟時算一次；之後使用者改 `#row-pos` 不重算已填的名稱（使用者可能已手改）。

### 測試 / 驗收（併入 `q2_position.test.js`）

- 單值儲存格 ctx（有 `nameHint`、`anchor.text`）→ `#name` 是欄標題。
- 單值整欄 → `#name` 是 `nameHint`。
- 多值 + `pos: 'last'` → 值名含「（最後一列）」且不含列標題。

## 批次 D：iframe 前置步驟提示

### 現況與核對結果

- Picker 收到 `ctx.frameUrl`（`main.js:286` 的 `frameIdentityOf`）只用來寫 `task.frame`（`picker.js:1265`）。
- 前置動作區在 `#advanced-section`（預設收合）內，`#preaction-add` 新增一列，「在頁面上選取」從最上層開始（`:1123`）。

### 定案

- 新任務且 `ctx.frameUrl` 存在且沒有前置動作 → `#advanced-section` 自動展開，前置動作區上方顯示提示區塊 `#frame-hint`（`role="status"`）：
  「目標在框架（<主機名>）內。若這個框架要先點頁籤或按鈕才會出現，請加入「點元素」前置動作；排程抓取是開新分頁，不會沿用你現在看到的畫面。」
  按鈕「加入點擊步驟」= 新增一列 `click` 並立刻觸發「在頁面上選取」；「不需要」隱藏提示。
- 編輯既有任務不顯示（使用者已經決定過）。
- 立即測試結果為成功且 `frameUrl` 存在、仍沒有前置動作時，預覽卡下方加一行「此測試在目前分頁執行；排程會開新分頁」（B3 的最低限度提醒）。

### 測試 / 驗收（`tests/q3_frame_hint.test.js`）

- ctx 有 `frameUrl`、無 task → `#frame-hint` 可見、`#advanced-section` 開啟；按「加入點擊步驟」→ `#preaction-list` 多一列 `click` 且送出了 `purpose: 'preaction'` 的 `ENTER_PICK`（`frameId: 0`）。
- ctx 無 `frameUrl` → 隱藏；ctx 有 task → 隱藏。
- 「不需要」→ 隱藏且不影響儲存。

## 批次 E：文件與收尾

- `docs/SPEC.md` §2、§2.1、§7、§8.3（歷史頁 `label`）；`docs/BACKLOG.md` 加「每個值各自的位置定位」「立即測試以新分頁執行」「位置定位的其他偏移」。
- `README.md` 快速上手一節改寫成新的操作語意（點選／Ctrl／Shift／雙擊或 Enter／點表頭），加「升級注意：整列聚合任務改以列標題定位」。
- 版本 `0.6.0 → 0.7.0`（`src/manifest.json` 與 `package.json`）。
- 煙霧測試 `tests/smoke/load.mjs` 加真實滑鼠情境：`page.mouse.click` 一格 → 面板含「1」且 background 沒收到 `PICKED`；`dblclick` → 收到 `PICKED` 且 `picks` 長度 1。
- 全量測試、`run_smoke.sh`、體檢交接；驗收逐條 grep：每條定案在 SPEC 與（使用者可見的）README 都找得到。
- 批次順序：A → F1 → C → B → D → F2 → E，每批獨立 commit。

## 明確不做（本輪定案）

- 每個值各自的位置定位（進 BACKLOG）。
- 「立即測試」以新分頁執行（進 BACKLOG，本輪只提示）。
- 位置定位的其他偏移（倒數第三筆以後）：三個選項夠用，需要時把 `pos` 擴成 `{from, offset}`。
- 選取模式從 iframe 往上回父頁面（BACKLOG 既有）。
- 選取模式的首次使用導覽（多步驟 tour）：面板一行狀態提示夠用，多步導覽會擋操作，`ui-ux-pro-max` 也列為反模式。
- 自訂 tooltip 元件：`th` 與 chip 用原生 `title`。
- 面板可拖曳（BACKLOG 既有）。
- 採用 `ui-ux-pro-max` 給的配色與字型（與專案 token 唯一來源衝突）。

## 規劃完成後複檢

- 與既有設計衝突：AF-7「格子歸屬以目標表格為準」被限縮為「已有已選值時」，SPEC §2 同步改寫（批次 A）。「換表才清空」規則不變，巢狀互相包含仍不清。
- 批次間：C 的規格形狀（`pos`）是 B 與 D 之外唯一跨批次介面；B 依 `pos` 取名，需在 C 之後。A 改的是進入表格模式，與 C 的 `applyPreselect` 都動 `picker-mode.js`，順序 A→C 不衝突。
- 單向閘門／破壞性判準：無。「什麼算一個」：資料列以 `parseTable` 排除表頭列後為準，與 `getDataRows` 一致；`last-1` 列數不足回 `not_found` 已寫。
- 升級路徑：舊任務沒有 `pos` 零遷移；`applyRepick` 保留 `pos` 已寫。
- 批次 F 與既有設計的衝突（本輪推翻）：SPEC §2「點擊即確認」「點已選過的格 = 移除」「`Shift`＋點 = 加選」三條被上表取代，理由是對齊 Excel／檔案總管習慣；`repick`／`preaction`／`login-*` 不變。
  「面板上的點擊不得落到 `confirmPick`」規則仍成立，新加的「完成」鈕是**明確呼叫**，不是落穿。
  拖曳放開補的 `click` 要吃掉（`suppressClick`）規則不變，且 `dblclick` 也要在拖曳後被吃掉（拖曳結束的 `mouseup` 之後 200ms 內的 `dblclick` 忽略，暫定值）。
- F 與 A 同檔：A 先做（進入規則），F 在其上改點擊語意；F 改寫的既有測試清單已列。
- F 與 C：C 的 `applyPreselect` 勾回已選值後，F 的「點一下取代」會把預選整批換成一格——編輯既有多值任務重選時使用者容易誤清。定案：`Ctrl`／`Shift` 不受影響；**點一下取代前，若已選清單來自 preselect 且 ≥2，面板先提示「將取代 N 個已選值，再點一次確認」**（第二次點同一格才取代）。列入 F 驗收。
- 複檢完成，補了「B2 用途分流」「`↑` 過升級規則」「拖曳後的 dblclick」「preselect 取代確認」四條，無其他新增事項。

## 四角度複檢（整體專案／程式／尖銳使用者／管理者）

已併入各批次的定案，這裡只記「複檢才發現」的項目與處置：

**整體專案**

1. `repick` 的語意矛盾（SPEC §2 vs §8.4）：F 改以 §8.4 為準，見批次 F。
2. **B1 是既有任務的行為變更**：現有整列聚合任務存了 `headerText`（列標題），以前擷取只吃 index，改走 `locateByHeader` 後「列標題變了」會從靜默抓錯列變成 `not_found`。這是正確方向，但要在 SPEC §7 與 README 升級注意寫明，並讓錯誤訊息指向解法：`not_found` 的 `error` 文字帶「列標題『…』找不到；若這張表每天新增一列，請到任務設定改用位置定位」。列入 C 驗收。
3. 設定匯出入（`shared/settings-io.js`）不白名單化 `spec`，`pos` 原樣通過，不需改；列入 C 的鏈結測試（匯出再匯入後 `pos` 仍在）。
4. 位置定位對**虛擬捲動表格**（`partial: true`）取的是「當下渲染的最後一列」不是真正最後一列：SPEC §7 註明，紀錄本來就會標 `partial`、燈號轉黃，不另做。
5. 預檢（§4.2）只走 `RESOLVE_LOCATOR` 判定容器存在，位置定位不影響預檢；不改。

**程式面**

6. 拖曳後 `dblclick`、preselect 取代確認：已補進 F。
7. 位置定位取到的值要能追溯是哪一列：紀錄新增 `label`（暫定名）= 該位置那一列的列標題（欄軸位置則是欄標題），Report 歷史頁的數值 `title` 顯示它。每天 09:30 網站還沒更新時抓到的是昨天那列，使用者從 `label` 看得出來，不會以為抓錯；「值未變化時不寫紀錄」維持在 BACKLOG。列入 C 定案與驗收（`fetcher` 寫入 → 歷史頁顯示的鏈結 grep）。
8. 「第一筆」在表頭列用 `td` 排的表格會取到表頭：`isHeaderRow` 只認 `thead` 或整列 `th`。不擴判準（會誤殺資料列），靠 Picker 自動帶入時的即時預覽讓使用者看到值不對；SPEC 註明。
9. `Ctrl`＋`A`、`Ctrl`＋`Z` 只在目標是表格／清單非空時 `preventDefault`，不搶頁面輸入框的快捷鍵（與 `Backspace` 同一原則）。

**尖銳使用者**

10. 「我點了一格什麼都沒發生」：面板完成鈕帶數字、格子變主色、提示換成「雙擊或 Enter 完成」，三處同時給回饋；README 快速上手一節同步改寫（目前寫的還是「滑鼠移到某一格會標示整欄、點一下就選定」，已經不對）。
11. 「為什麼進 iframe 要雙擊」：代理層維持點一下即鑽入。
12. 「鍵盤黨以前 hover＋Enter 一步到位」：快速路徑保留。
13. 「Excel 的 Shift 範圍以作用中儲存格為錨」：以最後一個已選格為錨，面板提示寫「Shift 從上一格拉範圍」。
14. 「你們把行為改了但沒有開關」：不做開關（兩套點擊語意等於兩份程式），改以**F 獨立 commit** 便於整批回退，且本輪版本升 0.7.0 讓變更看得出來。

**管理者**

15. 本輪規模大（五個實作批次、F 要改五個既有測試檔）：F 拆成 **F1 語意與面板按鈕**（必做）與 **F2 指標／焦點環／過渡／title**（可延後），F2 獨立階段、獨立驗收，時間不夠可留到下輪而不影響 F1。
16. 煙霧測試目前只驗 overlay 進出，不驗點擊：E 加一段真實滑鼠情境（puppeteer `page.mouse.click` 一格 → 沒有 `PICKED`；`dblclick` → 有），否則 F 的核心行為只有 jsdom 證據。
17. 文件：SPEC §2 幾乎整段改寫、§7 加位置定位、README 快速上手改寫、BACKLOG 三項；E 的驗收要逐條 grep（定案 → SPEC → README）。
18. 順序與可中止點：A → F1 → C → B → D → F2 → E；每個批次結束都是可併回的狀態。

## 執行紀錄

> agy 額度用盡（重置需 67 小時），依定案由 Claude 自己實作。整輪同一個執行者。

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A 表格模式進入規則 | Claude | `5c36ff2`，1567 綠 | `q1_table_entry` 9 條 + 突變（升級判定改成回原元素 → 7 紅） | AF-7 的 `p1_nested_cell` 兩條測的正是本輪要修的行為，依定案改寫並補「`↑` 仍可回外層」一條 |
| F1 選取模式操作習慣 | Claude | `ce56772`，1597 綠 | `q4_pick_habits` 27 條 + 三個突變（點一下直送 15 紅、Ctrl 不加選 7 紅、點表頭不選整欄 3 紅） | 實作時發現 `confirmPick` 對所有非 `task` 用途截斷 picks，與 SPEC §8.4 矛盾（規劃已預期，以 §8.4 為準）；連帶改 `b4`/`l7`/`p3`/`p5` 四個既有測試檔 |
| C 位置定位 + B1 | Claude | `f54cb65`，1627 綠 | `q2_position` 16 條 + 突變（倒數第二＝最後一 2 紅、整列不看列標題 2 紅）、`q5_picker_position` 18 條、`m2_chain` 兩條鏈結 | 規劃寫「點到第一／最後一列自動帶位置」，實作發現會誤判一般表格（兩列的匯率表點第一列 = 美金），改成只給建議不動設定；連帶補「改定位方式時重算未手改的名稱」 |
| B 命名 | Claude | 併入 `f54cb65` | `q5_picker_position` P-6 四條 | 無 |
| D iframe 前置步驟提示 | Claude | `e0b65ae` | `q3_frame_hint` 8 條 | 提示原訂放 `#errors`，那是紅色錯誤區，改用獨立的 `#test-note`（`role="status"`） |
| F2 指標／焦點環／過渡 | Claude | 併入 `e0b65ae`，1643 綠 | `q6_pick_affordance` 6 條 | 無 |
| E 文件與版本 | Claude | `e1a35f6` | 煙霧測試 Chrome + Edge 全過（含新增的真實滑鼠情境） | 煙霧的 `ElementHandle.click` 逾時（它會先呼叫頁面函式捲動進畫面），改用座標驅動滑鼠 |
| 終檢自查 | Claude | `2d249e4`，1647 綠 | `q5_picker_position` P-7 四條 | 整欄設「欄定位」不進規格卻藏掉聚合下拉＝藏掉一個還在生效的設定；同一軸的定位改為停用並說明 |
| 併回前終檢（兩份獨立審查） | Claude | `e5b1594`，1656 綠 | 見下方「終檢發現與處置」 | 兩份審查共 20 項，18 項修掉、2 項降級進 BACKLOG |

### 終檢發現與處置

程式碼審查（高）：
1. 「標題找不到，請改用位置定位」的訊息**無人消費**——刪掉整個函式測試全綠。已把 `message`
   一路帶到多值分支、紀錄的 `error` 與立即測試，並補 `q7_label_records` 與突變驗證。
2. `label` 只驗到 `extractValue` 為止，**紀錄與畫面兩端零訊號**。已補四條測試（單值、多值、
   訊息寫入、歷史頁 `title`），突變確認會紅。

程式碼審查（中）：`markTitle` 會永久覆蓋網頁自己的 `title`（改成記錄原值還原，並補測試——
第一次突變沒被抓到就是因為少了這條）、點在表格縫隙會鎖住整張表（改成什麼都不做）、
解除鎖定的 `setTarget` 漏 `upgradeTarget`、單值與多值命名規則不一致、重選新增的值沒有位置概念、
`applyPositionDefaults` 呼叫順序與註解相反。

程式碼審查（低）：三處死碼與多餘匯出已清；兩條測試品質問題（一條任何實作下都會過、
四處對空集合的斷言）已補守衛。

**未採納 1 項**：審查建議「整列聚合的標題找不到時退回原索引並標 `fallback`」。不採納——
那正是本輪要消滅的「安靜地抓到別一列」；改為維持硬性失敗，但把取捨寫進 SPEC §7 與 README 升級注意。

**降級進 BACKLOG 1 項**：`Tab` 走到面板的「完成／取消」。`Tab` 循環選取單位是既有行為且被五個
測試檔依賴，改動範圍超出本輪；改為修真正的根因——`mousedown` 原本對 overlay 自己的按鈕也
`preventDefault`，導致按鈕永遠拿不到焦點、焦點環是死規則。現在按鈕點得到焦點，且焦點停在
按鈕上時 `Enter` 交給那顆按鈕（焦點在「取消」上卻送出是最容易踩的陷阱）。

文件審查：SPEC 兩處與新語意矛盾的舊句已改寫；PLAN 的執行紀錄當時是空的（現已補）；
其餘 20 餘條定案逐條核對一致。

## 體檢交接

- **全量測試**：`npm test` **1656 綠 / 0 紅**（上輪基線 1558，本輪 +98）。
- **煙霧測試**：`./run_smoke.sh` Chrome for Testing 152 與 Edge 皆全部通過，含本輪新增的
  「真實滑鼠點一下只選取、雙擊才送出」情境；終檢修正後**再跑一次**，兩個瀏覽器仍全數通過。
- **版本**：`0.6.0 → 0.7.0`（`src/manifest.json` 與 `package.json` 已同步，`a4_conventions` D3b 綠）。
- **分支**：`feature/AF-8`，8 個 commit，尚未併 dev。
- **本輪推翻的既有定案**（併回時要一起看）：
  1. AF-7「格子歸屬一律以外層目標表格為準」→ 改為預設取內層，外層走 `↑`（SPEC §2）。
  2. SPEC §2「點擊即確認」「點已選過的格＝移除」「`Shift`＋點＝加選」→ 改為試算表語意（SPEC §2 表格）。
  3. SPEC §2「`purpose !== 'task'` 時 `col`/`row` 停用」→ `repick` 不在此列，與 §8.4 對齊。
  4. 整列聚合從「只吃 index」→ 跟著列標題走，既有任務行為會變（README 升級注意已寫）；
     刻意選擇「大聲失敗」而非退回索引，理由見終檢的「未採納 1 項」。
- **待實測**（jsdom 與煙霧都涵蓋不到的）：在真實的證交所頁面上，用「最後一筆」建一個任務，
  隔天確認抓到的是新的那一列且 `label` 顯示新日期。
