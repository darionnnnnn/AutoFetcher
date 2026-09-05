# AF-1 規劃:骨架 + 單值抓取 + 排程 + 儲存(草案,待使用者定案)

> 尚未定案。§待決 全部回答後才拆階段規格並委派。

## 目標

能在真實網頁上:右鍵選一個數值 → 命名 + 設兩個時間 → 到點自動開分頁抓取 → 紀錄進 storage 並寫日檔 JSON
→ Report 頁看得到。區塊聚合(§7)與自動登入(§6)留到 AF-2。

## 作業總覽

| 作業 | 內容 | 執行者(暫定) | 驗收 |
|---|---|---|---|
| A 骨架 | manifest、background/content/report 空殼、shared/storage 讀寫、Node 測試環境 | 地端 LLM | `npm test` 綠;`chrome://extensions` 載入無錯 |
| B 選擇器 | content: 記錄右鍵目標、產生四層選擇器、依序解析(SPEC §3) | 地端 LLM | 對 5 個固定 HTML fixture 的 jsdom 測試:每層各自命中/失效情境 |
| C Picker UI | 右鍵後彈出視窗:名稱、模式(text/number)、時間清單、預覽值 | agy | Puppeteer 煙霧:建立任務後 storage 內容正確 |
| D 排程與擷取 | alarms 建立/重建、到點開分頁、擷取、重試、補抓(SPEC §4) | agy | 單元測試 mock chrome.alarms/tabs;煙霧測試以 1 分鐘後的時間實測一次 |
| E JSON 匯出 | File System Access 授權、日檔合併寫入、回填、downloads 備援(SPEC §5) | agy | 授權後抓一筆 → 磁碟上日檔內容符合 schema |
| F Report | 日期清單、紀錄表、手動抓取、匯出按鈕(SPEC §8,趨勢圖留 AF-2) | 地端 LLM | Puppeteer 開 report.html 驗 DOM |

整輪委派模型:暫定「A/B/F 地端 LLM,C/D/E agy」;中途切換註明起點。

## 待決(請逐項回答)

1. **「區塊取 X 軸 / Y 軸最大值、平均值」的對象**是 HTML 表格/清單(建議,SPEC §7 照此寫),還是畫出來的圖表(canvas/SVG)?
   後者做不到通用,需針對特定圖表庫或走 OCR。
2. **JSON 存放路徑**:擴充功能無法直接寫任意路徑。建議 File System Access API 讓你選資料夾(每次 Chrome 重啟可能要重新授權一次,
   Report 頁會提示)。若要完全無人值守,需另裝 Native Messaging host(多一個安裝步驟)。選哪個?
3. **時間精度**:只需每日固定 HH:mm(建議),還是也要「每 N 分鐘」?
4. **Chrome 沒開時錯過的抓取**:建議「啟動後只補當日、最多一次、標記 late」。可接受?
5. **多台電腦**:任務設定要不要 `storage.sync` 同步(密碼除外)?建議 AF-1 先不做。
6. **抓取時要不要讓分頁真的顯示**?背景分頁(`active:false`)有些網站 lazy-load 不觸發;建議預設背景,任務可勾「前景抓取」。
7. **GitHub repo 已建為 private**;要 public 再說。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| (定案後填) | | | | |
