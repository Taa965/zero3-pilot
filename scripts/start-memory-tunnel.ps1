param(
    [Parameter(Mandatory=$true)][string]$KeyPath,
    [Parameter(Mandatory=$true)][string]$KnownHostsPath,
    [string]$Destination = 'ubuntu@34.218.104.186',
    [int]$LocalPort = 8792,
    [int]$RemotePort = 8791
)
$ErrorActionPreference = 'Stop'
if ($LocalPort -lt 1024 -or $LocalPort -gt 65535 -or $RemotePort -lt 1024 -or $RemotePort -gt 65535) { throw 'Invalid tunnel port' }
if ($Destination -notmatch '^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$') { throw 'Invalid SSH destination' }
$KeyPath = (Resolve-Path -LiteralPath $KeyPath).Path
$KnownHostsPath = (Resolve-Path -LiteralPath $KnownHostsPath).Path
$memoryMutex = New-Object System.Threading.Mutex($false, ('Local\Zero3MemoryTunnel-' + $LocalPort))
$memoryHeld = $false
try {
    try { $memoryHeld = $memoryMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $memoryHeld = $true }
    if (-not $memoryHeld) { exit 0 }
    $memorySsh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
    $memoryArguments = @('-N', '-T', '-i', ('"' + $KeyPath + '"'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', ('"UserKnownHostsFile=' + $KnownHostsPath + '"'), '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', ('127.0.0.1:' + $LocalPort + ':127.0.0.1:' + $RemotePort), $Destination)
    while ($true) {
        $memoryChild = Start-Process -FilePath $memorySsh -ArgumentList $memoryArguments -WindowStyle Hidden -Wait -PassThru
        Start-Sleep -Seconds 30
    }
} finally {
    if ($memoryHeld) { $memoryMutex.ReleaseMutex() }
    $memoryMutex.Dispose()
}
