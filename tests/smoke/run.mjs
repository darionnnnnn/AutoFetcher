import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBrowser, ROOT } from './browser-path.mjs'

export const SUITES = ['load.mjs', 'af22_g1_group_flow.mjs']

export function runSmoke({ browserPath = findBrowser(), run = spawnSync, suites = SUITES } = {}) {
  for (const suite of suites) {
    console.log(`[smoke] ${suite}`)
    const result = run(process.execPath, [resolve(ROOT, 'tests/smoke', suite)], {
      cwd: ROOT, env: { ...process.env, BROWSER_PATH: browserPath }, stdio: 'inherit'
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
