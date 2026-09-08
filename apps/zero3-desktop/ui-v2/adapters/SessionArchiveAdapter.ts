import { LocalSessionAdapter } from './LocalSessionAdapter'
import { WebWorkspaceAdapter } from './WebWorkspaceAdapter'
import type { WorkspaceSession } from '../conversations/session-types'

export type SessionArchiveResult = {
  native: boolean
  detail: string
}

export const SessionArchiveAdapter = {
  async setArchived(session: WorkspaceSession, archived: boolean): Promise<SessionArchiveResult> {
    if (session.source === 'web') {
      await WebWorkspaceAdapter.setArchived(session, archived)
      return session.provider === 'gpt'
        ? { native: true, detail: archived ? 'ChatGPT conversation archived' : 'ChatGPT conversation unarchived' }
        : { native: false, detail: 'Gemini has no wired native archive API; Zero3 archive metadata was updated' }
    }

    if (session.provider === 'gpt' || session.provider === 'gemini') throw new Error('Web provider cannot use the local archive bridge')
    const localProvider = session.provider
    const record = LocalSessionAdapter.get(session.id)
    if (!record) throw new Error('Local session was not found')

    if (localProvider === 'antigravity' && archived && record.runtimeId) {
      await window.zero3Antigravity.stop({ logicalSessionId: record.runtimeId }).catch(() => {})
    }

    const result = await window.zero3SessionProviders.setArchived({
      provider: localProvider,
      runtimeId: record.runtimeId,
      archived
    })

    try {
      LocalSessionAdapter.setArchived(session.id, archived)
    } catch (error) {
      if (result.native && record.runtimeId) {
        await window.zero3SessionProviders.setArchived({
          provider: localProvider,
          runtimeId: record.runtimeId,
          archived: !archived
        }).catch(() => {})
      }
      throw error
    }
    return result
  }
}
