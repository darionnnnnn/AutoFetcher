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

## 狀態

規劃階段,尚無程式碼。
