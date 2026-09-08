import { useEffect, useRef, useState } from 'react'
import type { WorkspaceSession } from './session-types'

export function RenameSessionDialog({ session, onSave, onCancel }: {
  session: WorkspaceSession
  onSave: (title: string) => Promise<void>
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(session.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savingRef = useRef(false)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    inputRef.current?.select()
    return () => dialog.close()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="rename-session-title"
      onCancel={event => { event.preventDefault(); if (!savingRef.current) onCancel() }}
      className="fixed inset-0 m-auto w-full max-w-md rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-5 text-foreground shadow-lg backdrop:bg-black/40"
    >
      <form onSubmit={async event => {
        event.preventDefault()
        if (savingRef.current || !title.trim()) return
        savingRef.current = true
        setSaving(true)
        setError(null)
        try { await onSave(title.trim()) }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
        finally { savingRef.current = false; setSaving(false) }
      }}>
        <h2 id="rename-session-title" className="mb-3 font-medium">修改名称</h2>
        <label htmlFor="rename-session-input" className="mb-1 block text-sm">会话名称</label>
        <input
          ref={inputRef}
          id="rename-session-input"
          autoFocus
          required
          maxLength={200}
          value={title}
          disabled={saving}
          onChange={event => setTitle(event.target.value)}
          className="w-full rounded-md border border-(--ui-stroke-secondary) bg-background px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
        {session.provider === 'gpt' && session.source === 'web' && (
          <p className="mt-2 text-xs text-(--ui-text-secondary)">保存后将同步修改 ChatGPT 网页中的会话名称。</p>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm hover:bg-(--ui-control-hover-background) disabled:opacity-50">取消</button>
          <button type="submit" disabled={saving || !title.trim()} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">{saving ? '正在保存…' : '保存'}</button>
        </div>
      </form>
    </dialog>
  )
}
