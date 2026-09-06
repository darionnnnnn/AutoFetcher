# AutoFetcher 專案規則

Chrome 擴充功能(Manifest V3):在指定網頁上以右鍵選取元素/區塊,依排程自動抓值,
歷史寫成 JSON,並在擴充功能內建的 Report 頁檢視每日紀錄。
**這是地圖不是百科**,細節在 `docs/`。

## 專案結構

```
src/
├── manifest.json        ← MV3;permissions 只加有消費端的
├── background/          ← service worker:排程(chrome.alarms)、開分頁抓取、寫入儲存
├── content/             ← 注入頁面:main.js 訊息路由/擷取/填登入/前置動作
│                          picker-mode.js 選取模式(高亮 overlay、↑↓、表格點欄列)
├── ui/theme.css         ← **顏色的唯一來源**(亮/暗雙軌 + --chart-1~8 圖表調色盤)
├── ui/picker/           ← 選取完成後的設定視窗(命名、時間、模式、區塊、告警、前置動作、儀表板)
├── ui/site/             ← 站台登入設定視窗(右鍵「設定此站台登入」)
├── ui/popup/            ← 工具列 popup(燈號摘要)
├── ui/report/           ← AutoFetcher-Report 頁(report.html)
│   ├── 純函式層(無 DOM、無 chrome.):
│   │   layout.js 格線數學 / series.js 資料序列與聚合 / logic.js 範圍篩選與 hash
│   │   templates.js 儀表板範本 / charts.js SVG 圖表(只碰 document 建元素)
│   └── DOM 層:report.js 路由與歷史頁 / dashboard.js 儀表板與拖曳 / cards.js 卡片
│       drawer.js 卡片設定抽屜 / tasks.js 任務頁 / settings.js 設定頁
└── shared/              ← 型別、儲存 schema、選擇器工具、layout-store.js(版面唯一入口)
                           record-status.js(成功狀態判定唯一來源)、crypto.js(站台密碼)
                           純函式:block-detect / table / aggregate / alerts
docs/                    ← SPEC.md 現況規格、BACKLOG.md、archive/
```


- **唯一排程入口**:background 的 alarm handler;content script 不得自己排程。
- **唯一寫入入口**:`shared/storage`;JSON 匯出也從這裡走。UI 不得直接呼叫 `chrome.storage`。
- **版面的唯一入口**:`shared/layout-store`(儀表板與卡片的增刪改),它自己只經 `shared/storage`。

## 文件地圖

- 改任何行為 → `docs/SPEC.md`(現況規格,§編號會被程式碼註解引用,勿拆檔)
- 想做但刻意沒做 → `docs/BACKLOG.md`(每項附觸發條件)
- 本輪規劃 → `docs/AF-<N>-PLAN.md`;完工搬 `docs/archive/`(按需讀,勿全掃)。AF-1、AF-2 已歸檔。

## 慣例

- 語言:文件與 UI 繁體中文;程式碼識別字英文;無框架、原生 JS(ES module)+ 少量 CSS。
- 測試:`npm test` **基線 905 綠**(Node 內建 test runner + jsdom;下一輪只能增不能減)。
  真實瀏覽器端到端:`./run_smoke.sh`。
- **測試由 Claude 先寫、再委派實作**,而且要做突變測試(把守門那行改壞,確認測試會紅)。
  AF-2 靠突變抓到多處同義反覆的測試;併回前另做兩份獨立終檢(程式碼 + 文件),抓到 14 類真實缺陷。
- 分支:`dev` 開發、`master` 由使用者併;每輪一個 `r<N>` 分支。
- 實作委派:先地端 LLM,較複雜給 agy;Claude 只規劃、驗收、寫文件(見 ~/.claude/skills 之委派 skill)。
- 設定/資料的事實來源是 `chrome.storage.local`;檔案一律**使用者手動匯出**,不自動下載(SPEC §5)。
- 訊息型別集中 `shared/messages.js`;三個執行環境的分工見 SPEC §0。
- **顏色一律走 `ui/theme.css` 變數**,任何模組內都不得出現色碼字面值(多序列用 `--chart-1`~`--chart-8`)。
- **格線數學與資料聚合寫成純函式**(無 DOM、無 `chrome.`),DOM 接線另置,才測得動。
- **「哪些 status 算成功」只有一份**:`shared/record-status.js`(`ok`/`fallback`/`late`)。

## 不要做

- 不要把帳號密碼存明文於 `storage.sync`(會同步到所有裝置;SPEC §6 規定只放 `storage.local` 並標示風險)。
- 不要用 `setTimeout`/`setInterval` 做排程(MV3 service worker 會被殺;一律 `chrome.alarms`)。
- 不要用 `periodInMinutes: 1440` 做每日排程(日光節約會漂移;每次觸發後重算 `when`,SPEC §4)。
- 不要在帳本之外直接呼叫 `runTask`(同一排程槽會重複抓;冪等靠 `runs[taskId][slot]`,SPEC §4.1)。
- 不要假設抓取時目標分頁已開啟(排程到點由 background 自己開分頁,SPEC §4)。
- **不要在 background 用動態 `import()`**(MV3 service worker 規格禁止,會在真實瀏覽器才炸;一律靜態匯入)。
- **不要用 `executeScript({files})` 注入 content script**:它是 ES module,傳統 script 注入會直接在頁面爆掉
  (AF-3 前這個 bug 讓擴充功能從來沒抓成功過一次);一律走 `background/inject.js` 的 `func` + 動態 `import()`。
- **不要直接呼叫 `chrome.notifications.create`**:一律走 `background/notify.js`(唯一入口,統一圖示、遵守通知偏好)。
  `iconUrl` 必須是 `chrome.runtime.getURL()` 的絕對網址,相對路徑會 404 而讓整則通知不顯示。
- **不要為了讓測試好寫去改寫內建原型**(`String.prototype`/`RegExp.prototype` 都犯過):改測試,不要改實作。
  `tests/a4_conventions.test.js` 會擋住這三類再犯。
- **不要在 background 直接呼叫 `chrome.notifications.create`**:一律走 `background/notify.js`
  (唯一入口、統一圖示、遵守通知偏好)。`iconUrl` 必須是 `chrome.runtime.getURL()` 的絕對網址。
- **不要用 `executeScript({files})` 注入 content script**:它是 ES module,一律走 `background/inject.js`。
- **不要為了讓測試好寫去改寫內建原型**:改測試,不要改實作(`tests/a4_conventions.test.js` 會擋)。
- **不要在 `src/` 寫色碼字面值**:唯一豁免是 `content/picker-mode.js`(網頁沒有載入 theme.css)。
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
- **缺值不補 0、不內插**(SPEC §8.6);抓取失敗一律顯示 `—`,錯誤原因放 `title`。
- 不要在匯出的獨立 HTML 報表放 `<script>` 或任何外部資源(靜態快照,離線可開)。
- 不要在 UI 直接讀 `chrome.storage`(一律經 `shared/storage`),也不要自己解析 alarm 名稱
  (下次執行時間問 background 的 `GET_NEXT_RUNS`,它已排除預檢與重試 alarm)。
- 不要每次渲染就 `addEventListener` 到不會被替換的容器(監聽會累加;用 `onclick` 指派或先移除)。
