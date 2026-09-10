> 除非必要否則不要讀取 docs/archive/ 內容,避免浪費 token。

# AutoFetcher 規格

> 本文是**現況規格**——全部段落都已實作。
> 刻意沒做的東西一律在 `BACKLOG.md`,附觸發條件。

## §0 架構總覽

```
┌──────────────── 目標網頁(任意站台)────────────────┐
│ content script(注入,**每個 frame 各一份**)         │
│  • 記住最後右鍵的元素                               │
│  • 產生 / 解析四層選擇器(§3)                        │
│  • 擷取:文字 / 數值策略鏈(§11)/ 表格聚合(§7)       │
│  • 自動登入、前置動作(§6)                           │
└──────────────▲───────────────┬─────────────────────┘
   訊息(DESCRIBE / EXTRACT …) │
┌──────────────┴───────────────▼─────────────────────┐
│ background service worker(MV3,事件驅動、隨時會被殺)│
│  • contextMenus:右鍵選單入口(§2)                    │
│  • scheduler:chrome.alarms 建立/重建(§4)            │
│  • fetcher:到點開分頁 → 登入 → 擷取 → 寫紀錄 → 關閉 │
│  • missed:啟動時算錯過清單、發通知(§4)              │
│  • alerts:閾值判定、通知(§10)                       │
└──────────────┬────────────────────────────────────┘
               │ 唯一寫入口 shared/storage(§5)
┌──────────────▼────────────────────────────────────┐
│ chrome.storage.local(主資料)                       │
│  tasks / sites / records(依日期)/ layout / settings │
└──────┬───────────────────────────────┬────────────┘
       │                               │
┌──────▼──────────┐          ┌─────────▼─────────────────────┐
│ ui/picker       │          │ ui/report(AutoFetcher-Report) │
│ 右鍵後的設定視窗 │          │  儀表板(自訂版面)/ 每日檢視     │
│ 命名、排程、策略 │          │  設定頁:匯出 JSON/CSV/HTML、   │
│ 預覽、加入儀表板 │          │  設定匯入匯出、站台登入、偏好   │
└─────────────────┘          └───────────────────────────────┘
```

- **frame 是第四個維度**:同一個分頁可能有多個 frame(iframe),content script 每個 frame 各一份。
  background 送訊息**一律指名 `{ frameId }`**——不指名就是廣播,最上層會搶先回「找不到」而結案(§3)。
- **三個執行環境**:content script 只碰 DOM;background 只做排程與流程;UI 頁只讀寫 storage 與發訊息。
  彼此以 `chrome.runtime.sendMessage` 溝通,訊息型別集中在 `shared/messages.js`。
- **資料流**:右鍵 → content 描述元素 → picker 存任務 → scheduler 建 alarm → 到點 fetcher 開分頁擷取 → storage →
  report 讀取呈現;檔案匯出一律由使用者在 report 設定頁手動觸發。
- **無框架、無 bundler**:原生 ES module;三個環境各自一個入口檔。

## §1 名詞

| 名詞 | 定義 |
|---|---|
| 任務(Task) | 一個「目標頁 URL + 選擇器 + 抓取模式 + 一組時間」的設定單位,使用者命名 |
| 抓取模式 | `text`(單一元素文字)、`number`(文字解析成數值)、`block`(表格:儲存格 / 欄列聚合 / 一次多個值,§7) |
| 值(Field) | 多值任務裡的一個值(`task.fields[]`),有自己的名稱與 `key`;單值任務沒有這一層 |
| 序列(Series) | 報表看到的一條資料線。單值任務就是任務本身,多值任務是「任務 · 值」;id 見 §7 |
| 紀錄(Record) | 一次抓取結果:`{taskId, slot, capturedAt, value, raw, status, strategyUsed, layer, error?, partial?, used?, skipped?, alert?, alertHits?, snippet?}`。**`taskId` 對多值任務是序列 id**(§7) |
| 站台設定(Site) | 以 origin 為 key 的登入設定:帳號、密碼、登入頁 URL、欄位選擇器、成功判定 |

## §2 右鍵選單與頁面內選取模式

- `contextMenus` 建立父項「AutoFetcher」,子項三個:
  「選取要抓的內容」「設定此站台登入」「開啟 AutoFetcher 報表」。
  (沒有獨立的「抓取此區塊」——區塊由選取模式自動判定。)
- 按下前兩項**不會直接開設定視窗**,而是讓目標頁進入**選取模式**(`content/picker-mode.js`):
  - Chrome 沒有 `getTargetElement`;content script 監聽 `contextmenu` 記住最後右鍵的元素,
    進入選取模式時**它就是預選**,立刻高亮。
  - 滑鼠移動改選;`↑` 擴大到父層、`↓` 沿原路縮回(到 `body` 停住);`Esc` 取消。
  - **滑鼠語意照一般電腦操作習慣**(試算表與檔案總管),`task` 與 `repick` 適用:

    | 操作 | 表格 | 非表格 |
    |---|---|---|
    | 點一下 | 選這一個,**取代**目前已選(不送出) | 鎖定這個元素(高亮不再跟著滑鼠) |
    | 再點同一個 | 維持已選(**不移除**) | 維持 |
    | `Ctrl`/`⌘` + 點 | 加選/取消這一個 | 不適用 |
    | `Shift` + 點 | 從**最後一個已選格**到這格的矩形範圍加選;沒有已選時同「點一下」 | 不適用 |
    | 拖曳 | 矩形框選,**累加** | 無 |
    | 雙擊 | 選這一個並**送出** | 送出 |
    | 點表頭列的格 | 選**整欄**(`block.axis: 'col'`) | 無 |
    | 已選一格後點工具列「整欄／整列」 | 把**最後一項**那一格**取代**成該欄／該列 | 無 |
    | 點資料列的 `th`(列標題) | 選**整列**(`block.axis: 'row'`) | 無 |
    | 點別處 | — | 解除鎖定 |

    點擊與雙擊都會被攔截,不傳給頁面。**送出的三個出口**:雙擊、`Enter`、面板的「完成」鈕。
    **`Enter` 的快速路徑**:已選清單是空的且滑鼠停在某一格時,`Enter` = 選那一格並送出
    (鍵盤使用者不必先點一下)。
    **拖曳框選放開後 200 毫秒內的 `dblclick` 要吃掉**——瀏覽器在拖曳結束補的 `click`
    會跟下一下湊成雙擊,那不是使用者要送出。
    **帶 `preselect` 進來且已選 ≥2 時,「點一下取代」要先提示、再點同一個才真的取代**
    (編輯既有多值任務時一個誤點會清光整批)。
    `preaction` 與 `login-*` 一次只選一個,**維持點一下就送出**;iframe 代理層點一下即鑽入
    (那是導覽不是選取)。
  - `Ctrl`/`⌘` + `A` 全選這張表的資料格(列標題那一格不算,受 `maxPicks` 截斷並提示);
    `Ctrl`/`⌘` + `Z` 等同「移除最後一項」(與 `Backspace` 同一條:清單空的時候不攔)。
  - **一次挑多個值**(`task` 與 `repick` 支援;`repick` 會帶既有的值回來勾,所以也要能多選):
    上述 `Ctrl`/`Shift`/拖曳,加上
    `Shift` + 方向鍵以目前的格為起點四方向自由加選(不限軸)。上限 `maxPicks`(預設 20)。
    **切換模式不清空已選**(已選清單本來就可以混放儲存格與欄列聚合,見 §7 的 `spec.fields`)。
    **已經選了值就鎖在那張表**(AF-10,推翻 AF-8 的「滑鼠移到另一張表格時才清空」):
    滑鼠移到非表格區域、或這張表的巢狀內外層,目標都不變——
    以前一移出表格,工具列三段立刻反灰、hover 標示被清掉,
    使用者根本走不到右上角去改「單格／整欄／整列」(P4 回饋的根因)。
    **換表要「點」不要「移」**:滑鼠移到另一張表只是把目標指過去(讓使用者看得到可以改點這張),
    **點下那張表的格子才換表**,而且是取代並存復原快照;`Ctrl` 點另一張表的格子**不加選**
    (兩張表的索引配不到同一個 locator),面板說明「一個任務只能抓同一張表格裡的值」。
    **鍵盤 `↑`／`↓` 不受鎖表限制**——那是明確意圖,不是滑鼠路過。
    已選的格子帶 `data-af-picked`。
    **選取狀態只存索引與表頭字串,不存元素參照**——即時報價的表格會整個重畫,
    存參照會讓標記留在被丟掉的節點上;每次滑鼠移動重貼一次標記。
  - **右鍵選單**(攔截頁面原生選單):表格內是
    「選這一格 / 這一欄:每格各一個值 / 這一欄:整欄聚合成一個值 /
    這一列:每格各一個值 / 這一列:整列聚合成一個值 / 完成 / 取消」——
    「每格各一個值」與「聚合成一個值」是兩件事(各幣別的買入 vs 全部幣別買入的加總),
    非表格是「選取此元素 / 取消」;項目帶 `data-af-menu-item`,容器帶 `data-af-menu`,同時只存在一個。
    **值的預設單位是儲存格**(匯率表的「美金買入」是那一格,不是整欄加總);選整欄/整列才是聚合。
  - **滑鼠停在儲存格上就進入該表格的表格模式**(`upgradeTarget`,唯一一份):目標升為那一格
    所屬的**最內層**表格,工具列三段隨即可用、`nameHint` 也算得出來。
    只對 `task` 與 `repick` 升級——前置動作與登入要點的是那個元素本身,不是它所在的表格。
    `↑` 的父層同樣過這條規則,所以從內層表按一次就回到外層表(不會停在 `td`),`↓` 沿原路回來。
    **巢狀表格預設取內層**(不是外層目標表格的那一格):外層那一格的文字是
    內層小表整串接起來的(`25530`+`39806` → `2553039806`),解析出來的數字只是碰巧排在最前面的那個;
    要改抓外層那一格按 `↑`。**已經選了值之後就鎖在那張表**(巢狀小表的索引配外層表的定位會送出錯的規格)。
  - 拖曳放開後瀏覽器補的那個 `click` 要吃掉,否則會被當成「單擊確認」直接送出。
    選取期間 `body` 的文字選取停用,離開時還原。
  - **`preview` 是所選那一個值的文字,不是容器的文字**:單格取那一格;整欄/整列改為
    `「表頭」整欄 N 格` 的描述且**不帶 `previewValue`**;多值取第一個值再加「(共 N 個值)」;
    非表格維持元素自己的文字。取整張表的文字會解析出毫不相干的數字。
  - `PICKED` 新增 `picks`(已選清單,順序 = 選取順序;單選時長度 1),
    既有欄位(`locator`、`blockInfo`、`preview`、`nameHint`…)一個都不變。
    `preaction` / `login-*` 一律選一個就送出(`repick` 與 `task` 同一套,見上面的滑鼠語意表)。
  - `ENTER_PICK` 可帶 `preselect`(形狀同 `picks`):**以表頭為準**勾回去,
    位置與帶進來的索引不同時在面板提示「位置已變」;表頭找不到就略過那一項。
  - 右下角面板即時顯示:元素描述、文字預覽前 80 字、偵測到的型別
    (數值 / 文字 / 表格 N 列 × M 欄 / 清單 N 項),判定來自 `shared/block-detect.js`。
  - **取代都留一步反悔**:「點一下取代」與「單格升級成整欄／整列」都會存下被換掉的清單,
    面板出現「復原」鈕(`data-af-undo`,沒有可復原的取代時 `hidden`),
    `Ctrl`/`⌘`+`Z` **先還原取代**,沒有可還原的才退回「移除最後一項」;
    加選、移除、離開選取模式都讓快照失效(留著會在幾步之後莫名其妙跳回舊的一批)。
    **換表反而要存快照**(AF-10,推翻 AF-9 的「換表讓快照失效」):
    hover 不再有破壞性副作用之後,唯一的破壞性動作就是「點另一張表的格子」,它最需要反悔。
    快照因此連同**這批索引屬於哪一張表**一起存,還原時 `pickedTableEl` 與目標一起回去——
    只還原清單的話就是「舊表的索引配上新表的定位」,與 AF-7 體檢抓到的 `pickedTableEl` 同型。
    **清單原本是空的時候點格不算取代**,不存快照、不長出「復原」鈕。
  - **面板永遠以一句「現在該做什麼」收尾**(`instructionLine`,唯一一份,固定在文字區最後一行、
    緊鄰動作列),隨狀態換:
    目標為空 → 「把滑鼠移到要抓的內容上;還沒出現的話按 `Esc`,先操作頁面讓它載入,再在它上面按右鍵」
    (這是「iframe 要先點頁籤才載入」的出路);表格未選 → 「點你要的那一格;點表頭可選整欄」;
    已選 N → 「已選 N 個值,再點可換、`Ctrl`/`⌘` 點可加,好了按完成」;
    `preaction` / `login-*` → 「點一下要操作的那個元素就完成」。**不做教學浮層,這一句就是全部的教學。**
  - **面板的動作列建一次,之後只更新文字與狀態**——每次 hover 重建會把使用者正要按的那一顆換掉
    (「完成鈕點了沒反應」的根因)。面板的文字內容在 `data-af-panel-body`,動作列是它的兄弟節點。
  - **面板會閃避游標**:游標進入面板外圍 24px 內就換到另一角(右下 ⇄ 左下),
    **換過之後要等游標離開那個範圍才會再換**(沿著面板邊緣移動時每次 `mousemove` 都翻會變成抖動);
    **滑鼠正在面板上、或面板裡有焦點時不動**(移動會讓按到一半的按鈕從指尖跑掉)。
  - **選取單位由畫面右上角的工具列決定**(`pickMode`,overlay 內、`pointer-events: auto`):
    三段「單格 / 整欄 / 整列」,屬性 `data-af-tool="cell|col|row"`,目前那一段帶 `data-af-active`,
    **預設是單格**。`Tab` 在三段之間循環(停用的跳過)。
    對外的 `currentAxis()` 維持相容:非表格回 `null`、`row` 回 `'row'`、`cell` 與 `col` 都回 `'col'`。
    **停用規則**:**已經選了值時以 `pickedTableEl` 判定**(那永遠是表格,所以三段一直可用,
    滑鼠在頁面上任何地方都走得到工具列);
    **`upgradeLastPickTo`(把最後一格升級成整欄／整列)也用同一個判定來源**,
    不然會出現「按鈕亮著、按下去卻沒反應」;還沒選任何值時才看 hover 目標——
    目標不是表格時三段全停用,面板一併顯示「非表格:抓整個元素」說明為什麼點不動;
    `preaction` 與 `login-*`(一次只選一個)時 `col` 與 `row` 停用——`repick` 不在此列,
    停用者帶 `aria-disabled="true"` 且點了不改模式,但**不得靜默無事**,而且
    **點任何一段都先解除鎖定**(`lockedEl`);理由要說對:目標不是表格就說「先把滑鼠移到表格上」
    (不是「這個用途一次只選一個」——那會跟面板上一行的「非表格:抓整個元素」自相矛盾):
    `task`/`repick` 點到停用的 `col`/`row` 時**記住這個意圖**(`pendingMode`)、**解除鎖定**,
    面板提示「先把滑鼠移到表格上,會自動切成整欄」,目標升級成表格時自動兌現;
    其他用途只提示「這個用途一次只選一個元素」。
    沒有這一條的話,從最上層進選取模式(目標還不是表格)時點整欄完全沒有反應,
    而先點過非表格元素造成的鎖定會讓後續滑鼠移動全部失效——使用者看到的是「工具列壞了」。
    這幾種用途**一次只選一個元素**,選到就送出,所以 chip 清單實際上不會累積。
    **`pendingMode` 兌現時要一併做 `upgradeLastPickTo`**(與直接點工具列的路徑同結果),
    點「單格」那一段則是**取消**先前記住的意圖(改變主意了,不能滑鼠一移到表格又自動切成整欄)。
    **模式是整欄／整列時,非表格元素不得鎖定、不得送出**:送出去的會是「整個元素」,
    使用者卻以為選的是一整欄,而工具列還亮著整欄——說出
    「整欄只能在表格上選…要抓這個元素請切回單格」,不要照做。
  - 滑鼠移到某一格時,**標示範圍跟著模式走**:單格只標那一格、整欄標整欄、整列標整列
    (待選標記 `data-af-cell`);點擊即選定,此時 locator 仍指向表格容器本身,欄列資訊另外帶回。
  - **`Ctrl`/`⌘` 點一個已經選過的格/欄/列 = 移除它,而且不送出**(判定走 `samePick`,加減一律走 `addPick`/`togglePick`);
    不按修飾鍵直接點已選的那一個是**維持**,不是移除。
    **點在表格內但不是任何一格**(格子之間的縫、表格的邊)什麼都不做——送出會存下使用者沒選的東西,
    鎖定會讓 hover 標示凍在原地。
  - **指標形狀就是可用性的說明**:表格資料格 `cell`、表頭 `pointer` 並帶 `title`(選整欄／選整列)、
    非表格 `crosshair`;`body` 的 `cursor` 與我們加的 `title` 都在 `exitPickMode` 還原。
    overlay 的按鈕拿不到樣式表,焦點環自己畫(`focus`/`blur` 切 `outline`)。
    **`mousedown` 對 overlay 自己的按鈕不得 `preventDefault`**——擋掉的話按鈕永遠拿不到焦點,
    焦點環就是一條沒有人到得了的死規則;頁面上的 `mousedown` 仍要擋(點到連結會讓頁面跑掉)。
    **焦點停在面板按鈕上時 `Enter` 交給那顆按鈕**,不當成「送出」(焦點在「取消」上卻送出是最容易踩的陷阱)。
    標示切換 100ms 過渡;`prefers-reduced-motion: reduce` 時所有過渡一律不加。
  - **面板底部固定「完成」與「取消」兩個鈕**(`data-af-done` / `data-af-cancel`):
    完成鈕帶已選數量「完成(3 個值)」;沒有已選且目標是表格時停用(`aria-disabled`,沒有東西可完成),
    非表格時是「完成(這個元素)」,iframe 代理層時是「進入這個框架」。
    面板的一行提示**跟著狀態換**:沒選時教怎麼開始(點一格/`Ctrl` 加選/`Shift` 拉範圍/點表頭選整欄),
    選了之後教怎麼送出(雙擊或 `Enter`/`Ctrl` 點取消/`Backspace` 移除最後一項)。
  - **面板是可互動的已選清單**:每個值一個 chip(`data-af-chip` 帶序號,內含 `data-af-chip-remove` 的 ×),
    另有 `data-af-remove-last`「移除最後一項」,`Backspace` 等同它——
    **清單是空的時候不攔這個按鍵**(選取模式可能開在有輸入框的頁面上)。
    **已達上限時點格子不送出**,停在原地提示,不能把使用者剛點的那一格靜靜丟掉。
    面板與工具列都是 `pointer-events: auto`,**它們上面的點擊不得落到 `confirmPick`**。
    清單空的時候面板顯示原本的說明文字。
  - **一個任務只抓一個元素,但那個元素裡可以挑多個值**(§7):
    同一張匯率表要抓美金買入與賣出,是一個任務兩個值;
    同一頁要抓四張**不同的表格**,才是四個任務(各自命名)。
- **目標在 iframe 內時(§3 的 `frame`)**:
  - 在 iframe 裡右鍵 → `contextMenus.onClicked` 的 `info.frameId` 就是那個 frame,
    直接在**該 frame** 進入選取模式(這是最常走、也最省事的一條)。
  - 在最上層右鍵、目標卻在 iframe 裡 → 選取模式在 iframe 上蓋一層**代理層**
    (`data-af-frame-proxy`,`pointer-events: auto`)。**沒有這一層就 hover 不到 `<iframe>`**:
    滑鼠移到 iframe 上時事件由 iframe 自己的文件接走,最上層的 overlay 又是 `pointer-events: none`。
    指到代理層時面板顯示「框架 iframe / 主機名 / 確認即進入這個框架選取」。
  - **代理層不得擋住頁面自己疊在 iframe 上的東西**(下拉選單、彈窗;AF-11)。
    指標被代理層攔走的話,站台收到 `mouseout` 就把選單收起來,使用者永遠點不到選單項目。
    三件事:
    1. **代理層貼在 `<body>` 底下,不放進 overlay**——overlay 的 `z-index` 是 2147483647
       且自成堆疊脈絡,放進去的東西一定蓋過所有頁面內容。
    2. **`z-index` 跟著 iframe 在 body 層級的堆疊祖先走**:取 iframe 往上到 `<body>` 這條鏈上
       **最外層**那個有數字 `z-index` 的祖先(或 iframe 自己)的值,整條鏈都沒有取 `0`,負值取 `0`。
       只看 iframe 自己會拿到 `0`,而 iframe 常包在 `.content { position: relative; z-index: 2 }` 這種容器裡,
       整個容器就蓋在代理層上面、iframe 反而選不到。與容器同層、又排在 DOM 後面,就蓋得住 iframe;
       頁面把選單疊上來時一定給了更高的 `z-index`,那就由選單勝出。這是主要機制。
       **已知上限**:選單與 iframe 同在一個有 `z-index` 的容器裡時,代理層在 body 層級贏過整個容器,
       只剩第 3 條的讓路(見 BACKLOG)。
    3. **只靠 DOM 順序疊上來(沒有 `z-index`)時讓路**:指標落在代理層上的那次 `mousemove`,
       暫時關掉代理層問一次 `document.elementFromPoint`,底下是頁面元素就把 `pointer-events` 收成 `none`
       並改以它為目標;指標離開它(`mousemove` 到別處,或它自己的 `mouseout`)再裝回去。
       這是最後防線,救得回**有收合延遲**的選單(jQuery 常見);零延遲又沒有 `z-index` 的選單救不回來
       (第一次閃斷就收合了),不假裝做得到。
    **「滑鼠踏上 iframe 才打開代理層」的事件式做法不可行**:真實瀏覽器實測,
    指標從頁面內容移進跨網域 iframe 時,父文件收不到**任何**事件
    (`mouseover`/`mouseout`/`pointerout` 都沒有),沒有任何進入訊號可用。
  - **代理層的位置在滑鼠移動時重算**(節流 250ms):lazy layout 常在進入選取模式之後才把 iframe 推開,
    只在建立時算一次會凍在舊位置。
  - 確認的目標是 `<iframe>`(或其代理層)時**不送 `PICKED`**,改送 `DESCEND_FRAME{purpose, taskId, src, preselect}`;
    background 以 `src` 對當下的 frame 清單做**網址比對**(只有 §3 的第 1、2 層——選取當下還沒有目標的 locator 可驗證),
    唯一命中才注入該 frame 並重新 `ENTER_PICK`(`purpose` 原樣帶著)。
  - 不是唯一命中 → 退回發出要求的那一層,`ENTER_PICK` 帶 `hint: 'frame_not_found'`,面板顯示「無法進入這個框架」。
  - **前置動作的「在頁面上選取」一律從最上層開始**(即使任務目標在 iframe 內):
    要點的按鈕常常在外層(頁籤、彈窗的關閉鈕),而值在 iframe 裡;
    進到值所在的那一層就選不到外層的按鈕了——選取模式只能往下鑽、回不去。
  - 指在代理層時 `↑` 走的是 **iframe 的父層**(代理層自己的父層是 overlay,不是頁面);`↓` 回到代理層。
    代理層在進入選取模式時建好,位置隨滑鼠移動重算(見上)。
  - **只能往下鑽,不能往上回**(`↑` 到該 frame 的 `body` 就停住);要換目標一律 `Esc` 重來。
- **純數值的標題不進任何名稱**(AF-14;判準見 §7 的 `isAnchorText`):
  `4318` 這種每天會變的值當名字,明天就對不上了。命名鏈**四個消費端**都套同一份判準——
  `picker.js` 的 `singleCellName`(單值任務名)與 `defaultPickName`(多值清單的預設值名)、
  `background/main.js` 的 `defaultFieldName`(重選存回時的值名);退不到就是 `nameHint`,再退是 `值 N`。
- **單值儲存格的預設任務名稱是欄標題**(使用者選的是「成交金額」那一格,名稱就該是它);
  欄標題空的才退回列標題,再退回 `nameHint`。整欄／整列聚合維持用 `nameHint`(那是整張表的聚合)。
- 選到表格類元素時,content 一併算出 **`nameHint`**(表格的 `<caption>` → 目標之前最近的
  `h1`~`h6` → 頁面 `title`,截 60 字)帶進 `PICKED`,Picker 拿它當任務名稱的預設值;
  非表格不帶,由 Picker 退回文字錨定或預覽前 20 字。
- **設定畫面是側邊面板(`chrome.sidePanel`),不是彈出視窗**(AF-10 推翻先前的 `windows.create`):
  面板停在目標分頁旁邊,永遠看得見、不會被別的視窗蓋住(MV3 沒有 `alwaysOnTop`),
  而且頁面上的高亮與設定畫面可以同時在眼前。新增、編輯、站台登入**三條走同一個載體**
  (以前編輯是另開一個普通分頁,「保持在最上層」對分頁根本不適用)。
  - **`open()` 必須是那個手勢裡第一個 `await` 的呼叫**(`shared/panel.js`):
    `setOptions` **不得 await**——兩者在同一個 task 送出,瀏覽器會照順序處理
    (實測:全域停用中、`setOptions` 換路徑,`open` 出來的仍是換過的那一頁)。
    右鍵選單的手勢發生在 service worker,**沒有 DOM 的暫時性啟用可依附**:
    先 `await setOptions` 就把 `open` 推到手勢之外,Chrome 拒絕,使用者看到的是
    「開的是彈出視窗,不是側邊面板」。擴充功能頁(Report 的編輯鈕、popup)另有 5 秒的
    暫時性啟用視窗,**跨幾個 `await` 仍然開得起來**——所以只從擴充功能頁驗證會漏掉右鍵這條。
  - **`sidePanel.open()` 只能在使用者手勢裡呼叫,而且手勢不跨 `sendMessage`**
    (實測錯誤訊息 `may only be called in response to a user gesture`):
    四個入口(右鍵兩項、popup 的選取鈕、任務頁的編輯鈕)各自在**自己的**處理函式裡呼叫,
    **不得轉給 background 代開**。唯一入口是 `shared/panel.js` 的 `openPanel(tabId, kind)`。
  - **參數一律走 `storage.session` 的 `panel:<tabId>`**,`setOptions.path` **不得帶查詢字串**:
    面板重載時 Chrome 用 `default_path` 重新載入,`?ctx=`／`?taskId=`／`?origin=` 全部會被丟掉(實測)。
    形狀是 `{ kind: 'waiting'|'new'|'edit'|'site', ctx?, taskId?, origin?, draft?, retarget? }`。
  - **面板判斷自己屬於哪個分頁**:`sender.tab` 永遠是 `null`、載入當下查作用分頁會在切換競態中
    拿到**切換前的舊分頁**(兩者皆實測)。可靠的做法只有一條:取 `windows.getCurrent().id`(跨重載穩定),
    **在轉為可見時**(`visibilitychange`,不是載入時)送 `RESOLVE_PANEL_TAB{windowId}` 問 background,
    而且每次轉為可見都重解析一次(自癒)。
  - **切走再切回會重載面板文件**(實測),所以表單值要寫進 `panel:<tabId>.draft` 並在重載時還原——
    沒有這一段,使用者切去看一眼別的分頁,回來就發現表單被清空了。
  - **面板已經有表單時再選一次目標＝換目標,不重置**:只換 `locator`/`picks`/`blockInfo`/`preview`/`nameHint`,
    名稱、排程、儀表板、進階設定全部留著,面板提示「已換成新的目標」。
    **右鍵與 popup 兩個入口在面板已有表單時都不得把 ctx 蓋成等待態**(蓋了草稿就沒了,
    選完也認不出是換目標);只有面板沒開、或停在等待態／站台設定時才寫等待態。
  - **同一份 ctx 不重畫**:草稿寫回 session 會觸發 `onChanged`,面板會再收到只多了 `draft` 的同一份 ctx——
    以簽章(`kind`/`ctx`/`taskId`/`retarget`)比對,沒變就不重畫,否則使用者正在打字時焦點會被踢掉。
    面板文件剛載入(切分頁回來)時 `retarget` 沒有「現有的表單」可以保留,要走完整路徑再貼回草稿。
  - **退路的彈出視窗要被告知服務哪個分頁**(網址帶 `tabId=`):它不是面板,作用分頁是它自己,
    解析不到目標分頁;picker 讀到 `tabId` 參數就直接採用、不再解析。
  - **面板關閉＝清場**,收斂到 `closePanelFor(tabId)`,**冪等**(暫存還在才代表這一輪還沒清過,
    清過就不再對頁面廣播 `EXIT_PICK`)。通道只有兩條:`sidePanel.onClosed`(142+,實測切分頁不會誤觸發)
    與 `tabs.onRemoved`(分頁關了,只清暫存)。
    **不可用面板自己的 `pagehide`,也不可用 `runtime.connect` 的斷線**——
    切換分頁會卸載並重載面板文件(實測),兩者都會把「還開著的面板」誤判成已關閉,
    然後清掉草稿與頁面上的標示,正好是本輪要修的那個症狀。
    代價:Chrome 114–141 沒有 `onClosed`,關掉面板後頁面上的標示會留到下一次選取或分頁關閉為止
    (只是視覺殘留,不影響資料)。儲存後自動關面板用 `sidePanel.close({tabId})`(141+)。
  - **舊版瀏覽器(或手勢不成立)退回原本的彈出視窗**,並記一筆 `panel_fallback` 診斷:
    使用者看到的是「右鍵沒反應」,沒有紀錄就查不出原因。
    另兩種說不出口的狀況也各記一筆:面板關閉清場(`panel_closed`,對到「藍框自己不見了」)、
    面板已關卻仍收到 `PICKED`(`panel_missing_on_pick`,對到「選完什麼都沒發生」)。
- **面板有三種畫面狀態**:**等待態**(`#panel-waiting`,右鍵剛開、還在頁面上選)——
  一句「正在頁面上選取…」加一顆「取消選取」;**表單**(選好之後);
  **換目標提示**(`#retarget-note`,「已換成新的目標，其他設定都留著。」)。
  等待態時表單與底部動作列一併隱藏——一開面板就看到一整頁空欄位,使用者不知道自己該做什麼。
- **面板的表單有草稿**(`panel:<tabId>.draft`,鍵是元素 id,debounce 300ms 寫回):
  切換分頁會重載面板文件(實測),沒有草稿就會「切去看一眼別的分頁,回來表單被清空」。
  **儲存或取消時連同 ctx 一起清掉**——不清的話,下一個新任務會被上一個的名稱與排程灌進去。
- **面板可以「回頁面重選目標」**(`#repick-target`):不必關面板、也不必回頁面按右鍵,
  按了直接進選取模式並把目前已選帶回去勾(`preselect`)。
- **送出後頁面上的標示要留著,直到面板關閉**(`data-af-held="<purpose>"`):
  表格是已選的那幾格;**非表格目標(最常見的單一數字)標在元素自己身上**——
  它的高亮本來畫在 overlay 上、會隨 overlay 一起拆掉,不另標就是送出後什麼都看不到。
  設定畫面就開在旁邊,使用者要看得到自己剛剛選的是哪一格。
  進入 `held` 時工具列、面板、事件攔截、`userSelect`/`cursor` 覆寫全部拆掉,頁面要能正常操作。
  **標示按用途分群**,而且**只標「這一輪選的」**(已經屬於別的用途的不得改群——
  前置動作送出一次就把任務目標那一格改成 `preaction` 群的話,
  下一次前置動作的 `Esc` 會連它一起抹掉);
  取消／`Esc`／下一輪 `ENTER_PICK` 只清**同一個用途**的
  (前置動作選到一半反悔,不該把任務目標的藍框一起抹掉);`EXIT_PICK` 清全部。
  `repick` 送出後不留標示(存檔就結束,沒有面板要看)。
- 確認後 content 送 `PICKED` 給 background,由它決定去處(`purpose`):
  `task` 把 ctx 寫進面板的 session、`repick` 直接更新既有任務的 locator
  (並重建排程、更新燈號、收掉為了重選而開的那個分頁)、
  `login-*` 轉發給站台登入設定視窗、`preaction` 轉發給 Picker 的前置動作那一列。
  **同一套狀態機,只有確認後的去向不同。**
- overlay 的樣式以 `element.style` 逐項設定(頁面 CSS 會污染 class),
  且 `content/picker-mode.js` 是**全專案唯一允許寫色碼字面值**的檔案——
  網頁沒有載入 `ui/theme.css`。**色碼一律集中在檔頭的 `COLORS` 常數**(值照抄 theme.css 暗色軌),
  其餘程式碼只引用它。外觀是深色系:深底、細邊框、圓角 8px;工具列是分段控制,
  作用中那段主色底;chip 深底淺字、移除鈕用 `×` 字元(不用 emoji);可點高度至少 28px。
- **擴充功能頁的共用元件樣式在 `ui/ui.css`**(主要按鈕、卡片/表單元素、`[hidden]`、
  `:focus-visible`、`prefers-reduced-motion`),**只吃 `theme.css` 變數、零色碼**,
  而且**不留沒有任何頁面使用的類別**(選取模式 overlay 注入在別人的網頁上,拿不到這份樣式表,
  它的 chip 樣式寫在 `content/picker-mode.js`)。
  `picker.html` 與 `site.html` 都載入它,頁面自己的 `<style>` 只留版面規則,
  **不得再寫一份共用樣式已有的規則**(主色按鈕掛 `class="btn-primary"`);
  Report 與 popup 尚未沿用(見 BACKLOG)。
- **Picker 設定視窗的版面**:整個視窗只回答三個問題——**抓什麼 / 多久抓一次 / 抓完放哪裡**。
  **「先試抓看看」區**(`#preview-section`)在失敗時多出「匯出診斷」鈕(`#export-diag`)與一句
  說明它內含什麼(`#export-diag-note`),成功或換了目標就收起來(內容屬於上一頁,見 §3);
  提示句說「請改用列定位」時,摘要卡旁另有捷徑鈕(`#goto-rowpos`)把焦點送到 `#row-pos` / `#col-pos`
  ——那兩個下拉在「抓什麼」區,不在進階區。
  頂部標題列(`[data-picker-header]`)——`#picker-title` 編輯既有任務時顯示任務名稱、新增時顯示「設定抓取任務」,
  `#target-host` 顯示目標網址的主機名(次要文字色、等寬字、過長截斷;網址不合法就留空),
  **任務名稱 `#name` 就在標題列**(開窗即可改,不必先找到某個欄位)。
  其下是**摘要卡** `#setup-summary`(`role="status"`,三行 `#summary-target` / `#summary-schedule` /
  `#summary-dashboard`),**任何影響這三句話的欄位變動都即時重算**(排程各欄、列/欄定位、
  數值類型、聚合方式、儀表板與卡片型別、一鍵命名),文字一律取自 `shared/describe.js`
  (`describeTarget` / `describeSchedule` / `describeDashboard`,與任務頁的排程欄、
  popup 任務列的 `title` 同一份;
  各寫一份會讓同一個任務在三個畫面上長得不一樣)。
  內容區(`.settings-body`)的直接子節點**一律是分節容器**,順序是
  抓什麼(`#block-section`)→ 先試抓看看(`#preview-section`)→ 多久抓一次(`#schedule-section`)→
  抓完放哪裡(`#add-to-dashboard`)→ 進階(`#advanced-section`),不留裸欄位。
  **`#url` 與 `#mode` 收在進階**:它們是程式從選取結果就知道的事實,擺在最前面只是讓使用者多讀兩行。
  `#preview` 是數值卡,測過之後帶 `data-state`(`ok` 綠 / `error` 紅,只用
  `--ok`/`--danger`),**每次 `render` 都先清掉**,免得換了目標還留著上一次的紅框。
  底部動作列:儲存(主色)/取消/立即測試,「將此次設定固定為預設值」在動作列上方。
  **頁面不得寫死寬度**(`picker.html` 與 `site.html` 都是 `width: 100%`):
  寫死會在較寬的視窗裡空出一條、讓捲軸卡在畫面中間;**面板寬度由瀏覽器管理**(實測最小 360px,使用者可自行拖寬),
  版面要在 360px 下不溢出、不橫向捲動;退路的彈出視窗尺寸(600×820)在 `shared/panel.js`。
- **多值清單的每一列**(`[data-field-row]`)除了序號與名稱,還有
  `[data-field-where]`(這個值在表格的哪個位置,「美金 · 買入」/「買入 整欄」)與
  `[data-field-result]`(立即測試的逐值結果就地顯示,未測與失敗都是 `—`,失敗原因放 `title`);
  另有一鍵命名 `#rename-col` / `#rename-cell`(**兩個值以上才顯示**),**只改沒有被使用者手動改過的列**
  (判準是 `input._afAutoName` 與現值相同)。
- **儲存成功不無聲關窗**:表單區換成 `#saved-feedback`——
  「已儲存。下次抓取:HH:mm」(時間取 `GET_NEXT_RUNS` 的實值,**在「儲存中」期間就問完**,
  拿不到才退回 `describeSchedule` 的白話句)加一顆 `#saved-open-report`,1.5 秒後自動關窗。
  延遲關窗前要確認 `globalThis.window` 還是自己那一個(否則會關到別人的視窗)。

### §2.1 Picker 表單的預設值

- `settings.pickerDefaults = { last, pinned }`,優先序 **`pinned` → `last` → 內建**。
  內建值寫在 `picker.js`(`BUILTIN_DEFAULTS`),**不放進 `DEFAULT_SETTINGS`**——
  `getSettings` 不與預設合併,放進去對舊使用者仍是 `undefined`。
  內建排程是**每天 09:30**(銀行牌告之類的頁面多在九點過後才更新)。
  **新任務預設加入第一個儀表板**,單值的卡片預設是**數字＋折線**
  (只給數字卡的話,使用者存完會看到一個沒有脈絡的數字,不會知道要自己去加折線才看得到趨勢);
  文字模式維持表格、多值維持樞紐表＋折線。
- 每次儲存新任務都更新 `last`;勾了「將此次設定固定為預設值」才另外寫 `pinned`。
  `saveSettings` 是淺層合併,寫 `pickerDefaults` 一律 read-modify-write,否則會把另一半洗掉。
  設定頁的「清除固定的預設值」只刪 `pinned`,保留 `last`。
- **編輯既有任務不套用任何預設值**,也不更新 `last` / `pinned`。
- **進階設定**(策略、正規表達式、生效時段、告警條件、前置動作)收在 `<details id="advanced-section">`,
  預設收合;編輯既有任務且其中有非預設值時自動展開。所有欄位 id 不變,只是換了外層容器。
- 編輯用了已移除策略(`attr`/`child`/`label`)的舊任務時,表單顯示一行說明(`#legacy-strategy-note`):
  設定原樣保留,改選其他策略才會換掉。
- 「立即測試」與正式抓取共用同一份規格組裝 `buildSpec(values)`,不得各組一份
  (否則區塊模式的預覽會落回數值策略鏈,測到整張表的第一個數字)。
  編輯既有任務時「立即測試」**維持隱藏**——這是產品決定,不是技術限制
  (改走 background 之後它會自己開分頁定位,開放與否見 BACKLOG)。
- **「立即測試」由 background 執行,不是 Picker 自己對頁面送 `EXTRACT`**:
  Picker 用 `buildTask` 組一個未儲存的任務(id `__preview`),送 `TEST_TASK{task, tabId}`;
  background 以 `runTask(task, { dryRun: true, reason: 'manual', tabId })` 跑完整流程
  ——找分頁、等載入、登入檢查、`locateFrame` 重新定位 iframe、`injectContent` 重新注入、`EXTRACT`——
  結果原樣回傳,**不寫紀錄、不進帳本、不存任務**。
  自己直送會在目標頁重新整理後拿到「Could not establish connection」:content script 已經不在、
  `frameId` 也換了。`runTask` 的 `opts.tabId` 指定分頁存在**且它現在的網址仍是任務那一頁**(用 §3 的 `sameOriginPath`,
  不另寫一份判定)才沿用;
  使用者把分頁導去別的網站時退回原本的找分頁流程,不能在不相干的頁面上定位與擷取。
  失敗時錯誤只放 `#errors`、`#preview` 顯示 `—`(同一句話不重複顯示兩次)。

## §3 選擇器(穩定性)

每個任務儲存多重定位資訊,擷取時依序嘗試,第一個唯一命中者為準:
1. 使用者可見的 `id` / `data-*` 屬性組成的 CSS 選擇器
2. 結構 CSS 路徑(nth-of-type)
3. 文字錨定:最近的標籤文字(如「今日總量」)+ 相對位置
4. 絕對 XPath(最後手段)

三者以上失敗 → 紀錄 `status: "not_found"`,並附當時 DOM 片段前 500 字方便除錯。

**目標在 iframe 內時另存 `task.frame = { url }`**(選取當下那個 frame 的 `location.href`);
目標在最上層時**不存這個欄位**(舊任務零遷移,沒有這個鍵就等於最上層)。
`frameId` 每次載入都不同、**存不得**——排程到點是開新分頁,所以要重新定位。
定位只有一份實作:`background/frames.js` 的 `locateFrame`,三層,**第一個「唯一」命中為準**:

1. 網址完全相同
2. `origin + pathname` 相同(query 常帶 token 或時戳;判定是 `frames.js` 的 `sameOriginPath`,唯一一份)
3. 逐個候選 frame 送 `RESOLVE_LOCATOR`(只判定不擷取),唯一 `found` 的那個

任一層命中兩個以上 → 進下一層;**第 3 層多重命中或全部失敗 → 判失敗**
(取錯 frame 會靜默抓到隔壁那張表的數字,比抓不到更糟)。
iframe 可能是「先點按鈕才出現」,所以 1、2 層是**輪詢**等待(預設 20 秒)。
定位失敗一律寫 `status: "not_found"`、`error: "找不到目標所在的框架"`——**不新增 status 種類**。
`locateFrame` 的回傳一律是物件:命中是 `{ frameId, matchedBy: 'exact'|'path'|'locator'|'top', candidates }`,
失敗是 `{ frameId: null, matchedBy: null, candidates, failed: true }`(**不再回 `null`**,AF-14)。
`candidates` 是當下列到的全部 frame,失敗時正是使用者要看的東西;呼叫端判定一律看**有沒有 `frameId`**,
不得比對 `=== null`。`frameId` 仍然**存不得**。

**試抓失敗的診斷包**(AF-14):「立即測試」失敗時,回應多帶一個 `debug`,Picker 顯示「匯出診斷」鈕,
使用者按下才存成 JSON 檔(`autofetcher-diag-<任務名>-<時戳>.json`,`saveAs` 由使用者選位置,SPEC §5)。
內容:`version`(manifest)、`at`、`tabUrl`(**`chrome.tabs.get` 的實際網址**,不是任務設定的)、
`task`(`name`/`url`/`spec`/`locator`/`frame`/`preActions`,**不含登入資料**)、
`frame`(`frameId`/`matchedBy`/`candidates`)、`preActionTrace`、`error`,
以及 content script 給的 `page`:`resolvedLayer`、表格摘要(`source`/`headers`/`rowHeaders`(**原文**,
不是過濾過的錨點)/`rowCount`/`colCount`/前 20 列 `cells`/`partial`)與那張表的 `outerHTML` 前 4000 字
(截到就標 `truncated: true`,**不靜默截**)。
`error` 的形狀依出口而定:定位/擷取失敗是 `{ error, message }`,最外層例外是 `{ error, raw }`
(`raw` 是轉譯成中文之前的原文,除錯時沒有它就沒有線索)。
**多值任務即使整體 `ok` 也要組**:表格解析得出來就是 `ok:true`,個別值仍可能失敗(§7),
content 端與 background 端都以「有沒有值失敗」判斷,只看整體 `ok` 的話多值任務永遠匯不出診斷。
**只在 `dryRun` 組**:正式抓取不帶,**不寫紀錄、不進 `diag` 環形緩衝**(500 筆會被擠掉),
只活在這一次回應與 Picker 的記憶體裡。成功時完全不帶(沒有消費端)。
按鈕旁明講「內含目標表格的 HTML 片段與頁面網址」——使用者要知道自己送出去的是什麼。
列 frame 用 `chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href })`,
**不需要 `webNavigation` 權限**。`about:blank` / `srcdoc` 的 iframe 網址沒有辨識度,只剩第 3 層,盡力而為。

## §4 排程與擷取流程

- 排程型別(每任務一種,可多筆):
  - `daily`:`HH:mm` 清單 + 星期勾選(預設每天);每次觸發後重算下一次的 `when`(見本節下方的對齊規則)。
  - `interval`:每 N 分鐘(N ≥ 1),可限定時段(如 09:00~18:00)與星期。
    **與 `daily` 一樣用 one-shot `when`,不用 `periodInMinutes`**——`periodInMinutes` 的週期起點是
    建立 alarm 的當下,設「08:30~09:20 每 10 分」會落在 08:33、08:43 這種不對齊的時刻,
    而且任何任務改動都會重建全部 alarm、把所有 interval 任務的相位一起重置。
    對齊規則(`shared/schedule-math.js` 的 `nextIntervalRun`,純函式;
    **實作只有這一份**,`background/scheduler.js` 只 re-export,Picker 的觸發預覽也用它——
    畫面預告的時刻與實際排的 alarm 各算一套就會不一樣):
    有時段 → 從時段起點每 N 分鐘,終點閉區間(08:30 08:40 … 09:20);
    沒時段 → 對齊當日 00:00 起的 N 分鐘倍數;
    跨午夜時段(22:00~02:00)→ 凌晨段從 00:00 起、傍晚段從 `from` 起,星期以候選時刻自己所在那天判定。
    算出的時刻必須嚴格大於現在(等於現在要跳下一格),最多往後找 8 天。
  - `weekdays` 缺省或空陣列,在 interval 一律視為**每天**(`nextIntervalRun` 與 `shouldRunInterval` 同一套規則;
    建 alarm 與觸發端若各判各的,會建了 alarm 卻永遠不觸發)。
  - alarm 名稱 `<taskId>:<index>`;任務修改/停用時整批重建。
  - `daily` **不用** `periodInMinutes: 1440`:每次觸發後重新計算下一次的 `when`(用本地時間算),否則日光節約或時區變更會漂移。
  - interval 觸發時,**排程槽取 `alarm.scheduledTime`**(對齊後的時刻)而不是實際觸發時刻,
    晚觸發不會自成新槽,冪等帳本才管得住;時段外觸發時**先排下一次再 return**,否則任務會永遠停擺。
  - **重試 alarm 名稱帶原始槽**(`<taskId>:retry:<n>@<slot>`):重試補的是同一格,
    否則 09:00 失敗、09:05 重試成功會變成兩列,冪等帳本也認不出是同一次排程。
  - **時段判定用 `alarm.scheduledTime`**,不是實際觸發時刻:晚觸發(休眠喚醒、worker 冷啟動)
    會滑出時段末端,把本來排定合法的最後一格丟掉。
  - 補建 alarm 的地方只有兩處(`scheduler.rebuildAlarms` 與看門狗),兩者共用同一個 `nextIntervalRun`。
  - interval 任務**不進錯過清單**(一個週末可累積上百槽,補抓沒有意義);睡醒後從下一個對齊槽繼續。
- **手動抓取(`reason: 'manual'`,來自任務頁與 popup 的「立即抓取」)**與排程觸發走同一個 `runTask`,但四點不同:
  ①**不查也不寫冪等帳本**——手動的 slot 是「當下這一分鐘」,寫進帳本會讓同一分鐘真正排定的 alarm 被擋掉,
  錯過清單也會誤判那一槽跑過;代價是同一分鐘按兩次會有兩筆紀錄(樞紐表同列取最新的成功值)。
  ②**不重試**,任何結果都立刻寫紀錄,使用者才看得到失敗。
  ③**不累加 `notFoundStreak`、不發通知**(使用者正看著畫面)。
  ④`res.status` 照原樣寫入,手動抓到欄位漂移仍是 `fallback`。
  `RUN_TASK` 回傳 `{ok, outcome: 'done'|'failed', status, value, error, values?}`;
  `values` 是多值任務每個值的 `{name, ok, value, error}`(同一分鐘按兩次只留每個值最新的那筆),
  任務頁與 popup 逐值就地顯示。
- 時區:一律用瀏覽器本地時間;紀錄同時存 ISO 字串(含 offset)與「排程槽」`slot`(`YYYY-MM-DDTHH:mm` 本地)。
- **Picker 的排程介面**(SPEC §2 的「多久抓一次」卡):
  - 每日:`<input type="time">` 加「加入」鈕,已加入的時刻顯示成可移除的 chip(去重並排序)。
    **事實來源仍是 `#times`**(逗號分隔字串),chip 只是它的介面,兩邊一律同步。
  - 間隔:「每 N 分鐘」加一個開關 `#window-enabled`「只在某個時段內執行」,**勾了才展開**起訖欄位;
    取消勾選要**清空殘值**(留著會被寫成 `schedule.window`,變成使用者沒要求的時段限制),
    編輯既有帶 `window` 的任務要把開關勾起來。時段欄位在主畫面,不在進階。
  - `#schedule-preview`(`role="status"`)顯示白話句,interval 另外列出**今天實際會跑的時刻與總次數**
    (迭代同一個 `nextIntervalRun`);星期或時段不符時說「今天不會執行」。
  - 表單值 → `schedule` 只有一份:`picker.js` 的 `buildSchedule(values)`(存檔與預覽共用)。

### §4.1 排程穩定性(MV3 的坑與對策)

| 風險 | 現象 | 對策 |
|---|---|---|
| service worker 被殺 | 閒置 30 秒或執行 5 分鐘就被回收,抓到一半消失 | 抓取開始時呼叫一次輕量 API(`runtime.getPlatformInfo`)延壽(**現況只呼叫一次,不是週期性續命**,見 BACKLOG);流程狀態機(`queued → loading → extracting → done`)寫 `storage.session`,worker 重啟時把卡在中途超過 3 分鐘的 run 標 `interrupted` 並清掉(重新排入見 BACKLOG) |
| alarms 在擴充功能更新 / 重新載入後消失 | 更新後所有任務靜默停擺 | `runtime.onInstalled`、`runtime.onStartup` 一律 `rebuildAlarms()`;另有看門狗(下) |
| alarm 觸發不準或重複 | 可能晚 0~60 秒、極少數重複觸發;補抓與正常觸發撞在同一槽 | **執行帳本** `runs[taskId][slot] = status`:同一 `slot` 只執行一次,重複觸發直接略過(冪等) |
| 電腦睡眠 | alarm 在喚醒時才響,可能已晚數小時 | 觸發時算 `late = now - slot`;補抓的紀錄標 `late`,超過容忍範圍的槽進錯過清單交使用者決定(§4 補抓;`lateTolerance` 見 BACKLOG) |
| 看門狗 | 上述任一環節漏掉,沒有人發現 | 固定 alarm `__watchdog` 每 15 分鐘:①確認每個啟用任務的 alarms 存在,缺就重建;②確認 `__sitecheck`(每日站台檢查)還在,不在才補建;③以帳本比對「上次檢查以來應有的槽」,缺的補進錯過清單;④清理超過 3 分鐘的中途 run(`startedAt` 存的是 ISO 字串);⑤記錄一筆心跳 |
| 沒有任何視窗 | macOS 上 Chrome 可在無視窗狀態執行,`tabs.create` 失敗 | 抓取前 `windows.getAll()` 為空時 `windows.create({state:"minimized"})`,用完關閉 |
| 背景分頁被 Chrome 丟棄(discard)/ 省電模式 | 分頁存在但內容被卸載,注入失敗 | `tabs.get` 檢查 `discarded`,是則 `tabs.reload` 再等 `complete`;自開的分頁設 `autoDiscardable:false` |
| 頁面永遠不到 `complete` | 有些頁長連線不結束 | 載入等待上限 30 秒,到時仍嘗試注入擷取;擷取本身逾時 15 秒(**計時器在擷取結束時清掉**,不清的話每抓一次都把 service worker 多吊 15 秒不能閒置) |
| 離線 / 網路錯誤 | 抓到錯誤頁 | `navigator.onLine` 為 false 直接排 10 分鐘後重試;找不到目標元素走重試(2 分鐘、10 分鐘,共兩次;HTTP 錯誤頁的判定見 BACKLOG) |
| 同時多任務 | 同站台互相干擾、開太多分頁 | 同站台嚴格串行並共用同一個分頁(全域並行佇列見 BACKLOG) |
| 時鐘/時區變更 | 排程槽算錯 | 看門狗每次比較 `Intl.DateTimeFormat().resolvedOptions().timeZone`,變了就 `rebuildAlarms()` |

- **診斷紀錄**:環形緩衝 500 筆(`storage.local.diag`),記 alarm 觸發、run 狀態轉移、看門狗結果、錯誤;Report 設定頁「排程健康」區顯示:
  每任務下次觸發時間(來自 `alarms.getAll` 實值,不是算出來的)、最近看門狗時間、最近 20 筆診斷
  (多值抓取每次一筆 `fetch_fields`,列出失敗的值)、「立即自檢」按鈕(建一個 1 分鐘後的測試 alarm 並回報是否準時觸發)。
- 通知策略:單次失敗不通知(重試中);重試用盡、看門狗發現漏槽、連續 3 次失敗、預檢失敗才通知,避免噪音。

### §4.2 預檢(抓取前提早測試,讓使用者有時間處理)

- 每個排程槽前 `precheckLeadMinutes`(預設 30,任務可調,0 = 關閉)另建一個 alarm `<taskId>:pre:<i>`,到點做**不寫紀錄**的演練:
  1. 開分頁載入目標 URL(同 §4 流程)。
  2. 若站台有登入設定:判定是否在登入頁 → 嘗試自動登入 → 驗證成功判定;失敗即 `login_failed`。
  3. 解析選擇器(§3),確認唯一命中;失敗即 `selector_lost`。
  4. 執行擷取策略鏈(§11)但不存 record;解析不出即 `parse_error`。
  5. 結果寫 `health[taskId] = {at, status, reason, detail}`,並更新燈號(§12);失敗立即通知「○○ 將於 HH:mm 抓取,預檢失敗:無法登入」,
     (**目前只有告警通知點得動**,預檢/站台檢查/找不到元素的通知點擊還沒接,見 BACKLOG。)
- 每日一次的**站台健康檢查**(`background/sitecheck.js`,`__sitecheck` alarm,
  時間取 `settings.siteCheckTime`,預設 08:00):對每個**啟用中**的站台開分頁走一次登入流程,
  結果寫 `health['site:<origin>']`,失敗即通知,提早發現密碼過期、驗證碼新增。
  用完的分頁一定關掉。與每日排程一樣用 `when` 重算,不用 `periodInMinutes`。
- 預檢通過但正式抓取仍失敗 → 走 §4 重試;預檢與正式抓取共用同一段流程碼,只差「是否寫紀錄」旗標。
- interval 任務(每 N 分鐘)不做每槽預檢(太頻繁),只吃每日站台健康檢查與正式失敗回報。
- 預檢用的分頁與正式抓取相同規則(背景、用完關閉);預檢失敗不重試,交給燈號與通知。
- 到點流程:background 開背景分頁(`active:false`)載入目標 URL → 等 `complete` + 額外等待(預設 3 秒,任務可調)
  → 若偵測到登入頁(§6)則先登入 → 注入 content script 擷取 → 寫入紀錄 → 關閉分頁。
- 若使用者已開著同 URL 的分頁,優先直接在該分頁擷取,不另開。
- 補抓:Chrome 未開時錯過的排程,啟動時整理成「錯過清單」(任務、應抓時間),以 `notifications`
  按鈕「立即補抓 / 略過」詢問使用者,Report 頁同時顯示橫幅可逐筆勾選;補抓的紀錄標 `status: "late"`。
  錯過清單只把最近 7 天內的槽算進去;既有項目不會自動過期(見 BACKLOG)。
- 重試:`not_found` 或逾時 → 2 分鐘後、10 分鐘後各重試一次(共兩次),仍失敗才寫失敗紀錄並發通知。
  `login_failed` 與 `parse_error` **不重試**(重試幾次結果都一樣)。
- 同一時刻多任務同站台 → 串行,共用分頁。
- 前景 vs 背景:`chrome.tabs.create({active:false})` 開的分頁 JS 照常執行,但 `document.visibilityState` 為 `hidden`,
  IntersectionObserver 式的 lazy-load、依可見性才啟動的圖表/輪詢**可能不觸發**。
  策略:預設背景;content script 擷取前先 `scrollIntoView` 目標;若同一任務連續 2 次 `not_found`,
  任務頁顯示提示與一鍵切換,任務可設 `foreground: true`(抓取時切到該分頁,結束後把焦點還給原本那個分頁)。
  成功抓到值一次就把提示清掉。
- **目標在 iframe 內時,Picker 會提示可能要加前置動作**(`#frame-hint`,`role="status"`):
  新任務、`ctx.frameUrl` 存在、又還沒有任何前置動作時才顯示,並把「進階設定」展開
  (藏在收合區裡等於沒提示)。「加入點擊步驟」= 新增一列 `click` 並立刻進入選取模式
  (`frameId: 0`,要點的按鈕常在最上層);「不需要」收起。編輯既有任務不提示。
  **「立即測試」成功且目標在框架內、又沒有前置動作時**,`#test-note`(`role="status"`,不是紅色的
  `#errors`)補一句「這次測試在目前分頁執行;排程會開新分頁」——測試是在使用者眼前那個
  已經開著 iframe 的分頁跑的,排程卻是開新分頁,成功不代表排程會成功。
- **送出中要有回饋**:「立即測試」與「儲存」按下後停用並改字(測試中…／儲存中…),
  結果回來(或驗證失敗)才還原,不得連按。
- 抓取前可選的**前置動作**(`task.preActions`,依序執行,任一失敗即停止並走錯誤路徑),四種:
  - **`hover`**(移到元素上,AF-10):`scrollIntoView` 後依序派發
    `pointerover` → `pointerenter` → `mouseover` → `mouseenter` → `mousemove`;
    **`mouseenter` / `pointerenter` 不冒泡**,要沿祖先鏈逐一派發(靠外層容器的 enter 才展開的選單很常見)。
    `holdMs`(預設 300)是游標停留的毫秒,停留期間每 100ms 補一次 `mousemove`(有些選單要停一下才展開);
    **刻意不派 `mouseout`/`mouseleave`**——下一步通常是點那個選單,移開會讓它收起來。
  - **`waitFor`**(等某元素出現,預設逾時 20 秒,`MutationObserver` 不輪詢):
    **「出現」預設是「看得見」**(`visible`,預設 true):在 DOM 裡不等於使用者看得到,
    選單多半早就在 DOM 中、靠 class 或 `display` 切換顯示;等到一個隱藏的元素,下一步就是點到看不見的東西。
    因此 observer **必須同時監聽 `attributes`**(`class`/`style`/`hidden`/`aria-hidden`),
    只監聽 `childList` 的話這種選單永遠等不到。要點隱藏項目的站台把 `visible` 設 false。
  - **`click`**(點某元素:關閉彈窗、切分頁籤):**派完整的指標事件序列**
    (hover 那一串 → `pointerdown` → `mousedown` → `focus` → `pointerup` → `mouseup` → `el.click()`)。
    只呼叫 `el.click()` 只會送出一個 `click` 事件,綁 `pointerdown`/`mousedown` 的元件庫選單點不動
    (與「填表單要派 `input`/`change`」同一個道理)。
  - **`wait`**(等 N 秒):**單位是秒**(`sec`,AF-10 改;下拉本來就寫「等待秒數」,欄位卻收毫秒,
    使用者填 3 只會等 3 毫秒)。**舊任務存的 `ms` 仍讀得懂**,重存時換算成 `sec`;
    換算只有 `shared/preaction.js` 的 `waitMsOf` 一份。
  在 Picker 的「前置動作」區設定,要點的元素直接回頁面上選(走 §2 的選取模式)。
  **「滑鼠移過去才出現的選單」用 `hover` → `waitFor` → `click` 三步組合**,不做一列做三件事的複合型
  (失敗時不知道卡在哪一步,而且比三列更難懂)。
  **做不到的要說出來**:合成事件的 `isTrusted` 一律是 false,**純 CSS `:hover` 展開的選單打不開**,
  Picker 的說明也寫著這一句與替代路徑(那種站台的選單項目通常本來就在頁面裡,
  把 `waitFor` 的「要看得見」取消再直接點它)。沒有這一句,使用者會以為功能壞了。
- **前置動作的失敗訊息要說得出「第幾步、哪一種動作、怎麼了」**(`shared/preaction.js` 的
  `preActionFailure`,唯一一份):`前置動作第 2 步（等元素出現）等不到元素出現（逾時）`。
  內部代碼(`preaction_timeout`)不得露出到使用者眼前。訊息一路走到紀錄的 `error` 與立即測試的 `#errors`。
- **立即測試回報前置動作的逐步軌跡**(`preActionTrace: [{step, type, ok, ms}]`,只在 `dryRun` 回傳,
  **成功與失敗都帶**):成功時 `#test-note` 顯示「前置動作 N 步完成（共 X 秒）」,
  失敗時顯示「走到第 N 步（前 M 步成功）」——失敗才是最需要軌跡的時候。
  `waitFor` 的逾時毫秒由 `shared/preaction.js` 的 `timeoutMsOf` 換算(字串也吃),
  background 與 content 兩端同一份,否則一邊 3 秒、一邊 20 秒。
  派不出事件(拿不到 `MouseEvent` 建構子)要炸成看得見的失敗,不得回 `ok`。調 hover 選單時最需要知道的是
  「hover 有做、是 click 沒點到」還是「hover 就失敗」,只回一句「成功」等於什麼都沒說。
- **前置動作逐一執行,每個動作各自帶 `frame`**(形狀同 `task.frame`,缺省 = 最上層):
  每個動作執行前各自 `locateFrame`(`waitFor` 用自己的 `timeoutMs`,`click` 用 20 秒),
  命中才注入該 frame 並送**只含這一個動作**的 `RUN_PRE_ACTIONS`。
  整批送給同一個 frame 是行不通的:要點的按鈕可能在最上層,而值在 iframe 裡。
  定位不到 → 走既有的前置動作失敗路徑(訊息含第幾個動作),後面的動作與擷取都不執行。
  **`wait` 由 background 自己等**,不送訊息到頁面、也不需要 frame。
- **順序是「先跑完全部前置動作,再定位目標的 frame」**:iframe 常常是點了按鈕才出現、或切頁籤後整個重建。
- **前置動作造成導覽之後,擷取要活得下來**(AF-13)。前置動作的點擊常常讓頁面換頁,
  舊文件連同注入的 content script 一起被丟掉,擷取這時送訊息會拿到
  `Could not establish connection`。三條規則:
  1. **「定位 → 注入 → 捲動 → 擷取」是一個整體**,中間任何一步**送不到**就整段重來,
     最多重試 3 次(間隔 300 / 600 / 1200 毫秒)。**一次**的定義是從重新定位跑到擷取回應或拋錯。
  2. **哪些不重試**:擷取逾時(那是頁面沒回應,重試只會把 15 秒乘以四)、
     找不到框架(`locateFrame` 自己已經輪詢到逾時才放棄)、
     **前置動作**(它有副作用,重放就是把按鈕再按一次,所以它留在重試區塊外面)。
     **唯一例外是 `waitFor`**:它只觀察不動頁面,前一步的點擊讓頁面換掉、它送不到時可以重送
     (同樣的次數與間隔)——SPEC 自己推薦的「點擊切頁籤 → 等元素出現」正是這種。
     `hover`／`click` 送不到就停下來,訊息說「第幾步送不到、頁面在這一步之前換頁了、請在前一步後面加等待」,
     原文進診斷。
     判定「該不該重試」**不得比對 Chrome 的英文錯誤字串**——那串字會隨版本與語系變;
     我們自己丟的逾時要帶得出身分。
  3. **捲動到可視區是盡力而為**:它**逾時**就往下走讓擷取自己判定(為它重試等於把 10 秒乘以四);
     它**送不到**則要往上冒出去觸發重試(那是文件被換掉的訊號)。
- **「等分頁回到 `complete`」對子框架導覽無效**:真實瀏覽器實測,`iframe.src` 改變時
  `tabs.get(tabId).status` **全程是 `complete`**,沒有任何訊號;整頁導覽才會短暫變 `loading`(約 25 毫秒)。
  兩種導覽下 `frameId` 都不變,所以症狀是「文件被換掉」而不是「框架不見了」。
  別再想用分頁狀態當作前置動作後的等待條件。
- **送給 content 的每一則訊息都要有逾時**:`RUN_PRE_ACTIONS` 的逾時要**涵蓋動作自己需要的時間**
  (`shared/preaction.js` 的 `messageTimeoutMs`,唯一一份:`hover` 用 `holdMs`、`waitFor` 用自己的逾時,
  各加 5 秒緩衝,其餘 20 秒)——固定值會把「使用者刻意設長的 hover」誤報成沒有回應。
  逾時的訊息說的是**「沒有回應（這一步可能讓頁面換頁了）」**而不是「動作失敗」:
  正常情況回應幾毫秒就回來,會逾時最可能就是那一步讓頁面換掉了。
  **這是保守的取捨**:寧可誤報並說出方向,也不要無限卡住讓 service worker 被回收。
- **存活重試與排程層重試是兩件事**:前者是「同一次執行內,文件被換掉就再抓一次」(最多 3 次),
  後者是 §4.3 的「這一輪失敗,隔一段時間整個重跑」(`attempt < 3`)。兩者各自計數、互不影響。
- **重試耗盡後給使用者的是中文**:`fetcher.js` 的 `PAGE_GONE_MESSAGE`(唯一一份,
  立即測試、紀錄、任務頁、popup 都吃它),說出發生什麼、可能的原因、能怎麼辦;
  **Chrome 的英文原文寫進 `shared/diag` 不丟掉**,但不顯示給使用者。
- **額外等待秒數**的優先序:呼叫端指定 > `task.extraDelaySec` > `settings.extraDelaySec` > 3 秒。
  `0` 是合法值(代表不等)。
  它有**兩個作用點**:最初載入完成之後,以及**前置動作全部跑完之後**(只有真的跑過前置動作才等第二次)。
  第二個作用點是為了縮小「擷取打中舊文件」的窗口——擷取若趕在導覽生效前打中舊文件,
  而 locator 剛好在舊頁面上匹配得到,會回一個**成功的錯誤值**靜靜寫進紀錄,那比看到錯誤更糟。
  **但這只是縮小窗口,不是關閉窗口**:沒有任何訊號能證明「頁面已經安定」(見上面的實測),
  設成 `0` 就是使用者自願承擔。

## §5 儲存

- 主資料:`chrome.storage.local`,`schemaVersion` 目前為 **2**
  - `tasks: Task[]`、`sites: Record<origin, Site>`、紀錄以 `rec:<YYYY-MM-DD>` 為鍵
  - 其他鍵:`runs`(冪等帳本)、`missed`、`health`、`diag`、`layout`、`alertLog`、`cryptoKey`、`lastValues`、`lastTrimDate`、`settings`;`storage.session.inflight`
  - 保留天數預設 365,超過自動刪最舊(設定可調);由看門狗執行,一天最多掃一次(`lastTrimDate`),不放在抓取寫入路徑。
- 檔案匯出(**只在使用者手動觸發**,不自動下載):
  - Report 設定頁「匯出」區:選日期範圍(單日 / 本月 / 全部)與格式(JSON 日檔、CSV、獨立 HTML 報表 §8.5),
    按下才呼叫 `chrome.downloads.download`(`saveAs:true` 讓使用者選位置;預設檔名 `AutoFetcher/<YYYY-MM-DD>.json`)。
  - 多日匯出時打包成一個 JSON(`days: [...]`)或多列 CSV,不產生多個下載。
  - **獨立 HTML 報表**:檔名 `AutoFetcher/report-<from>_<to>.html`;內嵌調色盤(取自 `ui/theme.css`)、
    目前儀表板的卡片快照與紀錄表格;**不含 `<script>`、不含任何外部資源**,離線可開、可列印
    (`@media print` 下卡片不跨頁截斷)。
  - 擴充功能無法自行寫任意路徑,自動落地方案(File System Access / Native host)列 BACKLOG。
- 設定匯出/匯入(換機):
  - 匯出 `autofetcher-settings.json`:`tasks`、`sites`(密碼**預設不含**;勾「含密碼」時以匯出時輸入的密語 AES-GCM 加密,見 §6)、
    Report 版面(§8)。不含 `records`(歷史另有日檔)。
  - 匯入:同 `taskId` 覆蓋、新 id 新增;匯入後重建所有 alarms;若含加密密碼則要求輸入密語。
  - 歷史匯入:Report 頁可選多個日檔 JSON 併回 `records`(同 taskId + capturedAt 去重,既有紀錄不被覆蓋);
    也接受打包格式 `{days: [...]}`;回報 `{added, skipped}`;任一日檔形狀不合則整批不寫入。
- **紀錄的 `taskId` 對多值任務是序列 id**(`<任務id>#<值key>`,§7):
  CSV 的 `taskId` 欄、日檔的 `tasks` 鍵、歷史匯入的去重鍵(`taskId` + `capturedAt`)都跟著變成序列 id,
  **檔案格式與 schema 版本不變**。單值任務完全維持原樣(舊資料零遷移)。
- **寫入 API**:`appendRecord(date, record)` 與 `appendRecords(date, records)`、`setLastValue` 與 `setLastValues(entries)`——
  多值任務一次抓完的那幾筆一定走批次版(每筆各讀寫一次整包會讓 N 個值變成 N 倍成本)。
- **`saveTask` 的守門**:`task.id` 不得含保留字元;`task.fields[].key` 必須是非空字串、
  不得含保留字元、同任務內不得重複——違反就丟例外拒絕存檔。設定匯入逐筆 try/catch,
  單一壞任務被跳過並回報 `{skippedTasks}`,不拖垮整批。
- **變更訂閱**:`subscribe(handler)` 是 UI 監看資料變動的唯一入口(UI 不得自己碰 `chrome.storage.onChanged`)。
  只看 `local` 這個 area,只有 `tasks` / `health` / `layout` / `missed` / `lastValues` 與 `rec:` 開頭的鍵會通知;
  **`runs` 與 `diag` 一律排除**(每次抓取都在變,拿來重繪會讓畫面不停重畫)。
  同一批連續變更去抖 50 毫秒只通知一次;回傳的函式可取消訂閱。
- 紀錄欄位(除既有的 `taskId`/`slot`/`capturedAt`/`value`/`raw`/`status`/`strategyUsed`/`layer` 外):
  `alert` 與 `alertHits`(§10 命中告警時才有)、`used` / `skipped`(§7 區塊聚合用了幾格、跳過幾格)、
  `partial`(§7 只抓到部分,**只有為真時才寫**)、`error`(失敗原因)、`snippet`(找不到元素時的 DOM 片段)、
  `label`(§7 位置定位抓的是哪一列;**只有用位置定位時才寫**)。
- 日檔 schema:
  ```json
  { "date": "2026-09-05", "tasks": { "<taskId>": { "name": "...", "records": [ {...} ] } } }
  ```

## §6 自動登入

- Site 設定:登入頁 URL、帳號欄/密碼欄/送出鈕選擇器(在登入頁右鍵「設定此站台登入」開設定視窗,
  三個欄位各自「在頁面上選取」,走 §2 的選取模式)、登入成功判定(URL 前綴 或 某元素存在)、
  登入頁判定(URL 前綴 或 密碼欄存在)。三個選擇器沒選齊不給存(存了也只會在抓取時失敗)。
- 密碼只存 `chrome.storage.local`,以 WebCrypto AES-GCM 加密(`shared/crypto.js`),
  金鑰自動產生後存於同一 storage(**僅防誤讀,不防同機惡意程式**;設定視窗與設定頁都明示)。
  不使用 `storage.sync`。
- **設定匯出**:預設不含密碼(連密文都不放)。勾「含密碼」時,先用本機金鑰解回明文、
  再用使用者輸入的**密語**重新加密放進 `secrets`;匯入端以密語解開後,**用該機器的本機金鑰重新加密**
  寫成 `passwordEnc`——storage 內任何時候都不留明文。密語錯誤則整批不寫入。
- **舊格式遷移**(`schemaVersion` 1 → 2,`storage.init` 做一次):
  `loginPageUrlPrefix` → `loginCheck`;明文 `password` → 加密成 `passwordEnc` 並刪除原欄位。
- 抓取流程(`background/login.js`,在等待載入之後、注入擷取之前):
  1. 讀**分頁被轉址之後的實際網址**判斷是不是停在登入頁(不是任務設定的網址)。
  2. 站台已被停用 → 直接回 `login_failed`,不再嘗試(避免一直用錯密碼撞帳號鎖定)。
  3. 解密密碼 → 送 `FILL_LOGIN` 給 content:填值並派發 `input`/`change` 事件
     (只設 `value` 對 React 之類的表單無效),再點送出鈕。
  4. 等重新載入完成,依 `successCheck` 判定;成功 `failStreak` 歸零,失敗則累加。
- 有 2FA / 驗證碼的站台不支援自動登入;連續 3 次登入失敗即停用該站台並通知一次。
- `login_failed` 是紀錄狀態之一,**不算成功**,而且**不重試**(密碼錯了重試幾次都一樣)。

- **站台設定面板**(`ui/site/`,side panel):每次重畫都從乾淨狀態起算(切到沒有站台設定的分頁時
  不得沿用上一個分頁的 origin,否則 A 站的設定會寫到 B 站);轉為可見時**分頁沒變就不重畫**
  (重畫會把剛填的密碼與剛選的欄位洗掉);判斷不出目前分頁(`origin` 為空)時停用儲存鈕並說明,
  存檔也擋下——鍵為空字串的站台永遠不會被任何網址命中。存好之後與任務面板同一套:
  1.5 秒後請 background 關面板(連同頁面上保留的標示)。
## §7 區塊模式:儲存格、欄列聚合、一個任務多個值

- `task.mode = 'block'`;`task.spec` 有三種形狀,擇一:
  - `spec.block = { axis: 'col'|'row', index, headerText, aggregate }` —— 整欄或整列聚合(原有)。
  - `spec.block = { cell: { row: {index, header}, col: {index, header} } }` —— **單一儲存格**
    (列 × 欄交會的那一格,匯率表「美金 × 即期買入」就是這種)。不聚合。
  - **位置定位**:任一軸可帶 `pos: 'first' | 'last' | 'last-1'`,有 `pos` 就**不看 `index` 與 `header`**,
    每次擷取以當下的筆數重算(`extract.js` 的 `resolveByPosition`,唯一一份;`picker-mode.js` 勾回
    preselect 時也用它)。給的是「每天在最前或最後新增一筆」的表格——列標題是日期時,
    依標題定位隔天就 `not_found`。`last-1` 是因為最後一列常是合計。
    **表頭列用 `td` 排的表格**,`getDataRows` 會把它當資料列,`first` 因此會取到表頭那一列
    (判準不放寬:放寬會誤殺真正的資料列);Picker 的即時預覽會讓使用者當場看到值不對。
    **筆數不足**(只有一列卻要 `last-1`)→ `not_found`;**那一格是空的或解析不出來** → `parse_error`,
    **不往前找非空格**(使用者要的就是那個位置)。位置定位沒有備援的概念,狀態一律 `ok`。
    整欄／整列**再帶 `pos` 就是「那一格」**(「成交金額」× 最後一列),`aggregate` 忽略、`used` 為 1。
    位置是**任務層級**設定(Picker 的「列定位／欄定位」),寫進規格時每個值的同一軸各帶一份。
  - **`label`**:任一軸用位置定位時,擷取結果與紀錄多帶 `label`(那一列的列標題;兩軸都用位置時「列 · 欄」),
    歷史頁的該列 `title` 顯示「來源列:…」、明細多一行。依標題定位的不寫(規格裡本來就有)。
    沒有它的話,「今天早上網站還沒更新」與「抓錯列」在畫面上長得一模一樣。
  - `spec.fields = [{ key, cell? , block? }]` —— **一個任務抓多個值**,每個值各自是儲存格或欄列聚合。
  **多層表頭**:最後一層決定欄名,上層有 `colspan` 的視為群組,組成「群組 · 欄」——
  匯率表的四個「買入/賣出」因此變成「現金匯率 · 買入」「即期匯率 · 買入」…,
  漂移偵測才分得出是哪一組。
- **定位與漂移**(欄與列同一套規則,`extract.js` 的 `locateByHeader`):
  表頭對得上原索引 → 用它、`ok`;搬家了 → 跟著表頭走、`fallback`;
  **同名表頭有多個時取離原索引最近的那一個**;表頭整個不見 → `not_found`。
  **整列聚合也走這一套**(只吃 `index` 的話,表格前面插一列就靜默抓錯列)。
  代價是**那一列的第一格會變動時會硬性失敗**(照索引取值仍會動);對**文字型**標題這是刻意的:
  安靜地聚合到別一列,抓到的數字看起來很正常卻是別人的資料。失敗訊息會建議改用位置定位。
- **純數值的標題不當定位錨點**(AF-14;判準唯一一份在 `shared/table.js` 的 `isAnchorText`,
  `anchorHeader(row)` 是它套在列標題上的版本)。判準是**嚴格**的:去掉千分位逗號與空白後
  整段是「可選負號+數字+可選小數」才算純數值(`4318`、`1,234`、`-5`、`3.5`);
  `2024年度`、`No.4318`、`A-100`、日期字串**仍然是錨點**——`parseNumber` 解得出數字不足以當判準。
  單列無表頭的表(`<tr><td>4318</td><td>38605</td></tr>`)第一格本身就是每天會變的資料,
  拿它當錨點隔天必定 `not_found`,而且沒有任何東西可以當錨點。
  - **四個消費端走同一份判準**:選取端寫進規格的 `row.header`/`col.header`/`block.headerText`、
    preselect 回選與重存、擷取端的 `locateByHeader`、命名鏈(`singleCellName`/`defaultFieldName`)。
  - **舊任務零遷移**:規格裡已經存了 `"4318"` 的任務不必重存,擷取端遇到純數值 header 視同沒有 header,
    走 `index`、狀態 `ok`(**不是 `fallback`**——`fallback` 屬警示狀態,那種表會天天亮黃燈)。
  - **選取當下要說出來**:摘要卡多一句「這一列的第一格是數字(4318),不能當標題,改以位置抓;
    若這張表會新增列,請改用『列定位』」(`shared/describe.js` 的 `anchorNote`,白話只有一份)。
    原文靠 pick 上的 `rawHeader` 帶到 Picker,**只給畫面看**(面板 chip 也用它),
    `buildSpec` 會濾掉它——進了規格就會被存進 storage、參與規格比對,下一輪又被當成錨點。
  表頭不見時的 `message` 要指向解法,並說出現況:
  「標題『…』找不到;目前這張表的列標題是:A、B、C(超過 5 個只列 5 個並說總數);
  若這張表每天新增一列,請到任務設定改用位置定位」,列與欄各說各的軸;
  **一個標題都沒有時**改說「目前這張表沒有列標題」,不留下「是:」後面的空白。
  而且**要一路走到使用者眼前**:多值任務的每個值各自帶、寫進紀錄的 `error`、「立即測試」優先顯示它
  (只顯示 `not_found` 等於告訴使用者「壞了」卻不說能怎麼辦)。
  儲存格的欄或列任一為 `fallback`,整格就是 `fallback`。
- **多值的成敗分界**:表格本身解析不出來 → `{ok:false, error:'not_found'}`,這才走重試;
  表格解析得出來就是 `{ok:true, fields:{...}}`,**即使每個值都失敗**——
  欄位漂移不是暫時性問題,重試沒有意義。
- **多值的寫入**(`fetcher.js`):一次載入、一次擷取,每個值各寫一筆紀錄,
  `taskId` 是**子序列 id**、`slot` 全部相同;整組只呼叫一次 `appendRecords` 與一次
  `getRecordsInRange`(每個值各讀寫一遍會讓 N 個值變成 N 倍成本)。
  帳本與 health 寫在**父任務 id** 上,`lastValues` 寫在子序列上。
  health:全成功 `ok` / 有備援或遲到取該狀態 / 部分值失敗 `partial` 並註明幾個 /
  全部值失敗取第一個失敗狀態(紅)。
- **序列 id**:多值任務的每個值在紀錄、卡片來源、告警紀錄、歷史篩選裡都是
  `<任務id>#<值key>`。組合、拆解、名稱解析**只有一份** `shared/series-index.js`
  (`seriesIdOf` / `parentIdOf` / `fieldKeyOf` / `buildSeriesIndex` / `nameOf`),
  任何模組都不得自己切字串。`buildSeriesIndex(tasks)` 回傳
  `{ byId, parents, childrenOf, seriesIds }`,每筆序列是
  `{ id, parentId, name(「任務 · 值」), shortName(值名), fieldKey, mode }`;
  `seriesIds` 的順序是任務順序 × 值的順序。
- **父任務 id 與序列 id 的分工**(記錯會讓冪等失效或畫面永遠空白):

  | 用父任務 id | 用序列 id |
  |---|---|
  | 排程 alarm、執行帳本 `runs`、`inflight` | 紀錄的 `taskId` |
  | `health`、`missed`、`GET_NEXT_RUNS`、`MARK_READ` | `lastValues`、`alertLog`、通知 id |
  | 預檢、診斷、`notFoundStreak` | 卡片 `source`、歷史頁篩選、匯出的任務鍵 |

- **共用的表格工具**(`shared/table.js`):`columnHeaders(el)`(與資料欄一一對齊的完整表頭)、
  `rowHeader(row)`(該列第一個非空文字格)、`getDataRows(el)`(排除表頭的資料列元素)。
  表頭列只認 `thead` 內的列,或表格**開頭連續**的表頭列——表格中段整列 `th` 的分組標題
  (「亞洲貨幣」那種)是資料的一部分,把它當表頭會讓整份表頭被那一列洗掉。
- **CSS 假表格的資料列判準也只有一份**(`cssGridRowsOf`):選取端與解析端各寫一份的話,
  兩邊對「哪些是列」的認知會漂移——本輪修掉的正是這種漂移。
- **「哪些列／格屬於這張表」的判準只有 `shared/table.js` 一份**(AF-10):
  `tableOf` / `cellOf` / `isHeaderCell` / `tableRowsOf` / `rowCellsOf` / `isHeaderRowOf`
  加上 `CELL_SELECTOR` / `TABLE_SELECTOR`,`content/picker-mode.js`(選取)與
  `shared/block-detect.js`(面板描述)都 import 它,不得自己再寫一份。
  規則:同時認 `<table>` 與 ARIA(`role=grid|table` / `row` / `cell|gridcell|columnheader`);
  **列只算「最近的表格祖先就是這張表」的**、格只算「最近的列祖先就是這一列」的(巢狀小表格的列格不算);
  `role="columnheader"` 整列視為表頭列。容器(`<div>`、`role="table"`)自己沒有列、
  卻恰好包著**一張**表格時以那張表為準;**包著兩張以上就不猜**(挑第一張會少算,
  使用者也無從得知挑了哪一張)。
  三份判準不一致的代價是靜默錯值:選取時以外層算索引、擷取時解析內層,抓到的是別一格。
- **選取端與擷取端必須看到同一張表**:`picker-mode.js` 的 `upgradeTarget` 在回傳前套
  `innermostTable`,與擷取端(`parseTable` / `getDataRows`)同一份判準。
  滑鼠落在純包裝外層的那一格(`<td>` 的邊或 padding)時,沒有這一條就會索引配錯表。
- **格子裡自己包著一張表格時,面板要先說出來**(`這一格內含表格，會抓到整串文字…`):
  那一格的文字是內層小表整串接起來的(`25530`+`39806` → `2553039806`),
  解析出的數字只是碰巧排在最前面的那個——抓得到值但值是錯的,是看不見的錯誤。
  面板只在目標改變時重畫,所以 hover 換到(或離開)這種格子時補畫一次,不是每次 `mousemove` 都重畫。
- `task.fields = [{ key, name }]` 是**顯示用**的值清單(名稱、順序),
  `task.spec.fields = [{ key, cell?|block? }]` 是**擷取規格**,兩者以 `key` 一一對應;
  `key` 建立後不變、同任務內唯一、不得含保留字元。改名不改 `key`。
- **Picker 的值清單**(`#field-list`,每列 `data-field-row`):挑了 2 個以上的值才出現。
  任務名稱只填一次(用 `nameHint`),每個值各自命名,預設 `cell` 型用「列標題 · 欄標題」、
  `block` 型用表頭;同名自動加序號。可上下移動改順序、可移除。
  聚合方式全任務一份(每個值各自聚合列在「明確不做」);**全部的值都是儲存格時聚合下拉隱藏**——一格就是一個值,沒有東西要聚合;
  **選了位置定位時也隱藏**(有位置就是取那一格)。
  **整欄的值不給選「欄定位」、整列的不給選「列定位」**(那一軸是使用者自己點的,
  留著能選但選了不生效就是一個靜默無效的設定):停用並用 `title` 說明,值一併清掉。
  **`#row-pos` / `#col-pos` 是位置定位的下拉**(依標題／第一筆／最後一筆／倒數第二筆,各有可見標籤與
  `#pos-hint` 白話說明)。使用者點的剛好是第一列或最後一列時,`#block-summary`(`role="status"`)
  **給建議但不替他改設定**——兩列的匯率表點第一列(美金)與每日成交表點最後一列在資料上長得一樣,
  猜錯就是默默換掉定位方式。改了定位方式時**重算尚未被手動改過的名稱**(手改過的一律尊重)。
  用位置定位的那一軸**不把標題寫進值名稱**(「成交金額(最後一列)」),那個日期明天就變了。
  **重選保留原本的定位方式**(`applyRepick` 的 `keepPos`),而且比對「是不是同一個值」時忽略 `pos`
  (`sameSpec` 的 `stripPos`)——帶著 `pos` 去比會永遠不相等,`key` 重生就把歷史紀錄的序列切斷了。
  移除一個值只影響之後的抓取,**舊紀錄保留**(它的子序列 id 還在)。
  儲存前 `#save-summary` 顯示「將建立 1 個任務、N 個值」。
  告警列在多值任務多一個「套用到」下拉(空值 = 全部值),寫進 `alert.field`。
  「立即測試」對多值任務逐值顯示預覽。
- 解析(`shared/table.js` 的 `parseTable`)→ 聚合(`shared/aggregate.js` 的 `aggregateCells`),
  兩層都是純函式;`extract.js` 的 block 分支串起來,**不走數值策略鏈**。
- 對象是 HTML 表格的各種寫法,解析為二維陣列 `cells[row][col]`(只含資料列,表頭另外放 `headers`):
  - `<table>`:含 thead/tbody、`rowspan`/`colspan`(展開成實際格子)。
    **巢狀 table 只在「純包裝」時取內層**(`shared/table.js` 的 `innermostTable`,唯一一份判準):
    這張表自己的儲存格之中恰好一格含 `<table>`、**那一格除了內層表格沒有自己的文字**、
    其餘每一格文字皆空,才往內鑽(可重複多層)。
    (`<td>總計<table>…</table></td>` 不算純包裝——鑽進去「總計」就沒了。)
    否則外層就是資料表,格內的小表格只是那一格的內容(文字扁平化)。
    監控頁常見「每一列的某一格各包一張小表」,舊的「有內層就取最內層」會把整張表看成 1 列 2 欄。
    容器(如 `<div>`)包著表格時仍以那張表格為準。
  - `role="grid"/"table"` + `role="row"/"cell"`(ARIA 表格,常見於 React/MUI/AG Grid)。
  - CSS grid / flex 假表格:以「同構子節點」啟發式:容器下重複出現、子節點數相同的元素視為列,其子元素為欄。
  - `<ul>/<ol>`:每 li 一列,以空白/tab 切欄。
  - 虛擬捲動表格(只渲染可視列)只抓當下渲染的部分,並在紀錄註記 `partial: true`。
    **位置定位在這種表上取的是「當下渲染的最後一列」,不是真正的最後一列**;
    紀錄本來就會標 `partial`、燈號轉黃,不另外處理。
- 使用者選的單位有三種:**單一儲存格(預設)、整欄、整列**——**直接在頁面上點**
  (§2 選取模式,右上角工具列切換,`Tab` 在三段之間循環),不是在視窗裡填數字。
  聚合方式(`max`/`min`/`avg`/`sum`/`count`)只對整欄/整列有意義,在 Picker 選;
  **單格不聚合**,Picker 會把聚合下拉隱藏。
- 抓到值時紀錄帶 `used`(用了幾格)與 `skipped`(跳過幾格);`partial` 為真時紀錄標記,
  健康燈號轉黃(抓到值仍算成功)。
- 數值解析:去千分位、貨幣符號、百分號、全形數字、會計負數(半形與**全形**括號);無法解析的格子略過並記 `skipped` 數。
- **整串看起來像日期或範圍時(`09-02`、`2026-09-02`、`10-20`、`5/8`)一律不當數值**——抓到錯的數字是看不見的錯誤,回 `parse_error` 是看得見、使用者可以改設定的錯誤。夾在文字裡的數值不受影響(`09-02 用電 1,234 度` 仍取得到 9)。
- Canvas / SVG 圖表**不在範圍**(見 BACKLOG)。

## §8 Report 頁(AutoFetcher-Report)

### §8.1 結構

- 路徑 `report.html`,**開啟即直接呈現資料**(儀表板為首頁);匯出只是設定頁的一個區塊,不是主要用途。
- 頂部頁籤:**儀表板**(可多個)| **歷史查詢** | **任務** | **設定**。
- 頂部固定一條**日期範圍列**(所有頁籤共用):快捷「今天 / 昨天 / 近 7 天 / 近 30 天 / 本月 / 上月 / 自訂」+ 月曆挑選;
  儀表板所有卡片與歷史查詢都跟著這個範圍;左右箭頭可逐日/逐週往前翻。
- 由右鍵選單、工具列圖示 popup、或 `chrome://extensions` 的擴充功能選項開啟。

### §8.2 儀表板:自訂版面(重點)

**版面模型**

- 每個儀表板 = 12 欄格線 + 卡片清單;卡片 `{id, type, x, y, w, h, source, options}`;`w` 1~12、`h` 1~6(每單位 80px 暫定)。
  新增卡片一律經 `layout-store.addCard`:傳入的 `x, y` 若沒被佔就照用,否則由它找第一個空位(所有呼叫端同一規則)。
- 卡片型別:

| 型別 | 顯示 | 主要選項 |
|---|---|---|
| `number` | 最新值 + 與前一筆/前一日差異(箭頭、百分比) | 小數位、單位、比較基準、閾值色 |
| `line` | 折線(單任務或多任務) | 期間 1/7/30/90 天、聚合(原始/每日最後/最大/最小/平均)、Y 軸範圍 |
| `bar` | 長條(每日聚合) | 同上 |
| `table` | 最近 N 筆(`mode: recent`)或樞紐表(`mode: pivot`,列=時間、欄=序列;`showDelta` 為真時每格附與**表格上緊鄰前一列**同欄的差,箭頭 + 絕對值,漲跌用 `--ok`/`--danger`;
  算法是 `series.js` 的純函式 `withDelta`,**缺值不補不內插、也不往前找更早的成功值**;複製 TSV 不含差值) | `limit`(兩種模式都吃;最近 N 筆未設預設 10、樞紐表預設 50)、`rowHeader`(樞紐表第一欄標頭,預設「時間」)、`bucketMinutes`(時間容差,見下) |
| `gauge` | 目前值在區間內的位置 | 下限/上限、警戒線 |
| `text` | 標題、說明文字(支援粗體/清單) | 內容 |
| `status` | 每個任務的最後抓取狀態、下次排程時間 | 任務篩選 |

- `source`:一或多個 `{taskId, aggregation}`;同一任務可出現在多張卡片。
  **`source` 的陣列順序就是樞紐表的欄序**(拖曳插入欄位、抽屜的上下移動都是在改它)。

**樞紐表的時間容差合併(`bucketMinutes`)**

- 每筆紀錄的「有效時刻」= `slot`,沒有 slot 就用 `capturedAt`(補抓與手動觸發的紀錄因此也進得了樞紐表)。
  **`slot` 是本地時間字串,`capturedAt` 是 `toISOString()` 的 UTC**,兩者不可直接比字串——
  差一個時區就會分成兩列、比新舊也會判反。換算只有一份:`series.js` 的 `effectiveTimeOf`,
  表格篩選、樞紐分列、`buildSeries` 的日期範圍都用它。
- `0`(預設)= 不合併,時刻相同才同列;正整數 N = 列鍵向下對齊到當日 00:00 起算的 N 分鐘倍數。
  **只從實際出現過的桶產生列**,空桶不成列。
- 同一任務落在同一列的多筆:取 `capturedAt` 最新的**成功**紀錄;一筆成功都沒有就是 `—`;
  儲存格 `title` 註明合併筆數。
- **不做鄰近群聚式的合併**:併哪幾筆會取決於掃描順序,新增一筆會改變既有列的歸屬,結果不穩定。
- `limit` 對樞紐表是「保留最新 N 列」,顯示順序仍由舊到新;**未設定時預設 50 列**
  (長區間的 interval 資料會有上千列)。

**資料變動時自動重繪**

- Report 開著的時候,抓取寫進紀錄會自動更新畫面(經 `shared/storage` 的 `subscribe`,§5)。
- **只重繪目前所在的頁籤**;儀表板在**編輯模式中不重繪**(會把拖曳打斷),離開編輯模式補繪一次。
- 設定頁不重繪(它沒有會被抓取改變的內容)。

**編輯體驗(讓使用者設定時好用)**

1. **在 Picker 就排好**:建立任務的最後一步「加入儀表板」——選儀表板、卡片型別(依模式給預設:
   單值:`text` 模式→`table`(`mode: recent`),其餘→**只有 `number`**;
   **2 個值以上→一張樞紐表(`mode:'pivot'`、`bucketMinutes:1440`、`showDelta:true`)+ 一張折線**,
   `number`/`gauge` 只取第一個值;一個值同時長出數值卡與折線卡會被當成重複)。
   存檔後卡片自動排到版面末端,使用者不必再去 Report 找。
   **`addCard` 會去重**:同一個儀表板內型別相同、來源集合相同(只比 `taskId`,與順序無關)的卡片
   不重複新增,直接回傳既有那張;`source` 為空的卡片(文字卡)不受限。所有呼叫端(Picker、拖曳、範本)同一規則。
   **標題可分辨**:沒有自訂標題時用來源名;同一儀表板內若前面已有同名但不同型別的卡片,
   顯示時補型別後綴(`數值`/`趨勢`/`長條`/`明細`/`量表`/`狀態`),但不寫回 `card.title`。
2. **編輯模式開關**:Report 右上「編輯版面」切換;開啟後卡片可拖曳移動、右下角拉大縮小、拖曳時顯示吸附格線與佔位陰影;
   關閉即瀏覽模式,不會誤動。
3. **卡片設定抽屜**:點卡片右上齒輪,右側滑出抽屜即時預覽:型別切換、來源任務(多選)、期間、聚合、標題、顏色、單位、小數位、閾值色。
   表格卡片另有列軸標頭、時間容差(0 / 5 / 10 / 15 / 30 / 60 分鐘 / **1440 = 每天一格**)、筆數上限、差異欄。
   來源清單兩層(任務 → 值,父層可全選/全不選),**已選的排在前面並照欄序**,每項附上下移動鈕改欄序;
   **清單上找不到的既有來源原樣保留在原本的欄位置**,不得靜默丟棄。
   所有變更立即套用到卡片,抽屜有「還原」。
   抽屜勾選與下面的拖曳是同一份資料(都寫 `card.source`),兩條路徑不可各存一份。
4. **一鍵排版**:「自動排列」依型別給合理寬度(number 3 欄、line 6 欄、table 12 欄)並填滿空隙;「套用範本」提供三種預設:
   「總覽」(上排 number、下排 line)、「單一指標深入」(大 line + gauge + table)、「多任務比較」(multi-line + 樞紐表)。範本產不出任何卡片時**不清空**既有版面並提示原因。
5. **多儀表板**:頁籤可新增、改名(空白名稱忽略、前後空白修掉)、排序、複製;每個獨立版面。
6. **復原/重做**:編輯模式內 ⌘Z / ⌘⇧Z,離開編輯模式清空。
7. **響應式**:視窗寬 < 900px 時自動疊成單欄(不改存檔版面)。
8. **版面持久化**:`storage.local.layout = {dashboards:[{id,name,cards:[]}]}`,隨設定匯出;任務刪除時其卡片一併移除。
9. **資料來源側欄與拖曳投放**(編輯模式才顯示,`#source-palette`):列出啟用中的任務,可搜尋,每項都是拖曳來源。
   多值任務底下列出每個值(`data-palette-series`),**可用把手 `data-palette-toggle` 收合**(三家銀行各六個值就是十八列);
   搜尋命中子項時它的父項一起顯示。
   拖曳一律走 `ui/report/dnd.js`(Pointer Events;命中判定用已註冊目標的矩形,不用 `elementFromPoint`——
   jsdom 沒有它,測不動;**上層目標不接受這個 payload 時要繼續往下找**,否則拖出移除放在別張卡片上會整個落空;
   矩形命中判定只有一份 `isPointInside`,其他模組一律用它)。拖曳要接 `pointercancel`(觸控被接管、視窗失焦時
   只會發它),並比對 `pointerId`(多點觸控時別根手指不可劫持)。
   投放後的結果由純函式 `ui/report/drop-rules.js` 決定,一律經 `layout-store` 寫入並推進復原堆疊;
   沒有造成改變的投放不佔用一步復原。

   | 目標 | 行為 |
   |---|---|
   | `table` | 依放開的 X 位置插入到對應欄之前(**只在樞紐表**算位置:最近 N 筆的表頭是固定四欄,與來源無關);已存在則搬移。表格一律接受投放,否則最後一欄拖不動 |
   | `line` / `bar` | 追加並去重;超過 8 條(`--chart-1~8`)拒絕並在 `#dnd-toast` 說明原因 |
   | `number` / `gauge` | 取代唯一來源;標題等於原任務名稱時跟著換,使用者自訂的標題不動 |
   | `status` | 加入任務篩選清單(`options.taskIds`),去重;移除路徑也要改這個欄位,不是 `source` |
   | `text` | 不接受 |
   | 空白格線 | 建新卡:`text` 模式的任務建 `table`(`mode: recent`),其餘建 `number`;**建在放開的格子**,該處被佔才由 `addCard` 找空位 |
   | 指標壓在不肯收的卡片上 | 什麼都不做,**不可在它底下偷偷長出新卡片** |
   | **拖整個多值任務**(payload 帶 `seriesIds`,走 `applyDropMany`) | 表格 / 折線 / 長條 → 全部值依序加入(折線加完超過 8 條**整批拒絕**);數字 / 計量 → 取第一個值並提示用了哪一個;狀態卡 → 以 `parentIdOf` 加入;空白格線 → 建含全部值的樞紐表(12×4) |

10. **趨勢浮層**(`ui/report/trend-popover.js`,**只在非編輯模式**):
    點樞紐表欄標或數值卡的值 → 浮層畫該序列在目前範圍的折線,附三個動作:
    「加入為折線卡」(經 `addCard`,去重規則同上)、「到歷史頁」(帶該序列的篩選)、
    「比較其他任務的同名值」(把其他父任務中 `shortName` 相同的序列加進同一張折線,總數上限 8)。
    再點一次、`Esc`、或點浮層以外的地方關閉;同時只存在一個。
    編輯模式下這兩處不得有點擊行為(留給拖曳與移除把手)。
11. **拖出移除**:編輯模式下,樞紐表的欄標與折線/長條的圖例各有一個移除把手(`data-remove-source`),
    拖到來源卡片矩形之外放開即移除該來源(放在別張卡片上也算);`status` 清單每一項也有;
    `number`/`gauge` 沒有把手(至少留一個來源)。把手的建法只有一份(`cards.js` 的 `makeRemoveHandle`)。
    樞紐表移除到零欄時**卡片保留**並顯示「拖進來」的空狀態(最近 N 筆模式的表頭是固定四欄,零來源時列出範圍內全部紀錄)。

### §8.3 歷史查詢(查過去任何一天的資料)

- 左側**月曆**:有紀錄的日期打點,點數量以顏色深淺表示,有失敗/告警的日期標紅角;點日期即顯示該日,拖曳可選連續範圍;
  月曆上方可切月、跳到任意年月。
- **位置定位抓到的紀錄**(§7 的 `label`)在該列的 `title` 顯示「來源列:…」,展開明細另有一行。
  沒有它的話,「今天早上網站還沒更新」與「抓錯列」在畫面上長得一模一樣。
- 右側依所選日期(或範圍)顯示紀錄;兩種表格模式切換:
  - **紀錄列表**:時間 / 任務 / 值 / 狀態 / 策略,欄位可排序、可隱藏,順序可拖曳;失敗列展開錯誤與 DOM 片段。
  - **樞紐表**:列 = 時間、欄 = **序列**(單值任務一欄,多值任務每個值一欄),一眼比對同一時刻的所有值;欄順序沿用「任務」頁的排序 × 值的順序。
    與儀表板表格卡片共用同一個 `pivot()`,但**不吃卡片選項**(列軸標頭、容差、列數上限是卡片層的設定)。
- 篩選:任務多選(**兩層**:父任務勾選 = 底下所有值一起勾,部分勾時父呈現 indeterminate;
  寫進狀態的一律是序列 id)、狀態(成功/失敗/late/fallback)、只看告警、值範圍(≥ / ≤)、關鍵字。
  網址狀態裡的序列 id 含保留字元,**必須逐一編碼**,否則網址會從那裡被截斷。
- 樞紐表與「與另一天比較」的欄集合是 `buildSeriesIndex` 的 `seriesIds`(不是任務 id),
  多值任務的紀錄才對得上欄。
- 範圍內摘要列:每任務的筆數、最大/最小/平均、首末值差;點任務名跳到只含該任務的折線(期間 = 目前範圍)。
- 單筆紀錄可展開:原文 `raw`、所用策略、錯誤與 DOM 片段、對應的排程時間 vs 實際時間。
- 「與另一天比較」:選第二個日期,樞紐表並排顯示兩天同時刻的值與差異。
- 表格設定(欄位、順序、模式 `tableMode`、篩選)記在 `settings.history`,隨設定匯出;
  URL hash 帶日期、篩選、值範圍、關鍵字、只看告警、分頁與比較日期,可加書籤或重新整理不丟狀態。
- 單筆紀錄展開後可**刪除該筆**(需確認;刪掉當天最後一筆時整個日期鍵一併移除)。
- 紀錄列表與樞紐表都可**複製為 TSV**(貼進試算表);瀏覽器沒有剪貼簿權限時該按鈕隱藏。
- 摘要列的任務名可點,點了在下方畫出該任務在目前範圍的折線(臨時圖表,不會存進版面)。
- 大量資料:一次只載入所選範圍;範圍超過 90 天時表格分頁(每頁 500 筆暫定),摘要仍算全範圍。

### §8.4 任務頁

- 所有任務清單(拖曳排序,此順序是全域預設順序;也是樞紐表的欄序)、啟用開關、下次執行時間、
  最後狀態、**連續失敗次數**與最後錯誤(hover 顯示)、快速動作(立即抓取、編輯、複製、刪除、重新選取)。
- 搜尋框(比對名稱與網址)與「只看失敗」勾選。
- 編輯開同一個 Picker 表單(`picker.html?taskId=<id>`,帶入現值;沒有目標分頁時隱藏「立即測試」)。
- **複製任務**:新 id、名稱加「(副本)」、**預設停用**、不自動加入儀表板。
- **刪除保護**:對話框顯示「將一併刪除 N 筆紀錄」,並提供「先匯出再刪除」(先下載 CSV 成功才刪)。
- **錯過清單橫幅**:列在清單上方,可逐筆勾選補抓或略過(`CATCH_UP_ONE` / `SKIP_ONE`)。
- **重新選取**:開啟該任務的目標頁、等載入完成、注入後直接進入選取模式(§2);
  background 自己從任務組出 `locator` 與 `preselect`(多值走 `spec.fields`,單值走 `spec.block`)帶進 `ENTER_PICK`,
  新分頁沒有「上次右鍵的元素」可靠。啟動失敗才提示改用右鍵選單。
- 下次執行時間一律向 background 詢問(`GET_NEXT_RUNS`),UI 不自行解析 alarm 名稱
  (預檢與重試 alarm 必須排除)。
- 排程欄的文字走 `shared/describe.js` 的 `describeSchedule`(與 Picker 摘要卡、儲存回饋同一份),
  所以 interval 的**時段與星期都看得到**(「08:30～09:20 之間每 10 分鐘,週一～五」),
  不再只寫「每 15 分鐘」。

### §8.5 設定頁

- 匯出:日期範圍 + 格式(JSON / CSV / **獨立 HTML 報表**:單一 .html 內嵌資料與目前儀表板版面,離線可開、可寄給別人)。
- 設定匯出 / 匯入(§5)、歷史匯入(多個日檔 JSON,以 `taskId + capturedAt` 去重)。
- **儲存用量**:目前位元組、紀錄總筆數、最舊日期、上次設定匯出與上次紀錄匯出的時間。
- **排程健康**:每任務下次觸發時間、看門狗最近一次巡檢(取自診斷紀錄)、最近 20 筆診斷、立即自檢。
- **隱私與權限說明**:固定說明不連任何伺服器、資料只在本機,並逐一說明每個權限的用途。
- 站台登入管理(§6):列出每個站台的 origin、帳號、啟用狀態、連續失敗次數、最近一次檢查結果;
  可停用 / 重新啟用(重新啟用會把 `failStreak` 歸零)/ 刪除。頂部固定顯示密碼保護的限度。
  **新增站台**走右鍵「設定此站台登入」開的獨立視窗(`ui/site/site.html`)。
- 偏好:保留天數、通知開關、預設額外等待秒數、**同一告警的通知間隔(分鐘,預設 60)**、**每日站台登入檢查時間(預設 08:00)**、深色模式(跟隨系統 / 亮 / 暗)。

### §8.6 圖表

- 純 SVG 自繪,不引外部圖表庫;hover 顯示值與時間;缺值(失敗)以斷線呈現,不補 0;所有色彩取自 `ui/theme.css` 變數。

## §9 權限(manifest)

`contextMenus`, `alarms`, `storage`, `unlimitedStorage`, `tabs`, `scripting`、`sidePanel`(設定面板), `notifications`, `downloads`,
`host_permissions: ["<all_urls>"]`(或改為 `optional_host_permissions` 於首次設定任務時逐站授權,見 BACKLOG)。
`downloads` 為 JSON 匯出所需;`notifications` 為失敗/告警/補抓詢問所需;
`unlimitedStorage` 讓歷史紀錄不受 `storage.local` 預設 10MB 上限限制(保留天數預設 365 天很容易超過)。
另設 `options_page: "ui/report/report.html"`,可從 `chrome://extensions` 的擴充功能選項開啟報表。

`web_accessible_resources`(`content/*.js`、`shared/*.js`,`matches: ["<all_urls>"]`)是**必要的**:
content script 是 ES module,`executeScript({files})` 以傳統 script 注入會拋
`Cannot use import statement outside a module`,注入必須改成 `executeScript({func: (url) => import(url)})`,
而動態 import 只能讀 web accessible 的資源。代價是網頁可以探測本擴充功能是否安裝(列 BACKLOG)。

跨網域 iframe 的注入靠既有的 `host_permissions: ["<all_urls>"]`,**不需要新權限**;
列出分頁裡有哪些 frame 也**不需要 `webNavigation`**——`executeScript` 的 `allFrames: true`
回傳的每一項就帶 `frameId`。注意 `matchOriginAsFallback` **不是** `executeScript` 的屬性
(它只用於 `registerContentScripts` 與 manifest 的 `content_scripts`)。

`icons`(16/32/48/128)與 `action.default_icon` 為必填:通知的 `iconUrl` 只要載不到,
Chrome 會讓**整則通知不顯示**。且 `iconUrl` **必須用 `chrome.runtime.getURL()` 取絕對網址**——
相對路徑會相對於呼叫端的位址解析(service worker 是 `/background/`),在真實瀏覽器一律 404。
所有通知走 `background/notify.js` 這個唯一入口,它同時負責遵守 `settings.notifications` 偏好。

## §10 告警

- 任務可設多條條件(`task.alerts`,每條 `{id, type, value, enabled, field?}`;
  `field` 是值的 `key`,只對該值評估,缺省則對每個值各自評估):
  `gt` / `lt` / `eq`(值大於 / 小於 / 等於)、`deltaPct`(相較**前一筆成功紀錄**變動超過 X%,
  漲跌都算)、`failStreak`(連續 N 次非成功)。判定是純函式 `shared/alerts.js`。
- 評估時機在**寫入紀錄之前**,命中就把 `alert: true` 與 `alertHits: [alertId…]` 一起寫進同一筆紀錄
  (避免報表讀到「紀錄有了、旗標還沒有」的中間態);演練(dryRun)不評估。
- 觸發時發通知;**同一條件 60 分鐘內只通知一次**(`settings.alertCooldownMin` 可調),
  但紀錄一律標記——去重只針對通知。點通知會開報表並定位到該任務那一天。
- Report:月曆對有告警的日期上色(與失敗分開)、歷史列標記並可展開看到命中哪一條、
  「只看告警」可篩選;number 卡片沿用既有的閾值色機制,不另加一套顏色規則。
- `deltaPct` 找不到前一筆成功紀錄、或前一筆是 0 時不命中(除以 0 沒有意義)。
- **多值任務**:去重紀錄(`alertLog`)與通知 id 都用**子序列 id**,兩個值才不會互相把通知吃掉;
  `prevRecords` 也用子序列精確比對——用父任務比對會讓「買入」拿「賣出」的舊值算變動比例。
  通知與訊息裡的名稱用序列名(「臺銀匯率 · 美金賣出」)。

## §11 數值擷取策略與後處理(number 模式)

> `strategyUsed` 記的是這一筆值是怎麼來的:數值策略鏈的四種、區塊聚合的 `block`、單一儲存格的 `cell`。

- 擷取來源(策略鏈,使用者在 Picker 選主策略,其餘為自動備援;紀錄寫入 `strategy_used`):
  1. `auto`:取元素 `innerText` 中第一個數字(預設)。
  2. `regex`:使用者給正則,取第一個群組(如從「餘額:1,234 元」取 `([\d,\.]+)`)。
  3. `attr`:取指定屬性(`value`、`data-*`、`title`、`aria-label`)——SPA 常把精確值放屬性、畫面顯示四捨五入。
  4. `child`:元素內指定子節點(以相對 CSS 選擇器)。
  5. `label`:相鄰標籤錨定——找含指定文字的元素,取其右側/下方第一個含數字的元素(表格「項目 | 值」最常見)。
  - 主策略失敗時依 1→5 順序試其他策略,成功則紀錄標 `status: "fallback"` 並在 Report 提示。
  - 全部失敗或解析不出數字(如顯示「--」)→ `status: "parse_error"`,保留原文 `raw`,**不寫 0**。
- 後處理:乘數(單位換算)、小數位數。
- Picker 內「立即測試」按鈕:用目前設定對當前頁面實抓一次並顯示結果與所用策略,存檔前就能確認抓得到。

## §12 工具列圖示燈號與 popup

### §12.1 燈號(`chrome.action`)

- 圖示右下角以 badge 顏色 + 圖示變體呈現整體狀態,取所有啟用任務中**最嚴重**者:

| 燈號 | 條件 | badge |
|---|---|---|
| 🟢 正常 | 所有任務最近一次抓取/預檢成功,alarms 齊全 | 無 badge(或綠點圖示) |
| 🟡 注意 | 有 `fallback` / `late` / `partial`;或有錯過清單待處理;或看門狗補建過 alarm | 黃底,數字 = 注意事項數 |
| 🔴 異常 | 預檢失敗(`login_failed` / `selector_lost` / `parse_error`)、重試用盡、站台自動登入被停用、連續 3 次失敗 | 紅底,數字 = 異常任務數 |
| ⚪ 停用 | 沒有啟用中的任務,或使用者按「全部暫停」 | 灰底「II」 |

- 狀態由 background 的 `health` 匯總;任何 run / 預檢 / 看門狗結束都重算並 `setBadgeText` / `setBadgeBackgroundColor` / `setIcon`。
- 使用者在 popup 或 Report 看過該項(點開)即標已讀,黃/紅計數減少;問題真正解決(下次成功)才回綠。
- **每抓一次就寫一次 health**(單值在 `writeRecord`、多值在整組寫完之後,兩處都呼叫同一個純函式
  `fetcher.js` 的 `healthFromRecords`——**狀態的算法只有那一份**),對應表由
  `shared/record-status.js` 的 `healthStatusOf` 提供,`background/health.js` 的紅/黃集合也引用同一份,
  不得各自維護:

  | 紀錄 status | health status | 燈號 |
  |---|---|---|
  | `ok` | `ok` | 綠 |
  | `fallback` / `late` / `partial` | 同名 | 黃 |
  | `not_found` | `selector_lost` | 紅 |
  | `parse_error` / `login_failed` | 同名 | 紅 |
  | `error` | `failed` | 紅 |

  **抓取成功會把 health 寫回 `ok`**:曾經失敗過的任務不會再永遠停在紅燈。
  health 寫在**父任務 id** 上,卡片以子序列 id 當來源時要先取父 id 才查得到。
- `setIcon` 的圖示變體還沒接(見 BACKLOG)。
- 圖示 `title`(滑鼠停留)顯示一行摘要:「2 個任務異常:A 無法登入、B 找不到元素」。

### §12.2 popup

- 點擊圖示:上方燈號摘要;任務清單(名稱、最後值、狀態圖示、下次執行);
  異常項目有「立即重試」「開啟頁面」(開目標 URL 讓使用者自己處理,例如手動登入或看網站改版);
  底部「全部暫停 / 恢復」、「開啟 Report」。
- popup 只讀 storage 與發訊息,不做抓取。
- **最上方是主要入口 `#pick-here`「在這個頁面選取」**:查目前分頁,送
  `ENTER_PICK{purpose:'task', tabId, frameId: 0}`,成功即關閉 popup。
  不是 `http`/`https` 的頁面(擴充功能頁、`chrome://`)顯示 `#pick-here-note`
  「這個頁面無法選取,請切換到一般網頁再試」,**不得靜靜失敗**。
  右鍵選單仍在,但使用者不必知道它存在才用得起來——只寫一句「去網頁上按右鍵」,
  沒有人會發現那個選單。

## §13 瀏覽器相容(Chrome + Edge)

- Edge 為 Chromium 核心,`chrome.*` 命名空間與 MV3 API 相同;**同一份程式碼、同一個 manifest**,不分版本。
- 只用 §9 列出的 API,不用 Chrome 專屬或實驗性 API(`offscreen`、`declarativeNetRequest` 等一律不引入)。
  **`sidePanel` 是例外且已引入**(AF-10):Edge 官方 API 支援表列它為 MV3 支援,不是 Chrome 專屬;
  沒有它的舊版仍有彈出視窗的退路。
- Edge 特有行為與對策:

| Edge 機制 | 影響 | 對策 |
|---|---|---|
| 睡眠索引標籤(Sleeping Tabs,預設 2 小時,可設 5 分鐘) | 背景分頁被卸載比 Chrome 積極 | 自開分頁 `autoDiscardable:false`;既有分頁若 `discarded` 先 reload(§4.1 已涵蓋) |
| 效率模式(Efficiency mode) | 背景 JS 節流更重 | 載入等待上限與擷取逾時已放寬;預檢(§4.2)會提早暴露問題 |
| 啟動加速(Startup boost)/ 關閉視窗後仍在背景執行 | 無視窗狀態更常見 | §4.1「沒有任何視窗」對策 |
| `edge://extensions` 載入未封裝 | 路徑不同 | README 兩個瀏覽器的安裝步驟都寫 |
| Edge Add-ons 商店獨立審核 | 上架要分別送 | BACKLOG |
| `chrome.sidePanel` | Edge 官方 API 支援表列為 MV3 支援(Windows/Linux/Mac),另有 sidebar 開發指南 | 同一份程式碼;`sidePanel` 需 114+,`close()` 需 141+、`onClosed` 需 142+,兩者都有退路(停用該分頁的面板／停在「已儲存」畫面) |
| 沒有 `chrome.sidePanel`(114 以下) | 設定畫面開不起來 | `shared/panel.js` 退回原本的彈出視窗,並記 `panel_fallback` 診斷 |

- 驗收:Puppeteer 煙霧腳本以環境變數 `BROWSER_PATH` 指定執行檔,CI/本機各跑一次 Chrome 與 Edge(未安裝 Edge 時自動略過並標示)。
- 使用者可見差異只有一處:設定頁「排程健康」顯示目前瀏覽器名稱與版本(`navigator.userAgentData`)。
