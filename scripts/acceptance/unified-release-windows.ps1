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

function Assert-PreparedFile {
  param([string]$RelativePath)
  $full = Join-Path $RepoRoot "upstream\hermes-agent\apps\desktop\$RelativePath"
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "Prepared desktop is missing required unified-runtime source: $RelativePath"
  }
}

$RepoRoot = (& git rev-parse --show-toplevel).Trim()
if (-not $RepoRoot) { throw 'Not inside the Zero3 Pilot Git repository' }
Set-Location $RepoRoot

$Expected = $CandidateSha.ToLowerInvariant()
$Head = (& git rev-parse HEAD).Trim().ToLowerInvariant()
if ($Head -ne $Expected) {
  throw "Exact candidate mismatch: requested $CandidateSha, current HEAD is $Head"
}
Assert-CleanRepository

$EvidenceRoot = if ($env:ZERO3_UNIFIED_ACCEPTANCE_DIR) {
  [System.IO.Path]::GetFullPath($env:ZERO3_UNIFIED_ACCEPTANCE_DIR)
} else {
  Join-Path ([System.IO.Path]::GetTempPath()) 'zero3-pilot-unified-v1-acceptance'
}
$EvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
$RepoRootFull = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
if ($EvidenceRoot.Equals($RepoRootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
    $EvidenceRoot.StartsWith($RepoRootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'ZERO3_UNIFIED_ACCEPTANCE_DIR must be outside the repository'
}
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$Transcript = Join-Path $EvidenceRoot "windows-$Expected.log"
Start-Transcript -Path $Transcript -Force | Out-Null

try {
  Write-Host "Zero3 Pilot unified V1 exact candidate: $Expected"
  Write-Host "Windows: $([System.Environment]::OSVersion.VersionString)"
  Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
  & node --version
  & npm --version
  & git --version

  Invoke-Step 'Repository architecture guard' {
    node scripts/check-architecture.mjs
  }

  Invoke-Step 'Unified release-candidate guard' {
    node scripts/check-unified-release-candidate.mjs
  }

  Invoke-Step 'Development Group V1 architecture guard' {
    node scripts/check-development-group-v1.mjs
  }

  Invoke-Step 'Gemini/Antigravity architecture guard' {
    node scripts/check-gemini-antigravity-architecture.mjs
  }

  $DgTests = @(
    'apps/zero3-desktop/group-runtime/planning/planning.test.ts',
    'apps/zero3-desktop/group-runtime/workspace/workspace.test.ts',
    'apps/zero3-desktop/group-runtime/session/session-runtime.test.ts',
    'apps/zero3-desktop/group-runtime/controller/controller.test.ts',
    'apps/zero3-desktop/group-runtime/integration/integration.test.ts',
    'apps/zero3-desktop/group-runtime/verification/verification.test.ts',
    'apps/zero3-desktop/group-runtime/completion/completion.test.ts',
    'apps/zero3-desktop/group-runtime/ui/groups-view-model.test.ts',
    'apps/zero3-desktop/group-runtime/runtime/runtime-facade.test.ts',
    'apps/zero3-desktop/group-runtime/runtime/closeout.test.ts',
    'apps/zero3-desktop/executor-runtime/handoff/handoff-runtime.test.ts'
  )

  Invoke-Step 'Development Group integrated behavior suite' {
    & node --experimental-transform-types --test @DgTests
  }

  Invoke-Step 'Prepare one unified desktop tree' {
    npm --prefix apps/zero3-desktop run prepare
  }

  Invoke-Step 'Prepared GPT/Gemini/Antigravity composition guard' {
    node scripts/check-prepared-gemini-integration.mjs
  }

  Write-Host "`n=== Unified prepared overlay presence ===" -ForegroundColor Cyan
  $PreparedFiles = @(
    'electron\zero3\gpt-web\gpt-web-provider.ts',
    'electron\zero3\gemini-web\gemini-web-provider.ts',
    'electron\zero3\antigravity\antigravity-adapter.ts',
    'electron\zero3\agent-routing\agent-runtime-orchestrator.ts',
    'electron\zero3\agent-routing\authoritative-result-finalizer.ts',
    'electron\zero3\agent-desktop-bridge\bridge.ts',
    'electron\zero3\artifacts\artifact-store.ts',
    'electron\zero3\mcp\task-mcp-server.mjs',
    'electron\zero3\mcp\project-context-server.mjs',
    'electron\zero3\remote-host\remote-task-runner.ts',
    'electron\zero3\executor-runtime\executor-manager.ts',
    'electron\zero3\group-runtime\desktop\desktop-runtime.ts',
    'electron\zero3\group-runtime\runtime\runtime-facade.ts',
    'src\app\chat\sidebar\zero3-gpt-web-section.tsx',
    'src\app\chat\sidebar\gpt-web-handoff-actions.tsx',
    'src\app\chat\sidebar\gemini-session-section.tsx'
  )
  foreach ($file in $PreparedFiles) { Assert-PreparedFile $file }
  Write-Host 'Unified prepared runtime files: PASS'

  Invoke-Step 'Zero3 Desktop exact-candidate typecheck' {
    $previousPrepared = $env:ZERO3_DESKTOP_ALREADY_PREPARED
    $env:ZERO3_DESKTOP_ALREADY_PREPARED = '1'
    try {
      npm --prefix apps/zero3-desktop run typecheck
    }
    finally {
      if ($null -eq $previousPrepared) {
        Remove-Item Env:ZERO3_DESKTOP_ALREADY_PREPARED -ErrorAction SilentlyContinue
      } else {
        $env:ZERO3_DESKTOP_ALREADY_PREPARED = $previousPrepared
      }
    }
  }

  Invoke-Step 'Development Group Skills-only package shape' {
    node -e @'
const fs = require('fs');
const plugin = JSON.parse(fs.readFileSync('plugins/zero3-development-group/.codex-plugin/plugin.json','utf8'));
if (plugin.name !== 'zero3-development-group') throw new Error('unexpected Development Group plugin identity');
if (plugin.skills !== './skills/') throw new Error('skills path mismatch');
for (const key of ['apps','app','mcp','mcpServers','connections']) if (Object.hasOwn(plugin, key)) throw new Error('first-review plugin unexpectedly requires ' + key);
const cases = fs.readFileSync('plugins/zero3-development-group/REVIEW_TEST_CASES.md','utf8');
const positives = (cases.match(/^## Positive /gm) || []).length;
const negatives = (cases.match(/^## Negative /gm) || []).length;
if (positives !== 5 || negatives !== 3) throw new Error(`expected 5+3 OpenAI review cases, got ${positives}+${negatives}`);
console.log('Development Group Skills-only package: PASS');
'@
  }

  $Agy = Get-Command agy -ErrorAction SilentlyContinue
  if ($Agy) {
    Write-Host "`nAntigravity CLI discovery: FOUND ($($Agy.Source))" -ForegroundColor Green
    try { & agy --version } catch { Write-Warning "agy --version failed: $_" }
  } else {
    Write-Host "`nAntigravity CLI discovery: NOT_RUN/BLOCKED (agy not found on PATH)." -ForegroundColor Yellow
  }

  if ($BuildInstaller) {
    Invoke-Step 'Zero3 Desktop Windows installer' {
      $previousPrepared = $env:ZERO3_DESKTOP_ALREADY_PREPARED
      $env:ZERO3_DESKTOP_ALREADY_PREPARED = '1'
      try {
        npm --prefix apps/zero3-desktop run dist:win
      }
      finally {
        if ($null -eq $previousPrepared) {
          Remove-Item Env:ZERO3_DESKTOP_ALREADY_PREPARED -ErrorAction SilentlyContinue
        } else {
          $env:ZERO3_DESKTOP_ALREADY_PREPARED = $previousPrepared
        }
      }
    }
  } else {
    Write-Host "`nWindows installer build: NOT_RUN (pass -BuildInstaller to include it)." -ForegroundColor Yellow
  }

  Write-Host "`n=== Manual real-runtime gates still required ===" -ForegroundColor Yellow
  Write-Host 'Provider/browser truth:'
  Write-Host '- Real ChatGPT and Gemini persistent-login isolation, navigation/title persistence, and no credential/token leakage.'
  Write-Host '- Real GPT Web -> TaskSpecV2 -> Gemini/Antigravity -> authoritative result -> GPT review/fix cycle.'
  Write-Host '- Explicit CODEX/GEMINI targets and observable AUTO routing/fallback with tri-state authentication.'
  Write-Host 'Agent/Git/artifact truth:'
  Write-Host '- Dedicated linked-worktree execution, committed changed-file capture, Codex-authoritative Git evidence, artifact hashes and tamper rejection.'
  Write-Host '- Task-scoped MCP current-turn candidate isolation and terminal/MCP disagreement blocking.'
  Write-Host '- Kill/restart before terminal result => durable OutcomeUnknown; no automatic retry; explicit evidence-bound recovery.'
  Write-Host 'Development Group truth:'
  Write-Host '- Real pinned-Codex Development Session, approval response, clean commit, Delivery materialization, integration, exact-SHA verification and Completion Proof.'
  Write-Host '- Real restart/Handoff/rollback and OutcomeUnknown recovery on the Development Group path.'
  Write-Host 'OpenAI review truth:'
  Write-Host '- Execute the 5 positive + 3 negative Skills-only review cases in the actual submission-capable OpenAI environment.'
  Write-Host '- Publisher identity, privacy/support/legal listing fields and actual review/submission remain account-side gates.'
  Write-Host 'Every item above remains NOT_RUN until evidence is recorded for this exact SHA.'
}
finally {
  try {
    Write-Host "`n=== Reset generated upstream overlays once ===" -ForegroundColor Cyan
    npm --prefix apps/zero3-desktop run reset
  } catch {
    Write-Warning "Desktop reset failed: $_"
  }
  Stop-Transcript | Out-Null
}

Assert-CleanRepository
Write-Host "`nAutomatable unified Windows checks completed for exact SHA $Expected." -ForegroundColor Green
Write-Host "Evidence transcript: $Transcript"
Write-Host 'Final Zero3 Pilot V1 acceptance remains NOT_RUN until all manual real-runtime and OpenAI review gates above are recorded.' -ForegroundColor Yellow
