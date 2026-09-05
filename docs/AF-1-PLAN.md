# AF-1 規劃:骨架 + 單值抓取 + 排程 + JSON 日檔 + 基本 Report

> 狀態:兩批待決皆已定案(2026-09-05),階段已拆;下一步是逐階段寫委派規格檔並執行。目前不實作。

## 已定案(2026-09-05)

| # | 決定 |
|---|---|
| 1 | 區塊聚合以 HTML 表格各種寫法為主(table / ARIA grid / grid-flex 假表格 / list),見 SPEC §7 |
| 2 | JSON 先寫 Chrome 下載資料夾底下 `AutoFetcher/`(`chrome.downloads`);選資料夾與 Native host 進 BACKLOG |
| 3 | 排程同時支援每日 HH:mm 與每 N 分鐘,使用者選 |
| 4 | 錯過的抓取列成清單,由使用者決定補抓或略過 |
| 5 | 不做 storage.sync;提供設定匯出/匯入(密碼預設不含) |
| 6 | 前景抓取不預設;背景失敗 2 次才提示可改前景(理由見 SPEC §4) |
| 7 | GitHub repo 已改 public |

## 分輪範圍

| 輪 | 內容 |
|---|---|
| **AF-1(本輪)** | 骨架、右鍵單值(text/number)、四層選擇器、daily + interval 排程、背景開分頁擷取、重試、錯過清單、storage、日檔 JSON、設定匯出/匯入、Report 每日檢視 + 手動抓取 |
| **AF-2** | **儀表板自訂版面(§8.2 全部)**、Picker「加入儀表板」、樞紐表、獨立 HTML 報表、工具列 popup(§12) |
| AF-3 | 區塊聚合(§7)、自動登入(§6)、前置動作、告警(§10)、歷史匯入 |

## AF-1 作業總覽

| 作業 | 內容 | 執行者(暫定) | 驗收 |
|---|---|---|---|
| A 骨架 | manifest、background/content/report 空殼、`shared/storage` 讀寫 + schema 版本欄、Node 測試環境(`node --test` + jsdom)、chrome API mock | 地端 LLM | `npm test` 綠;`chrome://extensions` 載入無錯 |
| B 選擇器 | content:記錄右鍵目標、產生四層選擇器、依序解析、`not_found` 附 DOM 片段(SPEC §3) | 地端 LLM | 5 個 HTML fixture:每層各有「命中」與「該層失效退到下一層」測試 |
| C Picker UI | 彈出視窗:名稱、模式、排程型別(daily 時間清單+星期 / interval N+時段)、預覽值、儲存後建 alarms | agy | Puppeteer 煙霧:建立任務後 storage 與 `chrome.alarms.getAll()` 內容正確 |
| D 排程與擷取 | alarm handler、找既有分頁或背景開分頁、等待載入、擷取、重試、錯過清單與通知按鈕(SPEC §4) | agy | 單元測試 mock alarms/tabs/scripting;煙霧:設 1 分鐘後的 daily 任務實抓一次 |
| E JSON 與設定 | 日檔產生與 `downloads` 覆寫、設定匯出/匯入(含 alarms 重建)(SPEC §5) | 地端 LLM | 抓一筆 → 下載資料夾日檔符合 schema;匯出→清空→匯入後任務與 alarms 一致 |
| F Report | 每日檢視、紀錄表排序、錯過清單橫幅、立即抓取、暫停/恢復、匯出設定按鈕(SPEC §8 每日檢視部分) | agy | Puppeteer 開 report.html:塞假紀錄後 DOM 正確;按立即抓取觸發 D |

整輪委派模型:暫定 A/B/E 地端 LLM,C/D/F agy;中途切換註明起點。
順序 A → B → E → C → D → F(E 早做讓 C/D 有儲存層可用)。

## 已定案(第二批)

| # | 決定 |
|---|---|
| 1 | interval 下限 1 分鐘 |
| 2 | 錯過清單:系統通知附「補抓全部 / 略過」,細選在 Report |
| 3 | 不自動下載;檔案只在 Report 設定頁由使用者手動匯出(JSON / CSV / 獨立 HTML) |
| 4 | 抓不到數字記 `parse_error` 保留原文,不寫 0 |
| 5 | number 模式採五種擷取策略鏈(auto / regex / attr / child / label),主策略失敗自動備援;併入 AF-1 |

## AF-1 階段拆分

每階段一次委派、可獨立驗收;「契約」只寫行為與介面,不寫實作。驗收皆為可執行指令,基線數在階段開始前由 Claude 填。

### A 骨架

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| A1 | 可載入的空擴充功能 + 測試環境 | `src/manifest.json`(MV3、§9 權限)、background/content/report 三個空入口;`package.json` 只用 `node --test` + `jsdom`,無 bundler;`tests/chrome-mock.js` 提供 alarms/tabs/storage/scripting/downloads/notifications/contextMenus 的最小 mock(記錄呼叫、可設回傳) | `npm test` 0 失敗;`node -e` 讀 manifest 驗 `manifest_version===3`;Puppeteer 以 `--load-extension` 啟動無 console error(煙霧腳本 `tests/smoke/load.mjs`) |
| A2 | 儲存層 | `src/shared/storage.js`:`getTasks/saveTask/deleteTask/getSites/saveSite/appendRecord/getRecordsByDate/listDates/getSettings/saveSettings`;所有寫入經此模組;`schemaVersion` 欄位 + 升版函式;記錄依 §5 結構、保留天數裁剪 | 單元測試 ≥ 12 條,含「超過保留天數最舊日期被刪」「schemaVersion 缺少時補 1」;`grep -rn "chrome.storage" src/ \| grep -v shared/storage.js` 為 0 行 |

### B 選擇器

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| B1 | 產生四層定位 | `src/shared/selector.js`:`describe(el) → {css, path, anchor, xpath}`(§3 四層);純函式、可在 jsdom 跑;`css` 只用穩定屬性(id 非隨機、data-* 、name),排除看起來是 hash 的 class/id(規則:含 ≥ 6 個連續英數混雜且無母音或含數字 ≥ 3,暫定) | 5 個 fixture(一般頁、React 隨機 class、表格、清單、無 id 深巢狀)各有測試;`describe` 對 fixture 每個目標回四層皆非空 |
| B2 | 依序解析 + 失敗診斷 | `resolve(doc, locator) → {el, layer} \| {error:"not_found", snippet}`;唯一命中才算,命中多個視為該層失敗;`snippet` 為 anchor 附近 DOM 前 500 字 | 每層各有「命中」與「該層失效退到下一層」測試,共 ≥ 8 條;全失敗時 snippet 長度 ≤ 500 |
| B3 | content script 接線 | `src/content/main.js`:監聽 `contextmenu` 記最後元素;回應 background 的 `DESCRIBE`(回四層 + 預覽文字)、`EXTRACT`(依 locator + 策略鏈擷取,見 C2)、`SCROLL_INTO_VIEW` | jsdom 測試以假 `chrome.runtime.onMessage` 觸發三種訊息並驗回覆;`grep -c "chrome.alarms" src/content/` 為 0 |

### E JSON 與設定(先於 C/D)

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| E1 | 匯出檔產生 | `src/shared/export.js`:`buildExport({from,to,format:"json"\|"csv"}) → {filename, blob}`(§5 schema;多日 JSON 打包 `days[]`、CSV 一列一紀錄);`download(blob, filename)` 經 `chrome.downloads`(`saveAs:true`);**沒有任何自動呼叫點** | 單元測試:單日/多日 JSON 結構、CSV 欄位與跳脫(含逗號、引號、換行);`grep -rn "downloads.download" src/ \| grep -v export.js` 為 0 行 |
| E2 | 設定匯出/匯入 | `exportSettings({includePasswords, passphrase}) → JSON 字串`、`importSettings(json, {passphrase})`;含 tasks/sites/layout/settings,不含 records;密碼以 WebCrypto AES-GCM + PBKDF2;匯入後呼叫 `rebuildAlarms()`(D1 提供,此階段以 mock) | 匯出→清空 storage→匯入 → tasks 深相等;含密碼匯出後密文中 `grep` 不到原密碼;錯密語匯入拋錯且 storage 不變 |

### C Picker

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| C1 | 右鍵選單 + 彈窗 | background 建立 contextMenus(§2 四子項);點「抓取此文字/數值」→ 向分頁要 `DESCRIBE` → 開 `ui/picker/picker.html`(popup 視窗 480×640 暫定)帶入預覽;表單:名稱、模式 text/number、排程型別 daily(時間清單 + 星期)或 interval(N、時段、星期);儲存呼叫 `saveTask` 後通知 background 建 alarms | Puppeteer 煙霧:在 fixture 頁右鍵→建立任務→`storage` 有該 task;jsdom 表單驗證測試:空名稱、時間格式錯、N<1 皆擋下 |
| C2 | 數值策略鏈 | `src/shared/extract.js`:`extractNumber(el, strategy) `五種策略(§11)+ 備援順序 + `parseNumber`(千分位/貨幣/百分號/全形/會計負數);Picker 的 number 模式可選主策略、regex 輸入即時預覽、「立即測試」按鈕實抓一次 | `parseNumber` 表格測試 ≥ 15 個輸入(含「--」→ null);策略鏈測試:主策略失敗回 `fallback` 且標 `strategy_used`;全失敗回 `parse_error` 且 `raw` 保留 |

### D 排程與擷取

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| D1 | alarms 管理 | `src/background/scheduler.js`:`rebuildAlarms()` 依所有啟用任務重建(名稱 `<taskId>:<i>`);daily 算下一次 `when`(含星期跳過);interval 含時段/星期時由 handler 判定「此刻該不該抓」;任務暫停即清其 alarms | 單元測試:daily 三時間+週一至五 → alarm 數與 when 正確;interval 時段外觸發不擷取;暫停後 `alarms.getAll` 無該 task |
| D2 | 擷取流程 | `src/background/fetcher.js`:`runTask(task, {reason})`:找同 URL 既有分頁否則 `tabs.create({active:false})` → 等 `complete` + 任務 `extraDelay`(預設 3s)→ 注入 content → `SCROLL_INTO_VIEW` → `EXTRACT` → `appendRecord` → 自開的分頁關閉;逾時 30 秒;`not_found`/逾時 2 分鐘後重試一次;同站台串行佇列;連續 2 次 not_found 在 task 標 `suggestForeground` | 以 chrome-mock 的單元測試:成功、not_found 重試後成功、重試仍失敗寫失敗紀錄並呼叫 notifications、同站台兩任務只開一個分頁;煙霧:1 分鐘後 daily 任務實抓 fixture 頁並得到正確值 |
| D3 | 錯過清單 | 啟動(`runtime.onStartup`)時比對每任務「上次成功時間」與應觸發時刻,產生 `missed[]` 存 storage;發 notification 附「補抓全部 / 略過」;補抓走 `runTask(..., {reason:"late"})`;超過 7 天自動略過 | 單元測試:關機 2 天、daily 兩時間 → missed 4 筆;按「補抓全部」→ runTask 呼叫 4 次且紀錄 `status:"late"`;略過 → missed 清空 |

### F Report(每日檢視)

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| F1 | 歷史查詢 | `ui/report/`:頂部日期範圍列(快捷 + 月曆 + 左右翻)、左側月曆打點、右側紀錄列表(排序/隱藏/拖曳欄序)、篩選(任務/狀態)、範圍摘要列、單筆展開、URL hash 保存狀態;無外部依賴。樞紐表與「與另一天比較」留 AF-2 | Puppeteer:預填 3 天假紀錄 → 月曆 3 個打點、點某日列數正確、選 7 天範圍摘要筆數正確、重新整理後仍在同一天 |
| F2 | 任務頁 + 設定頁 | 任務頁(§8.4:清單拖曳排序、啟用開關、立即抓取、編輯、複製、刪除 confirm);設定頁(§8.5:日期範圍 + JSON/CSV 匯出按鈕、設定匯出/匯入、保留天數);錯過清單橫幅(逐筆勾選補抓/略過)。獨立 HTML 報表留 AF-2 | Puppeteer:每個按鈕觸發對應 mock 呼叫一次;刪除未 confirm 時 storage 不變 |

執行順序:A1 → A2 → B1 → B2 → B3 → E1 → E2 → C1 → C2 → D1 → D2 → D3 → F1 → F2。
委派模型(暫定):A/B/E 地端 LLM;C/D/F agy。B3、D2 若地端兩輪未過直接改派 agy。

## AF-2 作業草案(儀表板,定案後另開 AF-2-PLAN)

| 作業 | 內容 |
|---|---|
| G 版面引擎 | 12 欄格線、卡片模型、拖曳/縮放/吸附、復原重做、響應式疊欄;版面存取與任務刪除連動 |
| H 卡片型別 | number / line / bar / table / gauge / text / status 七種,共用 SVG 圖表模組與聚合函式 |
| I 設定抽屜與範本 | 齒輪抽屜即時預覽、自動排列、三種範本、多儀表板頁籤 |
| J Picker 接線與歷史進階 | 建任務最後一步「加入儀表板」;任務頁排序影響樞紐表欄序;歷史查詢的樞紐表、與另一天比較、值範圍/關鍵字篩選、大範圍分頁 |
| K 匯出與 popup | 獨立 HTML 報表(內嵌資料 + 版面,離線可開)、工具列 popup(§12) |

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| (定案後填) | | | | |
