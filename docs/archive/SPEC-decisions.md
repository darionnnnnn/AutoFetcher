# SPEC 搬出的決策紀錄與探針事實

> 從 `docs/SPEC.md` 搬出來的「為什麼這樣定」與一次性實驗紀錄;現況規格以 SPEC 為準。

## §4 專用視窗的探針事實(AF-20)(AF-21 自 SPEC 搬出)

- **專用視窗的探針事實**(AF-20,Chrome for Testing 152 / Windows 11,已拿掉 puppeteer 預設的關閉節流旗標——帶著它們量到的可見性與計時器全都不可信):

  | 做法 | 焦點 | 結果 |
  |---|---|---|
  | `windows.create({ state:'minimized' })` | 不搶 | 頁面 viewport **0×0**(RWD 站台會切成手機版、虛擬捲動表格渲染 0 列);之後改尺寸、重載、導覽都救不回來 |
  | `state:'minimized'` ＋ `focused:false` | 不搶 | **靜默變成一般視窗**,沒有最小化 |
  | `state:'minimized'` ＋ `type:'popup'` | **搶焦點** | — |
  | 先不聚焦帶尺寸建立,再最小化 | 不搶,零 `onFocusChanged` | viewport 保住;頁面 `hidden`、計時器節流,與背景分頁完全相同 |
  | 已最小化的視窗裡再 `tabs.create` | 不搶 | 新開的**作用中**分頁 viewport **0×0**,在它之後開的背景分頁也是(只開背景分頁時保得住,但不依賴這個順序)→ 同佇列的下一個任務一律在同一個分頁**導覽**(`tabs.update({url})`) |
  | 畫面外座標 `left:-2000` | — | API 直接拒絕(至少 50% 要在可見範圍) |

  探針腳本:`tests/smoke/probe_fetch_window.mjs`(不進 `npm test`;可見性一欄會隨視窗有沒有被遮住而變,viewport 與視窗狀態兩欄是穩定的)。
  量不到的:建立到最小化之間(約 100~300 毫秒)肉眼看不看得到;Edge 未實測(本機 puppeteer 啟動不了 Edge)。
