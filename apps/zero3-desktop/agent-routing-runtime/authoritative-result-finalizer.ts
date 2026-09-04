import type {
  Zero3ArtifactRef,
  Zero3ExecutionResultV2,
  Zero3TaskSpecV2,
  Zero3VerificationResult
} from './agent-contracts'
import type { Zero3GitEvidence } from './git-authority'

export type Zero3AuthoritativeResultDependencies = {
  collectGitEvidence: (workspace: string, requestedBaseSha?: string | null) => Promise<Zero3GitEvidence>
  verifyArtifact: (artifact: Zero3ArtifactRef) => Promise<boolean>
  collectVerification: (task: Zero3TaskSpecV2, candidate: Zero3ExecutionResultV2) => Promise<Zero3VerificationResult[]>
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function verificationTruth(result: Zero3VerificationResult): string | null {
  if (!result.id?.trim()) return 'verification result has no id'
  switch (result.state) {
    case 'PASSED':
      return result.evidence?.trim() ? null : `${result.id}: PASSED lacks authoritative evidence`
    case 'FAILED':
      return null
    case 'NOT_RUN':
    case 'BLOCKED':
      return result.reason?.trim() ? null : `${result.id}: ${result.state} lacks a reason`
  }
}

function gateFailure(
  gate: string,
  input: {
    git: Zero3GitEvidence | null
    artifactsVerified: boolean
    verification: Zero3VerificationResult[]
    summaryPresent: boolean
  }
): string | null {
  switch (gate) {
    case 'result.summary':
      return input.summaryPresent ? null : 'result.summary requires a non-empty summary'
    case 'git.clean':
      return input.git?.clean ? null : 'git.clean requires a clean authoritative worktree'
    case 'git.base-bound':
      return input.git?.baseSha ? null : 'git.base-bound requires a resolved authoritative base SHA'
    case 'artifact.hashes':
      return input.artifactsVerified ? null : 'artifact.hashes requires every declared artifact hash to verify'
    case 'verification.no-failures':
      return input.verification.some(value => value.state === 'FAILED' || value.state === 'BLOCKED')
        ? 'verification.no-failures failed'
        : null
    case 'verification.all-passed':
      return input.verification.length > 0 && input.verification.every(value => value.state === 'PASSED')
        ? null
        : 'verification.all-passed requires at least one verification result and all results PASSED'
    default: {
      const matching = input.verification.find(value => value.id === gate)
      if (!matching) return `unknown completion gate or missing verification evidence: ${gate}`
      return matching.state === 'PASSED' ? null : `${gate} is ${matching.state}, not PASSED`
    }
  }
}

export class Zero3AuthoritativeResultFinalizer {
  constructor(private readonly deps: Zero3AuthoritativeResultDependencies) {}

  async finalize(task: Zero3TaskSpecV2, candidate: Zero3ExecutionResultV2): Promise<Zero3ExecutionResultV2> {
    if (candidate.taskId !== task.taskId || candidate.executionId !== task.executionId || candidate.projectId !== task.projectId) {
      throw new Error('candidate result identity mismatch')
    }
    if (candidate.contextVersion !== task.contextVersion) throw new Error('candidate result contextVersion mismatch')

    if (candidate.status === 'OUTCOME_UNKNOWN') {
      return {
        ...candidate,
        blockers: unique([
          ...candidate.blockers,
          'OutcomeUnknown is unresolved; authoritative completion finalization is intentionally withheld.'
        ]),
        recommendedAction: 'HUMAN_REVIEW'
      }
    }

    let git: Zero3GitEvidence | null = null
    if (task.worktreePath?.trim()) {
      git = await this.deps.collectGitEvidence(task.worktreePath, task.baseSha ?? null)
    }

    const artifactChecks = await Promise.all(candidate.artifacts.map(async artifact => ({
      artifact,
      verified: await this.deps.verifyArtifact(artifact).catch(() => false)
    })))
    const invalidArtifacts = artifactChecks.filter(value => !value.verified).map(value => value.artifact.artifactId)
    const artifactsVerified = invalidArtifacts.length === 0

    const verification = await this.deps.collectVerification(task, candidate)
    const verificationFormatFailures = verification.map(verificationTruth).filter((value): value is string => Boolean(value))
    const gateFailures = task.completionGate
      .map(gate => gateFailure(gate, {
        git,
        artifactsVerified,
        verification,
        summaryPresent: Boolean(candidate.summary.trim())
      }))
      .filter((value): value is string => Boolean(value))

    const blockers = unique([
      ...candidate.blockers,
      ...verificationFormatFailures,
      ...invalidArtifacts.map(id => `artifact hash verification failed: ${id}`),
      ...gateFailures
    ])

    const cannotComplete = blockers.length > 0
    const nextStatus = candidate.status === 'FAILED'
      ? 'FAILED'
      : candidate.status === 'BLOCKED' || cannotComplete
        ? 'BLOCKED'
        : candidate.status

    return {
      ...candidate,
      status: nextStatus,
      changedFiles: git ? [...git.changedFiles] : [],
      git: git
        ? {
            baseSha: git.baseSha,
            headSha: git.headSha,
            commitSha: git.clean ? git.headSha : null,
            branch: git.branch
          }
        : candidate.git,
      verification,
      blockers,
      recommendedAction: nextStatus === 'COMPLETE' || nextStatus === 'PARTIAL'
        ? candidate.recommendedAction
        : 'HUMAN_REVIEW',
      completedAt: new Date().toISOString()
    }
  }
}
