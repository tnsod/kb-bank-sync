[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$taskName = "KB Bank Sync"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($null -eq $existing) {
    Write-Output "Scheduled task is not registered: $taskName"
    exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output "Scheduled task removed: $taskName"
