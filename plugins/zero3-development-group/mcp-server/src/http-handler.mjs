import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'

import { createDevelopmentGroupMcpServer } from './server.mjs'

export function createDevelopmentGroupMcpHttpHandler(service) {
  return createMcpHandler(() => createDevelopmentGroupMcpServer(service))
}

export function createDevelopmentGroupMcpNodeHandler(service) {
  return toNodeHandler(createDevelopmentGroupMcpHttpHandler(service))
}
