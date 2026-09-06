# 任務:實作站台密碼的加解密(AES-GCM)

## 背景

AutoFetcher 是 Chrome 擴充功能(原生 JS ES module)。使用者可以設定站台的自動登入,
密碼需要存在 `chrome.storage.local`。SPEC §6 規定:密碼以 WebCrypto AES-GCM 加密,
金鑰存在同一個 storage —— **這只防誤讀(例如匯出檔案、翻看 storage),不防同機惡意程式**,
設定頁會明白告知使用者這個限制。

`src/shared/settings-io.js` 已經有一組用**密語(passphrase)**派生金鑰的加解密,
那是「匯出設定檔」用的,與這裡不同:這裡用的是**本機自動產生的隨機金鑰**,
沒有使用者輸入。兩者不共用,**不要去改 settings-io.js**。

執行環境同時包含 service worker 與擴充功能頁面,兩邊都有 `crypto.subtle` 與
`chrome.storage.local`,可以直接用。

## 要做的事

在 `src/shared/crypto.js` 匯出兩個函式:

```js
export async function encryptSecret(plain)   // 回 { iv, ct }
export async function decryptSecret(enc)     // 回原本的字串
```

金鑰管理:

- 金鑰存在 `chrome.storage.local` 的 `cryptoKey` 鍵。
- 加密時若還沒有金鑰,就產生一把新的 **AES-GCM 256-bit** 金鑰,
  用 `crypto.subtle.exportKey('raw', ...)` 匯出後存起來(存成一般陣列或 base64 字串都可以,
  但要能原樣讀回來重建金鑰)。已經有金鑰就**沿用**,不要每次換。
- 解密時讀出金鑰重建;**沒有金鑰時要明確失敗**(讓 `decryptSecret` 回傳的 Promise reject),
  不要回空字串或 null。

加解密:

- 每次加密都要用 `crypto.getRandomValues` 產生**新的隨機 iv**(12 bytes),
  所以同一個明文兩次加密的結果必須不同。
- `encryptSecret` 回傳的物件 `{ iv, ct }` 必須是**可以直接 JSON 序列化**的
  (存進 storage 要能存、讀得回來),而且 **JSON 之後不得出現明文**。
- `decryptSecret` 對**被竄改過的密文**必須失敗(AES-GCM 本身就會驗證,
  只要不要把錯誤吞掉即可)。
- 空字串與中文都要能正確往返。

## 不要做的事

- 不要修改 `src/shared/settings-io.js` 或任何其他既有檔案。
- 不要做密語(passphrase)派生——這裡沒有使用者輸入。
- 不要新增其他匯出的函式。
- 不要加「舊格式相容」「多把金鑰輪替」之類規格沒要求的東西。

## 限制

- 只能修改:`src/shared/crypto.js`
- 原生 JS ES module,不要 import 任何東西,不要用任何套件(WebCrypto 是全域的)。
- 不要新增可選參數或 `= null` 的相依。
- 嚴格禁止過度設計:不要加設定項、不要加快取層、不要加金鑰版本號。
- 錯誤不要用 try/catch 吞掉——解不開就是要讓呼叫端知道。
- 註解用繁體中文全形標點,每個函式上方一行說明。
