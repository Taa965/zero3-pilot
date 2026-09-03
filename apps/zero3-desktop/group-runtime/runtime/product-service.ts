import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Zero3ExecutorManager } from '../../executor-runtime/executor-manager.ts'
import { Zero3ExecutorRegistry } from '../../executor-runtime/executor-registry.ts'
import type { ExecutorEvent, ExecutorPermissionResponse } from '../../executor-runtime/executor-types.ts'
import { buildHandoffCheckpoint } from '../../executor-runtime/handoff/handoff-builder.ts'
import type { Zero3HandoffCheckpointV1 } from '../../executor-runtime/handoff/handoff-types.ts'
import { NativeCodexAppServerDriver, type NativeCodexAppServerTransport } from '../../executor-runtime/native/native-app-server-driver.ts'
import { NativeCodexExecutor } from '../../executor-runtime/native/native-codex-executor.ts'
import { assertGroupCompletable, buildCompletionProof } from '../completion/index.ts'
import {
  ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
  validateSessionStateTransition,
  type DevelopmentDelivery,
  type DevelopmentGroupPolicy,
  type DevelopmentSessionDefinition,
  type DevelopmentSessionRuntime,
  type FailureRecord,
  type GroupCompletionProof,
  type IntegrationMilestone,
  type RepairTask,
  type VerificationCommand,
  type VerificationRun
} from '../contracts/index.ts'
import { DevelopmentGroupController } from '../controller/index.ts'
import { IntegrationController, IntegrationGitAdapter, IntegrationQueue } from '../integration/index.ts'
import type { RequirementProposal } from '../planning/index.ts'
import { DevelopmentSessionRunner } from '../session/index.ts'
import { DevelopmentGroupStore, readDurableJson, writeDurableJson } from '../store/index.ts'
import { buildDevelopmentGroupViewModel, type DevelopmentGroupViewModel } from '../ui/index.ts'
import {
  attributeFailure,
  executeVerification,
  planRepairWave,
  type FailureObservation,
  type FailureSignal,
  type VerificationCommandExecutor,
  type VerificationPlatform
} from '../verification/index.ts'
import { computeDeliveryHash, GitWorkspaceAdapter, verifyDevelopmentDelivery, type DeliveryGateResult } from '../workspace/index.ts'

const execFileAsync = promisify(execFile)
const PRODUCT_RECORD_SCHEMA = 'zero3.pilot.development-group-product.v1' as const
const VERIFICATION_POLICY_SCHEMA = 'zero3.pilot.verification-policy.v1' as const
const ACTIVE_RUNTIME_STATES = new Set<DevelopmentSessionRuntime['status']>(['starting', 'running', 'waiting_input'])
const TERMINAL_RUNTIME_STATES = new Set<DevelopmentSessionRuntime['status']>(['verified', 'cancelled', 'superseded'])
const RETRYABLE_RUNTIME_STATES = new Set<DevelopmentSessionRuntime['status']>(['blocked', 'failed'])

export interface ProductVerificationPolicy {
  schema: typeof VERIFICATION_POLICY_SCHEMA
  revision: string
  commands: readonly VerificationCommand[]
}

interface ProductRecord {
  schema: typeof PRODUCT_RECORD_SCHEMA
  repositoryRoot: string
  verificationPolicyHash: string
  createdAt: string
}

export interface ProductRequirementInput {
  title: string
  description?: string
  acceptanceCriteria?: readonly string[]
  pathHints?: readonly string[]
  tags?: readonly string[]
  dependencies?: readonly string[]
  mandatory?: boolean
}

export interface CreateDevelopmentGroupInput {
  repositoryRoot: string
  masterGoal: string
  developmentPlan: string
  requirements: readonly ProductRequirementInput[]
  maxParallelSessions?: number
  maxSessionSubagents?: number
  permissionProfile?: DevelopmentGroupPolicy['permissionProfile']
}

export interface DevelopmentGroupProductEvent {
  type: 'group.changed' | 'executor.event' | 'runtime.error'
  groupId: string
  sessionId?: string
  event?: ExecutorEvent
  detail?: string
}

export interface DevelopmentGroupProductSnapshot {
  view: DevelopmentGroupViewModel
  completion?: GroupCompletionProof
  verificationPolicy: { revision: string; mandatoryTests: readonly string[] }
}

export interface FinalizeDeliveryInput {
  groupId: string
  sessionId: string
  testsAdded?: readonly string[]
  testsExecuted?: readonly string[]
  artifacts?: readonly string[]
  knownIssues?: readonly string[]
  downstreamNotes?: readonly string[]
}

export interface FinalizeDeliveryResult {
  accepted: boolean
  gate: DeliveryGateResult
  delivery?: DevelopmentDelivery
  handoffCheckpointHash?: string
}

function assertNonEmpty(value: string, label: string, max = 16_384): string {
  const text = value.trim()
  if (!text || text.length > max) throw new Error(`${label} is required and must be at most ${max} characters`)
  return text
}

function boundedPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value == null) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`value must be an integer between 1 and ${max}`)
  return value
}

function boundedStrings(values: readonly string[] | undefined, label: string, maxItems = 256): string[] {
  const items = (values ?? []).map((value, index) => assertNonEmpty(value, `${label}[${index}]`, 8192))
  if (items.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`)
  return [...new Set(items)]
}

function platformName(): VerificationPlatform {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return 'linux'
}

function canonicalHash(value: unknown): string {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize)
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]))
    }
    return entry
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function resolveInside(root: string, candidate: string): string {
  const absoluteRoot = resolve(root)
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(absoluteRoot, candidate)
  const rel = relative(absoluteRoot, absolute)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`path escapes repository root: ${candidate}`)
  }
  return absolute
}

function absoluteSession(repositoryRoot: string, session: DevelopmentSessionDefinition): DevelopmentSessionDefinition {
  return { ...session, worktree: resolveInside(repositoryRoot, session.worktree) }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readRecords<T>(directory: string, predicate: (name: string) => boolean = name => name.endsWith('.json')): Promise<T[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return Promise.all(names.filter(predicate).sort().map(name => readDurableJson<T>(join(directory, name))))
}

function parseArgv(command: string): readonly string[] {
  let value: unknown
  try {
    value = JSON.parse(command)
  } catch {
    throw new Error('verification command must be a JSON argv array, for example ["node","script.mjs"]')
  }
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('verification command must be a non-empty JSON array of non-empty strings')
  }
  if (value.length > 64 || value.some(item => item.length > 8192)) throw new Error('verification argv exceeds product limits')
  return value as string[]
}

class ShelllessVerificationExecutor implements VerificationCommandExecutor {
  constructor(private readonly repositoryRoot: string) {}

  async run(command: VerificationCommand): Promise<{ exitCode: number; evidence: readonly string[] }> {
    const argv = parseArgv(command.command)
    const cwd = command.cwd ? resolveInside(this.repositoryRoot, command.cwd) : this.repositoryRoot
    try {
      const result = await execFileAsync(argv[0], [...argv.slice(1)], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        maxBuffer: 16 * 1024 * 1024
      })
      return { exitCode: 0, evidence: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).map(text => text.slice(-16_384)) }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
      if (typeof failure.code !== 'number') throw error
      return {
        exitCode: failure.code,
        evidence: [failure.stdout?.trim(), failure.stderr?.trim(), failure.message.trim()].filter(Boolean).map(text => String(text).slice(-16_384))
      }
    }
  }
}

async function loadVerificationPolicy(repositoryRoot: string): Promise<{ policy: ProductVerificationPolicy; hash: string }> {
  const file = join(repositoryRoot, '.zero3', 'verification-policy.json')
  let policy: ProductVerificationPolicy
  try {
    policy = JSON.parse(await readFile(file, 'utf8')) as ProductVerificationPolicy
  } catch (error) {
    throw new Error(`cannot read frozen verification policy ${file}: ${String(error)}`)
  }
  if (policy.schema !== VERIFICATION_POLICY_SCHEMA) throw new Error(`unsupported verification policy schema in ${file}`)
  assertNonEmpty(policy.revision, 'verification policy revision', 256)
  if (!Array.isArray(policy.commands) || policy.commands.length === 0) throw new Error('verification policy commands are required')
  const ids = new Set<string>()
  for (const command of policy.commands) {
    assertNonEmpty(command.id, 'verification command id', 128)
    if (ids.has(command.id)) throw new Error(`duplicate verification command id: ${command.id}`)
    ids.add(command.id)
    parseArgv(command.command)
  }
  return { policy, hash: canonicalHash(policy) }
}

function productRecordPath(store: DevelopmentGroupStore, groupId: string): string {
  return join(store.groupDir(groupId), 'product.json')
}

function handoffPath(store: DevelopmentGroupStore, groupId: string, sessionId: string): string {
  return join(store.groupDir(groupId), 'deliveries', `${sessionId}.handoff.json`)
}

function completionPath(store: DevelopmentGroupStore, groupId: string): string {
  return join(store.groupDir(groupId), 'completion.json')
}

function requirementProposal(input: ProductRequirementInput, index: number): RequirementProposal {
  const title = assertNonEmpty(input.title, `requirements[${index}].title`, 512)
  const description = assertNonEmpty(input.description ?? title, `requirements[${index}].description`, 4096)
  const acceptanceCriteria = (input.acceptanceCriteria ?? [`${title} is implemented and verified`]).map((value, criterionIndex) =>
    assertNonEmpty(value, `requirements[${index}].acceptanceCriteria[${criterionIndex}]`, 2048)
  )
  return {
    id: `REQ-${String(index + 1).padStart(3, '0')}`,
    title,
    description,
    mandatory: input.mandatory ?? true,
    acceptanceCriteria,
    sourceAnchor: `product:create#requirement-${index + 1}`,
    dependencies: boundedStrings(input.dependencies, `requirements[${index}].dependencies`),
    pathHints: boundedStrings(input.pathHints, `requirements[${index}].pathHints`),
    tags: boundedStrings(input.tags, `requirements[${index}].tags`)
  }
}

function handoffConstraints(session: DevelopmentSessionDefinition): string[] {
  return [
    `baseline=${session.baselineSha}`,
    `integration_ref=${session.integrationRef}`,
    ...session.ownedPaths.map(path => `owned:${path}`),
    ...session.readOnlyPaths.map(path => `read_only:${path}`),
    ...session.forbiddenPaths.map(path => `forbidden:${path}`),
    'delivery_contract=zero3.pilot.development-delivery.v1',
    `subagent_max=${session.subagentPolicy.maxConcurrency}`,
    'recursive_group_creation=false'
  ]
}

function signalForRuntime(runtime: DevelopmentSessionRuntime): FailureSignal {
  if (runtime.status === 'outcome_unknown') return 'outcome_unknown'
  const blocker = runtime.blocker ?? ''
  if (blocker.includes('permission_denied') || blocker.includes('policy_denied')) return 'permission_denied'
  if (blocker.startsWith('integration:')) return 'integration_conflict'
  if (blocker.includes('dependency')) return 'dependency_failed'
  return runtime.status === 'failed' ? 'command_failed' : 'unknown'
}

export class DevelopmentGroupProductService {
  readonly store: DevelopmentGroupStore
  readonly controller: DevelopmentGroupController
  readonly executorManager: Zero3ExecutorManager
  readonly #listeners = new Set<(event: DevelopmentGroupProductEvent) => void>()
  readonly #runners = new Map<string, DevelopmentSessionRunner>()
  readonly #activeTasks = new Map<string, Promise<void>>()
  readonly #reconciled = new Set<string>()

  constructor(storeRoot: string, codexTransport: NativeCodexAppServerTransport) {
    this.store = new DevelopmentGroupStore(resolve(storeRoot))
    this.controller = new DevelopmentGroupController(this.store)
    const registry = new Zero3ExecutorRegistry()
    registry.register(new NativeCodexExecutor(new NativeCodexAppServerDriver({ transport: codexTransport })))
    this.executorManager = new Zero3ExecutorManager(registry)
  }

  subscribe(listener: (event: DevelopmentGroupProductEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  private emit(event: DevelopmentGroupProductEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event) } catch (error) { console.error('Development Group product listener failed', error) }
    }
  }

  async create(input: CreateDevelopmentGroupInput): Promise<DevelopmentGroupProductSnapshot> {
    const repositoryRoot = resolve(assertNonEmpty(input.repositoryRoot, 'repositoryRoot', 4096))
    if (!(await exists(join(repositoryRoot, '.git')))) throw new Error('repositoryRoot must point to a local Git worktree root')
    const git = new GitWorkspaceAdapter(repositoryRoot)
    const [baselineSha, integrationRef, verification] = await Promise.all([
      git.resolveHead(),
      git.currentBranch(),
      loadVerificationPolicy(repositoryRoot)
    ])
    const requirements = input.requirements.map(requirementProposal)
    if (requirements.length === 0 || requirements.length > 200) throw new Error('Development Group requires between 1 and 200 Requirements')
    const mandatoryTests = verification.policy.commands.filter(command => command.required).map(command => command.id)
    const policy: DevelopmentGroupPolicy = {
      maxParallelSessions: boundedPositiveInt(input.maxParallelSessions, 6, 12),
      maxSessionAttempts: 3,
      maxRepairSessions: 3,
      maxRepairWaves: 3,
      maxSameFailureAttempts: 2,
      maxSessionSubagents: boundedPositiveInt(input.maxSessionSubagents, 4, 8),
      permissionProfile: input.permissionProfile ?? 'standard',
      completionMode: 'strict',
      verificationPolicyRevision: verification.policy.revision,
      targetBranch: integrationRef,
      protectedPaths: ['.git/**', '.zero3/**'],
      mandatoryTests
    }
    const masterGoal = assertNonEmpty(input.masterGoal, 'masterGoal', 16_384)
    const developmentPlan = assertNonEmpty(input.developmentPlan || masterGoal, 'developmentPlan', 100_000)
    const plan = await this.controller.createGroup(
      {
        repository: repositoryRoot,
        masterGoal,
        masterPrompt: masterGoal,
        developmentPlan,
        baselineSha,
        integrationRef,
        policy
      },
      { requirements }
    )
    const product: ProductRecord = {
      schema: PRODUCT_RECORD_SCHEMA,
      repositoryRoot,
      verificationPolicyHash: verification.hash,
      createdAt: new Date().toISOString()
    }
    await writeDurableJson(productRecordPath(this.store, plan.definition.groupId), product)
    this.emit({ type: 'group.changed', groupId: plan.definition.groupId, detail: 'created' })
    return this.get(plan.definition.groupId)
  }

  async list(): Promise<DevelopmentGroupProductSnapshot[]> {
    const ids = await this.store.listGroupIds()
    const snapshots: DevelopmentGroupProductSnapshot[] = []
    for (const id of ids) snapshots.push(await this.get(id))
    return snapshots.sort((left, right) => right.view.summary.groupId.localeCompare(left.view.summary.groupId))
  }

  async get(groupId: string): Promise<DevelopmentGroupProductSnapshot> {
    await this.reconcileInterrupted(groupId)
    const plan = await this.controller.loadPlan(groupId)
    const [state, runtimes, deliveries, integrations, verifications, failures, repairs, product, completion] = await Promise.all([
      this.controller.resumeGroup(groupId),
      Promise.all(plan.sessions.map(session => this.store.loadSession(groupId, session.sessionId))),
      readRecords<DevelopmentDelivery>(join(this.store.groupDir(groupId), 'deliveries'), name => name.endsWith('.json') && !name.endsWith('.handoff.json')),
      readRecords<IntegrationMilestone>(join(this.store.groupDir(groupId), 'integration')),
      readRecords<VerificationRun>(join(this.store.groupDir(groupId), 'verification')),
      readRecords<FailureRecord>(join(this.store.groupDir(groupId), 'repair'), name => name.startsWith('failure-') && name.endsWith('.json')),
      readRecords<RepairTask>(join(this.store.groupDir(groupId), 'repair'), name => !name.startsWith('failure-') && name.endsWith('.json')),
      readDurableJson<ProductRecord>(productRecordPath(this.store, groupId)),
      readDurableJson<GroupCompletionProof>(completionPath(this.store, groupId)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error))
    ])
    if (product.schema !== PRODUCT_RECORD_SCHEMA || product.repositoryRoot !== plan.definition.repository) throw new Error('Development Group product metadata is invalid')
    return {
      view: buildDevelopmentGroupViewModel({
        definition: plan.definition,
        state,
        requirements: plan.requirements,
        sessions: plan.sessions,
        runtimes,
        deliveries,
        waves: plan.waves,
        integrations,
        verifications,
        failures,
        repairs
      }),
      completion,
      verificationPolicy: {
        revision: plan.definition.policy.verificationPolicyRevision,
        mandatoryTests: [...plan.definition.policy.mandatoryTests]
      }
    }
  }

  async startSession(groupId: string, sessionId: string): Promise<DevelopmentSessionRuntime> {
    await this.reconcileInterrupted(groupId)
    const key = `${groupId}:${sessionId}`
    if (this.#activeTasks.has(key)) throw new Error(`Development Session ${sessionId} already has an active turn`)
    const plan = await this.controller.loadPlan(groupId)
    const session = plan.sessions.find(candidate => candidate.sessionId === sessionId)
    if (!session) throw new Error(`unknown Development Session ${sessionId}`)
    const runtimeSession = absoluteSession(plan.definition.repository, session)
    let runtime = await this.store.loadSession(groupId, sessionId)

    const [runtimes, deliveries, integrations] = await Promise.all([
      Promise.all(plan.sessions.map(item => this.store.loadSession(groupId, item.sessionId))),
      readRecords<DevelopmentDelivery>(join(this.store.groupDir(groupId), 'deliveries'), name => name.endsWith('.json') && !name.endsWith('.handoff.json')),
      readRecords<IntegrationMilestone>(join(this.store.groupDir(groupId), 'integration'))
    ])
    const acceptedDeliverySessions = new Set(deliveries.map(delivery => delivery.sessionId))
    const integratedSessions = new Set(integrations.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
    const waveEvidence = new Map(plan.waves.map(wave => [wave.waveId, {
      waveId: wave.waveId,
      integrationValid: wave.requiredSessionIds.every(id => integratedSessions.has(id)),
      requiredDeliveriesValid: wave.requiredSessionIds.every(id => acceptedDeliverySessions.has(id)),
      ownershipValid: wave.requiredSessionIds.every(id => acceptedDeliverySessions.has(id))
    }] as const))
    const runningSessionCount = runtimes.filter(item => ACTIVE_RUNTIME_STATES.has(item.status)).length
    const schedule = await this.controller.schedule(groupId, waveEvidence, runningSessionCount)
    if (!schedule.readySessionIds.includes(sessionId)) throw new Error(`Development Session ${sessionId} is not scheduler-ready`)

    const repositoryGit = new GitWorkspaceAdapter(plan.definition.repository)
    if (!(await exists(runtimeSession.worktree))) {
      await repositoryGit.createSessionWorktree(runtimeSession.worktree, session.branch, session.baselineSha)
    }
    const runner = new DevelopmentSessionRunner(
      plan.definition,
      runtimeSession,
      plan.requirements,
      this.executorManager,
      { save: next => this.store.writeSession(next) },
      {
        onExecutorEvent: async event => {
          this.emit({ type: 'executor.event', groupId, sessionId, event })
          this.emit({ type: 'group.changed', groupId, sessionId, detail: event.type })
        }
      },
      runtime
    )
    this.#runners.set(key, runner)
    if (runtime.status === 'waiting_dependencies') {
      await runner.markReady()
      runtime = runner.snapshot()
    }
    await this.controller.record(groupId, 'wave.started', undefined, session.waveId)
    await runner.start()
    await this.controller.record(groupId, 'session.started', sessionId, session.waveId)
    const task = runner.sendInitialInstruction(`dg:${groupId}:${sessionId}:${randomUUID()}`)
      .then(() => undefined)
      .catch(error => {
        this.emit({ type: 'runtime.error', groupId, sessionId, detail: error instanceof Error ? error.message : String(error) })
      })
      .finally(async () => {
        this.#activeTasks.delete(key)
        const snapshot = runner.snapshot()
        if (snapshot.status === 'blocked' || snapshot.status === 'failed' || snapshot.status === 'outcome_unknown') {
          await this.recordSessionFailure(groupId, sessionId, snapshot).catch(error => {
            this.emit({ type: 'runtime.error', groupId, sessionId, detail: `failure_record_error: ${String(error)}` })
          })
          await runner.close().catch(() => undefined)
          this.#runners.delete(key)
        }
        this.emit({ type: 'group.changed', groupId, sessionId, detail: 'turn.finished' })
      })
    this.#activeTasks.set(key, task)
    this.emit({ type: 'group.changed', groupId, sessionId, detail: 'started' })
    return runner.snapshot()
  }

  async retrySession(groupId: string, sessionId: string): Promise<DevelopmentSessionRuntime> {
    const plan = await this.controller.loadPlan(groupId)
    const runtime = await this.store.loadSession(groupId, sessionId)
    if (!RETRYABLE_RUNTIME_STATES.has(runtime.status)) throw new Error(`only blocked/failed Sessions may be retried; got ${runtime.status}`)
    if (runtime.attempt >= plan.definition.policy.maxSessionAttempts) throw new Error('Session attempt budget exhausted')
    const repairs = await readRecords<RepairTask>(join(this.store.groupDir(groupId), 'repair'), name => !name.startsWith('failure-') && name.endsWith('.json'))
    const repair = repairs
      .filter(task => task.status === 'planned' && task.ownerSessionIds.includes(sessionId))
      .sort((left, right) => right.waveOrdinal - left.waveOrdinal)[0]
    if (!repair) throw new Error('no bounded planned RepairTask authorizes this Session retry; human review is required')
    const next = await this.writeSessionStatus(runtime, 'ready', { blocker: undefined })
    await this.store.writeRepair({ ...repair, status: 'running' })
    this.emit({ type: 'group.changed', groupId, sessionId, detail: `retry.authorized:${repair.repairTaskId}` })
    return next
  }

  async respondPermission(groupId: string, sessionId: string, response: ExecutorPermissionResponse): Promise<void> {
    const runner = this.#runners.get(`${groupId}:${sessionId}`)
    if (!runner) throw new Error('no live Development Session runner owns this permission request')
    await runner.respondPermission(response)
    this.emit({ type: 'group.changed', groupId, sessionId, detail: `permission.${response.decision}` })
  }

  async cancelSession(groupId: string, sessionId: string): Promise<void> {
    const key = `${groupId}:${sessionId}`
    const runner = this.#runners.get(key)
    if (runner) {
      await runner.cancel()
      this.#runners.delete(key)
    } else {
      const runtime = await this.store.loadSession(groupId, sessionId)
      if (!TERMINAL_RUNTIME_STATES.has(runtime.status)) await this.writeSessionStatus(runtime, 'cancelled')
    }
    this.emit({ type: 'group.changed', groupId, sessionId, detail: 'cancelled' })
  }

  async finalizeDelivery(input: FinalizeDeliveryInput): Promise<FinalizeDeliveryResult> {
    const plan = await this.controller.loadPlan(input.groupId)
    const session = plan.sessions.find(candidate => candidate.sessionId === input.sessionId)
    if (!session) throw new Error(`unknown Development Session ${input.sessionId}`)
    const runtime = await this.store.loadSession(input.groupId, input.sessionId)
    if (runtime.status !== 'delivering') throw new Error(`Delivery can be finalized only from delivering; got ${runtime.status}`)
    if (!runtime.executorId || !runtime.executorSessionId || !runtime.executorGeneration) throw new Error('Session executor identity is incomplete')

    const runtimeSession = absoluteSession(plan.definition.repository, session)
    const git = new GitWorkspaceAdapter(runtimeSession.worktree)
    const headSha = await git.resolveHead()
    const [branch, changedPaths, status] = await Promise.all([
      git.currentBranch(),
      git.changedPaths(session.baselineSha, headSha),
      git.status()
    ])
    if (branch !== session.branch) throw new Error(`Session worktree branch mismatch: expected ${session.branch}, got ${branch}`)
    if (headSha === session.baselineSha) throw new Error('Session has no committed change relative to the frozen baseline')
    if (status.length > 0) throw new Error('Session worktree must be clean before Delivery finalization; commit or discard pending changes first')

    const testsAdded = boundedStrings(input.testsAdded, 'testsAdded')
    const testsExecuted = boundedStrings(input.testsExecuted, 'testsExecuted')
    const artifacts = boundedStrings(input.artifacts, 'artifacts')
    const knownIssues = boundedStrings(input.knownIssues, 'knownIssues')
    const downstreamNotes = boundedStrings(input.downstreamNotes, 'downstreamNotes')
    const checkpoint = await buildHandoffCheckpoint({
      taskId: `${input.groupId}:${session.sessionId}`,
      executionId: session.executionId,
      workspace: runtimeSession.worktree,
      repoId: plan.definition.repository,
      baseSha: session.baselineSha,
      objective: session.objective,
      constraints: handoffConstraints(session),
      acceptanceCriteria: session.acceptanceCriteria,
      completed: session.requirements.map(id => `requirement:${id}`),
      inProgress: [],
      remaining: knownIssues,
      testsRun: testsExecuted,
      testResults: testsExecuted.map(name => ({ name, status: 'unknown' as const, detail: 'Delivery-reported; final VerificationRun is authoritative.' })),
      pendingApprovals: [],
      lastExecutor: runtime.executorId,
      lastSessionId: runtime.executorSessionId,
      stopReason: 'development_delivery',
      nextAction: 'delivery_gate_then_controlled_integration',
      previousGeneration: Math.max(0, runtime.executorGeneration - 1)
    })
    const unsigned: DevelopmentDelivery = {
      contract: ZERO3_DEVELOPMENT_DELIVERY_CONTRACT,
      groupId: input.groupId,
      sessionId: session.sessionId,
      executionId: session.executionId,
      status: 'completed',
      baseSha: session.baselineSha,
      headSha,
      changedPaths: [...changedPaths],
      requirements: [...session.requirements],
      testsAdded,
      testsExecuted,
      artifacts,
      knownIssues,
      downstreamNotes,
      handoffCheckpoint: checkpoint.checkpoint_hash,
      deliveryHash: '',
      createdAt: new Date().toISOString()
    }
    const delivery: DevelopmentDelivery = { ...unsigned, deliveryHash: computeDeliveryHash(unsigned) }
    const gate = await verifyDevelopmentDelivery({ delivery, session: runtimeSession, git, handoff: { checkpoint } })
    if (gate.decision !== 'DELIVERY_ACCEPT') {
      await this.controller.record(input.groupId, 'delivery.rejected', session.sessionId, session.waveId, gate.reasons.join('; '))
      return { accepted: false, gate }
    }
    await Promise.all([
      this.store.writeDelivery(delivery),
      writeDurableJson(handoffPath(this.store, input.groupId, session.sessionId), checkpoint)
    ])
    await this.writeSessionStatus(runtime, 'delivered', { headSha: delivery.headSha, blocker: undefined })
    await this.resolveSessionFailures(input.groupId, session.sessionId)
    await this.controller.record(input.groupId, 'session.delivered', session.sessionId, session.waveId, delivery.deliveryHash)
    const runner = this.#runners.get(`${input.groupId}:${session.sessionId}`)
    if (runner) {
      await runner.close().catch(() => undefined)
      this.#runners.delete(`${input.groupId}:${session.sessionId}`)
    }
    this.emit({ type: 'group.changed', groupId: input.groupId, sessionId: session.sessionId, detail: 'delivery.accepted' })
    return { accepted: true, gate, delivery, handoffCheckpointHash: checkpoint.checkpoint_hash }
  }

  async integrate(groupId: string): Promise<readonly IntegrationMilestone[]> {
    const plan = await this.controller.loadPlan(groupId)
    const deliveries = await readRecords<DevelopmentDelivery>(join(this.store.groupDir(groupId), 'deliveries'), name => name.endsWith('.json') && !name.endsWith('.handoff.json'))
    const existing = await readRecords<IntegrationMilestone>(join(this.store.groupDir(groupId), 'integration'))
    const integratedSessions = new Set(existing.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
    const mergedDeliveryHashes = new Set(existing.filter(record => record.status === 'merged').flatMap(record => record.deliveryHashes))
    const queue = new IntegrationQueue()
    for (const delivery of deliveries) {
      if (mergedDeliveryHashes.has(delivery.deliveryHash)) continue
      const session = plan.sessions.find(candidate => candidate.sessionId === delivery.sessionId)
      if (!session) throw new Error(`Delivery references unknown Session ${delivery.sessionId}`)
      queue.enqueue(absoluteSession(plan.definition.repository, session), delivery, plan.waves)
    }
    if (queue.snapshot().length === 0) return []
    await this.controller.record(groupId, 'integration.started')
    const integration = new IntegrationController(
      queue,
      new IntegrationGitAdapter(plan.definition.repository),
      {
        verify: async item => {
          const handoff = await readDurableJson<Zero3HandoffCheckpointV1>(handoffPath(this.store, groupId, item.session.sessionId))
          return verifyDevelopmentDelivery({ delivery: item.delivery, session: item.session, git: new GitWorkspaceAdapter(item.session.worktree), handoff: { checkpoint: handoff } })
        }
      },
      this.store,
      { integrationRef: plan.definition.integrationRef, initialIntegratedSessionIds: [...integratedSessions] }
    )
    const records = await integration.drainUntilBlocked()
    for (const record of records) {
      if (record.status === 'merged') {
        for (const sessionId of record.mergedSessionIds) {
          let runtime = await this.store.loadSession(groupId, sessionId)
          if (runtime.status === 'delivered') runtime = await this.writeSessionStatus(runtime, 'integrating')
          if (runtime.status === 'integrating') await this.writeSessionStatus(runtime, 'integrated', { headSha: record.headSha })
        }
        await this.controller.record(groupId, 'integration.merged', undefined, undefined, record.headSha)
      } else {
        const failedDelivery = deliveries.find(delivery => record.deliveryHashes.includes(delivery.deliveryHash))
        if (failedDelivery) {
          const runtime = await this.store.loadSession(groupId, failedDelivery.sessionId)
          const blocker = `integration:${record.integrationRunId}:${record.conflicts.join('; ') || record.status}`
          if (runtime.status === 'delivered' || runtime.status === 'integrating') {
            const blocked = await this.writeSessionStatus(runtime, 'blocked', { blocker })
            await this.recordSessionFailure(groupId, failedDelivery.sessionId, blocked)
          }
        } else {
          await this.controller.record(groupId, 'session.blocked', undefined, undefined, `integration:${record.integrationRunId}:${record.conflicts.join('; ')}`)
        }
      }
    }
    this.emit({ type: 'group.changed', groupId, detail: 'integration.finished' })
    return records
  }

  async verify(groupId: string): Promise<{ verification: VerificationRun; completion?: GroupCompletionProof; completionIssues: readonly string[] }> {
    const plan = await this.controller.loadPlan(groupId)
    const product = await readDurableJson<ProductRecord>(productRecordPath(this.store, groupId))
    const runtimes = await Promise.all(plan.sessions.map(session => this.store.loadSession(groupId, session.sessionId)))
    const incomplete = runtimes.filter(runtime => runtime.status !== 'integrated' && runtime.status !== 'verified')
    if (incomplete.length > 0) throw new Error(`final verification requires every Session integrated: ${incomplete.map(runtime => `${runtime.sessionId}=${runtime.status}`).join(', ')}`)

    const currentPolicy = await loadVerificationPolicy(product.repositoryRoot)
    if (currentPolicy.hash !== product.verificationPolicyHash) throw new Error('verification policy changed after Group planning; create a reviewed new Group or restore the frozen policy')
    if (currentPolicy.policy.revision !== plan.definition.policy.verificationPolicyRevision) throw new Error('verification policy revision does not match frozen Group policy')
    const integrationGit = new IntegrationGitAdapter(product.repositoryRoot)
    if ((await integrationGit.currentBranch()) !== plan.definition.integrationRef) throw new Error('final verification workspace is on the wrong integration branch')
    if (!(await integrationGit.statusClean())) throw new Error('final verification requires a clean integration worktree')
    const currentHead = await integrationGit.currentHead()
    await this.controller.record(groupId, 'verification.started', undefined, undefined, currentHead)
    const verification = await executeVerification(
      {
        groupId,
        integrationSha: currentHead,
        policyRevision: currentPolicy.policy.revision,
        commands: currentPolicy.policy.commands,
        mandatoryCommandIds: plan.definition.policy.mandatoryTests,
        environment: { node: process.version },
        platform: platformName()
      },
      new ShelllessVerificationExecutor(product.repositoryRoot)
    )
    const postHead = await integrationGit.currentHead()
    const postClean = await integrationGit.statusClean()
    if (postHead !== currentHead || !postClean) {
      verification.status = 'failed'
      verification.environment = { ...verification.environment, workspacePostcondition: postHead !== currentHead ? `head_changed:${postHead}` : 'worktree_dirty' }
    }
    await this.store.writeVerification(verification)
    if (verification.status !== 'passed') {
      await this.controller.record(groupId, 'verification.failed', undefined, undefined, verification.verificationRunId)
      await this.recordVerificationFailures(groupId, verification, plan.sessions)
      if (verification.status === 'outcome_unknown') await this.markGroupOutcomeUnknown(groupId)
      this.emit({ type: 'group.changed', groupId, detail: `verification.${verification.status}` })
      return { verification, completionIssues: [`verification_status=${verification.status}`] }
    }

    const integrations = await readRecords<IntegrationMilestone>(join(this.store.groupDir(groupId), 'integration'))
    const verifiedSessions = new Set(integrations.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
    for (const sessionId of verifiedSessions) {
      const runtime = await this.store.loadSession(groupId, sessionId)
      if (runtime.status === 'integrated') await this.writeSessionStatus(runtime, 'verified')
    }
    const repairs = await readRecords<RepairTask>(join(this.store.groupDir(groupId), 'repair'), name => !name.startsWith('failure-') && name.endsWith('.json'))
    for (const repair of repairs) {
      if (repair.status === 'delivered') await this.store.writeRepair({ ...repair, status: 'verified' })
    }
    const completion = await this.tryComplete(groupId, currentHead)
    this.emit({ type: 'group.changed', groupId, detail: completion.issues.length === 0 ? 'completed' : 'verification.passed' })
    return {
      verification,
      completion: completion.issues.length === 0 ? completion.proof : undefined,
      completionIssues: completion.issues.map(issue => `${issue.code}@${issue.path}: ${issue.message}`)
    }
  }

  private async recordSessionFailure(groupId: string, sessionId: string, runtime: DevelopmentSessionRuntime): Promise<void> {
    const plan = await this.controller.loadPlan(groupId)
    const observation: FailureObservation = {
      groupId,
      signal: signalForRuntime(runtime),
      message: runtime.blocker ?? `${sessionId} ${runtime.status}`,
      evidence: [`session=${sessionId}`, `attempt=${runtime.attempt}`, `status=${runtime.status}`],
      involvedSessionIds: [sessionId],
      attempts: runtime.attempt
    }
    const failure: FailureRecord = { ...attributeFailure(observation, plan.sessions), sessionId }
    await this.store.writeFailure(failure)
    if (runtime.status === 'outcome_unknown') {
      await this.markGroupOutcomeUnknown(groupId)
      return
    }
    await this.controller.record(groupId, 'session.blocked', sessionId, plan.sessions.find(session => session.sessionId === sessionId)?.waveId, `session:${sessionId}:${failure.failureId}:${failure.message}`)
    await this.planRepairs(groupId, [failure])
  }

  private async recordVerificationFailures(groupId: string, verification: VerificationRun, sessions: readonly DevelopmentSessionDefinition[]): Promise<void> {
    const failures: FailureRecord[] = []
    for (const result of verification.results.filter(result => result.status !== 'passed')) {
      const signal: FailureSignal = result.status === 'not_run_platform' ? 'environment_unavailable' : result.status === 'not_run' ? 'outcome_unknown' : 'command_failed'
      failures.push(attributeFailure({
        groupId,
        verificationRunId: verification.verificationRunId,
        signal,
        message: `verification ${result.commandId} ${result.status}`,
        evidence: result.evidence,
        involvedSessionIds: [],
        attempts: 1
      }, sessions))
    }
    if (failures.length === 0) {
      failures.push(attributeFailure({
        groupId,
        verificationRunId: verification.verificationRunId,
        signal: verification.status === 'outcome_unknown' ? 'outcome_unknown' : 'unknown',
        message: 'verification failed its workspace or execution postcondition',
        evidence: Object.entries(verification.environment).map(([key, value]) => `${key}=${value}`),
        involvedSessionIds: [],
        attempts: 1
      }, sessions))
    }
    for (const failure of failures) await this.store.writeFailure(failure)
    if (verification.status !== 'outcome_unknown') await this.planRepairs(groupId, failures)
  }

  private async planRepairs(groupId: string, failures: readonly FailureRecord[]): Promise<readonly RepairTask[]> {
    const [plan, state] = await Promise.all([this.controller.loadPlan(groupId), this.store.loadState(groupId)])
    if (state.repairWaveCount >= plan.definition.policy.maxRepairWaves) return []
    const tasks = planRepairWave({
      groupId,
      waveOrdinal: state.repairWaveCount + 1,
      failures,
      policy: plan.definition.policy
    })
    for (const task of tasks) await this.store.writeRepair(task)
    if (tasks.length > 0) await this.controller.record(groupId, 'repair.created', undefined, undefined, tasks.map(task => task.repairTaskId).join(','))
    return tasks
  }

  private async resolveSessionFailures(groupId: string, sessionId: string): Promise<void> {
    const failures = await readRecords<FailureRecord>(join(this.store.groupDir(groupId), 'repair'), name => name.startsWith('failure-') && name.endsWith('.json'))
    for (const failure of failures) {
      if (failure.unresolved && (failure.sessionId === sessionId || failure.ownerSessionIds.includes(sessionId))) {
        await this.store.writeFailure({ ...failure, unresolved: false })
      }
    }
    const repairs = await readRecords<RepairTask>(join(this.store.groupDir(groupId), 'repair'), name => !name.startsWith('failure-') && name.endsWith('.json'))
    for (const repair of repairs) {
      if (!repair.ownerSessionIds.includes(sessionId) || (repair.status !== 'planned' && repair.status !== 'running')) continue
      const ownerRuntimes = await Promise.all(repair.ownerSessionIds.map(ownerId => this.store.loadSession(groupId, ownerId)))
      if (ownerRuntimes.every(runtime => ['delivered', 'integrating', 'integrated', 'verified'].includes(runtime.status))) {
        await this.store.writeRepair({ ...repair, status: 'delivered' })
      }
    }
  }

  private async markGroupOutcomeUnknown(groupId: string): Promise<void> {
    const state = await this.store.loadState(groupId)
    if (state.status === 'outcome_unknown') return
    await this.store.writeState({ ...state, status: 'outcome_unknown', outcomeUnknownCount: state.outcomeUnknownCount + 1, updatedAt: new Date().toISOString() })
  }

  private async tryComplete(groupId: string, finalIntegrationSha: string) {
    const plan = await this.controller.loadPlan(groupId)
    const [state, runtimes, deliveries, integrations, verifications] = await Promise.all([
      this.store.loadState(groupId),
      Promise.all(plan.sessions.map(session => this.store.loadSession(groupId, session.sessionId))),
      readRecords<DevelopmentDelivery>(join(this.store.groupDir(groupId), 'deliveries'), name => name.endsWith('.json') && !name.endsWith('.handoff.json')),
      readRecords<IntegrationMilestone>(join(this.store.groupDir(groupId), 'integration')),
      readRecords<VerificationRun>(join(this.store.groupDir(groupId), 'verification'))
    ])
    const validDeliveryHashes = new Set(integrations.filter(record => record.status === 'merged').flatMap(record => record.deliveryHashes))
    const result = buildCompletionProof({
      groupId,
      policy: plan.definition.policy,
      requirements: plan.requirements,
      sessions: plan.sessions,
      runtimes,
      deliveries,
      validDeliveryHashes,
      integrations,
      verifications,
      finalIntegrationSha,
      unresolvedBlockers: state.unresolvedBlockers
    })
    if (result.issues.length === 0) {
      const proof = assertGroupCompletable(result)
      await writeDurableJson(completionPath(this.store, groupId), proof)
      await this.controller.record(groupId, 'group.completed', undefined, undefined, proof.finalIntegrationSha)
    }
    return result
  }

  private async reconcileInterrupted(groupId: string): Promise<void> {
    if (this.#reconciled.has(groupId)) return
    this.#reconciled.add(groupId)
    const plan = await this.controller.loadPlan(groupId)
    let count = 0
    for (const session of plan.sessions) {
      const runtime = await this.store.loadSession(groupId, session.sessionId)
      if (!ACTIVE_RUNTIME_STATES.has(runtime.status) || this.#runners.has(`${groupId}:${session.sessionId}`)) continue
      await this.writeSessionStatus(runtime, 'outcome_unknown', { blocker: 'desktop_restart_during_active_executor_session' })
      count += 1
    }
    if (count > 0) {
      const state = await this.store.loadState(groupId)
      await this.store.writeState({
        ...state,
        status: 'outcome_unknown',
        outcomeUnknownCount: state.outcomeUnknownCount + count,
        updatedAt: new Date().toISOString()
      })
      this.emit({ type: 'group.changed', groupId, detail: `reconciled_outcome_unknown=${count}` })
    }
  }

  private async writeSessionStatus(
    runtime: DevelopmentSessionRuntime,
    status: DevelopmentSessionRuntime['status'],
    patch: Partial<DevelopmentSessionRuntime> = {}
  ): Promise<DevelopmentSessionRuntime> {
    const issues = validateSessionStateTransition(runtime.status, status)
    if (issues.length > 0) throw new Error(issues[0].message)
    const next: DevelopmentSessionRuntime = { ...runtime, ...patch, status, updatedAt: new Date().toISOString() }
    await this.store.writeSession(next)
    return next
  }
}
