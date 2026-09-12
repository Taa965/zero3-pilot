import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { ExecutionExecutorTarget, ExecutionSessionBindingState, ExecutionSkillPreflight, ExecutionStepDefinition, ExecutionStepStatus, ExecutionTaskDefinition } from '../contracts.ts'
import { Zero3ExecutionReporterHttpServer } from '../reporter-http.ts'
import { Zero3ExecutionReporter } from '../reporter.ts'
import { Zero3ExecutionRuntime, type BindExecutionSessionInput, type CreateExecutionTaskInput } from '../runtime.ts'
import { Zero3ExecutionStore } from '../store.ts'
import { createDefaultTaskWorkflowRegistry, Zero3TaskWorkflowRegistry } from '../workflows/registry.ts'
import type { TaskWorkflowCreateInput } from '../workflows/contracts.ts'
import type {
  ExecutionDesktopPort,
  ExecutionDesktopReporterAccess,
  ExecutionReporterTicketRequest
} from './desktop-port.ts'

export interface ExecutionSkillCapabilityProvider {
  preflight(task: ExecutionTaskDefinition, step: ExecutionStepDefinition): Promise<ExecutionSkillPreflight>
  matrix(): Promise<unknown>
}

export interface ExecutionDesktopRuntimeOptions {
  reporterClientPath: string
  reporterClientKind: 'node' | 'powershell'
  nodeExecutable?: string
  powershellExecutable?: string
  skillCapabilityProvider?: ExecutionSkillCapabilityProvider
  taskWorkflowRegistry?: Zero3TaskWorkflowRegistry
}

function loadOrCreateSecret(file: string): Buffer {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    const existing = fs.readFileSync(file)
    if (existing.byteLength < 32) throw new Error('execution reporter secret is too short')
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const created = randomBytes(48)
  try { fs.writeFileSync(file, created, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return loadOrCreateSecret(file)
  }
  return created
}

export class Zero3ExecutionDesktopRuntime implements ExecutionDesktopPort {
  readonly root: string
  readonly store: Zero3ExecutionStore
  readonly runtime: Zero3ExecutionRuntime
  readonly reporter: Zero3ExecutionReporter
  readonly reporterServer: Zero3ExecutionReporterHttpServer
  readonly taskWorkflows: Zero3TaskWorkflowRegistry
  readonly endpointFile: string
  readonly #options: ExecutionDesktopRuntimeOptions

  constructor(root: string, options: ExecutionDesktopRuntimeOptions) {
    this.root = path.resolve(root)
    this.#options = options
    if (!path.isAbsolute(options.reporterClientPath)) throw new Error('execution reporter client path must be absolute')
    this.endpointFile = path.join(this.root, 'reporter-endpoint.json')
    this.store = new Zero3ExecutionStore(path.join(this.root, 'tasks'))
    this.runtime = new Zero3ExecutionRuntime(this.store)
    this.taskWorkflows = options.taskWorkflowRegistry ?? createDefaultTaskWorkflowRegistry()
    this.reporter = new Zero3ExecutionReporter(this.runtime, loadOrCreateSecret(path.join(this.root, 'reporter-secret')))
    this.reporterServer = new Zero3ExecutionReporterHttpServer(this.reporter, { descriptorPath: this.endpointFile })
  }

  async start(): Promise<void> { await this.reporterServer.start() }
  async stop(): Promise<void> { await this.reporterServer.stop() }

  async runtimeCapabilities(): Promise<unknown> {
    const descriptor = this.reporterServer.descriptor()
    return {
      protocol: 'zero3.pilot.cross-app-execution.v1',
      reporter: {
        running: Boolean(descriptor),
        origin: descriptor?.origin ?? null,
        endpointFile: this.endpointFile,
        clientKind: this.#options.reporterClientKind,
        clientPath: this.#options.reporterClientPath
      },
      executors: ['GPT_WEB', 'GEMINI_WEB', 'CODEX', 'CLAUDE', 'ANTIGRAVITY', 'ZERO3', 'REMOTE_COMPUTE', 'HUMAN']
    }
  }

  async skillCapabilities(): Promise<unknown> {
    return this.#options.skillCapabilityProvider?.matrix() ?? { agents: [], unavailable: true }
  }

  async refreshSkillPreflight(taskId: string): Promise<unknown> {
    const provider = this.#options.skillCapabilityProvider
    if (!provider) return this.runtime.snapshot(taskId)
    const snapshot = await this.runtime.snapshot(taskId)
    const terminal = new Set(['completed', 'cancelled', 'failed', 'outcome_unknown'])
    for (const step of snapshot.definition.steps) {
      const current = snapshot.runtime.steps.find(item => item.stepId === step.stepId)
      if (!current || terminal.has(current.status)) continue
      const preflight = await provider.preflight(snapshot.definition.task, step)
      await this.runtime.recordSkillPreflight(taskId, step.stepId, preflight)
    }
    return this.runtime.snapshot(taskId)
  }

  async reconcileReadiness(taskId: string): Promise<unknown> {
    await this.refreshSkillPreflight(taskId)
    return this.runtime.reconcileReadiness(taskId)
  }

  async listTasks(): Promise<unknown> {
    const ids = await this.store.listTaskIds()
    return Promise.all(ids.map(taskId => this.runtime.snapshot(taskId)))
  }

  getTask(taskId: string): Promise<unknown> { return this.runtime.snapshot(taskId) }
  setTaskArchived(taskId: string, archived: boolean): Promise<unknown> {
    return this.runtime.setTaskArchived(taskId, archived)
  }
  deleteTask(taskId: string): Promise<unknown> {
    return this.runtime.deleteTask(taskId).then(() => ({ taskId, deleted: true }))
  }
  async listTaskWorkflows(): Promise<unknown> { return this.taskWorkflows.list() }
  createWorkflowTask(input: TaskWorkflowCreateInput): Promise<unknown> { return this.runtime.createTask(this.taskWorkflows.compile(input)) }
  createTask(input: CreateExecutionTaskInput): Promise<unknown> { return this.runtime.createTask(input) }
  addSteps(taskId: string, steps: readonly Record<string, unknown>[]): Promise<unknown> {
    return this.runtime.addSteps(taskId, steps as Parameters<Zero3ExecutionRuntime['addSteps']>[1])
  }
  createAssignment(
    taskId: string,
    stepId: string,
    executor: Exclude<ExecutionExecutorTarget, 'AUTO'>,
    executorId: string | null = null
  ): Promise<unknown> { return this.runtime.createAssignment(taskId, stepId, executor, executorId) }
  async createRoutedAssignment(taskId: string, stepId: string, executorId: string | null = null): Promise<unknown> {
    await this.refreshSkillPreflight(taskId)
    const snapshot = await this.runtime.snapshot(taskId)
    const definition = snapshot.definition.steps.find(step => step.stepId === stepId)
    const current = snapshot.runtime.steps.find(step => step.stepId === stepId)
    if (!definition || !current) throw new Error(`execution step not found: ${stepId}`)
    const target = definition.executor === 'AUTO' ? current.skillPreflight?.executor : definition.executor
    if (!target) throw new Error(`step ${stepId} has no Skill-capable routed executor`)
    return this.runtime.createAssignment(taskId, stepId, target, executorId)
  }

  bindSession(assignmentId: string, input: BindExecutionSessionInput): Promise<unknown> {
    return this.runtime.bindSession(assignmentId, input)
  }
  updateSessionState(taskId: string, bindingId: string, state: ExecutionSessionBindingState): Promise<unknown> {
    return this.runtime.updateSessionBindingState(taskId, bindingId, state)
  }
  transitionStep(taskId: string, stepId: string, status: ExecutionStepStatus, reason?: string): Promise<unknown> {
    return this.runtime.transitionStep(taskId, stepId, status, reason)
  }
  gatePassed(taskId: string, stepId: string, evidence: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    return this.runtime.gatePassed(taskId, stepId, evidence)
  }
  gateFailed(taskId: string, stepId: string, reason: string): Promise<unknown> {
    return this.runtime.gateFailed(taskId, stepId, reason)
  }

  async issueReporterTicket(
    assignmentId: string,
    request: ExecutionReporterTicketRequest = {}
  ): Promise<ExecutionDesktopReporterAccess> {
    if (!this.reporterServer.descriptor()) await this.start()
    const ticket = await this.reporter.issueTicket(assignmentId, request)
    const kind = this.#options.reporterClientKind
    const command = kind === 'powershell'
      ? (this.#options.powershellExecutable?.trim() || 'powershell.exe')
      : (this.#options.nodeExecutable?.trim() || process.execPath)
    const argsPrefix = kind === 'powershell'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.#options.reporterClientPath]
      : [this.#options.reporterClientPath]
    return { ticket, endpointFile: this.endpointFile, client: { kind, command, argsPrefix } }
  }
}

export function createExecutionDesktopRuntime(root: string, options: ExecutionDesktopRuntimeOptions): Zero3ExecutionDesktopRuntime {
  return new Zero3ExecutionDesktopRuntime(root, options)
}
