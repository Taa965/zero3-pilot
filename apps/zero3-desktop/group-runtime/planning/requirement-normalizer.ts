import { createHash } from 'node:crypto'

import type { DevelopmentRequirement } from '../contracts/index.ts'
import type { PlanningModuleHint, RequirementProposal } from './planning-types.ts'

function cleanText(value: string, field: string): string {
  const cleaned = value.trim()
  if (!cleaned) throw new Error(`${field} must be non-empty`)
  return cleaned
}

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))]
}

function requirementId(index: number): string {
  return `REQ-${String(index + 1).padStart(3, '0')}`
}

export function normalizeRequirementProposals(
  groupId: string,
  proposals: readonly RequirementProposal[]
): { requirements: DevelopmentRequirement[]; hints: PlanningModuleHint[] } {
  if (!groupId.trim()) throw new Error('groupId must be non-empty')
  const explicit = new Set<string>()
  for (const proposal of proposals) {
    if (!proposal.id) continue
    const id = cleanText(proposal.id, 'requirement id')
    if (explicit.has(id)) throw new Error(`duplicate requirement id: ${id}`)
    explicit.add(id)
  }

  const requirements = proposals.map((proposal, index): DevelopmentRequirement => {
    const id = proposal.id ? cleanText(proposal.id, 'requirement id') : requirementId(index)
    const acceptanceCriteria = unique(proposal.acceptanceCriteria)
    if (acceptanceCriteria.length === 0) throw new Error(`requirement ${id} needs acceptance criteria`)
    return {
      groupId,
      requirementId: id,
      title: cleanText(proposal.title, `requirement ${id} title`),
      description: cleanText(proposal.description, `requirement ${id} description`),
      mandatory: proposal.mandatory !== false,
      acceptanceCriteria,
      sourceAnchor: cleanText(proposal.sourceAnchor, `requirement ${id} sourceAnchor`),
      proposedOwner: proposal.proposedOwner?.trim() || undefined,
      dependencies: unique(proposal.dependencies)
    }
  })

  const ids = new Set(requirements.map(item => item.requirementId))
  for (const requirement of requirements) {
    for (const dependency of requirement.dependencies) {
      if (!ids.has(dependency)) throw new Error(`requirement ${requirement.requirementId} has unknown dependency ${dependency}`)
      if (dependency === requirement.requirementId) throw new Error(`requirement ${requirement.requirementId} cannot depend on itself`)
    }
  }

  const hints = requirements.map((requirement, index): PlanningModuleHint => ({
    requirementId: requirement.requirementId,
    pathHints: unique(proposals[index].pathHints),
    tags: unique(proposals[index].tags)
  }))
  return { requirements, hints }
}

export function stablePlanHash(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
