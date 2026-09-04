import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, repoRoot } from './config.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'host-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'remote-host')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function patchFile(relativePath, replacements) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  let source = read(file)
  for (const replacement of replacements) {
    if (source.includes(replacement.to)) continue
    if (!source.includes(replacement.from)) {
      throw new Error(
        `Zero3 Remote Host overlay drift in ${relativePath}: could not find ${replacement.label}. ` +
          'Review the pinned Hermes/Codex desktop boundary before updating the upstream pin.'
      )
    }
    source = source.replace(replacement.from, replacement.to)
  }
  write(file, source)
}

function copyRuntimeSources() {
  fs.mkdirSync(targetDir, { recursive: true })
  const files = [
    'remote-types.ts',
    'remote-config.ts',
    'remote-client.ts',
    'remote-evidence.ts',
    'remote-completion-gate.ts',
    'remote-mapping-store.ts',
    'remote-outbox.ts',
    'remote-outbox-drain.ts',
    'remote-task-runner.ts',
    'remote-node.ts',
    'index.ts'
  ]
  for (const file of files) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 Remote Host source template missing: ${source}`)
    write(path.join(targetDir, file), read(source))
  }
}

function applyCompletionGate() {
  patchFile('electron/zero3/remote-host/remote-task-runner.ts', [
    {
      label: 'completion gate import',
      from: "import { Zero3RemoteEvidenceCollector } from './remote-evidence'",
      to:
        "import { Zero3RemoteEvidenceCollector } from './remote-evidence'\n" +
        "import { evaluateZero3CompletionGate } from './remote-completion-gate'"
    },
    {
      label: 'authoritative completion gate before succeeded terminal',
      from:
        "      if (status === 'completed') {\n" +
        "        const gitPostflight = await runGitPostflight(this.codex, workspace, task, gitPreflight)\n" +
        "        const postflightEvidence = evidence.push('remote.git.postflight', gitEvidence(gitPostflight))\n" +
        "        if (onEvidence) await onEvidence(postflightEvidence.sequence, postflightEvidence.method, postflightEvidence.params)\n" +
        "        const executionResult = buildExecutionResult({\n" +
        "          task,\n" +
        "          mapping,\n" +
        "          state: 'succeeded',\n" +
        "          turnId,\n" +
        "          turn,\n" +
        "          preflight: gitPreflight,\n" +
        "          postflight: gitPostflight,\n" +
        "          evidence\n" +
        "        })\n" +
        "        const resultEvidence = evidence.push('remote.execution.result', executionResult)\n" +
        "        if (onEvidence) await onEvidence(resultEvidence.sequence, resultEvidence.method, resultEvidence.params)\n" +
        "        return {\n" +
        "          state: 'succeeded' as const,\n" +
        "          task,\n" +
        "          mapping,\n" +
        "          executionResult,\n" +
        "          terminal: { turnId, status },\n" +
        "          evidence: evidence.snapshot()\n" +
        "        }\n" +
        "      }",
      to:
        "      if (status === 'completed') {\n" +
        "        const gitPostflight = await runGitPostflight(this.codex, workspace, task, gitPreflight)\n" +
        "        const postflightEvidence = evidence.push('remote.git.postflight', gitEvidence(gitPostflight))\n" +
        "        if (onEvidence) await onEvidence(postflightEvidence.sequence, postflightEvidence.method, postflightEvidence.params)\n" +
        "\n" +
        "        const completionGate = evaluateZero3CompletionGate({\n" +
        "          task,\n" +
        "          turnStatus: status,\n" +
        "          agentSummary: lastAgentSummary(turn),\n" +
        "          gitPreflight,\n" +
        "          gitPostflight,\n" +
        "          executionResultReady: true\n" +
        "        })\n" +
        "        const gateEvidence = evidence.push('remote.completion.gate', completionGate)\n" +
        "        if (onEvidence) await onEvidence(gateEvidence.sequence, gateEvidence.method, gateEvidence.params)\n" +
        "\n" +
        "        if (!completionGate.ok) {\n" +
        "          const executionResult = buildExecutionResult({\n" +
        "            task,\n" +
        "            mapping,\n" +
        "            state: 'blocked',\n" +
        "            turnId,\n" +
        "            turn,\n" +
        "            preflight: gitPreflight,\n" +
        "            postflight: gitPostflight,\n" +
        "            evidence\n" +
        "          })\n" +
        "          const resultEvidence = evidence.push('remote.execution.result', executionResult)\n" +
        "          if (onEvidence) await onEvidence(resultEvidence.sequence, resultEvidence.method, resultEvidence.params)\n" +
        "          return {\n" +
        "            state: 'blocked' as const,\n" +
        "            task,\n" +
        "            mapping,\n" +
        "            executionResult,\n" +
        "            completionGate,\n" +
        "            terminal: {\n" +
        "              turnId,\n" +
        "              status: 'blocked',\n" +
        "              reason: `completion evidence gate failed; missing=${completionGate.missing.join(',') || 'none'} unsupported=${completionGate.unsupported.join(',') || 'none'}`\n" +
        "            },\n" +
        "            evidence: evidence.snapshot()\n" +
        "          }\n" +
        "        }\n" +
        "\n" +
        "        const executionResult = buildExecutionResult({\n" +
        "          task,\n" +
        "          mapping,\n" +
        "          state: 'succeeded',\n" +
        "          turnId,\n" +
        "          turn,\n" +
        "          preflight: gitPreflight,\n" +
        "          postflight: gitPostflight,\n" +
        "          evidence\n" +
        "        })\n" +
        "        const resultEvidence = evidence.push('remote.execution.result', executionResult)\n" +
        "        if (onEvidence) await onEvidence(resultEvidence.sequence, resultEvidence.method, resultEvidence.params)\n" +
        "        return {\n" +
        "          state: 'succeeded' as const,\n" +
        "          task,\n" +
        "          mapping,\n" +
        "          executionResult,\n" +
        "          completionGate,\n" +
        "          terminal: { turnId, status },\n" +
        "          evidence: evidence.snapshot()\n" +
        "        }\n" +
        "      }"
    }
  ])
}

export function applyZero3RemoteHostRuntime() {
  copyRuntimeSources()
  applyCompletionGate()

  patchFile('electron/main.ts', [
    {
      label: 'end of Electron import block',
      from: "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR",
      to:
        "import { Zero3RemoteNode } from './zero3/remote-host/index'\n\n" +
        "const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR"
    },
    {
      label: 'Electron ready boundary after Codex transport registration',
      from: "app.whenReady().then(() => {",
      to:
        "const zero3RemoteNode = new Zero3RemoteNode({\n" +
        "  startThread: params => zero3CodexAppServer.request('thread/start', params),\n" +
        "  startTurn: (params, timeoutMs) => zero3CodexAppServer.request('turn/start', params, timeoutMs),\n" +
        "  readThread: params => zero3CodexAppServer.request('thread/read', params),\n" +
        "  execCommand: (params, timeoutMs) => zero3CodexAppServer.request('command/exec', params, timeoutMs)\n" +
        "})\n" +
        "app.on('before-quit', () => zero3RemoteNode.stop())\n\n" +
        "app.whenReady().then(() => {\n" +
        "  zero3RemoteNode.start()"
    }
  ])
}
