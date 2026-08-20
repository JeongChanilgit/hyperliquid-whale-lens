[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Start', 'Stop', 'Status')]
  [string]$Action,
  [string[]]$WhaleAddress = @(),
  [ValidateRange(0.000001, 1)]
  [double]$CopyRatio = 0.01,
  [ValidateRange(1, 1000000000)]
  [double]$FollowerCapitalUsd = 1000,
  [string]$AllowedSymbols = '*',
  [int]$RunnerPort = 8788,
  [int]$SitePort = 3000
)

$ErrorActionPreference = 'Stop'
$dashboardRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stateRoot = Join-Path $env:LOCALAPPDATA 'WhaleLens'
$statePath = Join-Path $stateRoot 'local-copy-state.json'
$localSimulationToken = 'whale-lens-local-simulation-only-v1'

function Get-LocalState {
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try { return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json }
  catch { throw "Local state file is invalid: $statePath" }
}

function Test-ManagedProcess {
  param([object]$Entry)
  if ($null -eq $Entry -or $null -eq $Entry.Pid) { return $false }
  try {
    $process = Get-Process -Id ([int]$Entry.Pid) -ErrorAction Stop
    return $process.StartTime.ToUniversalTime().ToString('o') -eq [string]$Entry.StartedUtc
  } catch { return $false }
}

function Get-ListenerProcessIds {
  param([int]$Port)
  try {
    return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  } catch { return @() }
}

function Test-LocalRunnerHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$RunnerPort/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch { return $false }
}

function Test-LocalSiteHealth {
  param([int]$Port)
  try {
    # vinext binds localhost to IPv6 on this workstation even when a host flag is
    # supplied, so use the same hostname printed by the development server.
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/" -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch { return $false }
}

function Get-LocalRunnerStatus {
  try {
    $headers = @{ 'x-copy-runner-control-token' = $localSimulationToken }
    return Invoke-RestMethod -Uri "http://127.0.0.1:$RunnerPort/status" -Headers $headers -TimeoutSec 3
  } catch { return $null }
}

function Test-AdoptableRunner {
  if (-not (Test-LocalRunnerHealth)) { return $false }
  $runnerStatus = Get-LocalRunnerStatus
  # Adoption is deliberately limited to the standard local simulation bridge.
  return $null -ne $runnerStatus -and $runnerStatus.engine -and $runnerStatus.engine.mode -eq 'SIMULATION'
}

function Stop-ManagedProcess {
  param([object]$Entry, [string]$Label)
  if ($null -ne $Entry.Owned -and -not [bool]$Entry.Owned) {
    Write-Host "Retained adopted $Label process."
    return
  }
  if (-not (Test-ManagedProcess $Entry)) { return }
  $process = Get-Process -Id ([int]$Entry.Pid) -ErrorAction Stop
  function Get-DescendantProcessIds {
    param([int]$ParentId)
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId" -ErrorAction SilentlyContinue)
    $result = @()
    foreach ($child in $children) {
      $result += Get-DescendantProcessIds -ParentId ([int]$child.ProcessId)
      $result += [int]$child.ProcessId
    }
    return $result
  }
  $tree = @(Get-DescendantProcessIds -ParentId $process.Id) + $process.Id
  foreach ($processId in $tree | Select-Object -Unique) {
    Stop-Process -Id $processId -ErrorAction SilentlyContinue
  }
  Write-Host "Stopped local $Label process $($process.Id)."
}

function Get-WhaleConfig {
  if ($WhaleAddress.Count -eq 0) {
    # Omit COPY_RUNNER_WHALES so the runner uses its screened SEED_WALLETS top 10.
    return $null
  }
  if ($WhaleAddress.Count -lt 1 -or $WhaleAddress.Count -gt 10) { throw 'Provide between 1 and 10 wallet addresses.' }
  $unique = @($WhaleAddress | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
  if ($unique.Count -ne $WhaleAddress.Count) { throw 'Wallet addresses must be unique.' }
  foreach ($wallet in $unique) {
    if ($wallet -notmatch '^0x[0-9a-f]{40}$') { throw "Invalid Hyperliquid address: $wallet" }
  }
  return @($unique | ForEach-Object { [ordered]@{ address = $_; copyRatio = $CopyRatio } }) | ConvertTo-Json -Compress
}

function Start-LocalStack {
  $state = Get-LocalState
  $trackedRunner = $state -and (($state.Runner.Owned -eq $true -and (Test-ManagedProcess $state.Runner)) -or ($state.Runner.Owned -eq $false -and (Test-AdoptableRunner)))
  if ($state -and $trackedRunner -and (Test-ManagedProcess $state.Site) -and
      (Test-LocalSiteHealth ([int]$state.SitePort)) -and (Test-LocalRunnerHealth)) {
    Write-Host "Local site and runner are already managed by this user session. Run npm run local:status."
    return
  }
  if ($state) {
    Stop-ManagedProcess $state.Runner 'runner'
    Stop-ManagedProcess $state.Site 'site'
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }
  $runnerListeners = Get-ListenerProcessIds $RunnerPort
  $adoptedRunner = $false
  if ($runnerListeners.Count -gt 0) {
    if (Test-AdoptableRunner) {
      $adoptedRunner = $true
      Write-Host "Adopting the healthy localhost simulation runner on port $RunnerPort."
    } else {
      throw "Port $RunnerPort is already listening (PID(s): $($runnerListeners -join ', ')) but is not the standard healthy local simulation runner."
    }
  }
  $requestedSitePort = $SitePort
  $siteListeners = Get-ListenerProcessIds $SitePort
  if ($siteListeners.Count -gt 0) {
    $availableSitePort = $null
    foreach ($candidatePort in (($requestedSitePort + 1)..($requestedSitePort + 10))) {
      if ((Get-ListenerProcessIds $candidatePort).Count -eq 0) {
        $availableSitePort = $candidatePort
        break
      }
    }
    if ($null -eq $availableSitePort) {
      throw "Ports $requestedSitePort through $($requestedSitePort + 10) are already in use. Free one of them or pass -SitePort explicitly."
    }
    $SitePort = $availableSitePort
    Write-Warning "Port $requestedSitePort is already in use; starting the local site on port $SitePort instead."
  }
  $dataJobs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match 'prefetch-wallets|data:prefetch|copy-runner' -and $_.ProcessId -notin $runnerListeners
  })
  if ($dataJobs.Count -gt 0) { Write-Warning 'Existing data-prefetch/copy-runner processes were found. Their PIDs are not adopted; port checks above prevent duplicate runner control.' }

  $whales = Get-WhaleConfig
  $token = $localSimulationToken
  $runnerEnvironment = @{
    COPY_RUNNER_ALLOWED_SYMBOLS = $AllowedSymbols
    COPY_RUNNER_MODE = 'SIMULATION'
    COPY_RUNNER_HOST = '127.0.0.1'
    COPY_RUNNER_PORT = [string]$RunnerPort
    COPY_RUNNER_CONTROL_TOKEN = $token
    COPY_RUNNER_AUTOSTART = 'true'
    COPY_RUNNER_REQUIRE_FLAT_START = 'true'
    COPY_RUNNER_FOLLOWER_CAPITAL_USD = [string]$FollowerCapitalUsd
    HYPERLIQUID_ENABLED = 'false'
    HYPERLIQUID_TESTNET = 'true'
    HYPERLIQUID_AGENT_PRIVATE_KEY = ''
    HYPERLIQUID_MASTER_ACCOUNT_ADDRESS = ''
    HYPERLIQUID_TARGETS_JSON = ''
    HYPERLIQUID_PRODUCTION_CONFIRMED = ''
  }
  if ($null -ne $whales) { $runnerEnvironment.COPY_RUNNER_WHALES = $whales }
  else { $runnerEnvironment.COPY_RUNNER_WHALES = $null }
  $siteEnvironment = @{
    COPY_RUNNER_BASE_URL = "http://127.0.0.1:$RunnerPort"
    COPY_RUNNER_CONTROL_TOKEN = $token
    HYPERLIQUID_ENABLED = 'false'
    PORT = [string]$SitePort
  }
  $original = @{}
  foreach ($key in @($runnerEnvironment.Keys + $siteEnvironment.Keys | Select-Object -Unique)) { $original[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
  try {
    $runner = $null
    if (-not $adoptedRunner) {
      foreach ($pair in $runnerEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process') }
      $runner = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'copy-runner') -WorkingDirectory $dashboardRoot -WindowStyle Hidden -PassThru
      $deadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $deadline -and -not (Test-AdoptableRunner)) { Start-Sleep -Milliseconds 250 }
      if (-not (Test-AdoptableRunner)) {
        Stop-Process -Id $runner.Id -ErrorAction SilentlyContinue
        throw 'The local runner did not become a healthy simulation bridge. Check npm run copy-runner manually for configuration errors.'
      }
    }
    foreach ($pair in $siteEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process') }
    $site = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', [string]$SitePort) -WorkingDirectory $dashboardRoot -WindowStyle Hidden -PassThru
    $siteDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $siteDeadline -and -not (Test-LocalSiteHealth $SitePort)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-LocalSiteHealth $SitePort)) {
      Stop-ManagedProcess ([pscustomobject]@{ Owned = $true; Pid = $site.Id; StartedUtc = $site.StartTime.ToUniversalTime().ToString('o') }) 'site'
      throw 'The local site process started but did not become reachable.'
    }
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    [ordered]@{
      Runner = if ($adoptedRunner) { [ordered]@{ Owned = $false; Port = $RunnerPort } } else { [ordered]@{ Owned = $true; Pid = $runner.Id; StartedUtc = $runner.StartTime.ToUniversalTime().ToString('o') }
      }
      Site = [ordered]@{ Owned = $true; Pid = $site.Id; StartedUtc = $site.StartTime.ToUniversalTime().ToString('o') }
      RunnerPort = $RunnerPort
      SitePort = $SitePort
      ControlToken = $token
      StartedUtc = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
    $runnerMessage = if ($adoptedRunner) { 'Adopted local runner' } else { 'Started local runner' }
    Write-Host "$runnerMessage at http://127.0.0.1:$RunnerPort and started site at http://127.0.0.1:$SitePort."
    Write-Host 'Hyperliquid live signing is forced disabled; this command only runs simulation.'
  } finally {
    foreach ($pair in $original.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process') }
  }
}

function Stop-LocalStack {
  $state = Get-LocalState
  if (-not $state) { Write-Host 'No managed local stack state was found.'; return }
  Stop-ManagedProcess $state.Site 'site'
  Stop-ManagedProcess $state.Runner 'runner'
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
}

function Show-LocalStatus {
  $state = Get-LocalState
  if (-not $state) { Write-Host 'Local stack: stopped (no managed state).'; return }
  $runner = if ($state.Runner.Owned -eq $false) { Test-AdoptableRunner } else { Test-ManagedProcess $state.Runner }
  $site = Test-ManagedProcess $state.Site
  $siteHealth = $site -and (Test-LocalSiteHealth ([int]$state.SitePort))
  $health = Test-LocalRunnerHealth
  Write-Host "Runner process: $runner; health: $health; Site process: $site; site health: $siteHealth"
  if ($runner -and $state.ControlToken) {
    try {
      $headers = @{ 'x-copy-runner-control-token' = $localSimulationToken }
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($state.RunnerPort)/status" -Headers $headers -TimeoutSec 3
      [ordered]@{
        state = $status.engine.state
        mode = $status.engine.mode
        sizingMode = $status.engine.sizing.mode
        followerCapitalUsd = $status.engine.sizing.followerCapitalUsd
        allocationPerWhaleUsd = $status.engine.sizing.allocationPerWhaleUsd
        leveragePolicy = 'COPY_SOURCE_EXACTLY'
        watchedWhales = @($status.engine.watchedWhales).Count
        watchedWhaleAddresses = @($status.engine.watchedWhales)
        sessionStartedAt = $status.session.startedAt
        sessionEndsAt = $status.session.endsAt
        sessionExpired = $status.session.expired
        sessionRemainingMs = $status.session.remainingMs
        simulatedFills = $status.engine.performance.simulatedFills
        realizedPnl = $status.engine.performance.realizedPnl
        errors = $status.engine.performance.errors
        executionEnabled = $status.executionEnabled
        testnet = $status.testnet
        databasePath = $status.databasePath
        siteUrl = "http://localhost:$($state.SitePort)"
      } | ConvertTo-Json
    } catch { Write-Warning "Runner status request failed: $($_.Exception.Message)" }
  }
}

switch ($Action) {
  'Start' { Start-LocalStack }
  'Stop' { Stop-LocalStack }
  'Status' { Show-LocalStatus }
}
