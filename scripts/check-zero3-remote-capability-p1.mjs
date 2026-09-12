import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ZRCP P1 architecture guard: File System + Git capabilities.
//
// The P0 guard proves the transport chain is fenced. This guard proves the P1
// capabilities did not widen it: file and Git authority stays in the local Zero3
// capability runtime, the AWS gateway and the MCP catalog stay transport-only,
// and the two dangerous shapes this phase is most likely to grow by accident --
// a generic `filesystem.exec`/`git.exec` entry point and a force push -- cannot
// exist without failing here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
const requireText = (source, needle, message) => { if (!source.includes(needle)) throw new Error(message) }
const forbidText = (source, needle, message) => { if (source.includes(needle)) throw new Error(message) }

const CAPABILITY_RUNTIME_DIR = 'apps/zero3-desktop/capability-runtime'
const FILESYSTEM_CAPABILITIES = [
  'filesystem.list',
  'filesystem.stat',
  'filesystem.read',
  'filesystem.write',
  'filesystem.mkdir',
  'filesystem.copy',
  'filesystem.move',
  'filesystem.delete'
]
const GIT_CAPABILITIES = [
  'git.status',
  'git.diff',
  'git.log',
  'git.show',
  'git.add',
  'git.commit',
  'git.fetch',
  'git.push',
  'git.branch'
]

const gateway = read('apps/web/src/worker_gateway.rs')
const remoteRpc = read('apps/zero3-desktop/host-runtime/remote-worker-rpc.ts')
const remoteTypes = read('apps/zero3-desktop/host-runtime/remote-types.ts')
const lifecycle = read('apps/zero3-desktop/scripts/apply-agent-lifecycle-runtime.mjs')
const index = read(`${CAPABILITY_RUNTIME_DIR}/index.ts`)
const contracts = read(`${CAPABILITY_RUNTIME_DIR}/contracts.ts`)
const policy = read(`${CAPABILITY_RUNTIME_DIR}/policy-port.ts`)
const pathSafety = read(`${CAPABILITY_RUNTIME_DIR}/path-safety.ts`)
const filesystem = read(`${CAPABILITY_RUNTIME_DIR}/filesystem-capabilities.ts`)
const gitCapabilities = read(`${CAPABILITY_RUNTIME_DIR}/git-capabilities.ts`)
const gitRuntime = read(`${CAPABILITY_RUNTIME_DIR}/git-runtime.ts`)
const protocolDoc = read('docs/ZERO3_REMOTE_CAPABILITY_PROTOCOL.md')

const capabilityRuntimeSources = fs
  .readdirSync(path.join(root, ...CAPABILITY_RUNTIME_DIR.split('/')), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
  .map(entry => ({ name: entry.name, source: read(`${CAPABILITY_RUNTIME_DIR}/${entry.name}`) }))

// ---------------------------------------------------------------------------
// 1. Every P1 capability exists, is registered locally and is documented.
// ---------------------------------------------------------------------------
function declaredIds(source) {
  return [...source.matchAll(/'(filesystem|git)\.[a-z][a-z.]*'/gu)].map(match => match[0].slice(1, -1))
}

const filesystemIds = declaredIds(filesystem)
const gitIds = declaredIds(gitCapabilities)
for (const id of FILESYSTEM_CAPABILITIES) {
  if (!filesystemIds.includes(id)) throw new Error(`Local Zero3 filesystem capability is missing: ${id}`)
}
for (const id of GIT_CAPABILITIES) {
  if (!gitIds.includes(id)) throw new Error(`Local Zero3 Git capability is missing: ${id}`)
}
if (filesystemIds.length !== FILESYSTEM_CAPABILITIES.length) {
  throw new Error(`P1 filesystem capability set changed without architecture review: ${filesystemIds.join(', ')}`)
}
if (gitIds.length !== GIT_CAPABILITIES.length) {
  throw new Error(`P1 Git capability set changed without architecture review: ${gitIds.join(', ')}`)
}

requireText(index, 'createZero3FileSystemCapabilities', 'Capability Runtime must compose the local filesystem capabilities.')
requireText(index, 'createZero3GitCapabilities', 'Capability Runtime must compose the local Git capabilities.')
requireText(
  index,
  'registry.register(capability.definition, capability.handler)',
  'Registration must go through the single Zero3CapabilityRegistry, not a second dispatch table.'
)
requireText(index, 'registry.register(systemStatusDefinition', 'P1 must not regress the P0 system.status capability.')
requireText(index, 'registry.register(powerShellDefinition', 'P1 must not regress the P0 PowerShell capability.')
requireText(index, 'new Zero3OperationRuntime(', 'P1 capabilities must reuse the P0 Operation Runtime.')
for (const forbidden of ['class Zero3OperationRuntime', 'class Zero3OperationStore', 'class Zero3CapabilityRegistry']) {
  for (const { name, source } of capabilityRuntimeSources) {
    if (name === 'operation-runtime.ts' || name === 'operation-store.ts' || name === 'registry.ts') continue
    forbidText(source, forbidden, `P1 must reuse the P0 runtime instead of redefining ${forbidden} in ${name}.`)
  }
}

for (const id of [...FILESYSTEM_CAPABILITIES, ...GIT_CAPABILITIES]) {
  requireText(protocolDoc, `\`${id}\``, `ZRCP protocol document must list the P1 capability ${id}.`)
}

// ---------------------------------------------------------------------------
// 2. The MCP catalog stays the five generic ZRCP tools.
// ---------------------------------------------------------------------------
requireText(gateway, 'const CAPABILITY_TOOLS: [&str; 5]', 'ZRCP catalog size changed without architecture review.')
for (const tool of ['list_capabilities', 'describe_capability', 'invoke_capability', 'get_operation', 'cancel_operation']) {
  requireText(gateway, `"${tool}"`, `Generic ZRCP tool disappeared from the AWS gateway: ${tool}`)
}
for (const id of [...FILESYSTEM_CAPABILITIES, ...GIT_CAPABILITIES]) {
  forbidText(gateway, `"${id}"`, `P1 capability ${id} must never become an MCP top-level tool.`)
}
for (const name of ['filesystem_read', 'filesystem_write', 'filesystem_list', 'git_status', 'git_diff', 'git_commit', 'git_push']) {
  forbidText(gateway, `"${name}"`, `P1 must not publish an MCP tool named ${name}; Web GPT calls invoke_capability.`)
  forbidText(remoteRpc, name, `The tunnel RPC adapter must not publish a per-action P1 tool ${name}.`)
}

// ---------------------------------------------------------------------------
// 3. AWS stays transport-only: no filesystem, process or Git execution.
// ---------------------------------------------------------------------------
// The gateway may persist its own bounded RPC correlation state (its request
// directory and OAuth/token files). What it must never gain is a process
// primitive, a caller-directed filesystem operation, or local policy authority.
for (const forbidden of [
  'std::process::Command',
  'std::process::Stdio',
  'tokio::process',
  'Command::new',
  'powershell',
  'pwsh',
  'cmd.exe'
]) {
  forbidText(gateway, forbidden, `AWS Worker Gateway must stay transport-only and never gain local executor authority: ${forbidden}`)
}
if (/fs::[a-z_]+\([^)]*\b(?:arguments|params|request_body)\b/u.test(gateway)) {
  throw new Error('AWS Worker Gateway filesystem calls must stay on gateway-owned state, never on an RPC-supplied path.')
}
for (const forbidden of ['filesystem.exec', 'git.exec', 'capability_policy', 'ZERO3_CAPABILITY_ALLOWED_ROOTS', 'capability-runtime']) {
  forbidText(gateway, forbidden, `AWS Worker Gateway must not hold P1 execution or policy authority: ${forbidden}`)
}
requireText(gateway, 'REMOTE_CAPABILITY => CAPABILITY_TOOLS.contains(&tool)', 'ZRCP stays a gateway protocol selector, not an execution path.')

// ---------------------------------------------------------------------------
// 4. No generic exec shape anywhere in the capability runtime.
// ---------------------------------------------------------------------------
const spawningModules = capabilityRuntimeSources.filter(entry => /execFile\(\s*'git'/u.test(entry.source))
if (spawningModules.length !== 1 || spawningModules[0].name !== 'git-runtime.ts') {
  throw new Error(`Exactly one capability-runtime module may shell out to Git; found: ${spawningModules.map(entry => entry.name).join(', ') || 'none'}`)
}
// The reviewed capability id set is closed. An id such as `filesystem.exec` or
// `git.exec` therefore cannot be introduced without failing here first.
const declaredP1Ids = new Set([...FILESYSTEM_CAPABILITIES, ...GIT_CAPABILITIES])
for (const { name, source } of capabilityRuntimeSources) {
  for (const match of source.matchAll(/'(?:filesystem|git)\.[a-z][a-z.]*'/gu)) {
    const id = match[0].slice(1, -1)
    if (!declaredP1Ids.has(id)) throw new Error(`Undeclared P1 capability id in ${name}: ${id}`)
  }
}
const processModules = capabilityRuntimeSources.filter(entry => /(execFile|spawn)\(/u.test(entry.source))
for (const { name, source } of capabilityRuntimeSources) {
  forbidText(source, 'shell: true', `Capability execution must never enable a shell (${name}).`)
  forbidText(source, 'shell:true', `Capability execution must never enable a shell (${name}).`)
  forbidText(source, 'execSync', `Capability execution must stay asynchronous and cancellable (${name}).`)
}
const unexpectedProcessModules = processModules
  .map(entry => entry.name)
  .filter(name => name !== 'git-runtime.ts' && name !== 'powershell-capability.ts')
if (unexpectedProcessModules.length > 0) {
  throw new Error(`Only the reviewed local executors may start a child process; found: ${unexpectedProcessModules.join(', ')}`)
}
requireText(gitRuntime, 'execFile(', 'Git must execute through execFile with an argument array.')
requireText(gitRuntime, 'shell: false', 'Git must execute with shell:false.')
requireText(gitRuntime, 'GIT_TERMINAL_PROMPT', 'Git must fail closed instead of prompting for credentials.')
requireText(gitRuntime, 'assertGitRef', 'Git refs must be validated, not interpolated.')
requireText(filesystem, 'zero3AtomicWriteFile', 'filesystem.write must reuse the reviewed atomic writer.')
forbidText(filesystem, 'fs.writeFileSync', 'filesystem.write must not bypass the atomic writer.')

// ---------------------------------------------------------------------------
// 5. Force push does not exist, and push always names an explicit refspec.
// ---------------------------------------------------------------------------
for (const source of [gitCapabilities, gitRuntime]) {
  forbidText(source, "'--force'", 'P1 must not gain a force-push argument.')
  forbidText(source, "'--force-with-lease'", 'P1 must not gain a force-with-lease argument.')
  forbidText(source, "'-f'", 'P1 must not gain a short force flag.')
  forbidText(source, "'+", 'P1 must not build a + (forced) refspec.')
}
requireText(gitCapabilities, 'refs/heads/${branch}:refs/heads/${branch}', 'Push must use one explicit, non-forced refspec.')
requireText(gitCapabilities, 'PUSH_REJECTED', 'A diverged remote must fail closed instead of rewriting history.')

// ---------------------------------------------------------------------------
// 6. Every mutation stays inside the local policy and path authority.
// ---------------------------------------------------------------------------
requireText(policy, 'class EnvironmentZero3CapabilityPolicy', 'Capability execution must pass through the local policy port.')
requireText(policy, 'READ_ONLY_CAPABILITIES', 'Local policy must classify read capabilities.')
requireText(policy, 'PROJECT_WRITE_CAPABILITIES', 'Local policy must classify project-scope writes.')
requireText(policy, 'CONFIRMATION_CAPABILITIES', 'Local policy must classify confirmation-gated mutations.')
for (const id of ['filesystem.delete', 'filesystem.move', 'git.commit', 'git.push', 'git.fetch']) {
  requireText(policy, `'${id}'`, `Local policy must classify ${id}.`)
}
requireText(policy, "'read_only'", 'Local policy must keep a read-only mode.')
requireText(policy, "id === 'system.status'", 'P1 must not regress the P0 system.status policy rule.')
requireText(pathSafety, 'path.relative(', 'Path containment must be computed with path.relative, never a string prefix.')
requireText(pathSafety, 'realpath', 'Path containment must re-check the real path so symlink escapes fail closed.')
requireText(pathSafety, 'SYMLINK_ESCAPE', 'Symlink escape must be an explicit, named refusal.')
requireText(pathSafety, 'PATH_OUTSIDE_ALLOWED_ROOTS', 'Leaving the allowed roots must be an explicit, named refusal.')
requireText(pathSafety, 'UNC_PATH_NOT_ALLOWED', 'UNC paths must be refused unless a UNC root is allow-listed.')
requireText(pathSafety, 'toLowerCase()', 'Windows path comparison must be case-insensitive.')
requireText(filesystem, 'expectedSha256', 'filesystem.write must support optimistic concurrency.')
requireText(filesystem, 'FILE_CHANGED', 'A concurrent write must fail closed instead of overwriting.')
requireText(filesystem, 'CANNOT_DELETE_ALLOWED_ROOT', 'An allow-listed root must never be deletable.')
requireText(filesystem, 'UNSUPPORTED_BINARY', 'Binary content must be refused, not silently decoded.')
requireText(filesystem, 'FILE_TOO_LARGE', 'Oversized reads and writes must be refused explicitly.')
requireText(gitCapabilities, 'UNRELATED_STAGED_CHANGES', 'git.commit must refuse staged work it was not told about.')
requireText(gitCapabilities, 'NOTHING_STAGED', 'git.commit must not fabricate a commit with an empty index.')

// ---------------------------------------------------------------------------
// 7. Response size is bounded locally, before the gateway 2 MiB body cap.
// ---------------------------------------------------------------------------
for (const needle of ['MAX_LIST_ENTRIES', 'MAX_READ_BYTES', 'MAX_WRITE_BYTES']) {
  requireText(filesystem, needle, `Filesystem payloads must be bounded locally: ${needle}`)
}
requireText(gitCapabilities, 'MAX_DIFF_BYTES', 'Git diffs must be bounded locally.')
requireText(gitCapabilities, 'MAX_LOG_LIMIT', 'Git history must be bounded locally.')
requireText(gitRuntime, 'MAX_GIT_OUTPUT_BYTES', 'Git child output must be bounded locally.')

// ---------------------------------------------------------------------------
// 8. Worker Protocol and the generated Electron overlay are unchanged in shape.
// ---------------------------------------------------------------------------
for (const forbidden of ['filesystem.read', 'filesystem.write', 'filesystem.exec', 'git.status', 'git.exec']) {
  forbidText(remoteRpc, forbidden, `Worker Protocol adapter must not grow a P1 executor: ${forbidden}`)
  forbidText(remoteTypes, forbidden, `Worker Protocol types must not grow a P1 executor: ${forbidden}`)
}
requireText(remoteTypes, 'Zero3CapabilityRpcTool', 'ZRCP tools must stay separate from Worker Protocol tools.')
requireText(remoteRpc, 'verify_commit', 'P1 must not remove the reviewed Worker Protocol Git path.')
requireText(lifecycle, 'capabilityTargetDir', 'Prepared Electron must receive the capability runtime.')
requireText(lifecycle, 'createZero3CapabilityRuntime', 'Prepared Electron must compose the local Capability Runtime.')
requireText(lifecycle, "endsWith('.test.ts')", 'The capability overlay must copy production sources and skip tests.')
forbidText(lifecycle, 'filesystem-capabilities.ts', 'The capability overlay must copy by directory scan so new P1 modules cannot be forgotten.')
for (const { name } of capabilityRuntimeSources) {
  if (name.includes('/')) throw new Error(`capability-runtime modules must stay flat so the generated overlay cannot skip ${name}`)
}

// ---------------------------------------------------------------------------
// 9. Contracts keep the reviewed capability shape.
// ---------------------------------------------------------------------------
for (const field of ['id', 'version', 'name', 'description', 'category', 'status', 'provider', 'nodeId', 'supportsCancellation', 'requiresApproval', 'inputSchema', 'outputSchema']) {
  requireText(contracts, `${field}:`, `Capability definitions must keep the reviewed field ${field}.`)
}
for (const source of [filesystem, gitCapabilities]) {
  requireText(source, "executionMode: 'local'", 'P1 capabilities must declare local execution.')
  requireText(source, "provider: 'zero3-local'", 'P1 capabilities must declare the local Zero3 provider.')
  requireText(source, 'inputSchema', 'P1 capabilities must publish an input schema.')
  requireText(source, 'outputSchema', 'P1 capabilities must publish an output schema.')
}

console.log(
  'Zero3 Remote Capability Protocol P1 guard passed: 8 filesystem + 9 structured Git capabilities are registered only in the local Zero3 runtime, AWS and the MCP catalog stay transport-only, path containment is realpath-based, writes are atomic and conflict-checked, commits cannot sweep up unrelated staged work, and no force push exists.'
)
