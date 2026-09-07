export type Zero3McpHttpStatusRecord = {
  running: boolean
  host: string
  port: number
  endpoint: string
  bearerToken: string
  writeVerified: boolean
  enabledProjectIds: string[]
}
type McpHttpBridge = {
  status: () => Promise<Zero3McpHttpStatusRecord>
  setProjectAccess: (request: { projectId: string; enabled: boolean }) => Promise<{ projectId: string; enabled: boolean }>
  rotateToken: () => Promise<{ bearerToken: string }>
}
function bridge(): McpHttpBridge | null {
  return ((window as Window & { zero3McpHttp?: McpHttpBridge }).zero3McpHttp ?? null)
}
function requireBridge(): McpHttpBridge {
  const value = bridge()
  if (!value) throw new Error('Zero3 网页 MCP 运行时尚未加载')
  return value
}
export const McpHttpAdapter = {
  available: () => bridge() !== null,
  status: () => requireBridge().status(),
  setProjectAccess: (projectId: string, enabled: boolean) => requireBridge().setProjectAccess({ projectId, enabled }),
  async rotateToken(): Promise<string> { return (await requireBridge().rotateToken()).bearerToken }
}
