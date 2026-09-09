import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

function canonical(value) {
  let result = path.resolve(value)
  try { result = fs.realpathSync.native(result) } catch { /* New directory. */ }
  return process.platform === 'win32' ? result.toLowerCase() : result
}
function git(cwd, ...args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return null }
}
function remoteIdentity(remote) {
  if (!remote) return null
  const scp = remote.match(/^(?:[^/@]+@)?([^/:]+):(.+)$/)
  if (scp && !remote.includes('://') && !/^[A-Za-z]:[\\/]/.test(remote)) remote = `ssh://${scp[1]}/${scp[2]}`
  try {
    const url = new URL(remote)
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null
    let repo = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
    if (url.hostname.toLowerCase() === 'github.com') repo = repo.toLowerCase()
    return repo ? `${url.hostname.toLowerCase()}/${repo}` : null
  } catch { return null }
}

// Codex passes its task cwd to stdio MCP servers. Never pin a global MCP's cwd
// to one repository. Persist identity before returning it so adding/changing an
// origin later cannot silently move an existing workspace into an empty scope.
export function resolveWorkspaceScope({ cwd = process.cwd(), config }) {
  if (!path.isAbsolute(config.cacheDir)) throw new Error('cacheDir must be absolute')
  const current = canonical(cwd)
  const top = git(current, 'rev-parse', '--show-toplevel')
  const common = top && git(current, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const workspace = canonical(common && path.basename(common) === '.git' ? path.dirname(common) : (top || current))
  // An explicit user association from Zero3 takes precedence over automatic
  // discovery. Keep the previous automatic registry intact; no history merges.
  if (config.projectLinksFile && fs.existsSync(config.projectLinksFile)) {
    const links = new DatabaseSync(config.projectLinksFile, { readOnly: true })
    try {
      const rows = links.prepare('SELECT root_path,project_id FROM workspace_links WHERE active=1 ORDER BY length(root_path) DESC').all()
      const match = rows.find(row => workspace === row.root_path || (!top && current.startsWith(row.root_path + path.sep)))
      if (match) return { projectId: match.project_id, workspace }
    } finally { links.close() }
  }
  const mappings = Object.entries(config.projectMappings ?? {}).map(([root, projectId]) => [canonical(root), projectId])
    .sort((a, b) => b[0].length - a[0].length)
  const registered = mappings.find(([root]) => workspace === root || (!top && current.startsWith(root + path.sep)))
  const workspaceKey = registered?.[0] ?? workspace
  const mappedId = registered?.[1]
  if (mappedId && !/^[A-Za-z0-9._:-]{1,256}$/.test(mappedId)) throw new Error('invalid registered project ID')
  fs.mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 })
  const filename = path.join(config.cacheDir, 'workspace-scopes.sqlite')
  fs.closeSync(fs.openSync(filename, 'a', 0o600))
  const db = new DatabaseSync(filename)
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspace_scopes (workspace TEXT PRIMARY KEY, project_id TEXT NOT NULL)')
    const known = db.prepare('SELECT project_id FROM workspace_scopes WHERE workspace=?').get(workspaceKey)
    const identity = remoteIdentity(top && git(current, 'remote', 'get-url', 'origin')) ?? workspaceKey
    const candidate = known?.project_id ?? mappedId ?? `project-codex-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
    db.prepare('INSERT OR IGNORE INTO workspace_scopes (workspace,project_id) VALUES (?,?)').run(workspaceKey, candidate)
    return { projectId: db.prepare('SELECT project_id FROM workspace_scopes WHERE workspace=?').get(workspaceKey).project_id, workspace: workspaceKey }
  } finally { db.close() }
}
