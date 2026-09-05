> 除非必要否則不要讀取 docs/archive/ 內容,避免浪費 token。

# BACKLOG(已知但刻意未做)

| 項目 | 觸發條件 |
|---|---|
| Canvas/SVG 圖表取值(需讀圖表庫內部資料或 OCR) | 使用者提出實際目標頁是 canvas 圖表時 |
| 逐站 `optional_host_permissions` 取代 `<all_urls>` | 要上架 Chrome Web Store 時(審核會要求) |
| Native Messaging host 寫任意路徑(取代 File System Access) | 使用者需要無人值守、且每次重啟 Chrome 都不想重授權時 |
| 秒級或分鐘級高頻抓取 | 目前最小粒度為每日固定 HH:mm;有需求再談(alarms 最小 30 秒) |
| 多瀏覽器(Firefox)支援 | 有需求時;選擇器與 alarms API 皆可移植,contextMenus 差異最大 |
| 值變動通知(閾值告警) | 使用者提出 |
| 匯出 CSV | 使用者提出 |
| 任務設定匯入/匯出(換機) | 使用者提出 |
