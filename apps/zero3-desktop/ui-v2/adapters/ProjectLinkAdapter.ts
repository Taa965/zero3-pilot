export type LinkedProvider = 'codex' | 'claude' | 'antigravity'
export type ProviderProject = { id: string; name: string; rootPath: string | null }
export type ProjectBinding = { provider: LinkedProvider; externalId: string | null; name?: string; rootPath: string; revision: number; state?: 'ready' | 'setup_failed' | 'uncertain' }
export type ProviderProjectList = { provider: LinkedProvider; projects: ProviderProject[]; binding: ProjectBinding | null; error: string | null }
type Bridge = {
  list: (request: { projectId: string }) => Promise<ProviderProjectList[]>
  connect: (request: { projectId: string; provider: LinkedProvider; mode: 'existing' | 'create'; externalId?: string; rootPath?: string }) => Promise<ProjectBinding>
  resolve: (request: { projectId: string; provider: LinkedProvider }) => Promise<ProjectBinding>
  attachCodexThread: (request: { projectId: string; externalId: string; threadId: string }) => Promise<{ attached: boolean }>
  pickDirectory: () => Promise<string | null>
}
function bridge(): Bridge {
  const value = (window as Window & { zero3ProjectLinks?: Bridge }).zero3ProjectLinks
  if (!value) throw new Error('项目关联组件尚未加载，请重启更新后的 Zero3 Pilot')
  return value
}
export const ProjectLinkAdapter = {
  list: (projectId: string) => bridge().list({ projectId }),
  connect: (request: Parameters<Bridge['connect']>[0]) => bridge().connect(request),
  resolve: (projectId: string, provider: LinkedProvider) => bridge().resolve({ projectId, provider }),
  attachCodexThread: (request: Parameters<Bridge['attachCodexThread']>[0]) => bridge().attachCodexThread(request),
  pickDirectory: () => bridge().pickDirectory()
}
