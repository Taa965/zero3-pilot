import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Zero3RemoteHostConfig } from './remote-types'

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parseWorkspaceList(value: string | undefined): string[] {
  if (!value) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of value.split(';')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const resolved = path.resolve(trimmed)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    result.push(resolved)
  }
  return result
}

function defaultNodeId(): string {
  const host = os.hostname().trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'host'
  return `zero3-${host}`
}

function defaultMappingStateFile(): string {
  return path.join(os.homedir(), '.zero3-pilot', 'remote-host', 'task-mappings.json')
}

export function loadZero3RemoteHostConfig(): Zero3RemoteHostConfig {
  const enabled = parseBoolean(process.env.ZERO3_REMOTE_HOST_ENABLED, false)
  const baseUrl = process.env.ZERO3_REMOTE_HOST_BASE_URL?.trim() || null
  const tokenFile = process.env.ZERO3_REMOTE_HOST_TOKEN_FILE?.trim() || null
  const nodeId = process.env.ZERO3_REMOTE_HOST_NODE_ID?.trim() || defaultNodeId()
  const allowedWorkspaces = parseWorkspaceList(process.env.ZERO3_REMOTE_HOST_WORKSPACES)
  const developmentAllowHttp = parseBoolean(process.env.ZERO3_REMOTE_HOST_ALLOW_HTTP, false)
  const mappingStateFile = path.resolve(
    process.env.ZERO3_REMOTE_HOST_MAPPING_STATE_FILE?.trim() || defaultMappingStateFile()
  )

  if (!enabled) {
    return { enabled, baseUrl, tokenFile, nodeId, allowedWorkspaces, developmentAllowHttp, mappingStateFile }
  }
  if (!baseUrl) throw new Error('ZERO3_REMOTE_HOST_BASE_URL is required when remote host is enabled')
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:' && !(developmentAllowHttp && parsed.protocol === 'http:')) {
    throw new Error('Zero3 Remote Host control plane must use HTTPS')
  }
  if (parsed.username || parsed.password) throw new Error('Zero3 Remote Host URL must not contain inline credentials')
  if (!tokenFile) throw new Error('ZERO3_REMOTE_HOST_TOKEN_FILE is required when remote host is enabled')
  const tokenPath = path.resolve(tokenFile)
  if (!fs.statSync(tokenPath).isFile()) throw new Error('Zero3 Remote Host token file does not exist')
  if (allowedWorkspaces.length === 0) {
    throw new Error('ZERO3_REMOTE_HOST_WORKSPACES must contain at least one local allow-listed workspace')
  }

  return {
    enabled,
    baseUrl: parsed.toString().replace(/\/$/, ''),
    tokenFile: tokenPath,
    nodeId,
    allowedWorkspaces,
    developmentAllowHttp,
    mappingStateFile
  }
}

export function zero3RemoteWorkspaceAllowed(config: Zero3RemoteHostConfig, requested: string): string | null {
  const resolved = path.resolve(requested)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  for (const allowed of config.allowedWorkspaces) {
    const allowedKey = process.platform === 'win32' ? allowed.toLowerCase() : allowed
    if (key === allowedKey) return allowed
  }
  return null
}
