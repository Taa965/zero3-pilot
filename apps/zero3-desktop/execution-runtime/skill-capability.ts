import type {
  ExecutionExecutorTarget,
  ExecutionSkillAdapterMode,
  ExecutionSkillPreflight,
  ExecutionStepDefinition
} from './contracts.ts'

export interface ExecutionSkillCatalogItem {
  name: string
  displayName?: string | null
  path?: string | null
  enabled: boolean
}

function selectorMatch(skill: ExecutionSkillCatalogItem, selector: string): boolean {
  const value = selector.trim()
  return Boolean(value) && (
    skill.name === value ||
    skill.displayName === value ||
    skill.path === value
  )
}

function resolve(
  catalog: readonly ExecutionSkillCatalogItem[],
  selectors: readonly string[]
): { available: string[]; missing: string[] } {
  const available: string[] = []
  const missing: string[] = []
  for (const selector of selectors) {
    const skill = catalog.find(item => item.enabled && selectorMatch(item, selector))
    if (skill) available.push(skill.displayName?.trim() || skill.name)
    else missing.push(selector)
  }
  return { available, missing }
}

export function evaluateExecutionSkillPreflight(input: {
  step: ExecutionStepDefinition
  executor: Exclude<ExecutionExecutorTarget, 'AUTO'> | null
  adapterMode: ExecutionSkillAdapterMode
  catalog: readonly ExecutionSkillCatalogItem[]
  checkedAt?: string
}): ExecutionSkillPreflight {
  const requiredSkills = [...(input.step.requiredSkills ?? [])]
  const optionalSkills = [...(input.step.optionalSkills ?? [])]
  const unsupported = input.adapterMode === 'unsupported' || input.executor == null
  const required = unsupported
    ? { available: [], missing: requiredSkills }
    : resolve(input.catalog, requiredSkills)
  const optional = unsupported
    ? { available: [], missing: optionalSkills }
    : resolve(input.catalog, optionalSkills)
  const state = requiredSkills.length === 0 && optionalSkills.length === 0
    ? 'not_required'
    : required.missing.length === 0 ? 'ready' : 'blocked'
  return {
    state,
    executor: input.executor,
    adapterMode: input.adapterMode,
    requiredSkills,
    optionalSkills,
    availableRequiredSkills: required.available,
    availableOptionalSkills: optional.available,
    missingRequiredSkills: required.missing,
    missingOptionalSkills: optional.missing,
    checkedAt: input.checkedAt ?? new Date().toISOString()
  }
}
