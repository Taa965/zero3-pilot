export type SkillRecord = {
  cwd: string
  name: string
  description: string
  shortDescription: string
  path: string
  scope: string
  enabled: boolean
  pluginId: string | null
  displayName: string | null
}
export type SkillListSnapshot = { items: SkillRecord[]; errors: string[] }
export type SkillBinding = Awaited<ReturnType<Window['zero3Codex']['skills']['bindings']['list']>>[number]

function flatten(response: Awaited<ReturnType<Window['zero3Codex']['skills']['list']>>): SkillListSnapshot {
  const items: SkillRecord[] = []
  const errors: string[] = []
  for (const entry of response.data ?? []) {
    for (const error of entry.errors ?? []) errors.push(`${error.path}: ${error.message}`)
    for (const skill of entry.skills ?? []) {
      items.push({
        cwd: entry.cwd,
        name: skill.name,
        description: skill.description ?? '',
        shortDescription: skill.shortDescription ?? skill.interface?.shortDescription ?? '',
        path: skill.path,
        scope: skill.scope,
        enabled: skill.enabled !== false,
        pluginId: skill.pluginId ?? null,
        displayName: skill.interface?.displayName ?? null
      })
    }
  }
  const unique = [...new Map(items.map(item => [item.path, item])).values()]
  unique.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name))
  return { items: unique, errors }
}

export const SkillAdapter = {
  async list(cwd?: string | null, forceReload = false): Promise<SkillListSnapshot> {
    return flatten(await window.zero3Codex.skills.list({ cwds: cwd ? [cwd] : [], forceReload }))
  },
  search(items: SkillRecord[], query: string): SkillRecord[] {
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (!tokens.length) return items
    return items.filter(item => {
      const value = [item.name, item.displayName, item.description, item.shortDescription, item.path].filter(Boolean).join('\n').toLowerCase()
      return tokens.every(token => value.includes(token))
    })
  },
  async setEnabled(skill: SkillRecord, enabled: boolean): Promise<void> {
    await window.zero3Codex.skills.setEnabled({ path: skill.path, enabled })
  },
  install(source: string, cwd?: string | null) {
    return window.zero3Codex.skills.install({ source: source.trim(), ...(cwd ? { cwd } : {}) })
  },
  read(skill: SkillRecord, cwd?: string | null) {
    return window.zero3Codex.skills.read({ path: skill.path, ...(cwd ? { cwd } : {}) })
  },
  listBindings(): Promise<SkillBinding[]> { return window.zero3Codex.skills.bindings.list() },
  upsertBinding(input: Parameters<Window['zero3Codex']['skills']['bindings']['upsert']>[0]) {
    return window.zero3Codex.skills.bindings.upsert(input)
  },
  removeBinding(bindingId: string) { return window.zero3Codex.skills.bindings.remove({ bindingId }) },
  async capabilityMatrix(): Promise<AgentSkillCapabilityMatrix> {
    return await window.zero3Execution.skillCapabilities() as AgentSkillCapabilityMatrix
  },
  subscribe(onChanged: () => void): () => void {
    return window.zero3Codex.onEvent(event => {
      if (event.kind === 'notification' && event.method === 'skills/changed') onChanged()
    })
  }
}

export type AgentSkillCapability = {
  executor: string
  adapterMode: string
  available: boolean
  skillCount: number
  boundSkills: string[]
}
export type AgentSkillCapabilityMatrix = { generatedAt?: string; agents?: AgentSkillCapability[] }
