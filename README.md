# AutoFetcher

Chrome 擴充功能:在網頁上右鍵選取文字/數值/區塊,設定多個抓取時間,自動抓值並累積成每日歷史,
內建 Report 頁檢視。支援需登入的頁面(自動填入帳密)。

## 功能

1. 右鍵 → AutoFetcher → 「抓取此文字/數值」:命名、設定一或多個時間(HH:mm),到點自動擷取。
2. 右鍵 → AutoFetcher → 「抓取此區塊」:對表格/清單區塊取 X 軸(列)或 Y 軸(欄)的最大值 / 平均值。
3. 歷史資料存於 `chrome.storage.local`,並匯出 JSON 到使用者指定的資料夾。
4. Report 頁:依日期瀏覽每筆紀錄、趨勢圖、匯出。

## 結構

見 `CLAUDE.md`;規格見 `docs/SPEC.md`。

## 安裝(開發模式)

1. Chrome:`chrome://extensions`;Edge:`edge://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選 `src/`。
2. 到目標網頁,右鍵即可看到 AutoFetcher 選單。

## 開發

```bash
npm install
npm test          # 293 個單元測試
./run_smoke.sh    # 真實瀏覽器端到端(需 Chrome for Testing)
```

一般 Chrome 152 起已封鎖命令列載入擴充功能,煙霧測試改用 Chrome for Testing:

```bash
npx @puppeteer/browsers install chrome@stable --path "$PWD/.browsers"
```

## 狀態

AF-1 完成:右鍵建立任務、四層選擇器、五種數值擷取策略、每日與間隔排程、
背景抓取與重試、錯過清單、看門狗、抓取前預檢、工具列燈號、報表歷史查詢、
JSON/CSV 手動匯出、設定匯出匯入。

下一輪(AF-2):報表儀表板自訂版面。之後(AF-3):表格區塊聚合、自動登入、告警。
