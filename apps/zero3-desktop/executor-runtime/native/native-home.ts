import os from 'node:os'
import path from 'node:path'

export interface NativeCodexHomeOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

export function resolveNativeSubscriptionCodexHome({
  env = process.env,
  homeDir = os.homedir()
}: NativeCodexHomeOptions = {}): string {
  const explicit = String(env.ZERO3_NATIVE_CODEX_HOME ?? '').trim()
  if (explicit) return path.resolve(explicit)
  return path.join(homeDir, '.codex')
}

export function nativeCodexAppServerEnv(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const home = codexHome.trim()
  if (!home) throw new Error('native Codex home must be non-empty')
  return { ...env, CODEX_HOME: home }
}
