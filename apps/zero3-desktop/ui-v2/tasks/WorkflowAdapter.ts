export type WorkflowRuntimeCapabilities = {
  protocol: string
  artifactProviders: {
    GOOGLE_DRIVE?: { configured: boolean; mode?: string }
    LOCAL?: { configured: boolean }
    REMOTE_COMPUTE?: { configured: boolean; provider?: string | null; error?: string | null }
  }
  automaticInputIngest: boolean
  handoffMaterialization?: boolean
  remoteRender?: boolean
  videoPullback?: boolean
}

export type WorkflowRunSummary = {
  workflowRunId: string
  moduleId: string
  moduleVersion: string
  projectId: string
  title: string
  status: string
  progress: number
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type WorkflowModuleManifest = {
  id: string
  version: string
  name: string
  description: string
  uiKind: string
  requiredExecutors: string[]
  requiredSkills: string[]
  requiredPlugins: string[]
  requiredArtifactProviders: string[]
}

export type WorkflowItem = {
  workflowRunId: string
  itemId: string
  ordinal: number
  title: string
  status: string
  progress: number
  metadata: Record<string, unknown>
}

export type WorkflowStage = {
  stageRunId: string
  workflowRunId: string
  itemId: string
  stageId: string
  title: string
  executor: string
  workerDefinitionId: string | null
  status: string
  progress: number
  currentActivity: string | null
  claimOwnerId: string | null
  attempt: number
  maxAttempts: number
  metadata: Record<string, unknown>
}

export type WorkflowArtifact = {
  artifactId: string
  itemId: string
  stageId: string
  logicalName: string
  kind: string
  state: string
  storage: Record<string, unknown>
}

export type WorkflowSnapshot = {
  plan: {
    workflowRunId: string
    moduleId: string
    moduleVersion: string
    projectId: string
    title: string
    stages: { stageId: string; title: string; executor: string; workerDefinitionId?: string | null }[]
    workers: { workerDefinitionId: string; name: string; executor: string; concurrency: number; promptRevision: string; metadata?: Record<string, unknown> }[]
    metadata: Record<string, unknown>
  }
  run: WorkflowRunSummary
  items: WorkflowItem[]
  stages: WorkflowStage[]
  artifacts: WorkflowArtifact[]
  externalJobs: { jobId: string; itemId: string; stageRunId: string; provider: string; requestKey: string; externalId: string | null; state: string; metadata: Record<string, unknown>; createdAt: string; updatedAt: string }[]
  events: { sequence: number; type: string; itemId: string | null; stageRunId: string | null; payload: Record<string, unknown>; at: string }[]
}

type WorkflowBridge = {
  runtimeCapabilities: (projectRootPath?: string | null) => Promise<WorkflowRuntimeCapabilities>
  listModules: () => Promise<WorkflowModuleManifest[]>
  validateCreateInput: (moduleId: string, input: unknown, moduleVersion?: string | null) => Promise<{ valid: boolean; errors: string[]; warnings: string[] }>
  listRuns: () => Promise<WorkflowRunSummary[]>
  getRun: (runId: string) => Promise<WorkflowSnapshot>
  createRun: (request: { moduleId: string; moduleVersion?: string | null; input: unknown; start?: boolean }) => Promise<WorkflowSnapshot>
  resumeStage: (runId: string, stageRunId: string) => Promise<WorkflowSnapshot>
  pickInputFiles: () => Promise<{ path: string; name: string }[]>
  ingestInputs: (runId: string) => Promise<WorkflowSnapshot>
  ingestHandoffs: (runId: string) => Promise<WorkflowSnapshot>
  reconcileRemote: (runId: string) => Promise<{ snapshot: WorkflowSnapshot; results: unknown[] }>
  pullbackVideos: (runId: string) => Promise<{ snapshot: WorkflowSnapshot; results: unknown[] }>
}

function bridge(): WorkflowBridge | null {
  return ((window as Window & { zero3Workflow?: WorkflowBridge }).zero3Workflow ?? null)
}

export const WorkflowAdapter = {
  runtimeCapabilities: async (projectRootPath?: string | null): Promise<WorkflowRuntimeCapabilities | null> => bridge()?.runtimeCapabilities(projectRootPath ?? null) ?? null,
  available: () => bridge() !== null,
  listModules: async () => bridge()?.listModules() ?? [],
  listRuns: async () => bridge()?.listRuns() ?? [],
  getRun: async (runId: string) => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.getRun(runId)
  },
  validateCreateInput: async (moduleId: string, input: unknown, moduleVersion?: string | null) => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.validateCreateInput(moduleId, input, moduleVersion)
  },
  createRun: async (moduleId: string, input: unknown, moduleVersion?: string | null) => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.createRun({ moduleId, moduleVersion, input, start: true })
  },
  resumeStage: async (runId: string, stageRunId: string) => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.resumeStage(runId, stageRunId)
  },
  pickInputFiles: async () => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.pickInputFiles()
  },
  ingestInputs: async (runId: string) => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.ingestInputs(runId)
  },
  ingestHandoffs: async (runId: string) => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.ingestHandoffs(runId)
  },
  reconcileRemote: async (runId: string) => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.reconcileRemote(runId)
  },
  pullbackVideos: async (runId: string) => {
    const runtime = bridge()
    if (!runtime) throw new Error('Zero3 Workflow Runtime 尚未加载')
    return runtime.pullbackVideos(runId)
  }
}
