import { CodexItemRenderer } from './CodexItemRenderer'

// Mock Data
const mockTurns = [
  {
    id: 't1',
    role: 'user',
    content: '我希望把所有界面的英文翻译为中文。'
  },
  {
    id: 't2',
    role: 'assistant',
    reasoning: '用户要求将界面语言中文化。我需要遍历工作区组件并更新文案。',
    plan: '1. 检索 ui-v2 文件夹\n2. 将 WorkspaceRouter.tsx 翻译为中文\n3. 将 TaskWorkspace.tsx 翻译为中文',
    tools: [
      { name: 'grep_search', status: 'completed', duration: '120ms' },
      { name: 'replace_file_content', status: 'completed', duration: '300ms' }
    ],
    files: [
      { path: 'apps/zero3-desktop/ui-v2/shell/WorkspaceRouter.tsx', status: 'modified' }
    ],
    content: '好的，我已经更新了工作区组件，并替换为中文。'
  }
]

export function CodexMessageList() {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {mockTurns.map(turn => (
        <CodexItemRenderer key={turn.id} item={turn as any} />
      ))}
    </div>
  )
}
