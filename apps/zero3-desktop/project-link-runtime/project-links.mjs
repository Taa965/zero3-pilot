import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NativeProjects, readJson } from './native-projects.mjs'

export const PROVIDERS = ['codex', 'claude', 'antigravity']
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
export function canonicalRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('请选择有效的本地项目目录')
  const resolved = fs.realpathSync.native(root)
  if (!fs.statSync(resolved).isDirectory()) throw new Error('项目路径不是目录')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export class ProjectLinks {
  constructor({ stateDir, getProject, native, mcp, ...options }) {
    Object.assign(this, { stateDir, getProject, native: native ?? new NativeProjects(options), mcp })
    fs.mkdirSync(stateDir, { recursive: true })
    this.db = new DatabaseSync(path.join(stateDir, 'project-links.sqlite'))
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS provider_links(project_id TEXT,provider TEXT,body TEXT NOT NULL,PRIMARY KEY(project_id,provider));
      CREATE TABLE IF NOT EXISTS workspace_links(root_path TEXT PRIMARY KEY,project_id TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS binding_history(project_id TEXT,provider TEXT,external_id TEXT,root_path TEXT,PRIMARY KEY(project_id,provider,external_id));
      CREATE TABLE IF NOT EXISTS link_operations(project_id TEXT,provider TEXT,expires INTEGER,PRIMARY KEY(project_id,provider));`)
    if (!this.db.prepare('PRAGMA table_info(workspace_links)').all().some(column => column.name === 'active')) {
      this.db.exec('ALTER TABLE workspace_links ADD COLUMN active INTEGER NOT NULL DEFAULT 0')
    }
  }
  close() { this.db.close() }
  async project(projectId) {
    if (!id(projectId)) throw new Error('项目 ID 无效')
    const project = await this.getProject(projectId)
    if (!project) throw new Error('Zero3 项目不存在')
    canonicalRoot(project.rootPath)
    return project
  }
  get(projectId, provider) {
    const row = this.db.prepare('SELECT body FROM provider_links WHERE project_id=? AND provider=?').get(projectId, provider)
    return row ? JSON.parse(row.body) : null
  }
  put(projectId, provider, body) {
    this.db.prepare('INSERT OR REPLACE INTO provider_links VALUES (?,?,?)').run(projectId, provider, JSON.stringify(body))
    return body
  }
  claim(projectId, roots) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const root of roots) {
        const claim = this.db.prepare('SELECT project_id FROM workspace_links WHERE root_path=?').get(root)
        if (claim && claim.project_id !== projectId) throw new Error('此目录已经关联另一个 Zero3 项目，不能覆盖它的共享记忆')
        this.db.prepare('INSERT OR IGNORE INTO workspace_links (root_path,project_id) VALUES (?,?)').run(root, projectId)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  async list(projectId) {
    const project = await this.project(projectId)
    return Promise.all(PROVIDERS.map(async provider => {
      try { return { provider, binding: this.get(projectId, provider), projects: await this.native.list(provider, project.rootPath), error: null } }
      catch (error) { return { provider, binding: this.get(projectId, provider), projects: [], error: error.message } }
    }))
  }
  async resolve(projectId, provider) {
    const project = await this.project(projectId)
    if (!PROVIDERS.includes(provider)) throw new Error('不支持的应用')
    const binding = this.get(projectId, provider)
    if (binding && binding.state !== 'ready') throw new Error('应用项目关联尚未完成，请在项目总览中修复后重试')
    return binding ?? { provider, externalId: null, rootPath: project.rootPath, revision: 0 }
  }
  async install(provider, root, projectId) {
    const mcp = { ...this.mcp, env: { ...this.mcp.env, ZERO3_ACTIVE_PROJECT_ID: projectId, ZERO3_MEMORY_AUTO_PROJECT: '0' } }
    if (provider === 'claude') {
      // Reuse a matching existing configuration; the CLI add command refuses
      // duplicate names. Never remove a user's different same-name server.
      const local = await readJson(path.join(this.native.home, '.claude.json'), {})
      const existing = Object.entries(local.projects ?? {}).find(([p]) => { try { return canonicalRoot(p) === canonicalRoot(root) } catch { return false } })?.[1]?.mcpServers?.zero3_shared_memory
      if (existing) {
        if (existing.command !== mcp.command || JSON.stringify(existing.args) !== JSON.stringify(mcp.args) || Object.entries(mcp.env).some(([key,value]) => existing.env?.[key] !== value)) throw new Error('Claude 此目录已有不同的共享记忆配置，请先处理已有绑定')
        return
      }
      await this.native.configureClaude(root, mcp)
      return
    }
    const directory = path.join(root, provider === 'codex' ? '.codex' : '.agents')
    fs.mkdirSync(directory, { recursive: true })
    if (!canonicalRoot(directory).startsWith(canonicalRoot(root) + path.sep)) throw new Error('应用配置目录指向项目外部，请检查目录链接')
    const file = path.join(directory, provider === 'codex' ? 'config.toml' : 'mcp_config.json')
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    let next
    if (provider === 'codex') {
      const begin = '# BEGIN ZERO3 PROJECT MEMORY', end = '# END ZERO3 PROJECT MEMORY'
      const quote = value => JSON.stringify(value)
      const section = `${begin}\n[mcp_servers.zero3_shared_memory]\ncommand = ${quote(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\nenabled = true\nstartup_timeout_sec = 20\n[mcp_servers.zero3_shared_memory.env]\n${Object.entries(mcp.env).map(([k,v]) => `${k} = ${quote(v)}`).join('\n')}\n${end}`
      if (previous.includes(begin)) {
        const start = previous.indexOf(begin), finish = previous.indexOf(end, start)
        if (finish < 0) throw new Error('原有 Zero3 MCP 配置不完整')
        next = previous.slice(0,start) + section + previous.slice(finish + end.length)
      } else {
        if (/\[mcp_servers[.\s]+["']?zero3_shared_memory/.test(previous)) throw new Error('此目录已有同名 Codex MCP 配置，请先处理已有绑定')
        next = previous.trimEnd() + '\n\n' + section + '\n'
      }
    } else {
      const value = previous ? JSON.parse(previous) : {}
      const existing = value.mcpServers?.zero3_shared_memory
      if (existing && existing.env?.ZERO3_ACTIVE_PROJECT_ID !== projectId) throw new Error('此目录已有不同的 Antigravity 共享记忆配置')
      next = JSON.stringify({ ...value, mcpServers: { ...value.mcpServers, zero3_shared_memory: mcp } }, null, 2) + '\n'
    }
    // Avoid clobbering a concurrent editor or a symlink to an unrelated file.
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('配置文件是符号链接，请先检查')
    const temp = file + '.zero3-' + process.pid + '.tmp'
    fs.writeFileSync(temp, next, { flag: 'wx', mode: 0o600 })
    try {
      if ((fs.existsSync(file) ? fs.readFileSync(file,'utf8') : '') !== previous) throw new Error('应用配置刚刚发生变化，请重试')
      fs.renameSync(temp, file)
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  async connect({ projectId, provider, mode, externalId, rootPath }) {
    const project = await this.project(projectId)
    if (!PROVIDERS.includes(provider) || !['existing','create'].includes(mode)) throw new Error('项目关联请求无效')
    this.db.prepare('DELETE FROM link_operations WHERE expires < ?').run(Date.now())
    try { this.db.prepare('INSERT INTO link_operations VALUES (?,?,?)').run(projectId, provider, Date.now() + 180000) }
    catch { throw new Error('这个应用的项目关联正在进行，请勿重复提交') }
    let binding = this.get(projectId, provider)
    try {
      if (mode === 'create' && binding?.state === 'uncertain') throw new Error('上次创建结果未确认，请刷新后选择已有项目，避免重复创建')
      let target
      if (mode === 'create' && binding?.externalId) target = { id: binding.externalId, name: binding.name, rootPath: binding.rootPath }
      else if (mode === 'create') {
        // Reserve identity before any external side effect, including concurrent
        // requests from different Zero3 projects using the same directory.
        this.claim(projectId, [canonicalRoot(project.rootPath)])
        this.put(projectId, provider, { provider, state: 'uncertain', rootPath: project.rootPath, externalId: null })
        try { target = await this.native.create(provider, project) }
        catch (error) {
          if (error.noProjectCreated) this.put(projectId, provider, { provider, state: 'setup_failed', rootPath: project.rootPath, externalId: null })
          throw error
        }
      } else {
        const candidates = await this.native.list(provider, project.rootPath)
        target = candidates.find(p => p.id === externalId && (!rootPath || !p.rootPath || canonicalRoot(p.rootPath) === canonicalRoot(rootPath)))
        if (!target && provider === 'claude' && rootPath) target = { id: canonicalRoot(rootPath), name: path.basename(rootPath), rootPath }
        if (!target) throw new Error('找不到所选应用项目，请刷新后重新选择')
      }
      const root = canonicalRoot(target.rootPath || project.rootPath)
      const zero3Root = canonicalRoot(project.rootPath)
      for (const check of [root, zero3Root]) {
        const claim = this.db.prepare('SELECT project_id FROM workspace_links WHERE root_path=?').get(check)
        if (claim && claim.project_id !== projectId) throw new Error('此目录已经关联另一个 Zero3 项目，不能覆盖它的共享记忆')
      }
      binding = { provider, externalId: target.id, name: target.name, rootPath: root, state: 'setup_failed', revision: Date.now() }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const check of [root, zero3Root]) {
          const claim = this.db.prepare('SELECT project_id FROM workspace_links WHERE root_path=?').get(check)
          if (claim && claim.project_id !== projectId) throw new Error('目录已被另一个项目关联，请刷新')
          this.db.prepare('INSERT OR IGNORE INTO workspace_links (root_path,project_id) VALUES (?,?)').run(check,projectId)
        }
        const duplicate = this.db.prepare('SELECT project_id FROM provider_links WHERE provider=? AND project_id<>? AND json_extract(body,\'$.externalId\')=?').get(provider,projectId,target.id)
        if (duplicate) throw new Error('此应用项目已经关联另一个 Zero3 项目')
        const historical = this.db.prepare('SELECT project_id FROM binding_history WHERE provider=? AND external_id=? AND project_id<>?').get(provider,target.id,projectId)
        if (historical) throw new Error('此应用项目仍有另一个 Zero3 项目的历史会话，请选择其他应用项目')
        this.put(projectId,provider,binding); this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      await this.install(provider, root, projectId)
      binding.state = 'ready'
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.put(projectId,provider,binding)
        this.db.prepare('INSERT OR REPLACE INTO binding_history VALUES (?,?,?,?)').run(projectId,provider,binding.externalId,root)
        for (const check of [root, zero3Root]) this.db.prepare('UPDATE workspace_links SET active=1 WHERE root_path=? AND project_id=?').run(check,projectId)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      return binding
    } finally { this.db.prepare('DELETE FROM link_operations WHERE project_id=? AND provider=?').run(projectId,provider) }
  }
  async attachCodexThread({ projectId, externalId, threadId }) {
    await this.project(projectId)
    const binding = this.db.prepare('SELECT root_path FROM binding_history WHERE project_id=? AND provider=\'codex\' AND external_id=?').get(projectId, externalId)
    if (!binding || typeof threadId !== 'string' || !threadId.trim() || threadId.length > 256) throw new Error('Codex 项目绑定无效，请检查关联')
    await this.native.codex('thread/metadata/update', { threadId, projectId: externalId }, binding.root_path)
    return { attached: true }
  }
}
