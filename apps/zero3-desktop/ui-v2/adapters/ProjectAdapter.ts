export type Zero3ProjectRecord = {
  id: string
  name: string
  rootPath: string
  chatGptProjectUrl: string | null
  createdAt: string
  lastActiveAt: string
}

type ProjectBridge = {
  list: () => Promise<Zero3ProjectRecord[]>
  get: (request: { id: string }) => Promise<Zero3ProjectRecord | null>
  create: (request: { name: string; rootPath: string }) => Promise<Zero3ProjectRecord>
  update: (request: { id: string; name?: string; chatGptProjectUrl?: string | null }) => Promise<Zero3ProjectRecord>
  remove: (request: { id: string }) => Promise<{ removed: boolean }>
  pickDirectory: () => Promise<string | null>
}

function bridge(): ProjectBridge | null {
  return ((window as Window & { zero3Project?: ProjectBridge }).zero3Project ?? null)
}

function requireBridge(): ProjectBridge {
  const value = bridge()
  if (!value) throw new Error('Zero3 项目运行时尚未加载')
  return value
}

function directoryName(rootPath: string): string {
  const normalized = rootPath.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? '新项目'
}

export const ProjectAdapter = {
  available(): boolean {
    return bridge() !== null
  },

  async list(): Promise<Zero3ProjectRecord[]> {
    const value = bridge()
    return value ? value.list() : []
  },

  async createFromDirectory(): Promise<Zero3ProjectRecord | null> {
    const runtime = requireBridge()
    const rootPath = await runtime.pickDirectory()
    if (!rootPath) return null
    return runtime.create({ name: directoryName(rootPath), rootPath })
  },

  async update(request: { id: string; name?: string; chatGptProjectUrl?: string | null }): Promise<Zero3ProjectRecord> {
    return requireBridge().update(request)
  },

  async remove(id: string): Promise<boolean> {
    return (await requireBridge().remove({ id })).removed
  }
}
