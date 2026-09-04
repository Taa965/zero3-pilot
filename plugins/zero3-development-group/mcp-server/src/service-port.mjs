const REQUIRED_METHODS = [
  'createGroup',
  'getGroup',
  'listSessions',
  'startWave',
  'validateDelivery',
  'integrateDelivery',
  'runVerification',
  'getCompletionProof'
]

export function assertDevelopmentGroupMcpService(service) {
  if (!service || typeof service !== 'object') throw new Error('Development Group MCP service is required')
  for (const method of REQUIRED_METHODS) {
    if (typeof service[method] !== 'function') throw new Error(`Development Group MCP service is missing ${method}()`)
  }
  return service
}
