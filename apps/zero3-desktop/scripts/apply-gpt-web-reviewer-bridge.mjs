import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const reviewerSource = path.join(repoRoot, 'apps', 'zero3-desktop', 'gpt-web-runtime', 'gpt-web-reviewer.ts')
const reviewerTarget = path.join(hermesDesktopDir, 'electron', 'zero3', 'gpt-web', 'gpt-web-reviewer.ts')

function read(relativePath) {
  return fs.readFileSync(path.join(hermesDesktopDir, ...relativePath.split('/')), 'utf8')
}

function write(relativePath, content) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function patchFile(relativePath, replacements) {
  let source = read(relativePath)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Zero3 GPT Web reviewer bridge drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(relativePath, source)
}

function stageReviewerTransport() {
  if (!fs.existsSync(reviewerSource) || !fs.statSync(reviewerSource).isFile()) {
    throw new Error(`Zero3 GPT Web reviewer source is missing: ${reviewerSource}`)
  }
  fs.mkdirSync(path.dirname(reviewerTarget), { recursive: true })
  fs.copyFileSync(reviewerSource, reviewerTarget)

  patchFile('electron/zero3/gpt-web/gpt-web-provider.ts', [
    {
      label: 'accessibility reviewer transport import',
      from: "} from './gpt-web-types'\n",
      to: "} from './gpt-web-types'\nimport { runZero3GptWebReview, type Zero3GptWebReviewInput } from './gpt-web-reviewer'\n"
    },
    {
      label: 'GPT Web provider reviewer method',
      appliedMarker: 'async review(idValue: unknown, input: Zero3GptWebReviewInput)',
      from: '\n  stop(): void {',
      to: String.raw`
  async review(idValue: unknown, input: Zero3GptWebReviewInput) {
    const id = requiredText(idValue, 'workspace entry id', MAX_ENTRY_ID)
    const entry = await this.requireEntry(id)
    const live = await this.ensureLive(entry)
    const contents = live.view.webContents
    const previousBounds = live.view.getBounds()
    const detached = live.parentWindowId == null
    if (detached && (previousBounds.width < 640 || previousBounds.height < 480)) {
      live.view.setBounds({ x: 0, y: 0, width: 1200, height: 900 })
    }
    const readyDeadline = Date.now() + 30_000
    while (contents.isLoadingMainFrame() && Date.now() < readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const currentUrl = observedChatGptUrl(contents.getURL())
    if (!currentUrl) throw new Error('GPT Web reviewer is not on an authenticated chatgpt.com page')
    if (contents.isLoadingMainFrame()) throw new Error('GPT Web reviewer page did not become ready within 30 seconds')
    const bounds = live.view.getBounds()
    live.lastUsedAt = Date.now()
    this.bump(live.entryId)
    try {
      return await runZero3GptWebReview(contents, { width: bounds.width, height: bounds.height }, input)
    } finally {
      if (detached && !contents.isDestroyed()) live.view.setBounds(previousBounds)
    }
  }

  stop(): void {`
    }
  ])
}

const reviewerRuntime = String.raw`
const zero3GptWebReviewLoops = new Map<string, Promise<unknown>>()
const zero3GptWebReviewSessionTails = new Map<string, Promise<void>>()
const ZERO3_GPT_WEB_REVIEW_DIFF_CAP = 96 * 1024

function zero3ReviewerRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function zero3ReviewerText(value: unknown, label: string, max = 256): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(label + ' is invalid')
  return text
}

function zero3ReviewerOptionalText(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= max ? text : null
}

function zero3ReviewerGitSha(value: unknown): string | null {
  const sha = zero3ReviewerOptionalText(value, 64)
  return sha && /^[a-fA-F0-9]{7,64}$/.test(sha) ? sha : null
}

function zero3ReviewerUtf8Cap(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false }
  let capped = buffer.subarray(0, maxBytes).toString('utf8')
  while (Buffer.byteLength(capped, 'utf8') > maxBytes) capped = capped.slice(0, -1)
  return { text: capped, truncated: true }
}

async function zero3WithGptWebReviewSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = zero3GptWebReviewSessionTails.get(sessionId) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  zero3GptWebReviewSessionTails.set(sessionId, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (zero3GptWebReviewSessionTails.get(sessionId) === tail) zero3GptWebReviewSessionTails.delete(sessionId)
  }
}

async function zero3BuildGptWebReviewPacket(taskRecord: Record<string, unknown>, packetValue: unknown): Promise<Record<string, unknown>> {
  const packet = structuredClone(zero3ReviewerRecord(packetValue))
  const task = zero3ReviewerRecord(taskRecord.task)
  const result = zero3ReviewerRecord(taskRecord.result)
  const gitResult = zero3ReviewerRecord(result.git)
  const workspace = zero3ReviewerOptionalText(task.worktreePath, 16_384)
  const baseSha = zero3ReviewerGitSha(packet.baseSha) ?? zero3ReviewerGitSha(task.baseSha)
  const headSha = zero3ReviewerGitSha(packet.headSha) ?? zero3ReviewerGitSha(gitResult.headSha) ?? zero3ReviewerGitSha(gitResult.commitSha)
  const changedFiles = Array.isArray(packet.changedFiles) ? packet.changedFiles : []

  if (!workspace || !baseSha || !headSha || baseSha.toLowerCase() === headSha.toLowerCase()) {
    packet.diffSummary = {
      available: baseSha != null && headSha != null && baseSha.toLowerCase() === headSha.toLowerCase(),
      source: 'codex-command-exec',
      baseSha,
      headSha,
      patch: '',
      patchTruncated: false,
      reason: changedFiles.length > 0 && (!workspace || !baseSha || !headSha)
        ? 'Authoritative workspace/base/head was incomplete; reviewer must not assume changed code it cannot inspect.'
        : null
    }
    return packet
  }

  try {
    const response = await zero3CodexRuntime.execCommand({
      command: ['git', 'diff', '--no-ext-diff', '--no-renames', '--unified=24', baseSha + '..' + headSha, '--'],
      cwd: workspace,
      timeoutMs: 15_000,
      outputBytesCap: ZERO3_GPT_WEB_REVIEW_DIFF_CAP + 4096,
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    }, 20_000)
    const output = zero3ReviewerRecord(response)
    const exitCode = Number(output.exitCode)
    if (!Number.isInteger(exitCode) || exitCode !== 0) {
      throw new Error(zero3ReviewerOptionalText(output.stderr, 4000) ?? zero3ReviewerOptionalText(output.stdout, 4000) ?? 'git diff failed')
    }
    const stdout = typeof output.stdout === 'string' ? output.stdout : ''
    const capped = zero3ReviewerUtf8Cap(stdout, ZERO3_GPT_WEB_REVIEW_DIFF_CAP)
    packet.diffSummary = {
      available: true,
      source: 'codex-command-exec',
      baseSha,
      headSha,
      patch: capped.text,
      patchTruncated: capped.truncated
    }
  } catch (error) {
    packet.diffSummary = {
      available: false,
      source: 'codex-command-exec',
      baseSha,
      headSha,
      patch: '',
      patchTruncated: false,
      reason: 'Git diff evidence collection failed: ' + (error instanceof Error ? error.message : String(error)).slice(0, 4000)
    }
  }
  return packet
}

async function zero3RunGptWebReviewerLoop(taskIdValue: unknown): Promise<unknown> {
  const taskId = zero3ReviewerText(taskIdValue, 'taskId', 128)
  const existing = zero3GptWebReviewLoops.get(taskId)
  if (existing) return existing

  const running = (async () => {
    for (let guard = 0; guard < 20; guard += 1) {
      const taskRecord = await zero3AgentTaskStore.get(taskId)
      if (!taskRecord) throw new Error('GPT Web reviewer task was not found')
      if (taskRecord.state !== 'REVIEW_PENDING') return taskRecord
      if (!taskRecord.task.reviewPolicy?.required || taskRecord.task.reviewPolicy.reviewer !== 'GPT_WEB') return taskRecord
      if (!taskRecord.binding) throw new Error('GPT Web reviewer requires a durable cross-agent binding')

      const reviewSessionId = taskRecord.binding.reviewSessionId ?? taskRecord.binding.originSessionId
      if (!reviewSessionId) throw new Error('GPT Web reviewer session binding is missing')
      const sourceEntry = await zero3WorkspaceEntries.get(reviewSessionId)
      if (!sourceEntry || sourceEntry.kind !== 'gpt_web') {
        throw new Error('GPT Web reviewer is bound to a missing or non-GPT workspace entry')
      }

      const review = await zero3ReviewStore.get(taskId)
      const current = review?.cycles.at(-1)
      if (!current || review?.state !== 'REVIEW_PENDING') {
        throw new Error('GPT Web reviewer could not load the current ReviewPacket')
      }
      if (current.decision) return taskRecord

      const attempts = (taskRecord.reviewAutomation?.attempts ?? 0) + 1
      await zero3AgentTaskStore.setReviewAutomation(taskId, {
        status: 'QUEUED',
        reviewerSessionId: reviewSessionId,
        cycle: current.cycle,
        attempts,
        lastError: null
      })

      const webDecision = await zero3WithGptWebReviewSessionLock(reviewSessionId, async () => {
        await zero3AgentTaskStore.setReviewAutomation(taskId, {
          status: 'RUNNING',
          reviewerSessionId: reviewSessionId,
          cycle: current.cycle,
          attempts,
          lastError: null
        })
        const packet = await zero3BuildGptWebReviewPacket(taskRecord as unknown as Record<string, unknown>, current.packet)
        return zero3GptWeb.review(reviewSessionId, {
          reviewId: current.packet.reviewId,
          taskId,
          cycle: current.cycle,
          packet,
          timeoutMs: 240_000
        })
      })

      const decision = {
        protocol: 'zero3.pilot.review-decision.v1',
        reviewId: current.packet.reviewId,
        taskId,
        cycle: current.cycle,
        decision: webDecision.decision,
        findings: webDecision.findings,
        requiredFixes: webDecision.requiredFixes,
        optionalSuggestions: webDecision.optionalSuggestions,
        reviewerSessionId: reviewSessionId,
        createdAt: new Date().toISOString()
      }
      const decided = await zero3AgentDesktopHandlers.reviewDecision({
        taskId,
        contextVersion: taskRecord.task.contextVersion,
        decision
      })
      await zero3AgentTaskStore.setReviewAutomation(taskId, {
        status: 'SUCCEEDED',
        reviewerSessionId: reviewSessionId,
        cycle: current.cycle,
        attempts,
        lastError: null
      })
      const next = zero3ReviewerRecord(decided)
      const state = typeof next.state === 'string' ? next.state : ''
      if (state !== 'REVIEW_PENDING') return await zero3AgentTaskStore.get(taskId)
    }
    throw new Error('GPT Web reviewer exceeded the 20-cycle automation safety limit')
  })()

  zero3GptWebReviewLoops.set(taskId, running)
  try {
    return await running
  } catch (error) {
    const current = await zero3AgentTaskStore.get(taskId).catch(() => null)
    if (current) {
      const attempts = current.reviewAutomation?.attempts ?? 0
      await zero3AgentTaskStore.setReviewAutomation(taskId, {
        status: 'FAILED',
        attempts,
        lastError: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined)
    }
    throw error
  } finally {
    if (zero3GptWebReviewLoops.get(taskId) === running) zero3GptWebReviewLoops.delete(taskId)
  }
}

ipcMain.handle('zero3:agent-task:review-gpt-web', (_event, request: unknown) => {
  const input = zero3ReviewerRecord(request)
  return zero3RunGptWebReviewerLoop(input.taskId)
})
`

function wireReviewerRuntime() {
  patchFile('electron/main.ts', [
    {
      label: 'GPT Web reviewer runtime after agent desktop handlers',
      appliedMarker: 'const zero3GptWebReviewSessionTails = new Map<string, Promise<void>>()',
      from: "ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.recoveryResolve, (_event, request: unknown) => zero3AgentDesktopHandlers.recoveryResolve(request))\n",
      to:
        "ipcMain.handle(ZERO3_AGENT_DESKTOP_CHANNELS.recoveryResolve, (_event, request: unknown) => zero3AgentDesktopHandlers.recoveryResolve(request))\n" +
        reviewerRuntime + '\n'
    },
    {
      label: 'automatic reviewer start after real TaskSpec handoff',
      appliedMarker: "console.warn('[zero3:gpt-web-reviewer]'",
      from:
        "  const record = zero3AgentCompatRecord(taskRecord)\n" +
        "  const binding = zero3AgentCompatRecord(record.binding)\n" +
        "  return {",
      to:
        "  const record = zero3AgentCompatRecord(taskRecord)\n" +
        "  const binding = zero3AgentCompatRecord(record.binding)\n" +
        "  void zero3RunGptWebReviewerLoop(taskId).catch(error => {\n" +
        "    console.warn('[zero3:gpt-web-reviewer]', error instanceof Error ? error.message : String(error))\n" +
        "  })\n" +
        "  return {"
    }
  ])

  patchFile('electron/preload.ts', [
    {
      label: 'manual GPT Web reviewer retry bridge',
      appliedMarker: "reviewGptWeb: request => ipcRenderer.invoke('zero3:agent-task:review-gpt-web', request)",
      from: "  reviewGet: request => ipcRenderer.invoke('zero3:agent-task:review-get', request),\n  dispatch:",
      to:
        "  reviewGet: request => ipcRenderer.invoke('zero3:agent-task:review-get', request),\n" +
        "  reviewGptWeb: request => ipcRenderer.invoke('zero3:agent-task:review-gpt-web', request),\n" +
        "  dispatch:"
    }
  ])

  patchFile('src/global.d.ts', [
    {
      label: 'manual GPT Web reviewer renderer type',
      appliedMarker: 'reviewGptWeb: (request: { taskId: string }) => Promise<unknown>',
      from: '      reviewGet: (request: { taskId: string }) => Promise<unknown>\n      dispatch:',
      to:
        '      reviewGet: (request: { taskId: string }) => Promise<unknown>\n' +
        '      reviewGptWeb: (request: { taskId: string }) => Promise<unknown>\n' +
        '      dispatch:'
    }
  ])

  const provenancePath = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
  if (fs.existsSync(provenancePath)) {
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
    provenance.gptWebReviewerPhase = 'P2C2-chatgpt-web-reviewer-hardening'
    provenance.gptWebReviewerTransport = 'chromium-devtools-accessibility-input-no-dom-selectors'
    provenance.gptWebReviewerConcurrency = 'serialized-per-bound-gpt-session'
    provenance.gptWebReviewerEvidence = 'authoritative-codex-command-exec-git-diff'
    fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)
  }
}

export function applyZero3GptWebReviewerBridge() {
  stageReviewerTransport()
  wireReviewerRuntime()
  console.log('Zero3 GPT Web reviewer staged: per-session serialized Accessibility/Input transport, authoritative Git diff evidence, durable retry/error state, and same-provider fix loop; no DOM selectors or private ChatGPT APIs.')
}
