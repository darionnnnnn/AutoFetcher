#!/usr/bin/env node
// Offline gate for the visible picker feedback recorded by af23_perf_pick_ui.mjs.
// This only post-processes an existing report; it does not launch a browser.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const input = resolve(process.argv[2] || 'work/perf-pick-ui-final.json')
const report = JSON.parse(readFileSync(input, 'utf8'))
const failures = []

if (report.id !== 'AF-23-E1-picker-ui' || report.status !== 'PASS' || report.gateEligible !== true) {
  failures.push('Input is not a completed, gate-eligible AF-23 picker UI report.')
}

function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
}

const cases = (report.cases || []).map((item) => {
  const samples = item.samples || []
  const durations = []
  let busy = 0
  let completed = 0
  let invalid = 0

  for (const sample of samples) {
    const completion = sample.completion
    const frame = completion?.busyFrame
    const control = frame?.control
    const result = frame?.resultUi
    const visibleBusy = control?.disabled === true
      && control?.label === '正在完成…'
      && result?.groupStatus === '正在同步選取…'
    const visibleCompleted = control?.disabled === false
      && result?.batchHidden === false
      && Number(result?.batchRows) === item.scenario.groups
    const durationMs = Number(frame?.at) - Number(completion?.startedAt)

    if (visibleBusy) busy += 1
    else if (visibleCompleted) completed += 1
    else invalid += 1

    if (!Number.isFinite(durationMs) || durationMs < 0) invalid += 1
    else durations.push(durationMs)
    if (sample.correctSavedData !== true) failures.push(`${item.scenario?.id || 'unknown'} sample ${sample.iteration}: saved data was incorrect.`)
  }

  const p95Ms = durations.length ? percentile95(durations) : null
  if (samples.length !== 20 || invalid > 0 || durations.length !== samples.length) {
    failures.push(`${item.scenario?.id || 'unknown'}: exactly 20 samples must each show a visible busy or completed state on the captured frame.`)
  }
  if (p95Ms === null || p95Ms > 100) failures.push(`${item.scenario?.id || 'unknown'}: visible feedback p95 must be <= 100ms.`)
  if (item.correctness !== true) failures.push(`${item.scenario?.id || 'unknown'}: case correctness flag is not true.`)

  return {
    id: item.scenario?.id || null,
    samples: samples.length,
    visibleBusySamples: busy,
    visibleCompletedBeforeBusySamples: completed,
    visibleStateSamples: busy + completed,
    p95Ms: p95Ms === null ? null : +p95Ms.toFixed(2),
    gateUnder100ms: p95Ms !== null && p95Ms <= 100,
    correctness: item.correctness === true,
  }
})

const expectedIds = ['1group-1value', '5group-20values', '20group-100values']
if (cases.length !== expectedIds.length || expectedIds.some((id) => !cases.some((item) => item.id === id))) {
  failures.push('Expected exactly the three fixed picker UI scenarios.')
}

const result = { status: failures.length === 0 ? 'PASS' : 'FAIL', input, cases, failures }
console.log(JSON.stringify(result, null, 2))
if (failures.length) process.exitCode = 1
