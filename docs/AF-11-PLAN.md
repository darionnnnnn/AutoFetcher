# AF-11 第 11 輪規劃：iframe 代理層讓路給疊在上面的頁面元素

> 狀態：實作完成，待收尾
> 基準：dev@b3e39c3（1834 綠，版本 0.9.0）
> 來源：使用者回報——設定前置動作、在頁面上選「要點的選單項目」時，滑鼠一從「投資先生」移向展開的選單，選單就收起來、藍框改框住整個內容區，選不到選單項目。
> 實作方式：Claude 自己做（單一機制、單一檔案，委派的拆段成本高於改動本身）。

## 根因（已核對）

- 前置動作的「在頁面上選取」一律從最上層開始（SPEC §2），`enterPickMode` 對頁面上每一個 `<iframe>` 貼一層代理
  （[picker-mode.js:392](../src/content/picker-mode.js:392) `buildFrameProxies`），`pointer-events: auto`、`z-index` 2147483646，
  蓋在**整個頁面的最上面**。
- 站台的內容區是 iframe，「投資先生」的下拉選單展開後疊在內容 iframe 上，而代理層又疊在選單上。
  滑鼠往下移時命中的是代理層：瀏覽器對選單的 `li` 派 `mouseout` → 站台 JS 收合選單；
  同時 `onMouseMove` 把目標指到代理層 → 藍框框住整個 iframe、面板顯示「框架 iframe」。
- 不限前置動作：`task`／`login` 在最上層選取時，任何疊在 iframe 上的東西（下拉選單、彈窗、sticky 標題）都指不到。
  BACKLOG 的「代理層隨版面重排更新」也是同一層的問題（位置在進入時算一次就凍住）。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 |
|---|---|---|---|
| A | 代理層改由堆疊順序讓開頁面元素（貼 body／z-index 跟著 iframe／沒有 z-index 時讓路） | `picker-mode.js` 一個機制 + 單元測試 | 無 |
| B | 真實瀏覽器煙霧：疊在 iframe 上的選單走得到、裸露 iframe 指得到 | `tests/smoke/load.mjs` 一段 | A |
| C | 文件與版本：SPEC §2、CLAUDE.md 豁免、BACKLOG 結案、0.10.0 | 文件 | A、B |

建議順序：**B 的探針先做**（見 B-0，驗證前提），再 A → B → C。

## 批次A：代理層讓路

### 現況與核對結果

- [picker-mode.js:392-414](../src/content/picker-mode.js:392)：進入時一次建好，`pointerEvents = 'auto'`，位置用當下的 `getBoundingClientRect` 算，之後不更新。
- [picker-mode.js:1462-1489](../src/content/picker-mode.js:1462) `onMouseMove`：overlay 內的元素一律跳過，代理層是唯一例外；代理層走 `upgradeTarget → setTarget`。
- [picker-mode.js:985-993](../src/content/picker-mode.js:985)：目標是 iframe／代理層時 `confirmPick` 改送 `DESCEND_FRAME`；[1756-1770](../src/content/picker-mode.js:1756) 點一下代理層即鑽入。
- [picker-mode.js:1590](../src/content/picker-mode.js:1590)：`↑` 從代理層走 iframe 的父層，`↓` 由 `backStack` 回到代理層——**鍵盤路徑不經過指標，代理層接不接事件都要能當目標**。
- overlay 與 highlight 本來就是 `pointer-events: none`（[2084](../src/content/picker-mode.js:2084)、[2089](../src/content/picker-mode.js:2089)），不是它們擋的。
- `exitPickMode`（[2166](../src/content/picker-mode.js:2166)）移除七個 document 監聽並拆 overlay；新增的監聽與狀態都要在這裡收。
- `CLAUDE.md:174`「不要用 `document.elementFromPoint`（jsdom 沒有，測不動）」是為 Report 的拖曳立的規則；
  `report.js:922` 已有一處帶 `?.` 守門的使用。
- `tests/o6_frame_proxy.test.js` 九條測試全用 `dispatchEvent` 直接打代理層——**jsdom 不做命中測試，`pointer-events` 改成 `none` 這九條照樣綠**，
  所以新行為必須直接斷言 `style.pointerEvents`，不能只靠事件流。

### 定案（B-0 探針推翻原方案後改定）

**B-0 探針的結論(真實 Chrome for Testing 實測)**:指標從頁面內容移進跨網域 iframe 時,
父文件收不到**任何**事件——`mouseover`、`mouseout`、`pointerout`、`mousemove` 全部沒有。
規劃時的 A-2「滑鼠踏上裸露的 iframe 才打開代理層」因此**不可行**,沒有任何進入訊號可用。
(第一次探針看到的 `mouseover: fr` 是指標首次進入整份文件造成的假象,加上「先移到頁面內容再移進 iframe」
就重現不出來。這正是把探針排在最前面的理由。)

改以**堆疊順序**為主要機制,讓路降為最後防線:

- **A-1 代理層貼在 `<body>` 底下,不放進 overlay**:overlay 的 `z-index` 是 2147483647 且自成堆疊脈絡,
  放進去的東西一定蓋過所有頁面內容,子元素自己的 `z-index` 完全無效。
- **A-2 `z-index` 跟著它代表的那個 iframe 走**(`getComputedStyle(frame).zIndex`,非數字取 `0`):
  蓋得住 iframe(定位元素勝過流內元素),但頁面把選單疊在 iframe 上時一定給了更高的 `z-index`,
  由選單勝出——**指標從頭到尾沒碰過代理層,站台收不到 `mouseout`,選單不會收**。這是主要機制。
- **A-3 讓路(最後防線)**:只靠 DOM 順序疊上來、沒有 `z-index` 的選單,代理層仍會贏。
  指標落在代理層上的那次 `mousemove`,暫時關掉代理層問一次 `document.elementFromPoint`,
  底下是頁面元素就把 `pointer-events` 收成 `none` 並改以它為目標。
  **誠實說出做不到的部分**:這時站台已經收到一次 `mouseout`,救得回**有收合延遲**的選單(jQuery 常見),
  零延遲又沒有 `z-index` 的選單救不回來。煙霧測試就照這個界線分兩案驗。
- **A-4 讓路是暫時的,要裝得回去**:指標離開讓路的那個元素就把 `pointer-events` 收回 `auto`,
  否則 iframe 從此選不到。兩個出口:`mousemove` 到讓路元素以外的地方、以及讓路元素自己的 `mouseout`
  (指標從選單移進裸露的 iframe 區域時,父文件收不到任何事件,那個 `mouseout` 是最後一個訊號)。
  在讓路元素**內部**移動不算離開(裝回去就馬上又搶走指標)。
- **A-5 位置隨滑鼠移動重算**(節流 250ms):結掉 BACKLOG 的「代理層隨版面重排更新」。
- **A-6 收尾**:代理層不在 overlay 底下了,`exitPickMode` 要自己移除;`yieldedEl`、`lastProxySync` 一併重設。
- **不選的方案**:
  - 事件式開關代理層(原 A-2):探針證明沒有進入訊號,做不到。
  - 只做讓路、代理層維持最高 z-index:第一次踏上代理層時 `mouseout` 已經發出去,主要情境救不回來。
  - 拿掉代理層、改由 iframe 內 content script 經 background 回報 hover:跨三個執行環境、與 `DESCEND_FRAME` 重疊。
  - 每次 `mousemove` 對所有 iframe 重算矩形不節流:量矩形會逼瀏覽器重算版面。

### 改動（實作後對照）

1. `src/content/picker-mode.js`
   - `buildFrameProxies`:改 append 到 `document.body`、`z-index` 由 `proxyZIndexFor(frame)` 決定、位置抽成 `syncProxyRect`(唯一一份)。
   - 新增 `syncProxyRects`(節流 250ms,`onMouseMove` 每次呼叫)、`yieldProxyIfCovered`、`rearmProxies`、`stillOnYielded`、`onMouseOut`。
   - `onMouseMove`:重算矩形 → 離開讓路元素就裝回去 → 指在代理層上就問一次底下是誰。
   - `exitPickMode`:移除 `mouseout` 監聽、移除代理層節點、重設 `yieldedEl` / `lastProxySync`。
2. `tests/o6_frame_proxy.test.js`:既有九條全數維持,首條加驗 `pointerEvents === 'auto'`。
3. 新增 `tests/o9_proxy_yield.test.js` 12 條(先寫先紅):貼在 body 不在 overlay、z-index 跟著 iframe、
   iframe 無 z-index 取 0、讓路、底下就是 iframe 時不讓路、讓路後點選單送 `PICKED`、
   移到別處裝回去、選單 `mouseout` 裝回去、內部移動不算離開、節流重算矩形、
   沒有 `elementFromPoint` 不炸、離開時代理層清乾淨。
4. `src/manifest.json` 與 `package.json` 版本 0.9.0 → 0.10.0。

### 測試／驗收

- `npm test` **1846 綠**（1834 + 12），全綠。
- 五個突變各自紅（規劃時列四個，實作時多驗一個「讓路後沒關掉代理層」）：
  代理層預設回 `auto` → 3 紅；拿掉進入訊號監聽 → 4 紅；`syncProxyRect` 不重算 → 1 紅；
  拿掉讓路 → 2 紅；讓路後沒把 `pointer-events` 收成 `none` → 1 紅。
- grep 正式碼無測試檔名、`__test`、`Error().stack`。
- `elementFromPoint` 在 `src/` 只多出 `picker-mode.js` 一處，且帶 `typeof` 存在判斷。

## 批次B：真實瀏覽器煙霧

### 現況與核對結果

- `tests/smoke/load.mjs` 已有：本機 HTTP 伺服器、跨網域 iframe 頁（`/withframe`，[150-165](../tests/smoke/load.mjs:150)）、
  以 `chrome.tabs.sendMessage(ENTER_PICK)` 進入選取模式（[247](../tests/smoke/load.mjs:247)）、`page.mouse.move/click` 真實移動指標（[285](../tests/smoke/load.mjs:285)）。
- 沒有任何一段驗證「疊在 iframe 上的元素」。

### 定案（探針結果已改寫原案）

- **B-0 探針先行**（已執行，結論見批次 A 定案）：獨立腳本在 Chrome for Testing 上量「父文件收得到哪些指標事件」。
  結果推翻原方案，規劃改寫後才開始實作——這一步的價值就在這裡。
- **B-1**：新增 `/overlapframe` 頁：一個 iframe，上方一條選單列，`mouseover` 展開的下拉選單以 `position:absolute` 疊在 iframe 上。
  收合行為可切換：`__delay=false` 為 `mouseout` **立刻**收合（比使用者的站台嚴格），`__delay=true` 為 jQuery 常見的 300ms 延遲收合。
- **B-2 案(1)**：選單有 `z-index`（絕大多數站台）+ 零延遲收合。指標從選單列走進下拉選單 →
  選單仍展開、代理層**不在 overlay 底下**、面板不說「框架」；點選單項目 → `PICKED`，不是 `DESCEND_FRAME`。
- **B-3 案(2)**：選單**沒有** `z-index` + 延遲收合。指標走進下拉選單 → 代理層讓路（`pointerEvents === 'none'`）、
  選單沒被收掉、面板不說「框架」。
- **B-4 案(3)**：指標移到裸露的 iframe 區域 → 代理層 `auto`、面板說「框架」；點一下 → `DESCEND_FRAME`。

### 測試／驗收

- `./run_smoke.sh`：**Chrome for Testing 全部通過**，輸出多三行（案 1／案 2／案 3）。
  Edge 在本機起不來（`Failed to launch the browser process`），**改動前的 dev 也一樣**，是本機環境問題，非本輪造成。

## 批次C：文件與版本

1. `docs/SPEC.md` §2「目標在 iframe 內時」那段：新增代理層的三條規則（貼 body 不進 overlay／z-index 跟著 iframe／沒有 z-index 時讓路）、
   位置隨滑鼠移動重算，並寫下「父文件收不到進入跨網域 iframe 的任何事件」這個實測事實。
2. `CLAUDE.md`：`elementFromPoint` 那條加豁免（代理層讓路，必須帶存在判斷）；
   「不要做」補一條「蓋在頁面上、又接指標事件的東西要讓得開」，含那個實測事實。
3. `docs/BACKLOG.md`：刪「iframe 代理層隨版面重排更新」（本輪結案）；新增「進入選取模式之後才出現的 iframe 沒有代理層」（觸發：有站台回報）。
4. 版本 0.9.0 → **0.10.0**（`src/manifest.json` 與 `package.json` 兩處）。
5. 收尾走 `project-closeout`：換模型體檢 → 併 dev → 刪 `r11` → 本檔搬 `docs/archive/`。

## 四個角度的自檢（規劃階段補強，已反映在上面）

- **整體專案**：只動 `picker-mode.js` 一個機制；`background/frames.js`、`DESCEND_FRAME`、`frame: { url }` 存法全不變；
  三個用途（`task`／`repick`／`preaction`／`login-*`）共用同一條路徑，一次修完，不是只修前置動作那條。
- **程式面**：新監聽（`mouseout`）有對應的移除；代理層改貼在 `<body>` 底下不再隨 overlay 一起拆，
  所以 `exitPickMode` 補了自己的移除，`yieldedEl` 與 `lastProxySync` 一併重設（避免 AF-7／AF-9 那種殘留）；
  jsdom 不做命中測試 → 測試直接斷言 `pointerEvents`／`zIndex`／`parentElement`，命中替身照真實規則（開著就命中代理層）寫，
  程式沒有「先關再問」就會答錯；並補「讓路後送出的是 `PICKED`」的鏈結測試；五個突變各對一條。
- **使用者角度**（尖銳但有理）：「一個擴充功能不該弄壞我網頁的選單」——主要機制下指標從頭到尾沒碰過代理層，
  與沒開選取模式時一樣；做不到的情況（零延遲又沒有 z-index 的選單）寫在 SPEC 裡，不假裝做得到。
  「修好之後 hover 前置動作真的點得到嗎？」——本輪只保證**選得到**，執行端是另一件事，驗收多一步：使用者在真站台以
  `hover → waitFor（要看得見）→ click` 三步「立即測試」，讀 `preActionTrace` 看卡在哪一步；卡住再開下一輪。
- **管理者角度**：唯一的技術前提放在最前面用探針驗，**而且真的被推翻了**，改寫定案後才動工；
  規模小、版本 minor +1、BACKLOG 一進一出，都有留痕。

## 明確不做（本輪定案）

- 進入選取模式**之後**才動態插入的 iframe 不補代理層（進 BACKLOG）。
- 前置動作**執行端**（合成 `mouseenter` 序列）不動：使用者站台的選單是 JS 控制顯示，理論上照 SPEC §4 三步組合打得開，實測不行再開輪。
- 代理層的矩形重算節流 250ms，不做每一次 `mousemove` 都量（量矩形會逼瀏覽器重算版面）。
- 從 iframe 往上回父頁面（BACKLOG 既有項）不動。
