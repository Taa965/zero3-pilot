import fs from 'node:fs'
import path from 'node:path'

import { hermesDesktopDir, overlayRuntimeSource, repoRoot } from './config.mjs'
import { patchOverlaySource } from './overlay-patch.mjs'

const sourceDir = path.join(repoRoot, 'apps', 'zero3-desktop', 'host-runtime')
const targetDir = path.join(hermesDesktopDir, 'electron', 'zero3', 'remote-host')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function patchFile(relativePath, replacements, invariants = []) {
  const file = path.join(hermesDesktopDir, ...relativePath.split('/'))
  const patched = patchOverlaySource({
    relativePath,
    source: read(file),
    replacements,
    invariants,
    driftPrefix: 'Zero3 Remote Host overlay'
  })
  write(file, patched)
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
    'remote-worker-rpc.ts',
    'remote-skill-rpc.ts',
    'remote-task-runner.ts',
    'remote-node.ts',
    'index.ts'
  ]
  for (const file of files) {
    const source = path.join(sourceDir, file)
    if (!fs.statSync(source).isFile()) throw new Error(`Zero3 Remote Host source template missing: ${source}`)
    write(path.join(targetDir, file), overlayRuntimeSource(read(source)))
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

// The Remote Host node used to be constructed with the four Codex bridges and
// no Worker RPC runtime provider. A generated tree can still hold that shape,
// and the ready-boundary anchor below would then insert a second declaration
// instead of upgrading the first one -- while that legacy tree already carries
// the matching before-quit hook and the ready-boundary start, so the repair has
// to rewrite the constructor alone. The candidate is the exact legacy text
// (a shape, not a fuzzy span), so an already-upgraded tree never matches it and
// no future line in the file can be swallowed by an open-ended match.
const LEGACY_REMOTE_NODE_CONSTRUCTOR = [
  'const zero3RemoteNode = new Zero3RemoteNode({',
  "  startThread: params => zero3CodexAppServer.request('thread/start', params),",
  "  startTurn: (params, timeoutMs) => zero3CodexAppServer.request('turn/start', params, timeoutMs),",
  "  readThread: params => zero3CodexAppServer.request('thread/read', params),",
  "  execCommand: (params, timeoutMs) => zero3CodexAppServer.request('command/exec', params, timeoutMs)",
  '})',
  ''
].join('\n')

function zero3RemoteNodeConstructor() {
  return (
    "const zero3RemoteNode = new Zero3RemoteNode({\n" +
    "  listSkills: params => zero3CodexAppServer.request('skills/list', params),\n" +
    "  startThread: params => zero3CodexAppServer.request('thread/start', params),\n" +
    "  startTurn: (params, timeoutMs) => zero3CodexAppServer.request('turn/start', params, timeoutMs),\n" +
    "  readThread: params => zero3CodexAppServer.request('thread/read', params),\n" +
    "  execCommand: (params, timeoutMs) => zero3CodexAppServer.request('command/exec', params, timeoutMs)\n" +
    "}, () => zero3WorkerAdmin())\n"
  )
}

function zero3RemoteNodeRuntime() {
  return (
    zero3RemoteNodeConstructor() +
    "app.on('before-quit', () => zero3RemoteNode.stop())\n\n" +
    "app.whenReady().then(() => {\n" +
    "  zero3RemoteNode.start()"
  )
}

export function applyZero3RemoteHostRuntime() {
  copyRuntimeSources()
  applyCompletionGate()

  patchFile(
    'electron/main.ts',
    [
      {
        label: 'end of Electron import block',
        already: "from './zero3/remote-host/index'",
        from: 'const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR',
        to:
          "import { Zero3RemoteNode } from './zero3/remote-host/index'\n\n" +
          'const USER_DATA_OVERRIDE = process.env.HERMES_DESKTOP_USER_DATA_DIR',
        hint: 'Review the pinned Hermes/Codex desktop boundary before updating the upstream pin.'
      },
      {
        label: 'Electron ready boundary after Codex transport registration',
        // The Agent Lifecycle overlay upgrades the provider argument from
        // zero3WorkerAdmin() to the zero3WorkerRpcRuntime() composite, so both
        // spellings mean this boundary is already wired. The provider-less
        // legacy shape is neither, which is what routes it to the repair
        // candidate instead of to a second insertion before the ready anchor.
        alreadyAny: [zero3RemoteNodeConstructor(), '}, () => zero3WorkerRpcRuntime())'],
        // A generated tree may still carry the provider-less constructor; that
        // shape is repaired in place (it already owns the hook and the ready
        // boundary start), otherwise the fresh-tree anchor inserts the whole
        // composition before the ready boundary.
        fromAny: [
          { from: LEGACY_REMOTE_NODE_CONSTRUCTOR, to: zero3RemoteNodeConstructor() },
          'app.whenReady().then(() => {'
        ],
        to: zero3RemoteNodeRuntime(),
        hint:
          'The Codex transport overlay must expose zero3CodexAppServer and the ready boundary before this overlay runs.'
      }
    ],
    [
      { label: 'Remote Host Runtime composition point', text: 'const zero3RemoteNode = new Zero3RemoteNode(', count: 1 },
      {
        label: 'Worker RPC runtime provider argument',
        texts: ['}, () => zero3WorkerAdmin())', '}, () => zero3WorkerRpcRuntime())'],
        count: 1
      },
      { label: 'Remote Host ready-boundary start', text: 'zero3RemoteNode.start()', count: 1 },
      { label: 'Remote Host before-quit teardown', text: 'app.on(\'before-quit\', () => zero3RemoteNode.stop())', count: 1 }
    ]
  )
}
