import type { DevelopmentGroupDefinition, DevelopmentRequirement, DevelopmentSessionDefinition } from '../contracts/index.ts'

function section(title: string, values: readonly string[]): string {
  return `${title}:\n${values.length > 0 ? values.map(value => `- ${value}`).join('\n') : '- none'}`
}

export function buildDevelopmentSessionPrompt(input: {
  group: DevelopmentGroupDefinition
  session: DevelopmentSessionDefinition
  requirements: readonly DevelopmentRequirement[]
}): string {
  const { group, session } = input
  const requirementById = new Map(input.requirements.map(requirement => [requirement.requirementId, requirement] as const))
  const requirements = session.requirements.map(requirementId => {
    const requirement = requirementById.get(requirementId)
    if (!requirement) throw new Error(`session references unknown requirement ${requirementId}`)
    return `${requirement.requirementId}: ${requirement.title} — ${requirement.description}`
  })
  const acceptance = session.requirements.flatMap(requirementId => requirementById.get(requirementId)?.acceptanceCriteria ?? [])

  return [
    `You are Development Group ${group.groupId} Session ${session.sessionId}.`,
    '',
    'Group goal:',
    group.masterGoal,
    '',
    'Your only responsibility:',
    session.objective,
    '',
    section('Requirements', requirements),
    '',
    `Frozen baseline: ${session.baselineSha}`,
    `Integration ref: ${session.integrationRef}`,
    `Branch: ${session.branch}`,
    `Worktree: ${session.worktree}`,
    '',
    section('Owned paths', session.ownedPaths),
    section('Read-only paths', session.readOnlyPaths),
    section('Forbidden paths', session.forbiddenPaths),
    '',
    section('Session dependencies', session.dependencies),
    section('Acceptance criteria', [...new Set([...session.acceptanceCriteria, ...acceptance])]),
    '',
    'Execution contract:',
    '- Execute through the bound Zero3Executor / native Codex root Thread.',
    `- Native Codex subagents are ${session.subagentPolicy.allowed ? 'allowed' : 'not allowed'} with max concurrency ${session.subagentPolicy.maxConcurrency}.`,
    '- Do not create another Development Group or a replacement agent loop.',
    '- Do not bypass Codex/Executor permission requests.',
    '- Do not modify read-only, forbidden, or otherwise unowned paths.',
    '- Commit all intended changes to the bound Session branch before finishing; leave the worktree clean and do not merge it yourself.',
    '- Report tests, artifacts, known issues, and downstream notes in your final message for the human/controller to review.',
    '- The Zero3 product runtime, not agent text, derives the authoritative DevelopmentDelivery, Handoff checkpoint, changed paths, exact HEAD, and delivery hash from Git evidence after the turn succeeds.',
    '- A textual claim of completion is never delivery evidence.',
    '- If execution outcome may have external side effects but cannot be confirmed, stop as OutcomeUnknown; do not blindly retry.'
  ].join('\n')
}
