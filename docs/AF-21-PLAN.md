# AF 第 21 輪規劃：全專案體檢（穩定性／安全／操作直覺／視覺）

> 狀態：實作完成、併回前終檢已處理（分支 `r21`，2914 綠），待換模型收尾體檢後併 dev
> 基準：dev@e930260（2529 綠／v0.19.0）
> 來源：使用者要求的全專案體檢。六份唯讀掃描（background、storage／安全、Picker／站台／popup、Report、content、文件相符）＋ Claude 親自讀碼核對高嚴重度項目。
> 方向（使用者定）：①操作符合直覺、步驟少 ②每天用的功能要穩 ③畫面不只整齊還要好看、一看就知道點哪、不能存要說原因。
> 讀取紀律：`docs/archive/` 未讀。

## 作業總覽

- **委派模型**：**整輪 `impl-low`（Opus＋low）**。開工時查 agy 額度：Gemini 組週額度剩 38%，本輪約 50 段，不足以做完；依使用者指示「agy 額度不足就使用 opus low」與 gemini-delegate/LOCAL.md 本機定案，自第一段起改派 impl-low、整輪不換回。
- **分段粒度**：impl-low 能承擔比 agy 大的段，批次內相鄰且同一機制的階段合併派工（合併方式記在執行紀錄），驗收條件逐條照本文件不減。
- **測試分工**：高風險不變式（鎖、slot、復原、sender、儲存守門）的守門測試由 Claude 先寫；其餘由 impl-low 依本文件驗收條件寫，Claude 逐條核對斷言並突變。
  掃描／終檢 subagent 一律 `scan-low`（Opus＋low）。
- **測試先行**：每段的驗收測試由 Claude 先寫並做突變（備份用 `cp` 到 scratchpad，**不用 `git checkout` 還原**），再交委派。
- **分兩次併 dev**：批次 1～3（穩定性與安全）完成 → 終檢 → 併 dev → 使用者實測；再做批次 4～9。版本號收尾時一次升 `0.20.0`。
- **探針先行**（規劃確認後、寫規格前由 Claude 做，結果回寫本文件「探針結果」節；探針檔用完即刪）：
  - P1 `navigator.locks` 在 service worker 與擴充功能頁之間是否互斥（同一 lock 名）。
  - P2 同一分鐘 10 個不同 origin 任務到點，量 `rec`／`runs` 掉筆率（定量批次 1 的必要性，也當批次 1 完成後的對照）。
  - P3 5000 列表格、已選 100 格時 `mousemove` 單次耗時（批次 7 的基準）。
  - P4 批次選 3 組時選取面板是否把動作列擠出視窗；side panel 360px 下 Picker 底部四顆鈕是否折行。
  - P5 alarm 事件處理函式 `await` 一條超過 5 分鐘的佇列時 service worker 是否被截斷（決定 2-3 的續跑設計要多積極）。
  - 量可見性／節流類探針要拿掉 puppeteer 三個預設旗標（CLAUDE.md 既有規則）。

## 批次總覽

| 批次 | 內容 | 規模 | 相依 |
|---|---|---|---|
| 1 資料層 | 跨環境寫入鎖、`runs` 按日分鍵、`rec` 按小時分鍵、紀錄瘦身、孤兒鍵清理 | 大 | 最先 |
| 2 排程穩定 | daily slot／先排後跑／待辦持久化與續跑／總時限與續命／逾時補齊／通知冷卻／延遲渲染短等待／interval 空窗提示 | 大 | 1 |
| 3 安全與匯入 | 網址 scheme、匯入先驗後寫、sender 守門、WAR 收斂、Blob 匯出 | 中 | 無 |
| —— | **第一次併 dev＋實測** | | |
| 4 儲存與驗證體驗 | **樣式地基（report／popup 改載 `ui.css`）**＋共用「為什麼不能存」元件；Picker／站台／設定頁／抽屜；存檔後立刻抓第一筆 | 大 | 無 |
| 5 狀態可見性 | 燈號語意、popup、任務頁狀態與下一步、空狀態、確認框、篩選語意 | 中 | 4（共用元件） |
| 6 Report 效能 | 依變動日期重畫、圖表抽樣、去抖 | 中 | 1 |
| 7 選取模式 | hover 效能、面板／工具列不擋不溢出、脫離文件守門、提示 | 中 | P3、P4 |
| 8 視覺重設計 | 設計方向、token、元件外觀、圖示、鍵盤可達、詞彙、進階區重排、教學頁同步（樣式地基已在 4-0） | 大 | 4、5 |
| 9 文件 | SPEC 修正與瘦身、CLAUDE.md、BACKLOG | 小 | 最後 |

建議順序：1 → 2 → 3 →（併 dev）→ 4 → 5 → 6 → 7 → 8 → 9。

---

## 批次 1：資料層

### 現況與核對結果

- `runs` 帳本：`fetcher.js:97-109` 每次抓取整包讀寫；全專案沒有刪除點（`deleteTasks` 也不清）。✅ 親核
- `getRecordsInRange` → `listDates` → `get(null)`（`storage.js:313,325`）；多值任務每次抓取無條件呼叫（`fetcher.js:629`），單值在有告警時呼叫（`:166`）。違反 CLAUDE.md「抓取寫入路徑不得掃整個 storage」。✅ 親核
- 讀-改-寫無序列化：`rec:<date>`、`runs`、`health`、`lastValues`、`missed`、`diag`、`tasks`、`sites`、`alertLog`、`session.inflight`；只有 `saveSettings` 與 `fetchTabs` 有佇列。跨 origin 任務並行、UI 頁也會同時寫（`saveTasks`、`deleteRecord`；fetcher 也會 `saveTask` 回寫 `notFoundStreak`，`fetcher.js:664,685,735`）。✅ 結構親核；掉筆率待 P2
- `rec:<date>` 一鍵一天，每寫一筆重寫整天。✅
- 「唯一寫入口是 `shared/storage`」實際被繞過：`fetcher.js`（runs、inflight）、`health.js`、`missed.js`、`watchdog.js`（lastTimezone、inflight）、`main.js`（session 的 repick 鍵）直接碰 `chrome.storage`。✅ grep
- `snippet`（頁面 `body.innerHTML` 前 500 字）寫進紀錄保留一年、JSON 匯出原樣帶出（`selector.js:138` → `fetcher.js:748`）；消費端：歷史頁明細一行（`report.js:610`）、預檢通知的 detail（`precheck.js:147`，即時用、不落地）。✅ grep
- `raw` 無上限（`extract.js:610` 整欄 `join`）；消費端：紀錄、CSV／HTML 匯出、歷史頁、失敗通知 detail、Picker 試抓預覽（不落地）。✅ grep
- locator 的 anchor 文字無上限（`selector.js:88`）。⚠️ 代理回報
- 所有 `rec:` 鍵的解析都在 `storage.js` 內（外部零命中）→ 改鍵結構的影響面被關在一個檔。✅ grep

### 定案

1. **跨環境鎖**：`storage.js` 新增內部 `withLock(name, fn)`——有 `navigator.locks` 用它（service worker 與各擴充功能頁同源、鎖跨環境有效；worker 被回收時鎖自動釋放），沒有（jsdom）退回模組內 promise 佇列。所有讀-改-寫函式經它，鎖名＝storage 鍵名。**鎖內不得再取別的鎖**（`deleteTasks` 這類動多鍵的函式逐鍵依序取放，不巢狀）。`saveSettings` 既有的 `saveQueue` 併進同一機制。
   - **鎖不可重入**：公開函式取鎖、內部 `*Unlocked` 版本不取；鎖內只准呼叫 `Unlocked` 版本（同名鎖再取一次就是死結）。
   - **取鎖最多等 10 秒**〔暫定〕：逾時就不帶鎖照做並寫一筆 diag（`lock_timeout`）——某個卡死的頁面不能讓排程抓取永遠停擺；可用性優先於嚴格互斥。
   - `layout-store.js` 的版面讀-改-寫、`session.runState`（批次 2）同樣經 `withLock`（由 storage 匯出）。
   - **跨兩次呼叫的讀-改-寫鎖不住**：新增 `updateTasks(ids, mutator)`（鎖內讀最新→套 mutator→寫），取代「`getTask` → 改 → `saveTask`」的寫法：`fetcher.js` 三處 `notFoundStreak`、`main.js` 的 repick、任務頁整批啟停／改排程／改名（現在用的是畫面載入當下的舊副本）。Picker 整份存檔維持 `saveTasks`（它本來就重組整個任務）。
   〔暫定：P1 若證實跨環境不互斥，退回「單環境佇列＋UI 寫入改送訊息給 background 代寫」，屆時回寫本節〕
2. **收回唯一寫入口**：上列繞過點全部搬進 `storage.js` 的具名函式；`a4_conventions` 加一條——`src/` 內只有 `shared/storage.js`、`shared/diag.js`、`shared/crypto.js`、`background/fetch-tab.js`（`session.fetchTabs`，自帶佇列）可出現 `chrome.storage.`。`diag.js` 的環形緩衝寫入也要上鎖（同一個 `withLock` 由 storage 匯出給它）。
3. **`runs` 按日分鍵**：`runs:<YYYY-MM-DD>`（日期＝slot 前 10 碼），值 `{ [taskId]: { [slot]: status } }`。介面：查單格、寫單格、取多日。保留 14 天（錯過清單 7 天＋重試餘裕），看門狗每日清；`deleteTasks` 連帶清。
   - 不選「留單鍵＋定期修剪」：每次抓取仍整包讀寫、與其他任務搶同一把鎖。
4. **`rec` 按小時分鍵**：新寫入一律進 `rec2:<date>:<HH>`（HH＝slot 的本地小時；匯入紀錄無 slot 時取 `capturedAt` 換算的本地小時，再沒有就 `00`）。**刻意換前綴**：舊版程式以 `startsWith('rec:')` 認紀錄鍵，沿用前綴的話一旦降版，小時鍵會被當成日期（行事曆出現 `2026-09-18#09` 這種日子）；換成 `rec2:` 降版時新紀錄只是看不到、資料完好，再升級就回來。舊的 `rec:<date>` **不遷移、只讀與刪**：讀取合併「舊日鍵＋24 個小時鍵」，隨保留天數自然到期。
   - 不選「每任務每天一鍵」：讀取要先知道任務 id，匯入的孤兒紀錄與已刪任務會漏讀；小時鍵可由日期直接列舉，不需要索引。
   - 不選「一次性遷移」：要在升級當下重寫全部歷史（MB 級），中途被回收就是半套；雙讀零風險。
   - `getRecordsInRange` 改為**由起訖日期列舉鍵**直接 `get(keys)`，不經 `listDates`；回傳順序契約：先依日期、同日依 `capturedAt` 由舊到新（等同現況的寫入順序）。範圍超過 62 天時先取現有鍵清單再篩（避免一次帶近萬個不存在的鍵）〔暫定數值〕。
   - 需要「所有鍵」的操作（`listDates`、`trimOldRecords`、`deleteTasks`、`countRecordsForTasks`、`getStorageStats`）：有 `chrome.storage.local.getKeys` 就用它，沒有才 `get(null)`；取值時每批最多 50 鍵，不一次把全部紀錄載進記憶體。這些都不在抓取寫入路徑上。
5. **紀錄瘦身**：
   - `snippet` 不進紀錄（兩份寫紀錄白名單都不抄）；歷史頁明細拿掉那一行；立即測試的診斷包（`buildDebug`）照舊帶。既有紀錄裡的 `snippet` 不動、JSON 匯出時剝掉。
   - `raw` 寫進紀錄前截到 500 字並標 `rawTruncated: true`（截斷只在 fetcher 寫紀錄那一層做，擷取端與試抓預覽不截）；歷史頁明細在截斷時標「（已截斷）」。
   - anchor 文字超過 120 字就不產生 anchor 層（既有任務存著的長 anchor 照舊可用，不動）。
6. **孤兒鍵清理**：看門狗一天一次（沿用既有日戳守衛）以目前 `tasks`／`sites` 為準清 `alertLog`、`health`、`lastValues` 裡不存在的任務／站台項目。
7. **schemaVersion 升 3**：`init` 把舊 `runs` 拆成按日鍵（只留近 14 天）後移除舊鍵。設定匯出檔帶 3；匯入接受 ≤3（設定檔不含 `runs`／`rec`，無形狀差異）；**匯入檔的 `schemaVersion` 比目前程式新 → 拒絕並說明要先升級**（`settings-io.js` 目前完全沒看這個欄位）。
8. **升級注意（寫進 SPEC §5 與收尾交接）**：v3 之後不建議降版——舊 `runs` 已拆掉，舊版會看到空帳本（錯過清單可能列出近 7 天的 daily 槽，不會自動重抓）；`rec2:` 的新紀錄在舊版看不到但不會被破壞。第一次併 dev 實測前請先匯出設定與紀錄。

### 改動（階段；每段 1～2 檔＋其測試）

| 段 | 內容 | 主要檔案 |
|---|---|---|
| 1-1 | `withLock`＋既有讀-改-寫函式全部上鎖；`saveQueue` 併入 | `shared/storage.js` |
| 1-2 | `runs` 介面與按日鍵、v3 遷移、保留與刪任務連動 | `shared/storage.js`、`background/fetcher.js` |
| 1-3 | `missed.js`／`health.js`／`watchdog.js`／`main.js` 的直接存取搬進 storage；`diag.js` 上鎖；慣例測試 | 各檔＋`tests/a4_conventions` |
| 1-4 | `rec` 小時鍵：寫入、單日讀、範圍讀、`deleteRecord`、`importRecords` | `shared/storage.js` |
| 1-5 | 全鍵操作改 `getKeys`＋分批；`trimOldRecords`／`deleteTasks`／`count`／`stats`／`listDates` | `shared/storage.js` |
| 1-6 | 紀錄瘦身三項＋歷史頁明細＋匯出剝 `snippet` | `background/fetcher.js`、`shared/selector.js`、`ui/report/report.js`、`shared/export.js` |
| 1-7 | 孤兒鍵清理 | `background/watchdog.js`、`shared/storage.js` |

### 測試／驗收

- 鎖：**不用壓力測試**。把 `chrome.storage.local` 替身包一層「`set` 某鍵時斷言該鍵的鎖正被持有」，任何漏鎖的讀-改-寫當場炸在犯案那一行；突變＝拿掉任一函式的 `withLock`。另一則：兩個交錯的 `appendRecords`（替身在 `get` 與 `set` 之間讓出）後兩筆都在。
- 鎖不巢狀／不重入：替身在「已持有鎖時又請求任何一把（含同名）」時丟例外；`deleteTasks`、`updateTasks`、版面增刪改全流程通過。
- 取鎖逾時：替身讓鎖永不釋放 → 10 秒（測試用假時鐘）後照寫、diag 有 `lock_timeout`。
- `updateTasks`：mutator 執行前另一個寫入改了同一任務的別的欄位 → 兩個欄位都在（突變＝改回用呼叫端傳入的舊副本）；任務頁整批停用不會把剛寫入的 `notFoundStreak` 洗掉。
- 降版相容：鍵名契約測試——新紀錄鍵不以 `rec:` 開頭。
- 直接斷言寫入鍵名的既有測試（grep 為 4 個檔）改寫時逐檔列進執行紀錄。
- `runs`：同格寫兩次冪等；15 天前的鍵被清、14 天內保留；刪任務後各日鍵不含該 id；v3 遷移——舊 `runs` 含 3 天前與 30 天前各一格 → 前者進按日鍵、後者丟、舊鍵移除；**遷移中途失敗（第二次 `set` 丟例外）重跑 `init` 結果相同**（冪等）。
- `rec`：只有舊日鍵／只有小時鍵／兩者並存三種資料下，單日讀、範圍讀、`deleteRecord`、`deleteTasks`、`count`、`trim`、`listDates`、匯入去重結果皆正確；範圍讀的替身**斷言沒有呼叫 `get(null)`**（突變＝改回經 `listDates`）；同日順序依 `capturedAt`。
- 抓取路徑守門：以替身跑單值與多值各一次 `runTask`，全程 `get(null)`／`getKeys` 零次。
- 瘦身：失敗紀錄無 `snippet` 鍵；600 字 `raw` → 紀錄 500 字＋`rawTruncated`，**試抓預覽的 `raw` 仍是全文**（反例，防止截錯層）；JSON 匯出舊紀錄不含 `snippet`；anchor 121 字不產生、120 字產生。
- 鏈結測試（`m2_chain`）：`rawTruncated` 從 fetcher 一路斷言到歷史頁明細文字。
- 什麼算一個／一個都沒有：`getRecordsInRange` 起日晚於訖日回空陣列；`runs` 某日無鍵視為該日無任何格（不是錯誤）。

---

## 批次 2：排程穩定

### 現況與核對結果

- daily 的 slot 取 `new Date()` 的日期（`main.js:228-236,384`）：晚觸發跨日會寫成「隔天 T23:55」、佔住隔天帳本格 → 隔天漏抓。interval 已用 `alarm.scheduledTime`。✅ 親核
  - 連帶：啟動時 `refreshMissed` 算出的錯過槽與 Chrome 補觸發的 alarm 目前 slot 對不上（一個昨天、一個今天）→ 同一格可能補抓兩次。修 slot 後兩者對齊、帳本冪等才真的生效。
- daily 下一次 alarm 排在 `runTask` 之後、外層 `catch {}` 全吞（`main.js:387-399`）。✅ 親核
- 同站台佇列只在記憶體（`fetch-tab.js:237`）；worker 回收後排隊中的任務無紀錄／帳本／重試／missed，`cleanStuckInflight` 只寫 diag（`watchdog.js:87-112`，BACKLOG:57），health 不變 → 綠燈。⚠️ 機制親讀，回收時機待 P5
- `runTask` 無總時限，逐項逾時相加 >3 分鐘；`sleep` 期間無續命（BACKLOG:47）。⚠️
- `login.js` 三處、`frames.js:107` 的 `sendMessage` 無逾時（BACKLOG:66）；`content/main.js` 路由分支除 `handlePreActions` 外無 try/catch。⚠️
- 失敗／預檢／站台檢查通知無冷卻（只有告警有 `alertCooldownMin`）；同頁多任務同槽失敗各跳一則（BACKLOG:121）。⚠️
- `handleMessage` 全域 catch 回 `undefined`（`main.js:757`）。⚠️
- `schedulePrechecks` 每次預檢觸發清光重建全部預檢 alarm；看門狗 `repairMissingAlarms` 不補預檢 alarm。⚠️
- 擷取端 `resolve` 一次失敗就回 `not_found`。⚠️
- interval 任務不進錯過清單（BACKLOG:92 定案不補抓），休眠期間的空窗完全無提示。✅
- `lateTolerance` SPEC §4.1 寫了沒實作（BACKLOG:50）。✅

### 定案

1. **slot 一律取排定時刻**：daily 與 interval 都用 `slotOf(alarm.scheduledTime)`（daily 的 alarm 本來就排在那一分鐘；使用者改時間會 `REBUILD_ALARMS` 重建）。`scheduledTime` 缺省才退回舊算法。
2. **遲到標記**：實際開始抓的時刻比 slot 晚超過 30 分鐘〔暫定；必須大於重試視窗 2＋10 分鐘加單次總時限，否則每一筆重試成功都會變黃燈〕→ 成功的紀錄狀態記 `late`（既有狀態、算成功、黃燈）。這是 `lateTolerance` 的最小實作（固定常數、不開設定），SPEC §4.1 與 BACKLOG:50 同步改寫。
   - **（實作修正）遲到由呼叫端判定**：`handleAlarm` 與 `recoverRunState` 以 `isLateStart(slot, now)` 算好後傳 `markLate` 給 `runTask`；`runTask` 自己不看時鐘（否則所有直接呼叫 runTask 的路徑都會被時鐘影響）。
   - **晚超過 24 小時的 daily alarm 不執行**（電腦關三天，Chrome 只補觸發一次，把今天的值寫進三天前那格沒有意義）：只排下一次，那一格交給錯過清單。
   - 理由：修了第 1 點之後，「23:55 的格子在早上 07:00 才抓到」會被老實寫成昨天那格，不標遲到就是把 07:00 的值當成 23:55 的值。
3. **daily 也先排下一次再執行**；`handleAlarm` 的外層 catch 改成寫 diag（不再靜默）。
4. **待辦持久化**：把「到點待跑／執行中」合併成一份 `session.runState`：`{ '<taskId>@<slot>': { state:'queued'|'running', at, boot } }`，到點當下（進佇列之前）先寫、結束才刪；`boot` 沿用 `fetch-tab.js` 的 `BOOT`。項目另帶 `attempt` 與 `reason`（排程／重試／補抓），續跑時原樣帶回。**手動抓取與試抓不登記**（使用者就在畫面前，UI 端對「訊息通道中斷」要顯示「抓取被中斷，請再試一次」——`sendMessage` 被拒絕的情形，與定案 7 的 `ok:false` 是兩條路，兩條都要有字）。
   - **worker 每次啟動（模組頂層，不只 `onStartup`）與看門狗**掃描「`boot` 不是現在這個」的項目：slot 距今 ≤10 分鐘〔暫定〕→ 經帳本檢查後續跑；超過 → 寫一筆 `interrupted` 紀錄（新狀態，不算成功、紅燈），daily 另進錯過清單（可補抓）。取代既有 `inflight` 與 `cleanStuckInflight`。
   - 啟動時同時跑一次 `cleanOrphanFetchTabs`（不等看門狗 15 分鐘）。
   - 什麼會長得像孤兒卻不是：**同一個 worker 內正在跑的項目**——`boot` 相同一律不碰；同 `boot` 但 `running` 超過總時限＋30 秒才算卡住。
   - 新狀態 `interrupted` 的消費端要全部接上：`record-status`（RED）、`health` 的 `STATUS_TEXT`、歷史頁／任務頁／popup 的狀態文字、匯出。
5. **總時限與續命**：`runTask` 整體 deadline＝150 秒＋任務自己宣告的等待總和，上限 270 秒〔暫定〕；超過記既有的逾時類失敗並走重試。fetcher 內的純等待改用「每 20 秒戳一次 `getPlatformInfo`」的等待函式。前置動作單步 `wait` 與 `hover` 的停留執行時上限各 60 秒（超過照 60 秒跑並在紀錄 `error` 註明；不改使用者存的值）。
6. **逾時補齊**：`sendToFrame`（帶逾時、清計時器）抽成 background 共用，`login.js` 三處與 `frames.js` 探測改用它；`login.js` 的等載入併進 `waitTabReady`（BACKLOG:118 一併收）。`content/main.js` 的訊息路由在分派處統一包 try/catch，例外回 `{ ok:false, error:'content_exception', detail }`。
7. **`handleMessage` 例外**回 `{ ok:false, error }` 並寫 diag；三個 UI 端（popup、Report、Picker）對 `ok:false` 都要有可見的字（逐一 grep 呼叫端）。
8. **通知冷卻與合併**：失敗／預檢／站台檢查通知比照告警記帳——同一任務同一狀態 24 小時內只跳一次〔暫定；已知壞掉的任務一天最多提醒一次〕，狀態改變或恢復成功即重置；同一站台同一輪佇列的多筆失敗合成一則（「example.com 有 3 個任務抓取失敗」）。燈號不受冷卻影響。
9. **預檢 alarm**：觸發時只重排自己那一個；看門狗的補 alarm 涵蓋預檢 alarm；順手清「任務已刪／停用的重試 alarm」（BACKLOG:96）。
10. **延遲渲染短等待**：擷取端 `resolve` 失敗時，用 `waitFor` 同一份等待實作觀察最多 3 秒〔暫定〕再解析一次才回 `not_found`；不重跑前置動作、不改擷取逾時 15 秒。
11. **錯過清單在喚醒後也要算**：`refreshMissed` 目前只在 `onStartup` 呼叫（`main.js:312`，grep 唯一呼叫端）——筆電闔上再打開、瀏覽器沒重啟時，錯過的 daily 槽永遠不會被列出。改成看門狗每輪也呼叫（它靠 `lastSeenAt` 與帳本計算，已有的槽不重複列）〔寫規格前先確認它對重複呼叫是冪等的〕。
12. **狀態文字只留一份**：`record-status.js` 匯出狀態→白話的對照（含新的 `interrupted`），`health.js` 的 `STATUS_TEXT` 與三個畫面各自的文字都改引用它——否則本批與批次 5、8 會在同一批字串上改三次。
13. **interval 空窗提示**：啟動／喚醒時以 `lastSeenAt` 算出每個啟用中的 interval 任務漏了幾格，>0 就在錯過清單放一筆 `kind:'gap'`（「休眠期間略過 N 次」）：進黃燈、只能「知道了」、**不可補抓**（補到的是現在的值，填進過去幾百格是假資料——維持 BACKLOG:92）。`catchUpAll`／`catchUpOne` 必須略過 `gap`。

### 改動（階段）

| 段 | 內容 | 主要檔案 |
|---|---|---|
| 2-1 | slot 取排定時刻＋`late` 標記＋daily 先排後跑＋catch 寫 diag | `background/main.js`、`background/fetcher.js` |
| 2-2 | `runState`（取代 inflight）＋啟動／看門狗復原＋`interrupted` 狀態 | `shared/storage.js`、`background/fetcher.js`、`background/watchdog.js`、`background/main.js` |
| 2-3 | `interrupted` 的消費端（狀態表、文字、匯出、三個畫面） | `shared/record-status.js`、`background/health.js`、`ui/report/*`、`ui/popup/popup.js` |
| 2-4 | 總時限、續命等待、`wait` 上限 | `background/fetcher.js` |
| 2-5 | `sendToFrame` 共用＋login／frames 逾時＋`waitTabReady` 合一 | `background/login.js`、`background/frames.js`、`background/fetch-tab.js` |
| 2-6 | content 路由 try/catch＋延遲渲染短等待 | `content/main.js` |
| 2-7 | `handleMessage` 例外回應＋UI 端顯示 | `background/main.js`＋呼叫端 |
| 2-8 | 通知冷卻與同站台合併 | `background/notify.js`、`background/fetcher.js`、`precheck.js`、`sitecheck.js` |
| 2-9 | 預檢 alarm 只排自己＋看門狗補預檢／清殘留重試 | `background/precheck.js`、`background/watchdog.js` |
| 2-10 | 看門狗呼叫 `refreshMissed`＋interval 空窗（`gap`）＋錯過清單各消費端 | `background/missed.js`、`watchdog.js`、`health.js`、`ui/popup`、`ui/report` |
| 2-11 | 狀態文字單一來源（排在 2-3 之前做） | `shared/record-status.js`、`background/health.js`、三個畫面 |

### 測試／驗收

- slot：alarm `scheduledTime`＝昨天 23:55、現在＝今天 00:05 → 紀錄與帳本都在昨天 23:55 那格、今天 23:55 那格仍空；突變＝改回 `new Date()`。晚 7 小時 → 狀態 `late`；晚 25 分鐘（第二次重試成功的典型值）→ `ok`；晚 25 小時 → 不執行、下一次 alarm 已排、錯過清單有該格；**抓取失敗時不得被改寫成 `late`**（反例）。
- 錯過清單對齊：同一格先被 Chrome 補觸發、再被 `catchUp` 要求 → 只抓一次。
- 先排後跑：`runTask` 丟例外後下一次 daily alarm 仍存在；diag 有一筆。
- `runState`：不同 `boot`＋slot 5 分鐘前 → 續跑一次且帳本只一格；不同 `boot`＋30 分鐘前 → 一筆 `interrupted`、daily 進錯過清單、interval 不進；**相同 `boot` 的 `running` 項目不被碰**（反例）；`session` 為空（瀏覽器重啟）→ 什麼都不做。
- `interrupted` 鏈結測試：從復原寫入 → `health` 紅 → popup 摘要文字 → 任務頁 chip → CSV 匯出，逐站斷言。
- 總時限：替身讓擷取永不回 → 在上限內結束、分頁釋放、佇列下一個任務照跑。
- 逾時：`login.js` 三則與 `frames.js` 一則各自在替身不回應時於上限內失敗；`a4_conventions` 的 D13 旁加一條「background 的 `tabs.sendMessage` 只准出現在共用封裝內」（比對基準數量）。
- content 例外：讓 `extractValue` 丟例外 → 回 `content_exception`，不是逾時。
- 喚醒：`lastSeenAt` 是 9 小時前、無 `onStartup` → 看門狗一輪後錯過清單有該 daily 槽；連跑兩輪不重複列。
- 通知：同狀態 24 小時內第二次不跳、狀態換了會跳、恢復後再壞會跳；同輪 3 筆失敗一則；`notifications:false` 時零則（既有行為不破）。
- 短等待：目標 800 毫秒後才出現 → `ok`；永不出現 → 約 3 秒回 `not_found`（不是 15 秒）。
- `gap`：漏 0 格不產生項目；`catchUpAll` 不對 `gap` 呼叫 `runTask`；「知道了」後黃燈消。

---

## 批次 3：安全與匯入

### 現況與核對結果

- `validateTask` 只驗 `id`／`name`／`url` 非空（`storage.js:117-152`），任何 scheme 都存得進。✅ 親核
- `importSettings` 先寫後驗、`settings` 整包合併（可寫 `retentionDays:0`）、外來 `passwordEnc` 原樣存入；`importRecords` 不驗逐筆形狀；匯入前沒有任何確認或摘要。⚠️＋✅（無確認為 grep 確認）
- `handleMessage` 不驗 sender；`TEST_TASK` 吃整包任務、會開頁與自動登入並回傳頁面內容。⚠️
- WAR 對 `<all_urls>` 開放 `shared/*.js` 全部。✅
- 匯出走 `data:` URL（`export.js:505-510`）。✅
- `getStorageStats` 的退路分支 `JSON.stringify(all)` 含 `cryptoKey`（只拿來算長度，未外流；縱深）。⚠️

### 定案

1. **網址 scheme**：`validateTask` 只收 `http:`／`https:`／`file:`；其餘拒絕。**匯入設定檔時 `file:` 也拒絕**（本機自己用 Picker 建的可以，外來檔不行）。`file:` 保留的理由：有人拿它抓本機儀表板，Chrome 本來就要使用者手動開「允許存取檔案網址」。
2. **匯入先驗後寫**：整份解析→驗證→產生「將新增 N／覆寫 N／略過 N（附原因）」摘要→使用者確認→才寫。摘要另列「N 個站台需要重新輸入密碼」（設定檔不含密碼，團隊部署時每台都會遇到）。`settings` 走白名單與數值域（`retentionDays` 1～3650、`extraDelaySec` 0～60、`alertCooldownMin` 0～1440〔暫定〕）；`passwordEnc` 一律丟棄；任一步寫入失敗要把已寫的鍵還原成匯入前的快照。`importRecords` 逐筆驗 `taskId`（字串、至多一個保留分隔）、`capturedAt`（可解析）、`status`（已知列舉），不合格計入 `skipped` 並回報前 5 筆原因。
   （實作修正：**沒有** `status` 欄位的紀錄照收，只拒絕帶了未知 status 的；同一台機器再匯入沒帶密碼的設定檔時，本機既有站台的密碼沿用、不列入要重輸；網址沒變的 `updateTasks` 不檢查 scheme。）
3. **sender 守門**：`messages.js` 增列「content script 可送的型別」清單；`handleMessage` 開頭判定——`sender.url` 不是本擴充功能來源的訊息只准清單內型別，其餘回 `{ ok:false, error:'forbidden' }` 並寫 diag。判定式：「有 `sender.tab` **且** `sender.url` 不以本擴充功能來源開頭」＝content script（真實的 content script 一定有 `sender.tab`；Report 開在分頁裡也有 `sender.tab`，所以不能只看它；大量既有測試傳空的 `sender`，維持視為擴充功能頁）。新增的訊息型別預設不在清單內（預設拒絕）。
4. **WAR 收斂**到 content 端 import 圖實際用到的檔案；新增慣例測試從 `content/*.js` 起算靜態 import 閉包，與 manifest 清單比對（多列、漏列都紅）。
5. **匯出改 Blob**：`download` 在有 DOM 的頁面用 `Blob`＋`URL.createObjectURL`（下載完成或 60 秒後才 revoke——另存視窗開著時提早 revoke 會讓下載失敗）；呼叫端都在 Report 頁〔寫規格前 grep 確認沒有 background 呼叫端；有的話該處維持 `data:` 並限制大小〕。
6. `getStorageStats` 退路分支先剔除 `cryptoKey` 與 `sites` 再估算。

### 改動（階段）

| 段 | 內容 | 主要檔案 |
|---|---|---|
| 3-1 | scheme 驗證（存檔與匯入兩層） | `shared/storage.js`、`shared/settings-io.js` |
| 3-2 | 設定匯入：驗證、摘要、確認、還原 | `shared/settings-io.js`、`ui/report/settings.js` |
| 3-3 | 紀錄匯入逐筆驗證 | `shared/storage.js` |
| 3-4 | sender 守門 | `shared/messages.js`、`background/main.js` |
| 3-5 | WAR 收斂＋慣例測試 | `manifest.json`、`tests/a4_conventions` |
| 3-6 | Blob 匯出＋stats 剔除 | `shared/export.js`、`shared/storage.js` |

### 測試／驗收

- scheme：`javascript:`／`data:`／`chrome-extension:`／`chrome:` 存檔被拒；`file:` 存檔可、匯入被略過並出現在摘要；**既有 storage 裡已有的怪網址任務不因升級消失**（只在下次存檔時被擋，任務頁顯示原因）。
- 匯入：`retentionDays:0` 被拒並列入摘要；未知設定鍵不寫入；帶 `passwordEnc` 的站台匯入後該欄不存在；第 3 步 `set` 丟例外 → storage 與匯入前位元組相同；使用者按取消 → 零寫入。
- 紀錄匯入：`taskId` 含兩個分隔字元、缺 `capturedAt`、未知 `status` 各一筆 → 全部 `skipped`、其餘照進。
- sender：來源是網頁的 `TEST_TASK`／`RUN_TASK`／`SAVE` 類被拒；清單內型別（`PICKED` 等）照常；**來源是 Report 分頁（有 `sender.tab`）的 `RUN_TASK` 照常**（反例）。鏈結測試確認選取→送出→面板整條不受影響。
- WAR：把 `shared/crypto.js` 加進清單 → 紅；從清單拿掉 `shared/table.js` → 紅。煙霧測試全過（注入失敗只有真瀏覽器看得到）。
- Blob：5MB 內容下載呼叫的 `url` 以 `blob:` 開頭且事後被 revoke。

---

## 批次 4：儲存與驗證體驗

### 現況與核對結果

- Picker `validateForm` 只驗名稱／排程／正規表達式（`picker.js:295-320`）；沒有目標也能存並顯示「已儲存」。✅ 親核
- `#errors` 在捲動區中段（`picker.html:485`），固定列在 `:596-602`；驗證失敗不捲動、不 focus。✅ 位置親核
- 預設名稱四層退路都可能是空字串。⚠️
- 站台「成功判定值」可留空，`startsWith('')` 恆真（`site.js:204`、`login.js:132`）。✅ 親核
- 站台無測試登入（BACKLOG:62）。✅
- 設定頁：`Number('')===0` 直接存（`settings.js:221,243,266`）；無已儲存回饋；匯入成功不重繪；匯出失敗無回饋；站台刪除無確認。✅ 前者親核，其餘 ⚠️
- 抽屜即時套用、關閉再開無法還原。⚠️
- 排程預設兩套（HTML 勾一～五／程式預設每天）；批次試抓期間儲存鈕靜默停用；編輯時「抓完放哪裡」整區消失；未試抓時預覽區空白；停用中提示只在頁首。⚠️

### 定案

0. **樣式地基（先做）**：`ui.css` 目前用元素選擇器（`button`、`label`、`input`、`h2`、`body`）定樣式，直接載進 Report 會改掉整頁外觀；而本批的守門元件、modal、抽屜固定列都要在 Report 裡用到。所以先把 report／popup 改成載入 `ui.css`，並把兩頁自己那份**按鈕／表單／焦點環／`[hidden]`／reduced-motion** 規則刪掉改吃共用的；版面規則從 `report.html` 拆到 `ui/report/report.css`。目標是**外觀盡量不變**（重設計留給批次 8），用真實瀏覽器前後截圖比對。匯出的獨立 HTML 自帶 `<style>`（`export.js:243`），不受影響。
1. **共用「儲存守門」元件**（`ui/save-guard.js`＋`ui.css` 樣式，Picker／站台／抽屜共用）：
   - 固定列正上方有一塊 `role="alert"` 的「還不能儲存」區，逐條列出原因；每條可點 → 捲到該欄、加 `aria-invalid`、focus。
   - **儲存鈕不 disabled**：按下去若有原因，就展開那一塊並跳到第一條（符合專案「停用的控制項不得靜默」）；按鈕旁同步顯示「還差 N 項」。
   - 欄位離開焦點時就地驗證（錯誤字在欄位下方），不等到按儲存。
   - 存檔中按鈕顯示進行狀態並防連按；成功訊息沿用既有 `#save-summary`。
2. **Picker**：
   - 新增守門條件「有目標」（`locator`、`picks`、`block` 至少一項成立；批次模式每一組都要成立）。缺目標時原因句附「回頁面重選目標」動作。
   - 名稱保底：預設名稱為空時給「〈主機名〉的值 N」，確保新任務「什麼都不改就能存」。
   - 固定列分兩層：上層主要動作「儲存」獨占、下層次要動作（立即測試／回頁面重選／取消）；360px 不折行（P4 驗）。
   - 排程預設值只留一份（程式那份＝每天）；HTML 不寫死 `checked`。
   - **存檔後立刻抓第一筆**（新任務才做；手動性質、不寫帳本、不佔排程槽）：現在存完要等到下一個排程時刻儀表板才有東西（Picker 存檔路徑 grep 無任何抓取觸發），新使用者會以為沒成功。儲存回饋顯示「已儲存，正在抓第一筆…」→「第一筆：31.52」或失敗原因＋下一步。批次建立時同站台經既有佇列依序抓。
   - 批次試抓期間儲存鈕改 `aria-disabled`＋就地說明；未試抓的預覽區放一句引導；編輯模式的「抓完放哪裡」改成一行說明＋到儀表板的連結；停用中任務在固定列旁顯示小標記。
3. **站台設定**：
   - 「成功判定值」必填；提供「用目前這一頁的網址」一鍵帶入。**判定值不得與登入頁網址互為前綴**（使用者在登入頁按一鍵帶入的話，送出前就「成功」了）——列為守門原因。
   - 儲存站台時重置該站台的登入失敗計數與 `site:<origin>` 健康項目（改完密碼不該還掛著紅燈）〔寫規格前確認現況〕。
   - **測試登入**：新訊息型別，background 以表單上**尚未儲存**的設定走既有登入流程（經 `fetch-tab` 開背景分頁），回傳逐步結果（開登入頁／找到三個欄位／送出／成功判定），面板就地顯示走到哪一步。密碼只在這一則訊息裡以明文傳給 background，**不得寫進 diag、紀錄、session**（面板在按鈕旁明說「只在這台電腦上測試，不會儲存」）；失敗計數不累加到站台的自動停用計數。經 `enqueueForOrigin` 與同站台排程抓取排隊。**目前已是登入狀態時**老實回報「已經是登入狀態，無法驗證帳密；請先在該站登出再測」而不是回報成功。
   - 刪除站台（設定頁）加二段確認。
4. **設定頁**：維持即時生效。每列右側「已儲存 ✓」瞬時回饋；非法值（空白、超出範圍）**不寫入**、欄位下方說明原因、離開焦點後恢復成上一個有效值。**調低保留天數要先確認**（modal 顯示「會刪除 N 天以前的紀錄」），因為看門狗下一輪就會不可逆地刪。匯入成功後重繪整頁；匯出失敗（含使用者在另存視窗按取消）在按鈕旁說明。
5. **卡片設定抽屜**：改成草稿模型——變更只套到畫面上那張卡（預覽），底部固定「套用／取消」；關閉或 `Esc` 時有未套用變更要問一次。既有「還原」鈕併入「取消」。
   - 草稿只管抽屜自己的欄位（型別、來源、呈現選項）；卡片的位置與大小不在草稿內，照舊即時寫。
   - **抽屜開著時把值拖進那張卡**（拖曳投放會直接寫 `card.source`）：改成併進草稿、不直接寫 storage，否則「取消」會把拖進來的來源一起丟掉、或「套用」把它蓋掉——兩個寫入者搶同一個欄位。
6. **確認框**一律做成真正的 modal（置中、遮罩、焦點移入、`Esc` 關、焦點歸還），共用一份（`ui/modal.js`）；任務刪除、紀錄刪除、站台刪除、匯入確認、抽屜未套用都用它。

### 改動（階段）

| 段 | 內容 | 主要檔案 |
|---|---|---|
| 4-0 | 樣式地基：report／popup 載入 `ui.css`、共用規則去重、拆出 `report.css` | `ui/report/report.html`、`ui/report/report.css`（新）、`ui/popup/popup.html`、`ui/ui.css` |
| 4-1 | 儲存守門元件＋樣式 | `ui/save-guard.js`（新）、`ui/ui.css` |
| 4-2 | Picker 接守門（目標／名稱／排程／正規表達式）＋名稱保底 | `ui/picker/picker.js`、`picker.html` |
| 4-3 | Picker 固定列兩層＋五項小修＋存檔後抓第一筆 | `ui/picker/picker.html`、`picker.js` |
| 4-4 | 站台：判定值必填與一鍵帶入、接守門 | `ui/site/site.js`、`site.html` |
| 4-5 | 測試登入（訊息、background、面板呈現） | `shared/messages.js`、`background/login.js`、`background/main.js`、`ui/site/*` |
| 4-6 | modal 共用元件＋五個使用點 | `ui/modal.js`（新）、`ui/report/*` |
| 4-7 | 設定頁：驗證、回饋、匯入重繪、匯出失敗 | `ui/report/settings.js`、`report.html` |
| 4-8 | 抽屜草稿模型 | `ui/report/drawer.js`、`dashboard.js` |

### 測試／驗收

- 樣式地基：`p4_ui_css` 系列與其他讀 `report.html` 內嵌樣式的掃描型測試改讀新路徑（逐檔列進執行紀錄）；三頁都載入 `ui.css`；popup 有 `[hidden]` 規則；真實瀏覽器前後截圖由 Claude 比對。
- 存檔後第一筆：新任務存檔 → 恰好一次手動性質的抓取、帳本零寫入；編輯既有任務不觸發；抓取失敗時回饋區有原因與下一步。
- 守門：無目標按儲存 → 零寫入、原因區出現「還沒選要抓的內容」、焦點在對應動作上；補上後原因消失且可存。批次 3 組其中一組無目標 → 指名是哪一組。**原因數為 0 時那一塊不佔版面**（`[hidden]` 規則）。
- 名稱保底：預設名稱為空的 ctx 開面板 → 名稱欄非空 → 直接按儲存成功（「零修改可存」的鏈結測試，從 ctx 一路到 `saveTasks` 的引數）。
- 既有任務編輯不受影響：`RUNTIME_FIELDS`（`enabled`／`foreground`）照舊帶過（既有測試不得改寫）。
- 站台：判定值空白 → 不可存並指到該欄；判定值＝登入頁網址或其前綴 → 不可存；已登入狀態下測試 → 回報「無法驗證」而非成功；一鍵帶入填入目前網址。測試登入：四步各自失敗的回報文字不同；**測試後 diag／session／local 全文搜不到測試用密碼字串**；失敗計數不變。
- 設定頁：清空保留天數 → storage 值不變、欄位下有原因、離開後回到舊值；匯入後各欄位顯示匯入值；`download` 丟例外 → 有字、`lastRecordsExportAt` 不更新。
- 設定頁：保留天數 365→30 → 先出確認、取消則值不變。
- 抽屜：抽屜開著時投放一個值到該卡 → storage 不變、草稿來源多一項、套用後才寫入；改型別未套用就關 → 問一次；選取消 → storage 與開啟前位元組相同、畫面上的卡恢復原樣；套用後才寫入一次。
- modal：開啟時焦點在框內、`Esc` 關閉、關閉後焦點回到觸發鈕；背景不可點。

---

## 批次 5：狀態可見性

### 現況與核對結果

- popup 一開就把所有異常標已讀，`computeHealth` 只算未讀 → 全部已讀即回綠（`health.js:77` 註解明寫）；SPEC §12.1 寫「問題真正解決才回綠」，兩者矛盾。✅ 親核
- popup 清單只畫任務，站台異常沒有列、沒有下一步；popup 無教學入口；零任務只有一句話。⚠️
- 任務頁 `.task-row.failed`／`.site-row.failed` 無人加 → 狀態 chip 永遠綠底，原因只在 `title`。✅ grep
- 任務頁無空狀態；手動抓取結果被整份重畫洗掉；刪除確認框在清單底部之外。⚠️
- 「只看告警」實際篩「全部失敗」，真正的 `alertOnly` 無呼叫端（`logic.js:52-55`）。✅ 親核
- 「確定刪除」是藍色主按鈕；任務頁與儀表板沒有主按鈕；日期範圍列在任務頁與設定頁也顯示。⚠️
- `MARK_READ` 不在 `messages.js`。✅
- `setIcon` 圖示變體：圖示檔已在、SPEC §12.1 寫了、程式沒接（BACKLOG:54）。✅

### 定案

1. **燈號語意**（照 SPEC、修程式）：
   - **紅**（資料沒在收）：只要還沒修好就維持紅，與已讀無關；已讀只影響 badge 數字與是否再跳通知。不想管的壞任務＝停用它。
   - **黃**（`fallback`／`late`／`partial`／錯過／`gap`）：可「知道了」——已讀後不再計入燈號，狀態改變才重新亮。理由：純數值標題的任務會天天 `fallback`（BACKLOG:27 刻意接受），黃燈不能消就是永久警報疲勞。
   - popup 開啟**不再自動全部標已讀**；改成每列一顆「知道了」與一顆「全部知道了」。紅項按了「知道了」之後列上標「已知悉・尚未修復」（否則使用者會問「我按了為什麼還是紅的」），並附「停用這個任務」動作。
   - 接上 `setIcon` 圖示變體（紅／黃／綠／灰），badge 數字＝未讀數。
2. **popup**：站台異常畫成列，動作鈕「開啟站台並重設登入」；紅／黃列各有對應下一步（立即重試／開啟頁面／到任務頁重選）；頁尾加「使用教學」（**推翻 AF-18 定案**「教學入口只放右鍵」：那是在沒有零任務引導的前提下定的；新使用者第一個打開的是 popup，不是右鍵選單）；零任務時顯示三步引導＋「在這個頁面選取」主按鈕。
3. **任務頁**：狀態 chip 綠／黃／紅／灰（停用）四態，失敗原因直接顯示成一行小字；失敗列給下一步鈕（重選目標／重設登入／立即抓取，依狀態挑）；空狀態分「完全沒有任務」（右鍵引導＋教學連結）與「篩選後沒有結果」（清除篩選）；最近一次手動抓取結果放模組層、跨重畫保留到下一次該任務的紀錄寫入為止。
4. **歷史頁篩選**：拆成「只看失敗」與「只看告警」兩個獨立條件；網址參數 `alertsOnly=1`（舊連結）對應「只看失敗」（那是它一直以來的實際行為），新參數 `alertOnly=1` 才是告警。
5. **主按鈕分配**：每個畫面一顆——儀表板＝「編輯版面」、任務頁＝零任務時的引導鈕（有任務時不設）、設定頁＝無（即時生效）、確認框＝安全的那顆；刪除類一律 danger 樣式、不當主按鈕。日期範圍列只在歷史與儀表板顯示，儀表板頂部一句說明「卡片的全局區間＝上方日期範圍」。
6. `MARK_READ` 收進 `messages.js`。

### 改動（階段）

| 段 | 內容 | 主要檔案 |
|---|---|---|
| 5-1 | `computeHealth` 新語意＋`setIcon`＋`MARK_READ` 入表 | `background/health.js`、`shared/messages.js` |
| 5-2 | popup：不自動已讀、「知道了」、站台列、下一步、教學入口、零任務引導 | `ui/popup/*` |
| 5-3 | 任務頁：四態 chip、原因行、下一步鈕、空狀態、手動結果保留 | `ui/report/tasks.js`、`report.html` |
| 5-4 | 歷史篩選拆兩條＋網址參數相容 | `ui/report/logic.js`、`report.js`、`report.html` |
| 5-5 | 主按鈕分配、danger 樣式、範圍列顯示規則 | `ui/report/report.html`、`report.js` |

### 測試／驗收

- 燈號：紅項已讀 → 等級仍紅、badge 數字少一；黃項已讀 → 等級回綠；黃項狀態由 `fallback` 變 `late` → 重新亮；任務停用 → 不計。突變＝把紅也改回看已讀。既有 `d5_health` 依舊語意寫的斷言要**逐條改寫並在執行紀錄列出**（不是刪掉）。
- popup：開啟後 `health` 的 `read` 旗標零變動；站台紅燈時清單有該站台列與動作；零任務顯示引導。
- 任務頁：`not_found` 任務 → chip 帶紅色 class、原因文字在 DOM 內文（不是只在 `title`）；手動抓取後觸發一次 subscribe 重畫，結果文字仍在。
- 篩選：一筆 `alert:true` 的成功紀錄＋一筆失敗紀錄——「只看告警」只剩前者、「只看失敗」只剩後者；舊網址 `alertsOnly=1` 還原成「只看失敗」勾選。
- 每個畫面主按鈕數 ≤1（掃 DOM 斷言；**先斷言掃到的按鈕集合非空**）。

---

## 批次 6：Report 效能

### 現況與核對結果

- `subscribe` 去抖 50ms、任何 `rec:` 變動就 `refreshCurrentView`（`report.js:1175`）→ 全量讀紀錄＋重建側欄、頁籤、所有卡片、`resetDnd`、關趨勢浮層（`dashboard.js:987-1180`）。✅ 結構
- 圖表每個資料點一個 `<circle>`＋`<title>`，無點數上限（`charts.js:270-304`）。⚠️

### 定案

1. `subscribe` 的回呼帶出這段去抖期間「變動的鍵集合與日期集合」；Report 只在變動日期與目前檢視範圍有交集、或 `tasks`／`layout`／`health`／`missed` 變動時才動。
2. 儀表板在「只有紀錄變動」時：重讀紀錄一次、只重畫卡片內容；側欄、頁籤、拖曳註冊不動；**編輯模式中、抽屜開啟中、趨勢浮層開啟中延後到關閉後再重畫**。
3. 一般情境去抖 300ms〔暫定〕；使用者自己觸發的操作（手動抓取、刪除）不受去抖延遲影響的觀感由操作端自己先更新畫面。
4. 圖表抽樣：單一序列超過 600 點〔暫定〕時以「每桶取最小與最大」降到上限內（保留尖峰），卡片角落標「已抽樣顯示」；表格與匯出不抽樣。缺值仍不補、不內插（SPEC §8.6）。

### 改動（階段）

| 段 | 內容 | 主要檔案 |
|---|---|---|
| 6-1 | `subscribe` 帶變動集合＋去抖值 | `shared/storage.js` |
| 6-2 | Report 各視圖依交集決定是否重畫；儀表板輕量重畫與延後 | `ui/report/report.js`、`dashboard.js` |
| 6-3 | 抽樣純函式＋圖表接線＋標示 | `ui/report/series.js`、`charts.js`、`cards.js` |

### 測試／驗收

- 檢視範圍是上週、今天的紀錄鍵變動 → 讀紀錄零次、DOM 不變；範圍含今天 → 讀一次、側欄節點是同一個物件（未重建）。
- 編輯模式中收到變動 → 不重畫；離開編輯模式後補一次。
- 抽樣：10000 點含一個尖峰 → 輸出 ≤600 且尖峰值在內；599 點不抽樣、無標示；含缺值的序列抽樣後缺口仍在。

---

## 批次 7：選取模式

### 現況與核對結果（皆 ⚠️，P3／P4 定量）

- `mousemove` 無節流；每次重算整張表、重畫全部已選標示；`kindOf` 單槽快取互相逐出。
- 面板 `maxHeight` 但 body 無高度上限 → 批次多組時動作列可能被擠出視窗。
- 工具列固定右上、不閃避（面板會）。
- 送出前不檢查選取的元素是否還在文件內；`describe` 對已脫離的節點會產生缺根路徑。
- Shift 拉範圍、`Ctrl+A` 無畫面提示；shadow DOM 靜默抓整包；中鍵點連結不受保護；連按「完成」可能被當成頁面雙擊。

### 定案

1. 一次事件內資料列只算一次並往下傳；`kindOf` 改以元素為鍵的弱參照快取（離開選取模式清空）；已選標示改差異更新。**不得改變任何選取語意**（本段是純效能重構，既有選取測試一則都不能改）。**先不做節流**：既有測試都是「派發事件後同步斷言」，把 hover 改成非同步會讓 51 個測試檔的前提失效；P3 改後量測單次 hover 仍超過 16 毫秒才加，而且只准「第一下同步處理、同一影格內後續的合併成一次」這種不破壞同步語意的形式。
2. 面板改直向彈性版面：內容區可捲、動作列永遠可見；工具列比照面板做靠近閃避。
3. 送出（完成／雙擊／`Enter`）前檢查目標與已選表格仍在文件內；不在 → 不送出、面板說「頁面剛剛更新過，請重新點選」並清掉已失效的選取。`describe` 對未連到文件根的節點不產生 `path`／`xpath`。
4. 已選 ≥1 時面板多一行提示「Shift＋點可拉範圍、Ctrl+A 全選」；目標在 shadow DOM 內時面板明說「這個區塊在封閉元件裡，只能整塊抓」；攔截 `auxclick`；overlay 自己按鈕上的 `dblclick` 不觸發送出。

### 改動（階段）

| 段 | 內容 | 主要檔案 |
|---|---|---|
| 7-1 | hover 效能（單次計算、快取、差異標示；節流視 P3 而定） | `content/picker-mode.js`、`shared/table.js` |
| 7-2 | 面板版面＋工具列閃避 | `content/picker-mode.js` |
| 7-3 | 脫離文件守門＋`describe` 守門 | `content/picker-mode.js`、`shared/selector.js` |
| 7-4 | 提示、shadow DOM 告知、`auxclick`、按鈕雙擊 | `content/picker-mode.js`、`ui/help/help.html` |

### 測試／驗收

- 效能以**計數**驗、不以時間驗：一次 hover 事件內「取資料列」的呼叫次數＝1（替身計數；突變＝拿掉傳遞改回各自計算）。P3 探針在改前改後各量一次，數字寫進執行紀錄。
- 既有選取測試（b4、q4、s2、v2、w3 等）零修改全綠。
- 面板：3 組批次下動作列的三顆鈕都在 DOM 且其容器不是可捲區的子孫；P4 探針實機複驗。
- 脫離文件：選了之後把表格節點換掉再按完成 → 零 `PICKED`、面板有提示、已選清空；**連續選兩次**的既有行為測試不破。
- `exitPickMode` 後快取與新狀態全部重設（沿用「連續進出兩次」型測試）。

---

## 批次 8：視覺統一與重設計（套用 `ui-ux-pro-max`）

### 現況與核對結果

- （樣式去重與 `ui.css` 全站載入已在批次 4-0 完成，本批在統一的地基上改外觀。）原始落差：`report.html` 內嵌約 700 行 CSS、`popup.html` 另一份，皆未載入 `ui.css`（BACKLOG:39）；按鈕內距、字級、主按鈕文字色（`var(--bg)`／`white`／`var(--text)` 三種）、焦點環偏移各不相同；report 無 `prefers-reduced-motion`；popup 無 `[hidden]` 規則（違反專案慣例）。✅
- popup `#pick-here` 亮色是深色字配藍底（`popup.html:122-130`）。⚠️ 實機複驗
- 同一概念多種叫法（聚合／合成；立即測試／試抓／全部試抓）。⚠️
- 常用的前置動作收在進階、少用的「固定為預設值」常駐在外。⚠️

### 定案

1. **設計方向**（`ui-ux-pro-max` 查詢結果取其適用部分；它推薦的「誇張極簡／大字級登陸頁」樣式不適用工具型介面，不採用）：
   - 定位：資料監控工具——密度高、動效克制、資訊層級靠字重與留白而非色塊。
   - 色彩沿用既有藍（資料）＋琥珀（警示）雙軌；新增 token：`--on-primary`（主按鈕文字，亮暗兩軌都對主色 ≥4.5:1）、`--primary-strong`（暗色軌實心按鈕底色，解決暗色主色配白字對比不足）、`--text-subtle`（第三層文字）。**新增的亮色變數放第一個 `:root`，並同步 `export.js` 的硬編碼退路**（既有規則）。
   - 字體維持系統字體堆疊（擴充功能頁與匯出檔不得載外部資源），數值用既有 `--font-mono` 並開等寬數字。
   - 圖示一律內嵌 SVG，不用 emoji（齒輪、把手等現有符號字元換掉）。
   - 互動：可點元素 `cursor:pointer`、hover／active／focus-visible 三態齊全、過場 150～200ms、`prefers-reduced-motion` 全站關過場。
2. **元件清單（只存在於 `ui.css`，全站共用）**：按鈕四種（主要／次要／文字／危險）、表單欄位（標籤在上、說明在下、錯誤在欄位下）、狀態 chip 四態、橫幅（資訊／警示／錯誤）、空狀態（圖示＋一句話＋一個動作）、固定動作列、modal、就地回饋（「已儲存 ✓」）。report 與 popup 已在批次 4-0 改載 `ui.css`，本批把元件選擇器從元素選擇器（`button`、`label`）逐步收成類別、各頁樣式表只留版面；**`ui.css` 不留沒有頁面使用的類別**（既有規則，掃描測試守）。
3. **匯出的獨立 HTML 不得因為樣式搬家而缺規則**：匯出用到的卡片樣式來源在寫規格前先 grep 釐清（目前 `export.js` 自帶樣式＋抓 `theme.css` 第一個 `:root`），搬移後 `k1_html_report` 系列須零修改全綠。
4. **詞彙表**（全站一份，收在 `describe.js` 或新的常數檔，三端共用）：「合計方式」（取代聚合／合成）、「試抓」（取代立即測試／先試抓看看；批次為「全部試抓」）、「值」與「任務」的用法固定（一個任務可以有多個值）。
5. **Picker 進階區重排**：前置動作提到主區「抓什麼」之下（收合成一行「抓之前要先點什麼嗎？」，展開才是編輯器）；試抓失敗且沒有前置動作時主動提示；「固定為預設值」從常駐列移除，改成存檔成功回饋裡的一句「下次新任務沿用這組排程與去處」動作。
6. **教學頁同步**：所有改名的按鈕與流程（詞彙、固定列兩層、測試登入、「知道了」、點齒輪開卡片設定）更新 `help.html`；`y5_help_page` 的 `data-ui-label` 跟著改。
7. **鍵盤可達**：歷史頁的日曆格與可展開的紀錄列目前是掛 `click` 的 `<td>`／`<tr>`，鍵盤到不了；改成按鈕語意（可聚焦、`Enter`／空白鍵觸發、`aria-expanded`）。頁籤補 `role="tab"`／`aria-selected`（現在 active 狀態只靠 CSS）。
8. 各頁驗收寬度：side panel 320／360／480px；popup 固定寬；Report 900px 斷點上下各一。

### 改動（階段）

| 段 | 內容 | 主要檔案 |
|---|---|---|
| 8-1 | token 新增＋`export.js` 退路同步＋`ui.css` 元件補齊 | `ui/theme.css`、`ui/ui.css`、`shared/export.js` |
| 8-2 | popup 外觀與版面 | `ui/popup/*` |
| 8-3 | Report 外觀（分兩段：導覽與任務／設定頁、儀表板與歷史頁）＋鍵盤可達 | `ui/report/report.css`、`report.js` |
| 8-4 | 圖示 SVG 化 | `ui/report/cards.js`、`dashboard.js` 等 |
| 8-5 | 詞彙表與三端替換 | `shared/describe.js`、`ui/picker/*`、`ui/report/*`、`content/picker-mode.js` |
| 8-6 | Picker 進階區重排＋預設值動作搬家 | `ui/picker/*` |
| 8-7 | 教學頁同步 | `ui/help/help.html`、`tests/y5_help_page` |

### 測試／驗收

- `p4_ui_css` 擴充：`src/ui/**` 的 HTML 內嵌樣式與 CSS 檔零色碼字面值（豁免清單不變）；三個頁面都載入 `ui.css`；每個 UI 樣式來源都有 `[hidden]` 規則；`ui.css` 每個類別至少被一個頁面使用（**先斷言掃到的類別集合非空**）。
- 對比：以 token 值計算 `--on-primary` 對 `--primary`／`--primary-strong`、`--text-muted` 對 `--surface` 的對比 ≥4.5:1，亮暗各一組（純函式測試；突變＝把 token 改淡）。
- 詞彙：舊詞在 `src/` 的出現數相對基準歸零（**比對基準數量、不得為過驗收改寫無關程式碼**）。
- 視覺驗收由 Claude 在真實瀏覽器逐頁截圖（亮／暗 × 各寬度）附在執行紀錄，交使用者過目——這一批「好不好看」無法機器判定，明列為人工驗收。
- 煙霧測試全過（樣式搬遷最容易在真瀏覽器才壞）。

---

## 批次 9：文件

1. SPEC 修正：§12.1 `setIcon`（批次 5 後成為現況）、§13 瀏覽器版本顯示（刪除該句）、§11 `strategyUsed` 與策略下拉兩項、§1 Record 補 `label`／`excluded`／`rawTruncated`、拿掉 `snippet`、§0 架構圖改側邊面板、§5 鍵清單補 `lastSeenAt`／`lastTimezone`／`runs:<date>`／`rec2:<date>:<HH>`／`session.runState`、§4.1 `late` 與 `interrupted`、§12.1 燈號新語意、訊息型別補齊。
2. SPEC 瘦身：§2、§4、§7 的「推翻史」與探針事實表搬 `docs/archive/SPEC-decisions.md`，正文只留現況；**§ 編號不動**（程式註解引用 14 種，搬完 grep 逐一確認仍存在）。
3. CLAUDE.md：結構表（新檔 `ui/save-guard.js`、`ui/modal.js`、`report.css`、`help.js`）、新規則（鎖不巢狀、`chrome.storage` 白名單、`sender.url` 判定、`rec` 雙讀、`runState`、燈號語意、儲存守門與 modal 唯一入口、詞彙表唯一來源）、測試基線數。
4. 設定頁「排程健康」的自檢結果加列近 7 天的 `interrupted`、`lock_timeout`、`forbidden` 次數（取自 diag）——這三種是本輪新增的靜默保護，管理的人要看得到它們有沒有在發生。新增的 diag 類型**不得在正常運作時每次抓取都寫**（環形緩衝只有 500 筆）。
5. BACKLOG：劃掉本輪做掉的（:31、:38 敘述、:39、:47、:50、:54、:57、:62、:66、:96、:118、:121）；新增「`rec` 舊日鍵在保留天數設為永久時永遠留著（只讀，無害）」「選取模式 `isTrusted` 守門」「preselect 的『位置已變』說出從第幾欄搬到第幾欄」等本輪明確不做的項目與觸發條件。

---

## 明確不做（本輪定案）

| 項目 | 理由 | 去處 |
|---|---|---|
| 選取模式事件的 `isTrusted` 檢查 | 頁面腳本偽造雙擊只能讓選取提早送到面板，**使用者仍要在面板按儲存**才會成為任務，影響是干擾不是入侵；而 jsdom 的合成事件一律 `isTrusted:false`，51 個測試檔的進入點都要改走函式參數，改動面與風險遠大於收益。 | BACKLOG，觸發：有站台實際干擾選取時 |
| interval 任務補抓 | 補到的是「現在」的值，填進過去數百格是假資料；本輪改做空窗提示（批次 2 定案 13）。 | 維持 BACKLOG:92 |
| `cryptoKey` 改不可匯出 | 金鑰要以 base64 存回 `storage.local` 才能跨 worker 生命週期使用，必須可匯出；保護程度「僅防誤讀」是 SPEC §6 已載明的取捨。 | 不動 |
| `rec` 舊日鍵一次性遷移 | 見批次 1 定案 4。 | 不做 |
| 上架相關（逐站權限、i18n、單一 bundle） | 觸發條件未成立。 | 維持 BACKLOG |
| preselect「（位置已變）」的具體差異說明 | 低頻、只影響重選當下的提示；擷取端已有 `fallback` 黃燈。 | BACKLOG，觸發：有人反映看不懂位置變了什麼 |
| Shadow DOM 內選取 | 本輪只做「明說選不到」；真的支援要改四層定位。 | 維持 BACKLOG:58 |

## 探針結果

- **P1 鎖跨環境（2026-09-19，Chrome for Testing 152）**：擴充功能頁持有 `navigator.locks` 的鎖時 service worker 等了 2698ms、反向 1696ms（持有時間 3s／2s）→ **同一擴充功能來源的頁面與 worker 互斥成立**，批次 1 定案 1 採主方案。`AbortSignal.timeout` 可中止等待（回 `TimeoutError`）→ 取鎖逾時用它。`chrome.storage.local.getKeys` 在 worker 與頁面都存在 → 批次 1 定案 4 採用。
- **P2 掉筆率**：不做。P1 證實鎖可用後，批次 1 以「漏鎖當場炸」的替身守門取代定量（壓力量測不當偵測器，見 plan-before-dev §拆分原則）。
- **P5 長佇列截斷**：不做獨立探針。批次 2 的 `runState` 復原本來就同時處理「被截斷」與「被回收」，兩者的使用者可見結果相同（續跑或 `interrupted`）；煙霧測試加一條「worker 重啟後佇列項目被續跑」取代。
- **P3 大表 hover（2026-09-19，改動前）**：5000 列×6 欄的表，滑鼠在表內移動 40 次——沒選任何格時長任務總和 6725ms（平均約 170ms、最長 305ms）；已選 20 格後 16023ms（平均約 400ms、最長 497ms）。**畫面凍結成立**，批次 7 段 A 以此為基準（目標降到 1/10 以下、單次不超過 100ms）。
- **P4 批次三組面板**：三張表各選 4 個值、視窗高 600 時面板 240px、完成／取消在畫面內——**這個量沒有溢出**；但每組 chip 清單各自 `maxHeight: 40vh`，三組值多時理論上合計超過 100vh。段 B 仍改成單一捲動區（成本低、消掉這條路），驗收改用每組 12 個值實測。

## 規劃完成後複檢

初稿完成後由 Claude 以四種角度、六條使用者走查、最後整體視角重看一遍；以下每條都已回寫上文（括號是落點）。

**整體專案角度**
- 降版風險：小時鍵沿用 `rec:` 前綴會被舊版當成日期 → 換 `rec2:` 前綴＋升級注意（批次 1 定案 4、8）。
- `ui.css` 用元素選擇器，載進 Report 會改掉整頁；而批次 4 的守門／modal／抽屜固定列就要在 Report 用 → 樣式地基從批次 8 前移成 4-0（批次 4 定案 0）。
- 狀態文字散在 `health.js` 與三個畫面，本輪有三個批次會動它 → 先收成一份（批次 2 定案 12）。
- 抽屜改草稿模型後，拖曳投放成了同一欄位的第二個寫入者 → 併進草稿（批次 4 定案 5）。
- 教學入口放 popup 與 AF-18 定案衝突 → 明寫推翻與理由（批次 5 定案 2）。

**程式面角度**
- 鎖不可重入、跨兩次呼叫的讀-改-寫鎖不住（`getTask`→改→`saveTask` 共 4 處＋任務頁整批操作用舊副本）→ `Unlocked` 內部版與 `updateTasks`（批次 1 定案 1）。
- 取鎖沒有上限會讓一個卡死的頁面拖垮排程 → 10 秒逾時照做＋diag。
- `late` 門檻 10 分鐘會讓每筆重試成功變黃燈 → 30 分鐘；晚超過 24 小時不執行。
- hover 改非同步會讓 51 個測試檔的同步斷言失效 → 先不節流，只做單次計算與快取（批次 7 定案 1）。
- sender 判定只看 `sender.tab` 會誤擋 Report；只看 `sender.url` 會誤擋傳空 sender 的既有測試 → 兩者合取（批次 3 定案 3）。
- `refreshMissed` 只有 `onStartup` 呼叫，闔上筆電再打開不會算錯過 → 看門狗也呼叫（批次 2 定案 11）。
- Blob 提早 revoke 會讓另存視窗中的下載失敗。

**尖銳使用者角度**
- 「按了知道了為什麼還是紅的」→ 列上標「已知悉・尚未修復」＋停用動作。
- 「壞掉的任務一天吵我四次」→ 冷卻 6 小時改 24 小時。
- 「天天 fallback 的任務讓我永久黃燈」→ 黃燈可知悉、紅燈不可（批次 5 定案 1）。
- 「我只是把保留天數改小，歷史就沒了」→ 調低要確認。
- 「存完了儀表板還是空的」→ 存檔後立刻抓第一筆。
- 「在登入頁按一鍵帶入，結果永遠判定成功」→ 判定值不得與登入頁互為前綴。
- 「我已經登入了，測試登入說成功，其實密碼是錯的」→ 已登入時回報無法驗證。
- 「密碼被傳來傳去？」→ 按鈕旁明說只在本機、不儲存；測試斷言搜不到密碼字串。

**管理者角度**
- 升級前備份、不建議降版、匯入檔版本較新要拒絕。
- 團隊部署：匯入摘要列出要重輸密碼的站台。
- 新增的靜默保護（`interrupted`／`lock_timeout`／`forbidden`）要在排程健康看得到次數；新 diag 類型不得每次抓取都寫。
- 本輪不新增任何使用者設定鍵（冷卻、門檻都是常數）——設定頁不再變長。
- Edge 在開發環境啟動不了（前幾輪既有狀況），煙霧只跑 Chrome，Edge 請使用者實測。

**使用者走查（規劃下的操作是否走得通）**
1. 新使用者：popup 零任務引導 → 在這頁選取 → 點一格 → 完成 → 面板名稱已帶、排程與去處有預設 → 儲存 → 立刻看到第一筆。全程不需要填任何欄位。✔
2. 要登入的站：右鍵設定站台 → 三個欄位點選 → 帳密 → 一鍵帶入判定值（在登入後頁面按才有效，在登入頁按會被擋並說明）→ 測試登入逐步回報 → 儲存。✔
3. 筆電闔上過夜：07:00 打開 → 23:55 的 alarm 補觸發 → 寫進昨天那格、標 `late` 黃燈、可按知道了；其他錯過的槽在看門狗第一輪（15 分鐘內）進錯過清單。✔
4. Report 整天開著：紀錄變動只在檢視範圍含今天時重讀一次；編輯版面或抽屜開著時不被打斷。✔
5. 管理者匯入設定到新機器：看到摘要（新增／覆寫／略過原因／要重輸密碼的站台）→ 確認 → 任一步失敗還原。✔
6. 同站台 30 個任務同分鐘：佇列依序、每個有總時限、worker 被回收後續跑或記 `interrupted`；排在後面的超過 30 分鐘才開始就標 `late`——如實。✔（P5 決定續跑要多積極）

**整體視角**
- 既有測試會被改寫的三塊：直接斷言 `rec:` 鍵名的 4 個檔、`d5_health` 的已讀語意、讀 `report.html` 內嵌樣式的掃描型測試與介面字串。三塊都要求「逐檔列進執行紀錄、改寫不刪除」，總數只增不減。
- 批次之間同檔交會：`storage.js`（1、2、3、6 都動）→ 依批次順序串行、不並行委派；`report.html`（4-0、5、8）→ 4-0 先拆檔後，5 與 8 動的是不同檔（`report.html` 結構／`report.css` 外觀）。
- 新增的單一入口（`withLock`、`updateTasks`、`runState`、狀態文字、儲存守門、modal、詞彙表）都要進 CLAUDE.md，否則下一輪又會各寫一份。
- 複檢後仍未定、要靠探針的：P1（鎖跨環境）、P5（長佇列是否被截斷）。兩者各有寫明的退路，不擋規劃確認。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| 1-A 鎖＋唯一寫入口＋updateTasks（合併 1-1、1-3 與定案 1 的 updateTasks） | impl-low | 2537 綠（+8） | Claude 先寫 `za1_locks` 守門（讀寫同一次持有、單鎖、白名單）；獨立全套重跑綠；突變（mutateKey 拿掉鎖）3 則紅 | impl-low 主動回報：告警冷卻改「鎖內判斷蓋章、鎖外通知」、`catchUpAll` 只移除補抓過的項目、v1 站台遷移加密挪到鎖外。均接受 |
| 1-B 帳本按日鍵＋紀錄小時鍵（前綴 `rec2:`）＋全鍵分批（合併 1-2、1-4、1-5） | impl-low | 2570 綠（+33） | 自寫 `za2_keys` 33 則；突變三次皆紅；Claude 獨立全套重跑 | **Claude 補修 7 則恆真的舊帳本斷言**（d5c、d6、m2、l1：它們讀已不再寫入的單一 `runs` 鍵，改成 `getRunStatus`／`runs:` 鍵清單），其中 d6 另有一行測試自己寫入 `runs:{}` 造成誤紅，一併拿掉。z1／z4 的「get(null) 恰好一次」改成「getKeys 或 get(null) 合計一次」 |
| 1-C 紀錄瘦身＋孤兒鍵清理（1-6、1-7） | impl-low | 2582 綠（+12） | 自寫 `za3_slim`；m2_chain 補 rawTruncated 鏈結；突變 6 次皆紅 | 規格外加 `runOncePerDay`（日戳守衛留在 storage，避免看門狗直接碰 chrome.storage），接受 |
| 2-A 排程槽取排定時刻、先排後跑、runState 復原（2-1、2-2） | impl-low | 2595 綠 | Claude 先寫 `zb1_slot_recovery`（mock.timers 假 Date）；突變 markLate 恆 false → 紅 | **規格兩處錯誤由 impl-low 回報**：(1) Claude 的測試 #4 用第一次失敗，但第 1、2 次失敗只排重試不寫紀錄 → Claude 改用重試 alarm；(2) 遲到在 runTask 內用時鐘判斷會讓 32 則直接呼叫 runTask 的舊測試變 late → 改為呼叫端（handleAlarm、recoverRunState）以 `isLateStart` 算好傳 `markLate`。**Claude 補修**：兩個復原同時跑（啟動＋看門狗）會把同一格處理兩次 → `takeRunState` 鎖內拿走才處理，補併發測試（突變驗證會紅） |
| 2-B 狀態文字單一來源＋interrupted 接到畫面＋背景錯誤回應（2-3、2-7、2-11） | impl-low | 2610 綠（+15） | 自寫 `zb2_status_text`；突變 2 組皆紅；Claude 獨立全套重跑 | health 的 `reason` 預設改用 `statusTextOf`（ok 也會寫「成功」），不影響畫面（異常才顯示 reason）；自檢失敗顯示在診斷框第一列（report.html 不在白名單），批次 8 版面整理時再看 |
| 2-C 總時限與續命、訊息逾時、content 例外、延遲渲染短等待（2-4、2-5、2-6） | impl-low | 2633 綠（+23） | 自寫 `zb3_timeouts` 21 則；突變三組皆紅（含「用 Promise.race 包整段會多寫一筆」） | 登入第一則 `CHECK_ELEMENT` 逾時照既有語意算「不在登入頁」（接受）。**Claude 補修**：被總時限截短的登入失敗原本會累加 `failStreak`（三次就誤停用站台）→ `recordLoginFailure` 在時限已過時不記帳，補測試並突變驗證；探測逾時 5000 寫了兩份 → fetcher 改用 frames.js 匯出的常數 |
| 2-D 失敗通知冷卻與同站台合併、預檢 alarm 只排自己、喚醒後算錯過、interval 空窗（2-8、2-9、2-10） | impl-low | 2652 綠（+19） | 自寫 `zb4_notify_missed` 19 則；突變三組皆紅 | `parseRetryName` 搬到 fetcher 匯出（看門狗要用，避免循環相依），接受。**Claude 補修**：儀表板狀態卡（也是匯出 HTML）把 gap 算成「錯過 1」→ gap 白話搬到 `shared/describe.js`（UI 原本為了這句話 import 背景模組），狀態卡分開顯示錯過數與「休眠期間略過 N 次」，補 h3 測試 |
| 3-B sender 守門、WAR 收斂、Blob 匯出（3-3～3-6） | impl-low | 2665 綠 | Claude 先寫 `zc1_sender`；impl 自寫 `zc3_war_blob`＋a4 D16（manifest＝content import 閉包）；突變 8 次皆紅 | 規格要替身加 `runtime.id`，但五個 UI 模組以它判斷「是不是真的擴充功能頁」而開始正式接線 → 改用 `getURL('')` 取來源（行為等同），替身不加 id，接受。**煙霧測試 Chrome 三案「沒有留下紀錄」**：impl 以為是既有問題；Claude 查出是煙霧腳本直接讀舊鍵 `rec:<日期>`（批次 1 改成 `rec2:`）→ 改讀兩種鍵後 **Chrome 與 Edge 全過**（Edge 本輪首次啟動成功） |
| 3-A 網址 scheme、設定匯入先驗後寫（摘要＋確認＋失敗還原）、紀錄匯入逐筆驗證（3-1、3-2） | impl-low | 2681 綠 | 自寫 `zc2_import`；突變 preview 零寫入與失敗還原皆紅 | 與 `za2` 衝突：沒有 `status` 的紀錄照收（只拒絕帶了未知 status 的），接受並記入規劃。**Claude 補修三處**：(1) 舊資料裡的怪網址任務，任何 `updateTasks`（fetcher 回寫 notFoundStreak、整批啟停）都會丟例外 → 網址沒變的更新不檢查 scheme，只有整份重存才擋；(2) 同一台機器再匯入沒帶密碼的設定檔會把本機能用的站台密碼洗掉 → 沿用本機密文、不列入要重輸；(3) 匯入改了主題要重新整理才生效 → 匯入後 `applySavedTheme`。三處都補測試（原測試依舊語意斷言者改寫） |
| —— 批次 1～3 完成 | Claude | —— | —— | **設計修正**：原定此處先併 dev 讓使用者實測；使用者本輪指示「全部在本輪處理完畢」且不在場實測，改為全部批次完成後一次終檢、一次併 dev。升級注意（v3、不建議降版）照舊寫進收尾交接 |
| 4-A 樣式地基：Report、popup 改載 ui.css（4-0） | impl-low | 2685 綠（+4） | 改動前後各截 24 張（亮暗×六畫面）＋逐元素 computed style 比對，只剩允許的差異（主要按鈕文字色、按鈕左右內距）；Claude 抽看設定頁截圖；煙霧 Chrome、Edge 全過 | 範圍選擇器特異度會壓過 Report 各區塊規則 → 改用同一元素選擇器後載入蓋回（多用 `revert`），body 字級寫 75% 保持原樣；以 id 當主色按鈕的規則仍在 report.css（5-B 改掛類別時收掉） |
| 4-B Picker 守門、零修改可存、固定列兩層、存檔後抓第一筆與小修（4-1～4-3） | impl-low | 2703 綠 | Claude 先寫 `zd1_save_guard`（5 則）；impl 自寫 `zd2` 13 則；突變（不送／送兩次 RUN_TASK、拿掉試抓中守門）皆紅；320／360px 截圖 | j1、l3 的測試前置原本在存「沒有目標」的任務（其中兩則是空過），補上目標，接受。**Claude 補修**：第一筆失敗的下一步寫「按立即測試」，但存檔後表單已換成回饋區、沒有那顆鈕 → 改指向回饋區的「開啟報表」與任務頁「立即抓取」 |
| 4-C 站台判定值必填與一鍵帶入、測試登入、存檔重置（4-4、4-5） | impl-low | 2726 綠（+23） | 自寫 `zd3` 23 則；突變三次皆紅（已登入回報成功、密碼寫進 diag、測試累加 failStreak） | 現況查核：存站台本來就重置 `failStreak`／`enabled`，但 `site:<origin>` 紅燈沒清 → 補上。判斷不出分頁時儲存鈕仍 disabled（s3 體檢-6 的保護，與守門原因無關），接受。燈號重整借 `REBUILD_ALARMS`（多重建一次 alarm，冪等），接受 |
| 4-D 共用對話框、設定頁驗證與回饋、保留天數調低確認、匯出失敗回饋（4-6、4-7） | impl-low | 2751 綠（+25） | 自寫 `zd4` 25 則；突變三組皆紅 | impl 回報兩處衝突，**Claude 處理**：(1) zc2 的設定頁測試缺 `<dialog>` 替身 → 在 zc2 補替身；(2) p6 的「ui.css 不留死類別」只掃 picker／site 的 HTML，對話框的類別由 JS 動態掛上被誤判 → 掃描改為 src/ui 全部 HTML＋JS 的 className／classList／類別字串參數（先斷言掃描集合非空）。另把 `trimOldRecords` 的截止日改用與「會刪除幾天以前」相同的 `addDays` 公式，只留一份 |
| 4-E 卡片設定抽屜草稿模型（4-8） | impl-low | 2772 綠（+21） | 自寫 `zd5` 21 則；突變（變回即時寫入、投放直接寫）皆紅 | impl 回報三點，Claude 定案後由同一 impl 續做：確認框取消／Esc＝「繼續編輯」（原本 Esc 會丟掉草稿）；六則變成恆真的既有抽屜測試補「按套用」並抽樣突變（r1、m2、n2 會紅，l9、m4 守的是別的機制）；同一張卡拖出移除把手也併進草稿 |
| 5-A 燈號語意（紅燈修好才綠、黃燈可知悉）、圖示變體、popup 下一步 | impl-low | 2791 綠（+19） | 自寫 `ze1` 19 則；突變（紅燈改回已讀即不計）→ 3 則紅 | 改寫 d5、d9、d5b 三條依舊語意的斷言（未刪）。popup 開報表改走 hash（報表只讀 `location.hash`），連帶修正 5-B 規格。異常列保留既有「立即重試」「開啟頁面」、下一步鈕加在最前（d5b 既有斷言守著），接受 |
| 5-B 任務頁四態與下一步、空狀態、手動結果保留、依網址定位；歷史篩選拆兩條；主要按鈕與日期列 | impl-low | 2807 綠（+16） | 自寫 `ze2` 16 則；突變五次皆紅 | **Claude 補修**：impl 為了不改 zb2 保留 `filterRecords` 認舊鍵 `alertsOnly` → 改 zb2、j2 用新鍵並拿掉相容分支（舊網址的轉換留在 `parseHash`）；更新 popup 過時註解。歷史頁本來就沒有匯出鈕（在設定頁），歷史頁不設主要按鈕；抽屜開著時「套用」與「編輯版面」同時可見兩顆主要按鈕（抽屜是覆蓋層），接受 |
| 6 Report 依變動重畫、儀表板輕量重畫、圖表抽樣 | impl-low | 2818 綠（+11） | 自寫 `zf1` 11 則；突變三次皆紅 | **推翻暫定值**：去抖維持 50ms（`za2`、`l1` 以 60ms 斷言通知；收益主要來自「沒交集不動」與輕量重畫），接受。儀表板交集用精確範圍（與取數共用 `fetchRangeOf`），不是只看「含今天」 |
| 7-A 選取模式大表 hover 效能 | impl-low | 2822 綠（+4） | 自寫 `zg1` 4 則（改動前 HEAD 全紅）；突變五次皆紅；探針 P3：已選 20 格時 40 次 hover 長任務總和 16246ms → 0ms、單次中位數 386.6ms → 0.9ms；未選時首次 hover 仍有一次 174ms（整表首次描述） | 沒加節流（中位數已遠低於 16ms）。觀察範圍比規格寬（所有進快取的表，理由：升級判定會讀外層表的小表）。impl 誤用 junction 接 worktree 的 node_modules，`git worktree remove --force` 刪光主專案 node_modules，已 `npm ci` 復原。**煙霧測試抓到 5-A 回歸**：`setIcon` 用相對路徑，service worker 在 `/background/` 解析失敗並丟例外，讓專用視窗抓取回報失敗 → Claude 改 `/icons/…` 並包 try/catch，Chrome、Edge 煙霧全過 |
| 7-B 面板單一捲動區、工具列閃避、失效選取不送出、提示與防誤觸 | impl-low | 2835 綠（+13） | 自寫 `zg2` 13 則；突變六次皆紅；P4 實機（每組 12 值、視窗高 600／400）動作列都在畫面內；煙霧 Chrome、Edge 全過 | 規格外：面板加寬度上限 480px（chip 多時面板橫跨整個視窗蓋住表格，HEAD 也如此）、`maxHeight` 讓出工具列；工具列閃避邊界改 0（要點工具列的人游標一定會靠近它）。z5 的「chip 清單自己有 maxHeight」改成「內容區可捲」（規格明定拿掉各組 40vh）。未做：提示文字仍在可捲區內（要拆 updatePanel 四分支）→ 記入 BACKLOG |
| 8-A 設計 token（對比達標）與共用元件外觀 | impl-low | 2842 綠（+7） | 自寫 `zh1_tokens`（WCAG 對比純函式，四條軌八組配對 ≥4.5:1）；突變 `--warn-text` 改回 `#d97706` → 紅；p4 擴充死類別與零色碼掃描；亮暗截圖逐張看過；煙霧 Chrome、Edge 全過 | 另加 `--danger-strong`（暗色 `--danger` 配白字只有 3.8）；修既有 bug：`* { margin:0 }` 讓 `showModal` 對話框貼左上角。**Claude 補修**：w5、x3 綁 token 名 `var(--warn)` 讓兩處警示文字留在低對比 → 改用 `--warn-text`，測試接受兩種。其餘五件（狀態卡恆綠、popup 黃燈原因紅字、暗色原生控制項白底、popup 兩顆主按鈕、匯出 HTML 狀態字色）併入 8-B |
| 8-B Report 與 popup 版面層級、SVG 圖示、鍵盤可達 | impl-low | 2861 綠（+19） | 自寫 `zh2` 19 則；突變八次皆紅（其中 `color-scheme` 第一輪是假守門——條件字串本身含那串字，已修測試）；真實 Chrome 驗頁籤方向鍵、日曆 Enter、紀錄列展開鈕；截圖 | 修既有 bug：900px 以下卡片固定 80px 高被切掉。Claude 看截圖後把收尾項（停用 chip 寫「成功」、重選鈕重複、模式欄英文、CSS `order` 讓 Tab 順序與畫面不一致、走勢圖超出卡片、表格時間欄 ISO 格式、狀態卡無標題、picker／site 的符號字元）併入 8-C |
| 8-C 詞彙統一、前置動作提到主區、固定預設值搬到存檔回饋、教學頁同步、版面收尾 | impl-low | 2876 綠（+15） | 自寫 `zh3` 14 則；突變八條皆紅（兩條第一輪沒抓到：替身存物件參照、pin 與 last 值相同，已補強）；360px Picker 與 Report 截圖逐張看過；煙霧全過 | d13、k1_checkup、zd3 三條斷言因規格改白話／時間格式／圖示而改寫，接受。**Claude 補修**：框架提示仍展開已空的進階區 → 只展開前置動作那一列（改 q3 斷言）；儀表板狀態卡停用任務顯示「—」→「停用中」灰 chip，補 h3 測試。舊詞剩 10 處皆為註解（background、aggregate、save-guard） |
| 9 文件、排程健康保護次數 | Claude | 2878 綠（+2） | `zi1_guard_counts` 2 則 | 排程健康的「近 7 天保護次數」寫在規劃批次 9 卻是程式工作、沒有派進任何一段 → Claude 補做（`countGuardEvents`）。SPEC §0～§13 更新、專用視窗探針表搬 `docs/archive/SPEC-decisions.md`、CLAUDE.md 新規則與結構、BACKLOG 劃掉 10 條新增 9 條。BACKLOG「排程觸發失敗立即寫紀錄」沒做（只有 interrupted），不劃；規劃提的「保留天數永久時舊日鍵永遠留著」前提不存在（保留天數 1～3650，沒有永久），不加 |
| 併回前終檢（程式） | scan-low | 無高嚴重度；中 5、低 11 | 全 diff 對照 PLAN 與 CLAUDE.md | 第一次因額度上限中斷、重跑。抓到：站台設定讀-改-寫沒鎖（登入流程用舊副本蓋掉使用者剛存的密碼）、popup／Picker／錯過清單四處失敗靜默、儀表板拖曳與復原整份 `saveLayout` 蓋回背景修剪、刪儀表板不是 modal、抽屜套用讓修剪過的序列復活、通知建立失敗仍吃掉冷卻、forbidden 診斷可洗掉緩衝、網頁可送 repick 改任務、同 worker 卡住的 runState 永不清、看門狗被續跑擋住、zc1 兩則假守門、za1 清單不全 |
| 併回前終檢（文件） | scan-low | 13 項 | PLAN 定案逐條 grep、SPEC／CLAUDE.md 新主張逐條驗 | 殘留舊敘述（帳本單一鍵、inflight、DOM 片段、ui.css 服務範圍、icons 目錄）→ Claude 已改；匯出退路自我引用 → 併入修正段 |
| 終檢修正段 | impl-low | 2912 綠（+34） | 自寫 `zj1` 34 則；每點一次突變皆紅；煙霧 Chrome、Edge 全過 | 13 點全做。差異：儀表板復原改成「這一步的前後差異套到鎖內最新版面」（純還原位置會讓 j3、j4 既有的復原測試紅）；卡住判定用新增的 `runningAt`（`at` 是進佇列時刻，排隊久的會被誤判）。repick 核對讓 10 個既有測試補上 `repickTabs` 登記（它們原本從未登記的分頁送 repick）。**Claude 補修**：匯出退路另外 17 個舊 token 也是自我引用 → 全改實際值並加守門；重選「取消」也核對分頁（任何網頁都能關掉我們開的重選分頁）；兩則補測試，2914 綠、煙霧全過 |

## 體檢交接

- **全量測試**:`npm test` **2914 綠 / 0 紅**(基線 2529,+385)。本輪曾出現一次無法重現的單則失敗(7-B 收尾,之後連跑多次全綠),已記 BACKLOG。
- **煙霧測試**:`bash run_smoke.sh` **Chrome 與 Edge 全過**(Edge 本輪起能在這台啟動)。
- **提交**:分支 `r21`,尚未併 dev。版本號仍是 0.19.0——**收尾時** `manifest.json` 與 `package.json` 同步升 0.20.0。
- **併回前終檢**已做(程式、文件兩份獨立掃描,發現已全數處理,見執行紀錄)。收尾體檢請換模型進行(project-lifecycle 階段 4)。
- **升級注意(給使用者)**:資料升到 schemaVersion 3(帳本按日、紀錄按小時分鍵),**升級前先在設定頁匯出設定與紀錄,之後不建議降版**。
- **仍需使用者實測的點**:抽屜「點外面」與拖曳結束的 click 在真實瀏覽器是否互撞;續跑不被看門狗 await 時 worker 是否撐得住;popup 360px 下異常列四顆按鈕的換行;測試登入在真實站台的四步回報。
