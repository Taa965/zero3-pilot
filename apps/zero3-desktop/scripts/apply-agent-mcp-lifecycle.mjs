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
    if (!source.includes(replacement.from)) throw new Error(`Zero3 MCP lifecycle overlay drift in ${relativePath}: missing ${replacement.label}`)
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

const lifecycleHelpers = String.raw`
const zero3AgentMcpLeases = new Map<string, { lease: Zero3AntigravityMcpLease; logicalSessionId: string }>()
async function zero3AgentDelay(ms: number) {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}
async function zero3ResetAntigravityRuntime(logicalSessionId: string) {
  if (!zero3Antigravity.status().activeSessions.includes(logicalSessionId)) return
  try { await zero3Antigravity.stop(logicalSessionId) } catch {}
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!zero3Antigravity.status().activeSessions.includes(logicalSessionId)) return
    await zero3AgentDelay(50)
  }
  try { await zero3Antigravity.interrupt(logicalSessionId) } catch {}
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!zero3Antigravity.status().activeSessions.includes(logicalSessionId)) return
    await zero3AgentDelay(50)
  }
  throw new Error('Antigravity runtime did not terminate while releasing the task-scoped MCP lease')
}
`

const startReplacement = String.raw`    const preflight = await zero3GitEvidence(zero3CodexRuntime, input.cwd, record.task.baseSha ?? null)
    assertZero3GitPreflight(preflight, record.task.baseSha ?? null, true)
    const review = await zero3ReviewStore.get(taskId)
    const fixRequest = review?.state === 'FIX_DISPATCHED' ? await zero3ReviewStore.latestFixRequest(taskId) : null
    await zero3ResetAntigravityRuntime(input.logicalSessionId)
    const lease = new Zero3AntigravityMcpLease()
    await lease.install({
      taskId: record.task.taskId,
      projectId: record.task.projectId,
      workspace: input.cwd,
      taskSnapshot: record,
      serverPath: zero3TaskMcpServerPath,
      electronExecutable: process.execPath,
      stateDir: zero3AgentTaskStateRoot,
      artifactDir: zero3ArtifactRoot,
      reviewDir: zero3ReviewRoot,
      projectContextDir: zero3ProjectContextRoot
    })
    try {
      const started = await zero3Antigravity.startTurn({
        ...input,
        prompt: renderZero3AgentTaskPrompt(record.task, fixRequest)
      })
      zero3AgentMcpLeases.set(started.turnId, { lease, logicalSessionId: input.logicalSessionId })
      return started
    } catch (error) {
      try { await zero3ResetAntigravityRuntime(input.logicalSessionId) } finally { await lease.restore() }
      throw error
    }`

const waitReplacement = String.raw`  waitTurn: async (turnId: string) => {
    const scoped = zero3AgentMcpLeases.get(turnId) ?? null
    try {
      return await zero3Antigravity.waitTurn(turnId)
    } finally {
      zero3AgentMcpLeases.delete(turnId)
      if (scoped) {
        try { await zero3ResetAntigravityRuntime(scoped.logicalSessionId) }
        finally { await scoped.lease.restore() }
      }
    }
  }`

export function applyZero3AgentMcpLifecycle() {
  patchFile('electron/main.ts', [
    {
      label: 'task-scoped MCP lifecycle helpers',
      from: 'const zero3TaskAwareAntigravity = {',
      to: lifecycleHelpers + '\nconst zero3TaskAwareAntigravity = {'
    },
    {
      label: 'task-scoped MCP install before formal Gemini turn',
      from:
        "    const preflight = await zero3GitEvidence(zero3CodexRuntime, input.cwd, record.task.baseSha ?? null)\n" +
        "    assertZero3GitPreflight(preflight, record.task.baseSha ?? null, true)\n" +
        "    const review = await zero3ReviewStore.get(taskId)\n" +
        "    const fixRequest = review?.state === 'FIX_DISPATCHED' ? await zero3ReviewStore.latestFixRequest(taskId) : null\n" +
        "    return zero3Antigravity.startTurn({\n" +
        "      ...input,\n" +
        "      prompt: renderZero3AgentTaskPrompt(record.task, fixRequest)\n" +
        "    })",
      to: startReplacement
    },
    {
      label: 'task-scoped MCP cleanup after formal Gemini turn',
      from: '  waitTurn: (turnId: string) => zero3Antigravity.waitTurn(turnId)',
      to: waitReplacement
    }
  ])
}
