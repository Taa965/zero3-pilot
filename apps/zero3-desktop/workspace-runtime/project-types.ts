export const ZERO3_PROJECT_SCHEMA_VERSION = 1 as const

export type Zero3Project = {
  id: string
  name: string
  rootPath: string
  chatGptProjectUrl: string | null
  createdAt: string
  lastActiveAt: string
}

export type Zero3ProjectFile = {
  schemaVersion: typeof ZERO3_PROJECT_SCHEMA_VERSION
  projects: Record<string, Zero3Project>
}

export type Zero3CreateProjectInput = {
  name: string
  rootPath: string
}

export type Zero3UpdateProjectInput = {
  id: string
  name?: string
  chatGptProjectUrl?: string | null
}
