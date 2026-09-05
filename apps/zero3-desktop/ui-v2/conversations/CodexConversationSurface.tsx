import { CodexMessageList } from '../codex/CodexMessageList'
import { Composer } from '../codex/Composer'

export function CodexConversationSurface() {
  return (
    <div className="flex h-full flex-col bg-background relative">
      <CodexMessageList />
      <Composer />
    </div>
  )
}
