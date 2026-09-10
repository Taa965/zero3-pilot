import type { WorkflowArtifactLocator, WorkflowArtifactRecord, WorkflowArtifactStorageProvider } from './contracts.ts'

export type WorkflowExecutionEnvironment = 'WEB' | 'LOCAL' | 'REMOTE'

export interface WorkflowArtifactPutRequest {
  workflowRunId: string
  workItemId: string
  stageRunId: string
  logicalName: string
  kind: string
  source: WorkflowArtifactLocator
}

export interface WorkflowArtifactProvider {
  readonly kind: WorkflowArtifactStorageProvider
  verify(locator: WorkflowArtifactLocator): Promise<boolean>
  materialize(locator: WorkflowArtifactLocator, targetRoot: string): Promise<WorkflowArtifactLocator>
}

export function selectArtifactTransport(from: WorkflowExecutionEnvironment, to: WorkflowExecutionEnvironment): WorkflowArtifactStorageProvider {
  if (from === 'LOCAL' && to === 'LOCAL') return 'LOCAL'
  if (from === 'WEB' || to === 'WEB') return 'GOOGLE_DRIVE'
  if (from === 'REMOTE' || to === 'REMOTE') return 'REMOTE_COMPUTE'
  return 'LOCAL'
}

export class Zero3ArtifactTransportRouter {
  readonly #providers = new Map<WorkflowArtifactStorageProvider, WorkflowArtifactProvider>()

  register(provider: WorkflowArtifactProvider): void {
    if (this.#providers.has(provider.kind)) throw new Error(`artifact provider already registered: ${provider.kind}`)
    this.#providers.set(provider.kind, provider)
  }

  provider(kind: WorkflowArtifactStorageProvider): WorkflowArtifactProvider {
    const provider = this.#providers.get(kind)
    if (!provider) throw new Error(`artifact provider is not configured: ${kind}`)
    return provider
  }

  async verify(artifact: WorkflowArtifactRecord): Promise<boolean> {
    return this.provider(artifact.storage.provider).verify(artifact.storage)
  }

  async materialize(artifact: WorkflowArtifactRecord, targetRoot: string): Promise<WorkflowArtifactLocator> {
    return this.provider(artifact.storage.provider).materialize(artifact.storage, targetRoot)
  }
}

export interface GoogleDriveArtifactPort {
  verifyFile(fileId: string): Promise<boolean>
  downloadFile(fileId: string, targetRoot: string): Promise<{ path: string }>
}

export interface GoogleDriveUploadRequest {
  sourcePath: string
  artifactId: string
  fileName?: string
  mimeType?: string
  parentFolderId?: string | null
  appProperties?: Readonly<Record<string, string>>
}

export interface GoogleDriveUploadResult {
  fileId: string
  webUrl?: string
  sizeBytes: number
  sha256: string
  reused: boolean
}

export interface GoogleDriveWritableArtifactPort extends GoogleDriveArtifactPort {
  ensureFolder(parentFolderId: string | null, name: string, appProperties?: Readonly<Record<string, string>>): Promise<{ fileId: string; webUrl?: string }>
  ensureFolderPath(rootFolderId: string | null, segments: readonly string[], scopeKey: string): Promise<{ fileId: string; webUrl?: string }>
  uploadFile(request: GoogleDriveUploadRequest): Promise<GoogleDriveUploadResult>
}

export class GoogleDriveArtifactProvider implements WorkflowArtifactProvider {
  readonly kind = 'GOOGLE_DRIVE' as const
  constructor(private readonly port: GoogleDriveArtifactPort) {}

  async verify(locator: WorkflowArtifactLocator): Promise<boolean> {
    if (!locator.fileId?.trim()) return false
    return this.port.verifyFile(locator.fileId.trim())
  }

  async materialize(locator: WorkflowArtifactLocator, targetRoot: string): Promise<WorkflowArtifactLocator> {
    if (!locator.fileId?.trim()) throw new Error('Google Drive artifact is missing fileId')
    const result = await this.port.downloadFile(locator.fileId.trim(), targetRoot)
    return { provider: 'LOCAL', path: result.path }
  }
}
