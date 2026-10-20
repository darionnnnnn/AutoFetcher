import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBrowser, ROOT } from './browser-path.mjs'

export const SUITES = ["load.mjs","af23_release.mjs","af23_flows.mjs","af23_sources.mjs","af23_edit_flow.mjs","af23_d_route_flow.mjs","af23_journeys.mjs","af23_privacy.mjs","af23_d4_picker_lifecycle.mjs","af23_c3_c4_c6_browser.mjs","af23_preview_repair_seams.mjs","af23_prune_undo.mjs","af23_t06_inflight_scheduler.mjs","af23_c6_pending_browser.mjs"]

export function runSmoke({ browserPath = findBrowser(), run = spawnSync, suites = SUITES } = {}) {
  const env = { ...process.env, BROWSER_PATH: browserPath }
  // Full acceptance always tests this checkout and every functional case.
  for (const key of ['AF23_CASES', 'AF23_QA_SRC', 'AF23_EXTENSION_PATH', 'AF23_D4_SRC', 'AF23_UPGRADE_PROFILE']) delete env[key]
  for (const suite of suites) {
    console.log(`[smoke] ${suite}`)
    const result = run(process.execPath, [resolve(ROOT, 'tests/smoke', suite)], {
      cwd: ROOT, env, stdio: 'inherit'
    })
    if (result.error || result.signal || result.status !== 0) {
      console.error(`[smoke] ${suite} failed: ${result.error?.message || result.signal || result.status}`)
      return result.status || 1
    }
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runSmoke() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
