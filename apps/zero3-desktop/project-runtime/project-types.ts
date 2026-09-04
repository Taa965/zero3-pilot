export const ZERO3_PROJECT_REGISTRY_SCHEMA_VERSION = 1 as const

export type Zero3Project = {
  id: string
  name: string
  repositoryPath: string
  defaultWorktreePath: string | null
  defaultBranch: string | null
  baseRef: string | null
  contextSummary: string | null
  createdAt: string
  updatedAt: string
}

export type Zero3ProjectRegistryFile = {
  schemaVersion: typeof ZERO3_PROJECT_REGISTRY_SCHEMA_VERSION
  activeProjectId: string | null
  projects: Record<string, Zero3Project>
}

export type Zero3CreateProjectInput = {
  id: string
  name: string
  repositoryPath: string
  defaultWorktreePath?: string | null
  defaultBranch?: string | null
  baseRef?: string | null
  contextSummary?: string | null
}

export type Zero3UpdateProjectInput = {
  id: string
  name?: string
  repositoryPath?: string
  defaultWorktreePath?: string | null
  defaultBranch?: string | null
  baseRef?: string | null
  contextSummary?: string | null
}
