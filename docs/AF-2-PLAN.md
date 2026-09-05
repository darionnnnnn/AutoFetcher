# AF-2 規劃:報表儀表板自訂版面

> 狀態:規劃完成(2026-09-06),A~M 全部定案(全採建議),14 段階段規格已展開,**待動工**。基線 `npm test` 293 綠 + `./run_smoke.sh` 通過。

## 目標

使用者能自己決定報表長什麼樣:把任務放成卡片、拖曳排位置、拉大縮小、選卡片型別與期間,
版面存起來、隨設定匯出。這是使用者指定的本輪重點,判準是「**設定時方便**」而不只是「做得出來」。

## 規劃時做的決定(規格沒寫死的部分,以下為本輪定案)

| # | 決定 | 理由 |
|---|---|---|
| 1 | 拖曳用 **Pointer Events**(`pointerdown/move/up` + `setPointerCapture`),不用 HTML5 drag-and-drop | HTML5 DnD 在拖曳中拿不到即時座標、無法畫佔位陰影,且觸控支援差;Pointer Events 三種輸入裝置統一,也能在 jsdom 用合成事件測 |
| 2 | 版面引擎拆成**純函式**(`layout.js`)與 **DOM 接線**(`dashboard.js`) | 格線數學是這輪最容易寫錯的地方(碰撞、擠壓、邊界),純函式才測得動;拖曳接線只負責把座標換成格線座標再呼叫純函式 |
| 3 | 卡片碰撞策略:**往下擠壓(compact)**,不交換位置 | 與常見儀表板一致,行為可預期;交換位置在多卡片重疊時結果不唯一 |
| 4 | 圖表**自己畫 SVG**,不引圖表庫 | CSP 擋外部資源;需求只有折線/長條/儀表三種,自繪約 200 行 |
| 5 | 缺值(抓取失敗)**斷線**,不補 0 也不內插 | 補 0 會讓趨勢圖說謊;這點在 AF-1 已寫進 SPEC §8.6 |
| 6 | 復原重做只記**版面**(卡片座標與設定),不記資料;離開編輯模式即清空,上限 50 步 | 使用者要的是「拖壞了可以退回」,不是完整版本史 |
| 7 | 多序列顏色用固定 8 色調色盤循環,色盤放 `theme.css` 變數 | 與 AF-1 的「顏色不寫死在模組裡」一致 |
| 8 | 卡片高度單位 **80px**、格線 **12 欄**、卡片間距 8px | 沿用 SPEC §8.2 的暫定值,實作後不改 |

## 核對結果(2026-09-06,對照 dev 現況程式碼)

| 項目 | 狀態 | 證據 | 對規劃的影響 |
|---|---|---|---|
| `layout` 儲存鍵與設定匯出匯入已接好 | ✅ | `storage.js` DEFAULT_LAYOUT、`exportAll`、`settings-io.js` 匯入時寫回 layout | G2 只需在其上加 dashboards/cards 操作與 `version` |
| `theme.css` 存在 | ❌ | `src/ui/` 下沒有此檔;report/popup/picker 各自在 html 內寫 `:root` 變數 | 決定 7 與 SPEC §8.6 引用的檔案不存在,需新增階段 G0 抽出共用 `theme.css`(含 `--chart-1`~`--chart-8` 亮/暗兩組) |
| 頂部日期範圍列全頁籤共用(SPEC §8.1) | ⚠️ | `report.html` 的 `#range-bar` 在 `#panel-history` 內;沒有自訂範圍與左右翻 | 儀表板卡片要跟範圍走,G3 前要先把範圍列搬到頁籤下方共用(小改,併入 G0) |
| 任務頁、設定頁有內容 | ❌ | 兩個 panel 都是 `placeholder-panel`;`export.js`/`settings-io.js` **沒有任何 UI 消費端**(只被彼此引用) | 原規劃完全漏掉。J2 樞紐表欄序依「任務頁順序」、K1 匯出按鈕住在設定頁,都有硬前置 → 新增 F3 任務頁、F4 設定頁 |
| jsdom 能測 Pointer Events | ❌ | jsdom 25.0.1:`PointerEvent`、`setPointerCapture` 皆 undefined | 決定 1 保留(真實瀏覽器用 Pointer Events),但 G3 接線只讀 `clientX/clientY/pointerId`,`setPointerCapture` 存在才呼叫;測試用 `MouseEvent`/自訂 `Event` 合成 |
| 紀錄含 `taskName` | ❌ | fetcher `writeRecord` 只寫 taskId;`logic.js`/`report.js` 卻讀 `r.taskName`,現在「任務」欄顯示的是 id | 既有小 bug。報表載入時以 `getTasks()` 建 id→name 對照併入紀錄(Claude 幾行修);H1/H3 的 ctx 一律帶 `tasksById` |
| `deleteTask` 會清卡片 | ❌ | `storage.js deleteTask` 只清 tasks 與 rec:*;layout 不動 | G2 的 prune 直接接在 `deleteTask` 內(唯一寫入口),不另設呼叫時機 |
| Picker 存檔流程可加步驟 | ✅ | `picker.js handleSave` → `saveTask` → `REBUILD_ALARMS` → close | J1 在 saveTask 後、close 前插入「加入儀表板」;編輯既有任務(`currentCtx.task` 有值)不顯示 |
| 煙霧測試可延伸 | ✅ | `tests/smoke/load.mjs` 已從 report 頁做斷言 | 每段驗收加對應斷言 |
| `settings-io.js:65` 日期改寫 | ⚠️ | 為了讓 `e2_settings` 的 `!json.includes('2026-09-05')` 在當天通過,把 `exportedAt` 硬改成隔天 | agy 為過測試做的假修。Claude 改測試(斷言 `data` 沒有 rec 鍵)並刪掉這行,列入 G0 |

## 待決事項(定案後才動工)

| # | 問題 | 建議 | 理由 |
|---|---|---|---|
| A | 任務頁與設定頁要不要放進 AF-2? | **要**,新增 F3(任務頁)與 F4(設定頁),排在 G0 之後、G1 之前 | 沒有任務頁,J2 欄序沒有來源、使用者也無處編輯/刪任務;沒有設定頁,匯出與設定匯入根本沒入口;兩段都是純 UI 接線,已有邏輯層 |
| B | 排程健康區(AF-1 F2 原案:下次觸發實值、看門狗時間、診斷、立即自檢)要一起做嗎? | **做在 F4**,但縮成「每任務下次觸發 + 最近 20 筆診斷 + 立即自檢」三項 | `diag.js`/`health.js` 已有資料,只差顯示 |
| C | 深色模式偏好(跟隨系統 / 亮 / 暗,SPEC §8.5) | 本輪做,放 G0(`theme.css` 用 `[data-theme]` 切換) | 與抽出 theme.css 同一次改最便宜 |
| D | 抓不到 `taskName` 的既有 bug | Claude 直接修(報表載入時 join),不另開階段 | 幾行 |
| E | 卡片預設高度 80px、12 欄 | 維持決定 8 | — |

若 A~C 都採建議,順序改為:**G0 → F3 → F4 → G1 → G2 → H1 → H2 → H3 → G3 → I1 → I2 → J1 → J2 → K1**(14 段)。

## 功能完整性盤點(2026-09-06,SPEC §5/§8 逐條對照原規劃)

以下是 SPEC 已寫、AF-1 未做、原 AF-2 規劃也沒接住的項目,以及各自歸入哪一段:

| SPEC | 項目 | 現況 | 歸入 |
|---|---|---|---|
| §8.1 | 日期範圍列「自訂」範圍與左右箭頭逐日/逐週翻 | 只有六個快捷鈕 | G0 |
| §8.1 | 由 `chrome://extensions` 選項開啟報表 | manifest 沒有 `options_page` | G0(一行) |
| §8.2 number | 比較基準可選「前一筆 / 前一日」 | 原 H1 只有前一筆 | H1:`latest()` 回 `{current, prev, prevDay}`,prevDay 需多讀一天 |
| §8.2 gauge | 警戒線 | 原 H2 沒提 | H2/H3:`options.warn` 畫一條線並超線變色 |
| §8.2 text | 粗體與清單 | 沒定義怎麼做 | H3:只支援 `**粗體**` 與 `- 項目` 兩種語法,解析後用 DOM 節點組裝,**禁 innerHTML** |
| §8.2 status | 下次排程時間、任務篩選 | 需要 alarms 與 health 資料 | H3:ctx 帶 `health`(`getHealth()`)與 `nextRuns`(由 background 回 `MSG.GET_NEXT_RUNS`,scheduler 已有計算) |
| §8.2 6 | ⌘Z / ⌘⇧Z 鍵盤綁定 | 原 G3 只寫 undo/redo 函式 | G3:編輯模式內綁 keydown,焦點在輸入框時不攔截 |
| §8.3 | 月曆切月、跳任意年月、拖曳選連續範圍 | 月曆沒有導覽 | J2 |
| §8.3 | 篩選 UI(任務多選、狀態、只看告警、值範圍、關鍵字) | `#filters` 是空的,state 有欄位但無 UI | J2(原本只寫「值範圍與關鍵字」,其實整組都沒有) |
| §8.3 | 紀錄列表欄序可拖曳 | 只有顯示/隱藏勾選 | J2 |
| §8.3 | 摘要列點任務名跳到該任務折線 | 無 | J2(依賴 H2) |
| §5/§8.5 | 歷史匯入:多個日檔 JSON 併回 `records`,同 taskId+capturedAt 去重 | storage 沒有 `importRecords` | F4:storage 加 `importRecords(dayFiles)`,回 `{added, skipped}` |
| §8.5 | 偏好:通知開關、預設額外等待秒數 | settings 有欄位無 UI | F4 |
| §8.5 | 站台登入管理 | §6 自動登入本體在 AF-3 | **不做**,F4 留佔位文字 |
| AF-1 F2 | 錯過清單橫幅:逐筆勾選補抓 / 略過 | `missed.js` 有 `skipOne` 但沒有 `catchUpOne` | F3:橫幅放任務頁上方;background 加 `catchUpOne(taskId, slot)` 與對應訊息 |
| §8.4 | 任務頁「編輯」開 Picker | Picker 只從右鍵訊息拿 ctx | F3:Picker 支援 `?taskId=` 開啟,自行從 storage 載入並 `render({task})`;無 tabId 時隱藏「立即測試」 |
| §8.1 | 開啟即呈現儀表板為首頁 | 預設 view 是 history | I2:預設 `dashboard`;沒有卡片時顯示空狀態(「套用範本」「去任務頁」兩個按鈕) |

明確**列入 BACKLOG 不做**:拖曳的鍵盤替代操作(無障礙)、卡片超過 30 張的虛擬化、
儀表板匯出成圖片。

## 待決事項(第二批)

| # | 問題 | 建議 | 理由 |
|---|---|---|---|
| F | 卡片自己的「期間 1/7/30/90 天」與頂部共用範圍列衝突 | 卡片期間選項預設 **「跟隨範圍列」**,另可固定 1/7/30/90;固定時卡片標題角落顯示小標「近 7 天」 | SPEC 兩處都寫了,並存最不意外;總覽卡片通常想固定看近 7 天,不受翻頁影響 |
| G | 儀表板一次要讀多少紀錄 | 每次重畫**只讀一次**:取所有卡片需要的最大範圍(含 prevDay 多一天),各卡片從同一份切片 | 卡片各自讀 storage 會 N 倍慢 |
| H | 獨立 HTML 報表(K1)要不要能互動 | **靜態快照**:匯出時把卡片渲染成 SVG/HTML 內嵌,不帶 JS | 沒有打包步驟,把 charts.js 原始碼塞進字串很脆;離線可開、可寄的需求靜態就滿足;互動版列 BACKLOG |
| I | 任務頁「複製任務」的行為 | 複製成新 id、名稱加「(副本)」、**停用**狀態、不自動加入儀表板 | 避免一複製就開始抓 |
| J | 版面 `version` 遇到未知更高版本 | 照讀不丟棄,缺欄位補預設,並在儀表板頂部提示「版面來自較新版本」 | 使用者換機匯入時最常遇到 |

## 使用者視角壓力測試(2026-09-06,假想 Reddit 上的評論)

把工具丟到 r/chrome_extensions、r/datahoarder、r/selfhosted 會收到的典型留言,逐條對照現況與規劃:

| 假想留言 | 現況 | 處置 |
|---|---|---|
| 「用了半年,某天才發現網站改版後選擇器壞了,資料默默斷了三週」 | 有預檢與通知,但任務頁看不到「連續失敗幾次」,壞了也沒地方一鍵重選 | **F3**:任務列顯示連續失敗數與最後錯誤;「重新選取元素」開目標頁並讓 content 進入選取模式帶原 taskId(content 若無此模式則退化為只開頁面並提示右鍵重選,暫定)。**H3**:number/status 卡片顯示 `—` 時 hover 顯示最後錯誤原因 |
| 「我不小心刪了任務,六個月的紀錄一起沒了」 | `deleteTask` 直接連紀錄一起刪,confirm 只問一句 | **F3**:刪除對話框顯示「將一併刪除 N 筆紀錄」,提供「先匯出再刪除」按鈕(呼叫既有 CSV 匯出後才刪) |
| 「存了一年後突然寫不進去,原來 storage.local 有 10MB 上限」 | manifest 沒有 `unlimitedStorage`;沒有任何用量顯示 | **G0**:manifest 加 `unlimitedStorage`。**F4**:設定頁顯示目前用量(`getBytesInUse`)、紀錄總筆數、最舊日期,以及上次匯出設定/紀錄的時間 |
| 「Chrome 沒開的時候不會抓,這件事應該講清楚,不然以為壞了」 | 錯過清單有,但首次使用沒人告訴他 | **I2**:儀表板空狀態文字明講「只在 Chrome 開著時抓取;錯過的排程會列在任務頁」;**H3** status 卡片顯示錯過筆數 |
| 「40 個任務之後任務頁根本找不到東西」 | 任務頁尚未存在 | **F3**:任務頁加關鍵字搜尋(名稱/網址)與「只看失敗」勾選 |
| 「我想把三個網站的價格放同一張圖,可是量級差太多」 | 多序列有,無正規化 | **H1/I1**:line 卡片加 `normalize: none / percentFromFirst`(以各序列首值為 100%) |
| 「數字卡片只有一個數字,看不出趨勢」 | — | **H3**:number 卡片可選顯示迷你 sparkline(H2 已規劃 sparkline) |
| 「圖上看到一個怪點,想點進去看那天的原始紀錄」 | — | **H3**:折線/長條的點可點,跳到歷史查詢該日並篩該任務(用既有 hash 機制) |
| 「網站顯示錯了一次抓到 0,整張圖被拉壞,我想刪那一筆」 | 紀錄不能刪 | **J2**:單筆紀錄展開後可刪除(confirm);storage 加 `deleteRecord(date, taskId, capturedAt)` |
| 「表格想直接貼到 Excel」 | — | **J2**:紀錄列表與樞紐表加「複製為 TSV」;**H3** table 卡片同 |
| 「line 卡片選了文字模式的任務,畫出一片空白不知道為什麼」 | 抽屜沒限制 | **I1**:來源清單依卡片型別過濾,text 模式任務在 number/line/bar/gauge 下顯示為停用並註明原因 |
| 「有五個儀表板,每次打開都回到第一個」 | — | **I2**:記住最後開啟的儀表板(hash `dash=<id>`,無 hash 時用 settings 記的) |
| 「通知太吵」 | settings 有 `notifications` 欄位,無 UI | **F4**(已列) |
| 「這東西會不會把我的資料傳到哪裡?權限要 `<all_urls>` 很可怕」 | 不連外,但沒地方講 | **F4**:設定頁底部固定一段「不連任何伺服器、資料只在本機」與權限用途說明;README 收尾時同步(project-closeout) |
| 「匯出的 HTML 想直接列印給老闆」 | K1 靜態快照 | **K1**:加 `@media print` 樣式,卡片不跨頁截斷 |

**列入 BACKLOG(本輪不做,附觸發條件)**:英文介面 / i18n(上架或分享給非中文使用者時)、
抓到值時 POST 到 webhook 或 Google Sheets(使用者要接自動化時,與 AF-3 告警同一機制)、
值未變化時不寫紀錄的選項(紀錄量成為問題時)、從 Distill / Visualping 匯入(有人問時)、
互動版 HTML 報表、拖曳的鍵盤替代操作、30 張以上卡片虛擬化、儀表板匯出圖片。

## 待決事項(第三批)

| # | 問題 | 建議 | 理由 |
|---|---|---|---|
| K | 「重新選取元素」要不要做到 content 端的選取模式 | 做,但標**暫定**:規格寫「content 收到 `MSG.REPICK {taskId}` 進入高亮選取模式,點選後開 Picker 帶入既有任務」;委派時若 content 現有結構不容易接,退化為只開頁面 | 這是「壞了怎麼修」的核心體驗,值得試;退化路徑先寫好就不會卡段 |
| L | 刪紀錄要不要留痕 | 不留痕,直接刪 | 使用者自己的本機資料;留痕是另一套機制 |
| M | 儀表板空狀態要不要放「示範資料」 | 不放 | 假資料會混進匯出;用三個範本 + 說明文字就夠 |

## 作業總覽

- 委派模型:整輪 agy `gemini-3.8-flash-high`;幾行內的修改標「Claude」自己做。
- 每段流程:Claude 寫驗收測試並 commit → 抄一份階段規格到 `.gemini-tasks/` → agy 實作 → Claude 突變驗收 → 填執行紀錄。
- 測試檔命名 `tests/<段代號小寫>_<主題>.test.js`;基線 **293 綠**,每段驗收寫「總數 ≥ N」。
- 共用限制(每段規格都附):只改白名單檔案;不重整目錄與文件;不加規格沒要求的抽象層、設定項、泛化參數;同一判定用在兩處以上就抽函式;不用 `innerHTML` 塞任何來自 storage 的內容;UI 模組載入時不得讀 storage 或渲染;動手前不要跑測試建基準;不讀 `docs/archive/`。
- 順序:**G0 → F3 → F4 → G1 → G2 → H1 → H2 → H3 → G3 → I1 → I2 → J1 → J2 → K1**。
- 儲存 schema 新增(G2 定案,H/I/J 沿用):

```
layout = { version: 1, dashboards: [ { id, name, cards: [ Card ] } ], lastDashboardId? }
Card   = { id, type, x, y, w, h, title?, source: [ { taskId, aggregation } ], options: {} }
type   ∈ number | line | bar | table | gauge | text | status
aggregation ∈ raw | dailyLast | dailyMax | dailyMin | dailyAvg | dailySum
options(依型別):
  共用  period: 'range' | 1 | 7 | 30 | 90(預設 'range' = 跟隨範圍列)
  number  decimals, unit, compare: 'prev' | 'prevDay', thresholds: [{op:'gte'|'lte', value, color}], sparkline: bool
  line/bar yMin, yMax, normalize: 'none' | 'percentFromFirst'
  table   mode: 'recent' | 'pivot', limit(N), columns: [key]
  gauge   min, max, warn
  text    content(僅支援 **粗體** 與行首 "- " 清單)
  status  taskIds: [](空 = 全部)
```

## 作業與階段

### G0 基礎整備(Claude 為主,小段委派)

| 項目 | 契約 | 執行者 |
|---|---|---|
| 抽出 `src/ui/theme.css` | report/popup/picker 三個 html 的 `:root` 變數搬到同一檔,加 `--chart-1`~`--chart-8`(亮/暗各一組)、`--ok`/`--warn`;深色切換改為 `html[data-theme="dark"]` 與 `prefers-color-scheme` 雙軌;report 載入時依 `settings.theme`(system/light/dark)設 `data-theme` | agy |
| 日期範圍列升級 | `#range-bar` 搬到 `nav` 之下、所有 panel 之上;加「自訂」(兩個 date input)與 `‹ ›` 逐日、`« »` 逐週翻;翻頁保持目前範圍長度;`logic.js` 加 `shiftRange(from, to, days)` 純函式 | agy |
| manifest | 加 `options_page: "ui/report/report.html"`、permission `unlimitedStorage` | Claude |
| 紀錄補任務名 | report 載入時 `getTasks()` 建 `tasksById`,紀錄併入 `taskName`(已刪任務顯示 `taskId`) | Claude |
| 移除假修 | 刪 `settings-io.js` 的 exportedAt 日期改寫;`e2_settings` 改為斷言 `data` 內沒有 `rec:` 鍵 | Claude |

驗收:`npm test` ≥ 305;`grep -c "^\s*--[a-z]" src/ui/*/*.html` 為 0(變數只在 theme.css);`grep -c "chart-[1-8]" src/ui/theme.css` ≥ 16;`grep -c "2026-09-05" src/shared/settings-io.js` 為 0;煙霧測試三頁開啟正常。
測試(Claude 寫 12+):shiftRange 逐日/逐週/月底跨月;自訂範圍 from>to 時交換;theme 三種值對應 data-theme;紀錄 taskName 併入與已刪任務退回 id。

### F3 任務頁

- **目標**:SPEC §8.4 全部 + 錯過清單橫幅 + 失敗可見性。
- **檔案**:`src/ui/report/tasks.js`(新)、`report.html`(panel-tasks 內容)、`src/background/missed.js`(加 `catchUpOne`)、`src/background/main.js`(訊息)、`src/shared/messages.js`、`src/ui/picker/picker.js`(`?taskId=` 載入)、`src/content/main.js`(REPICK,暫定)。
- **契約**:
  - `renderTasks(tasks, health, missed)` 列出:名稱、網址(截斷)、模式、排程摘要、啟用開關、下次執行、最後狀態、連續失敗數(`notFoundStreak`)、最後錯誤(hover)。
  - 拖曳排序寫回 `order`(Pointer Events,與 G3 同一套接線原則:只讀 clientX/Y,`setPointerCapture` 存在才呼叫)。
  - 動作:立即抓取(`MSG.RUN_TASK`)、編輯(開 `picker.html?taskId=`)、複製(新 id、名稱加「(副本)」、`enabled:false`、不進儀表板)、刪除(對話框顯示「將一併刪除 N 筆紀錄」+「先匯出再刪除」按 CSV 匯出後才刪,取消時 storage 不變)、重新選取。
  - 搜尋框(名稱/網址包含)與「只看失敗」勾選,純函式 `filterTasks(tasks, {q, failedOnly})`。
  - 錯過清單橫幅在清單上方:逐筆勾選 → 「補抓勾選」/「略過勾選」;新增訊息 `MSG.CATCH_UP_ONE {taskId, slot}`、`MSG.SKIP_ONE`;background `catchUpOne` 走既有帳本冪等路徑。
  - Picker 以 `?taskId=` 開啟時從 storage 載任務並 `render({task})`,沒有 tabId 時隱藏「立即測試」。
  - 重新選取(**暫定**):新增 `MSG.REPICK {taskId}`,content 進入高亮選取模式,點選後以既有右鍵流程開 Picker 並帶入原任務;若 content 現有結構不易接,退化為「開目標頁 + 提示右鍵重選」並在回報說明。
- **不要做**:不改 Picker 表單欄位;不改排程邏輯。
- **驗收**:`npm test` ≥ 330;`grep -c "CATCH_UP_ONE\|SKIP_ONE\|REPICK" src/shared/messages.js` = 3;煙霧測試:任務頁列出 2 個任務、刪除取消後 storage 不變。
- 測試(Claude 寫 25+):filterTasks 四組;複製任務屬性;刪除確認取消不動、確認後 tasks 與 rec 皆清;catchUpOne 同 slot 重呼叫不重複寫;missed 橫幅勾選後只送勾選那幾筆;`?taskId=` 載入帶入表單;排序後 order 連續。

### F4 設定頁

- **目標**:SPEC §8.5(站台登入除外)+ 排程健康 + 儲存用量 + 隱私說明。
- **檔案**:`src/ui/report/settings.js`(新)、`report.html`、`src/shared/storage.js`(加 `importRecords`、`getStorageStats`)。
- **契約**:
  - 匯出區:範圍(單日/本月/全部/自訂,沿用頂部範圍列的值為預設)+ 格式 JSON/CSV/HTML(HTML 按鈕本段先停用並標「K1 後啟用」);按下才呼叫既有 `buildExport`+`download`。
  - 設定匯出/匯入:呼叫既有 `exportSettings`/`importSettings`;含密碼勾選時要求密語;匯入結果顯示新增/覆蓋數。
  - 歷史匯入:多選日檔 JSON → `importRecords(dayFiles)` 以 `taskId+capturedAt` 去重,回 `{added, skipped}`;接受 §5 日檔 schema 與 `{days:[...]}` 打包格式兩種。
  - 偏好:保留天數、通知開關、額外等待秒數、深色模式;每個變更立即 `saveSettings`。
  - 排程健康:每任務下次觸發實值(alarms `scheduledTime`,經 `MSG.GET_NEXT_RUNS` 回)、看門狗上次時間、最近 20 筆 `diag.getAll()`、「立即自檢」按鈕(`MSG.SELF_CHECK`)。
  - 儲存用量:`getStorageStats()` 回 `{bytes, recordCount, oldestDate, lastSettingsExportAt, lastRecordsExportAt}`;匯出成功時寫入對應時間戳到 settings。
  - 隱私段落固定文字:不連任何伺服器、資料只在本機、每個權限的用途一句。
- **驗收**:`npm test` ≥ 355;`grep -c "GET_NEXT_RUNS\|SELF_CHECK" src/shared/messages.js` = 2;煙霧測試:每個按鈕觸發對應 mock 一次。
- 測試(Claude 寫 25+):importRecords 去重/兩種格式/壞 JSON 回錯不寫;getStorageStats 空庫;偏好變更寫入;匯出後時間戳更新;HTML 按鈕 disabled。

### G1 格線數學(純函式)

- **檔案**:`src/ui/report/layout.js`(新,無 DOM、無 storage)。
- **契約**:`COLS=12`、`MAX_H=6`;`clampCard(card)`;`collides(a,b)`;`compact(cards)`(依 y 再 x 排序後逐張往上推,回新陣列不改原物件);`placeCard(cards, card)`(放入並把被壓到的往下推,連鎖處理,回新陣列);`findFreeSlot(cards, w, h)` 最上最左;`autoArrange(cards, widthByType)`(預設 number 3、gauge 3、status 4、line 6、bar 6、text 6、table 12)由上到下填滿,不重疊、不超欄;`resizeCard(cards, id, w, h)` clamp 後 placeCard。
- **驗收**:`npm test` ≥ 390;`grep -c "document\|chrome\." src/ui/report/layout.js` = 0。
- 測試(Claude 寫 35+):邊界夾取六組;連鎖擠壓三層;compact 冪等;autoArrange 不重疊且每張 x+w ≤ 12;空清單;不改輸入(deepEqual 前後)。

### G2 版面儲存

- **檔案**:`src/shared/layout-store.js`(新)、`src/shared/storage.js`(`deleteTask` 內呼叫 prune;`getLayout`/`saveLayout` 為唯一讀寫)、`src/shared/settings-io.js`(匯入時走 `saveLayout` 以套用版本補齊)。
- **契約**:schema 見作業總覽;`getLayout()` 讀取時補 `version` 與缺欄位、未知更高版本照讀並回傳 `{layout, newerVersion:true}`;沒有任何儀表板時自動建一個「預設」;`addDashboard/renameDashboard/deleteDashboard(刪最後一個則重建空的)/duplicateDashboard(卡片 id 全新)/reorderDashboards`;`addCard(dashId, card)` 自動配 id 與 `findFreeSlot`;`updateCard`/`removeCard`;`pruneCardsForTask(taskId)` 多來源只移除該來源、來源清空才刪卡、text 卡片不受影響;`setLastDashboard(id)`。
- **驗收**:`npm test` ≥ 420;`grep -c "storage.local" src/shared/layout-store.js` = 0(只經 storage.js);`grep -c "pruneCardsForTask" src/shared/storage.js` ≥ 1。
- 測試(Claude 寫 30+):版本補齊、更高版本旗標、deleteTask 連動、多來源只掉一個、複製 id 不重複、刪最後一個自動留一個、settings 匯入舊版 layout 補欄位。

### H1 資料序列(純函式)

- **檔案**:`src/ui/report/series.js`(新)。
- **契約**:`buildSeries(records, source, {from, to, aggregation, normalize})` → 每個來源一條 `{taskId, points:[{t, v}]}`;`raw` 用 slot 為 t;每日聚合的 t 為 `YYYY-MM-DD`;**失敗紀錄產生 `{t, v:null}`**,每日聚合當天全失敗也是 null;非數值 value 不計入;`normalize:'percentFromFirst'` 以第一個非 null 值為 100;`resolvePeriod(period, rangeFrom, rangeTo, today)` 回實際 from/to(`'range'` 用範圍列,數字用近 N 天含今天);`latest(records, taskId, today)` → `{current, prev, prevDay}`(prevDay = 前一天最後成功筆,沒有則 null);`pivot(records, taskIds, taskOrder)` → `{columns, rows:[{t, values}]}`;`summarizeRange` 沿用 logic.js 不重寫。
- **驗收**:`npm test` ≥ 450;`grep -c "document\|chrome\." src/ui/report/series.js` = 0。
- 測試(Claude 寫 30+):六種聚合各一組(含當天全失敗)、null 保留、跨日邊界(Asia/Taipei)、normalize 首值 null 時取下一個、resolvePeriod 四種、latest 三種基準、pivot 欄序照 taskOrder、空輸入。

### H2 SVG 圖表

- **檔案**:`src/ui/report/charts.js`(新)。
- **契約**:`lineChart(seriesList, {width, height, yMin, yMax, unit})`、`barChart`、`gauge({value, min, max, warn})`、`sparkline(points, {width, height})` 皆回 `<svg>` 元素;`v:null` 處路徑斷開(下一個非 null 重新 `M`);多序列顏色 `var(--chart-n)` 循環;每個資料點有 `<title>` 含時間與值;`data-t` 屬性供點擊;全 null 或空序列回帶「沒有資料」文字的 svg;Y 軸自動範圍留 5% 邊距,指定時生效;gauge 超過 warn 時加 class `over-warn`;不畫格線以外的裝飾。
- **驗收**:`npm test` ≥ 475;`grep -cE "#[0-9a-fA-F]{3,6}|rgb\(" src/ui/report/charts.js` = 0。
- 測試(Claude 寫 25+):`M` 數等於區段數、單點、全 null、yMin/yMax 生效、顏色字串含 `--chart-`、每點有 title 與 data-t、gauge warn class、sparkline 無軸。

### H3 卡片渲染

- **檔案**:`src/ui/report/cards.js`(新)。
- **契約**:`renderCard(card, ctx)` → 元素;`ctx = {records, tasksById, health, nextRuns, missed, range:{from,to}, today, onPointClick}`;七型別;標題沒填用來源任務名(多來源用「、」串);值失敗一律 `—` 並在 `title` 屬性放最後錯誤;number:小數位/單位/差異箭頭與百分比(基準 prev/prevDay)/閾值上色(class `threshold-hit` + inline `--card-accent` 變數)/可選 sparkline;line/bar 點擊呼叫 `onPointClick({taskId, date})`;table recent 模式最近 N 筆、pivot 模式用 series.pivot,附「複製 TSV」按鈕(`navigator.clipboard` 不存在時隱藏);gauge;text 只解析 `**粗體**` 與行首 `- `,以 DOM 節點組裝;status 每任務最後狀態、下次執行、錯過筆數;未知型別回錯誤卡片不丟例外;period 固定時右上角小標「近 N 天」。
- **驗收**:`npm test` ≥ 505;`grep -c "innerHTML" src/ui/report/cards.js` = 0。
- 測試(Claude 寫 30+):每型別 3~5 條,含「失敗不顯示 0」「負差異下箭頭」「閾值上色」「text 的 `<b>` 注入被當純文字」「未知型別」「多來源標題」「period 小標」。

### G3 儀表板接線:拖曳、縮放、編輯模式、復原重做

- **檔案**:`src/ui/report/dashboard.js`(新)、`report.html`(panel-dashboard 結構與 CSS)、`report.js`(view=dashboard 時呼叫)。
- **契約**:
  - `renderDashboard(dash, ctx)`:一次讀取(所有卡片需要的最大範圍 + prevDay 多一天)後各卡片切片;每張卡片各自重畫。
  - 編輯模式按鈕 `#edit-layout`;瀏覽模式下卡片無把手、拖曳無效。
  - 拖曳與縮放用 Pointer Events,只讀 `clientX/clientY/pointerId`,`setPointerCapture` 存在才呼叫;像素→格線換算純函式 `pxToGrid`;拖曳中顯示佔位陰影(`.ghost`)與吸附;放開時 `placeCard`+`compact` 後 `saveLayout`。
  - `undo()`/`redo()` 只記版面快照,上限 50,離開編輯模式清空;⌘Z/⌘⇧Z(Ctrl 同)僅在編輯模式且焦點不在輸入元件時攔截。
  - 視窗 < 900px:容器加 `single-column`,以 DOM 順序(y 再 x)疊放,**storage 不變**。
  - 儀表板頂部若 `newerVersion` 顯示提示列。
- **驗收**:`npm test` ≥ 530;真實瀏覽器手動確認拖曳手感並截圖;煙霧測試:儀表板有 1 張卡片且渲染出 svg。
- 測試(Claude 寫 25+,MouseEvent 合成):拖到格後 x/y 正確、縮放 clamp、瀏覽模式無效、undo/redo、上限 50、窄視窗 class 且 storage 不變、keydown 在 input 內不攔截、一次讀取(mock 計數 `storage.local.get` 呼叫次數 ≤ 2)。

### I1 卡片設定抽屜

- **檔案**:`src/ui/report/drawer.js`(新)、`report.html`。
- **契約**:齒輪開抽屜;欄位依型別顯示(對照作業總覽 options);來源清單依型別過濾(text 模式任務在 number/line/bar/gauge 下 disabled 並顯示原因);每次變更即 `updateCard` 並只重畫該卡片;「還原」回開啟時快照;關閉即存;抽屜開著時其他卡片不重畫;刪除卡片按鈕(confirm)。
- **驗收**:`npm test` ≥ 555。
- 測試(Claude 寫 25+):改型別重畫、改來源序列變、還原、關閉後 storage、來源過濾 disabled、其他卡片 DOM 節點同一參照、刪卡片。

### I2 一鍵排版、範本、多儀表板、空狀態

- **檔案**:`src/ui/report/templates.js`(新,純函式)、`dashboard.js`、`report.html`、`report.js`(預設 view)。
- **契約**:自動排列按鈕(`autoArrange`);三範本 `overview`/`deepDive`/`compare` 接受任務清單回卡片陣列(套用 = 取代目前儀表板卡片,confirm);儀表板頁籤新增/改名/排序(拖曳)/複製/刪除(confirm);hash `dash=<id>`,無 hash 用 `lastDashboardId`;預設 view 改 `dashboard`;空狀態:文字明講「只在 Chrome 開著時抓取;錯過的排程列在任務頁」+「套用範本」「去任務頁」按鈕。
- **驗收**:`npm test` ≥ 575;煙霧測試:無 hash 開啟落在儀表板。
- 測試(Claude 寫 20+):三範本卡片數/型別/不重疊、text 任務在 deepDive 只進 table、頁籤操作反映 storage、lastDashboardId、空狀態文字。

### J1 Picker「加入儀表板」

- **檔案**:`src/ui/picker/picker.js`、`picker.html`。
- **契約**:新建任務(`currentCtx.task` 為空)時表單底部區塊:儀表板下拉(含「不加入」)+ 型別勾選(number 模式預設 number+line,text 模式預設 table);`saveTask` 後依勾選 `addCard`,再 REBUILD_ALARMS、close;編輯既有任務不顯示此區塊;儀表板清單來自 `getLayout()`。
- **驗收**:`npm test` ≥ 590。
- 測試(Claude 寫 12+):預設勾選依模式、存檔後 layout 有卡片且 source 正確、不加入時無、編輯不重複、儀表板不存在時退回預設儀表板。

### J2 歷史查詢進階

- **檔案**:`report.js`、`logic.js`、`report.html`、`storage.js`(`deleteRecord`)。
- **契約**:篩選 UI(任務多選、狀態、只看告警、值範圍 ≥/≤、關鍵字)全部進 hash;月曆切月/跳年月/拖曳選範圍;欄序拖曳並存 `settings.history`;樞紐表模式(欄序依任務頁 order)與「與另一天比較」(第二日期,並排值與差異);摘要點任務名 → 儀表板臨時折線(不存版面,直接在歷史頁下方畫,用 H2);單筆展開可刪除(confirm,`deleteRecord(date, taskId, capturedAt)`);「複製 TSV」;範圍 > 90 天分頁 500 筆,摘要仍算全範圍;`filterRecords` 擴充值範圍與關鍵字。
- **驗收**:`npm test` ≥ 620;煙霧測試:篩狀態=失敗後列數為 1。
- 測試(Claude 寫 30+):新篩選各組、hash 往返、樞紐表欄序、比較差異計算、分頁邊界(1500 筆 3 頁,摘要全範圍)、deleteRecord 只刪那一筆、欄序存取。

### K1 獨立 HTML 報表

- **檔案**:`src/shared/export.js`(加 `buildHtmlReport`)、`settings.js`(啟用按鈕)。
- **契約**:輸入範圍 + 目前儀表板;輸出單一 HTML 字串:內嵌 `theme.css` 亮色變數、卡片以 H3/H2 渲染成靜態 DOM(把 svg 序列化)、下方附紀錄表;無 `<script>`、無外部資源、無 `chrome.`;`@media print` 卡片不跨頁;檔名 `AutoFetcher/report-<from>_<to>.html`。
- **驗收**:`npm test` ≥ 632;`grep -c "<script" <產出>` = 0;在瀏覽器直接開產出檔有卡片與表格。
- 測試(Claude 寫 12+):jsdom 可載入、含卡片標題與 svg、不含 `chrome.`/`http`/`<script`、空儀表板仍有紀錄表、print 樣式存在。

## 風險與對策

| 風險 | 對策 |
|---|---|
| 拖曳在 jsdom 測不出真實手感 | 純函式測數學、合成事件測接線;**手感只能在真實瀏覽器看**,G3 與 I2 後各跑一次煙霧測試並截圖 |
| SVG 圖表在深色模式看不清 | 顏色一律用 CSS 變數,`theme.css` 同時定義亮/暗兩組;驗收檢查模組內沒有色碼字面值 |
| 卡片變多後重畫變慢 | 每張卡片各自重畫,不整頁重建;先不做虛擬化,卡片數超過 30 才考慮(列入 BACKLOG) |
| 版面 schema 變動讓舊資料壞掉 | `layout` 加 `version` 欄位,讀取時缺欄位補預設,不丟棄整份版面 |

## 執行紀錄

| 階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| (執行後填) | | | | |
