import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'

import { assertDevelopmentGroupMcpService } from './service-port.mjs'

const idSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 160,
  pattern: '^[^\\u0000\\r\\n]+$'
}
const shaSchema = { type: 'string', pattern: '^[0-9a-fA-F]{40}$' }
const stringList = { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 512 } }

export const REVIEW_TOOL_DEFINITIONS = [
  {
    name: 'development_group_create',
    title: 'Create Development Group',
    description: 'Create a durable, bounded coding work plan from an explicit repository goal. This creates state but does not automatically start a wave.',
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['goal', 'repository', 'baselineSha', 'integrationRef'],
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: 20000 },
        repository: { type: 'string', minLength: 1, maxLength: 512 },
        baselineSha: shaSchema,
        integrationRef: { type: 'string', minLength: 1, maxLength: 256 },
        ownedPaths: stringList,
        forbiddenPaths: stringList,
        maxParallelSessions: { type: 'integer', minimum: 1, maximum: 12 },
        mandatoryTests: stringList
      }
    }
  },
  {
    name: 'development_group_get',
    title: 'Get Development Group',
    description: 'Read the durable Development Group status, blockers, progress, integration SHA, verification summary and evidence projection.',
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: 'object', additionalProperties: false, required: ['groupId'], properties: { groupId: idSchema } }
  },
  {
    name: 'development_group_list_sessions',
    title: 'List Development Sessions',
    description: 'Read bounded Development Sessions, requirements, dependencies, branches and current execution states for one Group.',
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: 'object', additionalProperties: false, required: ['groupId'], properties: { groupId: idSchema } }
  },
  {
    name: 'development_group_start_wave',
    title: 'Start Development Wave',
    description: 'Start only dependency-eligible Sessions in the named wave under the frozen concurrency, attempt and permission policy. Refuses unresolved OutcomeUnknown.',
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['groupId', 'waveId'], properties: { groupId: idSchema, waveId: idSchema } }
  },
  {
    name: 'development_group_validate_delivery',
    title: 'Validate Development Delivery',
    description: 'Revalidate an existing durable Delivery against exact Git head, baseline ancestry, path ownership, Delivery hash and required Handoff evidence without merging.',
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: 'object', additionalProperties: false, required: ['groupId', 'sessionId'], properties: { groupId: idSchema, sessionId: idSchema } }
  },
  {
    name: 'development_group_integrate_delivery',
    title: 'Integrate Development Delivery',
    description: 'Revalidate and merge one dependency-ready Delivery into the frozen integration ref. A failed post-merge guard restores the exact prior integration SHA.',
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['groupId', 'sessionId'], properties: { groupId: idSchema, sessionId: idSchema } }
  },
  {
    name: 'development_group_run_verification',
    title: 'Run Development Group Verification',
    description: 'Run only the server-side frozen verification command set against the exact final integration SHA and active policy revision. Arbitrary command input is not accepted.',
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['groupId'], properties: { groupId: idSchema } }
  },
  {
    name: 'development_group_get_completion_proof',
    title: 'Get Development Group Completion Proof',
    description: 'Build the fail-closed Completion Proof or return the exact unresolved gates. This does not mark the Group complete.',
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: 'object', additionalProperties: false, required: ['groupId'], properties: { groupId: idSchema } }
  }
]

const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|stack|environment|private[_-]?key|access[_-]?key|refresh[_-]?key|raw[_-]?exception)/iu

function minimize(value, depth = 0) {
  if (depth > 8) return '[truncated-depth]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => minimize(item, depth + 1))
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue
      result[key] = minimize(entry, depth + 1)
    }
    return result
  }
  return String(value)
}

function result(value) {
  const structuredContent = { result: minimize(value) }
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  }
}

function errorResult(error) {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true
  }
}

async function invoke(service, name, args) {
  switch (name) {
    case 'development_group_create': return service.createGroup(args)
    case 'development_group_get': return service.getGroup(args.groupId)
    case 'development_group_list_sessions': return service.listSessions(args.groupId)
    case 'development_group_start_wave': return service.startWave(args.groupId, args.waveId)
    case 'development_group_validate_delivery': return service.validateDelivery(args.groupId, args.sessionId)
    case 'development_group_integrate_delivery': return service.integrateDelivery(args.groupId, args.sessionId)
    case 'development_group_run_verification': return service.runVerification(args.groupId)
    case 'development_group_get_completion_proof': return service.getCompletionProof(args.groupId)
    default: throw new Error(`unsupported Development Group MCP tool ${name}`)
  }
}

export function createDevelopmentGroupMcpServer(rawService) {
  const service = assertDevelopmentGroupMcpService(rawService)
  const server = new McpServer(
    { name: 'zero3-development-group', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
  for (const definition of REVIEW_TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        annotations: definition.annotations,
        inputSchema: fromJsonSchema(definition.inputSchema)
      },
      async args => {
        try {
          return result(await invoke(service, definition.name, args))
        } catch (error) {
          return errorResult(error)
        }
      }
    )
  }
  return server
}
