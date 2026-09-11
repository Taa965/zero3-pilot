import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const need = (source, text, message) => { if (!source.includes(text)) throw new Error(message) }
const forbid = (source, text, message) => { if (source.includes(text)) throw new Error(message) }

const contracts = read('apps/zero3-desktop/execution-runtime/contracts.ts')
const scheduler = read('apps/zero3-desktop/execution-runtime/scheduler.ts')
const runtime = read('apps/zero3-desktop/execution-runtime/runtime.ts')
const bridge = read('apps/zero3-desktop/scripts/apply-execution-runtime-bridge.mjs')
const taskList = read('apps/zero3-desktop/ui-v2/tasks/TaskList.tsx')
const taskWorkspace = read('apps/zero3-desktop/ui-v2/tasks/TaskWorkspace.tsx')
const skillRouter = read('apps/zero3-desktop/skill-runtime/skill-router.ts')
const workerV2 = read('apps/zero3-desktop/worker-runtime/v2/contracts.ts')
const lifecycle = read('apps/zero3-desktop/worker-runtime/v2/lifecycle-runtime.ts')
const lifecycleOverlay = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
const skillWorkspace = read('apps/zero3-desktop/ui-v2/skills/SkillWorkspace.tsx')

need(contracts, 'requiredSkills?: readonly string[]', 'Execution Step must declare requiredSkills.')
need(contracts, 'optionalSkills?: readonly string[]', 'Execution Step must declare optionalSkills.')
need(contracts, 'skillPreflight?: ExecutionSkillPreflight', 'Execution Runtime must persist Skill preflight state.')
need(scheduler, 'capabilityBlockedStepIds', 'Scheduler must expose Skill capability blocking.')
need(scheduler, "preflight.state !== 'ready'", 'Scheduler must fail closed before required Skill preflight.')
need(runtime, 'recordSkillPreflight', 'Execution Runtime must record Skill preflight evidence.')
need(runtime, 'required Skills have not passed preflight', 'Assignment creation must enforce required Skill preflight.')
need(runtime, 'Skill preflight recommends', 'AUTO/assignment executor must match Skill routing result.')
need(bridge, 'zero3ExecutionSkillCapabilityProvider', 'Desktop Execution bridge must resolve Skill capabilities from the native Codex catalog.')
need(bridge, "zero3CodexAppServer.request('skills/list'", 'Execution Skill preflight must read Codex native Skill metadata.')
need(bridge, 'zero3SkillBindingStore.list()', 'Execution Skill routing must include Zero3 relation-only bindings.')
need(bridge, 'createRoutedAssignment', 'Desktop bridge must expose Skill-routed assignment creation.')
need(taskList, 'useTasks()', 'Task list must render the real Execution TaskContext ledger.')
need(taskWorkspace, '重新预检 Skill', 'Task details must expose Skill preflight refresh.')
need(taskWorkspace, 'refreshSkillPreflight', 'Task details must expose live Skill preflight.')
need(taskWorkspace, 'createRoutedAssignment', 'AUTO Task steps must use routed assignment.')
forbid(taskWorkspace, 'UI2-GEMINI-001', 'Task UI must not regress to fixed demonstration data.')
need(skillRouter, "binding.targetType === 'workflow'", 'Workflow Skill bindings must remain part of Skill routing.')
need(workerV2, 'skill?: {', 'Worker v2 legacy single-Skill contract must remain backward compatible.')
need(lifecycle, "runtime.skillPreflight?.executor === 'GPT_WEB'", 'Web lifecycle must not claim AUTO Steps routed by Skill preflight to another Agent.')
need(lifecycleOverlay, 'refreshSkillPreflight: taskId => zero3ExecutionRuntime.refreshSkillPreflight(taskId)', 'Web lifecycle composition must refresh Skill preflight before claims.')
need(skillWorkspace, 'Agent Capability Matrix', 'Skills management must expose the Agent Skill capability matrix.')
for (const forbidden of ['SkillRegistry', 'skill_packages']) forbid(bridge, forbidden, `Execution bridge must not create a second Skill authority: ${forbidden}`)

console.log('Zero3 Skill × Task × Workflow guard passed: Step requirements -> native Skill preflight -> Scheduler capability gate -> routed Assignment -> real Task UI / Agent capability matrix.')
