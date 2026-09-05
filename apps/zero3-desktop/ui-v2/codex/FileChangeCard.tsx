import { Codicon } from '@/components/ui/codicon'

interface FileChangeCardProps {
  filePath: string
  changeType: 'M' | 'A' | 'D'
  additions?: number
  deletions?: number
}

export function FileChangeCard({ filePath, changeType, additions = 0, deletions = 0 }: FileChangeCardProps) {
  return (
    <div className="rounded-md border border-(--ui-border) p-3 text-sm my-2 max-w-2xl bg-(--ui-pane-background) flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className={`font-mono text-xs font-bold ${changeType === 'M' ? 'text-amber-500' : changeType === 'A' ? 'text-green-500' : 'text-red-500'}`}>
          {changeType}
        </span>
        <span className="flex-1 font-mono text-xs truncate">{filePath}</span>
        <div className="flex items-center gap-2 text-xs">
          {additions > 0 && <span className="text-green-500">+{additions}</span>}
          {deletions > 0 && <span className="text-red-500">-{deletions}</span>}
        </div>
      </div>
      <div className="flex gap-4 text-xs text-blue-500">
        <button className="hover:underline flex items-center gap-1"><Codicon name="git-compare" className="size-3.5" /> 查看 Diff</button>
        <button className="hover:underline flex items-center gap-1"><Codicon name="go-to-file" className="size-3.5" /> 打开文件</button>
      </div>
    </div>
  )
}
