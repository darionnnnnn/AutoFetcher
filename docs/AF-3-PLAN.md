# AF-3 第 3 輪規劃

> 狀態:實作中(批次 A 已完成並併回 dev,690 綠)
> 基準:dev@fcb2ed7(671 綠;煙霧測試通過但**未涵蓋真實注入**,見批次 A)
> 來源:SPEC 標示 AF-3 的四個目標段落(§6 §7 §10 §4 前置動作)+ 使用者實測「右鍵沒反應」+ 使用者提案「右鍵直接進入選取模式」
> 實作方:全部派 agy;Claude 先寫測試(含突變)、逐段驗收、寫文件。地端 LLM 不用(AF-2 回顧:此機不堪用)。
> 已定案的使用者決定:五個主題全做、密碼照 §6 加密、批次 A 獨立 hotfix 先併、圖示由 Claude 產。

## 核對時抓到的既有缺陷(全部納入本輪)

| # | 缺陷 | 證據 | 影響 | 修在 |
|---|---|---|---|---|
| D1 | **content script 從未載入成功** | `content/main.js:1` 用 ES `import`,但 `main.js:295`、`fetcher.js:189` 以 `scripting.executeScript({files})` 注入 = 傳統 script。Chrome for Testing 實測:`SyntaxError: Cannot use import statement outside a module`,之後 `sendMessage` 回 `Receiving end does not exist` | 右鍵抓取、排程抓取、預檢**全部**在真實瀏覽器失效;擴充功能至今沒抓過任何值 | A |
| D2 | **所有通知都是啞的** | `src/` 無任何圖示檔;`precheck.js:150` 用 `assets/icon-128.png`、`main.js:304` 用 `assets/icon-48.png`、`missed.js:108` 用 `icons/icon-128.png`、`fetcher.js:230` 沒給。實測 `notifications.create` 拋 `Unable to download all specified images` | 預檢失敗、補抓詢問、找不到元素、「請先按右鍵」提示全都不顯示;§10 告警做了也看不到 | A |
| D3 | manifest 無 `icons` | `manifest.json` | 工具列灰色拼圖;`action.setIcon` 燈號變體(§12.1)無圖可換 | A |
| D4 | **service worker 全域猴補 `String.prototype.startsWith`** | `watchdog.js:13-21`:為了讓 `d4_watchdog.test.js:44,46,53,56,118` 用 `startsWith('t1')` 比對到 `task:t1:0` 而改寫原型 | 整個 worker 內任何以 `task:` 開頭的字串行為都被改變;是為了過測試而改實作的反模式 | A |
| D5 | 煙霧測試沒驗真實注入 | `tests/smoke/load.mjs:114` 直接把紀錄塞進 storage,從未在網頁上跑注入 → 擷取 | D1 這種等級的故障能通過「全綠」 | A |
| D6 | 登入頁判定永遠不會觸發 | `precheck.js:120` 拿 `task.url`(設定值)比對前綴,不是分頁轉址後的實際 URL | `login_failed` 只在任務網址本身是登入頁時才可能出現 | D |
| D7 | REPICK 開分頁後直接送訊息、沒注入 | `main.js:217-228` `tabs.create` 後立刻 `sendMessage`,content 沒注入也沒等載入;`content/main.js:88` 收到也只回 `unsupported` | 任務頁「重選」按鈕永遠走到「請用右鍵重新選取」的退路 | B |
| D8 | 「抓取此區塊」與「抓取此文字/數值」同路 | `main.js:292` 兩個 menuItemId 走同一段 | §7 尚未實作的自然結果 | B/C |
| D9 | `suggestForeground` 有寫沒讀;`foreground` 沒被尊重 | `fetcher.js:227` 寫;`grep foreground src/` 無其他命中 | §4「改用前景抓取」提示與旗標無效 | F |
| D10 | `sites` 無 UI 寫入端;`site.password` 明文 | 僅 `settings-io.js:141` 匯入會寫;`settings-io.js:56-60` 把 `site.password` 當明文搬 | §6 要求 storage 內即 AES-GCM | D |
| D11 | 偏好「預設額外等待秒數」存了沒人讀 | `settings.js:239` 寫 `settings.extraDelaySec`;background 零命中,`runTask` 永遠用參數預設 3000 | 設定頁一個無效的偏好 | F |
| D12 | Picker 與 popup 違反「顏色只走 theme.css」 | `picker.html` 9 個色碼字面值、`popup.html` 14 個,兩頁都有 `<link theme.css>` 卻沒用變數;`report.html` 是乾淨的 | 這兩頁深色模式不生效;違反 CLAUDE.md 規則 | B(Picker 重排時一併)、popup 順手 |
| D13 | 通知點擊沒有路由 | `main.js:341` 只註冊 `onButtonClicked`,沒有 `notifications.onClicked` | §4.2「點通知開 Report 定位任務」無效 | E |

好消息(不用做的):`r.alert` 的消費端已在(`logic.js:55` alertOnly 篩選、`report.js:289` 「只看告警」核取);number 卡片閾值色已在(`cards.js:154`);`settings-io.js` 已有 PBKDF2 + AES-GCM 工具函式可抽出共用。

## 執行紀錄

| 段 | 執行方 | 結果 | 測試數 | 驗收/終檢抓到什麼 |
|---|---|---|---|---|
| A1 通知單一入口 | agy | 綠 | 690(A 段測試先寫) | 一次過。diff 精準在白名單內,37 行無過度設計;讀 diff 時發現 `main.js` 還有第二處原型猴補(`RegExp.prototype.test`),規劃時只知道 watchdog 那處 |
| A2 注入修復 | agy | 綠 | 690 | 一次過。它多加了一個 `__afContentDoc !== document` 的重置條件——那是為了讓 `b3_content` 的多份 JSDOM 通過,屬「為測試遷就正式碼」;Claude 改回單純旗標,把重置移進測試的 setup |
| A3 圖示/猴補/manifest | Claude 自做 | 綠 | 690 | 規模幾十行,委派的固定成本大於節省。連帶要改 `d6_wiring` 的 alarm 名稱斷言(它假設名稱是 `t1:0`,真實是 `task:t1:0`——這正是猴補的成因) |
| A4 煙霧測試真注入 | Claude 自做 | 綠 | — | **抓到規劃寫錯的一條**:計畫寫 `iconUrl: 'icons/icon-128.png'`,實測相對路徑會相對呼叫端解析(service worker 是 `/background/`)而 404,必須 `chrome.runtime.getURL()`。單元測試與 a4 守門都跟著改成要求絕對網址 |

突變驗證(五個,全部由綠轉紅):注入退回 `files:` → 4 條紅;`iconUrl` 改回 `assets/` → 5 條紅;
拿掉通知偏好判斷 → 2 條紅;冪等守衛改恆真 → 1 條紅;加回原型賦值 → 1 條紅。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 | 分支 |
|---|---|---|---|---|
| **A** | **Hotfix**:D1~D5(注入修復、圖示、通知入口、移除猴補、煙霧測試真注入) | 中 | 無 | `hotfix/af3-inject`,**單獨併 dev、出一版** |
| B | 頁面內選取模式(overlay、↑/↓、面板、表格欄列點選)+ 右鍵選單收斂 + REPICK 接上(D7) | 大 | A | `r3` |
| C | §7 區塊聚合:表格解析純函式 + 聚合 + Picker 區塊選項 + 紀錄 `partial`/`skipped` | 中 | B | `r3` |
| D | §6 自動登入:Site 設定(走 B 的點選)+ 加密 + fetcher 登入步驟 + D6 + 每日站台檢查 + §8.5 UI + 匯出入相容 | 大 | B | `r3` |
| E | §10 告警:純函式判定 + 60 分鐘去重 + `alert:true` + Picker/任務頁設定 + 通知 + 卡片/月曆標色 | 中 | A | `r3` |
| F | 前景抓取(D9)+ 前置動作(等元素/點元素/額外等待) | 小 | B | `r3` |

建議順序:A → B → E → C → D → F。E 提前是因為只依賴 A、獨立性高,可在 B 之後當「緩衝段」讓 agy 換腦;F 最後因為最可砍。

每段的委派粒度照 `gemini-delegate` §1–2:一段 1~2 個檔案一個機制,Claude 先寫測試 + 突變,agy 只拿到規格與測試檔。**每段完成後 Claude 做跨段 grep**(AF-2 回顧:逐段全綠看不到跨段斷鏈):新匯出對呼叫端、新選項對設定端與消費端、新 MSG 型別對三端。

---

## 批次 A:Hotfix — 讓擴充功能真的能抓值

### 現況與核對結果

- D1~D5 見上表。修法已用臨時副本在 Chrome for Testing 驗證:加 `web_accessible_resources` + loader 動態 `import()` 後,同一段 `content/main.js` 對本機 http 頁 `EXTRACT` 回 `{ok:true,value:1234,raw:"1,234"}`。
- `executeScript({files})` 不會等 async IIFE;驗證時碰巧沒撞到競態,但正式版不能靠運氣。
- 三處注入點:`main.js:295`(右鍵)、`fetcher.js:189`(抓取/預檢)、REPICK(`main.js:217`,B 再處理)。
- 本機有 PIL 11.3,可產 PNG。
- 猴補 D4 的動機是 `d4_watchdog.test.js` 五處 `startsWith('t1')`;正確做法是測試改用 `parseAlarmName`。

### 定案

- 注入改為 `chrome.scripting.executeScript({ target, func: (url) => import(url), args: [chrome.runtime.getURL('content/main.js')] })`——`executeScript` 會等 `func` 回傳的 promise,載入完成才 `sendMessage`。不用另一個 loader 檔。
- `content/main.js` 加冪等守衛(`globalThis.__afContent` 已存在則不重複註冊監聽;同一分頁可能被右鍵與排程各注入一次)。
- manifest 加 `web_accessible_resources: [{ resources: ['content/*.js','shared/*.js'], matches: ['<all_urls>'] }]`。此舉讓網頁能探測擴充功能存在;寫進 SPEC §9 與設定頁權限說明,列 BACKLOG「改成只暴露單一 bundle」。
- 圖示:Claude 用 PIL 產 `src/icons/icon-{16,32,48,128}.png` 與燈號變體 `icon-{green,yellow,red,gray}-{16,32,48}.png`(§12.1 `setIcon` 用;現有 `applyBadge` 若只設 badge 不換圖,變體先產好、接線留給 `applyBadge` 一行)。幾何造型、色碼取 `theme.css` 的 `--ok/--warn/--danger/--muted` 對應值(圖示是點陣不能用變數,但顏色來源要註明)。
- 新增 `background/notify.js`:唯一的 `notifications.create` 入口,固定 `iconUrl: 'icons/icon-128.png'`,尊重 `settings.notifications` 開關(現在四處各自判斷或沒判斷),失敗寫 diag 不拋。五處呼叫端全部改走它。
- 移除 D4 猴補;`d4_watchdog.test.js` 改用 `parseAlarmName(a.name)?.taskId === 't1'`。
- 煙霧測試補「真注入」段:起本機 http server(探針已寫好,見 scratchpad `inject.mjs`,搬進 `tests/smoke/`),從擴充功能頁對該分頁 `executeScript` + `EXTRACT`,斷言值為 1234;另斷言 `notifications.create` 不拋。
- Chrome for Testing 的 `--load-extension` 是本專案煙霧測試的唯一途徑,`publish/` 目錄的產出流程(cp `src/`)不變。

### 改動

1. `src/manifest.json`:`icons`、`action.default_icon`、`web_accessible_resources`。
2. `src/icons/*.png`(Claude 產,不派 agy)。
3. `src/background/notify.js` 新檔;`main.js`、`fetcher.js`、`precheck.js`、`missed.js` 改呼叫。
4. `src/background/main.js:295`、`src/background/fetcher.js:189`:注入改 `func` + `import()`。
5. `src/content/main.js`:冪等守衛。
6. `src/background/watchdog.js:12-21` 刪除;`tests/d4_watchdog.test.js` 五處改寫。
7. `tests/smoke/load.mjs`:真注入段 + 通知段;`run_smoke.sh` 不變。
8. `docs/SPEC.md` §9 補 `web_accessible_resources` 說明;`CLAUDE.md`「不要做」加兩條(content 不得用傳統注入、通知只走 notify.js、不得猴補原型)。

### 測試 / 驗收

- 單元(Claude 先寫,`tests/a3_hotfix.test.js`):
  - `notify()` 在 `settings.notifications=false` 時不呼叫 `notifications.create`;呼叫時 `iconUrl` 為 `icons/icon-128.png`;`create` 拋錯時不往外拋且 diag 有一筆。
  - 四個呼叫端(右鍵無目標、預檢失敗、not_found 用盡、錯過清單)改走 `notify`——用 chrome-mock 斷言 `notifications.create` 的 `iconUrl` 一致。
  - `fetcher.runTask` 與右鍵處理的 `executeScript` 呼叫必須帶 `func` 不帶 `files`(突變:改回 files 要紅)。
  - content 重複載入不重複註冊(`onMessage.addListener` 只被呼叫一次)。
  - `String.prototype.startsWith` 在載入 watchdog 後仍是原生函式(突變:把猴補加回去要紅)。
- 規則守門測試 `tests/a4_conventions.test.js`(讀原始碼做靜態檢查,之後每輪都留著):`src/**` 不得出現 `executeScript({… files:` 指向 `content/`(D1);`notifications.create` 只准出現在 `background/notify.js`(D2);不得出現 `String.prototype.` 賦值(D4)。B 再追加色碼那條。
- 煙霧:真注入段回 1234;通知不拋;三個頁面無 console error;alarm 段維持。
- 手動(使用者):載入 `publish/`,任一網頁右鍵 → 「抓取此文字/數值」→ Picker 視窗要跳出;存檔後「立即重試」要寫出一筆紀錄;工具列圖示不再是灰拼圖。
- 併回:單獨走 project-closeout 精簡版(不換模型;文件只改 SPEC §9、CLAUDE.md、README 現況),併 dev 後建 `publish/` 交付。

---

## 批次 B:頁面內選取模式(使用者提案)

### 現況與核對結果

- 右鍵流程:`content/main.js:9` 記 `lastTarget` → `main.js:300` `DESCRIBE` → 直接開 Picker 視窗(`windows.create type:'popup'` 480×640)。使用者看不到頁面就要填設定,脫節。
- `selector.describe(el)` 回 `{css,path,anchor,xpath}`(`selector.js:67`),對任意元素都能產;區塊容器也適用。
- REPICK:D7。任務頁 `tasks.js:238` 已有「重選」按鈕與退路文案。
- §6 逐一點選欄位、§7 ↑/↓ 擴縮、REPICK 三者都需要同一套互動,本批次做共用機制。
- content script 在 isolated world,能建 DOM overlay;頁面 CSS 不影響 overlay(用 `all: initial` + 固定定位 + 最高 z-index);不能用 `theme.css` 變數(頁面沒載),顏色字面值只允許出現在這個 overlay 模組並註明來源。

### 定案

- 右鍵選單收斂為三項:「選取要抓的內容」「設定此站台登入」(D 批次啟用,本批次先建項目但灰色)「開啟 AutoFetcher 報表」。移除「抓取此區塊」(區塊由選取模式自動判定)。
- 選取模式狀態機(content):`idle → picking → confirmed | cancelled`。進入時**右鍵處元素即預選高亮**;mousemove 改選;`↑` 父層、`↓` 回到上一次的子層(維持一條堆疊,不猜子元素);`Enter`/左鍵確認;`Esc` 取消;點到 overlay 自己不算。捲動時 overlay 跟著重算位置。
- 面板(overlay 右下角固定):標籤 `tag#id.class`(截斷)、文字預覽前 80 字、偵測型別:`數值 1,234` / `文字` / `表格 12 列 × 5 欄` / `清單 8 項`。型別判定純函式放 `shared/block-detect.js`(給 C 用同一份)。
- 表格模式:高亮到表格容器時,面板多一行「點選一欄或一列」;滑鼠移到表格內任一格時高亮整欄或整列(按 `Tab` 切換欄/列),點擊即選定 `{axis:'col'|'row', index, headerText}`。此時**locator 仍是容器**,欄列索引存 `spec.block`。
- 確認後由 content 送 `PICKED` 訊息給 background(帶 `locator`、`preview`、`previewValue`、`blockInfo`、`purpose`),background 開 Picker 視窗;Picker 讀到 `blockInfo` 就顯示區塊區段(C 批次填內容)。
- `purpose` 欄位:`'task'`(預設)| `'repick'`(帶 taskId,確認後直接更新 task.locator,不開 Picker)| `'login-user'|'login-pass'|'login-submit'`(D 批次)。同一個狀態機,只有確認後的去向不同。
- 進入選取模式的三個入口都經 background 的 `ENTER_PICK` 訊息 → 注入(A 的方式)→ `sendMessage({type:'ENTER_PICK', purpose, ...})`。REPICK 改為:開分頁 → 等 `status==='complete'` → 注入 → `ENTER_PICK purpose:'repick'`。
- 新 MSG:`ENTER_PICK`、`EXIT_PICK`、`PICKED`。`DESCRIBE` 保留給測試與退路,`REPICK` 型別改名為由 `ENTER_PICK` 取代(三端一起改,跨段 grep 必查)。
- 不做:iframe 內元素(BACKLOG 既有)、Shadow DOM 穿透(列 BACKLOG,觸發條件「目標在 shadow root 內」)。

### 改動

1. `src/content/picker-mode.js` 新檔(overlay、狀態機、鍵盤、表格欄列高亮);`content/main.js` 接 `ENTER_PICK/EXIT_PICK`,用 A 的注入方式載入(它 `import` picker-mode)。
2. `src/shared/block-detect.js` 新檔:`detectKind(el)` → `{kind:'number'|'text'|'table'|'list'|'grid', rows, cols, headers}`(純函式,吃 DOM 但不碰 chrome)。
3. `src/shared/messages.js`:三個新型別,移除 `REPICK`。
4. `src/background/main.js`:選單三項;`ENTER_PICK` 路由;`PICKED` 處理(開 Picker 或更新 task);REPICK 改寫。
5. `src/ui/picker/picker.html`、`picker.js`:讀 `blockInfo` 顯示區塊區段骨架(欄/列/表頭文字唯讀顯示);頁面重排成可捲動分區(排程 / 抓取 / 告警 / 前置動作 / 儀表板,後兩區 C/E/F 填內容)、視窗高 760、存檔鈕固定底部;**9 個色碼字面值全部改 theme.css 變數**(D12)。
5b. `src/ui/popup/popup.html`:14 個色碼字面值改變數(D12;不改結構)。
6. `src/ui/report/tasks.js:238`:重選改送 `ENTER_PICK`;退路文案保留。
7. `docs/SPEC.md` §2 改寫為選取模式;§3 不動。

### 測試 / 驗收

- `tests/b4_pick_mode.test.js`(jsdom):進入後預選元素有 overlay;mousemove 到另一元素 overlay 跟著移;`↑` 後目標為父層、`↓` 回原元素;`Esc` 後 overlay 移除且送 `EXIT`;`Enter` 送 `PICKED` 且 `locator` 等於 `describe(目標)`;表格內 `Tab` 切換欄列,點擊送出 `blockInfo.axis/index`;overlay 自身不會成為目標;重複 `ENTER_PICK` 不疊兩層 overlay。突變:把「排除 overlay」拿掉、把 `↑` 改成 `parentElement.parentElement` 都要紅。
- `tests/b5_block_detect.test.js`:`<table>` 含 thead → `table` + headers;ARIA grid → `table`;`<ul>` → `list`;同構容器 → `grid`;純數字 div → `number`;含字 div → `text`。
- `tests/b6_pick_wiring.test.js`:右鍵 → `ENTER_PICK` 帶 `purpose:'task'`;`PICKED purpose:'task'` → `windows.create` 帶 ctx;`PICKED purpose:'repick'` → `saveTask` 的 locator 更新且**不**開視窗;任務頁重選 → 送 `ENTER_PICK`。
- 規則守門測試追加一條到 A 建立的 `tests/a4_conventions.test.js`:`src/ui/**/*.html` 與 `src/**/*.js` 除 `content/picker-mode.js` 外不得出現 `#rrggbb` 字面值(D12)。
- 跨段 grep:`REPICK` 零命中;`ENTER_PICK/PICKED` 三端都有。
- 煙霧:真注入段延伸——對本機頁送 `ENTER_PICK`,`document.querySelector('[data-af-overlay]')` 存在;送 `EXIT_PICK` 後不存在。
- 手動:右鍵 → 高亮 → ↑↓ → Enter → Picker 跳出且預覽正確;表格上點一欄 → Picker 顯示該欄表頭。

---

## 批次 C:§7 區塊聚合

### 現況與核對結果

- `extract.js` 只處理單一元素;`parseNumber` 已處理千分位、貨幣、百分號、全形、會計負數(`extract.js:78-115`),§7 的數值解析可直接重用。
- Task 形狀(`picker.js:99-110`):`{id,name,url,mode,enabled,locator,spec,schedule}`;`mode` 目前 `number|text`。
- 紀錄成功狀態只認 `ok/fallback/late`(`record-status.js`);`partial` 已在 `health.js:12` 列為黃燈狀態但沒有產生端。
- Picker 的儀表板預設卡片型別依 `mode`(`picker.js:173`),`block` 模式需給預設。

### 定案

- `mode: 'block'`;`spec.block = { axis:'row'|'col', index, headerText, aggregate:'max'|'min'|'avg'|'sum'|'count', skipHeader:true }`。`headerText` 用於 fetcher 端「索引漂移」偵測:解析後若 `index` 位置的表頭文字不等於 `headerText`,改用表頭文字找欄,找到就 `status:'fallback'`、找不到就 `not_found`。
- 表格解析純函式 `shared/table.js`:`parseTable(el) → { cells: string[][], headers: string[], partial: boolean, source:'table'|'aria'|'grid'|'list' }`。`rowspan/colspan` 展開;巢狀 table 取最內層;ARIA;同構容器啟發式(容器下子節點數 ≥ 3 且各子節點的子元素數相同 → 列);`<ul>/<ol>` 以空白/tab 切欄;虛擬捲動判定:容器 `scrollHeight > clientHeight * 1.5` 且列數 < 估計總列數 → `partial:true`(啟發式,寫進 SPEC 標「暫定」)。
- 聚合純函式 `shared/aggregate.js`:`aggregateCells(values:string[], aggregate) → { value, skipped, used }`,用 `parseNumber`;`count` 算可解析的格子數。
- 紀錄新增欄位:`partial`、`skipped`、`used`;`partial:true` 時 `status` 仍 `ok`,但 health 走 `partial`(黃燈)——這是 `partial` 首次有產生端。
- `extractValue` 增加 `mode==='block'` 分支呼叫上面兩個純函式;content 不需要改(它已經把 `spec` 原樣轉給 `extractValue`)。
- Picker:`mode` 選單加「表格/清單區塊」;有 `blockInfo` 時自動選它並顯示欄/列、表頭、聚合下拉;沒有 `blockInfo` 卻手選 block → 提示回頁面用選取模式點一欄。預設卡片 `number + line`。
- Report 歷史表格「策略」欄對 block 顯示 `sum(第 3 欄)` 之類的簡述;失敗列展開顯示 `skipped/used`。
- 不做:Canvas/SVG(BACKLOG 既有)、跨頁分頁表格(列 BACKLOG,觸發「目標值在第 2 頁以後」)。

### 改動

1. `src/shared/table.js`、`src/shared/aggregate.js` 新檔(純函式)。
2. `src/shared/extract.js`:block 分支。
3. `src/background/fetcher.js`:成功路徑把 `partial/skipped/used` 寫進紀錄;`partial` 時呼叫 `setTaskHealth(status:'partial')`。
4. `src/ui/picker/picker.html`、`picker.js`:block 模式 UI 與存檔。
5. `src/ui/report/tasks.js`、`report.js` 歷史列:block 顯示。
6. `docs/SPEC.md` §7 改為現況、§11 補 block 分支、紀錄 schema 補三欄。

### 測試 / 驗收

- `tests/c3_table.test.js`:每種來源各一組固定 HTML → 期望 `cells`;`rowspan=2` 展開後兩列同值;`colspan=3` 展開三格;巢狀取內層;ARIA grid;同構 div;ul 切欄;虛擬捲動 → `partial:true`。突變:把 rowspan 展開拿掉要紅。
- `tests/c4_aggregate.test.js`:五種聚合;含「N/A」「—」「$1,234」「（500）」混合的欄 → `skipped` 正確、`sum` 正確;全部不可解析 → `{value:null, skipped:n}` 由呼叫端轉 `parse_error`。
- `tests/c2_extract.test.js` 追加:`mode:'block'` 端到端;`headerText` 漂移 → `fallback`;表頭消失 → `not_found`。
- `tests/d2_fetcher.test.js` 追加:`partial:true` 的回覆 → 紀錄有 `partial` 且 health 為 `partial`。
- `tests/c1_picker.test.js` 追加:`blockInfo` 進來 → mode 自動為 block 且欄位顯示;存檔 task 有 `spec.block`。
- 跨段 grep:`spec.block` 的設定端(picker)與消費端(extract)都有;`partial` 產生端與 health 消費端。
- 手動:在一個真實表格頁(建議用本機 http 測試頁,煙霧一併加一段)選一欄取 `sum`,紀錄值正確。

---

## 批次 D:§6 自動登入 + §8.5 站台登入管理

### 現況與核對結果

- Site 現有欄位只有 `loginPageUrlPrefix`、`password`(從 precheck 與 settings-io 反推,沒有 schema 文件)。
- D6:`precheck.js:120`。fetcher 流程(`fetcher.js:170-200`)在等載入與注入之間沒有登入步驟。
- `settings-io.js:20-42` 已有 PBKDF2 → AES-GCM 派生與加解密,可抽到 `shared/crypto.js` 共用。
- 每日 08:00 站台健康檢查:SPEC §4.2 有寫,程式無;alarm 命名需避開 `task:` 前綴與 `:pre:` 格式,且 `GET_NEXT_RUNS`(`main.js:238`)用 `parseTaskAlarm` 過濾,新 alarm 不會混進去。煙霧測試對 alarm 的斷言是按名稱過濾(`load.mjs:86-92`),新增 alarm 不影響。
- 設定頁 `report.html:593` 佔位。
- popup「開啟頁面」按鈕已存在(§12.2),登入失敗時的手動處理路徑已有。

### 定案

- Site schema:`sites[origin] = { loginUrl, selectors:{user,pass,submit}(各為 locator 物件), successCheck:{type:'urlPrefix'|'element', value}, loginCheck:{type:'urlPrefix'|'passwordField', value}, username, passwordEnc:{iv,ct}, enabled, failStreak, disabledReason, updatedAt }`。舊欄位 `loginPageUrlPrefix` 對應到 `loginCheck.urlPrefix`,`storage.init` 升 `schemaVersion` 2 做一次搬移。
- 加密:`shared/crypto.js` 提供 `encryptSecret(plain)` / `decryptSecret(enc)`,金鑰為 `storage.local.cryptoKey`(首次產生 256-bit 隨機,`exportKey` 存 raw);設定頁與 SPEC 明示「僅防誤讀,不防同機惡意程式」。匯出設定時 `passwordEnc` 一律不含;勾「含密碼」時先用本機金鑰解密再用密語加密(既有流程),匯入反之。
- 登入流程(`background/login.js`,fetcher 在「等載入」之後、「注入擷取」之前呼叫):
  1. 讀 `tabs.get(tabId).url`(修 D6),依 `loginCheck` 判定是否在登入頁;不是 → 直接跳過。
  2. 站台 `enabled=false` → 回 `login_failed`(reason `站台自動登入已停用`)。
  3. 注入 content,送 `FILL_LOGIN`(帶 selectors、username、明文密碼——**只在訊息中短暫存在**,content 填完即丟);content 用 `resolve` 找三個元素,填值時觸發 `input`/`change` 事件(React 表單需要),點送出。
  4. 等 `complete` + 額外等待,再讀一次 URL 做 `successCheck`;失敗 → `failStreak++`,達 3 → `enabled=false` + `notify`(§6);成功 → `failStreak=0`。
  5. 回 `{ok, status:'login_failed'|null}`,fetcher 據此決定寫 `login_failed` 紀錄(新 status,**非**成功狀態;`record-status.js` 不變)或繼續。
- 預檢(`runPrecheck`)因共用 `runTask(dryRun)` 自動獲得登入步驟;`isAtLoginPage` 刪除,改由 `runTask` 回傳的 `status` 判定。
- 每日站台健康檢查:alarm `__sitecheck`,每日 `settings.siteCheckTime`(預設 `08:00`)以 `nextDailyRun` 算 `when`(不用 periodInMinutes,照 CLAUDE.md);對每個 `enabled` 站台開分頁 → 登入流程 → 結果寫 `health['site:'+origin]`;失敗通知。看門狗確認 `__sitecheck` 存在。
- 設定站台入口:右鍵「設定此站台登入」→ 開「站台登入」小視窗(`ui/site/site.html`,新頁),視窗內三個「點選」按鈕各觸發 `ENTER_PICK purpose:'login-*'`(B 的機制),content 回 `PICKED` 後 background 轉給該視窗更新欄位;帳號密碼在視窗內輸入;「測試登入」按鈕跑一次登入流程回報結果。
- §8.5 設定頁「站台登入管理」:列出所有站台(origin、帳號、啟用、最近檢查結果、失敗次數)、「啟用/停用」「重新啟用」(清 failStreak)「刪除」「開啟設定」(開上面的視窗);頂部固定風險說明。UI 不直讀 storage,走 `shared/storage` 的 `getSites/saveSite/deleteSite`(`deleteSite` 新增)。
- 密碼欄型別 `password`;視窗關閉即清;不做「顯示密碼」。
- 不做:2FA/驗證碼(§6 明訂)、OAuth 跳轉登入(列 BACKLOG,觸發「登入頁在別的 origin」)、多帳號同站台(BACKLOG)。

### 改動

1. `src/shared/crypto.js` 新檔;`settings-io.js` 改用它並處理 `passwordEnc`。
2. `src/shared/storage.js`:schema v2 搬移、`deleteSite`、`getSites` 形狀文件化。
3. `src/background/login.js` 新檔;`fetcher.js` 插入登入步驟與 `login_failed` 紀錄;`precheck.js` 移除 `isAtLoginPage`。
4. `src/content/main.js`:`FILL_LOGIN` 處理(填值 + 事件 + 點擊)。
5. `src/background/sitecheck.js` 新檔(`__sitecheck` alarm 建立與執行);`main.js` alarm 路由 + `handleInstalled/handleStartup` 建立;`watchdog.js` 確認存在。
6. `src/background/main.js`:「設定此站台登入」選單啟用;`PICKED purpose:'login-*'` 轉發;`SAVE_SITE`/`TEST_LOGIN` 訊息。
7. `src/ui/site/site.html`、`site.js` 新頁。
8. `src/ui/report/settings.js`、`report.html:593`:站台清單。
9. `src/background/health.js`:`site:` 前綴的健康項納入燈號(紅:站台停用/登入失敗)。
10. `docs/SPEC.md` §6 改現況、§4.2 站台檢查改現況、§5 補 Site schema 與 schemaVersion 2。

### 測試 / 驗收

- `tests/d7_crypto.test.js`:加密後解密還原;沒有金鑰時自動產生並存;兩次加密同明文 iv 不同;竄改 ct 解密拋錯。
- `tests/d8_login.test.js`(chrome-mock + tab responder):不在登入頁 → 不送 `FILL_LOGIN`;在登入頁且站台啟用 → 送 `FILL_LOGIN` 且訊息含明文、storage 內無明文(突變:把 `passwordEnc` 改成存明文要紅);成功判定過 → `failStreak` 歸零;連續 3 次失敗 → `enabled=false` + `notify` 一次;`enabled=false` → 直接 `login_failed` 不送 `FILL_LOGIN`;**用分頁實際 URL 判定**(mock 讓 `tabs.get` 回轉址後 URL;突變:改回讀 `task.url` 要紅)。
- `tests/d2_fetcher.test.js` 追加:登入失敗 → 紀錄 `login_failed`、不寫 `value`、`isSuccess` 為 false、不重試。
- `tests/d5c_precheck.test.js` 改寫:`login_failed` 來自 `runTask` 的回傳而非 URL 前綴。
- `tests/d9_sitecheck.test.js`:alarm 用 `when` 不用 `periodInMinutes`;觸發後對每個啟用站台各跑一次;結果寫 `health['site:…']`;`GET_NEXT_RUNS` 不含它。
- `tests/a2_storage.test.js` 追加:v1 → v2 搬移 `loginPageUrlPrefix`;`deleteSite`。
- `tests/e2_settings.test.js`(settings-io)追加:匯出不含 `passwordEnc`;含密碼匯出 → 匯入後 storage 內是 `passwordEnc` 不是明文。
- `tests/b3_content.test.js` 追加:`FILL_LOGIN` 對三個元素填值、觸發 `input` 事件、點擊送出;找不到任一元素回 `{ok:false, missing:'pass'}`。
- `tests/f4_settings.test.js` 追加:站台清單渲染、停用/重新啟用/刪除經 storage 不直讀 chrome;`tests/d10_site_page.test.js`:三個點選按鈕各送對 `purpose`;`PICKED` 回來填對欄位;儲存經 `SAVE_SITE`。
- 跨段 grep:`loginPageUrlPrefix` 只剩搬移程式;`site.password` 零命中;`FILL_LOGIN/SAVE_SITE/TEST_LOGIN/PICKED` 三端齊。
- 手動:對一個測試登入頁(煙霧加本機 http 登入頁:POST 後設 cookie 轉址)設定 → 測試登入成功 → 任務抓取時自動登入 → 改錯密碼 3 次後站台停用且有通知。

---

## 批次 E:§10 告警

### 現況與核對結果

- 消費端已在:`logic.js:41-55`(`alertOnly`/`alertsOnly` 兩個名字並存,只保留 `alertsOnly`,另一個是 AF-2 終檢列為「不採納」的既有契約——保留不動)、`report.js:289` 核取、`cards.js:154` 閾值色。月曆紅角已核實只看失敗(`report.js:721` `day.hasFail`),不讀 `alert`。
- 歷史頁狀態篩選清單是寫死的(`report.js:275` 起),C 的 `partial` 與 D 的 `login_failed` 都要加進去——列入 C/D 跨段 grep。
- 通知走 A 的 `notify()`;`settings.notifications` 開關已被它尊重。D13:`notifications.onClicked` 不存在,本批次補。
- 「連續 N 次失敗」的資料來源:紀錄按日分檔,要往前找 N 筆需跨日;`storage.getRecordsInRange` 已有(`storage.js:194`)。

### 定案

- Task 新增 `alerts: [{ id, type:'gt'|'lt'|'eq'|'deltaPct'|'failStreak', value, enabled }]`,可多條。
- 純函式 `shared/alerts.js`:`evaluateAlerts(task, record, prevRecords) → { hits:[{alertId,type,message}] }`;`deltaPct` 用前一筆**成功**紀錄(`isSuccess`)比;`failStreak` 數最近連續非成功紀錄含本筆;`eq` 對數值用 `Number.EPSILON` 級容差、對文字模式用字串相等。
- 去重:`storage.local.alertLog[taskId][alertId] = lastNotifiedAt`;60 分鐘內同 alertId 不再通知(可設 `settings.alertCooldownMin`,預設 60);但紀錄仍標 `alert:true` 與 `alertHits:[alertId…]`。
- 接點:`fetcher.writeRecord` 之前(成功與失敗紀錄都要評估,因為 `failStreak`);`dryRun` 不評估。`late` 補抓的紀錄也評估。
- 通知文案:`「<任務>」告警:值 1,234 > 1,000`;點通知開 Report 歷史頁定位該任務該日(現有通知點擊路由若無則補 `notifications.onClicked` 一條)。
- UI:Picker 與任務頁編輯各加「告警條件」區(型別下拉 + 數值 + 啟用),多條可增刪;任務頁列表對有告警設定的任務顯示鈴鐺,最近一次觸發時間。
- 顯示:歷史列 `alert:true` 加標記;月曆紅角改為「失敗或告警」;number 卡片保留既有閾值色機制,不另加(避免兩套顏色規則;SPEC §10「number 卡片以顏色標示」改寫為「經卡片閾值色達成」)。
- 觸發點介面:`alerts.js` 匯出的 `hits` 是唯一入口,webhook 之後接這裡;本輪不做 webhook(BACKLOG 保留)。

### 改動

1. `src/shared/alerts.js` 新檔。
2. `src/shared/storage.js`:`getAlertLog/setAlertLog`。
3. `src/background/fetcher.js`:評估 + 去重 + `notify`;紀錄多 `alert/alertHits`。
4. `src/background/main.js`:新增 `notifications.onClicked` 監聽(D13):告警與預檢通知 id 帶 `taskId`,點擊開 Report 歷史頁 `?task=<id>&date=<day>`。
5. `src/ui/picker/picker.html/.js`、`src/ui/report/tasks.js`:告警設定 UI。
6. `src/ui/report/report.js`:月曆紅角、歷史列標記。
7. `docs/SPEC.md` §10 改現況、Task schema 補 `alerts`。

### 測試 / 驗收

- `tests/e3_alerts.test.js`:五種型別各命中/不命中;`deltaPct` 忽略中間失敗紀錄取上一筆成功;`failStreak` 跨日計數;文字模式 `eq`;停用的條件不評估;突變:把 `>` 改 `>=` 要紅、把 `isSuccess` 過濾拿掉要紅。
- `tests/d2_fetcher.test.js` 追加:命中 → 紀錄 `alert:true`、`notify` 一次;60 分內再命中 → 紀錄仍 `alert:true` 但不再 `notify`;61 分後再通知;`dryRun` 不評估;失敗紀錄也評估 `failStreak`。
- `tests/c1_picker.test.js`、`tests/f3_tasks.test.js` 追加:告警條件增刪存進 `task.alerts`;不合法數值不能存。
- `tests/f2_report_view.test.js` 追加:`alertsOnly` 篩出 `alert:true`;月曆對只有告警的日期標紅角。
- 跨段 grep:`task.alerts` 設定端與消費端;`alertHits` 產生端與顯示端。
- 手動:設 `> 1` 對本機頁抓 1234 → 通知跳出、歷史列有標記、「只看告警」篩得到。

---

## 批次 F:前景抓取 + 前置動作

### 現況與核對結果

- D9。`fetcher.js:160` 一律 `active:false`。
- D11 已核實:`settings.extraDelaySec` 在 background 零命中,`runTask(opts)` 的 `extraDelayMs` 只有測試在傳;正式呼叫端(`main.js` alarm 路由與 `RUN_TASK`)一律走預設 3000。F 要讓 `runTask` 在 `opts.extraDelayMs` 未給時讀 `settings.extraDelaySec`,再被 `task.extraDelaySec` 覆寫。

### 定案

- `task.foreground: true` → 開分頁時 `active:true`,並記住原本作用中的分頁,抓完切回;若使用者正在打字(無法偵測)——文件明示「約 3~5 秒會搶焦點」。
- 任務頁:`suggestForeground` 為真時該任務顯示提示與「改用前景抓取」一鍵勾選;成功一次後清 `suggestForeground`。
- `task.preActions: [{type:'waitFor', locator, timeoutMs:20000} | {type:'click', locator} | {type:'wait', ms}]`,順序執行;`waitFor` 逾時 → 該次紀錄 `status:'error'`(reason `前置動作逾時`)走既有重試;`click` 找不到 → 同上。設定入口:Picker「前置動作」區,每條 `waitFor/click` 的元素用 B 的 `ENTER_PICK purpose:'preaction'` 點選。
- content 新訊息 `RUN_PRE_ACTIONS`,由 fetcher 在登入步驟之後、`SCROLL_INTO_VIEW` 之前送。
- 任務級 `extraDelaySec` 覆寫全域(SPEC §4.2「任務可調」)。

### 改動

1. `src/background/fetcher.js`:前景切換與復原;`RUN_PRE_ACTIONS`;任務級延遲。
2. `src/content/main.js`:`RUN_PRE_ACTIONS`(`waitFor` 用 `MutationObserver` + 逾時,不用輪詢 `setInterval`)。
3. `src/ui/picker/`:前置動作區;`src/ui/report/tasks.js`:前景提示、前置動作摘要。
4. `docs/SPEC.md` §4 前置動作由「暫定」改現況。

### 測試 / 驗收

- `tests/d2_fetcher.test.js` 追加:`foreground:true` → `tabs.create active:true` 且結束後 `tabs.update(原分頁,{active:true})`;預設仍 `active:false`;前置動作訊息在 `SCROLL_INTO_VIEW` 之前;任務級 `extraDelaySec` 覆寫全域。
- `tests/b3_content.test.js` 追加:`waitFor` 元素後出現 → ok;逾時 → `{ok:false, error:'preaction_timeout'}`;`click` 觸發目標的 `click` 事件;`wait` 不阻塞測試(注入時間可覆寫)。
- `tests/f3_tasks.test.js` 追加:`suggestForeground` 顯示提示;按下後 `task.foreground=true`。
- 手動:對一個有「關閉彈窗」按鈕的本機測試頁設 `click` 前置動作,抓值成功。

---

## 明確不做(本輪定案)

- webhook / Google Sheets POST:只留 `alerts.js` 的 `hits` 作為觸發點,不做傳送(BACKLOG 既有)。
- Canvas/SVG 圖表、iframe 內元素、Shadow DOM 穿透、跨頁分頁表格、OAuth 跨 origin 登入、多帳號同站台、2FA/驗證碼:各列 BACKLOG 附觸發條件。
- 把 `web_accessible_resources` 收斂成單一 bundle(需要打包步驟,與「無框架原生 JS」慣例衝突):BACKLOG,觸發「上架審核或有人反映被網站探測」。
- `alertOnly` 舊參數名:保留(AF-2 終檢定案的既有契約)。
- 換掉 `<all_urls>`:BACKLOG 既有(上架時)。

## 四角度複核(規劃階段自檢,實作前)

**整體專案**
- 批次 A 若不先做,B~F 的所有手動驗收都不可能;A 的獨立 hotfix 同時是「第一次真正的端到端驗證」——A 併回後,使用者用 `publish/` 實測一輪(右鍵 → Picker → 立即重試 → 有紀錄)才開 `r3`。這一步寫進 A 的驗收,不是可選。
- 煙霧測試是本專案唯一能抓 D1 這類故障的手段,所以每個批次都要在 `load.mjs` 加一段真實頁面操作(B overlay、C 表格、D 登入頁、E 告警通知),不能只加單元測試。本機 http 測試頁集中在 `tests/smoke/fixtures/`。
- schemaVersion 升 2(D)是本專案第一次搬移;`storage.init` 要能從 v1 或全新都到 v2,且**匯入舊版設定檔**(v1 形狀,含 `loginPageUrlPrefix`)也要走同一段搬移——`settings-io.importSettings` 補一行。
- MSG 型別本輪新增 8 個(`ENTER_PICK/EXIT_PICK/PICKED/FILL_LOGIN/SAVE_SITE/TEST_LOGIN/RUN_PRE_ACTIONS`+ 移除 `REPICK`),三端斷鏈風險最高,每段的跨段 grep 都要做,併回前再做一次總表(型別 × 送端 × 收端)。

**程式面**
- content 端首次出現有狀態的模組(選取模式狀態機)且會被多次注入(右鍵、排程、REPICK):A 的冪等守衛必須擋住「監聽器重複註冊」與「狀態機重複建立」兩件事,B 的測試明確列入。
- `FILL_LOGIN` 訊息帶明文密碼經過 `tabs.sendMessage`——只在擴充功能內部通道,不經頁面主世界;但 diag 紀錄**不得**記訊息內容,`notify.js` 與 `diag.log` 的呼叫端在 D 要 grep 確認沒把 payload 整包丟進去。
- `partial`(C)與 `login_failed`(D)是兩個新的 record status,`record-status.js` 不改(都非成功),但 health 黃/紅集合、popup 文案、歷史列狀態文字、獨立 HTML 報表的狀態欄四處要有對應中文——列入 C/D 的跨段 grep(`STATUS_TEXT`)。
- 告警評估放在 `writeRecord` 之前而不是之後,是為了讓 `alert` 欄位跟紀錄同一次寫入,不產生「紀錄有了、旗標還沒有」的中間態(Report 可能剛好在讀)。
- overlay 的顏色字面值是全專案唯一豁免(頁面沒有 theme.css),CLAUDE.md 要寫明豁免範圍只限 `content/picker-mode.js`。

**使用者**
- 右鍵 → 選取模式 → 確認 → Picker,比舊流程多一步「確認」,但少了「看不到頁面就填設定」的困惑;預選右鍵處元素讓最常見情境(就是那個)只多按一個 Enter。
- 告警、前置動作、區塊三種設定都在 Picker,Picker 視窗 480×640 會不夠——B 一併改成可捲動的分區(排程 / 抓取 / 告警 / 前置動作 / 儀表板)並把視窗高度放到 760,最下方存檔鈕固定。
- 登入密碼「僅防誤讀」的風險說明要出現在**輸入密碼的視窗**和設定頁兩處,不能只在設定頁。
- 站台被停用(3 次失敗)後,使用者要能一眼知道「為什麼任務失敗」:popup 與任務頁的 `login_failed` 文案帶「站台已停用,到設定頁重新啟用」。

**管理者(維護與交付)**
- `publish/` 產出方式不變(cp src),A 併回後立即出一版;`r3` 全案併回後再出一版。兩版都在 README 記版本與 manifest `version`(A 升 `0.1.1`,r3 升 `0.2.0`)。
- 測試基線:A 併回時更新 CLAUDE.md 的「基線 N 綠」;r3 併回再更新。
- 六個批次 agy 各段的規格檔、測試檔、驗收紀錄照 AF-2 的表格格式記在本文末(執行紀錄),含突變結果與返工次數。
- 併回前終檢沿用 AF-2 做法(兩個獨立唯讀審查子代理:程式碼 diff、文件一致性),並照 project-closeout 換模型體檢——AF-2 沒做的這一步本輪補上。
