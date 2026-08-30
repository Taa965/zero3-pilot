export const ZERO3_HANDOFF_SCHEMA = 'zero3.pilot.handoff.v1' as const

export interface HandoffChangedFile {
  path: string
  status: string
}

export interface HandoffUntrackedFile {
  path: string
  byte_len: number
  sha256: string
}

export interface HandoffTestResult {
  name: string
  status: 'passed' | 'failed' | 'skipped' | 'unknown'
  detail?: string
}

export interface HandoffPendingApproval {
  request_id: string
  description: string
  allow_session_approval: boolean
}

export interface Zero3HandoffCheckpointV1 {
  schema_version: typeof ZERO3_HANDOFF_SCHEMA
  task_id: string
  execution_id: string
  workspace: string
  repo_id: string
  branch: string
  base_sha: string
  head_sha: string
  dirty_worktree_fingerprint: string
  changed_files: readonly HandoffChangedFile[]
  untracked_files: readonly HandoffUntrackedFile[]
  working_diff: string
  objective: string
  constraints: readonly string[]
  acceptance_criteria: readonly string[]
  completed: readonly string[]
  in_progress: readonly string[]
  remaining: readonly string[]
  tests_run: readonly string[]
  test_results: readonly HandoffTestResult[]
  pending_approvals: readonly HandoffPendingApproval[]
  last_executor: string
  last_session_id: string
  stop_reason: string
  next_action: string
  checkpoint_hash: string
  handoff_generation: number
  created_at: string
}

export interface HandoffBuildInput {
  taskId: string
  executionId: string
  workspace: string
  repoId: string
  baseSha: string
  objective: string
  constraints: readonly string[]
  acceptanceCriteria: readonly string[]
  completed: readonly string[]
  inProgress: readonly string[]
  remaining: readonly string[]
  testsRun: readonly string[]
  testResults: readonly HandoffTestResult[]
  pendingApprovals: readonly HandoffPendingApproval[]
  lastExecutor: string
  lastSessionId: string
  stopReason: string
  nextAction: string
  previousGeneration: number
  createdAt?: string
}

export interface HandoffObservedWorkspace {
  workspace: string
  branch: string
  headSha: string
  dirtyWorktreeFingerprint: string
}

export interface HandoffVerificationResult {
  decision: 'HANDOFF_ACCEPT' | 'HANDOFF_REJECT'
  reasons: readonly string[]
  task_id: string
  execution_id: string
  checkpoint_hash: string
  generation: number
}
