> 除非必要否則不要讀取 docs/archive/ 內容,避免浪費 token。

# BACKLOG(已知但刻意未做)

| 項目 | 觸發條件 |
|---|---|
| Canvas/SVG 圖表取值(需讀圖表庫內部資料或 OCR) | 使用者提出實際目標頁是 canvas 圖表時 |
| 逐站 `optional_host_permissions` 取代 `<all_urls>` | 要上架 Chrome Web Store 時(審核會要求) |
| 自動落地 JSON(File System Access 選資料夾,需偶爾重授權) | 使用者需要不用手動就有檔案時 |
| Native Messaging host 寫任意路徑、完全無人值守 | 上一項仍不夠時(多一個安裝步驟) |
| 深色模式以外的主題色 | 使用者提出 |
| 秒級抓取 | 目前最小 1 分鐘;alarms 下限 30 秒,再快要常駐分頁 |
| Firefox 支援 | 有需求時;選擇器與 alarms API 皆可移植,contextMenus 差異最大 |
| Chrome Web Store 與 Edge Add-ons 上架 | 使用者想分享給別人安裝時(兩邊分別審核) |
| 任務設定 `storage.sync` 自動同步 | 使用者常在多台機器切換且嫌手動匯入麻煩時 |
| 抓取時同時截圖存證 | 使用者需要查證抓到的值時 |
| 同一頁多元素合併為一個任務(一次抓多值) | 使用者一頁要抓 5 個以上的值時 |
| iframe 內元素 | 目標值在跨域 iframe 內時(需 allFrames 注入) |
| 英文介面 / i18n | 上架 Chrome Web Store 或要分享給非中文使用者時 |
| 抓到值時 POST 到 webhook 或 Google Sheets | 使用者要接自動化時(與 AF-3 告警共用觸發機制) |
| 值未變化時不寫紀錄的選項 | 紀錄量成為問題、保留天數設定已不夠用時 |
| 從 Distill / Visualping 匯入任務 | 有使用者提出時 |
| 互動版獨立 HTML 報表(目前是靜態快照) | 使用者需要在匯出檔內切換範圍或篩選時 |
| 拖曳的鍵盤替代操作(無障礙) | 有鍵盤或輔助技術使用者提出,或上架審核要求時 |
| 儀表板卡片虛擬化 | 單一儀表板卡片超過 30 張且重畫變慢時 |
| 儀表板匯出成圖片(PNG) | 使用者要把儀表板貼進簡報時 |
| 站台登入管理 UI(設定頁目前是佔位文字) | AF-3 實作 §6 自動登入本體時 |

