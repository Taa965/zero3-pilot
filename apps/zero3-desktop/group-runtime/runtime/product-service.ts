import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Zero3ExecutorManager } from '../../executor-runtime/executor-manager.ts'
import { Zero3ExecutorRegistry } from '../../executor-runtime/executor-registry.ts'
import type { ExecutorEvent, ExecutorPermissionResponse } from '../../executor-runtime/executor-types.ts'
import { NativeCodexAppServerDriver, type NativeCodexAppServerTransport } from '../../executor-runtime/native/native-app-server-driver.ts'
import { NativeCodexExecutor } from '../../executor-runtime/native/native-codex-executor.ts'
import type { Zero3HandoffCheckpointV1 } from '../../executor-runtime/handoff/handoff-types.ts'
import { assertGroupCompletable, buildCompletionProof } from '../completion/index.ts'
import {
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
import { readDurableJson, writeDurableJson, DevelopmentGroupStore } from '../store/index.ts'
import { buildDevelopmentGroupViewModel, type DevelopmentGroupViewModel } from '../ui/index.ts'
import { executeVerification, type VerificationCommandExecutor, type VerificationPlatform } from '../verification/index.ts'
import { GitWorkspaceAdapter, verifyDevelopmentDelivery, type DeliveryGateResult } from '../workspace/index.ts'

const execFileAsync = promisify(execFile)
const PRODUCT_RECORD_SCHEMA = 'zero3.pilot.development-group-product.v1' as const
const VERIFICATION_POLICY_SCHEMA = 'zero3.pilot.verification-policy.v1' as const
const ACTIVE_RUNTIME_STATES = new Set<DevelopmentSessionRuntime['status']>(['starting', 'running', 'waiting_input'])
const TERMINAL_RUNTIME_STATES = new Set<DevelopmentSessionRuntime['status']>(['verified', 'cancelled', 'superseded'])

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

export interface AcceptDeliveryInput {
  groupId: string
  delivery: DevelopmentDelivery
  handoff: Zero3HandoffCheckpointV1
}

export interface AcceptDeliveryResult {
  accepted: boolean
  gate: DeliveryGateResult
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
  const selected = names.filter(predicate).sort()
  return Promise.all(selected.map(name => readDurableJson<T>(join(directory, name))))
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
    const executable = argv[0]
    const args = argv.slice(1)
    const cwd = command.cwd ? resolveInside(this.repositoryRoot, command.cwd) : this.repositoryRoot
    try {
      const result = await execFileAsync(executable, [...args], {
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
  const policy = await readDurableJson<ProductVerificationPolicy>(file)
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
    dependencies: [...(input.dependencies ?? [])],
    pathHints: [...(input.pathHints ?? [])],
    tags: [...(input.tags ?? [])]
  }
}

export class DevelopmentGroupProductService {
  readonly store: DevelopmentGroupStore
  readonly controller: DevelopmentGroupController
  readonly executorManager: Zero3ExecutorManager
  readonly #listeners = new Set<(event: DevelopmentGroupProductEvent) => void>()
  readonly #runners = new Map<string, Awaited<ReturnType<DevelopmentGroupController['sessionRunner']>>>()
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
    const repositoryRoot = plan.definition.repository
    const runtimeSession = absoluteSession(repositoryRoot, session)
    const runtime = await this.store.loadSession(groupId, sessionId)
    if (runtime.status === 'waiting_dependencies') {
      const dependencies = await Promise.all(session.dependencies.map(id => this.store.loadSession(groupId, id)))
      if (dependencies.some(item => !['delivered', 'integrating', 'integrated', 'verified'].includes(item.status))) {
        throw new Error('Development Session dependencies have not produced integration-eligible evidence')
      }
    }
    const activeCount = (await Promise.all(plan.sessions.map(item => this.store.loadSession(groupId, item.sessionId))))
      .filter(item => ['starting', 'running', 'waiting_input'].includes(item.status)).length
    if (activeCount >= plan.definition.policy.maxParallelSessions) throw new Error('Development Group parallel Session budget is full')

    const worktreeGit = new GitWorkspaceAdapter(repositoryRoot)
    if (!(await exists(runtimeSession.worktree))) {
      await worktreeGit.createSessionWorktree(runtimeSession.worktree, session.branch, session.baselineSha)
    }
    const runner = await this.controller.sessionRunner(groupId, sessionId, this.executorManager)
    const runtimeRunner = new (runner.constructor as typeof runner.constructor)(
      runner.group,
      runtimeSession,
      runner.requirements,
      this.executorManager,
      { save: next => this.store.writeSession(next) },
      {
        onExecutorEvent: async event => {
          this.emit({ type: 'executor.event', groupId, sessionId, event })
          this.emit({ type: 'group.changed', groupId, sessionId, detail: event.type })
        }
      },
      runtime
    ) as typeof runner
    this.#runners.set(key, runtimeRunner)
    if (runtimeRunner.snapshot().status === 'waiting_dependencies') await runtimeRunner.markReady()
    await runtimeRunner.start()
    await this.controller.record(groupId, 'session.started', sessionId, session.waveId)
    const task = runtimeRunner.sendInitialInstruction(`dg:${groupId}:${sessionId}:${randomUUID()}`)
      .then(() => undefined)
      .catch(error => {
        this.emit({ type: 'runtime.error', groupId, sessionId, detail: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        this.#activeTasks.delete(key)
        this.emit({ type: 'group.changed', groupId, sessionId, detail: 'turn.finished' })
      })
    this.#activeTasks.set(key, task)
    this.emit({ type: 'group.changed', groupId, sessionId, detail: 'started' })
    return runtimeRunner.snapshot()
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

  async acceptDelivery(input: AcceptDeliveryInput): Promise<AcceptDeliveryResult> {
    const plan = await this.controller.loadPlan(input.groupId)
    const session = plan.sessions.find(candidate => candidate.sessionId === input.delivery.sessionId)
    if (!session) throw new Error(`unknown Development Session ${input.delivery.sessionId}`)
    const runtimeSession = absoluteSession(plan.definition.repository, session)
    const gate = await verifyDevelopmentDelivery({
      delivery: input.delivery,
      session: runtimeSession,
      git: new GitWorkspaceAdapter(runtimeSession.worktree),
      handoff: { checkpoint: input.handoff }
    })
    if (gate.decision !== 'DELIVERY_ACCEPT') return { accepted: false, gate }
    await Promise.all([
      this.store.writeDelivery(input.delivery),
      writeDurableJson(handoffPath(this.store, input.groupId, session.sessionId), input.handoff)
    ])
    const runtime = await this.store.loadSession(input.groupId, session.sessionId)
    if (runtime.status !== 'delivering') throw new Error(`accepted Delivery requires Session status delivering; got ${runtime.status}`)
    await this.writeSessionStatus(runtime, 'delivered', { headSha: input.delivery.headSha, blocker: undefined })
    await this.controller.record(input.groupId, 'session.delivered', session.sessionId, session.waveId, input.delivery.deliveryHash)
    const runner = this.#runners.get(`${input.groupId}:${session.sessionId}`)
    if (runner) {
      await runner.close().catch(() => undefined)
      this.#runners.delete(`${input.groupId}:${session.sessionId}`)
    }
    this.emit({ type: 'group.changed', groupId: input.groupId, sessionId: session.sessionId, detail: 'delivery.accepted' })
    return { accepted: true, gate }
  }

  async integrate(groupId: string): Promise<readonly IntegrationMilestone[]> {
    const plan = await this.controller.loadPlan(groupId)
    const deliveries = await readRecords<DevelopmentDelivery>(join(this.store.groupDir(groupId), 'deliveries'), name => name.endsWith('.json') && !name.endsWith('.handoff.json'))
    const existing = await readRecords<IntegrationMilestone>(join(this.store.groupDir(groupId), 'integration'))
    const integrated = new Set(existing.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
    const queue = new IntegrationQueue()
    for (const delivery of deliveries) {
      if (integrated.has(delivery.sessionId)) continue
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
          return verifyDevelopmentDelivery({
            delivery: item.delivery,
            session: item.session,
            git: new GitWorkspaceAdapter(item.session.worktree),
            handoff: { checkpoint: handoff }
          })
        }
      },
      this.store,
      { integrationRef: plan.definition.integrationRef, initialIntegratedSessionIds: [...integrated] }
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
        await this.controller.record(groupId, 'session.blocked', undefined, undefined, record.conflicts.join('; '))
      }
    }
    this.emit({ type: 'group.changed', groupId, detail: 'integration.finished' })
    return records
  }

  async verify(groupId: string): Promise<{ verification: VerificationRun; completion?: GroupCompletionProof; completionIssues: readonly string[] }> {
    const plan = await this.controller.loadPlan(groupId)
    const product = await readDurableJson<ProductRecord>(productRecordPath(this.store, groupId))
    const currentPolicy = await loadVerificationPolicy(product.repositoryRoot)
    if (currentPolicy.hash !== product.verificationPolicyHash) throw new Error('verification policy changed after Group planning; create a reviewed new Group or restore the frozen policy')
    if (currentPolicy.policy.revision !== plan.definition.policy.verificationPolicyRevision) throw new Error('verification policy revision does not match frozen Group policy')
    const currentHead = await new IntegrationGitAdapter(product.repositoryRoot).currentHead()
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
    await this.store.writeVerification(verification)
    if (verification.status !== 'passed') {
      await this.controller.record(groupId, 'verification.failed', undefined, undefined, verification.verificationRunId)
      this.emit({ type: 'group.changed', groupId, detail: `verification.${verification.status}` })
      return { verification, completionIssues: [`verification_status=${verification.status}`] }
    }

    const integrations = await readRecords<IntegrationMilestone>(join(this.store.groupDir(groupId), 'integration'))
    const verifiedSessions = new Set(integrations.filter(record => record.status === 'merged').flatMap(record => record.mergedSessionIds))
    for (const sessionId of verifiedSessions) {
      const runtime = await this.store.loadSession(groupId, sessionId)
      if (runtime.status === 'integrated') await this.writeSessionStatus(runtime, 'verified')
    }
    const completion = await this.tryComplete(groupId, currentHead)
    this.emit({ type: 'group.changed', groupId, detail: completion.issues.length === 0 ? 'completed' : 'verification.passed' })
    return {
      verification,
      completion: completion.issues.length === 0 ? completion.proof : undefined,
      completionIssues: completion.issues.map(issue => `${issue.code}@${issue.path}: ${issue.message}`)
    }
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
