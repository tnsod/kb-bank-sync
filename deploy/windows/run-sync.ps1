[CmdletBinding()]
param(
    [string]$ProjectDirectory,
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ProjectDirectory {
    param([string]$ConfiguredDirectory)

    if (-not [string]::IsNullOrWhiteSpace($ConfiguredDirectory)) {
        return (Resolve-Path -LiteralPath $ConfiguredDirectory).Path
    }
    if (-not [string]::IsNullOrWhiteSpace($env:KB_BANK_SYNC_DIR)) {
        return (Resolve-Path -LiteralPath $env:KB_BANK_SYNC_DIR).Path
    }
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
}

function Write-SchedulerLog {
    param(
        [string]$Path,
        [string]$Event,
        [int]$ExitCode
    )

    $timestamp = [DateTimeOffset]::Now.ToString("o")
    Add-Content -LiteralPath $Path -Value "$timestamp event=$Event exitCode=$ExitCode" -Encoding UTF8
}

$projectRoot = Resolve-ProjectDirectory -ConfiguredDirectory $ProjectDirectory
$logDirectory = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory "windows-scheduler.log"
$environmentFile = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    Write-SchedulerLog -Path $logPath -Event "failed" -ExitCode 1
    throw ".env file not found: $environmentFile"
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($null -eq $docker) {
    Write-SchedulerLog -Path $logPath -Event "failed" -ExitCode 1
    throw "docker command not found"
}

& $docker.Source compose version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-SchedulerLog -Path $logPath -Event "failed" -ExitCode 1
    throw "docker compose is not available"
}

& $docker.Source info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-SchedulerLog -Path $logPath -Event "failed" -ExitCode 1
    throw "Docker Desktop is not running or the Docker engine is unavailable"
}

if ($ValidateOnly) {
    Write-Output "Validation completed for: $projectRoot"
    exit 0
}

$mutex = New-Object System.Threading.Mutex($false, "Local\KbBankSync")
$lockAcquired = $false
$exitCode = 1

try {
    try {
        $lockAcquired = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $lockAcquired = $true
    }
    if (-not $lockAcquired) {
        Write-SchedulerLog -Path $logPath -Event "skipped_already_running" -ExitCode 0
        exit 0
    }

    Write-SchedulerLog -Path $logPath -Event "started" -ExitCode 0
    Push-Location -LiteralPath $projectRoot
    try {
        & $docker.Source compose run --rm kb-sync
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    Write-SchedulerLog -Path $logPath -Event $(if ($exitCode -eq 0) { "succeeded" } else { "failed" }) -ExitCode $exitCode
} catch {
    Write-SchedulerLog -Path $logPath -Event "failed" -ExitCode 1
    Write-Error $_
    $exitCode = 1
} finally {
    if ($lockAcquired) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}

exit $exitCode
