param(
  [switch]$SkipReset,
  [switch]$SkipTypecheck,
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$RepoRoot = (Resolve-Path (Join-Path $DesktopDir '..\..')).Path
$HermesDesktop = Join-Path $RepoRoot 'upstream\hermes-agent\apps\desktop'

function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  Write-Host "`n=== $Name ===" -ForegroundColor Cyan
  & $Body
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Contains {
  param([string]$Text, [string]$Needle, [string]$Message)
  if (-not $Text.Contains($Needle)) { throw $Message }
}

function Assert-NotContains {
  param([string]$Text, [string]$Needle, [string]$Message)
  if ($Text.Contains($Needle)) { throw $Message }
}

Push-Location $DesktopDir
try {
  if (-not $SkipReset) {
    Invoke-Step '重置 pinned upstream overlay' {
      npm run reset
      if ($LASTEXITCODE -ne 0) { throw 'npm run reset failed' }
    }
  }

  Invoke-Step '应用统一 Runtime + 三栏 Renderer' {
    npm run prepare
    if ($LASTEXITCODE -ne 0) { throw 'npm run prepare failed' }
  }

  Invoke-Step '检查架构守卫' {
    node (Join-Path $RepoRoot 'scripts\check-architecture.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'architecture guard failed' }
  }

  Invoke-Step '检查唯一 Renderer cutover' {
    $indexPath = Join-Path $HermesDesktop 'index.html'
    $entryPath = Join-Path $HermesDesktop 'src\zero3-shell-entry.tsx'
    $shellPath = Join-Path $HermesDesktop 'src\zero3-shell\zero3-shell.tsx'
    $manifestPath = Join-Path $HermesDesktop 'public\zero3-renderer.json'

    Assert-True (Test-Path $indexPath) 'prepared index.html missing'
    Assert-True (Test-Path $entryPath) 'Zero3 renderer entry missing'
    Assert-True (Test-Path $shellPath) 'Zero3 three-column shell missing'
    Assert-True (Test-Path $manifestPath) 'zero3-renderer.json missing'

    $index = Get-Content -Raw $indexPath
    $entry = Get-Content -Raw $entryPath
    $shell = Get-Content -Raw $shellPath
    $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json

    Assert-Contains $index '/src/zero3-shell-entry.tsx' 'index.html does not point at the Zero3-owned renderer entry'
    Assert-NotContains $index '/src/main.tsx' 'Hermes main.tsx is still mounted as the product renderer'
    Assert-Contains $entry 'Zero3Shell' 'Zero3 renderer entry does not mount Zero3Shell'
    Assert-True ($manifest.renderer -eq 'zero3-three-column-v1') 'renderer manifest identity mismatch'
    Assert-True ($manifest.codexUi -eq 'retired-not-mounted') 'Codex OSS UI retirement marker missing'
    Assert-True ($manifest.hermesUi -eq 'retired-not-mounted') 'Hermes UI retirement marker missing'

    @(
      'runtime.zero3Codex.thread.list',
      'runtime.zero3Codex.thread.start',
      'runtime.zero3Codex.thread.read',
      'runtime.zero3Codex.turn.start',
      'runtime.zero3Codex.turn.interrupt',
      'runtime.zero3Codex.respondToServerRequest',
      'runtime.zero3Workspace.list',
      'runtime.zero3GptWeb',
      'runtime.zero3GeminiWeb',
      'ResizeObserver'
    ) | ForEach-Object {
      Assert-Contains $shell $_ "real runtime path missing from renderer: $_"
    }

    @('grep_search', 'replace_file_content') | ForEach-Object {
      Assert-NotContains $shell $_ "retired demo marker leaked back into renderer: $_"
    }
  }

  Invoke-Step '检查真实 preload / Electron main bridge' {
    $preload = Get-Content -Raw (Join-Path $HermesDesktop 'electron\preload.ts')
    $main = Get-Content -Raw (Join-Path $HermesDesktop 'electron\main.ts')

    @('zero3Codex', 'zero3Workspace', 'zero3GptWeb', 'zero3GeminiWeb') | ForEach-Object {
      Assert-Contains $preload "exposeInMainWorld('$_'" "preload bridge missing: $_"
    }

    @(
      'zero3:codex:thread:list',
      'zero3:codex:thread:start',
      'zero3:codex:thread:read',
      'zero3:codex:turn:start',
      'zero3:codex:turn:interrupt',
      'zero3:gpt-web:show',
      'zero3:gpt-web:set-bounds',
      'zero3:gemini-web:show',
      'zero3:gemini-web:set-bounds'
    ) | ForEach-Object {
      Assert-Contains $main $_ "Electron main handler missing: $_"
    }
  }

  if (-not $SkipTypecheck) {
    Invoke-Step 'TypeScript 类型检查（Windows）' {
      npm run typecheck
      if ($LASTEXITCODE -ne 0) { throw 'npm run typecheck failed' }
    }
  }

  Write-Host "`n静态/类型验收通过。下一步需要在窗口中做真实性操作验收。" -ForegroundColor Green
  Write-Host '重点：真实 Codex Thread/Turn/Item、Stop、审批/输入、GPT/Gemini 登录与 WebContentsView resize。'

  if ($Launch) {
    Invoke-Step '启动 Zero3 Pilot 进行人工真实性验收' {
      npm run dev
      if ($LASTEXITCODE -ne 0) { throw 'npm run dev failed' }
    }
  } else {
    Write-Host "`n如需直接启动：" -ForegroundColor Yellow
    Write-Host '.\scripts\verify-three-column-ui.ps1 -SkipReset -SkipTypecheck -Launch'
  }
} finally {
  Pop-Location
}
