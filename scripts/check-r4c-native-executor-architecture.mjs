import fs from 'node:fs'

const files = [
  'apps/zero3-desktop/executor-runtime/native/native-driver.ts',
  'apps/zero3-desktop/executor-runtime/native/native-home.ts',
  'apps/zero3-desktop/executor-runtime/native/native-codex-executor.ts',
  'apps/zero3-desktop/executor-runtime/native/native-app-server-driver.ts'
]
const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
const executor = fs.readFileSync(files[2], 'utf8')
const driver = fs.readFileSync(files[3], 'utf8')
const home = fs.readFileSync(files[1], 'utf8')
const transportOverlay = fs.readFileSync('apps/zero3-desktop/scripts/apply-codex-transport.mjs', 'utf8')
const requireText = (text, message) => { if (!source.includes(text)) throw new Error(message) }
const forbidText = (text, message) => { if (source.includes(text)) throw new Error(message) }
const requireOverlay = (text, message) => { if (!transportOverlay.includes(text)) throw new Error(message) }

requireText('implements Zero3Executor', 'Native Codex must implement the frozen Zero3Executor contract')
requireText("kind: 'native-codex'", 'Native Codex descriptor kind missing')
requireText("createExecutorFailure(FAILURE_MAP[event.reason]", 'Native failures must normalize into frozen taxonomy')
requireText("'context_lost'", 'resume failure must fail closed as context_lost')
requireText("'thread/resume'", 'Native driver must resume existing Codex Thread')
requireText("'thread/start'", 'Native driver must start Codex Thread through app-server')
requireText("'turn/start'", 'Native driver must start Codex Turn through app-server')
requireText("'account/read'", 'Native subscription must be proven by app-server account/read')
requireText("'account/rateLimits/read'", 'Native availability must check app-server rate limits')
requireText("'modelProvider/capabilities/read'", 'Native availability must check provider capabilities')
requireText('interface NativeCodexAppServerTransport', 'Native driver must consume the existing app-server transport seam')
requireText('transport: NativeCodexAppServerTransport', 'Native driver must receive an injected app-server transport')
requireText('this.#transport.subscribe(', 'Native driver must observe the existing app-server lifecycle/request stream')
requireText('this.#transport.respondToServerRequest(', 'permission decisions must return through the existing app-server response path')
requireText("? 'accept'", 'approve_once mapping missing')
requireText("? 'acceptForSession'", 'approve_session mapping missing')
requireText(": 'decline'", 'deny mapping missing')
requireText("'item/commandExecution/requestApproval'", 'command approval forwarding missing')
requireText("'item/fileChange/requestApproval'", 'file approval forwarding missing')
requireText("const explicit = String(env.ZERO3_NATIVE_CODEX_HOME", 'explicit native home seam missing')
requireText("return path.join(homeDir, '.codex')", 'host Codex home fallback missing')
requireText('nativeCodexAppServerEnv(', 'per-executor app-server environment seam missing')
requireText("refreshToken: false", 'account/read must not request token refresh')

requireOverlay('class Zero3CodexAppServer', 'R4C must reuse the existing Zero3CodexAppServer implementation')
requireOverlay('function createZero3CodexAppServer(options: Zero3CodexAppServerOptions = {})', 'shared per-executor app-server factory missing')
requireOverlay('this.launchEnv = options.env ?? process.env', 'app-server instance must own its launch environment')
requireOverlay('env: this.launchEnv', 'app-server spawn must use the instance launch environment')
requireOverlay('subscribe(listener: Zero3CodexEventListener)', 'existing app-server must expose an in-process event subscription seam')
requireOverlay('const zero3CodexAppServer = createZero3CodexAppServer()', 'legacy/default app-server singleton must remain intact')

for (const forbidden of [
  'auth.json', 'accessToken', 'refresh_token', 'access_token', 'readFile(', 'writeFile(',
  '@agentclientprotocol', 'acpx', 'claude-agent-sdk', 'process.env.CODEX_HOME =',
  'ZERO3_CODEX_HOME =', 'copyFile(', 'cpSync(', "from 'node:child_process'", 'spawn(',
  "['app-server', '--stdio']", 'ZERO3_CODEX_BIN'
]) forbidText(forbidden, `R4C forbidden duplicated runtime/credential coupling: ${forbidden}`)

const resumeStart = executor.indexOf('async resume(')
const promptStart = executor.indexOf('async *prompt(', resumeStart)
if (resumeStart < 0 || promptStart < 0) throw new Error('Native executor resume boundary missing')
const resumeBody = executor.slice(resumeStart, promptStart)
if (resumeBody.includes('startThread(')) throw new Error('Native resume must never silently create a replacement Thread')
if (home.includes('process.env.CODEX_HOME =')) throw new Error('Native home seam must not mutate process-global CODEX_HOME')

console.log('Zero3 Pilot R4C Native Codex executor architecture guard passed.')
