// AutoFetcher 診斷紀錄環形緩衝（SPEC §4.1）

const MAX_ENTRIES = 500

// 取得所有診斷紀錄（舊到新），無資料時回傳空陣列
export async function getAll() {
  const res = await chrome.storage.local.get('diag')
  return Array.isArray(res.diag) ? res.diag : []
}

// 寫入單筆診斷紀錄，超過 500 筆時丟掉最舊的
export async function log(kind, detail) {
  const list = await getAll()
  const entry = { at: Date.now(), kind, detail }
  list.push(entry)
  const trimmed = list.length > MAX_ENTRIES ? list.slice(list.length - MAX_ENTRIES) : list
  await chrome.storage.local.set({ diag: trimmed })
  return entry
}

// 清空所有診斷紀錄
export async function clear() {
  await chrome.storage.local.set({ diag: [] })
}
