#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openSharedMemory } from './shared-memory-runtime.mjs'

// Usable from a terminal, automation, or the connected Desktop Commander app.
const args = process.argv.slice(2)
function option(name) { const i = args.indexOf(name); if (i < 0) return null; const value = args[i + 1]; if (!value) throw new Error(`${name} requires a value`); args.splice(i, 2); return value }
let memory
try {
  const defaultConfig = process.platform === 'win32' ? path.join(os.homedir(), 'Documents', 'Zero3 Pilot', 'zero3', 'shared-memory.json') : path.join(os.homedir(), '.config', 'zero3', 'shared-memory.json')
  const configPath = option('--config') ?? process.env.ZERO3_SHARED_MEMORY_CONFIG ?? defaultConfig
  const projectId = option('--project') ?? process.env.ZERO3_ACTIVE_PROJECT_ID
  const [command = 'get', input] = args
  if (!projectId) throw new Error('--project is required')
  if (!['get', 'status', 'publish', 'handoff'].includes(command)) throw new Error('usage: memory-cli.mjs --project ID [--config PATH] get|status|publish EVENT.json|handoff TASK_ID')
  memory = await openSharedMemory({ configPath, projectId })
  let value
  if (command === 'get') value = await memory.getProject(projectId)
  else if (command === 'status') value = memory.status(input)
  else if (command === 'handoff') { if (!input) throw new Error('task ID is required'); value = await memory.getHandoff(input) }
  else { if (!input) throw new Error('event JSON file is required'); value = await memory.publish(JSON.parse(await fs.readFile(input, 'utf8'))) }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  if (value?.state === 'conflict' || value?.state === 'rejected') process.exitCode = 2
} catch (error) {
  console.error(error instanceof Error ? error.message : 'shared memory operation failed')
  process.exitCode = 1
} finally { await memory?.close() }
