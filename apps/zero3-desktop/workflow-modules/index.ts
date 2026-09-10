import { Zero3WorkflowRegistry } from '../workflow-runtime/registry.ts'
import { cognitiveStoreVideoModule } from './cognitive-store-video/index.ts'

export function createBuiltinWorkflowRegistry(): Zero3WorkflowRegistry {
  const registry = new Zero3WorkflowRegistry()
  registry.register(cognitiveStoreVideoModule)
  return registry
}

export * from './cognitive-store-video/index.ts'
