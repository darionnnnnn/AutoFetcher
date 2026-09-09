# AF-12 第 12 輪規劃：拔掉正式碼裡的測試欄位 `msg.__testOpts`

> 狀態：實作完成，待體檢
> 基準：dev@20871d2（1848 綠，版本 0.10.0）
> 來源：AF-11 收尾終檢 grep 抓到 `src/background/main.js:374` 有 `...(msg.__testOpts || {})` 進 `runTask`，違反 CLAUDE.md「正式碼不得有 `__test`」；來自開案期 commit `0297f1a`，一直沒被慣例測試擋下。
> 實作方式：Claude 自己做（一行正式碼 + 六個測試呼叫端 + 一條慣例測試）。若要用子代理跑測試，依使用者指示用 opus low。

## 現況與核對結果

- **正式碼只有這一處**：[main.js:372-376](../src/background/main.js:372) `RUN_TASK` 分支把訊息裡的 `__testOpts` 展開進 `runTask` 的選項，
  再以 `reason: 'manual'` 蓋回。等於**任何能送 runtime 訊息的來源都能改抓取的時序**（`pollMs`／`loadTimeoutMs`／`extractTimeoutMs`／`extraDelayMs`）
  與 `dryRun`、`slot`、`attempt`。正式呼叫端（[popup.js:106](../src/ui/popup/popup.js:106)、[tasks.js:290](../src/ui/report/tasks.js:290)）只送 `taskId`。
- **同一檔案已有正確的做法**：[main.js:264](../src/background/main.js:264) `handleAlarm(alarm, testOpts = {})`——測試時序走**函式第二參數**，
  不走事件物件；正式接線 `chrome.alarms.onAlarm` 不會傳它。`RUN_TASK` 該照這個慣例。
- **六個測試呼叫端**都經由 mock 的 `onMessage` 監聽器送 `{ type: 'RUN_TASK', taskId, __testOpts: FAST }`：
  [d6_wiring:140](../tests/d6_wiring.test.js:140)、[l1_batch_a:215／226／236](../tests/l1_batch_a.test.js:215)、
  [m4_audit2:106／122](../tests/m4_audit2.test.js:106)、[n1_closeout:140](../tests/n1_closeout.test.js:140)。
  其中只有 d6 的用意是**驗接線**（監聽器有註冊、會轉給 `handleMessage`），其餘五個驗的是 **`RUN_TASK` 的回傳形狀與帳本行為**，
  接線不是它們的主題。
- **不用 `FAST`、走生產時序的測試跑得快嗎**（決定接線測試能不能拿掉 seam）：mock 的分頁預設 `status: 'complete'`
  （[chrome-mock.js:136](../tests/chrome-mock.js:136)），[fetcher.js:365](../src/background/fetcher.js:365) 的載入輪詢一次都不進；
  `extraDelayMs` 未指定時讀 `settings.extraDelaySec`（[fetcher.js:255-262](../src/background/fetcher.js:255)），
  測試把它設 0 就是 0。所以**接線測試可以不帶任何時序選項**。
  （規劃時這裡還寫著「`extractTimeoutMs` 15 秒只在 responder 不回時才會等到」，**這句是錯的**：
  逾時計時器從不清除，就算擷取成功它也會吊著事件迴圈到 15 秒。實作 A-3 時才發現，見下面的計畫外修正。）
- **慣例測試沒有擋這件事**：`tests/a4_conventions.test.js` 到 D13 為止，沒有一條掃 `src/` 的 `__test`／測試檔名／`Error().stack`；
  CLAUDE.md 那條規則目前只靠人工 grep（[CLAUDE.md:92](../CLAUDE.md:92)），這就是它從開案活到現在的原因。
- `docs/SPEC.md` 沒有提到 `testOpts`／`handleAlarm`／`handleMessage` 的簽名，不用改 SPEC。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 |
|---|---|---|---|
| A | `handleMessage` 的執行選項改走第三參數；六個測試呼叫端改寫 | 1 行正式碼 + 6 處測試 | 無 |
| B | 慣例測試 D14：正式碼不得含 `__test`、測試檔名、`Error().stack` | `a4_conventions` 一條 | A（不然一開始就紅） |
| C | 文件與版本：CLAUDE.md 那條加「D14 會擋」、0.11.0 | 文件 | A、B |

## 批次A：執行選項改走參數

### 定案

- **A-1** `handleMessage(msg, sender, runOpts = {})`：`RUN_TASK` 用 `...runOpts`，**訊息物件裡的任何欄位都不再進 `runTask`**。
  順序維持 `{ slot, ...runOpts, reason: 'manual' }`，`reason` 仍不可被覆蓋。
  正式接線 [main.js:784](../src/background/main.js:784) **不改**——它本來就只傳 `(msg, sender)`，正式路徑拿不到 `runOpts`。
  與 `handleAlarm(alarm, testOpts)` 同一個形狀，不另起一套。
- **A-2** 五個「驗回傳形狀」的測試改直接呼叫 `handleMessage(msg, {}, FAST)`（`main.js` 已 export）：l1 ×3、m4 ×2、n1。
  l1 那條「`__testOpts` 不得覆蓋 reason」改名為「`runOpts` 不得覆蓋 reason」，斷言不變。
- **A-3** d6 的接線測試**保留走 `__emitMessage`，但不帶任何時序選項**：設定 `extraDelaySec: 0` 後送 `{ type: 'RUN_TASK', taskId }`，
  斷言紀錄寫進去。這才是接線測試該長的樣子——正式訊息長什麼樣，測試就送什麼。
- **A-4 新增一條負向測試**（d6）：透過監聽器送 `{ type: 'RUN_TASK', taskId, __testOpts: { dryRun: true }, dryRun: true, reason: 'scheduled' }`，
  斷言**紀錄仍然寫進去、`runs` 帳本仍然是空的**——訊息裡帶的執行選項一個都沒生效。這條是這輪的守門：
  把 A-1 改回讀 `msg.__testOpts` 它就紅。
- **不選的方案**：
  - 把時序選項做成 `settings`（`pollMs` 等）讓測試用合法設定注入：把測試旋鈕變成使用者設定，SPEC 與設定頁都得跟著長，不成比例。
  - `main.js` 匯出 `setRunDefaults()` 之類的模組層旋鈕：換個名字的測試鉤子，違反規則的精神。
  - 六個測試全部改直呼 `handleMessage`：接線就沒人驗了（d6 的 `return true` 與監聽器註冊）。

### 改動

1. `src/background/main.js`：`handleMessage` 簽名加第三參數；`RUN_TASK` 分支那一行改 `...runOpts`。
2. `tests/l1_batch_a.test.js`、`tests/m4_audit2.test.js`、`tests/n1_closeout.test.js`：改直呼 `handleMessage`（各自的 `sendTo`／`listener` 寫法留給仍在驗接線的測試用，沒人用了就刪）。
3. `tests/d6_wiring.test.js`：A-3 改寫、A-4 新增。

### 實作中新增：修掉擷取逾時的計時器洩漏（計畫外，但 A-3 需要）

[fetcher.js:439](../src/background/fetcher.js:439) 的 `Promise.race` 裡那個 `setTimeout` **從不清除**：
抓取成功之後它還吊著事件迴圈到 `extractTimeoutMs`（正式值 15 秒）為止。
以前每個測試都傳 `FAST`（200ms）所以看不出來；A-3 把接線測試改走正式時序，
d6 的耗時就從 0.8 秒變成 15.6 秒，才暴露出來。
**這在正式環境是真的浪費**：MV3 的 service worker 每抓一次都被多吊 15 秒不能閒置回收。
修法是 `.finally(() => clearTimeout(extractTimer))`。
迴歸測試 `d2_fetcher`「抓完不留計時器」用 `process.getActiveResourcesInfo()` 比對前後的 Timeout 數，
不指定 `extractTimeoutMs`（走正式的 15 秒）。d2 自己的耗時也從 1.03 秒降到 0.74 秒。
**另補一條「擷取一直不回時逾時失敗」**：逐條比對時發現這條失敗路徑**本來就沒有任何測試**，
而這輪剛好改到它——`.finally` 不吞 rejection 已另外驗過，但沒有測試就沒有人保證下一個人改它時還是這樣。
突變（計時器改成不 reject）會紅。

### 測試／驗收

- 全套 **1852 綠**（基線 1848 + 4）。
- 突變四個各自紅：訊息又能塞選項（`...(msg.__testOpts || {})` 加回去）→ d6 負向測試紅；
  `reason: 'manual'` 移到 `...runOpts` 前面 → l1「不得覆蓋 reason」紅；計時器不清 → d2「抓完不留計時器」紅；
  逾時不再 reject → d2「擷取一直不回時逾時失敗」紅。
- `grep -rn "__test" src/` 零筆。
- 逐檔耗時對照 dev 全部持平或更快（d2 1.03→0.74 秒，其餘在噪音內）。

## 批次B：慣例測試 D14

### 定案

- **B-1** `tests/a4_conventions.test.js` 新增 D14：沿用既有的 `src/` 檔案列舉，斷言正式碼**不含**
  `__test`（前綴比對，含 `__testOpts`）、`Error().stack`、任何 `tests/` 底下的檔名。訊息要說出哪個檔案哪一行。
  先斷言掃到的檔案集合非空（CLAUDE.md「掃描 + 迴圈型的測試要先斷言集合不是空的」）。
- **B-2** 這條要在 A 完成後才加，否則基準就紅。

### 測試／驗收

- 突變四個各自紅：`diag.js` 加一行 `// __testHook`（確認註解也掃）；`main.js` 註解提到 `tests/d6_wiring.test.js`；
  `fetcher.js` 加 `void new Error().stack`；把 `jsFiles()` 換成空陣列（非空守衛）。

## 批次C：文件與版本

1. `CLAUDE.md:92` 那條改為「……（`tests/a4_conventions.test.js` 的 D14 會擋）」；基線數更新。
2. 版本 0.10.0 → **0.11.0**（`src/manifest.json` 與 `package.json`）。
3. `docs/SPEC.md` 的失效情境表補一句：擷取逾時的計時器在擷取結束時清掉（計畫外的修正帶出來的規格事實）。
4. 收尾走 `project-closeout`（換模型體檢 → 併 dev → 刪 `r12` → 本檔搬 `docs/archive/`）。

## 四個角度的自檢

- **整體專案**：改動只在 `main.js` 一行與測試；`handleAlarm` 已是同一形狀，`RUN_TASK` 對齊它而不是另起爐灶；正式接線不動。
- **程式面**：A-4 是真正的守門（訊息欄位不得生效），比只 grep 字串更強；D14 把人工 grep 變成自動，兩層都有。
  接線測試改走生產時序，靠的是 mock 分頁預設 `complete` 與 `extraDelaySec: 0`，兩個都是既有事實，不是新替身。
- **使用者角度**：使用者看不到差別；唯一的實際效果是「送個訊息就能把抓取改成 dryRun 或改時序」這條路關掉。
- **管理者角度**：規模一天內、無風險；不做的話 CLAUDE.md 那條規則等於沒有執行力。

## 明確不做（本輪定案）

- 不把時序選項做成使用者設定。
- 不動 `handleAlarm(alarm, testOpts)`——它已是正確形狀。
- 不重構六個測試共用的 `sendTo` helper 成共用模組（各檔自有一份是既有慣例，這輪只改必要的呼叫端）。

## 體檢交接

- 實作：Opus 5（分支 `r12`）。體檢：請切換模型後執行 `project-closeout`。
- 測試：`npm test` **1852 綠**（基線 1848 + 4）；煙霧 Chrome for Testing 全過（Edge 本機起不動，改動前亦然）。
- **實作方最沒把握的三處**：
  1. 計時器洩漏的修正是計畫外的第二處正式碼改動（`fetcher.js`）。理由與量測寫在上面，但它超出原規劃的「一行正式碼」，
     請確認這個決定合理。（`.finally` 吞不吞 rejection 已單獨驗過、也補了逾時失敗路徑的測試，這一點不再是疑慮。）
  2. d6 那條接線測試現在依賴「mock 分頁預設 `complete`」與「`extraDelaySec: 0`」兩個前提。
     前提若哪天變了，這條測試會從「快」變成「慢但仍綠」，不會有人發現。
  3. D14 掃的是**每一行文字**（含註解與字串），可能誤傷未來合理的用法（例如正式碼裡出現 `__testnet` 之類的字）。
     目前 `src/` 零命中，但這條規則的誤報成本值得看一眼。
