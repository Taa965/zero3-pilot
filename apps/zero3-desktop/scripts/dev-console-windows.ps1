param(
    [Parameter(Mandatory)][ValidateSet('Stop', 'WaitAndFocus')][string]$Action,
    [Parameter(Mandatory)][int]$RootProcessId,
    [string]$ConsoleTitle = 'Zero3 Pilot - Source Console'
)
$ErrorActionPreference = 'Stop'

function Get-OwnedProcesses {
    $allProcesses = @(Get-CimInstance Win32_Process)
    $ownedIds = [System.Collections.Generic.HashSet[int]]::new()
    $null = $ownedIds.Add($RootProcessId)
    do {
        $added = $false
        foreach ($item in $allProcesses) {
            if ($ownedIds.Contains([int]$item.ParentProcessId) -and $ownedIds.Add([int]$item.ProcessId)) { $added = $true }
        }
    } while ($added)
    @($allProcesses | Where-Object { $ownedIds.Contains([int]$_.ProcessId) })
}

if ($Action -eq 'WaitAndFocus') {
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) { exit 0 }
        foreach ($item in Get-OwnedProcesses) {
            if ($item.Name -ne 'electron.exe') { continue }
            $window = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
            if ($window -and $window.MainWindowHandle -ne 0 -and $window.MainWindowTitle -eq 'Zero3 Pilot') {
                Start-Sleep -Milliseconds 700
                # npm temporarily changes the shared console title during boot.
                try { $Host.UI.RawUI.WindowTitle = $ConsoleTitle } catch { }
                Write-Host -NoNewline ([char]27 + ']0;' + $ConsoleTitle + [char]7)
                $shell = New-Object -ComObject WScript.Shell
                $focused = $shell.AppActivate($ConsoleTitle)
                Write-Host "`nZero3 is ready. Press R to rebuild/reload, or Q to quit."
                if (-not $focused) { Write-Host 'Click this CMD window to use the shortcuts.' }
                exit 0
            }
        }
        Start-Sleep -Milliseconds 1000
    }
    Write-Host 'Window startup timed out. Check the build log, then press R to retry.'
    exit 0
}

# Only operate on this launcher's descendants. Ask Electron to close normally
# first so session data is flushed; force termination is limited to its dev tree.
$owned = @(Get-OwnedProcesses)
foreach ($item in $owned) {
    if ($item.Name -ne 'electron.exe') { continue }
    $window = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if ($window -and $window.MainWindowHandle -ne 0 -and $window.MainWindowTitle -eq 'Zero3 Pilot') {
        $null = $window.CloseMainWindow()
    }
}
$deadline = [DateTime]::UtcNow.AddSeconds(12)
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) { exit 0 }
    $windows = @($owned | Where-Object Name -eq 'electron.exe' | ForEach-Object {
        Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    } | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq 'Zero3 Pilot' })
    if ($windows.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
}
if (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue) {
    # Console hosts may be shared with the interactive launcher. Never close or
    # terminate those windows; terminate only the captured development processes.
    foreach ($item in ($owned | Sort-Object CreationDate -Descending)) {
        if ($item.Name -match '^(conhost|OpenConsole|WindowsTerminal)\.exe$') { continue }
        $ownedProcess = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if (-not $ownedProcess -or $ownedProcess.HasExited) { continue }
        if ($ownedProcess.StartTime.ToUniversalTime() -gt $item.CreationDate.ToUniversalTime().AddSeconds(1)) { continue }
        Stop-Process -InputObject $ownedProcess -Force -ErrorAction SilentlyContinue
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $rootProcess = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
        if (-not $rootProcess -or $rootProcess.HasExited) { exit 0 }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    exit 1
}
exit 0
