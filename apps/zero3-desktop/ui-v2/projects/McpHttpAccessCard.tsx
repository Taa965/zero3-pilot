import { useCallback, useEffect, useState } from 'react'

import { McpHttpAdapter, type Zero3McpHttpStatusRecord } from '../adapters/McpHttpAdapter'

interface McpHttpAccessCardProps {
  projectId: string
}

export function McpHttpAccessCard({ projectId }: McpHttpAccessCardProps) {
  const [status, setStatus] = useState<Zero3McpHttpStatusRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await McpHttpAdapter.status())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const enabled = Boolean(status?.enabledProjectIds.includes(projectId))

  const setEnabled = useCallback(async (next: boolean) => {
    setBusy(true)
    try {
      await McpHttpAdapter.setProjectAccess(projectId, next)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [projectId, refresh])

  const rotate = useCallback(async () => {
    setBusy(true)
    try {
      await McpHttpAdapter.rotateToken()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  if (!McpHttpAdapter.available()) return null

  return (
    <div className="rounded-lg border border-(--ui-border) bg-background p-4 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">网页 MCP 访问</div>
          <div className="mt-1 text-xs text-(--ui-text-tertiary)">默认关闭；仅向网页端暴露 decisions / pitfalls / glossary。</div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} disabled={!status || busy} onChange={event => void setEnabled(event.target.checked)} />
          允许此项目
        </label>
      </div>
      {status && (
        <div className="mt-4 grid gap-2 text-xs">
          <div><span className="text-(--ui-text-tertiary)">本地端点：</span><span className="break-all">{status.endpoint}</span></div>
          <div><span className="text-(--ui-text-tertiary)">写入：</span>{status.writeVerified ? '已通过实测并启用' : '锁定为只读（待 Developer Mode 实测）'}</div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-(--ui-text-tertiary)">Bearer token：</span>
            <code className="min-w-0 flex-1 truncate" title={status.bearerToken}>{status.bearerToken}</code>
            <button className="rounded border border-(--ui-border) px-2 py-1 hover:bg-(--ui-control-hover-background)" disabled={busy} onClick={() => void rotate()}>
              重置令牌
            </button>
          </div>
        </div>
      )}
      {error && <div className="mt-3 text-xs text-red-600">{error}</div>}
    </div>
  )
}
