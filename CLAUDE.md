# AutoFetcher 專案規則

Chrome 擴充功能(Manifest V3):在指定網頁上以右鍵選取元素/區塊,依排程自動抓值,
歷史寫成 JSON,並在擴充功能內建的 Report 頁檢視每日紀錄。
**這是地圖不是百科**,細節在 `docs/`。

## 專案結構

```
src/
├── manifest.json        ← MV3;permissions 只加有消費端的
├── background/          ← service worker:main 總接線 / scheduler 排程 / fetcher 抓取 / login 自動登入
│                          precheck 預檢 / sitecheck 每日站台檢查 / missed 補抓 / watchdog 看門狗
│                          health 燈號 / notify 通知唯一入口 / inject 注入唯一入口
│                          frames 目標所在 iframe 的定位唯一入口
│                          fetch-tab 抓取頁面(專用視窗／分頁)與同站台佇列的唯一入口
├── content/             ← 注入頁面:main.js 訊息路由/擷取/填登入/前置動作(hover/等/點/等待)
│                          picker-mode.js 選取模式(高亮 overlay、↑↓、右上角工具列四段
│                          「單格(預設)/整欄→一個值/整欄→每格/整列→一個值」、可互動的已選 chip 面板、完成/取消鈕;
│                          點一下加選／再點取消、Shift 拉範圍、雙擊送出;巢狀小表升到外層;批次模式的「組」)
├── ui/theme.css         ← **顏色的唯一來源**(亮/暗雙軌 + --chart-1~8 圖表調色盤)
├── ui/theme-apply.js    ← **套用使用者主題設定的唯一一份**(`applyTheme`/`applySavedTheme`;Report、Picker、站台、popup、教學頁都用)
├── ui/help/             ← 使用教學頁(help.html 文案由 Claude 寫;寫法契約見 SPEC §2〈使用教學頁〉)
├── ui/ui.css            ← 擴充功能頁的**共用元件樣式**(按鈕三級/卡片/表單/chip/sticky footer/
│                          [hidden]/焦點/reduced-motion);只吃 theme.css 變數,零色碼。
│                          picker、site、help(教學頁)載入它;report/popup 尚未沿用
├── ui/picker/           ← 選取完成後的設定視窗;版面只回答三個問題
│                          (抓什麼／多久抓一次／抓完放哪裡),頂部摘要卡即時說出目前設定,
│                          網址與數值類型收在進階
├── ui/site/             ← 站台登入設定視窗(右鍵「設定此站台登入」)
├── ui/popup/            ← 工具列 popup(燈號摘要)
├── ui/report/           ← AutoFetcher-Report 頁(report.html)
│   ├── 純函式層(無 DOM、無 chrome.):
│   │   layout.js 格線數學 / series.js 資料序列與聚合(含樞紐表容差合併)/ logic.js 範圍篩選與 hash
│   │   templates.js 儀表板範本 / drop-rules.js 拖曳投放規則 / charts.js SVG 圖表(只碰 document 建元素)
│   └── DOM 層:report.js 路由與歷史頁 / dashboard.js 儀表板與拖曳 / cards.js 卡片
│       dnd.js 共用拖曳協定(唯一入口)/ drawer.js 卡片設定抽屜 / tasks.js 任務頁 / settings.js 設定頁
│       trend-popover.js 趨勢浮層(點欄標或數值卡開啟)
└── shared/              ← storage(唯一寫入口)、messages(訊息型別)、selector(四層定位)
                           series-index(序列 id 的唯一入口:組合/拆解/名稱)
                           extract(策略鏈)、export(三種匯出)、settings-io(設定匯出入)、diag(診斷)
                           layout-store(版面唯一入口)、record-status(成功狀態唯一來源)、crypto(站台密碼)
                           panel(side panel 的唯一入口:開啟／關閉／舊版退路)
                           preaction(前置動作的單位換算與失敗訊息,三端共用)
                           純函式:block-detect / table / aggregate / alerts
                           schedule-math(排程數學,background 與 Picker 共用)
                           describe(目標／排程／去處的白話句,全站唯一一份)
                           field-match(「這個 pick 是不是既有那個值」:重選與換目標共用)
docs/                    ← SPEC.md 現況規格、BACKLOG.md、archive/
```


- **唯一排程入口**:background 的 alarm handler;content script 不得自己排程。
- **唯一寫入入口**:`shared/storage`;JSON 匯出也從這裡走。UI 不得直接呼叫 `chrome.storage`。
  例外只有 `shared/diag.js`(診斷環形緩衝)與 `shared/crypto.js`(`cryptoKey`),各自只管自己那一個鍵。
- **不要把會掃整個 storage 的操作(`get(null)`)放在抓取寫入路徑上**:紀錄會累積到 MB 級;這類清理放看門狗並自帶一天一次的守衛。
- **版面的唯一入口**:`shared/layout-store`(儀表板與卡片的增刪改),它自己只經 `shared/storage`。
- **序列 id 的唯一入口**:`shared/series-index`。一個任務可以抓多個值,紀錄的 `taskId` 會是
  `<任務id>#<值key>`;任何地方都不得自己 split 字串。父任務 id 與序列 id 各用在哪見 SPEC §7 的分工表,
  記錯會讓冪等失效或畫面永遠空白。
- **UI 監看資料變動的唯一入口**:`shared/storage` 的 `subscribe`(UI 不得自己碰 `chrome.storage.onChanged`)。
- **frame 定位只有一份**:`background/frames.js`(`listFrames` / `matchFrameByUrl` / `locateFrame`,
  以及「同一個目標頁」的判定 `sameOriginPath`——立即測試核對分頁網址也用它,不得各比一次);
  任務存的是 `frame: { url }`,**`frameId` 存不得**(每次載入都不同),見 SPEC §3。
- **side panel 的唯一入口**:`shared/panel.js` 的 `openPanel(tabId, kind)`(含舊版退路與診斷)。
  **`sidePanel.open()` 的手勢不跨 `sendMessage`**——每個入口都要在自己的點擊／右鍵處理裡呼叫,
  不得轉給 background 代開;面板的參數一律走 `storage.session` 的 `panel:<tabId>`,
  **`setOptions.path` 不得帶查詢字串**(面板重載時會被丟掉)。
- **`sidePanel.open()` 要排在手勢裡第一個 `await`**:`setOptions` 不得先 await
  (同一個 task 送出即可,瀏覽器照順序處理)。右鍵選單的手勢在 service worker,
  沒有 DOM 暫時性啟用可依附,先 await 就會退回彈出視窗;
  **擴充功能頁跨 await 仍然開得起來,所以只驗那條會漏掉右鍵**。
- **面板不能自己判斷屬於哪個分頁**:`sender.tab` 永遠是 null、載入當下查作用分頁會拿到切換前的舊分頁。
  只能取 `windows.getCurrent().id`,在 `visibilitychange` 轉為可見時問 background(`RESOLVE_PANEL_TAB`)。
- **`held` 標示(送出後留在頁面上的藍框)有兩個出口**:面板關閉(`EXIT_PICK`)與下一輪同用途的 `ENTER_PICK`;
  按用途分群(`data-af-held`),取消／`Esc` 只清自己那一群。
- **抓取頁面只有 `background/fetch-tab.js` 開**(AF-20):排程、預檢、補抓、手動抓取、每日站台檢查都經 `enqueueForOrigin` → `acquireFetchTab`,
  佇列清空才 `releaseFetchTab`;前景抓取經 `openForegroundTab`;等載入(含 `discarded` 重載)只有 `waitTabReady`。
  **不沿用使用者開著的分頁**(只有立即測試帶 `tabId` 例外),「是不是同一頁」只用 `sameOriginPath`,抓取路徑不得 `tabs.query({url})`(`z8` 的 D15 會擋)。
  **預設是目前視窗的背景分頁**(`fetchTabMode:'tab'`,使用者定案不閃);專用視窗是設定選項。
  同站台接連的任務若前置動作全等、同一頁、而且入口的載入次數 `loads` 沒變 → `keepPage` 沿用、不重跑前置動作;判定只在 fetcher 一處。
  **「頁面沒被換過」的計數器不得歸零重算**(分頁重建要接著數),**入口量不到的換頁要另外通報**(自動登入回傳 `attempted`)——體檢探針各抓到一次「在全新／登入後的頁面上略過前置動作、照樣寫 ok」。
- **批次畫面沒有 `currentCtx`**(AF-20 體檢):把單任務區塊露出到批次畫面時,先 grep 那個區塊裡所有 `currentCtx` 的用處——前置動作的「在頁面上選取」少了 `tabId` 就靜默無事,
  而且按過一次「全部試抓」之後 `currentCtx` 被順手填上又會好,很容易誤判成沒問題。
  **專用視窗只有一種建法**:先 `windows.create({ url, focused:false, width, height })`、立刻登記、再 `windows.update({ state:'minimized' })`。
  直接 `state:'minimized'` 建的頁面 viewport 是 0×0;`minimized`＋`focused:false` 會靜默變一般視窗;`popup` 搶焦點;已最小化的視窗裡再開的作用中分頁(與在它之後開的背景分頁)也是 0×0(探針事實表在 SPEC §4)。
  自建的視窗／分頁登記在 `storage.session.fetchTabs`(帶 `boot`),孤兒只看登記表判定,不得用網址猜。
- **正式碼不得碰測試替身的 `__calls`**(AF-20 拔掉 fetcher 兩處往裡面塞假紀錄的程式碼,D14 已擋):那等於讓測試斷言正式碼自己寫的東西。
- **量頁面可見性、計時器節流一類的探針要拿掉 puppeteer 的預設旗標**(AF-20):它預設帶 `--disable-background-timer-throttling` 等三個,
  帶著跑的第一輪探針把背景頁面量成 visible、計時器照跑,結論完全相反。`ignoreDefaultArgs` 列出那三個再量。
- **health 一律經 `background/health.js` 的 `setTaskHealth` 寫**(fetcher / precheck / sitecheck 三個呼叫端);
  抓取結果 → 狀態的算法只有 `fetcher.js` 的 `healthFromRecords` 那一份。

## 文件地圖

- 改任何行為 → `docs/SPEC.md`(現況規格,§編號會被程式碼註解引用,勿拆檔)
- 想做但刻意沒做 → `docs/BACKLOG.md`(每項附觸發條件)
- 本輪規劃 → `docs/AF-<N>-PLAN.md`;完工搬 `docs/archive/`(按需讀,勿全掃)。AF-1~AF-20 已歸檔。

## 慣例

- 語言:文件與 UI 繁體中文;程式碼識別字英文;無框架、原生 JS(ES module)+ 少量 CSS。
- 測試:`npm test` **基線 2529 綠**(Node 內建 test runner + jsdom;下一輪只能增不能減)。
  真實瀏覽器端到端:`./run_smoke.sh`。
- **測試由 Claude 先寫、再委派實作**,而且要做突變測試(把守門那行改壞,確認測試會紅);
  併回前另做兩份獨立終檢(程式碼 + 文件)。
- **突變要改到真正的守門那一行**:數呼叫次數、把門檻設在本來就不會命中的位置,都是任何實作下都會過的假斷言。
- **段與段之間要有鏈結測試**:每段驗收都自己造輸入時,訊息欄位(`picks`、`locator`、`preselect`)沒有人從發訊端一路斷言到收訊端;
  `tests/m2_chain.test.js` 是這種測試,新增跨模組欄位時要補進去。
- **正式碼不得留測試後門**(測試檔名、`__test`、`Error().stack`;`tests/a4_conventions.test.js` 的 D14 會擋):
  委派端曾在正式碼塞測試替身呼叫,也曾用「呼叫堆疊是某測試檔就跳過去重」讓整套測試假綠。
  **測試要縮短等待一律走函式參數**(`handleAlarm(alarm, testOpts)`、`handleMessage(msg, sender, runOpts)`),
  正式接線不傳那個參數,那條路就不存在;**不得走訊息欄位**——`RUN_TASK` 曾把 `msg.__testOpts` 展開進 `runTask`,
  等於任何送得出 runtime 訊息的來源都能改抓取時序、把這次改成 dryRun、或改成 scheduled 去偷排程槽(AF-12 拔掉)。
- 分支:`dev` 開發、`master` 由使用者併;每輪一個 `r<N>` 分支。
- **每輪收尾要把版本號 minor +1**(`src/manifest.json` 與 `package.json` **兩處同步**,
  `tests/a4_conventions.test.js` 的 D3b 會擋不一致)。AF-6 與 AF-7 都漏升,
  到 AF-7 併 master 前才發現 manifest 停在 AF-5 的 0.4.0、package.json 還在開案的 0.1.0。
- 實作委派:先地端 LLM,較複雜給 agy;Claude 只規劃、驗收、寫文件(見 ~/.claude/skills 之委派 skill)。
- **委派規格的 grep 驗收要比對基準數量，不寫絕對值**：寫「不得出現 `Number.isInteger`」時，委派端把兩個既有函式改寫成 `% 1 === 0` 來過驗收（AF-16）。
  規格一律加「不得為了通過驗收改寫無關既有程式碼」。
- **Claude 寫的測試斷言別綁顯示格式的細節**：正則寫死「標籤後面緊接數字」，委派端就把歷史頁明細**所有**標籤的全形冒號拿掉（AF-16）。
- **換行判定用 python 讀位元組**：`"$(grep -c $'\r' f)"` 在 Git Bash 的命令替換裡會失效、回報 CR 數等於行數，AF-16 因此誤判全專案為 CRLF。本專案所有檔案是 LF。
- **委派端中途無聲結束時先查語法**:AF-16 作業 B 的 agy exit 0、stdout 全空,留下半套實作且刪掉一個結尾大括號,
  整個 content script 載不起來、數十則既有測試連帶紅。驗收先跑 `node --check`,再看 diff 缺了哪些條目。
- **改到操作語意或介面字串(工具列、按鈕、右鍵項目)要同步教學頁 `ui/help/help.html`**:`tests/y5_help_page.test.js` 的 `data-ui-label` 只擋「字串還在不在那個檔案」(子字串比對,註解裡有同一串也會過),擋不到語意變了(AF-18)。
- **不寫分號的專案,新增一行呼叫時要看下一行是不是以 `(`／`[`／`` ` `` 開頭**:AF-18 在 popup 初始化區塊加 `applySavedTheme()`,下一行是 `(async () => {…})()`,
  被接成 `applySavedTheme()(async …)`,jsdom 測不到(正式接線區塊不跑),真實瀏覽器煙霧才抓到。行首括號一律前置分號。
- **寫進 session 會觸發面板照 ctx 重畫**(AF-18):只 append 在 DOM 上的東西(儲存回饋的提示行)下一瞬間就被洗掉,而且不帶 `panelTabId` 的測試看不到——要留的內容放進 ctx。
- **新增一條「加值路徑」要過同一套守門**(AF-18 體檢):升到外層 → 批次換組 → 目標不是已選那張表就拒絕。`Shift`＋方向鍵與右鍵排除各漏過一次,結果是 A 表的組混進 B 表的索引。
- **存任務與加卡片分開、卡片排在重建排程之後**(AF-18 體檢):抽共用核心時把卡片綁進存檔,卡片寫不進去就讓已存的任務沒有排程。
- **突變腳本的 `replace(old, new, 1)` 換的是第一個命中**:同一串字在檔案裡出現兩次(`SHARED_IDS` 與 `DRAFT_FIELDS`)時會打錯位置、誤判成「測試沒守到」;`old` 要寫到唯一。
- **「在 A 之後讀 B」的情境要看 A 會不會清掉 B**:右鍵選單的 `closeMenu()` 會把 `menuTargetContext` 清成 null,
  排除分支在它之後才讀,右鍵排除永遠無效(AF-16)。新增選單動作要在關選單前取出情境。
- **任務存回 storage 一律「展開既有任務再覆寫自己擁有的欄位」**(AF-19):整批啟停、改排程、改名都只換那一個欄位;
  Picker 的 `buildTask` 會重組整個任務,編輯時靠 `RUNTIME_FIELDS` 帶過 `enabled`／`foreground` 等表單管不到的欄位。
  以前寫死 `enabled: true`,停用中的任務一編輯就復活、前景抓取設定默默消失。新增一條改任務的路徑時,先問「表單管不到的欄位會不會被洗掉」。
- **改多個任務一律走 `saveTasks`／`deleteTasks`**(AF-19):逐筆 `saveTask` 是 N 次讀寫整個 `tasks` 陣列;`REBUILD_ALARMS` 整批只送一次。
- **「這個 pick 是不是既有那個值」只有 `shared/field-match.js`**(AF-19):background 重選(`applyRepick`)與 Picker 換目標(`applyRetarget`)共用
  `pickSpecOf`／`sameSpec`／`reconcileFields`。以前只有 background 那一份,換目標每次都重生 key、把使用者改過的名稱打回預設。
- **值被移除時紀錄保留、卡片來源與 `lastValues` 清掉**(AF-19):`pruneSeries` 比對完整序列 id(不是父任務 id)。
- **任務頁要跨重畫保留的狀態放模組層**(AF-19):選取集合、改名到一半的文字——任務頁每抓一次就整份重畫,存在 DOM 上的都會被洗掉。
- **取消類二段確認的旗標與換表旗標一起清**(AF-19):一起清的地方只經 `clearPendingConfirms`;長按(`repeat`)與 400 毫秒內的連按不算第二次,
  右鍵開選單不清(選單裡的「取消」要能當第二步)。「是不是同一次確認」比**清單內容的簽章**,不比數量(換成整欄、排除都不改數量);
  太快的第二下不算但**不得重設計時**(重設就是每 300 毫秒按一次永遠取消不了,收尾探針實測抓到)。
- **排程欄位的回填要每一欄都寫**(AF-19 終檢):`fillSchedule` 只寫「有的鍵」時,同一份面板文件從編輯 A 切到整批改排程,A 的時段與星期會殘留並被套用到所有被選的任務。
- 設定/資料的事實來源是 `chrome.storage.local`;檔案一律**使用者手動匯出**,不自動下載(SPEC §5)。
- 訊息型別集中 `shared/messages.js`;三個執行環境的分工見 SPEC §0。
- **顏色一律走 `ui/theme.css` 變數**,任何模組內都不得出現色碼字面值(多序列用 `--chart-1`~`--chart-8`)。
- **格線數學與資料聚合寫成純函式**(無 DOM、無 `chrome.`),DOM 接線另置,才測得動。
- **白話描述只有一份**:`shared/describe.js`(Picker 摘要卡與儲存回饋、任務頁的排程欄、
  popup 任務列的 `title` 都用它)。
  同一個任務在不同畫面上長得不一樣,比沒有描述更糟。
- **排程數學只有一份**:`shared/schedule-math.js`(`nextIntervalRun` 等);
  `background/scheduler.js` 只 re-export。Picker 的觸發預覽要用同一份,不得自己算一套。
- **「哪些 status 算成功」只有一份**:`shared/record-status.js`(`ok`/`fallback`/`late`)。
- **`slot` 是本地時間、`capturedAt` 是 UTC**:絕不可直接比字串或切前 16 碼;換算只有一份
  (`series.js` 的 `effectiveTimeOf`/`sortKeyOf`,規則見 SPEC §8.2)。
- **卡片來源的順序就是表格欄序**:抽屜的上下移動與拖曳插入都只改 `card.source` 一份資料,不要另存欄序。
- **新增卡片一律走 `layout-store.addCard`**:它已呼叫 `findFreeSlot` 並自帶去重(同型別 + 同來源集合 + 同呈現模式),
  再算一次位置或自己去重就是兩份邏輯。
- **每個 UI 頁的樣式表都要有 `[hidden] { display: none !important; }`**:
  區塊自己的 `display: flex/grid` 會壓過 `hidden` 屬性,空的橫幅會露出一條空殼。
- **圖表 SVG 只設 `viewBox`**,外層用 `width: 100%` 縮放;`viewBox` 的長寬比要跟著卡片的格數走,
  否則等比縮放後會縮在角落。`padding.left` 48 / `bottom` 24 是座標軸標籤的保留區。
- **`theme.css` 的亮色變數全部要留在檔案最前面那個 `:root` 區塊**:
  匯出的獨立 HTML 用正規表示式只抓第一個 `:root`,新增變數還要同步進 `export.js` 的硬編碼退路。

## 不要做

- 不要把帳號密碼存明文於 `storage.sync`(會同步到所有裝置;SPEC §6 規定只放 `storage.local` 並標示風險)。
- 不要用 `setTimeout`/`setInterval` 做排程(MV3 service worker 會被殺;一律 `chrome.alarms`)。
- **不要用 `periodInMinutes` 做任務排程**(daily 與 interval 都不行,一律每次觸發後重算對齊的 `when`,
  理由與規則見 SPEC §4);`__watchdog` 自己那個固定 alarm 是唯一例外。
- 不要在帳本之外直接呼叫 `runTask`(同一排程槽會重複抓;冪等靠 `runs[taskId][slot]`,SPEC §4.1)。
- 不要假設抓取時目標分頁已開啟(排程到點由 background 經 `fetch-tab.js` 自己開頁面,SPEC §4)。
- **不要在 background 用動態 `import()`**(MV3 service worker 規格禁止,會在真實瀏覽器才炸;一律靜態匯入)。
- **不要在 background 直接呼叫 `chrome.notifications.create`**:一律走 `background/notify.js`
  (唯一入口、統一圖示、遵守通知偏好)。`iconUrl` 必須是 `chrome.runtime.getURL()` 的絕對網址。
- **不要用 `executeScript({files})` 注入 content script**:它是 ES module,一律走 `background/inject.js`。
- **不要讓 `chrome.tabs.sendMessage` 少掉第三個參數**:一個分頁可能有多個 frame,不指名 `{ frameId }`
  就是廣播,最上層會搶先回「找不到」而結案(`tests/a4_conventions.test.js` 的 D13 會擋)。
- **不要用 `matchOriginAsFallback`**:它不是 `executeScript` 的屬性,只用於 `registerContentScripts` 與 manifest。
- **不要為了讓測試好寫去改正式碼**:改寫內建原型(`tests/a4_conventions.test.js` 會擋)、把元素搬到測試讀得到的地方(AF-19:委派端把 `#errors` 搬進儲存回饋區,只因為測試在存檔成功後還讀它)都算;改測試,不要改實作。
- **不要在 `src/` 寫色碼字面值**:只有兩處豁免,都是拿不到 CSS 變數的執行環境——
  `content/picker-mode.js`(注入在網頁上,網頁沒載入 theme.css)與
  `background/health.js`(`setBadgeBackgroundColor` 只吃色碼字串)。
  **`picker-mode.js` 的色碼只能出現在檔頭的 `COLORS` 常數裡**(值照抄 theme.css 暗色軌),
  其餘程式碼一律引用它;連檔頭註解都不要列舉色碼(`tests/p4_ui_css.test.js` 會擋)。
- **選取模式的面板動作列建一次、只更新文字**:每次 hover 重建會把使用者正要按的那一顆換掉
  (「完成鈕點了沒反應」的根因);面板文字在 `data-af-panel-body`,動作列是它的兄弟節點。
- **停用的控制項被點到不得靜默無事**:要嘛記住意圖稍後兌現(工具列的 `pendingMode`),
  要嘛說出原因,而且**理由要對到真正的判定**(非表格就說不是表格,不要說成用途限制)。
  靜默 return 會讓使用者以為自己已經切好了模式。
- **「自動套用預設值」的函式要有『使用者動過就不再覆蓋』的守衛**:
  `applyDefaultCardTypes` 曾在移除一個值、上下移、改定位時把使用者勾的卡片型別改回預設。
- **延遲關窗前要確認 `globalThis.window` 還是自己那一個**:jsdom 測試共用全域 window,
  也可能關到別人的視窗。
- **會跨表格殘留的狀態，在「換表清空」那一段也要一起清**:AF-7 是 `pickedTableEl`、AF-9 是復原快照 `undoSnapshot`、AF-17 是立即測試明細表 `#test-detail`(`render` 清了預覽與診斷卻漏了它),
  兩次都是「清單清了、旁邊那份索引沒清」,`Ctrl+Z` 或送出就把 A 表的索引配上 B 表的定位。
- **蓋在頁面上、又接指標事件的東西要讓得開**:iframe 代理層曾貼在 z-index 最高的 overlay 底下,
  把站台疊在 iframe 上的下拉選單整個擋掉(站台收到 `mouseout` 就收合,使用者點不到選單項目)。
  規則見 SPEC §2:貼在 `<body>` 底下、`z-index` 跟著 iframe **最外層有數字 z-index 的祖先**走
  (只看 iframe 自己會被 `.content { z-index: 2 }` 這種容器蓋住,iframe 反而選不到)、沒有 z-index 時靠 `elementFromPoint` 讓路。
  **父文件收不到「指標進入跨網域 iframe」的任何事件**,別再想用 `mouseover` 之類的訊號開關它。
- **純數值標題(`4318`、`2025`)拿不拿來定位,只由 `extract.js` 的 `locateByHeader` 決定**
  (當下唯一出現才用;不見了或重複就走索引,SPEC §7)。選取端**原文照存**、preselect 直接呼叫同一個函式,
  不得各自寫一份比對——兩份會讓畫面勾到的格子與擷取抓到的格子不一樣。判準 `isAnchorText` 只給
  「命名不用它」與「摘要卡提示」用,不得拿來在選取端過濾標題(AF-14 先這麼做過:單列數值表是好了,
  年度欄的表卻從黃燈警示變成靜默抓錯欄)。
- **`locateFrame` 失敗回的是物件不是 `null`**(帶 `candidates` 給診斷用):
  判定一律看有沒有 `frameId`,寫 `=== null` 會把失敗當成成功。
- **格內子路徑 `inner` 的產生／解析、網格索引換算、同層同標籤計數各只有一份**(AF-15):
  `shared/table.js` 的 `innerPathOf`／`resolveInner`／`hasInner`／`resolveInnerAt`／`gridIndexOf`／`cellAtGridIndex`,
  計數是 `selector.js` 的 `getTagIndex`。**「某列某欄沿路徑取元素」選取端與擷取端共用 `resolveInnerAt`**,
  picker-mode.js 只經 `targetAtGrid` 呼叫它——各寫一份就是「畫面框到的格子與擷取抓到的不一樣」。
  **「非空陣列才放 `inner` 鍵」只有 `table.js` 的 `putInner`**(選取模式、Picker 收集表單、background 重選三處共用);
  **區塊擷取的列元素只有 `blockRowsOf`**(CSS 假表格改用 `cssGridRowsOf`,擷取端與診斷包探測共用);
  **「名稱接格內標籤」只有 `describe.js` 的 `withInnerLabel`**(七個命名與描述入口共用)。
  欄索引一律是網格索引,**不得再用 `getRowCells(row)[c]` 或 `cells.indexOf(cell)` 取欄**(有 `colspan` 就錯位)。
- **`inner` 的白話標籤只在顯示當下用 `describe.js` 的 `innerLabel` 算,不進 `PICKED` 訊息、ctx、任務與規格**(AF-15):
  `sameSpec` 是 JSON 全等比對,顯示字串進規格就會讓 key 重生、歷史序列斷掉(與 AF-14 的 `rawHeader` 同一個坑)。
  **收集表單值與重選時只要有「重組物件」的地方就要保留 `inner`**:Picker 的 `applyPosToCell` 與單值整欄組裝、background 的 `pickSpecOf`
  都是逐欄挑的,實測漏過一次——整條鏈每一段自己都綠,規格裡就是沒有 `inner`。
- **`↑`／`↓` 選定的表要鎖,`mousemove` 的升級不得覆寫明確意圖**(AF-15):鎖的判定與「已選值的鎖」是同一份 `anchor`;
  保護「選了值之後」時要問「選之前」——只鎖已選的話,按 `↑` 切到外層表之後滑鼠一動就回內層,第一次點之前就走不到。
- **巢狀小表的已選值升到外層只有一份**(AF-18):外層表 `outerTableOf`、可升級 `isUpgradeableTable`(同欄至少另一列有同型小表,擋版面表格)、
  換算 `promotePicksToOuter`(全有或全無)、加值前的觸發 `promoteBeforeAddingInOuter`(點擊／雙擊／拖曳／右鍵共用)。**`repick` 不升級**(key 會重生)。
  **`↑` 已選之後照樣離開這張表**,換不過去時鎖改認 `↑` 選定的外層表(`upgradeTarget` 的 anchor),否則 P1 會在版面表格上重現。
- **點一下＝加選／再點取消**(AF-18 推翻 AF-8);**移除類動作都要存復原快照,`Ctrl+Z` 自己做的移除不存**(存了連按兩次互相抵銷);換表已選 ≥2 要再點一次確認。
- **多任務的「組」**(AF-18):同一張表只能是一組(升到外層後要合併)、點 `body` 不成組、payload 只有 `buildPickPayload` 一份、恰好 1 組時訊息與非批次逐欄相同。
  面板批次儲存一律走 `render → 收集 → saveTaskFromForm`(與單任務共用存檔核心),**逐一 render 會把合成方式洗回預設,收集前要貼回共用設定**。
- **面板 `kind:'saved'`**(AF-18):存完當下就收成它;進選取的入口只經 `canStartPick`;同一份面板文件從 `saved` 進下一輪一律重載面板文件。
- **選取模式的模組狀態要在 `exitPickMode` 全部重設**:漏一個(例如「已選屬於哪張表」)
  會讓同一頁的下一次選取沿用上一張表的 locator、配上新表的列欄索引送出,抓到的永遠是錯的值。
  只驗「DOM 元素被移除」的測試抓不到這種殘留,要驗「連續選兩次」的行為。
- **掃描 + 迴圈型的測試要先斷言掃到的集合不是空的**:對空集合跑 `for` 迴圈一定通過
  (實例:掃 `ui.css` 的 `font-size: Npx`,但它全用 `var(--text-*)`,把 token 改成 8px 也不會紅)。
- **`ui/ui.css` 不留沒有任何頁面使用的類別**:它只服務 `picker.html`、`site.html` 與 `help/help.html`
  (Report 有自己那一份、選取模式 overlay 拿不到樣式表),定義了卻沒人掛的類別就是死規則。
- **樣式不要用 `content: attr(...)` 指向沒有人設定的屬性**:動態產生的清單不會帶你想像的
  `data-*`,那條規則會永遠是空白的死規則(序號一類用 CSS 計數器)。
- **跨文件邊界送訊息前不能假設文件還是原來那一個**:前置動作的點擊常常讓頁面換頁,
  舊文件連同 content script 一起被丟掉,接著送訊息就是 `Could not establish connection`。
  規則見 SPEC §4:定位/注入/捲動/擷取是一個整體、送不到就整段重來(最多 3 次),
  **逾時、找不到框架、前置動作都不重試**(`waitFor` 例外:它只觀察,前一步換頁害它送不到時可重送),
  判定不得比對 Chrome 的英文錯誤字串。
  **「等分頁回到 `complete`」對子框架導覽無效**(實測:`iframe.src` 改變時分頁狀態全程 `complete`)。
- **送給 content 的每一則訊息都要有逾時**:沒有逾時的 `sendMessage` 只要回應遺失就會吊到
  service worker 被回收。逾時值要涵蓋動作自己需要的時間(`hover` 的 `holdMs` 沒有上限)。
- **`chrome.tabs.create` 只吃它自己那幾個屬性**:多帶一個(例如 `autoDiscardable`,那是 `tabs.update` 的)
  Chrome 會**擋下整個呼叫**,不是忽略它。開案時就把 `autoDiscardable` 寫進 `create`,
  等於「目標頁沒開著」的排程抓取與每日站台檢查一直在失敗,到 AF-13 的煙霧測試才抓到——
  **測試替身不驗參數,而且當時的單元測試把這個 bug 寫進了斷言**。
- **不要用任務設定的網址判斷「現在在哪一頁」**:要讀 `chrome.tabs.get(tabId).url`(轉址後的實際位置)。
- **不要把每日排程算出來的時間直接當 alarm**:算出來若已經過去(例如現在剛好在預檢與抓取之間),
  Chrome 會立刻觸發、alarm 隨即消失,要跳過這一輪排到下一次。
- **content script 的擷取/填入不要只設 `value`**:要派發 `input`/`change` 事件,否則 React 表單收不到。
- 不要用一般 Chrome 跑煙霧測試:152 起已封鎖 `--load-extension`,必須用 Chrome for Testing(見 `run_smoke.sh`)。
- 不要用 `worker.evaluate` 做端到端斷言(service worker 閒置會被回收);從擴充功能頁面做。
- 不要在 UI 模組載入時就讀 storage 或渲染(測試要能自己呼叫 render)。
- 不要用 `innerHTML` 塞入紀錄內容或任務名稱(用 `textContent`)。
- 不要用絕對 XPath 當唯一選擇器(頁面小改就失效;SPEC §3 要求多重選擇器 + 文字錨定)。
- **不要用 HTML5 drag-and-drop**:拖曳一律 Pointer Events,且只讀 `clientX`/`clientY`/`pointerId`,
  `setPointerCapture` 要先檢查存在(jsdom 25 沒有 `PointerEvent` 也沒有這個方法)。
- **新的拖曳一律走 `ui/report/dnd.js`**,不要再各自內嵌 pointer 監聽(既有三處尚未搬過去,見 BACKLOG);
  **不要用 `document.elementFromPoint`**(jsdom 沒有,測不動)。命中與拒收往下找的規則見 SPEC §8.2。
  唯一例外是 `content/picker-mode.js` 的代理層讓路(只有真實命中測試答得出「底下是誰」),
  必須帶存在判斷,測試用替身注入。
- **底層投放目標要自己判斷指標是否壓在上層元素上**,否則會在拒收的卡片底下偷偷長出新卡片。
- **缺值不補 0、不內插**(SPEC §8.6);抓取失敗一律顯示 `—`,錯誤原因放 `title`。
- **數值不進科學記號、不截有效位數**:整數原樣輸出,只對有小數的值去浮點尾巴(`cards.js` 的 `formatNumber`)。
- 不要在匯出的獨立 HTML 報表放 `<script>` 或任何外部資源(靜態快照,離線可開)。
- 不要在 UI 直接讀 `chrome.storage`(一律經 `shared/storage`),也不要自己解析 alarm 名稱
  (下次執行時間問 background 的 `GET_NEXT_RUNS`,它已排除預檢與重試 alarm)。
- 不要每次渲染就 `addEventListener` 到不會被替換的容器(監聽會累加;用 `onclick` 指派或先移除)。
- **選取模式的 `mousedown` 不得對 overlay 自己的按鈕 `preventDefault`**:擋掉的話按鈕永遠拿不到焦點,
  焦點環就是畫了也沒人到得了的死規則;只擋頁面上的 `mousedown`(點到連結會讓頁面跑掉)。
- **新增的錯誤訊息或紀錄欄位要有消費端,而且測試要從產生端一路斷言到畫面**:
  `extract.js` 的指路訊息曾經產生後無人讀,刪掉整個函式測試全綠;`label` 只驗到回傳值,紀錄與畫面兩端零訊號。
- **`skip`／`exclude` 的「怎樣算有、怎麼讀」只有 `shared/table.js` 的 `skipOf`／`putSkip`／`excludeOf`／`putExclude`**（AF-16）：
  擷取端、background 重選、Picker 收集表單、描述句都經它們；不得各自寫 `Number.isInteger` 判斷。
  **「略過／排除」的白話只在 `describe.js`**：`exclusionOfTarget`（句中那一段）、`skipNote`（儲存摘要）、`targetOfTask`（已存任務轉描述輸入，任務頁與 popup 共用）。
  **`exclude` 是值的設定不是值的身分**：`sameSpec` 的 `stripPos` 要剝掉它與 `skip`，否則重選改了排除就 key 重生、歷史序列斷掉。
  **重組 `block` 物件的地方都要帶上它們**（background 的 `pickSpecOf` 與 `applyRepick` 兩條、Picker 的多值展開與單值逐欄組裝）——
  與 AF-15 `inner` 同一個坑：每一段自己都綠，規格裡就是沒有。
- **排除項在頁面上找不到不得靜默**（AF-16）：不排除任何東西、狀態降 `fallback`、訊息寫進紀錄的 `error`。
  合計列改名之後靜默的話，就是默默加兩次。
- **tfoot 預設排除只在「建立」整欄值的當下做一次**，preselect 帶回來的值不得再加（使用者取消過的不能復活）。
- **頭尾空白自動略過是 `skip.blank`，不是另一個鍵**（AF-17）：一律經 `skipOf`／`putSkip`，只認字面 `true`、關著時不寫 `blank` 鍵。併在 `skip` 裡才能沿用既有五個搬運點——另開鍵就是第三次「每段自己都綠、規格裡就是沒有」。**新建預設勾、編輯照舊任務回填**，不得把預設套到舊任務。
- **逐格明細 `items` 與 `blank` 只給立即測試預覽**（AF-17）：擷取端一律回傳，`fetcher` 單值與多值寫紀錄的兩份白名單**不得**抄它們（每筆紀錄夾帶整欄明細，storage 會長到 MB 級；`tests/x3_test_detail.test.js` 會擋）。處置分類只有 `extract.js` 一份，八態與結果的 `used`／`skipped`／`excluded`／`blank` 四條口徑必須對得上，改其中一邊要一起改。
