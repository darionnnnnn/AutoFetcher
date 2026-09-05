# AutoFetcher 專案規則

Chrome 擴充功能(Manifest V3):在指定網頁上以右鍵選取元素/區塊,依排程自動抓值,
歷史寫成 JSON,並在擴充功能內建的 Report 頁檢視每日紀錄。
**這是地圖不是百科**,細節在 `docs/`。

## 專案結構

```
src/
├── manifest.json        ← MV3;permissions 只加有消費端的
├── background/          ← service worker:排程(chrome.alarms)、開分頁抓取、寫入儲存
├── content/             ← 注入頁面:記錄右鍵目標、產生選擇器、實際擷取、自動登入
├── ui/picker/           ← 右鍵後跳出的設定視窗(命名、時間、抓取模式)
├── ui/report/           ← AutoFetcher-Report 頁(report.html;儀表板版面可自訂,SPEC §8)
└── shared/              ← 型別、儲存 schema、選擇器工具
docs/                    ← SPEC.md 現況規格、BACKLOG.md、archive/
```

- **唯一排程入口**:background 的 alarm handler;content script 不得自己排程。
- **唯一寫入入口**:`shared/storage`;JSON 匯出也從這裡走。

## 文件地圖

- 改任何行為 → `docs/SPEC.md`(現況規格,§編號會被程式碼註解引用,勿拆檔)
- 想做但刻意沒做 → `docs/BACKLOG.md`(每項附觸發條件)
- 本輪規劃 → `docs/AF-<N>-PLAN.md`;完工搬 `docs/archive/`(按需讀,勿全掃)

## 慣例

- 語言:文件與 UI 繁體中文;程式碼識別字英文;無框架、原生 JS(ES module)+ 少量 CSS。
- 測試:`npm test` **基線 293 綠**(Node 內建 test runner + jsdom;下一輪只能增不能減)。
  真實瀏覽器端到端:`./run_smoke.sh`。
- **測試由 Claude 先寫、再委派實作**,而且要做突變測試(把守門那行改壞,確認測試會紅)。
  這一輪靠突變抓到三處同義反覆的測試。
- 分支:`dev` 開發、`master` 由使用者併;每輪一個 `r<N>` 分支。
- 實作委派:先地端 LLM,較複雜給 agy;Claude 只規劃、驗收、寫文件(見 ~/.claude/skills 之委派 skill)。
- 設定/資料的事實來源是 `chrome.storage.local`;檔案一律**使用者手動匯出**,不自動下載(SPEC §5)。
- 訊息型別集中 `shared/messages.js`;三個執行環境的分工見 SPEC §0。

## 不要做

- 不要把帳號密碼存明文於 `storage.sync`(會同步到所有裝置;SPEC §6 規定只放 `storage.local` 並標示風險)。
- 不要用 `setTimeout`/`setInterval` 做排程(MV3 service worker 會被殺;一律 `chrome.alarms`)。
- 不要用 `periodInMinutes: 1440` 做每日排程(日光節約會漂移;每次觸發後重算 `when`,SPEC §4)。
- 不要在帳本之外直接呼叫 `runTask`(同一排程槽會重複抓;冪等靠 `runs[taskId][slot]`,SPEC §4.1)。
- 不要假設抓取時目標分頁已開啟(排程到點由 background 自己開分頁,SPEC §4)。
- **不要在 background 用動態 `import()`**(MV3 service worker 規格禁止,會在真實瀏覽器才炸;一律靜態匯入)。
- 不要用一般 Chrome 跑煙霧測試:152 起已封鎖 `--load-extension`,必須用 Chrome for Testing(見 `run_smoke.sh`)。
- 不要用 `worker.evaluate` 做端到端斷言(service worker 閒置會被回收);從擴充功能頁面做。
- 不要在 UI 模組載入時就讀 storage 或渲染(測試要能自己呼叫 render)。
- 不要用 `innerHTML` 塞入紀錄內容或任務名稱(用 `textContent`)。
- 不要用絕對 XPath 當唯一選擇器(頁面小改就失效;SPEC §3 要求多重選擇器 + 文字錨定)。
