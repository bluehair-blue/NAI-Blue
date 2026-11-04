[CmdletBinding()]
param([switch]$EnsureRunning)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$repo = Split-Path -Parent $PSScriptRoot

# Read the installation registry on every invocation instead of guessing Program
# Files or scanning old checkouts. Hashes distinguish builds sharing a version.
function Get-BinaryEvidence([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $file = Get-Item -LiteralPath $Path
    [pscustomobject]@{
        path = $file.FullName
        version = $file.VersionInfo.FileVersion
        modifiedUtc = $file.LastWriteTimeUtc.ToString('o')
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$installations = @(foreach ($root in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $root) {
        $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($null -eq $entry) { continue }
        $name = $entry.PSObject.Properties['DisplayName']
        $location = $entry.PSObject.Properties['InstallLocation']
        if ($null -eq $name -or $name.Value -ne 'NAI Blue' -or $null -eq $location -or -not $location.Value) { continue }
        $version = $entry.PSObject.Properties['DisplayVersion']
        [pscustomobject]@{
            registryPath = $key.Name
            registeredVersion = if ($null -ne $version) { $version.Value } else { $null }
            executable = Get-BinaryEvidence (Join-Path ([string]$location.Value).Trim('"') 'NAI-Blue.exe')
        }
    }
})

$running = @(Get-CimInstance Win32_Process -Filter "Name = 'NAI-Blue.exe'" | Select-Object ProcessId, ExecutablePath)
if ($EnsureRunning -and $running.Count -eq 0) {
    # Multiple MCP hosts may connect concurrently. Serialize only normal app
    # launch; never stop a process or choose an ambiguous installation here.
    $mutex = New-Object System.Threading.Mutex($false, 'Local\NAI-Blue-Mcp-Launch')
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'APP_LAUNCH_BUSY' }
        $running = @(Get-CimInstance Win32_Process -Filter "Name = 'NAI-Blue.exe'" | Select-Object ProcessId, ExecutablePath)
        $paths = @($installations | Where-Object executable | ForEach-Object { $_.executable.path } | Sort-Object -Unique)
        if ($running.Count -eq 0 -and $paths.Count -eq 1 -and @($installations | Where-Object { -not $_.executable -or $_.registeredVersion -ne $_.executable.version }).Count -eq 0) {
            Start-Process -FilePath $paths[0] -WorkingDirectory (Split-Path -Parent $paths[0]) -WindowStyle Hidden | Out-Null
            $running = @(Get-CimInstance Win32_Process -Filter "Name = 'NAI-Blue.exe'" | Select-Object ProcessId, ExecutablePath)
        }
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

# This reports separate artifacts; a newer timestamp never authorizes replacing
# an installed binary or terminating an app with pending generation work.
[pscustomobject]@{
    observedAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceRoot = $repo
    sourceVersion = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
    mcpEntryPoint = Join-Path $PSScriptRoot 'run-agent-mcp-stdio.mjs'
    registeredInstallations = $installations
    localReleaseBuild = Get-BinaryEvidence (Join-Path $repo 'src-tauri/target/release/NAI-Blue.exe')
    runningProcesses = $running
    updateBehavior = @{
        appInstallerUpdatesSourceMcp = $false
        mcpReloadsSourceWithoutReconnect = $false
        note = 'The stdio adapter loads this checkout at connection startup. App installation and host MCP configuration are separate. Verify live capabilities after reconnecting; this report is not runtime readiness.'
    }
} | ConvertTo-Json -Depth 6
