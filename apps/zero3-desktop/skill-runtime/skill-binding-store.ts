import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { zero3AtomicWriteFile } from '../workspace-runtime/atomic-file'
import type { Zero3SkillBinding, Zero3SkillBindingTargetType } from './skill-types'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const TARGET_TYPES = new Set<Zero3SkillBindingTargetType>(['agent', 'workflow', 'task-template'])
type BindingInput = Omit<Zero3SkillBinding, 'bindingId' | 'createdAt' | 'updatedAt'> & { bindingId?: string }

function text(value: unknown, label: string, max = 4096): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`)
  return normalized
}
function type(value: unknown): Zero3SkillBindingTargetType {
  if (!TARGET_TYPES.has(value as Zero3SkillBindingTargetType)) throw new Error('targetType is invalid')
  return value as Zero3SkillBindingTargetType
}
function rank(value: unknown): number {
  const number = value == null ? 0 : Number(value)
  if (!Number.isInteger(number) || number < -1000 || number > 1000) throw new Error('priority is invalid')
  return number
}

export class Zero3SkillBindingStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}

  async list(): Promise<Zero3SkillBinding[]> {
    try {
      const buffer = await fs.readFile(this.file)
      if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('Skill binding store exceeds size limit')
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown
      if (!Array.isArray(parsed)) throw new Error('Skill binding store is invalid')
      return parsed.map(value => structuredClone(value as Zero3SkillBinding))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  upsert(input: BindingInput): Promise<Zero3SkillBinding> {
    return this.mutate(async () => {
      const current = await this.list()
      const now = new Date().toISOString()
      const bindingId = input.bindingId?.trim() || `skill-binding-${randomUUID()}`
      const existing = current.find(binding => binding.bindingId === bindingId)
      const record: Zero3SkillBinding = {
        bindingId,
        targetType: type(input.targetType),
        targetId: text(input.targetId, 'targetId', 256),
        skillName: text(input.skillName, 'skillName', 256),
        skillPath: text(input.skillPath, 'skillPath'),
        enabled: input.enabled !== false,
        autoInvoke: input.autoInvoke === true,
        priority: rank(input.priority),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      await this.write([...current.filter(binding => binding.bindingId !== bindingId), record])
      return structuredClone(record)
    })
  }

  remove(bindingIdValue: unknown): Promise<boolean> {
    return this.mutate(async () => {
      const bindingId = text(bindingIdValue, 'bindingId', 256)
      const current = await this.list()
      const next = current.filter(binding => binding.bindingId !== bindingId)
      if (next.length === current.length) return false
      await this.write(next)
      return true
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async write(bindings: Zero3SkillBinding[]) {
    const body = `${JSON.stringify(bindings, null, 2)}\n`
    if (Buffer.byteLength(body, 'utf8') > MAX_FILE_BYTES) throw new Error('Skill binding store exceeds size limit')
    await zero3AtomicWriteFile(this.file, body)
  }
}
