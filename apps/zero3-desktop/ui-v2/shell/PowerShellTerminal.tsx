import '@xterm/xterm/css/xterm.css'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

interface PowerShellTerminalProps {
  cwd: string
}

type TerminalState =
  | { status: 'starting'; shell: string }
  | { status: 'open'; shell: string }
  | { status: 'closed'; shell: string }
  | { status: 'error'; shell: string; message: string }

function cssToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function isPowerShell(shell: string): boolean {
  return /(^|[\\/])(pwsh|powershell)(\.exe)?$/iu.test(shell) || /^(pwsh|powershell)(\.exe)?$/iu.test(shell)
}

function sameCwd(left: string, right: string): boolean {
  const normalize = (value: string) => value.split('\\').join('/').replace(/\/+$/gu, '').toLowerCase()
  return normalize(left) === normalize(right)
}

export function PowerShellTerminal({ cwd }: PowerShellTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<TerminalState>({ status: 'starting', shell: 'PowerShell' })

  useEffect(() => {
    const host = hostRef.current
    const api = window.hermesDesktop?.terminal
    if (!host || !api) {
      setState({ status: 'error', shell: 'PowerShell', message: '终端运行时不可用' })
      return
    }

    let disposed = false
    let sessionId: string | null = null
    let removeData: (() => void) | null = null
    let removeExit: (() => void) | null = null

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      scrollback: 2000,
      theme: {
        background: cssToken('--ui-terminal-surface-background', '#0c0c0c'),
        foreground: cssToken('--ui-text-primary', '#f3f4f6'),
        cursor: cssToken('--ui-text-primary', '#f3f4f6')
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    const resize = () => {
      if (disposed || host.clientWidth <= 0 || host.clientHeight <= 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      if (sessionId) void api.resize(sessionId, { cols: term.cols, rows: term.rows })
    }

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(host)
    resize()

    const input = term.onData(data => {
      if (sessionId) void api.write(sessionId, data)
    })

    void api.start({ cols: term.cols, cwd, rows: term.rows })
      .then(session => {
        if (disposed) {
          void api.dispose(session.id)
          return
        }
        if (!isPowerShell(session.shell)) {
          void api.dispose(session.id)
          setState({ status: 'error', shell: session.shell, message: `当前 Shell 为 ${session.shell}，未启动 PowerShell` })
          term.write(`\r\nPowerShell unavailable. Resolved shell: ${session.shell}\r\n`)
          return
        }
        if (!sameCwd(String(session.cwd ?? ''), cwd)) {
          void api.dispose(session.id)
          setState({ status: 'error', shell: session.shell, message: '当前项目路径不可用，PowerShell 未启动' })
          term.write(`\r\nProject cwd unavailable: ${cwd}\r\n`)
          return
        }

        sessionId = session.id
        setState({ status: 'open', shell: session.shell })
        removeData = api.onData(session.id, data => term.write(data))
        removeExit = api.onExit(session.id, () => {
          sessionId = null
          setState({ status: 'closed', shell: session.shell })
          term.write('\r\n[PowerShell 已退出]\r\n')
        })
        resize()
        term.focus()
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        setState({ status: 'error', shell: 'PowerShell', message })
        term.write(`\r\nPowerShell failed to start: ${message}\r\n`)
      })

    return () => {
      disposed = true
      observer?.disconnect()
      input.dispose()
      removeData?.()
      removeExit?.()
      if (sessionId) void api.dispose(sessionId)
      term.dispose()
    }
  }, [cwd])

  const statusLabel = state.status === 'open'
    ? 'READY'
    : state.status === 'starting'
      ? 'STARTING'
      : state.status === 'closed'
        ? 'CLOSED'
        : 'ERROR'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-(--ui-border) bg-(--ui-terminal-surface-background)">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--ui-border) px-3 text-xs">
        <span className="font-mono text-(--ui-text-secondary)">{state.shell || 'PowerShell'}</span>
        <span className={state.status === 'open' ? 'font-medium text-green-500' : 'text-(--ui-text-tertiary)'}>
          {statusLabel}
        </span>
      </div>
      {state.status === 'error' && (
        <div className="border-b border-(--ui-border) px-3 py-2 text-xs text-red-500">{state.message}</div>
      )}
      <div
        className="min-h-[280px] flex-1 overflow-hidden p-2 [&_.xterm]:h-full [&_.xterm-screen]:h-full"
        ref={hostRef}
      />
    </div>
  )
}
