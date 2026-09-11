import fs from 'node:fs/promises'

import type { Zero3NativeSkillMetadata, Zero3ResolvedTaskSkill } from './skill-types'

const MAX_SKILL_BYTES = 256 * 1024
const MAX_CONTEXT_BYTES = 512 * 1024

type JsonRecord = Record<string, unknown>
function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function zero3NativeSkillCatalog(response: unknown): Zero3NativeSkillMetadata[] {
  const rows: Zero3NativeSkillMetadata[] = []
  for (const rawEntry of Array.isArray(record(response).data) ? record(response).data as unknown[] : []) {
    const entry = record(rawEntry)
    for (const rawSkill of Array.isArray(entry.skills) ? entry.skills : []) {
      const skill = record(rawSkill)
      const name = text(skill.name)
      const skillPath = text(skill.path)
      if (!name || !skillPath) continue
      const iface = record(skill.interface)
      rows.push({
        name,
        path: skillPath,
        description: text(skill.description),
        scope: text(skill.scope),
        enabled: skill.enabled !== false,
        displayName: text(iface.displayName) || null,
        shortDescription: text(skill.shortDescription) || text(iface.shortDescription) || null,
        pluginId: text(skill.pluginId) || null
      })
    }
  }
  return [...new Map(rows.map(skill => [skill.path, skill])).values()]
}

export async function readZero3SkillDocument(skill: Pick<Zero3ResolvedTaskSkill, 'name' | 'path'>) {
  const stat = await fs.stat(skill.path)
  if (!stat.isFile()) throw new Error(`Skill path is not a file: ${skill.name}`)
  if (stat.size > MAX_SKILL_BYTES) throw new Error(`Skill document exceeds ${MAX_SKILL_BYTES} bytes: ${skill.name}`)
  return { name: skill.name, content: await fs.readFile(skill.path, 'utf8'), modifiedAt: stat.mtime.toISOString() }
}

export async function renderZero3SkillContext(skills: readonly Zero3ResolvedTaskSkill[]): Promise<string> {
  const parts: string[] = []
  let bytes = 0
  for (const skill of skills) {
    const document = await readZero3SkillDocument(skill)
    const block = `[ZERO3 CODEX NATIVE SKILL: ${skill.name}]\n${document.content}\n[END ZERO3 CODEX NATIVE SKILL]`
    const size = Buffer.byteLength(block, 'utf8')
    if (bytes + size > MAX_CONTEXT_BYTES) break
    parts.push(block)
    bytes += size
  }
  return parts.join('\n\n')
}
