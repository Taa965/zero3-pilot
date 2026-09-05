export function RuntimeWorkspace() {
  return (
    <div className="flex h-full flex-col bg-background p-6 overflow-y-auto">
      <div className="font-medium text-lg mb-6">Codex 核心 (Kernel)</div>
      
      <div className="grid grid-cols-2 gap-y-4 gap-x-8 max-w-lg mb-8 text-sm">
        <div className="text-(--ui-text-secondary)">运行状态</div>
        <div className="text-green-500 font-medium">就绪 (READY)</div>
        
        <div className="text-(--ui-text-secondary)">应用服务</div>
        <div className="text-foreground">运行中 (RUNNING)</div>
        
        <div className="text-(--ui-text-secondary)">二进制程序</div>
        <div className="text-foreground font-mono text-xs">内置 (bundled)</div>
        
        <div className="text-(--ui-text-secondary)">CODEX_HOME</div>
        <div className="text-foreground font-mono text-xs truncate">C:/Users/aaaa/AppData/Local/Zero3Pilot/codex</div>
        
        <div className="text-(--ui-text-secondary)">会话来源</div>
        <div className="text-foreground">app-server</div>
      </div>
      
      <div className="flex gap-4">
        <button className="rounded border border-(--ui-border) px-4 py-1.5 text-sm font-medium hover:bg-(--ui-control-hover-background)">重启 Kernel</button>
        <button className="rounded border border-(--ui-border) px-4 py-1.5 text-sm font-medium hover:bg-(--ui-control-hover-background)">查看日志</button>
      </div>
    </div>
  )
}
