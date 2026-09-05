# AF-2 規劃:報表儀表板自訂版面

> 狀態:規劃完成(2026-09-06),A~J 已定案(全採建議);**待定案第三批 K~M**。基線 `npm test` 293 綠 + `./run_smoke.sh` 通過。

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

## 作業與階段

每階段一次委派、可獨立驗收。測試一律 Claude 先寫並 commit,再委派實作,驗收含突變測試。

### G 版面引擎

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| G1 | 格線數學(純函式)`src/ui/report/layout.js` | `clampCard(card)` 夾到 1≤w≤12、1≤h≤6、x+w≤12、y≥0;`collides(a,b)`;`compact(cards)` 依 y 再 x 排序後逐張往上推到不重疊;`placeCard(cards, card)` 放入並擠開被壓到的(被壓者往下移,遞迴處理連鎖);`findFreeSlot(cards, w, h)` 找最上最左的空位;`autoArrange(cards, widthByType)` 依型別給寬度後由上到下填滿 | 30+ 測試:邊界夾取、連鎖擠壓、compact 冪等(跑兩次結果相同)、autoArrange 不重疊且不超出 12 欄、空清單不丟錯 |
| G2 | 版面儲存 `src/shared/layout-store.js` | `getLayout()`/`saveLayout(l)`;`addDashboard(name)`/`renameDashboard(id,name)`/`deleteDashboard(id)`/`duplicateDashboard(id)`/`reorderDashboards(ids)`;`addCard(dashId,card)`(自動配 id 與空位)/`updateCard(dashId,cardId,patch)`/`removeCard(dashId,cardId)`;`pruneCardsForDeletedTasks()` 刪除已不存在任務的卡片(多來源卡片只移除該來源,來源清空才刪卡);唯一寫入口仍是 `shared/storage.js` | 25+ 測試:含「刪任務後卡片一併消失」「多來源卡片只掉一個來源」「複製儀表板的卡片 id 全新」「刪掉最後一個儀表板會自動留一個空的」 |
| G3 | 拖曳、縮放、編輯模式、復原重做 `src/ui/report/dashboard.js` | Pointer Events;編輯模式開關(`#edit-layout`);拖曳中顯示佔位陰影與吸附格線;右下角把手縮放;`undo()`/`redo()` 上限 50、離開編輯模式清空;視窗寬 < 900px 時單欄疊放(**不改存檔版面**) | 20+ 測試(jsdom 合成 pointer 事件):拖到某格後 card.x/y 正確、縮放後 w/h 正確且被 clamp、瀏覽模式下拖曳無效、undo 回到前一版面、redo 再回來、窄視窗時 DOM 有 `single-column` 類別但 storage 內 x/y 不變 |

### H 卡片型別

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| H1 | 資料序列(純函式)`src/ui/report/series.js` | `buildSeries(records, source, options)` → `[{t, v}]`;`aggregation` 支援 `raw`/`dailyLast`/`dailyMax`/`dailyMin`/`dailyAvg`/`dailySum`;期間 1/7/30/90 天切片;**缺值產生 `{t, v: null}` 不是略過**(圖表才畫得出斷線);多來源回多條序列;`latest(records, taskId)` 回最新一筆與前一筆供 number 卡片算差異 | 25+ 測試:每種聚合各一組、缺值保留為 null、跨日邊界、空資料回空陣列、非數值不計入聚合 |
| H2 | SVG 圖表 `src/ui/report/charts.js` | `lineChart(series, opts)`/`barChart`/`gauge`/`sparkline` → 回傳 SVG 元素;多序列各一條路徑;`v: null` 處**斷開路徑**;Y 軸自動範圍或指定;顏色取自 CSS 變數 `--chart-1`~`--chart-8`;每點有 `<title>` 供 hover 顯示值與時間 | 20+ 測試:斷線處 path 的 `M` 指令數等於區段數、單點資料不炸、全 null 顯示「沒有資料」、Y 軸範圍指定時生效、顏色用的是變數不是色碼 |
| H3 | 卡片渲染 `src/ui/report/cards.js` | `renderCard(card, ctx)` → 元素。七型別:`number`(值+差異箭頭+閾值色)、`line`、`bar`、`table`(最近 N 筆或樞紐表)、`gauge`、`text`、`status`。失敗值一律顯示 `—`;卡片標題可自訂,沒填就用來源任務名 | 25+ 測試:每型別各 2~4 條,含「抓不到不顯示 0」「差異為負顯示下箭頭」「閾值超過時上色」「未知型別回錯誤卡片不丟例外」 |

### I 設定體驗

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| I1 | 卡片設定抽屜 `src/ui/report/drawer.js` | 點卡片齒輪滑出;欄位:型別、來源任務(多選)、聚合、期間、標題、單位、小數位、閾值與顏色、Y 軸範圍;**每次變更立即套用並重畫該卡片**;「還原」回到開啟抽屜時的狀態;關閉即存檔 | 20+ 測試:改型別後卡片重畫、改來源後序列變、還原真的還原、關閉後 storage 內容正確、抽屜開著時不影響其他卡片 |
| I2 | 一鍵排版、範本、多儀表板頁籤 | `autoArrange` 按鈕;三種範本(總覽 / 單一指標深入 / 多任務比較)套用到目前儀表板;頁籤新增、改名、排序、複製、刪除(刪除要確認) | 15+ 測試:套範本後卡片數與型別正確且不重疊、自動排列後無重疊、頁籤操作反映到 storage |

### J 接線與歷史進階

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| J1 | Picker「加入儀表板」 | 建立任務最後一步:選儀表板 + 卡片型別(number 模式預設 `number` + `line`,text 模式預設 `table`),存檔後卡片排到版面末端;可選「不加入」 | 12+ 測試:存檔後 layout 內有對應卡片、選不加入時沒有、編輯既有任務不重複加入 |
| J2 | 歷史查詢進階(SPEC §8.3 剩餘) | 樞紐表模式(列=時間、欄=任務,欄序沿用任務頁順序)、與另一天比較、值範圍與關鍵字篩選 UI、超過 90 天時分頁(每頁 500 筆,摘要仍算全範圍) | 18+ 測試 |

### K 匯出

| 階段 | 目標 | 契約 | 驗收 |
|---|---|---|---|
| K1 | 獨立 HTML 報表 | 單一 `.html`,內嵌所選範圍的資料與目前儀表板版面,離線可開、可寄給別人;不含任何外部資源與 `chrome.*` 呼叫 | 10+ 測試:產出字串可被 jsdom 載入、含資料、不含 `chrome.`、不含 http 連結;端到端在瀏覽器開起來有內容 |

執行順序:G1 → G2 → H1 → H2 → H3 → G3 → I1 → I2 → J1 → J2 → K1。
(G3 排在 H 之後,因為拖曳要有真的卡片才驗得出來。)

委派:全部 agy `gemini-3.8-flash-high`;測試與驗收由 Claude 負責,每段做突變測試。
每段完成後跑 `./run_smoke.sh`,G3 與 I2 之後另外在真實瀏覽器手動確認一次拖曳手感。

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
