# AF 第 6 輪規劃：iframe 內元素的選取與抓取

> 狀態：規劃中
> 基準：dev@9f89d90（1409 綠；Windows + Node 21 需本輪作業 0 的可攜性修正才跑得綠）
> 來源：使用者實測——目標值在跨網域 iframe 內時選不到也抓不到；並要求支援「先點指定按鈕（可能多層）再抓 iframe」的設定流程
> 委派模型：整輪 **agy**（跨 background / content / picker 三個執行環境，且要接訊息鏈；地端模型容易斷鏈）

## 作業總覽

| 作業 | 內容 | 規模 | 相依 | 執行者 |
|---|---|---|---|---|
| 0 | Windows / Node 21 測試可攜性（已完成，隨 r6 第一個 commit 進去） | 2 檔數行 | — | Claude |
| A | 選取端：allFrames 注入、右鍵帶 frameId、`PICKED` 帶 frame 身分、任務存 `frame`、立即測試對 frame | background/inject、main、content/main、picker、messages | — | agy |
| B | 抓取端：抓取／預檢／重選時重新定位 frame（三層）、所有 `tabs.sendMessage` 明確帶 frameId、慣例守門 | background/frames（新）、fetcher、main、login、a4 守門 | A | agy |
| C | 前置動作跨 frame：每個動作各自帶 `frame`、逐動作定位（含等 iframe 出現）、選取時選到 `<iframe>` 才下鑽 | content/main、fetcher、picker、picker-mode | A、B | agy |
| D | 文件與煙霧：SPEC §2/§3/§4/§9、BACKLOG、CLAUDE.md、含跨網域 iframe 的煙霧 fixture | docs、tests/smoke、run_smoke.sh | A~C | agy（fixture）／Claude（docs） |

建議順序 0 → A → B → C → D；A 完成後就能在真實瀏覽器選到 iframe 內元素，B 完成後排程才抓得到。

## 核對結果（共用）

抓不到 iframe 內容是三個斷點串在一起，缺一不可：

| # | 斷點 | 證據 |
|---|---|---|
| 1 | 注入只到最上層 frame | `background/inject.js:3` 的 `executeScript({target:{tabId}})` 沒有 `allFrames` / `frameIds` |
| 2 | 右鍵目標記在錯的 document | `content/main.js:187` 的 `contextmenu` 監聽只在 top；在 iframe 裡右鍵時事件在 iframe 自己的 document 觸發，top 的 `lastTarget` 永遠是 null。`contextMenus.onClicked` 的 `info.frameId` 沒有被使用（`main.js:545`） |
| 3 | 訊息沒路由到 frame、任務沒存 frame 身分 | 9 處 `chrome.tabs.sendMessage(tabId, msg)` 都不帶 `{frameId}`：若只補 allFrames 注入，訊息會廣播、**第一個回應的（top）說 not_found 就結案**。排程到點是開新分頁（SPEC §4），frameId 每次不同，任務必須存能重新找回 frame 的身分 |

其他事實：
- `host_permissions: <all_urls>` 已有，跨網域 iframe 注入**不需要新權限**；列 frame 也不用 `webNavigation`——
  `executeScript({target:{tabId, allFrames:true}, func})` 的回傳陣列每項都帶 `frameId`。
- `PICKED` 在 background 端（`main.js:345`）已拿得到 `sender.frameId` 與 `sender.url`（frame 自己的網址），只是沒放進 picker 的 ctx。
- 前置動作（`task.preActions[]`，型別 `wait` / `click` / `waitFor`）目前整批送一則 `RUN_PRE_ACTIONS` 給**一個** content script 依序執行（`content/main.js:105`）；
  選取要點的元素時 picker 送 `ENTER_PICK{purpose:'preaction', tabId}`，不帶 frame（`picker.js:1022`）。
- `tests/chrome-mock.js` 的 `tabs.sendMessage(tabId, msg)` 只收兩個參數、`scripting.executeScript` 只記錄呼叫；兩者都要能支援本輪的第三個參數與回傳值。
- 使用者實測的站：**跨網域 iframe、`src` 固定**。
- 專案已知（BACKLOG:47「iframe 內元素（需 allFrames 注入）」）但只寫到斷點 1。

## 定案（與使用者討論後）

1. 走 **allFrames 注入 + frameId 路由 + 任務存 frame 網址、抓取時重新定位**（方案 A）。
   不採「top 走 `iframe.contentDocument`」：只覆蓋同源且斷點 2 仍在；不採「任務網址直接填 iframe src」：站台常要 referer/session，只能當暫時解。
2. **frame 身分**：`frame: { url }`（frame 當時的 `location.href`）。目標在 top 時**不存此欄**（舊任務零遷移，語意等同 top）。
3. **重新定位規則**（`background/frames.js`，三層，第一個**唯一**命中為準）：
   ① 網址完全相同 → ② `origin + pathname` 相同（query 常帶 token / 時戳）→ ③ 逐個候選 frame 用 locator 去 resolve，**唯一**命中者。
   任何一層命中超過一個 → 進下一層；三層都失敗或第 ③ 層多重命中 → **判失敗**（取錯 frame 會靜默抓到錯的值，比抓不到更糟）。
   失敗紀錄 `status: 'not_found'`、`error: '找不到目標所在的框架'`——**不新增 status**，`shared/record-status.js` 不動。
4. **範圍**：前置動作可以跨 frame（作業 C）；自動登入（`CHECK_ELEMENT` / `FILL_LOGIN`）維持 top frame，「登入表單在 iframe 內」列 BACKLOG。
5. `about:blank` / `srcdoc` 的 iframe（內容由 JS 塞入）：`allFrames: true` 會涵蓋它們，但網址無辨識度只剩第 ③ 層——**盡力而為、不保證**，煙霧不涵蓋。
   （查核修正：`matchOriginAsFallback` **不是** `chrome.scripting.executeScript` 的合法屬性，它只用於 `registerContentScripts` 與 manifest 的 `content_scripts`；規劃初稿寫錯，已移除。）
6. 巢狀 iframe：allFrames 本來就含巢狀，網址比對不分層級，不另做。
7. **所有 `chrome.tabs.sendMessage` 一律明確帶 `{ frameId }`**（top 為 0）：多 frame 注入後不帶就是廣播，誰先回誰贏。a4 加守門。
8. 前置動作與目標的先後：**先執行全部前置動作，再定位目標 frame**（iframe 可能是點了按鈕才出現、或切頁籤後重建）。
   每個前置動作各自帶 `frame`（形狀同任務的 `frame`，缺省 = top），執行前逐動作定位；定位時 frame 還不存在要**等它出現**（輪詢，逾時暫定 20 秒，與 `waitFor` 預設一致）。
9. 前置動作「在頁面上選取」走**一般流程優先、選到 iframe 才下鑽**：先只在 top 進入選取模式（與現況相同）；
   當使用者確認的目標是 `<iframe>` 元素時，不送 `PICKED`，改請 background 找到那個 frame、注入並在**它裡面**進入選取模式，top 同時退出；
   找不到對應 frame（`src` 比對失敗或多重命中）時留在 top，面板顯示「無法進入此框架」。
   不採「全部 frame 同時進選取模式」（每個 frame 一份 overlay、要廣播退出，且對不含 iframe 的頁面是白費）；
   不採列上「在哪個框架」下拉（壞 UX）。同一機制**同時適用**於 `task` 的重選與 `af-pick`（右鍵在 top 但目標其實在 iframe 裡時）。
   只能往下鑽不能往上回（`Esc` 取消整次選取），寫進 SPEC。

## 作業 0：測試可攜性（Claude，已完成）

- `package.json` 的 `test` 加 `--no-experimental-global-navigator`（Node 21+ 內建唯讀 `navigator`，測試裡 `globalThis.navigator = …` 會炸）。
- `tests/a4_conventions.test.js`：`SRC` 改 `fileURLToPath`（Windows 上 `URL.pathname` 多前導斜線）、`rel()` 以 `path.sep` 正規化（豁免清單用 `/` 寫）。
- 驗收：Windows + Node 21.6 全量 1409 綠（已驗）。macOS 行為不變（旗標在 Node 20 不存在會不會拒絕？**待在 mac 驗**；不通過就改成 `NODE_OPTIONS` 條件加旗標）。

## 作業 A：選取端

### 現況與核對結果
見〈核對結果〉斷點 1、2、3 的前半（訊息帶 frame）。

### 改動（行為契約）
1. `background/inject.js`：`injectContent(tabId, opts)`——`opts.allFrames === true` → `target: { tabId, allFrames: true }`；
   否則 `target: { tabId, frameIds: [opts?.frameId ?? 0] }`（**預設只注入 top，且一定明寫 frameIds**，不得回到不指定 frame 的形式）。
   content script 既有的 `__afContentLoaded` 守衛每個 frame 各一份，重複注入無害。
2. 右鍵「選取要抓的內容」：注入並送 `ENTER_PICK` 到 **`info.frameId`** 那個 frame（`chrome.tabs.sendMessage(tabId, msg, { frameId })`）。
   「設定此站台登入」維持 top（定案 4）。
3. `PICKED{purpose:'task'}`：payload 增 `frameId: sender.frameId`、`frameUrl: sender.url`；**`frameId === 0` 時兩欄都不放**。
4. `ui/picker`：`buildTask` 在 ctx 有 `frameUrl` 時寫 `task.frame = { url }`；編輯既有任務保留原 `frame`；「立即測試」的 `EXTRACT` 帶 `{ frameId: ctx.frameId ?? 0 }`。
5. `ENTER_PICK` 帶 `tabId` 的那條路（picker 內的重選／前置動作選取）沿用 ctx 的 frameId（選到 `<iframe>` 元素時的下鑽在作業 C 加）。
6. `tests/chrome-mock.js`：`tabs.sendMessage(tabId, msg, options)` 記錄第三個參數；`scripting.executeScript` 可由測試預設回傳值（`allFrames` 列 frame 用）。

### 測試／驗收（Claude 先寫，agy 實作）
- 鏈結測試（補進 `m2_chain`）：模擬在 `frameId: 7` 右鍵 → `onClicked` 收到 `info.frameId = 7` → `tabs.sendMessage` 第三參數 `{frameId: 7}`；
  content 送 `PICKED`（sender `{frameId: 7, url: 'https://b.example/w.html?x=1'}`）→ `windows.create` 的 ctx 內含 `frameId: 7, frameUrl`。
  突變：把 `info.frameId` 拿掉 → 紅。
- top 右鍵（`sender.frameId = 0`）→ ctx **沒有** `frameId` / `frameUrl` 鍵；`buildTask` 結果沒有 `frame` 鍵（反例：不能存 `frame: {url: topUrl}`）。
- `buildTask` 有 `frameUrl` → `task.frame.url` 等於它；編輯既有任務（ctx.task 有 frame、ctx 沒 frameUrl）→ `frame` 原樣保留。
- 「立即測試」的 `EXTRACT` 呼叫第三參數 `{frameId}`。
- 既有 1409 全綠。

## 作業 B：抓取端

### 現況與核對結果
`fetcher.js:367-386`：注入 → 前置動作 → `SCROLL_INTO_VIEW` → `EXTRACT`，三則訊息都不帶 frameId；預檢與正式抓取共用這段（SPEC §4.2）；
重選走 `main.js:ENTER_PICK` 開新分頁後送訊息，同樣要定位。`login.js` 三處訊息維持 top。

### 改動（行為契約）
1. 新增 `background/frames.js`：
   - `listFrames(tabId)` → `[{frameId, url}]`（`executeScript allFrames` 跑一個回傳 `location.href` 的小函式；**不是**注入 content script）。
   - 純函式 `matchFrameByUrl(frames, frameUrl)` → 第 ①② 層：回 `{frameId}` 或 `{ambiguous: [...]}` 或 `null`；無 DOM、無 `chrome.`。
   - `locateFrame(tabId, frame, locator, { timeoutMs, pollMs })`：無 `frame` → `{frameId: 0}`；有 → 輪詢 `listFrames` 直到 ①② 命中或逾時；
     ①② 多重命中或全 miss 時對候選（多重命中的那幾個，或全部非 top frame）注入並送 `RESOLVE_LOCATOR`，唯一 `found` 者勝；否則回 `null`。
   - 第 ③ 層要新的訊息 `MSG.RESOLVE_LOCATOR{locator}` → `{ok, found}`（content 端用 `resolve` 判定，不擷取）。
2. `fetcher.runTask`：前置動作之後（作業 C 前，暫時仍是原本那一則 `RUN_PRE_ACTIONS`，送 top）呼叫 `locateFrame`；
   `null` → 依定案 3 寫 `not_found` 紀錄（走既有 not_found 的重試與通知路徑，dryRun 時回 `{ok:false, error:'frame_not_found'}`）；
   命中 → 注入該 frame、`SCROLL_INTO_VIEW` 與 `EXTRACT` 都帶 `{frameId}`。
3. `main.js` 的重選（`ENTER_PICK` 無 `tabId` 那條）：開新分頁後 `locateFrame`，命中才注入並送 `ENTER_PICK` 到該 frame；失敗回 `{ok:false, error:'frame_not_found'}`。
4. `login.js`、`main.js` 其餘 `tabs.sendMessage` 全部明確帶 `{frameId: 0}`。
5. `a4_conventions` 新守門：`src/` 內每個 `tabs.sendMessage(` 呼叫都必須帶第三個參數（文字掃描：括號內至少兩個逗號分隔的頂層引數）。

### 測試／驗收
- `matchFrameByUrl` 純函式：完全相同優先；只 query 不同 → ② 命中；兩個 frame 同 `origin+pathname` → `ambiguous`；都不同 → `null`；`frames` 為空 → `null`。
- `locateFrame`：第一次 `listFrames` 沒有目標、第二次有 → 命中（證明有輪詢）；逾時 → `null`；
  `ambiguous` 兩個候選、`RESOLVE_LOCATOR` 只有一個 `found` → 取它；兩個都 `found` → `null`（**反例：不得取第一個**）；突變：把「唯一」改成「第一個」→ 紅。
- `runTask`：任務有 `frame` 且定位到 `frameId: 7` → `EXTRACT` 第三參數 `{frameId: 7}`；定位失敗 → 紀錄 `status: 'not_found'`、`error` 含「框架」，且**沒有**送 `EXTRACT`；
  任務無 `frame` → 不呼叫 `listFrames`（舊任務路徑零額外開銷），`EXTRACT` 帶 `{frameId: 0}`。
- 重選：定位失敗不送 `ENTER_PICK`。
- a4 守門突變：把任一處第三參數拿掉 → 紅。
- 既有測試全綠；`RESOLVE_LOCATOR` 進 `messages.js`（`DESCEND_FRAME` 於作業 C 加入）。

## 作業 C：前置動作跨 frame

### 現況與核對結果
見〈核對結果〉第 4 點。`handlePreActions` 是一整批在同一 frame 跑；`waitFor` 用 `MutationObserver` 等元素，但 **frame 本身還不存在時 observer 掛在錯的 document**。

### 改動（行為契約）
1. 資料：`preActions[i].frame = { url }`（缺省 = top）；`buildTask` 的驗證保留這個欄位；`wait` 型別不帶 frame。
2. 執行：`fetcher` 把 `preActions` **逐一**執行——每個動作先 `locateFrame(tabId, action.frame, action.locator, {timeoutMs})`
   （`click` 的逾時暫定 20 秒，`waitFor` 用它自己的 `timeoutMs`），命中後注入該 frame、送只含**這一個**動作的 `RUN_PRE_ACTIONS` 帶 `{frameId}`；
   定位逾時 → 與既有「前置動作失敗」同一條錯誤路徑（錯誤文字含動作序號與「找不到框架」）。`wait` 不定位、不送訊息，background 自己等。
   content 端的 `handlePreActions` 介面不變（仍收陣列），只是每次收到一個。
3. 選取（定案 9）：
   - `content/picker-mode.js`：目標為 `<iframe>` 時面板顯示「框架：<主機名>，確認即進入框架選取」；確認時送新訊息 `MSG.DESCEND_FRAME{purpose, taskId, src: iframe.src, preselect?}` 給 background，並退出 top 的選取模式。
     `Enter`／點擊／右鍵選單「選取此元素」三種確認路徑都要走這條。
   - background：以 `iframe.src` 對 `listFrames` 做第 ①② 層比對（**不做第 ③ 層**，選取時沒有 locator）；唯一命中 → 注入該 frame、送 `ENTER_PICK`（沿用原 `purpose`/`taskId`/`preselect`）；
     失敗 → 對原 frame 送 `ENTER_PICK` 重新進入並附 `hint: 'frame_not_found'`，面板顯示「無法進入此框架」。
   - `PICKED{purpose:'preaction'}` 轉發給 picker 時補 `frameId`/`frameUrl`（`sender` 取；top 時不帶），與作業 A 的 `task` 路徑同一份組裝邏輯。
   - 這條下鑽機制放在 `main.js` 的 `ENTER_PICK` 處理裡，`af-pick`、重選、前置動作三個入口共用。
4. picker：列的 `_frame` 隨 `PICKED` 存入；`getFormData` 帶出；定位文字旁顯示 frame 主機名（有 frame 時），不顯示完整網址。

### 測試／驗收
- 鏈結（`m2_chain` 補）：picker 送 `ENTER_PICK{purpose:'preaction'}` → background 只對 `{frameId: 0}` 送一則（**反例：不得對其他 frame 送**）→
  top 送 `DESCEND_FRAME{src:'https://b.example/w.html?x=1'}` → `listFrames` 回三個 frame，`origin+pathname` 唯一命中 frame 7 → 注入 `{frameId: 7}` 並送 `ENTER_PICK`（`purpose` 原樣）→
  frame 7 送 `PICKED`（sender frameId 7）→ picker 收到的訊息含 `frameUrl`；儲存後 `preActions[0].frame.url` 等於它。
  `listFrames` 兩個 frame 同 `origin+pathname` → 不送第二則 `ENTER_PICK` 到任何非 top frame，改對 top 送 `ENTER_PICK{hint:'frame_not_found'}`。
  突變：把「唯一命中」改成「第一個」→ 紅。
- picker-mode（jsdom）：目標是 `<iframe>` 時 `Enter` 送出的是 `DESCEND_FRAME` 而非 `PICKED`，且 `src` 等於該元素的 `src`；目標不是 iframe 時行為不變。收到 `hint` 時面板文字含「無法進入此框架」。
- `runTask`：`[click@top, waitFor@frameB, click@frameB]` → 三則 `RUN_PRE_ACTIONS`，`frameId` 依序 `0, 7, 7`，每則 `actions.length === 1`；
  第二個動作的 frame 第一次 `listFrames` 不存在、第二次出現 → 仍成功（證明「先點才出現」的 iframe 可用）；
  逾時 → 紀錄走前置動作失敗路徑、**不**執行第三個動作、**不**送 `EXTRACT`。
  突變：把「逐一」改回整批 → 紅（frameId 序列斷言）。
- `wait` 型別：不呼叫 `listFrames`、不送訊息。
- 舊任務（`preActions` 沒有 `frame`）：全部 `frameId: 0`，行為與本輪前一致。

## 作業 D：文件與煙霧

1. SPEC：§2 右鍵與選取模式補「在哪個 frame 右鍵就在哪個 frame 進入選取模式；選到 `<iframe>` 元素即下鑽進去、只能往下不能往上」；§3 補 `frame` 欄與三層定位規則（引用 `background/frames.js`）；
   §4 補「前置動作逐一定位、先前置再定位目標」與失敗語意；§9 補「不需 `webNavigation`，列 frame 用 `executeScript allFrames`」。
   §0 架構圖 content script 加一行「每個 frame 各一份」。
2. BACKLOG：移除「iframe 內元素」；新增「登入表單在 iframe 內」「`about:blank`/`srcdoc` iframe 的煙霧驗證」。
3. CLAUDE.md：慣例加「`tabs.sendMessage` 一律帶 frameId」「frame 定位只有 `background/frames.js` 一份」；基線數字更新。
4. 煙霧 fixture：兩個本機 port 各服務一頁（A 頁含 `<iframe src="http://localhost:<B>/inner.html">`，B 頁有一個帶數值的元素與一個要先點才顯示數值的按鈕），
   跑「右鍵選取 → 立即測試 → 排程抓取」；`run_smoke.sh` 補 Windows 的 CFT 路徑（`chrome-win64/chrome.exe`）。**暫定**，`tests/smoke/load.mjs` 的既有結構讀過再定形狀。

## 明確不做（本輪定案）

- 登入表單在 iframe 內（列 BACKLOG）。
- 自動偵測「目標其實在 iframe 內」並提示使用者：本輪做完就直接選得到，提示沒有必要。
- 以 `webNavigation.getAllFrames` 取 `parentFrameId` 做層級比對：目前不需要新權限就夠用。
- 「任務網址直接填 iframe src」的引導 UI。

## 規劃完成後複檢

- 與既有設計衝突：SPEC §4「若使用者已開著同 URL 的分頁，優先直接在該分頁擷取」——該分頁的 frame 樹可能與新開分頁不同（使用者自己點過頁籤），
  定位規則對兩者一視同仁，且先跑前置動作再定位，行為一致。
  SPEC §2「`repick` 一律選一個就送出」不變；重選在 frame 內進行，`↑` 到該 frame 的 `body` 停住（選不到父 document，可接受，寫進 SPEC）。
  SPEC §2「點擊會被攔截」：目標是 `<iframe>` 時，top 的 overlay 蓋在 iframe 上，滑鼠事件落在 top，能選到 `<iframe>` 元素本身——這是下鑽機制成立的前提，picker-mode 的 overlay 已是 `pointer-events` 攔截，待作業 C 驗收時在真實瀏覽器確認。
- 批次間：A 產出 `frameId`/`frameUrl`、B 消費 `task.frame`、C 消費 `preActions[].frame`，欄位名在三段都用 `frame: {url}` 一種形狀；
  B 暫時仍送整批 `RUN_PRE_ACTIONS` 到 top，C 再改逐一——B 的 `runTask` 測試不得斷言前置動作的送法，避免 C 改動時要重寫。
- 四個坑：「什麼算一個命中」= `resolve` 回非 error（唯一命中在 `resolve` 內已保證）；候選為零 → `null`；
  破壞性判準：無（不洗欄位、不刪資料）；單向閘門：無；移除類：無（`injectContent` 簽章擴充但預設行為不變，既有呼叫端零改動）。
- 升級路徑：舊任務無 `frame` → top，零遷移；舊 `preActions` 無 `frame` → top。
- 複檢新增一項：作業 0 的旗標在舊 Node（mac）是否被拒絕，列為作業 0 的待驗項。

## 執行紀錄

| 作業-階段 | 執行者 | 結果 | 驗收 | 落差與處置 |
|---|---|---|---|---|
| 0 | Claude | 1409 綠（Windows/Node 21.6） | ✅ | mac 舊 Node 待驗 |
