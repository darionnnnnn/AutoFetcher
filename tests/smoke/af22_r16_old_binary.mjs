// R16 browser check: exact 0.20.0 source from origin/dev must refuse schema 4 settings.
// Uses Chrome for Testing, a temporary unpacked old extension and an isolated profile.
// Run: node tests/smoke/af22_r16_old_binary.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tempRoot = await mkdtemp(join(os.tmpdir(), 'af22-r16-old-binary-'))
const archive = join(tempRoot, 'origin-dev.tar')
const extracted = join(tempRoot, 'old-tree')
const profile = join(tempRoot, 'chrome-profile')
const extension = join(extracted, 'src')
const browserPath = process.env.BROWSER_PATH || join(os.tmpdir(), 'af22-cft/chrome/win64-154.0.8037.57/chrome-win64/chrome.exe')
const settingsFile = process.env.R16_SETTINGS_FILE || join(repo, '.local-backups/af22-r16-settings-fixture.json')
let browser

try {
  const archiveBytes = execFileSync('git', ['archive', '--format=tar', 'origin/dev'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
  await writeFile(archive, archiveBytes)
  await mkdir(extracted)
  execFileSync('tar', ['-xf', archive, '-C', extracted])

  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'))
  const storageSource = await readFile(join(extension, 'shared/storage.js'), 'utf8')
  assert.equal(manifest.version, '0.20.0')
  assert.match(storageSource, /SCHEMA_VERSION\s*=\s*3/)
  const newer = JSON.parse(await readFile(settingsFile, 'utf8'))
  assert.equal(newer.data.schemaVersion, 4, 'input file must be a real current-format export')

  browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: 'new',
    userDataDir: profile,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  })
  const worker = await browser.waitForTarget(
    target => target.type() === 'service_worker' && target.url().endsWith('/background/main.js'),
    { timeout: 25000 }
  )
  const extensionId = new URL(worker.url()).host
  const page = await browser.newPage()
  await page.goto(`chrome-extension://${extensionId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#tab-settings')
  await page.click('#tab-settings')
  await page.waitForSelector('#settings-import-file')

  const before = await page.evaluate(() => chrome.storage.local.get(null))
  await (await page.$('#settings-import-file')).uploadFile(settingsFile)
  await page.waitForFunction(() => /較新|先更新 AutoFetcher/.test(document.getElementById('settings-import-result')?.textContent || ''), { timeout: 10000 })
  const message = await page.$eval('#settings-import-result', el => el.textContent)
  const after = await page.evaluate(() => chrome.storage.local.get(null))
  assert.match(message, /較新/, `old settings importer should explain rejection: ${message}`)
  assert.deepEqual(after, before, 'newer-schema rejection must leave old profile storage unchanged')
  console.log(`PASS: Chrome for Testing loaded origin/dev AutoFetcher ${manifest.version} (schema 3), rejected schema 4 settings with zero storage changes (${extensionId})`)
} finally {
  if (browser) await browser.close()
  const root = resolve(os.tmpdir())
  const target = resolve(tempRoot)
  if (target.startsWith(root + '\\') && basename(target).startsWith('af22-r16-old-binary-')) {
    await rm(target, { recursive: true, force: true })
  }
}
