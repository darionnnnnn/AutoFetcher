// AF-21 批次 3 定案 5：匯出改 Blob object URL；下載完成／中斷或逾時後才 revoke
// （另存視窗開著時提早 revoke 會讓下載失敗；data: URL 大範圍匯出會超過長度上限）
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveObjectURL } from 'node:buffer'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const ex = await import('../src/shared/export.js?t=' + Math.random())
  const revoked = []
  const orig = URL.revokeObjectURL
  URL.revokeObjectURL = (u) => { revoked.push(u); return orig.call(URL, u) }
  const restore = () => { URL.revokeObjectURL = orig }
  return { c, ex, revoked, restore }
}

const FIVE_MB = 'x'.repeat(5 * 1024 * 1024)
const wait = (ms) => new Promise(r => setTimeout(r, ms))

test('5MB 內容以 blob: URL 下載；complete 之前不 revoke、之後 revoke', async () => {
  const { c, ex, revoked, restore } = await fresh()
  try {
    const id = await ex.download({ filename: 'AutoFetcher/big.json', content: FIVE_MB })
    const call = c.__calls.find(x => x.api === 'downloads.download')
    assert.ok(call, '要呼叫 downloads.download')
    const url = call.args[0].url
    assert.ok(String(url).startsWith('blob:'), `url 要是 blob:，實得 ${String(url).slice(0, 30)}`)
    assert.equal(call.args[0].saveAs, true)
    assert.equal(call.args[0].filename, 'AutoFetcher/big.json')
    // 內容完整、沒有 encodeURIComponent 膨脹
    const blob = resolveObjectURL(url)
    assert.ok(blob, 'object URL 要還有效')
    assert.equal(blob.size, FIVE_MB.length)
    assert.equal(blob.type, 'application/json')

    // 另存視窗開著（in_progress）、別的下載完成：都不得 revoke
    c.__emitDownloadChanged({ id, state: { previous: undefined, current: 'in_progress' } })
    c.__emitDownloadChanged({ id: id + 100, state: { previous: 'in_progress', current: 'complete' } })
    c.__emitDownloadChanged({ id, filename: { current: 'C:/x/big.json' } })
    assert.deepEqual(revoked, [], '下載完成之前不得 revoke')
    assert.ok(resolveObjectURL(url), 'complete 之前 object URL 仍可讀')

    c.__emitDownloadChanged({ id, state: { previous: 'in_progress', current: 'complete' } })
    assert.deepEqual(revoked, [url], 'complete 之後要 revoke 那一個 URL')
    assert.equal(resolveObjectURL(url), undefined)
    // 再來一次狀態事件不得重複 revoke
    c.__emitDownloadChanged({ id, state: { previous: 'complete', current: 'complete' } })
    assert.equal(revoked.length, 1)
  } finally { restore() }
})

test('下載中斷（interrupted）也 revoke', async () => {
  const { c, ex, revoked, restore } = await fresh()
  try {
    const id = await ex.download({ filename: 'a.csv', content: 'a,b\n' })
    const url = c.__calls.find(x => x.api === 'downloads.download').args[0].url
    assert.equal(resolveObjectURL(url).type, 'text/csv')
    assert.deepEqual(revoked, [])
    c.__emitDownloadChanged({ id, state: { previous: 'in_progress', current: 'interrupted' } })
    assert.deepEqual(revoked, [url])
  } finally { restore() }
})

test('沒有狀態事件時逾時後 revoke（參數縮短等待）', async () => {
  const { c, ex, revoked, restore } = await fresh()
  try {
    await ex.download({ filename: 'a.json', content: '{}' }, { revokeAfterMs: 30 })
    const url = c.__calls.find(x => x.api === 'downloads.download').args[0].url
    await wait(5)
    assert.deepEqual(revoked, [], '逾時前不得 revoke')
    await wait(80)
    assert.deepEqual(revoked, [url], '逾時後要 revoke')
    assert.equal(c.downloads.onChanged._listeners.size, 0, '監聽要一起拿掉')
  } finally { restore() }
})

test('預設逾時是 60 秒：59 秒時未 revoke、60 秒時 revoke（假計時）', async (t) => {
  const { c, ex, revoked, restore } = await fresh()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await ex.download({ filename: 'a.json', content: '{}' })
    const url = c.__calls.find(x => x.api === 'downloads.download').args[0].url
    t.mock.timers.tick(59000)
    assert.deepEqual(revoked, [])
    t.mock.timers.tick(1000)
    assert.deepEqual(revoked, [url])
  } finally { t.mock.timers.reset(); restore() }
})

test('complete 先到就不再等逾時，監聽也拿掉；downloads.download 失敗時立即 revoke 並往外丟', async () => {
  const { c, ex, revoked, restore } = await fresh()
  try {
    const id = await ex.download({ filename: 'a.json', content: '{}' }, { revokeAfterMs: 30 })
    c.__emitDownloadChanged({ id, state: { current: 'complete' } })
    assert.equal(revoked.length, 1)
    assert.equal(c.downloads.onChanged._listeners.size, 0)
    await wait(60)
    assert.equal(revoked.length, 1, '逾時不得再 revoke 一次')

    const orig = chrome.downloads.download
    chrome.downloads.download = async () => { throw new Error('Download canceled by the user') }
    try {
      await assert.rejects(() => ex.download({ filename: 'b.json', content: '{}' }), /canceled/)
    } finally { chrome.downloads.download = orig }
    assert.equal(revoked.length, 2, '下載沒送出就不必留著 object URL')
  } finally { restore() }
})
