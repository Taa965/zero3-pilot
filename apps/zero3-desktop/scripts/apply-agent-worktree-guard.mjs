import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.writeFileSync(file, content) }
function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) throw new Error(`Zero3 worktree guard drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

export function applyZero3AgentWorktreeGuard() {
  patchFile('electron/main.ts', [
    {
      label: 'worktree guard import',
      from: "import { Zero3ReviewLoopStore, Zero3AgentRouter, Zero3AgentTaskStore, Zero3AgentRuntimeOrchestrator, Zero3AgentRecoveryController, Zero3CodexTaskAdapter, Zero3AuthoritativeResultFinalizer, Zero3VerificationCollector, zero3GitEvidence, renderZero3AgentTaskPrompt, type Zero3TaskSpecV2 } from './zero3/agent-routing/index'",
      to: "import { Zero3ReviewLoopStore, Zero3AgentRouter, Zero3AgentTaskStore, Zero3AgentRuntimeOrchestrator, Zero3AgentRecoveryController, Zero3CodexTaskAdapter, Zero3AuthoritativeResultFinalizer, Zero3VerificationCollector, zero3GitEvidence, assertZero3GitPreflight, renderZero3AgentTaskPrompt, type Zero3TaskSpecV2 } from './zero3/agent-routing/index'"
    },
    {
      label: 'Gemini linked-worktree preflight',
      from:
        "    if (!record) throw new Error('Task-aware Antigravity dispatch could not load the durable TaskSpec')\n" +
        "    const review = await zero3ReviewStore.get(taskId)",
      to:
        "    if (!record) throw new Error('Task-aware Antigravity dispatch could not load the durable TaskSpec')\n" +
        "    const preflight = await zero3GitEvidence(zero3CodexRuntime, input.cwd, record.task.baseSha ?? null)\n" +
        "    assertZero3GitPreflight(preflight, record.task.baseSha ?? null, true)\n" +
        "    const review = await zero3ReviewStore.get(taskId)"
    },
    {
      label: 'Codex linked-worktree preflight',
      from:
        "  dispatchTask: async (task: Zero3TaskSpecV2) => {\n" +
        "    const review = await zero3ReviewStore.get(task.taskId)",
      to:
        "  dispatchTask: async (task: Zero3TaskSpecV2) => {\n" +
        "    if (!task.worktreePath?.trim()) throw new Error('Codex agent dispatch requires an isolated worktreePath')\n" +
        "    const preflight = await zero3GitEvidence(zero3CodexRuntime, task.worktreePath, task.baseSha ?? null)\n" +
        "    assertZero3GitPreflight(preflight, task.baseSha ?? null, true)\n" +
        "    const review = await zero3ReviewStore.get(task.taskId)"
    }
  ])
}
