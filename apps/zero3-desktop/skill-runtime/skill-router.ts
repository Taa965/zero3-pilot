import type { Zero3ResolvedAgentTarget, Zero3TaskSpecV2 } from '../agent-routing-runtime/agent-contracts'
import type { Zero3NativeSkillMetadata, Zero3ResolvedTaskSkill, Zero3SkillBinding, Zero3SkillSelectionSource } from './skill-types'

const MAX_ROUTED_SKILLS = 3
const STOP = new Set(['the','and','for','with','from','this','that','into','task','zero3','pilot'])

function words(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}._-]+/u)
    .map(value => value.trim()).filter(value => value.length >= 2 && !STOP.has(value)))]
}
function selectorMatch(skill: Zero3NativeSkillMetadata, selector: string): boolean {
  const value = selector.trim()
  return Boolean(value) && (skill.path === value || skill.name === value || skill.displayName === value)
}
function bindingSource(binding: Zero3SkillBinding): Zero3SkillSelectionSource {
  if (binding.targetType === 'agent') return 'agent-binding'
  if (binding.targetType === 'workflow') return 'workflow-binding'
  return 'task-template-binding'
}
function bindingMatches(binding: Zero3SkillBinding, task: Zero3TaskSpecV2, target: Zero3ResolvedAgentTarget): boolean {
  if (!binding.enabled || !binding.autoInvoke) return false
  if (binding.targetType === 'agent') return binding.targetId.toUpperCase() === target
  if (binding.targetType === 'workflow') return Boolean(task.workflowId) && binding.targetId === task.workflowId
  return binding.targetId.toUpperCase() === task.type
}
function score(skill: Zero3NativeSkillMetadata, task: Zero3TaskSpecV2): number {
  if (!skill.enabled) return -1
  const query = words([task.title, task.goal, ...task.requirements, ...task.constraints].join(' '))
  if (!query.length) return 0
  const name = `${skill.name} ${skill.displayName ?? ''}`.toLowerCase()
  const description = `${skill.description} ${skill.shortDescription ?? ''}`.toLowerCase()
  let total = 0
  for (const word of query) total += name.includes(word) ? 4 : description.includes(word) ? 1 : 0
  if (['skill-installer','skill-creator','plugin-creator'].includes(skill.name) &&
      !query.some(word => ['skill','plugin','install','create'].some(marker => word.includes(marker)))) return 0
  return total
}

export class Zero3SkillRouter {
  resolve(input: {
    task: Zero3TaskSpecV2
    target: Zero3ResolvedAgentTarget
    skills: Zero3NativeSkillMetadata[]
    bindings: Zero3SkillBinding[]
    topN?: number
  }): Zero3ResolvedTaskSkill[] {
    const { task, target, skills, bindings } = input
    const selected = new Map<string, Zero3ResolvedTaskSkill>()
    const add = (skill: Zero3NativeSkillMetadata, source: Zero3SkillSelectionSource, priority: number) => {
      if (!skill.enabled) return
      const current = selected.get(skill.path)
      if (current && current.priority >= priority) return
      selected.set(skill.path, {
        name: skill.name, path: skill.path, scope: skill.scope,
        description: skill.description, source, priority
      })
    }

    for (const selector of task.skillSelectors ?? []) {
      const skill = skills.find(item => selectorMatch(item, selector))
      if (skill) add(skill, 'explicit', 10_000)
    }
    for (const binding of bindings.filter(binding => bindingMatches(binding, task, target)).sort((a, b) => b.priority - a.priority)) {
      const skill = skills.find(item => item.path === binding.skillPath || item.name === binding.skillName)
      if (skill) add(skill, bindingSource(binding), 5_000 + binding.priority)
    }

    const limit = Math.max(0, Math.min(input.topN ?? MAX_ROUTED_SKILLS, 10))
    const routed = skills
      .map(skill => ({ skill, score: score(skill, task) }))
      .filter(item => item.score > 0 && !selected.has(item.skill.path))
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, limit)
    for (const item of routed) add(item.skill, 'router', item.score)

    return [...selected.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
  }
}
