import * as z from 'zod/v4'

const ID = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const TEXT = z.string().min(1).max(4096)
const BATCH = z.number().int().min(1).max(100)
const LEASE = z.number().int().min(60).max(86_400)
const META = z.record(z.string(), z.unknown())
const completedUnit = z.union([
  ID,
  z.object({ unitId: ID, artifactRefs: z.array(z.string().min(1).max(2048)).max(100).optional() })
])
const failedUnit = z.object({ unitId: ID, reason: TEXT, retryable: z.boolean().optional() })

function response(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

async function audited(audit, tool, input, run) {
  try {
    const value = run()
    await audit({ tool, taskId: input.taskId, workerId: input.workerId ?? null, result: 'ok' })
    return response(value)
  } catch (error) {
    await audit({ tool, taskId: input.taskId, workerId: input.workerId ?? null, result: 'error' })
    throw error
  }
}

export function registerWorkerTools(server, protocol, audit) {  server.registerTool('register_worker', {
    title: 'Register Zero3 Web Worker',
    description: 'Register this web GPT session as a task-scoped Zero3 worker. This never dispatches Codex or GPU work.',
    inputSchema: z.object({
      taskId: ID, stepId: ID, assignmentId: ID, workerType: ID,
      capabilities: z.array(ID).min(1).max(64), maxBatchSize: BATCH,
      logicalSessionId: z.string().min(1).max(512).optional(), metadata: META.optional(), idempotencyKey: ID
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, input => audited(audit, 'register_worker', input, () => protocol.registerWorker(input)))

  server.registerTool('claim_work', {
    title: 'Claim Zero3 Work',
    description: 'Atomically claim the next available WorkUnits for this registered web GPT worker.',
    inputSchema: z.object({
      taskId: ID, stepId: ID, assignmentId: ID, workerId: ID, sessionId: ID,
      maxItems: BATCH.optional(), leaseSeconds: LEASE.optional(), idempotencyKey: ID
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, input => audited(audit, 'claim_work', input, () => protocol.claimWork(input)))

  server.registerTool('report_progress', {
    title: 'Report Zero3 Work Progress',
    description: 'Report progress for the active Claim and renew its lease without completing WorkUnits.',
    inputSchema: z.object({
      taskId: ID, stepId: ID, assignmentId: ID, workerId: ID, sessionId: ID, claimId: ID,
      progress: z.number().min(0).max(1), currentActivity: z.string().max(2048).optional(),
      runningUnitIds: z.array(ID).max(100).optional(), leaseSeconds: LEASE.optional(), idempotencyKey: ID
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, input => audited(audit, 'report_progress', input, () => protocol.reportProgress(input)))

  server.registerTool('complete_and_claim_next', {
    title: 'Complete Zero3 Batch And Claim Next',
    description: 'Atomically record every WorkUnit in the active Claim and claim the next batch in one SQLite transaction.',
    inputSchema: z.object({
      taskId: ID, stepId: ID, assignmentId: ID, workerId: ID, sessionId: ID, claimId: ID,
      completedUnits: z.array(completedUnit).max(100), failedUnits: z.array(failedUnit).max(100).optional(),
      maxItems: BATCH.optional(), leaseSeconds: LEASE.optional(), idempotencyKey: ID
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, input => audited(audit, 'complete_and_claim_next', input, () => protocol.completeAndClaimNext(input)))

  server.registerTool('report_failure', {
    title: 'Report Zero3 Claim Failure',
    description: 'Record a Claim failure and safely requeue retryable units without declaring the parent Step completed.',
    inputSchema: z.object({
      taskId: ID, stepId: ID, assignmentId: ID, workerId: ID, sessionId: ID, claimId: ID,
      reason: TEXT, retryable: z.boolean().optional(), idempotencyKey: ID
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, input => audited(audit, 'report_failure', input, () => protocol.reportFailure(input)))

  server.registerTool('get_task_context', {
    title: 'Get Zero3 Worker Context',
    description: 'Recover authoritative Zero3 worker state after web GPT context loss or session interruption.',
    inputSchema: z.object({ taskId: ID, stepId: ID, assignmentId: ID, workerId: ID, sessionId: ID }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, input => audited(audit, 'get_task_context', input, () => protocol.getTaskContext(input)))
}