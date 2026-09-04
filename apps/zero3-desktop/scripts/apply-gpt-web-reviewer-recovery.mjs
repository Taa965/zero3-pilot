import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir } from './config.mjs'

function read(relativePath) {
  return fs.readFileSync(path.join(hermesDesktopDir, ...relativePath.split('/')), 'utf8')
}

function write(relativePath, content) {
  fs.writeFileSync(path.join(hermesDesktopDir, ...relativePath.split('/')), content)
}

function patchFile(relativePath, replacements) {
  let source = read(relativePath)
  for (const replacement of replacements) {
    if (source.includes(replacement.appliedMarker ?? replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(`Zero3 GPT Web reviewer recovery drift in ${relativePath}: missing ${replacement.label}`)
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(relativePath, source)
}

const recoveryRuntime = String.raw`
async function zero3RecoverPendingGptWebReviews(): Promise<number> {
  const pending = await zero3AgentTaskStore.list({ states: ['REVIEW_PENDING'], limit: 1000 })
  let scheduled = 0
  for (const task of pending) {
    if (!task.task.reviewPolicy?.required || task.task.reviewPolicy.reviewer !== 'GPT_WEB') continue
    // A durable FAILED state means the previous attempt ended cleanly with a known
    // failure. Do not create a restart loop; the Task Board exposes explicit retry.
    if (task.reviewAutomation?.status === 'FAILED') continue
    scheduled += 1
    void zero3RunGptWebReviewerLoop(task.task.taskId).catch(error => {
      console.warn('[zero3:gpt-web-reviewer:recovery]', task.task.taskId, error instanceof Error ? error.message : String(error))
    })
  }
  return scheduled
}

app.whenReady().then(() => {
  const timer = setTimeout(() => {
    void zero3RecoverPendingGptWebReviews()
      .then(count => {
        if (count > 0) console.info('[zero3:gpt-web-reviewer:recovery] resumed pending reviews:', count)
      })
      .catch(error => console.warn('[zero3:gpt-web-reviewer:recovery]', error instanceof Error ? error.message : String(error)))
  }, 1500)
  timer.unref?.()
})
`

export function applyZero3GptWebReviewerRecovery() {
  patchFile('electron/main.ts', [
    {
      label: 'startup recovery after manual reviewer IPC',
      appliedMarker: 'async function zero3RecoverPendingGptWebReviews(): Promise<number> {',
      from:
        "ipcMain.handle('zero3:agent-task:review-gpt-web', (_event, request: unknown) => {\n" +
        "  const input = zero3ReviewerRecord(request)\n" +
        "  return zero3RunGptWebReviewerLoop(input.taskId)\n" +
        "})\n",
      to:
        "ipcMain.handle('zero3:agent-task:review-gpt-web', (_event, request: unknown) => {\n" +
        "  const input = zero3ReviewerRecord(request)\n" +
        "  return zero3RunGptWebReviewerLoop(input.taskId)\n" +
        "})\n" +
        recoveryRuntime + '\n'
    }
  ])

  const provenancePath = path.join(hermesDesktopDir, 'public', 'zero3-upstream.json')
  if (fs.existsSync(provenancePath)) {
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
    provenance.gptWebReviewerRecovery = 'resume-nonfailed-review-pending-on-app-ready'
    fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)
  }

  console.log('Zero3 GPT Web reviewer recovery staged: non-failed REVIEW_PENDING tasks resume after restart; known FAILED attempts remain explicit-retry only.')
}
