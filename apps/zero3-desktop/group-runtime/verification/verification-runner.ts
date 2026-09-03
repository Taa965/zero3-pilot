import { randomUUID } from 'node:crypto'

import type { VerificationCommand, VerificationResult, VerificationRun } from '../contracts/index.ts'

export type VerificationPlatform = 'windows' | 'linux' | 'macos'

export interface VerificationCommandExecutor {
  run(command: VerificationCommand): Promise<{ exitCode: number; evidence: readonly string[] }>
}

export interface VerificationRunRequest {
  groupId: string
  integrationSha: string
  policyRevision: string
  commands: readonly VerificationCommand[]
  environment: Readonly<Record<string, string>>
  platform: VerificationPlatform
  verificationRunId?: string
  startedAt?: string
}

function assertExactSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/iu.test(sha)) throw new Error('verification requires an exact 40-character integration SHA')
}

export function validateVerificationCommands(commands: readonly VerificationCommand[]): readonly string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const command of commands) {
    if (!command.id.trim()) errors.push('verification command id is empty')
    else if (ids.has(command.id)) errors.push(`duplicate verification command id ${command.id}`)
    ids.add(command.id)
    if (!command.command.trim()) errors.push(`verification command ${command.id} is empty`)
    if (command.cwd !== undefined && !command.cwd.trim()) errors.push(`verification command ${command.id} has empty cwd`)
  }
  return errors
}

export async function executeVerification(request: VerificationRunRequest, executor: VerificationCommandExecutor): Promise<VerificationRun> {
  assertExactSha(request.integrationSha)
  const commandErrors = validateVerificationCommands(request.commands)
  if (commandErrors.length > 0) throw new Error(commandErrors.join('; '))
  const startedAt = request.startedAt ?? new Date().toISOString()
  const run: VerificationRun = {
    verificationRunId: request.verificationRunId ?? `V-${randomUUID()}`,
    groupId: request.groupId,
    integrationSha: request.integrationSha,
    policyRevision: request.policyRevision,
    commands: [...request.commands],
    results: [],
    environment: { ...request.environment, platform: request.platform },
    startedAt,
    status: 'running'
  }
  const results: VerificationResult[] = []
  let outcomeUnknown = false

  for (const command of request.commands) {
    if (command.platform !== 'any' && command.platform !== request.platform) {
      results.push({ commandId: command.id, status: 'not_run_platform', evidence: [`required_platform=${command.platform}`, `actual_platform=${request.platform}`] })
      continue
    }
    try {
      const result = await executor.run(command)
      results.push({ commandId: command.id, status: result.exitCode === 0 ? 'passed' : 'failed', exitCode: result.exitCode, evidence: [...result.evidence] })
    } catch (error) {
      outcomeUnknown = true
      results.push({ commandId: command.id, status: 'not_run', evidence: [`executor_exception=${String(error)}`] })
      break
    }
  }

  const resultById = new Map(results.map(result => [result.commandId, result] as const))
  const requiredIncomplete = request.commands.some(command => {
    if (!command.required) return false
    return resultById.get(command.id)?.status !== 'passed'
  })
  run.results = results
  run.finishedAt = new Date().toISOString()
  run.status = outcomeUnknown ? 'outcome_unknown' : requiredIncomplete ? 'failed' : 'passed'
  return run
}

export function assertMandatoryVerificationIds(commands: readonly VerificationCommand[], mandatoryIds: readonly string[]): readonly string[] {
  const present = new Set(commands.map(command => command.id))
  return [...new Set(mandatoryIds)].filter(id => !present.has(id)).sort()
}
