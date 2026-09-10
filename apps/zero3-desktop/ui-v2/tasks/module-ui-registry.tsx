import type { ComponentType } from 'react'

import type { WorkflowSnapshot } from './WorkflowAdapter'
import { CognitiveStoreVideoCreateRun } from './modules/cognitive-store-video/CreateRun'
import { CognitiveStoreVideoRunView } from './modules/cognitive-store-video/RunView'

type CreateProps = { moduleVersion: string }
type RunProps = { snapshot: WorkflowSnapshot }

type ModuleUiRegistration = {
  CreateRun: ComponentType<CreateProps>
  RunView: ComponentType<RunProps>
}

const registry = new Map<string, ModuleUiRegistration>([
  ['cognitive-store-video', { CreateRun: CognitiveStoreVideoCreateRun, RunView: CognitiveStoreVideoRunView }]
])

export function workflowModuleUi(uiKind: string): ModuleUiRegistration | null {
  return registry.get(uiKind) ?? null
}
