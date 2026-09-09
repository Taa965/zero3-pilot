import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { app, ipcMain } from 'electron'

const execFileAsync = promisify(execFile)
const STATUS_CHANNEL = 'zero3:robots:weixin-status'
const BIND_CHANNEL = 'zero3:robots:weixin-bind'
const DISCONNECT_CHANNEL = 'zero3:robots:weixin-disconnect'

function resolveWeixinExecutable(): string {
  const configured = process.env.ZERO3_WEIXIN_BIN?.trim()
  const bundled = app.isPackaged && process.platform === 'win32'
    ? path.join(process.resourcesPath, 'zero3-weixin', 'zero3-pilot-weixin.exe')
    : ''
  const executable = configured || bundled
  if (!executable) throw new Error('Zero3 微信机器人程序未配置。请重新启动 Zero3 Pilot。')
  if (app.isPackaged && executable !== bundled) {
    throw new Error('已打包的 Zero3 Pilot 只能启动内置微信机器人程序。')
  }
  if (!fs.existsSync(executable)) throw new Error(`微信机器人程序不存在：${executable}`)
  return executable
}

async function runWeixinCommand(command: 'status' | 'disconnect'): Promise<unknown> {
  const executable = resolveWeixinExecutable()
  const { stdout } = await execFileAsync(executable, [command], {
    cwd: path.dirname(executable),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  if (command === 'disconnect') return { ok: true }
  try {
    return JSON.parse(stdout.trim()) as unknown
  } catch {
    throw new Error('微信机器人状态返回了无法解析的数据。')
  }
}

async function launchBindingWindow(): Promise<{ started: true }> {
  if (process.platform !== 'win32') {
    throw new Error('当前绑定启动器只支持 Windows。')
  }
  const executable = resolveWeixinExecutable()
  const workingDirectory = path.dirname(executable)
  const launchScript = "Start-Process -FilePath $env:ZERO3_WEIXIN_LAUNCH_EXE -ArgumentList 'login' -WorkingDirectory $env:ZERO3_WEIXIN_LAUNCH_CWD"
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launchScript], {
    cwd: workingDirectory,
    env: {
      ...process.env,
      ZERO3_WEIXIN_LAUNCH_EXE: executable,
      ZERO3_WEIXIN_LAUNCH_CWD: workingDirectory
    },
    timeout: 10_000,
    windowsHide: true
  })
  return { started: true }
}

export function registerWeixinRobotDesktopIpc(): () => void {
  ipcMain.handle(STATUS_CHANNEL, () => runWeixinCommand('status'))
  ipcMain.handle(BIND_CHANNEL, () => launchBindingWindow())
  ipcMain.handle(DISCONNECT_CHANNEL, () => runWeixinCommand('disconnect'))

  return () => {
    ipcMain.removeHandler(STATUS_CHANNEL)
    ipcMain.removeHandler(BIND_CHANNEL)
    ipcMain.removeHandler(DISCONNECT_CHANNEL)
  }
}
