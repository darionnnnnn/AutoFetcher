# AF 第 20 輪規劃

> 狀態:實作完成、已驗收(分支 `r20`,2503 綠,Chrome 煙霧全過);待使用者實測閃爍與 Edge,之後換模型體檢收尾
> 基準:dev@5acc5f8(2445 綠 / v0.18.0)
> 來源:使用者回饋兩條——①排程能否在背景處理、不開新分頁、不影響當下操作;②一次抓多個值時前置動作要做幾次。
> 核對與探針中另外發現 7 條(A-1~A-5、B-1、B-2),使用者定案全部納入本輪。

## 作業總覽

| 作業 | 內容 | 規模 | 相依 |
|---|---|---|---|
| A | 抓取分頁的唯一入口 `background/fetch-tab.js`:專用最小化視窗、排程不再碰使用者的分頁、站台檢查併入、孤兒清理 | 大(fetcher / sitecheck / watchdog / 設定頁) | 無 |
| B | 前置動作:重用分頁前還原頁面狀態、「拆成多任務」共用前置動作 | 中(fetcher / picker) | B1 依賴 A(重用規則住在 A 的入口裡) |
| C | 文件:SPEC §4、§4.1、§9、CLAUDE.md、BACKLOG、教學頁與 Picker 提示文案、版本號 0.19.0 | 小 | A、B |

建議順序:A1 →(**使用者實測閃爍,見 A 定案 5**)→ A2 → A3 → A4 → B1 → B2 → C。

- 委派模型:**agy**(整輪一種);測試由 Claude 先寫並做突變,再派實作。subagent 核對與終檢用 Opus low(`scan-low`)。
- 實作端只拿階段規格檔,不看本文件。

## 第 2 點的答覆(不需改動的部分)

**一個任務抓多個值:前置動作設定一次、排程時也只跑一次。** `preActions` 掛在任務層;流程是
開分頁 → 前置動作依序跑一次 → **一則** `EXTRACT` 訊息帶整份 `spec.fields`,頁面端一次抓完全部的值
(`fetcher.js` 前置動作迴圈只繞 `task.preActions`;存活重試區塊刻意把前置動作留在外面,不會重按)。
需要修的是下面 B-1、B-2 兩個相鄰缺口。

## 探針實測事實(Chrome for Testing 152 / Windows 11,已拿掉 puppeteer 的三個關閉節流旗標)

第一輪探針帶著 puppeteer 預設的 `--disable-background-timer-throttling` 等旗標,結果不可信,以下為拿掉後重跑。

| # | 做法 | 焦點 | 視窗狀態 | 頁面 `visibilityState` | viewport | rAF / 計時器 / IntersectionObserver |
|---|---|---|---|---|---|---|
| P0 | **現況**:使用者視窗的背景分頁 | 不搶 | — | hidden | 1036×751 | rAF 0、計時器節流(2.5 秒 3 次)、IO 不觸發 |
| P1 | `windows.create({ state:'minimized' })` | 不搶、零 `onFocusChanged` | 維持 minimized | **visible**(從未顯示過的怪癖) | **0×0** | 全部正常運作 |
| P2 | `state:'minimized'` **＋** `focused:false` | 不搶 | **靜默變成 normal 視窗** | hidden | 正常 | 同 P0 |
| P3 | `state:'minimized'` ＋ `type:'popup'` | **搶走焦點** | 變 normal | visible | 正常 | 正常 |
| P4 | `create({ focused:false, width, height })` 再 `update({ state:'minimized' })` | 不搶、零事件 | minimized | hidden | **保住**(1186×770) | 同 P0 |
| P5 | P4 的分頁 `tabs.update({ url })` 導去別頁 | 不搶 | minimized | hidden | 保住 | 同 P0 |
| P6 | 已最小化的視窗裡再 `tabs.create` | 不搶 | minimized | active→visible;背景→hidden | **0×0** | — |
| P7 | P1 之後 `windows.update({ width, height })` | 不搶 | minimized | visible | **仍是 0×0**(重載、導覽後也是) | — |
| P8 | 畫面外座標 `left:-2000` | — | **API 直接拒絕**(至少 50% 要在可見範圍) | — | — | — |
| P9 | 小視窗 300×200 再最小化 | 不搶 | minimized | hidden | 502×106(Chrome 最小寬約 500) | — |

所有做法下 `textContent`／`innerText` 都讀得到;`windows.remove` 後焦點留在使用者視窗。
**量不到的兩件事**:P4 視窗從建立到最小化之間(約 100~300 毫秒)在螢幕上看起來如何;工作列圖示的觀感。
**Edge**:本機 puppeteer 啟動 Edge 失敗(AF-18、AF-19 同樣),未實測。

結論:
- P1「零閃爍但 viewport 0×0」——RWD 站台會切成手機版 DOM、虛擬捲動表格會渲染 0 列,定位失敗的風險是新的,而且 `visible` 是怪癖不是契約。
- P4「與現況背景分頁完全同一種頁面環境(hidden、viewport 正常)」——擷取面零退化,代價是可能看得到一瞬間的視窗。
- **採 P4**;P1 進 BACKLOG(觸發條件:實測閃爍不可接受,且目標站台確認不依賴 viewport)。

## 作業 A:抓取分頁的唯一入口

### 現況與核對結果

| 項目 | 結果 | 證據 |
|---|---|---|
| 排程找不到既有分頁時 | 在使用者視窗開 `active:false` 分頁,抓完關 | `fetcher.js:421-433`、`:285-300` |
| 使用者開著同網址分頁時 | **直接拿來用**:注入、hover／click、`scrollIntoView`、登出時填帳密按送出,無任何守門 | `fetcher.js:411-419`、`:453`、`:509`、`:563` |
| A-1 重用的分頁不重載 | 只有 `discarded` 才 reload;開了三小時沒刷新的頁,每次抓到同一個舊值 | `fetcher.js:439-442` |
| A-2 「同一頁」兩種比法 | 指定分頁用 `sameOriginPath`;排程用 `tabs.query({ url })` 連 query 逐字比,違反 CLAUDE.md「不得各比一次」 | `fetcher.js:405`、`:412` |
| A-3 站台檢查另寫一份 | 自己 `tabs.create`＋輪詢＋關閉;不進同站台佇列、無「沒有視窗」保護 | `sitecheck.js:43-52`、`:72-78` |
| A-4 前景抓取不處理視窗焦點 | 全程只有 `tabs.update({active})`;多視窗時目標頁不會真的可見 | `fetcher.js:390-396`、`:415-419`、`:847-853` |
| A-5 自開分頁無上限、無孤兒清理 | 同站台 `pending` 不歸零就不關;service worker 中途被回收時 `createdTabs` 在記憶體裡一起消失,分頁永遠留著;看門狗只清 `inflight` 狀態不清分頁 | `fetcher.js:289-299`、`watchdog.js:85-109` |
| 預檢、補抓 | 都經 `runTask`,自動跟著新規則 | `precheck.js:98`、`missed.js:132` |
| 重選(repick) | 使用者主動操作、`active:true` 開在使用者視窗 | `main.js:695`——**不在本輪範圍** |
| SPEC 禁用 API | `offscreen`、`declarativeNetRequest` 明文不引入 | `SPEC.md:1462` |

### 定案

1. **不做「完全不開頁面」**(offscreen／`fetch`＋DOMParser):不執行頁面 JS、前置動作與 iframe 定位與自動登入全失效,等於另寫一套引擎;SPEC §9 也禁。
2. **排程、預檢、補抓、任務頁的手動抓取、站台檢查**一律在**專用視窗**抓:照 P4 建立(先 `focused:false` 帶尺寸、再最小化)。
   - **不得**同時給 `state:'minimized'` 與 `focused:false`(P2)、**不得**用 `popup`(P3)、**不得**在已最小化的視窗裡再開分頁(P6)。
   - **一個同站台佇列＝一個視窗＝一個分頁**;同佇列的下一個任務用 `tabs.update({ url })` 導覽(P5),不另開分頁。
   - 視窗尺寸暫定 1280×800。
   - 原本「沒有任何視窗時建最小化視窗」的特例併進這條路,不再另外存在。
3. **排程不再重用使用者開的分頁**,只重用本入口自己開的。「是不是同一頁」只用 `sameOriginPath`;`tabs.query({ url })` 從抓取路徑移除(A-1、A-2 一併消失)。
   立即測試(`TEST_TASK` 帶 `tabId`)照舊用使用者眼前的分頁;`tabId` 核對不過時走專用視窗。
4. **前景抓取維持「最後手段」語意**:在使用者**最後聚焦的一般視窗**(`windows.getLastFocused`)開 `active:true` 新分頁(同樣不重用使用者既有分頁);
   結束後把該視窗原本的作用分頁切回來,並關掉自己開的分頁。
   **實作時修正(A1 規格)**:原定「把視窗 `focused:true`、結束後還原聚焦視窗」取消——A-4 的成因是「重用了另一個視窗裡的使用者分頁」,
   改成一律在最後聚焦的視窗開新分頁後就不存在;再去搶 OS 層級的視窗焦點只會多打擾。
5. **設定頁新增「抓取頁面開在哪裡」**(設定鍵 `fetchTabMode`,暫定名):`window`(預設,專用最小化視窗)／`tab`(目前視窗的背景分頁＝現況做法,但同樣不重用使用者分頁)。
   它是閃爍與 Edge 兩個未知數的退路。**A1 驗收後先請使用者實測閃爍**:不可接受就把預設改成 `tab`,並把 P1 從 BACKLOG 提前討論。
   建專用視窗失敗時自動退回 `tab` 做法並寫診斷,不讓整次抓取失敗。
6. **站台檢查改經同一個入口**,不再自己開關分頁(A-3);是否進同站台佇列:進(與抓取互斥,避免登入檢查與抓取同時操作同站台的登入狀態)。
7. **孤兒與上限(A-5)**:
   - 入口把自己建的視窗／分頁 id 記在 `storage.session` 的 `fetchTabs`(每筆帶 `boot`＝這次 service worker 啟動時產生的識別碼);看門狗每輪清一次。
   - 什麼算孤兒:登記表裡 `boot` 不是目前這個 service worker 的那些。清單是空的＝不做事。**不得用網址或標題去猜哪個視窗是自己的**(會關到使用者的視窗)。
   - **實作時修正(A1 規格)**:原定「沒有 inflight 屬於它的佇列」作廢——同站台兩個任務交接時,前一個已清 inflight、後一個還沒寫,
     看門狗剛好落在這個空檔就會關掉正要被沿用的視窗。service worker 還活著,記憶體裡的佇列就會自己釋放;
     只有 service worker 被回收(記憶體連同佇列一起消失)才會產生孤兒,而那正是 `boot` 換掉的時候。
   - 登記表的讀改寫要在模組內串行化(不同站台的佇列是並行的,會互相覆蓋)。
   - 已知不處理:瀏覽器在抓取途中被關閉、下次啟動「繼續上次工作階段」把那個視窗還原回來——session 已清空、id 已換,認不出來。發生機率低,寫進 SPEC §4.1 風險表。
   - 同站台佇列不設任務數上限(刻意共用),孤兒清理就是保險。

### 改動

1. 新模組 `background/fetch-tab.js`:取得／導覽／釋放抓取分頁的唯一入口(含 `fetchTabMode` 分岔、退路、session 登記、`autoDiscardable:false`、`discarded` 重載、等 `complete`)。
   fetcher 的 `enqueueForOrigin` 釋放段改呼叫它。
2. `fetcher.js`:步驟 4~7(視窗檢查、找／開分頁、discard、等載入)改成呼叫入口;前景分支照定案 4;移除 `tabs.query({ url })`。
3. `sitecheck.js`:開關分頁與輪詢改經入口並進同站台佇列;既有 `finally` 關閉語意由入口的釋放承接。
4. `watchdog.js`:孤兒清理。
5. `shared/storage`(設定預設值)、`ui/report/settings.js`＋`report.html`(一個下拉)、`shared/settings-io.js`(匯出入自動帶到,確認即可)。
6. CLAUDE.md「唯一入口」清單加一條;`tests/a4_conventions.test.js` 加守門:`src/background/` 內 `chrome.tabs.create`／`chrome.windows.create` 只准出現在 `fetch-tab.js` 與既有白名單(`main.js` 的 repick;`shared/panel.js` 不在 background)。

### 測試 / 驗收

- A1:入口單元測試——`window` 模式的呼叫序列(create 的參數**逐鍵斷言**,替身要驗參數:出現 `state` 與 `focused:false` 同時存在、`type:'popup'`、或對已建視窗呼叫 `tabs.create` 即紅);
  同佇列第二個任務走 `tabs.update({url})`;建視窗丟例外時退回 `tab` 且有診斷;`tab` 模式不呼叫 `windows.create`。
- A2:使用者開著同網址分頁時,排程**不對那個分頁送任何訊息或注入**(斷言 `sendMessage`／`executeScript` 的 tabId 集合不含它);
  網址帶不同 query 的同一頁只開一次(`sameOriginPath`);`TEST_TASK` 帶 `tabId` 仍用使用者分頁;前景抓取結束後還原分頁與視窗焦點、關掉自開分頁。
- A3:站台檢查不再直接呼叫 `tabs.create`;與同站台抓取不並行(用閘門卡住的假工作驗順序,不用壓力測試)。
- A4:孤兒清理——清單有 id 且無 inflight → 關;有 inflight → 不關;清單空 → 零呼叫;**反例**:不在清單裡的視窗絕不關。
- 突變:拿掉「不重用使用者分頁」的判定、把 `sameOriginPath` 換回整串比對、拿掉孤兒判定的 inflight 條件,各自要紅。
- 既有測試受影響面(含 `tabs.create`／`windows.*` 斷言):`d2_fetcher`(13 處)、`f5_foreground_pre`、`d9_sitecheck`、`p2_test_task`、`u4_test_diag`、`m2_chain`、`chrome-mock.js`;其餘命中檔是 side panel 與 repick,不應變動。**改測試要逐條說明是哪條定案推翻了它**。
- 煙霧:`tests/smoke/load.mjs` 加一案——真實瀏覽器跑一次排程抓取,斷言使用者視窗的分頁數前後不變、抓到值、專用視窗已關。

## 作業 B:前置動作

### 現況與核對結果

| 項目 | 結果 | 證據 |
|---|---|---|
| B-1 「拆成多任務」不帶前置動作 | 批次畫面把整個進階區(含前置動作區)藏起;共用設定清單 `SHARED_IDS` 不含它;逐項 `render` 會清空前置動作列 | `picker.js:3193`、`:32`、`:825-833`、`:3363`;BACKLOG:113 記為「刻意做薄」 |
| 批次畫面看不到 iframe 提示 | `#frame-hint` 在被藏起的進階區裡 | `picker.js:885-903` |
| B-2 同站台任務共用分頁、任務之間不還原狀態 | 第二個任務的 `click` 按在已被按過的頁面上;開關型按鈕會被收回去 | `fetcher.js:412` 命中上一個任務開的分頁,之後無 reload |

### 定案

1. **B-2:重用自己的分頁時,只要「上一個任務跑過任何前置動作」或「這個任務有前置動作」,先重新載入到 `task.url` 再開始**;
   兩者皆否且 `sameOriginPath` 相同 → 直接沿用(省一次載入)。網址不同 → 導覽(本來就是新文件)。
   不做「同網址同前置動作的任務合併成一次」(要動佇列與帳本)——進 BACKLOG,觸發條件:同頁任務多到載入時間成為問題。
2. **B-1:批次共用設定加入前置動作**,一份套到這次建立的全部任務(同一頁拆出來的任務,前置動作必然相同)。
   - 走既有的「逐項 `render` → 收集前貼回共用設定 → `saveTaskFromForm`」,不另開存檔路徑。
   - 前置動作裡自帶的 `frame` 照原樣複製到每個任務。
   - 批次畫面要看得到 iframe 提示(目標在 iframe 且沒有 `click` 前置動作時)。
   - 其餘逐任務進階設定(定位方式、正規表達式、告警)維持不做,BACKLOG:113 改寫成只剩那幾項。
3. 編輯單一任務的行為不變。

### 改動

1. `fetch-tab.js`／`fetcher.js`:入口記住「這個分頁上一個任務有沒有跑過前置動作」,依定案 1 決定沿用／重載／導覽。
2. `picker.js`＋`picker.html`:批次畫面顯示前置動作區與 iframe 提示;收集批次值時把前置動作貼回每一項。
3. `tests/m2_chain.test.js`:補「批次共用前置動作 → 每個存下來的任務 → fetcher 實際送出的 `PRE_ACTION`」鏈結斷言。

### 測試 / 驗收

- B1:同站台連續兩個任務——(有前置動作,有)、(有,無)、(無,有)三種都重載;(無,無)同網址不重載;用替身記錄 `tabs.reload`／`tabs.update` 的順序,**重載必須發生在第二個任務的第一則訊息之前**。
  突變:把條件改成只看「這個任務有前置動作」→(有,無)那案要紅。
- B2:批次建 3 個任務,每個任務的 `preActions` 與共用設定逐鍵相同(含 `frame`);共用設定沒填 → 每個任務都沒有 `preActions` 鍵(不寫空陣列,比照既有單任務行為,**實作前先核對單任務是寫空陣列還是不寫**);
  從編輯任務 A 切到批次時,A 的前置動作不得殘留(AF-19 `fillSchedule` 同型)。
- 教學頁與介面字串同步(`y5_help_page`)。

## 作業 C:文件與收尾

- SPEC §4(到點流程、前景 vs 背景、同站台共用)、§4.1 風險表(無視窗列改寫、加「工作階段還原」列)、§9(`windows` API 用途)、Edge 相容表(標明專用視窗未在 Edge 實測)。
- 探針事實表 P0~P9 摘進 SPEC §4(下次有人想「直接開最小化就好」時看得到 0×0)。
- CLAUDE.md:唯一入口、`windows.create` 三個禁用組合、「不重用使用者分頁」。
- BACKLOG:新增 P1 直接最小化、同頁任務合併;改寫 :113;`:24`「立即測試以新分頁執行」維持。
- 文案:`help.html:422`、`picker.js:902`、`:2749` 的「排程會開新分頁」改成不綁「分頁」的說法(例:「排程會自己另開一份頁面」)。
- 版本 0.19.0(`manifest.json`、`package.json`)。
- 探針腳本收進 `tests/smoke/`(不進 `npm test`)。

## 明確不做(本輪定案)

- offscreen／`fetch`＋DOMParser 背景抓取(定案 A-1)。
- 直接最小化視窗 P1(viewport 0×0)——BACKLOG。
- 同網址同前置動作的任務合併執行——BACKLOG。
- 批次的其餘逐任務進階設定。
- repick 開分頁的方式(使用者主動操作)。
- 全域「最多 N 個站台並行」佇列(BACKLOG:51 既有項,專用視窗不改變它的必要性)。

## 待使用者實測(無法由腳本判定)

1. 專用視窗建立瞬間的閃爍與工作列圖示是否可接受(A1 完成後即可測)。
2. Edge 上同一流程(Sleeping Tabs／效率模式對最小化視窗的影響)。

## 規劃完成後複檢

- 與既有設計的衝突:SPEC:746「已開著同 URL 的分頁優先直接擷取」、SPEC:716「無視窗建最小化視窗」、BACKLOG:113——**本輪明文推翻／改寫**,已列入作業 C。
  CLAUDE.md「不要假設抓取時目標分頁已開啟」不衝突(更徹底)。`suggestForeground` 機制不變。
- 批次之間:B1 的重用規則住在 A 的入口裡,順序 A→B 已定;A3 讓站台檢查進佇列後,站台檢查的分頁也適用 B1 規則(它沒有前置動作 → 只看上一個任務)。
- 四個坑:「什麼算孤兒／清單為空」已寫;破壞性動作(關視窗)的反例已寫;單向閘門無;移除類(`tabs.query({url})`、sitecheck 自開分頁、無視窗特例)的依賴方＝上列受影響測試,已列。
- 保護生效之前的路徑:專用視窗「建立後、最小化前」service worker 被回收 → 視窗以 normal 狀態留著;id 要在 **create 回來的當下**就登記進 session(早於最小化),孤兒清理才收得到——已併入 A1 契約。
- 複檢完成,新增上面最後一項,無其他事項。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| A1 抓取分頁入口 | agy(gemini-3.8-flash-high) | 通過 | z4 22→23 則、突變 11/11 被抓 | agy 回報停在「等 npm test」就結束(未跑完驗收),Claude 自跑;**最小化失敗會掉進退路再開一個分頁、已登記的視窗沒人關**——Claude 修(分開 try)並補測試,突變驗證 |
| A2 fetcher 接線＋B1 重載規則 | agy | 通過 | z5 16 則、突變 7/7 | 規劃原把 B1 放在作業 B,實作時與 A2 同一段程式碼,併成一段;佇列 `enqueueForOrigin` 搬進 fetch-tab.js(站台檢查要進同一條、測試要共用同一個模組實例);`p2` 一條舊斷言(`tabs.create`)被本輪推翻,Claude 改 |
| A3 站台檢查 | Claude | 通過 | z6 5 則、突變 2/2 | 改動十幾行,寫規格的成本高於自做;`d9` 兩條舊斷言(`tabs.create`/`tabs.remove`)被推翻,改成視窗 |
| A4 看門狗／設定頁／D15 | Claude | 通過 | z8 7 則、突變 3/3 | 同上,自做 |
| B2 批次共用前置動作 | agy | 通過 | z7 9 則、突變 8/8 | **規格自相矛盾**:要求改文案與露出進階區,又要求 `q3`/`y7` 全綠,而那三條舊斷言守的正是被推翻的行為——Claude 改測試;agy 把框架提示句與主機名解析複製一份到批次版,Claude 收成 `frameHintText` 一份 |
| C 文件／版本 | Claude | 完成 | — | SPEC §4／§4.1／§4.2／Picker 段／Edge 表、CLAUDE.md、BACKLOG 五條、0.19.0 |
| 煙霧 | Claude | Chrome 全過(新增 AF-20 案例:使用者開著同網址分頁、排程在專用視窗抓到 1234、使用者分頁沒被注入、視窗與分頁數回到原狀、登記表清空);AF-13 排程路徑案例改走專用視窗仍過 | — | Edge:puppeteer 啟動失敗(同 AF-18/19,環境問題) |

## 順手發現(未處理,待討論)

- `fetcher.js` 的 `setInflight`／`removeInflight` 在正式碼裡寫 `if (Array.isArray(chrome?.__calls)) chrome.__calls.push(...)`——這是測試替身的欄位,屬於 CLAUDE.md 禁止的「正式碼測試後門」,D14 守門沒擋到(它比對的是 `__test`、測試檔名、`Error().stack`)。正式環境沒有 `chrome.__calls`,所以不影響行為,但有測試在依賴它。
