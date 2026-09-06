> 除非必要否則不要讀取 docs/archive/ 內容,避免浪費 token。

# AutoFetcher 規格

> 本文是**現況規格**——全部段落都已實作。
> 刻意沒做的東西一律在 `BACKLOG.md`,附觸發條件。

## §0 架構總覽

```
┌──────────────── 目標網頁(任意站台)────────────────┐
│ content script(注入)                               │
│  • 記住最後右鍵的元素                               │
│  • 產生 / 解析四層選擇器(§3)                        │
│  • 擷取:文字 / 數值策略鏈(§11)/ 表格聚合(§7)       │
│  • 自動登入、前置動作(§6)                           │
└──────────────▲───────────────┬─────────────────────┘
   訊息(DESCRIBE / EXTRACT …) │
┌──────────────┴───────────────▼─────────────────────┐
│ background service worker(MV3,事件驅動、隨時會被殺)│
│  • contextMenus:右鍵選單入口(§2)                    │
│  • scheduler:chrome.alarms 建立/重建(§4)            │
│  • fetcher:到點開分頁 → 登入 → 擷取 → 寫紀錄 → 關閉 │
│  • missed:啟動時算錯過清單、發通知(§4)              │
│  • alerts:閾值判定、通知(§10)                       │
└──────────────┬────────────────────────────────────┘
               │ 唯一寫入口 shared/storage(§5)
┌──────────────▼────────────────────────────────────┐
│ chrome.storage.local(主資料)                       │
│  tasks / sites / records(依日期)/ layout / settings │
└──────┬───────────────────────────────┬────────────┘
       │                               │
┌──────▼──────────┐          ┌─────────▼─────────────────────┐
│ ui/picker       │          │ ui/report(AutoFetcher-Report) │
│ 右鍵後的設定視窗 │          │  儀表板(自訂版面)/ 每日檢視     │
│ 命名、排程、策略 │          │  設定頁:匯出 JSON/CSV/HTML、   │
│ 預覽、加入儀表板 │          │  設定匯入匯出、站台登入、偏好   │
└─────────────────┘          └───────────────────────────────┘
```

- **三個執行環境**:content script 只碰 DOM;background 只做排程與流程;UI 頁只讀寫 storage 與發訊息。
  彼此以 `chrome.runtime.sendMessage` 溝通,訊息型別集中在 `shared/messages.js`。
- **資料流**:右鍵 → content 描述元素 → picker 存任務 → scheduler 建 alarm → 到點 fetcher 開分頁擷取 → storage →
  report 讀取呈現;檔案匯出一律由使用者在 report 設定頁手動觸發。
- **無框架、無 bundler**:原生 ES module;三個環境各自一個入口檔。

## §1 名詞

| 名詞 | 定義 |
|---|---|
| 任務(Task) | 一個「目標頁 URL + 選擇器 + 抓取模式 + 一組時間」的設定單位,使用者命名 |
| 抓取模式 | `text`(單一元素文字)、`number`(文字解析成數值)、`block`(區塊聚合) |
| 紀錄(Record) | 一次抓取結果:`{taskId, scheduledAt, capturedAt, value, raw, status, error?}` |
| 站台設定(Site) | 以 origin 為 key 的登入設定:帳號、密碼、登入頁 URL、欄位選擇器、成功判定 |

## §2 右鍵選單與頁面內選取模式

- `contextMenus` 建立父項「AutoFetcher」,子項三個:
  「選取要抓的內容」「設定此站台登入」「開啟 AutoFetcher 報表」。
  (沒有獨立的「抓取此區塊」——區塊由選取模式自動判定。)
- 按下前兩項**不會直接開設定視窗**,而是讓目標頁進入**選取模式**(`content/picker-mode.js`):
  - Chrome 沒有 `getTargetElement`;content script 監聽 `contextmenu` 記住最後右鍵的元素,
    進入選取模式時**它就是預選**,立刻高亮。
  - 滑鼠移動改選;`↑` 擴大到父層、`↓` 沿原路縮回(到 `body` 停住);
    `Enter` 或點擊確認(點擊會被攔截,不會傳給頁面);`Esc` 取消。
  - 右下角面板即時顯示:元素描述、文字預覽前 80 字、偵測到的型別
    (數值 / 文字 / 表格 N 列 × M 欄 / 清單 N 項),判定來自 `shared/block-detect.js`。
  - 選到表格或 CSS 假表格時,滑鼠移到某一格會標示**整欄**(`Tab` 切換成整列),
    點擊即選定該欄/列;此時 locator 仍指向表格容器本身,欄列資訊另外帶回。
  - **一個任務只抓一個元素**:同一頁要抓四張表格的最大值,就是四個任務(各自命名),不是一個任務抓四個值。
- 選到表格類元素時,content 一併算出 **`nameHint`**(表格的 `<caption>` → 目標之前最近的
  `h1`~`h6` → 頁面 `title`,截 60 字)帶進 `PICKED`,Picker 拿它當任務名稱的預設值;
  非表格不帶,由 Picker 退回文字錨定或預覽前 20 字。
- 確認後 content 送 `PICKED` 給 background,由它決定去處(`purpose`):
  `task` 開 Picker 設定視窗、`repick` 直接更新既有任務的 locator、
  `login-*` 轉發給站台登入設定視窗、`preaction` 轉發給 Picker 的前置動作那一列。
  **同一套狀態機,只有確認後的去向不同。**
- overlay 的樣式以 `element.style` 逐項設定(頁面 CSS 會污染 class),
  且 `content/picker-mode.js` 是**全專案唯一允許寫色碼字面值**的檔案——
  網頁沒有載入 `ui/theme.css`。

## §3 選擇器(穩定性)

每個任務儲存多重定位資訊,擷取時依序嘗試,第一個唯一命中者為準:
1. 使用者可見的 `id` / `data-*` 屬性組成的 CSS 選擇器
2. 結構 CSS 路徑(nth-of-type)
3. 文字錨定:最近的標籤文字(如「今日總量」)+ 相對位置
4. 絕對 XPath(最後手段)

三者以上失敗 → 紀錄 `status: "not_found"`,並附當時 DOM 片段前 500 字方便除錯。

## §4 排程與擷取流程

- 排程型別(每任務一種,可多筆):
  - `daily`:`HH:mm` 清單 + 星期勾選(預設每天);每次觸發後重算下一次的 `when`(見 §4.1)。
  - `interval`:每 N 分鐘(N ≥ 1),可限定時段(如 09:00~18:00)與星期。
    **與 `daily` 一樣用 one-shot `when`,不用 `periodInMinutes`**——`periodInMinutes` 的週期起點是
    建立 alarm 的當下,設「08:30~09:20 每 10 分」會落在 08:33、08:43 這種不對齊的時刻,
    而且任何任務改動都會重建全部 alarm、把所有 interval 任務的相位一起重置。
    對齊規則(`background/scheduler.js` 的 `nextIntervalRun`,純函式):
    有時段 → 從時段起點每 N 分鐘,終點閉區間(08:30 08:40 … 09:20);
    沒時段 → 對齊當日 00:00 起的 N 分鐘倍數;
    跨午夜時段(22:00~02:00)→ 凌晨段從 00:00 起、傍晚段從 `from` 起,星期以候選時刻自己所在那天判定。
    算出的時刻必須嚴格大於現在(等於現在要跳下一格),最多往後找 8 天。
  - `weekdays` 缺省或空陣列,在 interval 一律視為**每天**(`nextIntervalRun` 與 `shouldRunInterval` 同一套規則;
    建 alarm 與觸發端若各判各的,會建了 alarm 卻永遠不觸發)。
  - alarm 名稱 `<taskId>:<index>`;任務修改/停用時整批重建。
  - `daily` **不用** `periodInMinutes: 1440`:每次觸發後重新計算下一次的 `when`(用本地時間算),否則日光節約或時區變更會漂移。
  - interval 觸發時,**排程槽取 `alarm.scheduledTime`**(對齊後的時刻)而不是實際觸發時刻,
    晚觸發不會自成新槽,冪等帳本才管得住;時段外觸發時**先排下一次再 return**,否則任務會永遠停擺。
  - **重試 alarm 名稱帶原始槽**(`<taskId>:retry:<n>@<slot>`):重試補的是同一格,
    否則 09:00 失敗、09:05 重試成功會變成兩列,冪等帳本也認不出是同一次排程。
  - **時段判定用 `alarm.scheduledTime`**,不是實際觸發時刻:晚觸發(休眠喚醒、worker 冷啟動)
    會滑出時段末端,把本來排定合法的最後一格丟掉。
  - 補建 alarm 的地方只有兩處(`scheduler.rebuildAlarms` 與看門狗),兩者共用同一個 `nextIntervalRun`。
  - interval 任務**不進錯過清單**(一個週末可累積上百槽,補抓沒有意義);睡醒後從下一個對齊槽繼續。
- **手動抓取(`reason: 'manual'`,來自任務頁與 popup 的「立即抓取」)**與排程觸發走同一個 `runTask`,但四點不同:
  ①**不查也不寫冪等帳本**——手動的 slot 是「當下這一分鐘」,寫進帳本會讓同一分鐘真正排定的 alarm 被擋掉,
  錯過清單也會誤判那一槽跑過;代價是同一分鐘按兩次會有兩筆紀錄(樞紐表同列取最新的成功值)。
  ②**不重試**,任何結果都立刻寫紀錄,使用者才看得到失敗。
  ③**不累加 `notFoundStreak`、不發通知**(使用者正看著畫面)。
  ④`res.status` 照原樣寫入,手動抓到欄位漂移仍是 `fallback`。
  `RUN_TASK` 回傳 `{ok, outcome: 'done'|'failed', status, value, error}`,UI 在按鈕旁就地顯示。
- 時區:一律用瀏覽器本地時間;紀錄同時存 ISO 字串(含 offset)與「排程槽」`slot`(`YYYY-MM-DDTHH:mm` 本地)。

### §4.1 排程穩定性(MV3 的坑與對策)

| 風險 | 現象 | 對策 |
|---|---|---|
| service worker 被殺 | 閒置 30 秒或執行 5 分鐘就被回收,抓到一半消失 | 抓取開始時呼叫一次輕量 API(`runtime.getPlatformInfo`)延壽(**現況只呼叫一次,不是週期性續命**,見 BACKLOG);流程狀態機(`queued → loading → extracting → done`)寫 `storage.session`,worker 重啟時把卡在中途超過 3 分鐘的 run 標 `interrupted` 並重新排入 |
| alarms 在擴充功能更新 / 重新載入後消失 | 更新後所有任務靜默停擺 | `runtime.onInstalled`、`runtime.onStartup` 一律 `rebuildAlarms()`;另有看門狗(下) |
| alarm 觸發不準或重複 | 可能晚 0~60 秒、極少數重複觸發;補抓與正常觸發撞在同一槽 | **執行帳本** `runs[taskId][slot] = status`:同一 `slot` 只執行一次,重複觸發直接略過(冪等) |
| 電腦睡眠 | alarm 在喚醒時才響,可能已晚數小時 | 觸發時算 `late = now - slot`;≤ 任務的 `lateTolerance`(預設 30 分鐘)照抓並標 `late`;超過則進錯過清單交使用者決定(§4 補抓) |
| 看門狗 | 上述任一環節漏掉,沒有人發現 | 固定 alarm `__watchdog` 每 15 分鐘:①確認每個啟用任務的 alarms 存在,缺就重建;②確認 `__sitecheck`(每日站台檢查)還在,不在才補建;③以帳本比對「上次檢查以來應有的槽」,缺的補進錯過清單;④清理超過 3 分鐘的中途 run(`startedAt` 存的是 ISO 字串);⑤記錄一筆心跳 |
| 沒有任何視窗 | macOS 上 Chrome 可在無視窗狀態執行,`tabs.create` 失敗 | 抓取前 `windows.getAll()` 為空時 `windows.create({state:"minimized"})`,用完關閉 |
| 背景分頁被 Chrome 丟棄(discard)/ 省電模式 | 分頁存在但內容被卸載,注入失敗 | `tabs.get` 檢查 `discarded`,是則 `tabs.reload` 再等 `complete`;自開的分頁設 `autoDiscardable:false` |
| 頁面永遠不到 `complete` | 有些頁長連線不結束 | 載入等待上限 30 秒,到時仍嘗試注入擷取;擷取本身逾時 15 秒 |
| 離線 / 網路錯誤 | 抓到錯誤頁 | `navigator.onLine` 為 false 直接排 10 分鐘後重試;HTTP 錯誤頁(`tabs` 的 `status`/標題含 `ERR_`)視同 `not_found` 走重試(2 分鐘、10 分鐘,共兩次) |
| 同時多任務 | 同站台互相干擾、開太多分頁 | 全域佇列,同時最多 2 個站台並行(暫定),同站台嚴格串行 |
| 時鐘/時區變更 | 排程槽算錯 | 看門狗每次比較 `Intl.DateTimeFormat().resolvedOptions().timeZone`,變了就 `rebuildAlarms()` |

- **診斷紀錄**:環形緩衝 500 筆(`storage.local.diag`),記 alarm 觸發、run 狀態轉移、看門狗結果、錯誤;Report 設定頁「排程健康」區顯示:
  每任務下次觸發時間(來自 `alarms.getAll` 實值,不是算出來的)、最近看門狗時間、最近 20 筆診斷、「立即自檢」按鈕(建一個 1 分鐘後的測試 alarm 並回報是否準時觸發)。
- 通知策略:單次失敗不通知(重試中);重試用盡、看門狗發現漏槽、連續 3 次失敗、預檢失敗才通知,避免噪音。

### §4.2 預檢(抓取前提早測試,讓使用者有時間處理)

- 每個排程槽前 `precheckLeadMinutes`(預設 30,任務可調,0 = 關閉)另建一個 alarm `<taskId>:pre:<i>`,到點做**不寫紀錄**的演練:
  1. 開分頁載入目標 URL(同 §4 流程)。
  2. 若站台有登入設定:判定是否在登入頁 → 嘗試自動登入 → 驗證成功判定;失敗即 `login_failed`。
  3. 解析選擇器(§3),確認唯一命中;失敗即 `selector_lost`。
  4. 執行擷取策略鏈(§11)但不存 record;解析不出即 `parse_error`。
  5. 結果寫 `health[taskId] = {at, status, reason, detail}`,並更新燈號(§12);失敗立即通知「○○ 將於 HH:mm 抓取,預檢失敗:無法登入」,
     (**目前只有告警通知點得動**,預檢/站台檢查/找不到元素的通知點擊還沒接,見 BACKLOG。)
- 每日一次的**站台健康檢查**(`background/sitecheck.js`,`__sitecheck` alarm,
  時間取 `settings.siteCheckTime`,預設 08:00):對每個**啟用中**的站台開分頁走一次登入流程,
  結果寫 `health['site:<origin>']`,失敗即通知,提早發現密碼過期、驗證碼新增。
  用完的分頁一定關掉。與每日排程一樣用 `when` 重算,不用 `periodInMinutes`。
- 預檢通過但正式抓取仍失敗 → 走 §4 重試;預檢與正式抓取共用同一段流程碼,只差「是否寫紀錄」旗標。
- interval 任務(每 N 分鐘)不做每槽預檢(太頻繁),只吃每日站台健康檢查與正式失敗回報。
- 預檢用的分頁與正式抓取相同規則(背景、用完關閉);預檢失敗不重試,交給燈號與通知。
- 到點流程:background 開背景分頁(`active:false`)載入目標 URL → 等 `complete` + 額外等待(預設 3 秒,任務可調)
  → 若偵測到登入頁(§6)則先登入 → 注入 content script 擷取 → 寫入紀錄 → 關閉分頁。
- 若使用者已開著同 URL 的分頁,優先直接在該分頁擷取,不另開。
- 補抓:Chrome 未開時錯過的排程,啟動時整理成「錯過清單」(任務、應抓時間),以 `notifications`
  按鈕「立即補抓 / 略過」詢問使用者,Report 頁同時顯示橫幅可逐筆勾選;補抓的紀錄標 `status: "late"`。
  未處理的錯過清單保留到使用者處理或超過 7 天(暫定)自動略過。
- 重試:`not_found` 或逾時 → 2 分鐘後、10 分鐘後各重試一次(共兩次),仍失敗才寫失敗紀錄並發通知。
  `login_failed` 與 `parse_error` **不重試**(重試幾次結果都一樣)。
- 同一時刻多任務同站台 → 串行,共用分頁。
- 前景 vs 背景:`chrome.tabs.create({active:false})` 開的分頁 JS 照常執行,但 `document.visibilityState` 為 `hidden`,
  IntersectionObserver 式的 lazy-load、依可見性才啟動的圖表/輪詢**可能不觸發**。
  策略:預設背景;content script 擷取前先 `scrollIntoView` 目標;若同一任務連續 2 次 `not_found`,
  任務頁顯示提示與一鍵切換,任務可設 `foreground: true`(抓取時切到該分頁,結束後把焦點還給原本那個分頁)。
  成功抓到值一次就把提示清掉。
- 抓取前可選的**前置動作**(`task.preActions`,依序執行,任一失敗即停止並走錯誤路徑):
  `waitFor`(等某元素出現,預設逾時 20 秒,用 `MutationObserver` 不用輪詢)、
  `click`(點某元素:關閉彈窗、切分頁籤)、`wait`(等 N 毫秒)。
  在 Picker 的「前置動作」區設定,要點的元素直接回頁面上選(走 §2 的選取模式)。
- **額外等待秒數**的優先序:呼叫端指定 > `task.extraDelaySec` > `settings.extraDelaySec` > 3 秒。
  `0` 是合法值(代表不等)。

## §5 儲存

- 主資料:`chrome.storage.local`,`schemaVersion` 目前為 **2**
  - `tasks: Task[]`、`sites: Record<origin, Site>`、紀錄以 `rec:<YYYY-MM-DD>` 為鍵
  - 其他鍵:`runs`(冪等帳本)、`missed`、`health`、`diag`、`layout`、`alertLog`、`cryptoKey`、`lastValues`、`lastTrimDate`、`settings`;`storage.session.inflight`
  - 保留天數預設 365,超過自動刪最舊(設定可調);由看門狗執行,一天最多掃一次(`lastTrimDate`),不放在抓取寫入路徑。
- 檔案匯出(**只在使用者手動觸發**,不自動下載):
  - Report 設定頁「匯出」區:選日期範圍(單日 / 本月 / 全部)與格式(JSON 日檔、CSV、獨立 HTML 報表 §8.5),
    按下才呼叫 `chrome.downloads.download`(`saveAs:true` 讓使用者選位置;預設檔名 `AutoFetcher/<YYYY-MM-DD>.json`)。
  - 多日匯出時打包成一個 JSON(`days: [...]`)或多列 CSV,不產生多個下載。
  - **獨立 HTML 報表**:檔名 `AutoFetcher/report-<from>_<to>.html`;內嵌調色盤(取自 `ui/theme.css`)、
    目前儀表板的卡片快照與紀錄表格;**不含 `<script>`、不含任何外部資源**,離線可開、可列印
    (`@media print` 下卡片不跨頁截斷)。
  - 擴充功能無法自行寫任意路徑,自動落地方案(File System Access / Native host)列 BACKLOG。
- 設定匯出/匯入(換機):
  - 匯出 `autofetcher-settings.json`:`tasks`、`sites`(密碼**預設不含**;勾「含密碼」時以匯出時輸入的密語 AES-GCM 加密,見 §6)、
    Report 版面(§8)。不含 `records`(歷史另有日檔)。
  - 匯入:同 `taskId` 覆蓋、新 id 新增;匯入後重建所有 alarms;若含加密密碼則要求輸入密語。
  - 歷史匯入:Report 頁可選多個日檔 JSON 併回 `records`(同 taskId + capturedAt 去重,既有紀錄不被覆蓋);
    也接受打包格式 `{days: [...]}`;回報 `{added, skipped}`;任一日檔形狀不合則整批不寫入。
- 紀錄欄位(除既有的 `taskId`/`slot`/`capturedAt`/`value`/`raw`/`status`/`strategyUsed`/`layer` 外):
  `alert` 與 `alertHits`(§10 命中告警時才有)、`used` / `skipped`(§7 區塊聚合用了幾格、跳過幾格)、
  `partial`(§7 只抓到部分,**只有為真時才寫**)、`error`(失敗原因)、`snippet`(找不到元素時的 DOM 片段)。
- 日檔 schema:
  ```json
  { "date": "2026-09-05", "tasks": { "<taskId>": { "name": "...", "records": [ {...} ] } } }
  ```

## §6 自動登入

- Site 設定:登入頁 URL、帳號欄/密碼欄/送出鈕選擇器(在登入頁右鍵「設定此站台登入」開設定視窗,
  三個欄位各自「在頁面上選取」,走 §2 的選取模式)、登入成功判定(URL 前綴 或 某元素存在)、
  登入頁判定(URL 前綴 或 密碼欄存在)。三個選擇器沒選齊不給存(存了也只會在抓取時失敗)。
- 密碼只存 `chrome.storage.local`,以 WebCrypto AES-GCM 加密(`shared/crypto.js`),
  金鑰自動產生後存於同一 storage(**僅防誤讀,不防同機惡意程式**;設定視窗與設定頁都明示)。
  不使用 `storage.sync`。
- **設定匯出**:預設不含密碼(連密文都不放)。勾「含密碼」時,先用本機金鑰解回明文、
  再用使用者輸入的**密語**重新加密放進 `secrets`;匯入端以密語解開後,**用該機器的本機金鑰重新加密**
  寫成 `passwordEnc`——storage 內任何時候都不留明文。密語錯誤則整批不寫入。
- **舊格式遷移**(`schemaVersion` 1 → 2,`storage.init` 做一次):
  `loginPageUrlPrefix` → `loginCheck`;明文 `password` → 加密成 `passwordEnc` 並刪除原欄位。
- 抓取流程(`background/login.js`,在等待載入之後、注入擷取之前):
  1. 讀**分頁被轉址之後的實際網址**判斷是不是停在登入頁(不是任務設定的網址)。
  2. 站台已被停用 → 直接回 `login_failed`,不再嘗試(避免一直用錯密碼撞帳號鎖定)。
  3. 解密密碼 → 送 `FILL_LOGIN` 給 content:填值並派發 `input`/`change` 事件
     (只設 `value` 對 React 之類的表單無效),再點送出鈕。
  4. 等重新載入完成,依 `successCheck` 判定;成功 `failStreak` 歸零,失敗則累加。
- 有 2FA / 驗證碼的站台不支援自動登入;連續 3 次登入失敗即停用該站台並通知一次。
- `login_failed` 是紀錄狀態之一,**不算成功**,而且**不重試**(密碼錯了重試幾次都一樣)。

## §7 區塊模式:儲存格、欄列聚合、一個任務多個值

- `task.mode = 'block'`;`task.spec` 有三種形狀,擇一:
  - `spec.block = { axis: 'col'|'row', index, headerText, aggregate }` —— 整欄或整列聚合(原有)。
  - `spec.block = { cell: { row: {index, header}, col: {index, header} } }` —— **單一儲存格**
    (列 × 欄交會的那一格,匯率表「美金 × 即期買入」就是這種)。不聚合。
  - `spec.fields = [{ key, cell? , block? }]` —— **一個任務抓多個值**,每個值各自是儲存格或欄列聚合。
- **表頭解析只有一份**:`shared/table.js` 的 `columnHeaders(el)`(與資料欄一一對齊)與
  `rowHeader(row)`(該列第一個非空文字格,跳過國旗圖之類的空格子)。
  `extract.js`、`content/picker-mode.js`、`shared/block-detect.js` 一律用它們,不得各自數表頭。
  **多層表頭**:最後一層決定欄名,上層有 `colspan` 的視為群組,組成「群組 · 欄」——
  匯率表的四個「買入/賣出」因此變成「現金匯率 · 買入」「即期匯率 · 買入」…,
  漂移偵測才分得出是哪一組(舊版把所有表頭列攤平,`indexOf('買入')` 永遠找到第一個,會抓到錯的欄)。
- **定位與漂移**(欄與列同一套規則,`extract.js` 的 `locateByHeader`):
  表頭對得上原索引 → 用它、`ok`;搬家了 → 跟著表頭走、`fallback`;
  **同名表頭有多個時取離原索引最近的那一個**;表頭整個不見 → `not_found`。
  儲存格的欄或列任一為 `fallback`,整格就是 `fallback`。
- **多值的成敗分界**:表格本身解析不出來 → `{ok:false, error:'not_found'}`,這才走重試;
  表格解析得出來就是 `{ok:true, fields:{...}}`,**即使每個值都失敗**——
  欄位漂移不是暫時性問題,重試沒有意義。
- **多值的寫入**(`fetcher.js`):一次載入、一次擷取,每個值各寫一筆紀錄,
  `taskId` 是**子序列 id**、`slot` 全部相同;整組只呼叫一次 `appendRecords` 與一次
  `getRecordsInRange`(每個值各讀寫一遍會讓 N 個值變成 N 倍成本)。
  帳本與 health 寫在**父任務 id** 上,`lastValues` 寫在子序列上。
  health:全成功 `ok` / 有備援或遲到取該狀態 / 部分值失敗 `partial` 並註明幾個 /
  全部值失敗取第一個失敗狀態(紅)。
- `task.fields = [{ key, name, ... }]` 是**顯示用**的值清單(名稱、順序);
  `key` 建立後不變、同任務內唯一、不得含保留字元。改名不改 `key`。
- 解析(`shared/table.js` 的 `parseTable`)→ 聚合(`shared/aggregate.js` 的 `aggregateCells`),
  兩層都是純函式;`extract.js` 的 block 分支串起來,**不走數值策略鏈**。
- **欄位漂移偵測**:`axis: 'col'` 且有 `headerText` 時,先在表頭找它——
  位置與 `index` 相同就照用;不同代表欄位搬家了,**跟著表頭走並標 `fallback`**;
  表頭整個不見則回 `not_found`,不會默默抓到隔壁那一欄。
  列(`axis: 'row'`)沒有表頭可比對,只用索引。
- 對象是 HTML 表格的各種寫法,解析為二維陣列 `cells[row][col]`(只含資料列,表頭另外放 `headers`):
  - `<table>`:含 thead/tbody、`rowspan`/`colspan`(展開成實際格子)、巢狀 table 取最內層。
  - `role="grid"/"table"` + `role="row"/"cell"`(ARIA 表格,常見於 React/MUI/AG Grid)。
  - CSS grid / flex 假表格:以「同構子節點」啟發式:容器下重複出現、子節點數相同的元素視為列,其子元素為欄。
  - `<ul>/<ol>`:每 li 一列,以空白/tab 切欄。
  - 虛擬捲動表格(只渲染可視列)只抓當下渲染的部分,並在紀錄註記 `partial: true`。
- 使用者選:軸(`row` 取某一列 / `col` 取某一欄)與索引——**直接在頁面上點那一欄或那一列**
  (§2 選取模式,`Tab` 切換軸),不是在視窗裡填數字;聚合方式(`max`/`min`/`avg`/`sum`/`count`)在 Picker 選。
- 抓到值時紀錄帶 `used`(用了幾格)與 `skipped`(跳過幾格);`partial` 為真時紀錄標記,
  健康燈號轉黃(抓到值仍算成功)。
- 數值解析:去千分位、貨幣符號、百分號、全形數字、會計負數(半形與**全形**括號);無法解析的格子略過並記 `skipped` 數。
- **整串看起來像日期或範圍時(`09-02`、`2026-09-02`、`10-20`、`5/8`)一律不當數值**——抓到錯的數字是看不見的錯誤,回 `parse_error` 是看得見、使用者可以改設定的錯誤。夾在文字裡的數值不受影響(`09-02 用電 1,234 度` 仍取得到 9)。
- Canvas / SVG 圖表**不在範圍**(見 BACKLOG)。

## §8 Report 頁(AutoFetcher-Report)

### §8.1 結構

- 路徑 `report.html`,**開啟即直接呈現資料**(儀表板為首頁);匯出只是設定頁的一個區塊,不是主要用途。
- 頂部頁籤:**儀表板**(可多個)| **歷史查詢** | **任務** | **設定**。
- 頂部固定一條**日期範圍列**(所有頁籤共用):快捷「今天 / 昨天 / 近 7 天 / 近 30 天 / 本月 / 上月 / 自訂」+ 月曆挑選;
  儀表板所有卡片與歷史查詢都跟著這個範圍;左右箭頭可逐日/逐週往前翻。
- 由右鍵選單、工具列圖示 popup、或 `chrome://extensions` 的擴充功能選項開啟。

### §8.2 儀表板:自訂版面(重點)

**版面模型**

- 每個儀表板 = 12 欄格線 + 卡片清單;卡片 `{id, type, x, y, w, h, source, options}`;`w` 1~12、`h` 1~6(每單位 80px 暫定)。
  新增卡片一律經 `layout-store.addCard`:傳入的 `x, y` 若沒被佔就照用,否則由它找第一個空位(所有呼叫端同一規則)。
- 卡片型別:

| 型別 | 顯示 | 主要選項 |
|---|---|---|
| `number` | 最新值 + 與前一筆/前一日差異(箭頭、百分比) | 小數位、單位、比較基準、閾值色 |
| `line` | 折線(單任務或多任務) | 期間 1/7/30/90 天、聚合(原始/每日最後/最大/最小/平均)、Y 軸範圍 |
| `bar` | 長條(每日聚合) | 同上 |
| `table` | 最近 N 筆(`mode: recent`)或樞紐表(`mode: pivot`,列=時間、欄=任務) | `limit`(兩種模式都吃;最近 N 筆未設預設 10、樞紐表預設 50)、`rowHeader`(樞紐表第一欄標頭,預設「時間」)、`bucketMinutes`(時間容差,見下) |
| `gauge` | 目前值在區間內的位置 | 下限/上限、警戒線 |
| `text` | 標題、說明文字(支援粗體/清單) | 內容 |
| `status` | 每個任務的最後抓取狀態、下次排程時間 | 任務篩選 |

- `source`:一或多個 `{taskId, aggregation}`;同一任務可出現在多張卡片。
  **`source` 的陣列順序就是樞紐表的欄序**(拖曳插入欄位、抽屜的上下移動都是在改它)。

**樞紐表的時間容差合併(`bucketMinutes`)**

- 每筆紀錄的「有效時刻」= `slot`,沒有 slot 就用 `capturedAt`(補抓與手動觸發的紀錄因此也進得了樞紐表)。
  **`slot` 是本地時間字串,`capturedAt` 是 `toISOString()` 的 UTC**,兩者不可直接比字串——
  差一個時區就會分成兩列、比新舊也會判反。換算只有一份:`series.js` 的 `effectiveTimeOf`,
  表格篩選、樞紐分列、`buildSeries` 的日期範圍都用它。
- `0`(預設)= 不合併,時刻相同才同列;正整數 N = 列鍵向下對齊到當日 00:00 起算的 N 分鐘倍數。
  **只從實際出現過的桶產生列**,空桶不成列。
- 同一任務落在同一列的多筆:取 `capturedAt` 最新的**成功**紀錄;一筆成功都沒有就是 `—`;
  儲存格 `title` 註明合併筆數。
- **不做鄰近群聚式的合併**:併哪幾筆會取決於掃描順序,新增一筆會改變既有列的歸屬,結果不穩定。
- `limit` 對樞紐表是「保留最新 N 列」,顯示順序仍由舊到新;**未設定時預設 50 列**
  (長區間的 interval 資料會有上千列)。

**編輯體驗(讓使用者設定時好用)**

1. **在 Picker 就排好**:建立任務的最後一步「加入儀表板」——選儀表板、卡片型別(依模式給預設:
   `text` 模式→`table`,其餘→**只有 `number`**;一個值同時長出數值卡與折線卡會被當成重複)。
   存檔後卡片自動排到版面末端,使用者不必再去 Report 找。
   **`addCard` 會去重**:同一個儀表板內型別相同、來源集合相同(只比 `taskId`,與順序無關)的卡片
   不重複新增,直接回傳既有那張;`source` 為空的卡片(文字卡)不受限。所有呼叫端(Picker、拖曳、範本)同一規則。
   **標題可分辨**:沒有自訂標題時用來源名;同一儀表板內若前面已有同名但不同型別的卡片,
   顯示時補型別後綴(`數值`/`趨勢`/`長條`/`明細`/`量表`/`狀態`),但不寫回 `card.title`。
2. **編輯模式開關**:Report 右上「編輯版面」切換;開啟後卡片可拖曳移動、右下角拉大縮小、拖曳時顯示吸附格線與佔位陰影;
   關閉即瀏覽模式,不會誤動。
3. **卡片設定抽屜**:點卡片右上齒輪,右側滑出抽屜即時預覽:型別切換、來源任務(多選)、期間、聚合、標題、顏色、單位、小數位、閾值色。
   表格卡片另有列軸標頭、時間容差、筆數上限。來源清單中**已選的排在前面並照欄序**,每項附上下移動鈕改欄序。
   所有變更立即套用到卡片,抽屜有「還原」。
   抽屜勾選與下面的拖曳是同一份資料(都寫 `card.source`),兩條路徑不可各存一份。
4. **一鍵排版**:「自動排列」依型別給合理寬度(number 3 欄、line 6 欄、table 12 欄)並填滿空隙;「套用範本」提供三種預設:
   「總覽」(上排 number、下排 line)、「單一指標深入」(大 line + gauge + table)、「多任務比較」(multi-line + 樞紐表)。
5. **多儀表板**:頁籤可新增、改名(空白名稱忽略、前後空白修掉)、排序、複製;每個獨立版面。
6. **復原/重做**:編輯模式內 ⌘Z / ⌘⇧Z,離開編輯模式清空。
7. **響應式**:視窗寬 < 900px 時自動疊成單欄(不改存檔版面)。
8. **版面持久化**:`storage.local.layout = {dashboards:[{id,name,cards:[]}]}`,隨設定匯出;任務刪除時其卡片一併移除。
9. **資料來源側欄與拖曳投放**(編輯模式才顯示,`#source-palette`):列出啟用中的任務,可搜尋,每項都是拖曳來源。
   拖曳一律走 `ui/report/dnd.js`(Pointer Events;命中判定用已註冊目標的矩形,不用 `elementFromPoint`——
   jsdom 沒有它,測不動;**上層目標不接受這個 payload 時要繼續往下找**,否則拖出移除放在別張卡片上會整個落空;
   矩形命中判定只有一份 `isPointInside`,其他模組一律用它)。拖曳要接 `pointercancel`(觸控被接管、視窗失焦時
   只會發它),並比對 `pointerId`(多點觸控時別根手指不可劫持)。
   投放後的結果由純函式 `ui/report/drop-rules.js` 決定,一律經 `layout-store` 寫入並推進復原堆疊;
   沒有造成改變的投放不佔用一步復原。

   | 目標 | 行為 |
   |---|---|
   | `table` | 依放開的 X 位置插入到對應欄之前(**只在樞紐表**算位置:最近 N 筆的表頭是固定四欄,與來源無關);已存在則搬移。表格一律接受投放,否則最後一欄拖不動 |
   | `line` / `bar` | 追加並去重;超過 8 條(`--chart-1~8`)拒絕並在 `#dnd-toast` 說明原因 |
   | `number` / `gauge` | 取代唯一來源;標題等於原任務名稱時跟著換,使用者自訂的標題不動 |
   | `status` | 加入任務篩選清單(`options.taskIds`),去重;移除路徑也要改這個欄位,不是 `source` |
   | `text` | 不接受 |
   | 空白格線 | 建新卡:`text` 模式的任務建 `table`(`mode: recent`),其餘建 `number`;**建在放開的格子**,該處被佔才由 `addCard` 找空位 |
   | 指標壓在不肯收的卡片上 | 什麼都不做,**不可在它底下偷偷長出新卡片** |

10. **拖出移除**:編輯模式下,樞紐表的欄標與折線/長條的圖例各有一個移除把手(`data-remove-source`),
    拖到來源卡片矩形之外放開即移除該來源(放在別張卡片上也算);`status` 清單每一項也有;
    `number`/`gauge` 沒有把手(至少留一個來源)。把手的建法只有一份(`cards.js` 的 `makeRemoveHandle`)。
    樞紐表移除到零欄時**卡片保留**並顯示「拖進來」的空狀態(最近 N 筆模式的表頭是固定四欄,零來源時列出範圍內全部紀錄)。

### §8.3 歷史查詢(查過去任何一天的資料)

- 左側**月曆**:有紀錄的日期打點,點數量以顏色深淺表示,有失敗/告警的日期標紅角;點日期即顯示該日,拖曳可選連續範圍;
  月曆上方可切月、跳到任意年月。
- 右側依所選日期(或範圍)顯示紀錄;兩種表格模式切換:
  - **紀錄列表**:時間 / 任務 / 值 / 狀態 / 策略,欄位可排序、可隱藏,順序可拖曳;失敗列展開錯誤與 DOM 片段。
  - **樞紐表**:列 = 時間、欄 = 任務,一眼比對同一時刻的所有值;欄順序沿用「任務」頁的排序。
    與儀表板表格卡片共用同一個 `pivot()`,但**不吃卡片選項**(列軸標頭、容差、列數上限是卡片層的設定)。
- 篩選:任務多選、狀態(成功/失敗/late/fallback)、只看告警、值範圍(≥ / ≤)、關鍵字(text 模式的內容)。
- 範圍內摘要列:每任務的筆數、最大/最小/平均、首末值差;點任務名跳到只含該任務的折線(期間 = 目前範圍)。
- 單筆紀錄可展開:原文 `raw`、所用策略、錯誤與 DOM 片段、對應的排程時間 vs 實際時間。
- 「與另一天比較」:選第二個日期,樞紐表並排顯示兩天同時刻的值與差異。
- 表格設定(欄位、順序、模式 `tableMode`、篩選)記在 `settings.history`,隨設定匯出;
  URL hash 帶日期、篩選、值範圍、關鍵字、只看告警、分頁與比較日期,可加書籤或重新整理不丟狀態。
- 單筆紀錄展開後可**刪除該筆**(需確認;刪掉當天最後一筆時整個日期鍵一併移除)。
- 紀錄列表與樞紐表都可**複製為 TSV**(貼進試算表);瀏覽器沒有剪貼簿權限時該按鈕隱藏。
- 摘要列的任務名可點,點了在下方畫出該任務在目前範圍的折線(臨時圖表,不會存進版面)。
- 大量資料:一次只載入所選範圍;範圍超過 90 天時表格分頁(每頁 500 筆暫定),摘要仍算全範圍。

### §8.4 任務頁

- 所有任務清單(拖曳排序,此順序是全域預設順序;也是樞紐表的欄序)、啟用開關、下次執行時間、
  最後狀態、**連續失敗次數**與最後錯誤(hover 顯示)、快速動作(立即抓取、編輯、複製、刪除、重新選取)。
- 搜尋框(比對名稱與網址)與「只看失敗」勾選。
- 編輯開同一個 Picker 表單(`picker.html?taskId=<id>`,帶入現值;沒有目標分頁時隱藏「立即測試」)。
- **複製任務**:新 id、名稱加「(副本)」、**預設停用**、不自動加入儀表板。
- **刪除保護**:對話框顯示「將一併刪除 N 筆紀錄」,並提供「先匯出再刪除」(先下載 CSV 成功才刪)。
- **錯過清單橫幅**:列在清單上方,可逐筆勾選補抓或略過(`CATCH_UP_ONE` / `SKIP_ONE`)。
- **重新選取**:開啟該任務的目標頁、等載入完成、注入後直接進入選取模式(§2);啟動失敗才提示改用右鍵選單。
- 下次執行時間一律向 background 詢問(`GET_NEXT_RUNS`),UI 不自行解析 alarm 名稱
  (預檢與重試 alarm 必須排除)。

### §8.5 設定頁

- 匯出:日期範圍 + 格式(JSON / CSV / **獨立 HTML 報表**:單一 .html 內嵌資料與目前儀表板版面,離線可開、可寄給別人)。
- 設定匯出 / 匯入(§5)、歷史匯入(多個日檔 JSON,以 `taskId + capturedAt` 去重)。
- **儲存用量**:目前位元組、紀錄總筆數、最舊日期、上次設定匯出與上次紀錄匯出的時間。
- **排程健康**:每任務下次觸發時間、看門狗最近一次巡檢(取自診斷紀錄)、最近 20 筆診斷、立即自檢。
- **隱私與權限說明**:固定說明不連任何伺服器、資料只在本機,並逐一說明每個權限的用途。
- 站台登入管理(§6):列出每個站台的 origin、帳號、啟用狀態、連續失敗次數、最近一次檢查結果;
  可停用 / 重新啟用(重新啟用會把 `failStreak` 歸零)/ 刪除。頂部固定顯示密碼保護的限度。
  **新增站台**走右鍵「設定此站台登入」開的獨立視窗(`ui/site/site.html`)。
- 偏好:保留天數、通知開關、預設額外等待秒數、**同一告警的通知間隔(分鐘,預設 60)**、**每日站台登入檢查時間(預設 08:00)**、深色模式(跟隨系統 / 亮 / 暗)。

### §8.6 圖表

- 純 SVG 自繪,不引外部圖表庫;hover 顯示值與時間;缺值(失敗)以斷線呈現,不補 0;所有色彩取自 `ui/theme.css` 變數。

## §9 權限(manifest)

`contextMenus`, `alarms`, `storage`, `unlimitedStorage`, `tabs`, `scripting`, `notifications`, `downloads`,
`host_permissions: ["<all_urls>"]`(或改為 `optional_host_permissions` 於首次設定任務時逐站授權,見 BACKLOG)。
`downloads` 為 JSON 匯出所需;`notifications` 為失敗/告警/補抓詢問所需;
`unlimitedStorage` 讓歷史紀錄不受 `storage.local` 預設 10MB 上限限制(保留天數預設 365 天很容易超過)。
另設 `options_page: "ui/report/report.html"`,可從 `chrome://extensions` 的擴充功能選項開啟報表。

`web_accessible_resources`(`content/*.js`、`shared/*.js`,`matches: ["<all_urls>"]`)是**必要的**:
content script 是 ES module,`executeScript({files})` 以傳統 script 注入會拋
`Cannot use import statement outside a module`,注入必須改成 `executeScript({func: (url) => import(url)})`,
而動態 import 只能讀 web accessible 的資源。代價是網頁可以探測本擴充功能是否安裝(列 BACKLOG)。

`icons`(16/32/48/128)與 `action.default_icon` 為必填:通知的 `iconUrl` 只要載不到,
Chrome 會讓**整則通知不顯示**。且 `iconUrl` **必須用 `chrome.runtime.getURL()` 取絕對網址**——
相對路徑會相對於呼叫端的位址解析(service worker 是 `/background/`),在真實瀏覽器一律 404。
所有通知走 `background/notify.js` 這個唯一入口,它同時負責遵守 `settings.notifications` 偏好。

## §10 告警

- 任務可設多條條件(`task.alerts`,每條 `{id, type, value, enabled, field?}`;
  `field` 是值的 `key`,只對該值評估,缺省則對每個值各自評估):
  `gt` / `lt` / `eq`(值大於 / 小於 / 等於)、`deltaPct`(相較**前一筆成功紀錄**變動超過 X%,
  漲跌都算)、`failStreak`(連續 N 次非成功)。判定是純函式 `shared/alerts.js`。
- 評估時機在**寫入紀錄之前**,命中就把 `alert: true` 與 `alertHits: [alertId…]` 一起寫進同一筆紀錄
  (避免報表讀到「紀錄有了、旗標還沒有」的中間態);演練(dryRun)不評估。
- 觸發時發通知;**同一條件 60 分鐘內只通知一次**(`settings.alertCooldownMin` 可調),
  但紀錄一律標記——去重只針對通知。點通知會開報表並定位到該任務那一天。
- Report:月曆對有告警的日期上色(與失敗分開)、歷史列標記並可展開看到命中哪一條、
  「只看告警」可篩選;number 卡片沿用既有的閾值色機制,不另加一套顏色規則。
- `deltaPct` 找不到前一筆成功紀錄、或前一筆是 0 時不命中(除以 0 沒有意義)。
- **多值任務**:去重紀錄(`alertLog`)與通知 id 都用**子序列 id**,兩個值才不會互相把通知吃掉;
  `prevRecords` 也用子序列精確比對——用父任務比對會讓「買入」拿「賣出」的舊值算變動比例。
  通知與訊息裡的名稱用序列名(「臺銀匯率 · 美金賣出」)。

### §2.1 Picker 表單的預設值

- `settings.pickerDefaults = { last, pinned }`,優先序 **`pinned` → `last` → 內建**。
  內建值寫在 `picker.js`(`BUILTIN_DEFAULTS`),**不放進 `DEFAULT_SETTINGS`**——
  `getSettings` 不與預設合併,放進去對舊使用者仍是 `undefined`。
  內建排程是**每天 09:30**(銀行牌告之類的頁面多在九點過後才更新)。
- 每次儲存新任務都更新 `last`;勾了「將此次設定固定為預設值」才另外寫 `pinned`。
  `saveSettings` 是淺層合併,寫 `pickerDefaults` 一律 read-modify-write,否則會把另一半洗掉。
  設定頁的「清除固定的預設值」只刪 `pinned`,保留 `last`。
- **編輯既有任務不套用任何預設值**,也不更新 `last` / `pinned`。
- **進階設定**(策略、正規表達式、生效時段、告警條件、前置動作)收在 `<details id="advanced-section">`,
  預設收合;編輯既有任務且其中有非預設值時自動展開。所有欄位 id 不變,只是換了外層容器。
- 「立即測試」與正式抓取共用同一份規格組裝 `buildSpec(values)`,不得各組一份
  (否則區塊模式的預覽會落回數值策略鏈,測到整張表的第一個數字)。
  編輯既有任務時沒有目標分頁,「立即測試」維持隱藏。

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
- Picker 內「立即測試」按鈕:用目前設定對當前頁面實抓一次並顯示結果與所用策略,存檔前就能確認抓得到。

## §12 工具列圖示燈號與 popup

### §12.1 燈號(`chrome.action`)

- 圖示右下角以 badge 顏色 + 圖示變體呈現整體狀態,取所有啟用任務中**最嚴重**者:

| 燈號 | 條件 | badge |
|---|---|---|
| 🟢 正常 | 所有任務最近一次抓取/預檢成功,alarms 齊全 | 無 badge(或綠點圖示) |
| 🟡 注意 | 有 `fallback` / `late` / `partial`;或有錯過清單待處理;或看門狗補建過 alarm | 黃底,數字 = 注意事項數 |
| 🔴 異常 | 預檢失敗(`login_failed` / `selector_lost` / `parse_error`)、重試用盡、站台自動登入被停用、連續 3 次失敗 | 紅底,數字 = 異常任務數 |
| ⚪ 停用 | 沒有啟用中的任務,或使用者按「全部暫停」 | 灰底「II」 |

- 狀態由 background 的 `health` 匯總;任何 run / 預檢 / 看門狗結束都重算並 `setBadgeText` / `setBadgeBackgroundColor` / `setIcon`。
- 使用者在 popup 或 Report 看過該項(點開)即標已讀,黃/紅計數減少;問題真正解決(下次成功)才回綠。
- **每寫一筆紀錄就寫一次 health**(`fetcher.js` 的 `writeRecord`,全檔唯一一處),對應表由
  `shared/record-status.js` 的 `healthStatusOf` 提供,`background/health.js` 的紅/黃集合也引用同一份,
  不得各自維護:

  | 紀錄 status | health status | 燈號 |
  |---|---|---|
  | `ok` | `ok` | 綠 |
  | `fallback` / `late` / `partial` | 同名 | 黃 |
  | `not_found` | `selector_lost` | 紅 |
  | `parse_error` / `login_failed` | 同名 | 紅 |
  | `error` | `failed` | 紅 |

  **抓取成功會把 health 寫回 `ok`**:曾經失敗過的任務不會再永遠停在紅燈(舊行為只有預檢會清)。
  health 寫在**父任務 id** 上,卡片以子序列 id 當來源時要先取父 id 才查得到。
- `setIcon` 的圖示變體還沒接(見 BACKLOG)。
- 圖示 `title`(滑鼠停留)顯示一行摘要:「2 個任務異常:A 無法登入、B 找不到元素」。

### §12.2 popup

- 點擊圖示:上方燈號摘要;任務清單(名稱、最後值、狀態圖示、下次執行);
  異常項目有「立即重試」「開啟頁面」(開目標 URL 讓使用者自己處理,例如手動登入或看網站改版);
  底部「全部暫停 / 恢復」、「開啟 Report」。
- popup 只讀 storage 與發訊息,不做抓取。

## §13 瀏覽器相容(Chrome + Edge)

- Edge 為 Chromium 核心,`chrome.*` 命名空間與 MV3 API 相同;**同一份程式碼、同一個 manifest**,不分版本。
- 只用 §9 列出的 API,不用 Chrome 專屬或實驗性 API(`sidePanel`、`offscreen`、`declarativeNetRequest` 等一律不引入)。
- Edge 特有行為與對策:

| Edge 機制 | 影響 | 對策 |
|---|---|---|
| 睡眠索引標籤(Sleeping Tabs,預設 2 小時,可設 5 分鐘) | 背景分頁被卸載比 Chrome 積極 | 自開分頁 `autoDiscardable:false`;既有分頁若 `discarded` 先 reload(§4.1 已涵蓋) |
| 效率模式(Efficiency mode) | 背景 JS 節流更重 | 載入等待上限與擷取逾時已放寬;預檢(§4.2)會提早暴露問題 |
| 啟動加速(Startup boost)/ 關閉視窗後仍在背景執行 | 無視窗狀態更常見 | §4.1「沒有任何視窗」對策 |
| `edge://extensions` 載入未封裝 | 路徑不同 | README 兩個瀏覽器的安裝步驟都寫 |
| Edge Add-ons 商店獨立審核 | 上架要分別送 | BACKLOG |

- 驗收:Puppeteer 煙霧腳本以環境變數 `BROWSER_PATH` 指定執行檔,CI/本機各跑一次 Chrome 與 Edge(未安裝 Edge 時自動略過並標示)。
- 使用者可見差異只有一處:設定頁「排程健康」顯示目前瀏覽器名稱與版本(`navigator.userAgentData`)。
