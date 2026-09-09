import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.stdin.end(); child.kill()
  })
}

// Native operations go through supported CLIs. Never manufacture provider
// project/session IDs or edit a provider's database to pretend creation worked.
export class NativeProjects {
  constructor({ home, resolveCommand, codexEnv = process.env, env = process.env }) {
    Object.assign(this, { home, resolveCommand, codexEnv, env })
  }
  start(provider, args, cwd) {
    const name = provider === 'codex' ? this.env.ZERO3_CODEX_CLI_BIN || 'codex' : provider === 'claude' ? this.env.ZERO3_CLAUDE_BIN || 'claude' : this.env.ZERO3_ANTIGRAVITY_BIN || 'agy'
    const resolved = this.resolveCommand(name)
    return spawn(resolved.command, [...resolved.args, ...args], { cwd, env: provider === 'codex' ? this.codexEnv : this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  async codex(method, params, cwd) {
    const child = this.start('codex', ['app-server'], cwd)
    const pending = new Map()
    let nextId = 0
    const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) } pending.clear() }
    child.stdin.on('error', () => fail(new Error('Codex 项目接口连接已关闭')))
    child.on('error', () => fail(Object.assign(new Error('Codex CLI 无法启动，请检查安装路径'), { noProjectCreated: true })))
    child.on('exit', () => fail(new Error('Codex 项目接口已退出')))
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (line.length > 4 * 1024 * 1024) return fail(new Error('Codex 项目响应过大'))
      try {
        const message = JSON.parse(line), p = pending.get(message.id)
        if (p) { pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result) }
      } catch { /* Non-protocol diagnostic. */ }
    })
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex 项目接口超时，请刷新后重试')) }, 20000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    try {
      await request('initialize', { clientInfo: { name: 'zero3-project-links', version: '1.0.0' }, capabilities: { experimentalApi: true } })
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
      return await request(method, params)
    } finally { fail(new Error('Project client closed')); lines.close(); await stop(child) }
  }
  async antigravityProjects() {
    const dir = path.join(this.home, '.gemini', 'config', 'projects')
    let files
    try { files = await fs.readdir(dir) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const result = []
    for (const file of files.filter(file => file.endsWith('.json')).slice(0, 1000)) {
      const value = await readJson(path.join(dir, file), null)
      if (typeof value?.id === 'string' && typeof value.name === 'string') result.push({ id: value.id, name: value.name, rootPath: null })
    }
    return result
  }
  async list(provider, cwd) {
    if (provider === 'codex') {
      const projects = []; let cursor = null
      do {
        const response = await this.codex('project/list', { limit: 100, cursor }, cwd)
        projects.push(...response.data.flatMap(p => p.roots.map(root => ({ id: p.id, name: p.name, rootPath: root.path }))))
        cursor = response.nextCursor
      } while (cursor && projects.length < 1000)
      return projects
    }
    if (provider === 'claude') {
      const value = await readJson(path.join(this.home, '.claude.json'), {})
      const projects = new Map()
      for (const root of Object.keys(value.projects ?? {}).filter(root => path.isAbsolute(root))) {
        let resolved
        try { resolved = await fs.realpath(root); if (!(await fs.stat(resolved)).isDirectory()) continue } catch { continue }
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
        projects.set(key, { id: key, name: path.basename(resolved), rootPath: resolved })
      }
      return [...projects.values()]
    }
    return this.antigravityProjects()
  }
  async create(provider, project) {
    if (provider === 'codex') {
      const response = await this.codex('project/create', { name: project.name, roots: [{ path: project.rootPath }], metadata: { zero3ProjectId: project.id }, idempotencyKey: `zero3:${project.id}:codex` }, project.rootPath)
      return { id: response.project.id, name: response.project.name, rootPath: project.rootPath }
    }
    if (provider === 'claude') return { id: project.rootPath, name: project.name, rootPath: project.rootPath }
    const before = new Set((await this.antigravityProjects()).map(p => p.id))
    const child = this.start('antigravity', ['--new-project', '--add-dir', project.rootPath, '--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox'], project.rootPath)
    child.stdin.on('error', () => {})
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Antigravity 创建结果未确认；请刷新项目列表检查，勿重复创建')), 30000)
        const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve() }
        child.once('error', () => done(Object.assign(new Error('Antigravity CLI 无法启动，请检查安装与登录'), { noProjectCreated: true })))
        child.once('exit', () => done(new Error('Antigravity 创建项目未完成，请检查登录状态')))
        lines.on('line', line => {
          try {
            const value = JSON.parse(line)
            if (value.event === 'init') done()
            if (value.event === 'auth_required' || value.event === 'error') done(new Error('Antigravity 需要登录或创建失败，请检查应用'))
          } catch { /* Non-protocol diagnostic. */ }
        })
      })
      const added = (await this.antigravityProjects()).filter(p => !before.has(p.id))
      if (added.length !== 1) throw new Error('Antigravity 新项目身份未唯一确认，请刷新后手动关联')
      return { ...added[0], rootPath: project.rootPath }
    } finally { lines.close(); await stop(child) }
  }
  async configureClaude(rootPath, mcp) {
    const child = this.start('claude', ['mcp', 'add-json', '--scope', 'local', 'zero3_shared_memory', JSON.stringify(mcp)], rootPath)
    child.stdin.on('error', () => {})
    child.stdout.resume(); child.stderr.resume(); child.stdin.end()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Claude Code 项目配置超时')) }, 15000)
      child.once('error', () => { clearTimeout(timer); reject(new Error('Claude Code 未安装或无法启动，项目关联尚未完成')) })
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Claude Code 未接受项目配置，请检查同名 MCP 配置后重试')) })
    })
  }
}
