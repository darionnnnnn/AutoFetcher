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

- 時間格式 `HH:mm`,每任務可多筆;以 `chrome.alarms.create(taskId+":"+HHmm, {when, periodInMinutes: 1440})` 建立。
- 到點流程:background 開背景分頁(`active:false`)載入目標 URL → 等 `complete` + 額外等待(預設 3 秒,任務可調)
  → 若偵測到登入頁(§6)則先登入 → 注入 content script 擷取 → 寫入紀錄 → 關閉分頁。
- 若使用者已開著同 URL 的分頁,優先直接在該分頁擷取,不另開。
- 補抓:Chrome 未開時錯過的時間,啟動後只補**當日**錯過的,最多一次,紀錄標 `status: "late"`。
- 重試:`not_found` 或逾時 → 2 分鐘後重試一次,仍失敗才寫失敗紀錄並發 `notifications`。
- 同一時刻多任務同站台 → 串行,共用分頁。

## §5 儲存

- 主資料:`chrome.storage.local`
  - `tasks: Task[]`、`sites: Record<origin, Site>`、`records: Record<YYYY-MM-DD, Record[]>`
  - 保留天數預設 365,超過自動刪最舊(設定可調)。
- JSON 匯出:
  - 擴充功能**無法**寫任意本機路徑。方案:Report 頁用 File System Access API `showDirectoryPicker()`
    讓使用者選資料夾,handle 存 IndexedDB;每次寫入前 `queryPermission`,失效時 Report 頁提示重新授權。
  - 檔名 `AutoFetcher/<YYYY>/<YYYY-MM-DD>.json`,每日一檔;每筆紀錄寫入後即時追加(讀→合併→整檔覆寫)。
  - 授權失效期間紀錄仍在 storage.local,重新授權後一次回填缺的日檔。
  - 備援:設定頁「立即匯出」走 `chrome.downloads` 到 `下載/AutoFetcher/`。
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

- 區塊解析為二維陣列 `cells[row][col]`(table:tr/td;list:每 li 一列,以空白/tab 切欄)。
- 使用者選:軸(`row` = X 軸,取某一列;`col` = Y 軸,取某一欄)、索引(含表頭預覽讓使用者點選)、
  聚合(`max` | `min` | `avg` | `sum` | `count`)。
- 數值解析:去千分位、貨幣符號、百分號、全形數字;無法解析的格子略過並記 `skipped` 數。
- Canvas / SVG 圖表**不在範圍**(見 BACKLOG)。

## §8 Report 頁

- 路徑 `report.html`,由右鍵選單或工具列圖示開啟。
- 左側日期清單(有紀錄的日期),右側該日所有任務紀錄表(時間、值、狀態),失敗紀錄可展開看錯誤。
- 單任務趨勢圖(近 30 天折線),純 SVG 自繪,不引外部圖表庫。
- 動作:立即抓取(手動觸發)、匯出當日 JSON、重新授權資料夾、刪除任務。

## §9 權限(manifest)

`contextMenus`, `alarms`, `storage`, `tabs`, `scripting`, `notifications`, `downloads`,
`host_permissions: ["<all_urls>"]`(或改為 `optional_host_permissions` 於首次設定任務時逐站授權,見 BACKLOG)。
