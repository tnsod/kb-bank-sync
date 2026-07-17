[CmdletBinding()]
param(
    [string]$ProjectDirectory,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$taskName = "KB Bank Sync"

if ([string]::IsNullOrWhiteSpace($ProjectDirectory)) {
    if (-not [string]::IsNullOrWhiteSpace($env:KB_BANK_SYNC_DIR)) {
        $ProjectDirectory = $env:KB_BANK_SYNC_DIR
    } else {
        $ProjectDirectory = Join-Path $PSScriptRoot "..\.."
    }
}

$projectRoot = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$runner = Join-Path $projectRoot "deploy\windows\run-sync.ps1"
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Windows runner not found: $runner"
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existing -and -not $Force) {
    throw "Scheduled task already exists. Use -Force to replace it: $taskName"
}

$powerShell = (Get-Process -Id $PID).Path
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -ProjectDirectory `"$projectRoot`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At "04:10"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force:$Force | Out-Null
Write-Output "Scheduled task registered without starting it: $taskName"
