[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Start', 'Stop', 'Status')]
  [string]$Action,
  [ValidateRange(1, 65535)]
  [int]$ServicePort = 8790,
  [ValidateRange(1, 65535)]
  [int]$SitePort = 3001
)

$ErrorActionPreference = 'Stop'
$dashboardRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$projectRoot = (Resolve-Path (Join-Path $dashboardRoot '..')).Path
$serviceRoot = (Resolve-Path (Join-Path $dashboardRoot 'services\faithful-mirror-v2')).Path
$configPath = (Resolve-Path (Join-Path $serviceRoot 'config\five-whale-paper.json')).Path
$reportPath = (Resolve-Path (Join-Path $projectRoot 'reports\perp-month-simple-twr\latest.json')).Path
$runtimeRoot = Join-Path $serviceRoot 'data\faithful-mirror-v2'
$historyRoot = Join-Path $serviceRoot 'data\faithful-mirror-v2-history'
$stateRoot = Join-Path $env:LOCALAPPDATA 'WhaleLens'
$statePath = Join-Path $stateRoot 'faithful-mirror-v2-local-state.json'

function Get-LocalState {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
  try { return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json }
  catch { throw "Faithful Mirror V2 local state is invalid: $statePath" }
}

function Test-ManagedProcess {
  param([object]$Entry)
  if ($null -eq $Entry -or $null -eq $Entry.Pid -or $null -eq $Entry.StartedUtc) { return $false }
  try {
    $process = Get-Process -Id ([int]$Entry.Pid) -ErrorAction Stop
    return $process.StartTime.ToUniversalTime().ToString('o') -eq [string]$Entry.StartedUtc
  } catch { return $false }
}

function Get-DescendantProcessIds {
  param([int]$ParentId)
  $result = @()
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId" -ErrorAction SilentlyContinue)) {
    $result += Get-DescendantProcessIds -ParentId ([int]$child.ProcessId)
    $result += [int]$child.ProcessId
  }
  return $result
}

function Stop-ManagedProcess {
  param([object]$Entry, [string]$Label)
  if (-not (Test-ManagedProcess $Entry)) { return }
  $process = Get-Process -Id ([int]$Entry.Pid) -ErrorAction Stop
  $tree = @(Get-DescendantProcessIds -ParentId $process.Id) + $process.Id
  foreach ($processId in @($tree | Select-Object -Unique)) {
    Stop-Process -Id $processId -ErrorAction SilentlyContinue
  }
  Write-Host "Stopped Faithful Mirror V2 $Label process $($process.Id)."
}

function Get-ListenerProcessIds {
  param([int]$Port)
  try { return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) }
  catch { return @() }
}

function Test-ServiceHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ServicePort/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch { return $false }
}

function Test-SiteHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$SitePort/" -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch { return $false }
}

function Assert-PaperCohort {
  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  if ([string]$config.mode -ne 'PAPER' -or $config.autoStart -ne $true) {
    throw 'Faithful Mirror V2 local start requires PAPER with autoStart=true.'
  }
  if (@($config.pairs).Count -ne 5) { throw 'Faithful Mirror V2 local start requires exactly five PAPER pairs.' }
  if ([string]$report.run_status -ne 'COMPLETE' -or [string]$report.data_quality -ne 'PORTFOLIO_ONLY_ESTIMATE') {
    throw 'The saved simple-TWR cohort is not a complete portfolio-only research report.'
  }
  $expected = @($report.top10 | Select-Object -First 5 | ForEach-Object { ([string]$_.wallet).ToLowerInvariant() })
  $actual = @($config.pairs | ForEach-Object { ([string]$_.sourceAddress).ToLowerInvariant() })
  if ($expected.Count -ne 5 -or (Compare-Object -ReferenceObject $expected -DifferenceObject $actual -SyncWindow 0)) {
    throw 'The configured five PAPER sources do not exactly match saved simple-TWR ranks 1-5.'
  }
  foreach ($pair in @($config.pairs)) {
    if ([double]$pair.capitalUsd -le 0) { throw "Invalid PAPER capital for $($pair.pairId)." }
  }
  return [pscustomobject]@{
    RunId = [string]$report.run_id
    ReportHash = [string]$report.report_sha256
    SourceAddresses = $actual
  }
}

function Move-PreviousRuntimeEvidence {
  if (-not (Test-Path -LiteralPath $runtimeRoot)) { return $null }
  $runtimeItem = Get-Item -LiteralPath $runtimeRoot -Force
  if (-not $runtimeItem.PSIsContainer -or ($runtimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing to move unexpected runtime path: $runtimeRoot"
  }
  $resolvedService = [IO.Path]::GetFullPath($serviceRoot).TrimEnd('\')
  $resolvedRuntime = [IO.Path]::GetFullPath($runtimeItem.FullName)
  if (-not $resolvedRuntime.StartsWith("$resolvedService\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime path escaped the Faithful Mirror V2 service root: $resolvedRuntime"
  }
  New-Item -ItemType Directory -Path $historyRoot -Force | Out-Null
  $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $destination = Join-Path $historyRoot "$stamp-$([guid]::NewGuid().ToString('N'))"
  if (Test-Path -LiteralPath $destination) { throw "Runtime archive target already exists: $destination" }
  Move-Item -LiteralPath $resolvedRuntime -Destination $destination -ErrorAction Stop
  return $destination
}

function Start-LocalStack {
  $existing = Get-LocalState
  if ($existing -and (Test-ManagedProcess $existing.Service) -and (Test-ManagedProcess $existing.Site) -and (Test-ServiceHealth) -and (Test-SiteHealth)) {
    Write-Host 'Faithful Mirror V2 PAPER and its local site are already running.'
    return
  }
  if ($existing) {
    Stop-ManagedProcess $existing.Site 'site'
    Stop-ManagedProcess $existing.Service 'service'
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }
  foreach ($port in @($ServicePort, $SitePort)) {
    $listeners = Get-ListenerProcessIds $port
    if ($listeners.Count -gt 0) { throw "Port $port is already in use by PID(s): $($listeners -join ', ')." }
  }

  $cohort = Assert-PaperCohort
  $archivedEvidence = Move-PreviousRuntimeEvidence
  $controlToken = "$([guid]::NewGuid().ToString('N'))$([guid]::NewGuid().ToString('N'))"
  $original = @{}
  $environment = @{
    FMV2_CONFIG = $configPath
    FMV2_CONTROL_TOKEN = $controlToken
    FMV2_BASE_URL = "http://127.0.0.1:$ServicePort"
    FMV2_TESTNET = $null
    FMV2_PRODUCTION_CONFIRMED = $null
    FMV2_MASTER_ACCOUNT_ADDRESS = $null
    FMV2_AGENT_PRIVATE_KEY = $null
    FMV2_AGENT_PRIVATE_KEY_1 = $null
    FMV2_AGENT_PRIVATE_KEY_2 = $null
    FMV2_AGENT_PRIVATE_KEY_3 = $null
    FMV2_AGENT_PRIVATE_KEY_4 = $null
    FMV2_AGENT_PRIVATE_KEY_5 = $null
    PORT = [string]$SitePort
  }
  foreach ($key in $environment.Keys) { $original[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
  try {
    foreach ($entry in $environment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
    $service = Start-Process -FilePath 'npm.cmd' -ArgumentList @('start') -WorkingDirectory $serviceRoot -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-ServiceHealth)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-ServiceHealth)) {
      Stop-ManagedProcess ([pscustomobject]@{ Pid = $service.Id; StartedUtc = $service.StartTime.ToUniversalTime().ToString('o') }) 'service'
      throw 'Faithful Mirror V2 did not become healthy.'
    }

    $site = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', [string]$SitePort) -WorkingDirectory $dashboardRoot -WindowStyle Hidden -PassThru
    $siteDeadline = (Get-Date).AddSeconds(75)
    while ((Get-Date) -lt $siteDeadline -and -not (Test-SiteHealth)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-SiteHealth)) {
      Stop-ManagedProcess ([pscustomobject]@{ Pid = $site.Id; StartedUtc = $site.StartTime.ToUniversalTime().ToString('o') }) 'site'
      Stop-ManagedProcess ([pscustomobject]@{ Pid = $service.Id; StartedUtc = $service.StartTime.ToUniversalTime().ToString('o') }) 'service'
      throw 'The Faithful Mirror V2 site did not become reachable.'
    }

    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    [ordered]@{
      Service = [ordered]@{ Pid = $service.Id; StartedUtc = $service.StartTime.ToUniversalTime().ToString('o') }
      Site = [ordered]@{ Pid = $site.Id; StartedUtc = $site.StartTime.ToUniversalTime().ToString('o') }
      ServicePort = $ServicePort
      SitePort = $SitePort
      ControlToken = $controlToken
      StartedUtc = [DateTimeOffset]::UtcNow.ToString('o')
      CohortRunId = $cohort.RunId
      CohortReportHash = $cohort.ReportHash
      SourceAddresses = $cohort.SourceAddresses
      ArchivedEvidence = $archivedEvidence
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
    Write-Host "Faithful Mirror V2 PAPER is running with five independent accounts."
    Write-Host "Local dashboard: http://localhost:$SitePort"
    Write-Host 'LIVE signing and mainnet execution are disabled.'
  } finally {
    foreach ($entry in $original.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
  }
}

function Stop-LocalStack {
  $state = Get-LocalState
  if (-not $state) { Write-Host 'No managed Faithful Mirror V2 local stack was found.'; return }
  if ($state.ControlToken -and (Test-ServiceHealth)) {
    try {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($state.ServicePort)/stop" -Headers @{ 'x-fmv2-control-token' = [string]$state.ControlToken } -ContentType 'application/json' -Body '{}' -TimeoutSec 15 | Out-Null
    } catch { Write-Warning 'Graceful PAPER stop did not complete; stopping only the exact managed process tree.' }
  }
  Stop-ManagedProcess $state.Site 'site'
  Stop-ManagedProcess $state.Service 'service'
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
}

function Show-LocalStatus {
  $state = Get-LocalState
  if (-not $state) { Write-Host 'Faithful Mirror V2 local stack: stopped.'; return }
  $serviceProcess = Test-ManagedProcess $state.Service
  $siteProcess = Test-ManagedProcess $state.Site
  $serviceHealth = $serviceProcess -and (Test-ServiceHealth)
  $siteHealth = $siteProcess -and (Test-SiteHealth)
  $summary = [ordered]@{
    serviceProcess = $serviceProcess
    serviceHealth = $serviceHealth
    siteProcess = $siteProcess
    siteHealth = $siteHealth
    mode = 'PAPER'
    liveExecutionEnabled = $false
    siteUrl = "http://localhost:$($state.SitePort)"
    cohortRunId = $state.CohortRunId
    startedUtc = $state.StartedUtc
  }
  if ($serviceHealth -and $state.ControlToken) {
    try {
      $response = Invoke-RestMethod -Uri "http://127.0.0.1:$($state.ServicePort)/status" -Headers @{ 'x-fmv2-control-token' = [string]$state.ControlToken } -TimeoutSec 5
      $summary.serviceState = $response.status.state
      $summary.sessionId = $response.status.sessionId
      $summary.pairs = @($response.status.snapshot.pairs.psobject.Properties).Count
    } catch { $summary.statusError = 'The service is healthy but the detailed status request failed.' }
  }
  $summary | ConvertTo-Json -Depth 4
}

switch ($Action) {
  'Start' { Start-LocalStack }
  'Stop' { Stop-LocalStack }
  'Status' { Show-LocalStatus }
}
