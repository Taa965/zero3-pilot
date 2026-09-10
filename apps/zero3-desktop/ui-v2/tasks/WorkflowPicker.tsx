import type { WorkflowModuleManifest } from './WorkflowAdapter'

export function WorkflowPicker({ modules, onSelect }: { modules: WorkflowModuleManifest[]; onSelect: (module: WorkflowModuleManifest) => void }) {
  return (
    <div className="mx-auto w-full max-w-4xl p-8">
      <div className="mb-2 text-xl font-semibold">新建任务</div>
      <div className="mb-6 text-sm text-(--ui-text-secondary)">选择一个代码化工作流模块。任务中心只负责装载和运行监控，业务规则由模块自身提供。</div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {modules.map(module => (
          <button key={`${module.id}@${module.version}`} onClick={() => onSelect(module)} className="rounded-xl border border-(--ui-border) bg-(--ui-pane-background) p-5 text-left transition hover:bg-(--ui-control-hover-background)">
            <div className="flex items-start justify-between gap-3">
              <div className="font-medium">{module.name}</div>
              <div className="rounded bg-(--ui-control-background) px-2 py-0.5 text-[11px] text-(--ui-text-tertiary)">v{module.version}</div>
            </div>
            <div className="mt-2 text-sm text-(--ui-text-secondary)">{module.description}</div>
            <div className="mt-4 flex flex-wrap gap-1.5 text-[11px] text-(--ui-text-tertiary)">
              {module.requiredExecutors.map(value => <span key={value} className="rounded border border-(--ui-border) px-1.5 py-0.5">{value}</span>)}
            </div>
          </button>
        ))}
      </div>
      {modules.length === 0 && <div className="rounded-lg border border-dashed border-(--ui-border) p-8 text-center text-sm text-(--ui-text-tertiary)">当前没有已注册 Workflow Module。</div>}
    </div>
  )
}
