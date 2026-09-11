function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function flattenSkillsList(response) {
  const result = []
  for (const rawEntry of Array.isArray(object(response).data) ? object(response).data : []) {
    const entry = object(rawEntry)
    const cwd = text(entry.cwd)
    for (const rawSkill of Array.isArray(entry.skills) ? entry.skills : []) {
      const skill = object(rawSkill)
      const name = text(skill.name)
      const path = text(skill.path)
      if (!name || !path) continue
      const iface = object(skill.interface)
      result.push({
        cwd,
        name,
        description: text(skill.description),
        shortDescription: text(skill.shortDescription ?? skill.short_description),
        path,
        scope: text(skill.scope),
        enabled: skill.enabled !== false,
        pluginId: text(skill.pluginId ?? skill.plugin_id) || null,
        interface: {
          displayName: text(iface.displayName ?? iface.display_name) || null,
          shortDescription: text(iface.shortDescription ?? iface.short_description) || null,
          defaultPrompt: text(iface.defaultPrompt ?? iface.default_prompt) || null
        }
      })
    }
  }
  return result
}

export function searchNativeSkills(skills, query, limit = 20) {
  const tokens = String(query ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean)
  const rows = Array.isArray(skills) ? skills : []
  const matches = rows.filter(skill => {
    if (!tokens.length) return true
    const haystack = [
      skill.name,
      skill.interface?.displayName,
      skill.description,
      skill.shortDescription,
      skill.interface?.shortDescription,
      skill.path
    ].filter(Boolean).join('\n').toLowerCase()
    return tokens.every(token => haystack.includes(token))
  })
  return matches.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
}

export function resolveNativeSkill(skills, selector) {
  const target = String(selector ?? '').trim()
  if (!target) throw new Error('Skill selector is required')
  const exact = (Array.isArray(skills) ? skills : []).filter(skill =>
    skill.path === target || skill.name === target || skill.interface?.displayName === target
  )
  if (exact.length === 1) return exact[0]
  if (!exact.length) throw new Error(`Codex native Skill not found: ${target}`)
  throw new Error(`Codex native Skill selector is ambiguous: ${target}`)
}

export function buildNativeSkillTurnInput(skill, prompt) {
  const selected = resolveNativeSkill([skill], skill?.path || skill?.name)
  const message = String(prompt ?? '').trim()
  if (!message) throw new Error('Skill prompt is required')
  return [
    { type: 'skill', name: selected.name, path: selected.path },
    { type: 'text', text: message, textElements: [] }
  ]
}

export function buildSkillInstallerPrompt(source) {
  const value = String(source ?? '').trim()
  if (!value || value.length > 4096) throw new Error('Skill install source must be 1..4096 characters')
  return `Install the Codex Skill from this source into the normal user Codex skills directory. Use the native skill-installer workflow and do not create a Zero3-specific copy or registry. Source: ${value}`
}
