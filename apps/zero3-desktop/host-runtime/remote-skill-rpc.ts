import fs from 'node:fs/promises'

import type { Zero3RemoteWorkerRpcLease, Zero3SkillRpcTool } from './remote-types'

const TURN_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 250

export type Zero3SkillRuntimePort = {
  listSkills: (params: Record<string, unknown>) => Promise<unknown>
  startThread: (params: Record<string, unknown>) => Promise<unknown>
  startTurn: (params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>
  readThread: (params: Record<string, unknown>) => Promise<unknown>
}

type SkillRow = {
  name: string
  description: string
  shortDescription: string
  path: string
  scope: string
  enabled: boolean
  pluginId: string | null
  displayName: string | null
}

const SKILL_TOOLS = new Set<Zero3SkillRpcTool>(['list_skills', 'search_skills', 'get_skill', 'invoke_skill'])
const MAX_WEB_SKILL_BYTES = 128 * 1024

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is required and must be <= ${max} characters`)
  return text
}
function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === '') return undefined
  return requiredText(value, label, max)
}
function flatten(value: unknown): SkillRow[] {
  const result: SkillRow[] = []
  for (const rawEntry of Array.isArray(record(value).data) ? record(value).data as unknown[] : []) {
    const entry = record(rawEntry)
    for (const rawSkill of Array.isArray(entry.skills) ? entry.skills : []) {
      const skill = record(rawSkill)
      const name = typeof skill.name === 'string' ? skill.name.trim() : ''
      const path = typeof skill.path === 'string' ? skill.path.trim() : ''
      if (!name || !path) continue
      const iface = record(skill.interface)
      result.push({
        name,
        description: typeof skill.description === 'string' ? skill.description : '',
        shortDescription: typeof skill.shortDescription === 'string' ? skill.shortDescription : '',
        path,
        scope: typeof skill.scope === 'string' ? skill.scope : '',
        enabled: skill.enabled !== false,
        pluginId: typeof skill.pluginId === 'string' ? skill.pluginId : null,
        displayName: typeof iface.displayName === 'string' ? iface.displayName : null
      })
    }
  }
  return [...new Map(result.map(skill => [skill.path, skill])).values()]
}
function resolveSkill(skills: SkillRow[], selector: string): SkillRow {
  const exact = skills.filter(skill => skill.path === selector || skill.name === selector || skill.displayName === selector)
  if (exact.length === 1) return exact[0]
  if (!exact.length) throw new Error(`Codex native Skill not found: ${selector}`)
  throw new Error(`Codex native Skill selector is ambiguous: ${selector}`)
}
function publicSkill(skill: SkillRow) {
  return {
    name: skill.name,
    description: skill.description,
    shortDescription: skill.shortDescription,
    scope: skill.scope,
    enabled: skill.enabled,
    pluginId: skill.pluginId,
    displayName: skill.displayName
  }
}

function search(skills: SkillRow[], query: string, limit: number): SkillRow[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return skills.filter(skill => {
    const haystack = [skill.name, skill.displayName, skill.description, skill.shortDescription, skill.path].filter(Boolean).join('\n').toLowerCase()
    return tokens.every(token => haystack.includes(token))
  }).slice(0, limit)
}
function threadFrom(value: unknown): Record<string, unknown> {
  const payload = record(value)
  return Object.keys(record(payload.thread)).length ? record(payload.thread) : payload
}
function turnStatus(thread: Record<string, unknown>, turnId: string): { status: string; turn: Record<string, unknown> } | null {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const turn = turns.map(record).find(item => item.id === turnId)
  if (!turn) return null
  return { status: typeof turn.status === 'string' ? turn.status : '', turn }
}
function lastAgentMessage(turn: Record<string, unknown>): string | null {
  const items = Array.isArray(turn.items) ? turn.items.map(record) : []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) return item.text
  }
  return null
}
async function waitForTurn(runtime: Zero3SkillRuntimePort, threadId: string, turnId: string) {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const thread = threadFrom(await runtime.readThread({ threadId, includeTurns: true }))
    const state = turnStatus(thread, turnId)
    if (state && ['completed', 'failed', 'interrupted'].includes(state.status)) return state
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  throw new Error('Codex Skill turn timed out')
}

export function isZero3SkillRpcTool(tool: string): tool is Zero3SkillRpcTool {
  return SKILL_TOOLS.has(tool as Zero3SkillRpcTool)
}

export async function executeZero3SkillRpc(runtime: Zero3SkillRuntimePort, lease: Zero3RemoteWorkerRpcLease): Promise<unknown> {
  if (!isZero3SkillRpcTool(lease.tool)) throw new Error(`unsupported Skill RPC tool: ${lease.tool}`)
  const input = record(lease.arguments)
  const cwd = optionalText(input.cwd, 'cwd', 4096)
  const forceReload = input.forceReload === true
  const listing = await runtime.listSkills({ cwds: cwd ? [cwd] : [], forceReload })
  const skills = flatten(listing)

  if (lease.tool === 'list_skills') return { skills: skills.map(publicSkill) }
  if (lease.tool === 'search_skills') {
    const query = requiredText(input.query, 'query', 1024)
    const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit, 100)) : 20
    return { query, skills: search(skills, query, limit).map(publicSkill) }
  }
  if (lease.tool === 'get_skill') {
    const selector = requiredText(input.selector, 'selector', 4096)
    const skill = resolveSkill(skills, selector)
    if (!skill.enabled) throw new Error(`Codex native Skill is disabled: ${skill.name}`)
    const stat = await fs.stat(skill.path)
    if (!stat.isFile() || stat.size > MAX_WEB_SKILL_BYTES) throw new Error('Skill document is unavailable or exceeds 128 KiB')
    return {
      skill: publicSkill(skill),
      content: await fs.readFile(skill.path, 'utf8'),
      modifiedAt: stat.mtime.toISOString()
    }
  }

  const invokeCwd = requiredText(input.cwd, 'cwd', 4096)
  const selector = requiredText(input.selector, 'selector', 4096)
  const prompt = requiredText(input.prompt, 'prompt', 100_000)
  const skill = resolveSkill(skills, selector)
  if (!skill.enabled) throw new Error(`Codex native Skill is disabled: ${skill.name}`)
  const started = threadFrom(await runtime.startThread({ cwd: invokeCwd, approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: false }))
  const threadId = requiredText(started.id, 'threadId', 256)
  const turnStart = record(await runtime.startTurn({
    threadId,
    input: [
      { type: 'skill', name: skill.name, path: skill.path },
      { type: 'text', text: prompt, text_elements: [] }
    ]
  }, TURN_TIMEOUT_MS))
  const turn = Object.keys(record(turnStart.turn)).length ? record(turnStart.turn) : turnStart
  const turnId = requiredText(turn.id, 'turnId', 256)
  const terminal = await waitForTurn(runtime, threadId, turnId)
  if (terminal.status !== 'completed') {
    const error = record(terminal.turn.error)
    throw new Error(typeof error.message === 'string' ? error.message : `Codex Skill turn ended with ${terminal.status}`)
  }
  return {
    skill: { name: skill.name, scope: skill.scope },
    threadId,
    turnId,
    status: terminal.status,
    result: lastAgentMessage(terminal.turn)
  }
}
