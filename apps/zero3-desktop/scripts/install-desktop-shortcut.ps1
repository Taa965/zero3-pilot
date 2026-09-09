#Requires -Version 5.1
<#
.SYNOPSIS
    在桌面创建 Zero3 Pilot 源码启动的快捷方式，并挂上产品图标。

.DESCRIPTION
    快捷方式指向仓库根目录的 Start-Zero3.cmd。用快捷方式启动而不是让别的程序
    代为启动，本身就是修复之一：Zero3 会继承启动者的沙箱限制，那会让本机 CLI
    检测全部失败。桌面快捷方式由资源管理器启动，环境是干净的。

    重复执行是安全的，会覆盖同名快捷方式。

.PARAMETER HotKey
    分配给快捷方式的全局快捷键，默认 Ctrl+Alt+Z。传入空字符串则不分配。

.PARAMETER Name
    快捷方式名称（不含 .lnk 后缀）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File apps\zero3-desktop\scripts\install-desktop-shortcut.ps1

.EXAMPLE
    # 不要全局快捷键
    ... -File ...\install-desktop-shortcut.ps1 -HotKey ''
#>
[CmdletBinding()]
param(
    [string]$Name = 'Zero3 Pilot 源码启动',
    [string]$HotKey = 'Ctrl+Alt+Z',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$target = Join-Path $repoRoot 'Start-Zero3.cmd'
$icon = Join-Path $repoRoot 'apps\zero3-desktop\assets\zero3-pilot.ico'

# GetFolderPath rather than $env:USERPROFILE\Desktop: a OneDrive-redirected
# desktop lives somewhere else entirely, and writing to the stale path creates
# a shortcut the user never sees.
$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop)) { throw '无法定位桌面目录。' }
$linkPath = Join-Path $desktop ($Name + '.lnk')

if ($Remove) {
    if (Test-Path -LiteralPath $linkPath) {
        Remove-Item -LiteralPath $linkPath -Force
        Write-Host "[Zero3] 已删除快捷方式：$linkPath"
    } else {
        Write-Host "[Zero3] 桌面上没有该快捷方式：$linkPath"
    }
    return
}

foreach ($required in @($target, $icon)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "缺少必需文件：$required"
    }
}

$shell = New-Object -ComObject WScript.Shell
try {
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = $target
    # Without this the console starts in system32 and every relative path in the
    # launcher resolves against the wrong root.
    $link.WorkingDirectory = $repoRoot
    $link.IconLocation = "$icon,0"
    $link.Description = 'Zero3 Pilot - 从源码启动，按 R 热重载'
    $link.WindowStyle = 1
    if (-not [string]::IsNullOrWhiteSpace($HotKey)) { $link.Hotkey = $HotKey }
    $link.Save()
} finally {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

if (-not (Test-Path -LiteralPath $linkPath -PathType Leaf)) {
    throw "快捷方式创建后未找到：$linkPath"
}

Write-Host "[Zero3] 已创建桌面快捷方式"
Write-Host "        位置: $linkPath"
Write-Host "        目标: $target"
Write-Host "        图标: $icon"
if (-not [string]::IsNullOrWhiteSpace($HotKey)) {
    Write-Host "        快捷键: $HotKey（想取消：右键快捷方式 - 属性 - 快捷键 - 清空，或重跑本脚本并加 -HotKey ''）"
}
