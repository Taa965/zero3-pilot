import { execFile } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Zero3ExecutorManager } from '../../executor-runtime/executor-manager.ts'
import { Zero3ExecutorRegistry } from '../../executor-runtime/executor-registry.ts'
import type { ExecutorPermissionResponse } from '../../executor-runtime/executor-types.ts'
import { HandoffStore } from '../../executor-runtime/handoff/handoff-store.ts'
import { NativeCodexAppServerDriver, type NativeCodexAppServerTransport } from '../../executor-runtime/native/native-app-server-driver.ts'
import { NativeCodexExecutor } from '../../executor-runtime/native/native-codex-executor.ts'
import type { DevelopmentGroupDefinition, DevelopmentSessionDefinition, DevelopmentSessionRuntime, VerificationCommand } from '../contracts/index.ts'
import { IntegrationGitAdapter } from '../integration/index.ts'
import type { ControllerPlanningProposal, PlanningRequest } from '../planning/index.ts'
import {
  DevelopmentGroupRuntimeFacade,
  HandoffStoreEvidenceResolver,
  WorkspaceDeliveryMaterializer,
  WorkspaceRuntimeDeliveryVerifier,
  resolveSessionOutcomeUnknown,
  retryDevelopmentSession,
  type OutcomeUnknownResolution
} from '../runtime/index.ts'
import { DevelopmentGroupStore } from '../store/index.ts'
import { GitWorkspaceAdapter, resolveSessionWorktree } from '../workspace/index.ts'
import type { DevelopmentGroupDesktopPort } from './desktop-port.ts'

const execFileAsync = promisify(execFile)

interface VerificationPolicyFile {
  revision: string
  commands: readonly VerificationCommand[]
}

function requiredString(value: unknown, label: string, max = 8192): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max || /[\0\r\n]/u.test(text)) throw new Error(`${label} is required`)
  return text
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactSha(value: unknown, label: string): string {
  const sha = requiredString(value, label, 40)
  if (!/^[0-9a-f]{40}$/iu.test(sha)) throw new Error(`${label} must be an exact 40-character Git SHA`)
  return sha.toLowerCase()
}

function safeBranch(branch: string): string {
  const value = requiredString(branch, 'branch', 512)
  if (value.startsWith('-')) throw new Error('branch must not begin with -')
  return value
}

function resolveInside(root: string, candidate: string): string {
  const absoluteRoot = resolve(root)
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(absoluteRoot, candidate)
  const rel = relative(absoluteRoot, absolute)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`verification cwd escapes repository root: ${candidate}`)
  }
  return absolute
}

function parseArgv(command: string): readonly string[] {
  let value: unknown
  try {
    value = JSON.parse(command)
  } catch {
    throw new Error('verification command must be a JSON argv array')
  }
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('verification command must be a non-empty JSON array of non-empty strings')
  }
  if (value.length > 64 || value.some(item => item.length > 8192)) throw new Error('verification argv exceeds product limits')
  return value as string[]
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function localBranchHead(repositoryRoot: string, branch: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${safeBranch(branch)}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      shell: false
    })
    return exactSha(result.stdout.trim(), 'branch head')
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number }
    if (failure.code === 128) return undefined
    throw error
  }
}

class GitSessionWorkspaceProvisioner {
  async ensure(group: DevelopmentGroupDefinition, persistedSession: DevelopmentSessionDefinition, runtime: DevelopmentSessionRuntime): Promise<void> {
    const repositoryRoot = resolve(group.repository)
    const session = resolveSessionWorktree(group, persistedSession)
    const worktree = session.worktree
    const exists = await directoryExists(worktree)

    if (exists) {
      const git = new GitWorkspaceAdapter(worktree)
      const [branch, head, status] = await Promise.all([git.currentBranch(), git.resolveHead(), git.status()])
      if (branch !== session.branch) throw new Error(`Session worktree branch mismatch: expected ${session.branch}, got ${branch}`)
      if (runtime.attempt === 0 && head !== session.baselineSha) {
        throw new Error(`fresh Session worktree must be at baseline ${session.baselineSha}; got ${head}`)
      }
      if (runtime.attempt === 0 && status.length > 0) throw new Error('fresh Session worktree must be clean')
      return
    }

    const branchHead = await localBranchHead(repositoryRoot, session.branch)
    await mkdir(dirname(worktree), { recursive: true })
    const rootGit = new GitWorkspaceAdapter(repositoryRoot)
    if (runtime.attempt === 0) {
      if (branchHead) throw new Error(`refusing to adopt pre-existing fresh Session branch ${session.branch}`)
      await rootGit.createSessionWorktree(worktree, session.branch, session.baselineSha)
      return
    }

    if (!branchHead) throw new Error(`retry Session branch ${session.branch} is missing; refusing to recreate from baseline`)
    await execFileAsync('git', ['worktree', 'add', worktree, safeBranch(session.branch)], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      shell: false
    })
  }
}

class ShelllessVerificationExecutor {
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
      return {
        exitCode: 0,
        evidence: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).map(text => text.slice(-16_384))
      }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
      if (typeof failure.code !== 'number') throw error
      return {
        exitCode: failure.code,
        evidence: [failure.stdout?.trim(), failure.stderr?.trim(), failure.message.trim()]
          .filter(Boolean)
          .map(text => String(text).slice(-16_384))
      }
    }
  }
}

async function loadVerificationCommands(definition: DevelopmentGroupDefinition): Promise<readonly VerificationCommand[]> {
  const repositoryRoot = resolve(definition.repository)
  const policyPath = resolveInside(repositoryRoot, '.zero3/verification-policy.json')
  let parsed: VerificationPolicyFile
  try {
    parsed = JSON.parse(await readFile(policyPath, 'utf8')) as VerificationPolicyFile
  } catch (error) {
    throw new Error(`cannot read frozen verification policy ${policyPath}: ${String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.commands)) throw new Error('verification policy commands are required')
  if (requiredString(parsed.revision, 'verification policy revision', 256) !== definition.policy.verificationPolicyRevision) {
    throw new Error('verification policy revision changed after Group planning')
  }
  return parsed.commands.map(command => ({
    ...command,
    cwd: command.cwd ? resolveInside(repositoryRoot, command.cwd) : repositoryRoot
  }))
}

export class DevelopmentGroupDesktopRuntime implements DevelopmentGroupDesktopPort {
  readonly store: DevelopmentGroupStore
  readonly executorManager: Zero3ExecutorManager
  readonly #handoffStore: HandoffStore
  readonly #workspaceProvisioner = new GitSessionWorkspaceProvisioner()
  readonly #facades = new Map<string, DevelopmentGroupRuntimeFacade>()

  constructor(storeRoot: string, codexTransport: NativeCodexAppServerTransport) {
    const root = resolve(storeRoot)
    this.store = new DevelopmentGroupStore(root)
    this.#handoffStore = new HandoffStore(`${root}-handoffs`)
    const registry = new Zero3ExecutorRegistry()
    registry.register(new NativeCodexExecutor(new NativeCodexAppServerDriver({ transport: codexTransport })))
    this.executorManager = new Zero3ExecutorManager(registry)
  }

  async listGroups(): Promise<unknown> {
    const groupIds = await this.store.listGroupIds()
    return Promise.all(groupIds.map(groupId => this.getGroup(groupId)))
  }

  async getGroup(groupId: string): Promise<unknown> {
    return (await this.facadeFor(groupId)).snapshot(groupId)
  }

  async createGroup(rawRequest: unknown, rawProposal: unknown): Promise<unknown> {
    const input = plainObject(rawRequest, 'Planning request')
    const proposal = plainObject(rawProposal, 'Planning proposal') as unknown as ControllerPlanningProposal
    const repository = resolve(requiredString(input.repository, 'repository'))
    const baselineSha = exactSha(input.baselineSha, 'baselineSha')
    const integrationRef = requiredString(input.integrationRef, 'integrationRef', 256)
    plainObject(input.policy, 'Planning policy')

    const git = new GitWorkspaceAdapter(repository)
    const [observedHead, observedBranch, status] = await Promise.all([git.resolveHead(), git.currentBranch(), git.status()])
    if (observedHead !== baselineSha) throw new Error(`Planning baseline mismatch: expected ${baselineSha}, got ${observedHead}`)
    if (observedBranch !== integrationRef) throw new Error(`Planning integrationRef mismatch: expected ${integrationRef}, got ${observedBranch}`)
    if (status.length > 0) throw new Error('Planning repository must be clean before Development Group creation')

    const request = { ...input, repository, baselineSha, integrationRef } as unknown as PlanningRequest
    const facade = this.createFacade(repository)
    const plan = await facade.createGroup(request, proposal)
    this.#facades.set(plan.definition.groupId, facade)
    return facade.snapshot(plan.definition.groupId)
  }

  async startWave(groupId: string, waveId: string): Promise<unknown> {
    const facade = await this.facadeFor(groupId)
    const snapshot = await facade.snapshot(groupId)
    const wave = snapshot.plan.waves.find(candidate => candidate.waveId === waveId)
    if (!wave) throw new Error(`unknown Development Wave ${waveId}`)
    const runtimeBySession = new Map(snapshot.records.runtimes.map(runtime => [runtime.sessionId, runtime] as const))
    for (const sessionId of wave.sessionIds) {
      const session = snapshot.plan.sessions.find(candidate => candidate.sessionId === sessionId)
      const runtime = runtimeBySession.get(sessionId)
      if (!session || !runtime || !['waiting_dependencies', 'ready'].includes(runtime.status)) continue
      await this.#workspaceProvisioner.ensure(snapshot.plan.definition, session, runtime)
    }
    return facade.startWave(groupId, waveId)
  }

  async retrySession(groupId: string, sessionId: string): Promise<unknown> {
    const facade = await this.facadeFor(groupId)
    const snapshot = await facade.snapshot(groupId)
    const session = snapshot.plan.sessions.find(candidate => candidate.sessionId === sessionId)
    const runtime = snapshot.records.runtimes.find(candidate => candidate.sessionId === sessionId)
    if (!session || !runtime) throw new Error(`unknown Development Session ${sessionId}`)
    await this.#workspaceProvisioner.ensure(snapshot.plan.definition, session, runtime)
    return retryDevelopmentSession(facade, groupId, sessionId)
  }

  async respondPermission(groupId: string, sessionId: string, response: ExecutorPermissionResponse): Promise<void> {
    const facade = await this.facadeFor(groupId)
    const runner = await facade.controller.sessionRunner(groupId, sessionId, this.executorManager)
    await runner.respondPermission(response)
  }

  async cancelSession(groupId: string, sessionId: string): Promise<void> {
    const facade = await this.facadeFor(groupId)
    const runner = await facade.controller.sessionRunner(groupId, sessionId, this.executorManager)
    await runner.cancel()
  }

  async resolveOutcomeUnknown(groupId: string, sessionId: string, resolution: OutcomeUnknownResolution, evidence: string): Promise<unknown> {
    const facade = await this.facadeFor(groupId)
    await resolveSessionOutcomeUnknown(this.store, groupId, sessionId, resolution, evidence)
    return facade.snapshot(groupId)
  }

  async integrateDelivery(groupId: string, sessionId: string): Promise<unknown> {
    return (await this.facadeFor(groupId)).integrateDelivery(groupId, sessionId)
  }

  async runVerification(groupId: string): Promise<unknown> {
    return (await this.facadeFor(groupId)).runVerification(groupId)
  }

  async getCompletionProof(groupId: string): Promise<unknown> {
    return (await this.facadeFor(groupId)).completionProof(groupId)
  }

  async completeGroup(groupId: string): Promise<unknown> {
    return (await this.facadeFor(groupId)).completeGroup(groupId)
  }

  private createFacade(repositoryRoot: string): DevelopmentGroupRuntimeFacade {
    const handoffResolver = new HandoffStoreEvidenceResolver(this.#handoffStore)
    return new DevelopmentGroupRuntimeFacade({
      store: this.store,
      executorManager: this.executorManager,
      integrationGit: new IntegrationGitAdapter(repositoryRoot),
      deliveryVerifier: new WorkspaceRuntimeDeliveryVerifier(handoffResolver),
      deliveryMaterializer: new WorkspaceDeliveryMaterializer(this.#handoffStore),
      verificationCommands: { commands: loadVerificationCommands },
      verificationExecutor: new ShelllessVerificationExecutor(repositoryRoot)
    })
  }

  private async facadeFor(groupId: string): Promise<DevelopmentGroupRuntimeFacade> {
    const existing = this.#facades.get(groupId)
    if (existing) return existing
    const definition = await this.store.loadDefinition(groupId)
    const facade = this.createFacade(resolve(definition.repository))
    this.#facades.set(groupId, facade)
    return facade
  }
}

export function createDevelopmentGroupDesktopRuntime(storeRoot: string, codexTransport: NativeCodexAppServerTransport): DevelopmentGroupDesktopRuntime {
  return new DevelopmentGroupDesktopRuntime(storeRoot, codexTransport)
}
