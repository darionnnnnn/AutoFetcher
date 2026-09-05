> 除非必要否則不要讀取 docs/archive/ 內容,避免浪費 token。

# AutoFetcher 規格(目標規格;尚無程式碼,實作後改為現況規格)

## §1 名詞

| 名詞 | 定義 |
|---|---|
| 任務(Task) | 一個「目標頁 URL + 選擇器 + 抓取模式 + 一組時間」的設定單位,使用者命名 |
| 抓取模式 | `text`(單一元素文字)、`number`(文字解析成數值)、`block`(區塊聚合) |
| 紀錄(Record) | 一次抓取結果:`{taskId, scheduledAt, capturedAt, value, raw, status, error?}` |
| 站台設定(Site) | 以 origin 為 key 的登入設定:帳號、密碼、登入頁 URL、欄位選擇器、成功判定 |

## §2 右鍵選單

- `contextMenus` 建立父項「AutoFetcher」,子項:「抓取此文字/數值」「抓取此區塊」「設定此站台登入」「開啟 Report」。
- Chrome 沒有 `getTargetElement`;content script 監聽 `contextmenu` 事件記住最後右鍵的元素,
  background 收到 `onClicked` 後向該分頁要選擇器與預覽值。
- 「抓取此區塊」時,content script 以右鍵元素往上找最近的 `table` / `ul` / `ol` / 含多個同構子節點的容器作為區塊,
  並在頁面上以外框高亮,允許使用者按 ↑/↓ 擴大/縮小範圍後確認。

## §3 選擇器(穩定性)

每個任務儲存多重定位資訊,擷取時依序嘗試,第一個唯一命中者為準:
1. 使用者可見的 `id` / `data-*` 屬性組成的 CSS 選擇器
2. 結構 CSS 路徑(nth-of-type)
3. 文字錨定:最近的標籤文字(如「今日總量」)+ 相對位置
4. 絕對 XPath(最後手段)

三者以上失敗 → 紀錄 `status: "not_found"`,並附當時 DOM 片段前 500 字方便除錯。

## §4 排程與擷取流程

- 排程型別(每任務一種,可多筆):
  - `daily`:`HH:mm` 清單 + 星期勾選(預設每天);alarm `periodInMinutes: 1440`。
  - `interval`:每 N 分鐘(N ≥ 1,暫定),可限定時段(如 09:00~18:00)與星期;alarm `periodInMinutes: N`。
  - alarm 名稱 `<taskId>:<index>`;任務修改/停用時整批重建。
- 時區:一律用瀏覽器本地時間;紀錄同時存 ISO 字串(含 offset)。
- 到點流程:background 開背景分頁(`active:false`)載入目標 URL → 等 `complete` + 額外等待(預設 3 秒,任務可調)
  → 若偵測到登入頁(§6)則先登入 → 注入 content script 擷取 → 寫入紀錄 → 關閉分頁。
- 若使用者已開著同 URL 的分頁,優先直接在該分頁擷取,不另開。
- 補抓:Chrome 未開時錯過的排程,啟動時整理成「錯過清單」(任務、應抓時間),以 `notifications`
  按鈕「立即補抓 / 略過」詢問使用者,Report 頁同時顯示橫幅可逐筆勾選;補抓的紀錄標 `status: "late"`。
  未處理的錯過清單保留到使用者處理或超過 7 天(暫定)自動略過。
- 重試:`not_found` 或逾時 → 2 分鐘後重試一次,仍失敗才寫失敗紀錄並發 `notifications`。
- 同一時刻多任務同站台 → 串行,共用分頁。
- 前景 vs 背景:`chrome.tabs.create({active:false})` 開的分頁 JS 照常執行,但 `document.visibilityState` 為 `hidden`,
  IntersectionObserver 式的 lazy-load、依可見性才啟動的圖表/輪詢**可能不觸發**。
  策略:預設背景;content script 擷取前先 `scrollIntoView` 目標;若同一任務連續 2 次 `not_found`,
  Report 頁提示「改用前景抓取」,任務可勾選 `foreground: true`(抓取時會短暫切換到該分頁,約 3~5 秒)。
- 抓取前可選的「前置動作」清單(暫定):等待某元素出現(逾時 20 秒)、點擊某元素(關閉彈窗、切分頁籤)、
  額外等待 N 秒;動作由使用者在 Picker 內以右鍵點選元素設定。

## §5 儲存

- 主資料:`chrome.storage.local`
  - `tasks: Task[]`、`sites: Record<origin, Site>`、`records: Record<YYYY-MM-DD, Record[]>`
  - 保留天數預設 365,超過自動刪最舊(設定可調)。
- JSON 匯出(預設目錄):
  - 擴充功能無法寫任意本機路徑;採 `chrome.downloads.download({filename:"AutoFetcher/<YYYY-MM>/<YYYY-MM-DD>.json",
    conflictAction:"overwrite", saveAs:false})`,固定落在 Chrome 下載資料夾底下的 `AutoFetcher/`。
  - 用途:`storage.local` 是主資料,日檔是**給 Chrome 以外使用**的副本(備份、Excel/其他程式讀取、換機帶走、
    擴充功能被移除時資料不消失)。
  - 寫入時機(節流):一次抓取後 5 分鐘內(暫定)的所有紀錄合併成一次覆寫;另每日 00:05 alarm 把前一日整檔重寫一次收尾;
    Report 頁可手動「立即匯出」。Chrome 的下載氣泡每次寫入會閃一下,節流後一天最多與排程次數相當。
  - 若使用者變更 Chrome 下載目錄,檔案跟著走;設定頁顯示目前實際路徑(`chrome.downloads.search` 取最近一筆)。
  - 選資料夾(File System Access)與 Native Messaging 皆列 BACKLOG。
- 設定匯出/匯入(換機):
  - 匯出 `autofetcher-settings.json`:`tasks`、`sites`(密碼**預設不含**,勾選「含密碼」時以匯出時輸入的密語 AES-GCM 加密)、
    Report 版面(§8)。不含 `records`(歷史另有日檔)。
  - 匯入:同 `taskId` 覆蓋、新 id 新增;匯入後重建所有 alarms;若含加密密碼則要求輸入密語。
  - 歷史匯入:Report 頁可選多個日檔 JSON 併回 `records`(同 taskId + capturedAt 去重)。
- 日檔 schema:
  ```json
  { "date": "2026-09-05", "tasks": { "<taskId>": { "name": "...", "records": [ {...} ] } } }
  ```

## §6 自動登入

- Site 設定:登入頁 URL、帳號欄/密碼欄/送出鈕選擇器(由使用者在登入頁右鍵「設定此站台登入」逐一點選)、
  登入成功判定(URL 前綴 或 某元素存在)、登入頁判定(URL 前綴 或 密碼欄存在)。
- 密碼只存 `chrome.storage.local`,以 WebCrypto AES-GCM 加密,金鑰存於同一 storage(**僅防誤讀,不防同機惡意程式**;
  設定頁明示)。不使用 `storage.sync`。
- 有 2FA / 驗證碼的站台不支援自動登入;偵測到登入失敗連續 3 次即停用該站台自動登入並通知。

## §7 區塊聚合(block 模式)

- 對象是 HTML 表格的各種寫法,解析為二維陣列 `cells[row][col]`:
  - `<table>`:含 thead/tbody、`rowspan`/`colspan`(展開成實際格子)、巢狀 table 取最內層。
  - `role="grid"/"table"` + `role="row"/"cell"`(ARIA 表格,常見於 React/MUI/AG Grid)。
  - CSS grid / flex 假表格:以「同構子節點」啟發式:容器下重複出現、子節點數相同的元素視為列,其子元素為欄。
  - `<ul>/<ol>`:每 li 一列,以空白/tab 切欄。
  - 虛擬捲動表格(只渲染可視列)只抓當下渲染的部分,並在紀錄註記 `partial: true`。
- 使用者選:軸(`row` = X 軸,取某一列;`col` = Y 軸,取某一欄)、索引(含表頭預覽讓使用者點選)、
  聚合(`max` | `min` | `avg` | `sum` | `count`)。
- 數值解析:去千分位、貨幣符號、百分號、全形數字;無法解析的格子略過並記 `skipped` 數。
- Canvas / SVG 圖表**不在範圍**(見 BACKLOG)。

## §8 Report 頁

- 路徑 `report.html`,由右鍵選單或工具列圖示開啟。
- 兩種檢視:
  - **每日檢視**:左側日期清單(有紀錄的日期),右側該日紀錄表(時間、任務、值、狀態),失敗可展開看錯誤。
    欄位可排序;任務欄順序沿用儀表板版面順序。
  - **儀表板**(使用者自訂版面):每個任務(或任務 × 聚合)是一個「卡片」,使用者決定卡片型別、位置與大小:
    - 型別:`number`(最新值 + 與前一筆差異)、`line`(近 N 天折線,N 可選 7/30/90)、`table`(最近 N 筆)、
      `multi-line`(多任務同圖比較)。
    - 版面:12 欄 CSS grid;卡片寬 3/4/6/12 欄,高 1~3 單位;拖曳排序與調整大小(原生 drag events,不引庫)。
    - 版面存 `storage.local.layout`,隨設定匯出;新任務自動排在最後(寬 4、型別 number)。
    - 可建立多個儀表板頁籤(如「工作」「投資」),各自版面。
- 圖表純 SVG 自繪,不引外部圖表庫。
- 動作:立即抓取、暫停/恢復任務、複製任務、匯出當日 JSON / CSV、匯出/匯入設定、匯入歷史日檔、刪除任務(連同紀錄,需確認)。
- 錯過清單橫幅(§4 補抓)。

## §10 告警

- 任務可設條件:值 > / < / = 閾值、相較前一筆變動超過 X%、連續 N 次抓取失敗。
- 觸發時 `notifications` 通知,並在紀錄標 `alert: true`;Report 每日檢視以顏色標示。
- 同一條件在 60 分鐘內(暫定)只通知一次。

## §11 數值擷取策略與後處理(number 模式)

- 擷取來源(策略鏈,使用者在 Picker 選主策略,其餘為自動備援;紀錄寫入 `strategy_used`):
  1. `auto`:取元素 `innerText` 中第一個數字(預設)。
  2. `regex`:使用者給正則,取第一個群組(如從「餘額:1,234 元」取 `([\d,\.]+)`)。
  3. `attr`:取指定屬性(`value`、`data-*`、`title`、`aria-label`)——SPA 常把精確值放屬性、畫面顯示四捨五入。
  4. `child`:元素內指定子節點(以相對 CSS 選擇器)。
  5. `label`:相鄰標籤錨定——找含指定文字的元素,取其右側/下方第一個含數字的元素(表格「項目 | 值」最常見)。
  - 主策略失敗時依 1→5 順序試其他策略,成功則紀錄標 `status: "fallback"` 並在 Report 提示。
  - 全部失敗或解析不出數字(如顯示「--」)→ `status: "parse_error"`,保留原文 `raw`,**不寫 0**。
- 後處理:乘數(單位換算)、小數位數。
- 解析規則同 §7:去千分位、貨幣符號、百分號、全形數字;負數支援 `-` 與 `(1,234)` 會計格式。

## §9 權限(manifest)

`contextMenus`, `alarms`, `storage`, `tabs`, `scripting`, `notifications`, `downloads`,
`host_permissions: ["<all_urls>"]`(或改為 `optional_host_permissions` 於首次設定任務時逐站授權,見 BACKLOG)。
`downloads` 為 JSON 匯出所需;`notifications` 為失敗/告警/補抓詢問所需。
