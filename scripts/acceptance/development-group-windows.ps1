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

$RepoRoot = (& git rev-parse --show-toplevel).Trim()
if (-not $RepoRoot) { throw 'Not inside the Zero3 Pilot Git repository' }
Set-Location $RepoRoot

$Head = (& git rev-parse HEAD).Trim()
if ($Head -ne $CandidateSha.ToLowerInvariant()) {
  throw "Exact candidate mismatch: requested $CandidateSha, current HEAD is $Head"
}

Assert-CleanRepository

$EvidenceRoot = Join-Path $RepoRoot 'artifacts/development-group-acceptance'
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$Transcript = Join-Path $EvidenceRoot "windows-$CandidateSha.log"
Start-Transcript -Path $Transcript -Force | Out-Null

try {
  Write-Host "Development Group V1 exact candidate: $CandidateSha"
  Write-Host "Windows: $([System.Environment]::OSVersion.VersionString)"
  Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
  & node --version
  & git --version

  Invoke-Step 'Repository architecture guard' {
    node scripts/check-architecture.mjs
  }

  Invoke-Step 'Development Group V1 architecture guard' {
    node scripts/check-development-group-v1.mjs
  }

  $Tests = @(
    'apps/zero3-desktop/group-runtime/planning/planning.test.ts',
    'apps/zero3-desktop/group-runtime/workspace/workspace.test.ts',
    'apps/zero3-desktop/group-runtime/session/session-runtime.test.ts',
    'apps/zero3-desktop/group-runtime/controller/controller.test.ts',
    'apps/zero3-desktop/group-runtime/integration/integration.test.ts',
    'apps/zero3-desktop/group-runtime/verification/verification.test.ts',
    'apps/zero3-desktop/group-runtime/completion/completion.test.ts',
    'apps/zero3-desktop/group-runtime/ui/groups-view-model.test.ts',
    'apps/zero3-desktop/group-runtime/runtime/runtime-facade.test.ts',
    'apps/zero3-desktop/executor-runtime/handoff/handoff-runtime.test.ts'
  )

  Invoke-Step 'Unified Development Group behavior suite' {
    & node --experimental-transform-types --test @Tests
  }

  Invoke-Step 'Skills-only Plugin manifest and review package check' {
    node -e @'
const fs = require('fs');
const path = 'plugins/zero3-development-group/.codex-plugin/plugin.json';
const plugin = JSON.parse(fs.readFileSync(path, 'utf8'));
if (plugin.name !== 'zero3-development-group') throw new Error('unexpected plugin identity');
if (plugin.skills !== './skills/') throw new Error('skills path mismatch');
for (const key of ['apps','app','mcp','mcpServers','connections']) if (Object.hasOwn(plugin, key)) throw new Error('skills-only manifest unexpectedly requires ' + key);
const cases = fs.readFileSync('plugins/zero3-development-group/REVIEW_TEST_CASES.md','utf8');
const positives = (cases.match(/^## Positive /gm) || []).length;
const negatives = (cases.match(/^## Negative /gm) || []).length;
if (positives !== 5 || negatives !== 3) throw new Error(`expected 5+3 review cases, got ${positives}+${negatives}`);
console.log('Skills-only Plugin static package: PASS');
'@
  }

  Invoke-Step 'Zero3 Desktop exact-candidate typecheck' {
    npm --prefix apps/zero3-desktop run typecheck
  }

  if ($BuildInstaller) {
    Invoke-Step 'Zero3 Desktop Windows package' {
      npm --prefix apps/zero3-desktop run dist:win
    }
  } else {
    Write-Host "`nWindows installer build: NOT_RUN (pass -BuildInstaller to include it)." -ForegroundColor Yellow
  }

  Write-Host "`nManual/real-runtime gates still required:" -ForegroundColor Yellow
  Write-Host '- Real pinned-Codex Development Session and permission path.'
  Write-Host '- Kill/restart during active state-changing prompt => durable OutcomeUnknown, no auto-retry.'
  Write-Host '- Real two-worktree Integration/Handoff/restart/rollback fixture if not covered by a dedicated executable fixture yet.'
  Write-Host '- OpenAI Skills-only 5 positive + 3 negative review cases in the actual submission-capable environment.'
  Write-Host 'These gates remain NOT_RUN until separately recorded; this script does not infer them from static/unit results.'
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
Write-Host "`nAutomated Windows acceptance steps completed for exact SHA $CandidateSha." -ForegroundColor Green
Write-Host "Evidence transcript: $Transcript"
Write-Host 'Final Development Group acceptance is NOT complete until the manual/real-runtime and OpenAI review gates above are recorded.' -ForegroundColor Yellow
