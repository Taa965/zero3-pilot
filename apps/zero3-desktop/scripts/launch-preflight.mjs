import { existsSync } from 'node:fs'
import path from 'node:path'

// A console handed down from an agent, an MCP server or a CI shell keeps that
// parent's sandbox: files outside the workspace stay invisible and the network
// can be switched off. Zero3 then probes the machine through that keyhole and
// reports installed CLIs as 未安装 with no hint that the launch is at fault --
// which is exactly the failure this preflight exists to name up front.
const RESTRICTION_MARKERS = [
  ['CODEX_SANDBOX_NETWORK_DISABLED', '网络已禁用'],
  ['CODEX_PERMISSION_PROFILE', '文件访问被限制在工作区'],
  ['CODEX_SESSION_ID', '由 Codex 会话派生']
]

// The directories the CLIs Zero3 drives actually install into. Reading them is
// the cheapest honest proxy for "detection will work": the sandbox that hides
// them is the same one that breaks every probe.
function installDirectories(env) {
  const roaming = env.APPDATA
  const local = env.LOCALAPPDATA
  return [
    roaming ? { label: 'npm 全局目录 (claude / codex)', dir: path.join(roaming, 'npm') } : null,
    local ? { label: 'WinGet Links (agy)', dir: path.join(local, 'Microsoft', 'WinGet', 'Links') } : null
  ].filter(Boolean)
}

export function describeLaunchEnvironment({ env = process.env, exists = existsSync } = {}) {
  const markers = RESTRICTION_MARKERS
    .filter(([name]) => String(env[name] ?? '').trim() !== '')
    .map(([name, description]) => ({ name, description }))

  const pathEntries = String(env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const onPath = new Set(pathEntries.map(entry => entry.toLowerCase()))

  // A directory that exists but cannot be read comes back the same as one that
  // is not there, and that is the point: either way Zero3 cannot see the CLI.
  const locations = installDirectories(env).map(({ label, dir }) => ({
    label,
    dir,
    visible: exists(dir),
    onPath: onPath.has(dir.toLowerCase())
  }))

  const invisible = locations.filter(location => !location.visible)
  return {
    markers,
    locations,
    // Missing directories are only a problem when something is hiding them; a
    // machine that simply has no npm globals is not a restricted launch.
    restricted: markers.length > 0,
    degraded: markers.length > 0 || (locations.length > 0 && invisible.length === locations.length)
  }
}

export function formatLaunchReport(description) {
  const lines = []
  if (description.markers.length > 0) {
    lines.push('[Zero3] 警告：当前进程处于受限环境，本机 CLI 检测会失败。')
    for (const marker of description.markers) lines.push(`        ${marker.name} → ${marker.description}`)
    lines.push('        请在资源管理器中双击 Start-Zero3.cmd，或在普通 CMD / PowerShell 窗口中运行它。')
    return lines
  }

  for (const location of description.locations) {
    if (location.visible) continue
    lines.push(`[Zero3] 提示：未找到 ${location.label}（${location.dir}）。`)
    lines.push('        若该 CLI 确实已安装，说明启动环境看不到它，新建会话时会显示为未安装。')
  }
  if (lines.length === 0) lines.push('[Zero3] 启动环境正常：本机 CLI 安装目录可见。')
  return lines
}

export function reportLaunchEnvironment(log = console.log) {
  const description = describeLaunchEnvironment()
  for (const line of formatLaunchReport(description)) log(line)
  return description
}
