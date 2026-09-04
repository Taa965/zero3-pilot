import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const CONFIG_RELATIVE = path.join('.agents', 'mcp_config.json')

export type Zero3TaskMcpLeaseInput = {
  taskId: string
  projectId: string
  workspace: string
  taskSnapshot: unknown
  serverPath: string
  electronExecutable: string
  stateDir: string
  artifactDir: string
  reviewDir: string
  projectContextDir: string
}

type Backup = { existed: boolean; content: string | null }

function required(value: unknown, label: string, max = 4096) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} is invalid`)
  return text
}

function scopedId(value: unknown, label: string): string {
  const text = required(value, label, 256)
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function storageName(logicalId: string): string {
  return createHash('sha256').update(logicalId, 'utf8').digest('hex')
}

export class Zero3AntigravityMcpLease {
  private backup: Backup | null = null
  private configPath: string | null = null
  private taskSnapshotPath: string | null = null

  async install(input: Zero3TaskMcpLeaseInput): Promise<void> {
    if (this.backup) throw new Error('Antigravity MCP lease is already installed')
    const workspace = path.resolve(required(input.workspace, 'workspace'))
    const taskId = scopedId(input.taskId, 'taskId')
    const projectId = scopedId(input.projectId, 'projectId')
    const configPath = path.join(workspace, CONFIG_RELATIVE)
    const taskSnapshotPath = path.join(path.resolve(input.stateDir), 'tasks', `${storageName(taskId)}.json`)
    await fs.mkdir(path.dirname(taskSnapshotPath), { recursive: true })
    await atomicJson(taskSnapshotPath, input.taskSnapshot)

    let existingRaw: string | null = null
    try { existingRaw = await fs.readFile(configPath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.backup = { existed: existingRaw != null, content: existingRaw }
    this.configPath = configPath
    this.taskSnapshotPath = taskSnapshotPath

    let config: Record<string, unknown> = {}
    if (existingRaw?.trim()) {
      const parsed = JSON.parse(existingRaw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('existing .agents/mcp_config.json must be an object')
      config = parsed as Record<string, unknown>
    }
    const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? { ...(config.mcpServers as Record<string, unknown>) }
      : {}
    if ('zero3_task' in servers) throw new Error('workspace already defines reserved MCP server id zero3_task')
    servers.zero3_task = {
      command: path.resolve(input.electronExecutable),
      args: [path.resolve(input.serverPath)],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ZERO3_MCP_TASK_ID: taskId,
        ZERO3_MCP_PROJECT_ID: projectId,
        ZERO3_MCP_STATE_DIR: path.resolve(input.stateDir),
        ZERO3_MCP_ARTIFACT_DIR: path.resolve(input.artifactDir),
        ZERO3_MCP_REVIEW_DIR: path.resolve(input.reviewDir),
        ZERO3_PROJECT_CONTEXT_DIR: path.resolve(input.projectContextDir)
      }
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await atomicJson(configPath, { ...config, mcpServers: servers })
  }

  async restore(): Promise<void> {
    const backup = this.backup
    const configPath = this.configPath
    this.backup = null
    this.configPath = null
    if (!backup || !configPath) return
    if (backup.existed) {
      await fs.writeFile(configPath, backup.content ?? '', { encoding: 'utf8' })
    } else {
      try { await fs.unlink(configPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try { await fs.rmdir(path.dirname(configPath)) } catch {}
    }
  }
}

async function atomicJson(file: string, value: unknown) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, file)
}
