import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateExecutionSkillPreflight } from './skill-capability.ts'

const step = {
  contract: 'zero3.pilot.execution-step.v1',
  taskId: 'task-1', stepId: 'script', title: '脚本', objective: '重构脚本', executor: 'AUTO',
  dependsOn: [], requiredSkills: ['cognitive-store-script'], optionalSkills: ['review-helper'],
  inputArtifacts: [], expectedOutputs: [], completionGate: [], maxAttempts: 2, metadata: {},
  createdAt: new Date().toISOString()
} as const

const catalog = [
  { name: 'cognitive-store-script', displayName: '认知便利店脚本', enabled: true },
  { name: 'review-helper', displayName: '审片助手', enabled: false }
]

test('required Skill resolves while disabled optional Skill stays non-blocking', () => {
  const result = evaluateExecutionSkillPreflight({ step, executor: 'CODEX', adapterMode: 'native', catalog })
  assert.equal(result.state, 'ready')
  assert.deepEqual(result.availableRequiredSkills, ['认知便利店脚本'])
  assert.deepEqual(result.missingOptionalSkills, ['review-helper'])
})

test('unsupported adapter blocks required Skills', () => {
  const result = evaluateExecutionSkillPreflight({ step, executor: 'GEMINI_WEB', adapterMode: 'unsupported', catalog })
  assert.equal(result.state, 'blocked')
  assert.deepEqual(result.missingRequiredSkills, ['cognitive-store-script'])
})

test('no Skill requirements remain backward compatible', () => {
  const result = evaluateExecutionSkillPreflight({
    step: { ...step, requiredSkills: [], optionalSkills: [] },
    executor: null,
    adapterMode: 'unsupported',
    catalog: []
  })
  assert.equal(result.state, 'not_required')
  assert.deepEqual(result.missingRequiredSkills, [])
})
