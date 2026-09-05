import type { ExecutorId, ExecutorProbe, Zero3Executor } from './executor-types.ts'

export class ExecutorRegistryError extends Error {}

export class Zero3ExecutorRegistry {
  readonly #executors = new Map<ExecutorId, Zero3Executor>()

  register(executor: Zero3Executor): void {
    const id = executor.descriptor.id.trim()
    if (!id) throw new ExecutorRegistryError('executor id must be non-empty')
    if (this.#executors.has(id)) {
      throw new ExecutorRegistryError(`executor already registered: ${id}`)
    }
    this.#executors.set(id, executor)
  }

  unregister(id: ExecutorId): boolean {
    return this.#executors.delete(id)
  }

  get(id: ExecutorId): Zero3Executor | undefined {
    return this.#executors.get(id)
  }

  require(id: ExecutorId): Zero3Executor {
    const executor = this.get(id)
    if (!executor) throw new ExecutorRegistryError(`executor is not registered: ${id}`)
    return executor
  }

  list(): readonly Zero3Executor[] {
    return [...this.#executors.values()]
  }

  async probeAll(): Promise<ExecutorProbe[]> {
    return Promise.all(this.list().map(executor => executor.probe()))
  }
}
