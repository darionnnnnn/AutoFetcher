import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function findBrowser(env = process.env, root = ROOT) {
  if (env.BROWSER_PATH) {
    const supplied = resolve(env.BROWSER_PATH)
    if (!existsSync(supplied)) throw new Error(`BROWSER_PATH 不存在：${supplied}`)
    return supplied
  }
  const cache = join(root, '.browsers/chrome')
  const builds = existsSync(cache) ? readdirSync(cache).sort().reverse() : []
  const suffixes = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-win64/chrome.exe', 'chrome-win32/chrome.exe', 'chrome-linux64/chrome'
  ]
  for (const build of builds) {
    for (const suffix of suffixes) {
      const candidate = join(cache, build, suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('找不到 Chrome for Testing；請設定 BROWSER_PATH，或安裝至 .browsers。')
}
