import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './config.mjs'

// Serialize reloads: stop the old tree completely before creating its successor.
// Key repeats during a build/stop collapse into a single pending reload.
export class ReloadController {
  current = null
  pending = false
  closing = false
  transition = null

  constructor({ start, stop, onError = console.error }) {
    Object.assign(this, { start, stop, onError })
  }

  reload() {
    if (this.closing) return Promise.resolve()
    this.pending = true
    if (this.transition) return this.transition
    this.transition = (async () => {
      while (this.pending && !this.closing) {
        this.pending = false
        try {
          if (this.current) {
            await this.stop(this.current)
            this.current = null
          }
          // Keys pressed while stopping are covered by the build about to start.
          this.pending = false
          if (!this.closing) this.current = await this.start()
        } catch (error) {
          this.pending = false
          this.onError(error)
        }
      }
    })().finally(() => { this.transition = null })
    return this.transition
  }

  async quit() {
    this.closing = true
    this.pending = false
    await this.transition
    if (this.current) {
      await this.stop(this.current)
      this.current = null
    }
  }
}

function portIsBusy(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = busy => { socket.destroy(); resolve(busy) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(700, () => finish(false))
  })
}

export async function runConsole() {
  if (process.platform !== 'win32') throw new Error('This launcher requires Windows.')
  if (!process.stdin.isTTY) throw new Error('Open Start-Zero3.cmd in an interactive CMD window.')
  const title = 'Zero3 Pilot - Source Console'
  process.stdout.write(`\x1b]0;${title}\x07`)
  const helper = path.join(repoRoot, 'apps/zero3-desktop/scripts/dev-console-windows.ps1')
  const powershell = (action, rootPid) => spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-Action', action, '-RootProcessId', String(rootPid), '-ConsoleTitle', title
  ], { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] })
  const completed = child => new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Process cleanup failed (${code}).`)))
  })
  const hint = () => console.log('\n[R] 重新编译并重载   [Q / Ctrl+C] 退出（无需回车）\n')
  const controller = new ReloadController({
    start: async () => {
      for (const port of [5174, 9222]) {
        if (await portIsBusy(port)) throw new Error(`端口 ${port} 正在使用。请关闭已运行的 Zero3 开发实例，再按 R。`)
      }
      console.log('\n正在应用源码并启动 Zero3…')
      const child = spawn(process.execPath, [path.join(repoRoot, 'apps/zero3-desktop/scripts/run.mjs'), 'dev', '--desktop-reload'], {
        cwd: repoRoot,
        env: { ...process.env, ZERO3_DESKTOP_ALREADY_PREPARED: '0' },
        stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      const focus = powershell('WaitAndFocus', child.pid)
      focus.on('error', error => console.error('无法切回 CMD：', error.message))
      child.once('exit', code => {
        focus.kill()
        if (!controller.closing) {
          console.log(`\n源码运行进程已退出（${code ?? '终止'}）。`)
          hint()
        }
      })
      hint()
      return { child, focus }
    },
    stop: async ({ child, focus }) => {
      focus.kill()
      if (child.exitCode !== null || child.signalCode !== null) return
      console.log('\n正在关闭本次启动的 Zero3…')
      await completed(powershell('Stop', child.pid)).catch(error => {
        if (child.exitCode === null && child.signalCode === null) throw error
      })
    },
    onError: error => { console.error(`\n启动失败：${error.message}`); hint() }
  })
  let quitting = false
  const quit = async () => {
    if (quitting) return
    quitting = true
    try {
      await controller.quit()
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    } finally {
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
  }
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', chunk => {
    for (const key of chunk.toString().toLowerCase()) {
      if (key === 'r') void controller.reload()
      else if (key === 'q' || key === '\u0003') void quit()
    }
  })
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  await controller.reload()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runConsole().catch(error => { console.error(error.message); process.exitCode = 1 })
}
