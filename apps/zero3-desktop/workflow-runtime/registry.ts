import type { WorkflowModule, WorkflowModuleManifest, WorkflowValidationResult } from './contracts.ts'
import { validateWorkflowRunPlan } from './validators.ts'

function moduleKey(id: string, version: string): string { return `${id}@${version}` }

export class Zero3WorkflowRegistry {
  readonly #modules = new Map<string, WorkflowModule>()
  readonly #latestById = new Map<string, WorkflowModule>()

  register(module: WorkflowModule): void {
    const { id, version } = module.manifest
    if (!id.trim() || !version.trim()) throw new Error('workflow module id/version are required')
    const key = moduleKey(id, version)
    if (this.#modules.has(key)) throw new Error(`workflow module already registered: ${key}`)
    this.#modules.set(key, module)
    const latest = this.#latestById.get(id)
    if (!latest || version.localeCompare(latest.manifest.version, undefined, { numeric: true }) >= 0) this.#latestById.set(id, module)
  }

  list(): WorkflowModuleManifest[] {
    return [...this.#latestById.values()].map(module => ({ ...module.manifest })).sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string, version?: string | null): WorkflowModule {
    const module = version ? this.#modules.get(moduleKey(id, version)) : this.#latestById.get(id)
    if (!module) throw new Error(`workflow module not found: ${version ? moduleKey(id, version) : id}`)
    return module
  }

  validate(id: string, input: unknown, version?: string | null): WorkflowValidationResult {
    return this.get(id, version).validateCreateInput(input)
  }

  createRun(id: string, input: unknown, version?: string | null) {
    const module = this.get(id, version)
    const validation = module.validateCreateInput(input)
    if (!validation.valid) throw new Error(`workflow input is invalid: ${validation.errors.join('; ')}`)
    const plan = module.createRun(input)
    if (plan.moduleId !== module.manifest.id || plan.moduleVersion !== module.manifest.version) {
      throw new Error('workflow module returned a plan with mismatched module identity')
    }
    const planErrors = validateWorkflowRunPlan(plan)
    if (planErrors.length) throw new Error(`workflow module returned an invalid run plan: ${planErrors.join('; ')}`)
    return plan
  }
}
