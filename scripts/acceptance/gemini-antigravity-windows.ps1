param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$CandidateSha,

  [switch]$BuildInstaller
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Step {
  param([string]$Name, [scriptblock]$Command)
  Write-Host "`n=== $Name ===" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

function Assert-CleanRepository {
  $status = (& git status --porcelain=v1 --untracked-files=all) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
  if ($status.Trim()) { throw "Repository must be clean for exact-candidate acceptance:`n$status" }
}

function Assert-StagedFile {
  param([string]$RelativePath)
  $full = Join-Path $RepoRoot "upstream\hermes-agent\apps\desktop\$RelativePath"
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "Prepared desktop is missing Gemini/Antigravity source: $RelativePath"
  }
}

$RepoRoot = (& git rev-parse --show-toplevel).Trim()
if (-not $RepoRoot) { throw 'Not inside the Zero3 Pilot Git repository' }
Set-Location $RepoRoot

$Head = (& git rev-parse HEAD).Trim().ToLowerInvariant()
if ($Head -ne $CandidateSha.ToLowerInvariant()) {
  throw "Exact candidate mismatch: requested $CandidateSha, current HEAD is $Head"
}
Assert-CleanRepository

$EvidenceRoot = if ($env:ZERO3_GEMINI_ACCEPTANCE_DIR) {
  [System.IO.Path]::GetFullPath($env:ZERO3_GEMINI_ACCEPTANCE_DIR)
} else {
  Join-Path ([System.IO.Path]::GetTempPath()) 'zero3-pilot-gemini-antigravity-acceptance'
}
$EvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
$RepoRootFull = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
if ($EvidenceRoot.Equals($RepoRootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
    $EvidenceRoot.StartsWith($RepoRootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'ZERO3_GEMINI_ACCEPTANCE_DIR must be outside the repository so evidence cannot dirty the candidate'
}
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$Transcript = Join-Path $EvidenceRoot "windows-$CandidateSha.log"
Start-Transcript -Path $Transcript -Force | Out-Null

try {
  Write-Host "Zero3 Gemini/Antigravity exact candidate: $CandidateSha"
  Write-Host "Windows: $([System.Environment]::OSVersion.VersionString)"
  Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
  & node --version
  & npm --version
  & git --version

  Invoke-Step 'Repository architecture guard' {
    node scripts/check-architecture.mjs
  }

  Invoke-Step 'Gemini/Antigravity architecture guard' {
    node scripts/check-gemini-antigravity-architecture.mjs
  }

  Invoke-Step 'Prepare pinned Zero3 Desktop with Gemini/Antigravity overlays' {
    npm --prefix apps/zero3-desktop run prepare
  }

  Write-Host "`n=== Prepared overlay presence ===" -ForegroundColor Cyan
  $Expected = @(
    'electron\zero3\gemini-web\gemini-web-provider.ts',
    'electron\zero3\antigravity\antigravity-adapter.ts',
    'electron\zero3\agent-routing\agent-contracts.ts',
    'electron\zero3\agent-routing\agent-task-store.ts',
    'electron\zero3\agent-routing\git-authority.ts',
    'electron\zero3\artifacts\artifact-store.ts',
    'electron\zero3\mcp\task-mcp-server.mjs',
    'electron\zero3\mcp\project-context-server.mjs',
    'src\app\chat\sidebar\gemini-session-section.tsx'
  )
  foreach ($file in $Expected) { Assert-StagedFile $file }
  Write-Host 'Prepared Gemini/Antigravity overlay files: PASS'

  Invoke-Step 'Zero3 Desktop exact-candidate typecheck' {
    npm --prefix apps/zero3-desktop run typecheck
  }

  $Agy = Get-Command agy -ErrorAction SilentlyContinue
  if ($Agy) {
    Write-Host "`nAntigravity CLI discovery: FOUND ($($Agy.Source))" -ForegroundColor Green
    try { & agy --version } catch { Write-Warning "agy --version failed: $_" }
  } else {
    Write-Host "`nAntigravity CLI discovery: NOT_RUN/BLOCKED (agy not found on PATH)." -ForegroundColor Yellow
  }

  if ($BuildInstaller) {
    Invoke-Step 'Zero3 Desktop Windows package' {
      npm --prefix apps/zero3-desktop run dist:win
    }
  } else {
    Write-Host "`nWindows installer build: NOT_RUN (pass -BuildInstaller to include it)." -ForegroundColor Yellow
  }

  Write-Host "`nReal-runtime gates still required for final acceptance:" -ForegroundColor Yellow
  Write-Host '- ChatGPT/Gemini persistent-login isolation and credential-leak review.'
  Write-Host '- Real GPT -> Gemini TaskSpecV2 -> Antigravity -> ExecutionResultV2 -> GPT review cycle.'
  Write-Host '- CHANGES_REQUESTED fix preserving logical Gemini session/runtime conversation where supported.'
  Write-Host '- Explicit CODEX/GEMINI target behavior and observable AUTO fallback.'
  Write-Host '- Dedicated Gemini worktree, Codex-authoritative Git evidence, artifact hash tamper failure.'
  Write-Host '- Kill/restart before terminal result => durable OutcomeUnknown; no auto-retry; explicit recovery.'
  Write-Host '- Task-scoped MCP isolation, candidate-only writes, lease cleanup and no credential leakage.'
  Write-Host 'All items above remain NOT_RUN until separately executed and recorded for this exact SHA.'
}
finally {
  try {
    Write-Host "`n=== Reset generated upstream overlays ===" -ForegroundColor Cyan
    npm --prefix apps/zero3-desktop run reset
  } catch {
    Write-Warning "Desktop reset failed: $_"
  }
  Stop-Transcript | Out-Null
}

Assert-CleanRepository
Write-Host "`nAutomatable Windows Gemini/Antigravity checks completed for exact SHA $CandidateSha." -ForegroundColor Green
Write-Host "Evidence transcript: $Transcript"
Write-Host 'Final Gemini/Antigravity acceptance remains NOT_RUN until all real-runtime gates in docs/GeminiAntigravity/FINAL_ACCEPTANCE.md are recorded.' -ForegroundColor Yellow
