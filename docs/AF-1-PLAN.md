# AF-1 規劃:骨架 + 單值抓取 + 排程 + JSON 日檔 + 基本 Report

> 狀態:方向已定案(2026-09-05),§待決 第二批待答;答完拆階段規格再委派。不實作。

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
| AF-2 | 區塊聚合(§7)、自動登入(§6)、前置動作、數值後處理(§11) |
| AF-3 | 儀表板自訂版面(§8)、告警(§10)、CSV、歷史匯入 |

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

## 待決(第二批)

1. **interval 下限**:1 分鐘(暫定)可以嗎?更短要常駐分頁,不建議。
2. **錯過清單通知方式**:Chrome 啟動時跳一則系統通知附「補抓全部 / 略過」兩鈕,細選到 Report 頁。可接受?
3. **下載氣泡**:每次寫日檔 Chrome 右上角會閃一下下載提示,無法從擴充功能關閉,只能由你在 Chrome 設定關。可接受,還是改成「每小時/每日整批寫一次」?
4. **number 模式抓不到數字**(例如頁面顯示「--」):記 `status: "parse_error"` 並保留原文,不當作 0。可接受?
5. **AF-1 要不要先把 §11 的正則擷取拉進來**?很多頁面的數字帶單位文字,不做的話 number 模式實用性打折;工作量小,建議併入作業 C。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| (定案後填) | | | | |
