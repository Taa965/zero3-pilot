import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

export function resolveCargo(env = process.env) {
  const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
  const directories = String(env[pathKey] ?? '').split(path.delimiter).filter(Boolean)
  // Explorer may retain the PATH from before Rust was installed. Honour a
  // custom CARGO_HOME too, without changing the user's persistent environment.
  const cargoHome = env.CARGO_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.cargo')
  directories.push(path.join(cargoHome, 'bin'))
  for (const directory of directories) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), executable)
    if (isFile(candidate)) return candidate
  }
  throw new Error('[Zero3] 未找到 Cargo，无法编译 Rust 组件。请安装 Rust 工具链，或将其 bin 目录加入 PATH / 设置 CARGO_HOME 后重试。桌面重载可复用已有的 debug 程序；首次构建和正式打包仍需要 Cargo。')
}

export function runCargo(args, { cwd, env = process.env, spawn = spawnSync }) {
  const cargo = resolveCargo(env)
  const result = spawn(cargo, args, { cwd, env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cargo ${args.join(' ')} exited with status ${result.status}`)
}

export function zero3WeixinBinary(repoRoot, profile = 'debug') {
  if (!['debug', 'release'].includes(profile)) throw new Error(`Unsupported Weixin build profile: ${profile}`)
  const executable = process.platform === 'win32' ? 'zero3-pilot-weixin.exe' : 'zero3-pilot-weixin'
  return path.join(repoRoot, 'target', profile, executable)
}

export function ensureZero3WeixinBinary({ repoRoot, env, profile = 'debug', desktopReload = false, build = runCargo, log = console.log }) {
  const binary = zero3WeixinBinary(repoRoot, profile)
  // R only rebuilds the desktop shell. Match the pinned Codex core's reuse
  // policy so a checkout with compiled binaries can launch without Rust.
  if (desktopReload && profile === 'debug' && isFile(binary)) {
    log('[Zero3] Desktop reload: reusing the compiled Weixin robot.')
    return binary
  }
  const args = ['build', '-p', 'zero3-weixin']
  if (profile === 'release') args.push('--release')
  build(args, { cwd: repoRoot, env })
  if (!isFile(binary)) throw new Error(`Zero3 Weixin binary was not produced at ${binary}`)
  return binary
}
