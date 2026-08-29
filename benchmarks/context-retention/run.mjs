#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const POLICY = Object.freeze({
  version: 'zero3-context-retention/v1',
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
  marker: '\n\n[... tool result middle pruned ...]\n\n',
})

const TOOL_RESULT_COUNT = 100
const OVERSIZED_COUNT = 20
const NORMAL_CHARS = 1024
const OVERSIZED_CHARS = 100_000
const CONTEXT_BUDGET_TOKENS = Number(process.env.ZERO3_CONTEXT_BUDGET_TOKENS ?? 128_000)

function codePoints(text) {
  return Array.from(text)
}

function pruneText(text) {
  const points = codePoints(text)
  if (points.length <= POLICY.thresholdChars) return { text, pruned: false }
  const output = [
    ...points.slice(0, POLICY.headChars),
    ...codePoints(POLICY.marker),
    ...points.slice(points.length - POLICY.tailChars),
  ].join('')
  return { text: output, pruned: true }
}

function estimateTokens(chars) {
  // Policy comparison heuristic only; runtime benchmark must replace this with
  // Codex/model token accounting before merge.
  return Math.ceil(chars / 4)
}

function makeScenario() {
  const results = []
  const answerKey = {}
  for (let i = 0; i < TOOL_RESULT_COUNT; i += 1) {
    const oversized = i < OVERSIZED_COUNT
    const needle = `ZERO3_MIDDLE_FACT_${String(i).padStart(3, '0')}`
    const targetChars = oversized ? OVERSIZED_CHARS : NORMAL_CHARS
    const prefixLength = oversized ? Math.floor(targetChars / 2) : Math.floor(targetChars / 3)
    const suffixLength = Math.max(0, targetChars - prefixLength - needle.length)
    const text = `${'A'.repeat(prefixLength)}${needle}${'Z'.repeat(suffixLength)}`
    results.push({ id: `tool-${i}`, oversized, text, needle })
    answerKey[`tool-${i}`] = needle
  }
  return { results, answerKey }
}

function summarize(results) {
  const chars = results.reduce((sum, result) => sum + codePoints(result.text).length, 0)
  const estimatedTokens = estimateTokens(chars)
  return {
    chars,
    estimatedTokens,
    compactionRequired: estimatedTokens > CONTEXT_BUDGET_TOKENS,
  }
}

function scoreAnswers(file, answerKey) {
  if (!file) {
    return {
      status: 'runtime-observation-required',
      correct: null,
      total: Object.keys(answerKey).length,
      accuracy: null,
    }
  }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  let correct = 0
  for (const [id, expected] of Object.entries(answerKey)) {
    if (payload[id] === expected) correct += 1
  }
  return {
    status: 'observed',
    correct,
    total: Object.keys(answerKey).length,
    accuracy: correct / Object.keys(answerKey).length,
  }
}

function parseArgs(argv) {
  const args = { baselineAnswers: null, zero3Answers: null, output: null }
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.split('=', 2)
    if (key === '--baseline-answers') args.baselineAnswers = value
    else if (key === '--zero3-answers') args.zero3Answers = value
    else if (key === '--output') args.output = value
    else throw new Error(`unknown argument: ${raw}`)
  }
  return args
}

const args = parseArgs(process.argv)
const scenario = makeScenario()
const baselineResults = scenario.results.map(result => ({ ...result }))
const prunedResults = scenario.results.map(result => {
  const pruned = pruneText(result.text)
  return { ...result, text: pruned.text, pruned: pruned.pruned }
})

const baseline = summarize(baselineResults)
const zero3 = summarize(prunedResults)
const report = {
  schema: 'zero3-context-retention-benchmark/v1',
  policy: POLICY,
  scenario: {
    toolResults: TOOL_RESULT_COUNT,
    oversizedToolResults: OVERSIZED_COUNT,
    normalChars: NORMAL_CHARS,
    oversizedChars: OVERSIZED_CHARS,
    contextBudgetTokens: CONTEXT_BUDGET_TOKENS,
    middleFacts: Object.keys(scenario.answerKey).length,
  },
  baseline: {
    ...baseline,
    compactionCalls: null,
    summaryCalls: null,
    answerAccuracy: scoreAnswers(args.baselineAnswers, scenario.answerKey),
  },
  zero3: {
    ...zero3,
    prunedToolResults: prunedResults.filter(result => result.pruned).length,
    compactionCalls: null,
    summaryCalls: null,
    answerAccuracy: scoreAnswers(args.zero3Answers, scenario.answerKey),
  },
  deltas: {
    chars: zero3.chars - baseline.chars,
    estimatedTokens: zero3.estimatedTokens - baseline.estimatedTokens,
  },
  notes: [
    'estimatedTokens is a deterministic chars/4 planning heuristic, not model token accounting',
    'compactionCalls and summaryCalls must be filled from pinned Codex runtime observations after D2B integration',
    'middle facts intentionally fall inside the removed span; Zero3 answer accuracy therefore depends on D1 full-output recovery, not on pretending the preview retains every fact',
  ],
}

const json = `${JSON.stringify(report, null, 2)}\n`
if (args.output) {
  const target = path.resolve(args.output)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, json)
} else {
  process.stdout.write(json)
}
