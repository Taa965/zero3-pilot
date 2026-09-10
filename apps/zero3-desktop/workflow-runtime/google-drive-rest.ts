import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { GoogleDriveWritableArtifactPort, GoogleDriveUploadRequest, GoogleDriveUploadResult } from './artifact-router.ts'

export interface GoogleDriveAccessTokenProvider {
  accessToken(): Promise<string>
}

export class GoogleDriveAccessTokenFileProvider implements GoogleDriveAccessTokenProvider {
  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) throw new Error('Google Drive access token file must be absolute')
  }

  async accessToken(): Promise<string> {
    const token = (await readFile(this.file, 'utf8')).trim()
    if (token.length < 16) throw new Error('Google Drive access token file is empty or invalid')
    return token
  }
}

export interface GoogleOAuthRefreshTokenOptions {
  clientId: string
  clientSecretFile: string
  refreshTokenFile: string
  tokenEndpoint?: string
  fetchImpl?: typeof fetch
  clock?: () => number
}

export class GoogleOAuthRefreshTokenProvider implements GoogleDriveAccessTokenProvider {
  private readonly fetchImpl: typeof fetch
  private readonly clock: () => number
  private cached: { token: string; expiresAt: number } | null = null

  constructor(private readonly options: GoogleOAuthRefreshTokenOptions) {
    if (!options.clientId.trim()) throw new Error('Google OAuth client id is required')
    if (!path.isAbsolute(options.clientSecretFile) || !path.isAbsolute(options.refreshTokenFile)) {
      throw new Error('Google OAuth secret paths must be absolute')
    }
    this.fetchImpl = options.fetchImpl ?? fetch
    this.clock = options.clock ?? (() => Date.now())
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.clock()) return this.cached.token
    const [clientSecret, refreshToken] = await Promise.all([
      readFile(this.options.clientSecretFile, 'utf8').then(value => value.trim()),
      readFile(this.options.refreshTokenFile, 'utf8').then(value => value.trim())
    ])
    if (!clientSecret || !refreshToken) throw new Error('Google OAuth credential file is empty')
    const body = new URLSearchParams({
      client_id: this.options.clientId.trim(),
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
    const response = await this.fetchImpl(this.options.tokenEndpoint ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!response.ok) throw new Error(`Google OAuth refresh failed (${response.status})`)
    const payload = await response.json() as { access_token?: string; expires_in?: number }
    const token = payload.access_token?.trim()
    if (!token) throw new Error('Google OAuth refresh returned no access token')
    const ttl = Number.isFinite(payload.expires_in) ? Math.max(60, Number(payload.expires_in)) : 3600
    this.cached = { token, expiresAt: this.clock() + ttl * 1000 }
    return token
  }
}

type DriveFileMetadata = {
  id: string
  name?: string
  mimeType?: string
  size?: string
  webViewLink?: string
  parents?: string[]
  trashed?: boolean
}

export interface GoogleDriveRestPortOptions {
  apiBaseUrl?: string
  uploadBaseUrl?: string
  fetchImpl?: typeof fetch
  maxUploadBytes?: number
}

function escapeQuery(value: string): string { return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'") }
function safeName(value: string): string {
  const name = path.basename(value.replace(/\\/gu, '/')).replace(/[\0\r\n]/gu, '').trim()
  if (!name || name === '.' || name === '..') throw new Error('Google Drive file name is invalid')
  return name.slice(0, 240)
}
function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.md') return 'text/markdown'
  if (ext === '.txt') return 'text/plain'
  if (ext === '.json') return 'application/json'
  if (ext === '.zip') return 'application/zip'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.mp4') return 'video/mp4'
  return 'application/octet-stream'
}

export class GoogleDriveRestArtifactPort implements GoogleDriveWritableArtifactPort {
  private readonly apiBaseUrl: string
  private readonly uploadBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly maxUploadBytes: number

  constructor(private readonly tokens: GoogleDriveAccessTokenProvider, options: GoogleDriveRestPortOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://www.googleapis.com/drive/v3').replace(/\/$/u, '')
    this.uploadBaseUrl = (options.uploadBaseUrl ?? 'https://www.googleapis.com/upload/drive/v3').replace(/\/$/u, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxUploadBytes = options.maxUploadBytes ?? 64 * 1024 * 1024
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.tokens.accessToken()
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    const response = await this.fetchImpl(url, { ...init, headers })
    if (!response.ok) {
      let detail = ''
      try { detail = (await response.text()).slice(0, 512) } catch {}
      throw new Error(`Google Drive API request failed (${response.status})${detail ? `: ${detail}` : ''}`)
    }
    return response
  }

  private async metadata(fileId: string): Promise<DriveFileMetadata> {
    const id = fileId.trim()
    if (!id) throw new Error('Google Drive fileId is required')
    const fields = encodeURIComponent('id,name,mimeType,size,webViewLink,parents,trashed')
    return this.request(`${this.apiBaseUrl}/files/${encodeURIComponent(id)}?fields=${fields}`)
      .then(response => response.json() as Promise<DriveFileMetadata>)
  }

  async verifyFile(fileId: string): Promise<boolean> {
    try { return (await this.metadata(fileId)).trashed !== true } catch { return false }
  }

  async downloadFile(fileId: string, targetRoot: string): Promise<{ path: string }> {
    const meta = await this.metadata(fileId)
    await mkdir(targetRoot, { recursive: true })
    const target = path.join(path.resolve(targetRoot), safeName(meta.name || fileId))
    const response = await this.request(`${this.apiBaseUrl}/files/${encodeURIComponent(fileId.trim())}?alt=media`)
    if (!response.body) throw new Error('Google Drive download returned no body')
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target, { mode: 0o600 }))
    return { path: target }
  }

  private async findByArtifactId(parentFolderId: string | null, artifactId: string): Promise<DriveFileMetadata | null> {
    const clauses = ["trashed = false", `appProperties has { key='zero3ArtifactId' and value='${escapeQuery(artifactId)}' }`]
    if (parentFolderId) clauses.push(`'${escapeQuery(parentFolderId)}' in parents`)
    const params = new URLSearchParams({
      q: clauses.join(' and '),
      pageSize: '2',
      fields: 'files(id,name,mimeType,size,webViewLink,parents,trashed)'
    })
    const payload = await this.request(`${this.apiBaseUrl}/files?${params}`).then(response => response.json() as Promise<{ files?: DriveFileMetadata[] }>)
    return payload.files?.[0] ?? null
  }

  async ensureFolder(parentFolderId: string | null, name: string, appProperties: Readonly<Record<string, string>> = {}): Promise<{ fileId: string; webUrl?: string }> {
    const folderName = safeName(name)
    const key = appProperties.zero3FolderKey?.trim()
    const clauses = [
      "trashed = false",
      "mimeType = 'application/vnd.google-apps.folder'",
      `name = '${escapeQuery(folderName)}'`
    ]
    if (parentFolderId) clauses.push(`'${escapeQuery(parentFolderId)}' in parents`)
    if (key) clauses.push(`appProperties has { key='zero3FolderKey' and value='${escapeQuery(key)}' }`)
    const query = new URLSearchParams({ q: clauses.join(' and '), pageSize: '2', fields: 'files(id,name,webViewLink,parents)' })
    const found = await this.request(`${this.apiBaseUrl}/files?${query}`).then(response => response.json() as Promise<{ files?: DriveFileMetadata[] }>)
    const existing = found.files?.[0]
    if (existing) return { fileId: existing.id, ...(existing.webViewLink ? { webUrl: existing.webViewLink } : {}) }
    const metadata: Record<string, unknown> = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentFolderId ? { parents: [parentFolderId] } : {}),
      ...(Object.keys(appProperties).length ? { appProperties } : {})
    }
    const created = await this.request(`${this.apiBaseUrl}/files?fields=id,name,webViewLink,parents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metadata)
    }).then(response => response.json() as Promise<DriveFileMetadata>)
    return { fileId: created.id, ...(created.webViewLink ? { webUrl: created.webViewLink } : {}) }
  }

  async ensureFolderPath(rootFolderId: string | null, segments: readonly string[], scopeKey: string): Promise<{ fileId: string; webUrl?: string }> {
    let parent = rootFolderId
    let latest: { fileId: string; webUrl?: string } | null = null
    for (let index = 0; index < segments.length; index += 1) {
      const segment = safeName(segments[index])
      latest = await this.ensureFolder(parent, segment, { zero3FolderKey: `${scopeKey}:${index}:${segment}`.slice(0, 120) })
      parent = latest.fileId
    }
    if (!latest) throw new Error('Google Drive folder path cannot be empty')
    return latest
  }

  async uploadFile(request: GoogleDriveUploadRequest): Promise<GoogleDriveUploadResult> {
    const sourcePath = path.resolve(request.sourcePath)
    const info = await stat(sourcePath)
    if (!info.isFile()) throw new Error('Google Drive upload source must be a file')
    if (info.size > this.maxUploadBytes) throw new Error(`Google Drive simple upload exceeds ${this.maxUploadBytes} bytes; use resumable upload`)
    const artifactId = request.artifactId.trim()
    if (!artifactId) throw new Error('Google Drive upload artifactId is required')
    const existing = await this.findByArtifactId(request.parentFolderId ?? null, artifactId)
    if (existing) {
      return {
        fileId: existing.id,
        ...(existing.webViewLink ? { webUrl: existing.webViewLink } : {}),
        sizeBytes: existing.size ? Number(existing.size) : info.size,
        sha256: await readFile(sourcePath).then(data => createHash('sha256').update(data).digest('hex')),
        reused: true
      }
    }
    const data = await readFile(sourcePath)
    const sha256 = createHash('sha256').update(data).digest('hex')
    const name = safeName(request.fileName || path.basename(sourcePath))
    const mimeType = request.mimeType?.trim() || mimeFor(name)
    const metadata = {
      name,
      ...(request.parentFolderId ? { parents: [request.parentFolderId] } : {}),
      appProperties: {
        zero3ArtifactId: artifactId,
        ...(request.appProperties ?? {})
      }
    }
    const boundary = `zero3_${randomUUID().replace(/-/gu, '')}`
    const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`)
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([prefix, data, suffix])
    const created = await this.request(`${this.uploadBaseUrl}/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,parents`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body
    }).then(response => response.json() as Promise<DriveFileMetadata>)
    return {
      fileId: created.id,
      ...(created.webViewLink ? { webUrl: created.webViewLink } : {}),
      sizeBytes: created.size ? Number(created.size) : data.byteLength,
      sha256,
      reused: false
    }
  }
}

export function createGoogleDriveArtifactPortFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleDriveRestArtifactPort | null {
  const tokenFile = env.ZERO3_GOOGLE_DRIVE_ACCESS_TOKEN_FILE?.trim()
  let tokens: GoogleDriveAccessTokenProvider | null = null
  if (tokenFile) tokens = new GoogleDriveAccessTokenFileProvider(path.resolve(tokenFile))
  const clientId = env.ZERO3_GOOGLE_DRIVE_CLIENT_ID?.trim()
  const clientSecretFile = env.ZERO3_GOOGLE_DRIVE_CLIENT_SECRET_FILE?.trim()
  const refreshTokenFile = env.ZERO3_GOOGLE_DRIVE_REFRESH_TOKEN_FILE?.trim()
  if (!tokens && clientId && clientSecretFile && refreshTokenFile) {
    tokens = new GoogleOAuthRefreshTokenProvider({
      clientId,
      clientSecretFile: path.resolve(clientSecretFile),
      refreshTokenFile: path.resolve(refreshTokenFile)
    })
  }
  return tokens ? new GoogleDriveRestArtifactPort(tokens) : null
}
