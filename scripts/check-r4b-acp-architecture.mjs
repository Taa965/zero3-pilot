import fs from 'node:fs'

const root = 'apps/zero3-desktop/executor-runtime/acp'
const read = file => fs.readFileSync(`${root}/${file}`, 'utf8')
const executor = read('acp-executor.ts')
const transport = read('acp-jsonl-client.ts')
const local = read('local-adapter.ts')
const manifest = JSON.parse(read('compatibility-pins.json'))
const all = [executor, transport, local, read('acp-session-store.ts'), read('acp-types.ts')].join('\n')
const requireText = (source, text, message) => { if (!source.includes(text)) throw new Error(message) }
const forbidText = (source, text, message) => { if (source.includes(text)) throw new Error(message) }

requireText(executor, 'implements Zero3Executor', 'R4B must implement frozen Zero3Executor')
requireText(executor, "kind: 'external-agent'", 'R4B must remain an external executor')
requireText(transport, "protocolVersion: 1", 'R4B must negotiate ACP v1')
requireText(executor, "'session/new'", 'ACP start path missing session/new')
requireText(executor, "'session/load'", 'ACP resume path missing session/load')
requireText(transport, "method === 'session/request_permission'", 'ACP permission bridge missing')
requireText(executor, 'refusing implicit approval', 'permission option mismatch must fail closed')
requireText(local, 'manifest.version !== spec.packageVersion', 'exact package version gate missing')
requireText(local, 'manifest.name !== spec.packageName', 'exact package name gate missing')
forbidText(local, 'npx', 'R4B may not launch adapters through npx')
forbidText(all, '@latest', 'R4B may not resolve runtime @latest')
forbidText(all, 'npm install', 'R4B runtime may not install packages')
forbidText(all, 'https://registry.npmjs.org', 'R4B runtime may not query package registry')
forbidText(all, 'child_process.exec(', 'R4B may not use generic shell exec')
forbidText(all, 'shell: true', 'R4B adapter launch may not use shell=true')
forbidText(all, 'failurePolicyFor(', 'provider must not own Router failover policy')
forbidText(all, 'WorkspaceWriterGate', 'provider must not own Handoff writer authority')
forbidText(all, "kind: 'native-codex'", 'external ACP executor cannot claim Native Codex authority')

const resumeStart = executor.indexOf('async resume(')
const promptStart = executor.indexOf('async *prompt(', resumeStart)
if (resumeStart < 0 || promptStart < 0) throw new Error('R4B resume boundary missing')
const resumeBody = executor.slice(resumeStart, promptStart)
if (resumeBody.includes("'session/new'")) throw new Error('R4B resume must never silently create a new ACP session')
if (!resumeBody.includes("'session/load'")) throw new Error('R4B resume must use ACP session/load')

if (manifest.schemaVersion !== 'zero3.pilot.acp.compatibility.v1' || manifest.status !== 'frozen-exact-pins') throw new Error('R4B compatibility manifest is not frozen')
for (const version of [manifest.protocol?.sdk?.version, manifest.runtime?.version, manifest.adapters?.claude?.version, manifest.adapters?.codexExternal?.version]) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`R4B dependency version is not exact: ${String(version)}`)
}
if (manifest.adapters?.codexExternal?.nativeAgentKernelAuthority !== false) throw new Error('external Codex ACP must never claim Native Agent Kernel authority')

const sharedFiles = [
  'apps/zero3-desktop/executor-runtime/executor-types.ts',
  'apps/zero3-desktop/executor-runtime/executor-manager.ts',
  'apps/zero3-desktop/executor-runtime/executor-router.ts'
]
for (const file of sharedFiles) {
  const source = fs.readFileSync(file, 'utf8')
  for (const leak of ['@agentclientprotocol', 'acpx', 'claude-agent-acp', 'AcpExternalExecutor']) {
    if (source.includes(leak)) throw new Error(`R4B type/provider leakage into shared file ${file}: ${leak}`)
  }
}

console.log('Zero3 Pilot R4B ACP external executor architecture guard passed.')
