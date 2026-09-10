import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  normalizeWorkflowArtifactRef,
  normalizeWorkflowWorkUnit,
  type WorkflowArtifactRef,
  type WorkflowWorkUnit
} from './contracts.ts'

export type V1WorkUnit = {
  unitId: string
  ordinal?: number
  title?: string
  payload?: Record<string, unknown>
  maxAttempts?: number
  artifactRefs?: string[]
}

export type V1CompatibilityContext = {
  workflowRunId: string
  taskId: string
  stepId: string
  workItemId?: string
  stageRunId?: string
  workerDefinitionId: string
  workerSlotId: string
  workerSessionId: string
  leaseSeconds?: number
}

function legacyArtifactId(reference: string, index: number): string {
  const digest = createHash('sha256').update(reference).digest('hex').slice(0, 20)
  return `legacy-art-${index + 1}-${digest}`
}

function legacyStorage(reference: string): WorkflowArtifactRef['storage'] {
  if (reference.startsWith('gdrive://')) {
    const fileId = reference.slice('gdrive://'.length).trim()
    if (fileId) return { provider: 'GOOGLE_DRIVE', fileId }
  }
  if (/^https?:\/\//i.test(reference)) return { provider: 'URL', webUrl: reference }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(reference)) return { provider: 'URL', uri: reference }
  if (path.isAbsolute(reference) || /^[A-Za-z]:[\\/]/.test(reference)) return { provider: 'LOCAL', path: reference }
  return { provider: 'URL', uri: `legacy-ref:${encodeURIComponent(reference)}` }
}

export function adaptV1ArtifactRefsToV2(
  refs: string[],
  context: V1CompatibilityContext,
  workItemId: string,
  stageRunId: string
): WorkflowArtifactRef[] {
  return refs.map((reference, index) => normalizeWorkflowArtifactRef({
    artifactId: legacyArtifactId(reference, index),
    workflowRunId: context.workflowRunId,
    workItemId,
    stageRunId,
    logicalName: `legacy-artifact-${index + 1}`,
    kind: 'legacy-ref',
    storage: legacyStorage(reference),
    producer: {
      workerDefinitionId: context.workerDefinitionId,
      workerSlotId: context.workerSlotId,
      workerSessionId: context.workerSessionId
    }
  }))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function expectedOutputs(value: unknown): Array<{ logicalName: string; kind?: string; mimeType?: string; required: boolean }> {
  if (!Array.isArray(value)) return []
  return value.map(entry => {
    const raw = record(entry)
    return {
      logicalName: typeof raw.logicalName === 'string' && raw.logicalName.trim() ? raw.logicalName.trim() : 'legacy-output',
      ...(typeof raw.kind === 'string' && raw.kind.trim() ? { kind: raw.kind.trim() } : {}),
      ...(typeof raw.mimeType === 'string' && raw.mimeType.trim() ? { mimeType: raw.mimeType.trim() } : {}),
      required: raw.required !== false
    }
  })
}

export function adaptV1WorkUnitToV2(unit: V1WorkUnit, context: V1CompatibilityContext): WorkflowWorkUnit {
  const payload = record(unit.payload)
  const unitId = unit.unitId
  const workItemId = context.workItemId ?? unitId
  const stageRunId = context.stageRunId ?? `${context.stepId}:${unitId}`
  const title = typeof unit.title === 'string' && unit.title.trim() ? unit.title.trim() : unitId
  const instruction =
    typeof payload.instruction === 'string' && payload.instruction.trim()
      ? payload.instruction.trim()
      : typeof payload.prompt === 'string' && payload.prompt.trim()
        ? payload.prompt.trim()
        : title
  const rawSkill = record(payload.skill)
  const legacyRefs = Array.isArray(unit.artifactRefs)
    ? unit.artifactRefs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  return normalizeWorkflowWorkUnit({
    workItemId,
    stageRunId,
    title,
    instruction,
    ...(typeof rawSkill.id === 'string' && rawSkill.id.trim() ? {
      skill: { id: rawSkill.id, ...(typeof rawSkill.revision === 'string' ? { revision: rawSkill.revision } : {}) }
    } : {}),
    inputs: adaptV1ArtifactRefsToV2(legacyRefs, context, workItemId, stageRunId),
    expectedOutputs: expectedOutputs(payload.expectedOutputs),
    policy: {
      maxAttempts: unit.maxAttempts ?? (typeof payload.maxAttempts === 'number' ? payload.maxAttempts : 3),
      leaseSeconds: context.leaseSeconds ?? (typeof payload.leaseSeconds === 'number' ? payload.leaseSeconds : 1800)
    },
    metadata: {
      ...(record(payload.metadata)),
      legacyV1: {
        taskId: context.taskId,
        stepId: context.stepId,
        unitId,
        ...(unit.ordinal == null ? {} : { ordinal: unit.ordinal }),
        payload
      }
    }
  })
}

export function adaptV2ArtifactToV1Ref(artifactValue: WorkflowArtifactRef): string {
  const artifact = normalizeWorkflowArtifactRef(artifactValue)
  if (artifact.storage.provider === 'GOOGLE_DRIVE') return `gdrive://${artifact.storage.fileId}`
  if (artifact.storage.webUrl) return artifact.storage.webUrl
  if (artifact.storage.uri) return artifact.storage.uri
  if (artifact.storage.path) return artifact.storage.path
  return artifact.artifactId
}
