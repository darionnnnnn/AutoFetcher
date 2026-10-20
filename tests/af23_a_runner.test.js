import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { findBrowser } from './smoke/browser-path.mjs'
import { runSmoke, SUITES } from './smoke/run.mjs'

test('AC-A1 runner 包含核心與完整群組流程，子程序失敗不得假綠', () => {
  assert.deepEqual(SUITES, ["load.mjs","af23_release.mjs","af23_flows.mjs","af23_sources.mjs","af23_edit_flow.mjs","af23_d_route_flow.mjs","af23_journeys.mjs","af23_privacy.mjs","af23_d4_picker_lifecycle.mjs","af23_c3_c4_c6_browser.mjs","af23_preview_repair_seams.mjs","af23_prune_undo.mjs","af23_t06_inflight_scheduler.mjs","af23_c6_pending_browser.mjs"])
  const seen = []
  const status = runSmoke({ browserPath: '/fixture/browser', run: (exe, args, options) => {
    seen.push(args[0])
    assert.equal(options.env.BROWSER_PATH, '/fixture/browser')
    return { status: seen.length === 2 ? 7 : 0 }
  } })
  assert.equal(status, 7)
  assert.equal(seen.length, 2)
  assert.equal(runSmoke({ browserPath: '/fixture/browser', run: () => ({ signal: 'SIGTERM', status: null }) }), 1)
})

test('AC-A1 路徑優先明確指定；各平台 CfT cache 可發現；缺檔失敗', () => {
  const root = mkdtempSync(join(tmpdir(), 'af23-browser-'))
  try {
    assert.throws(() => findBrowser({}, root), /找不到/)
    for (const suffix of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-win64/chrome.exe', 'chrome-linux64/chrome'
    ]) {
      const file = join(root, '.browsers/chrome/build', suffix)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '')
      assert.equal(findBrowser({}, root), file)
      assert.equal(findBrowser({ BROWSER_PATH: file }, root), file)
      rmSync(join(root, '.browsers'), { recursive: true })
    }
    assert.throws(() => findBrowser({ BROWSER_PATH: join(root, 'missing') }, root), /不存在/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
