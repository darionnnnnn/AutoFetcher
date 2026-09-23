// Reproducible G1 mutation checks. Each edit is temporary, restored from the
// original bytes (not git), hash-checked, and followed by a green test run.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const cases = [
  {
    label: 'source identity', file: 'src/shared/field-match.js',
    before: 'return json(left) === json(right)', after: 'return true',
    test: 'tests/af22_b2_identity.test.js', pattern: '相同表座標'
  },
  {
    label: 'stale frame message rejection', file: 'src/background/main.js',
    before: 'activeFrame.frameId !== (sender?.frameId ?? 0)', after: 'false',
    test: 'tests/af22_c2a_frames.test.js', pattern: '目的 frame 成為唯一作用層'
  },
  {
    label: 'completion button action', file: 'src/ui/picker/picker.js',
    before: "finish?.addEventListener('click', async () => {", after: "finish?.addEventListener('click', async () => { return;",
    test: 'tests/af22_d1a_picker.test.js', pattern: '完成前等待最後名稱 ACK'
  },
  {
    label: 'partial outcome', file: 'src/background/main.js',
    before: "successes > 0 ? 'partial' : 'failed'", after: "successes > 0 ? 'done' : 'failed'",
    test: 'tests/af22_r11_outcomes.test.js', pattern: 'RUN_TASK 真實 handler 回報部分失敗'
  },
  {
    label: 'manual group name priority', file: 'src/background/main.js',
    before: "typeof group.name === 'string' && group.name.trim() ? group.name : `值 ${index + 1}`",
    after: '`值 ${index + 1}`', test: 'tests/af22_f1b_batch.test.js', pattern: '兩組多來源完成 snapshot'
  },
  {
    label: 'same-metric key continuity', file: 'src/background/main.js',
    before: "if (grant.repairMode === 'replace') {", after: "if (grant.repairMode === 'repair') {",
    test: 'tests/af22_r18_field_repair.test.js', pattern: 'same-value repair updates only'
  }
]

function run(testFile, pattern) {
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, testFile], {
    cwd: root, encoding: 'utf8', timeout: 120_000
  })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` }
}

for (const item of cases) {
  const target = path.join(root, item.file)
  const original = await readFile(target)
  const source = original.toString('utf8')
  const occurrences = source.split(item.before).length - 1
  if (occurrences !== 1) throw new Error(`${item.label}: expected one mutation anchor, found ${occurrences}`)
  const mutant = Buffer.from(source.replace(item.before, item.after), 'utf8')
  const originalHash = hash(original)
  let red
  try {
    await writeFile(target, mutant)
    red = run(item.test, item.pattern)
    if (red.status === 0) throw new Error(`${item.label}: mutant survived (${item.test})`)
    if (!/# fail [1-9]\d*/.test(red.output) || !/not ok \d+ -/.test(red.output)) {
      throw new Error(`${item.label}: runner failed without a test assertion failure\n${red.output.slice(-3000)}`)
    }
  } finally {
    await writeFile(target, original)
    const restored = await readFile(target)
    if (!restored.equals(original) || hash(restored) !== originalHash) {
      throw new Error(`${item.label}: restoration was not byte-identical`)
    }
  }
  const green = run(item.test, item.pattern)
  if (green.status !== 0) throw new Error(`${item.label}: restored test failed\n${green.output.slice(-3000)}`)
  const summary = ['# pass', '# fail', '# skipped']
    .map(label => green.output.match(new RegExp(`${label} (\\d+)`))?.[0] || `${label} ?`)
    .join(', ')
  console.log(`RED ${item.label}: ${item.test} (exit ${red.status})`)
  console.log(`RESTORED ${item.file}: byte-identical sha256=${originalHash}`)
  console.log(`GREEN ${item.label}: ${summary}`)
}
