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
  [ValidateRange(1, 365)]
  [int]$SessionDays = 7,
  [ValidateSet('REPLAY_OPEN_EPISODES', 'NEW_POSITIONS_ONLY', 'INCLUDE_EXISTING')]
  [string]$EntryPolicy = 'REPLAY_OPEN_EPISODES',
  [string]$AllowedSymbols = '*',
  [switch]$AllowPartialResearch,
  [switch]$AllowTradeQualifiedResearch,
  [int]$RunnerPort = 8788,
  [int]$SitePort = 3000
)

$ErrorActionPreference = 'Stop'
$dashboardRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$projectRoot = (Resolve-Path (Join-Path $dashboardRoot '..')).Path
$canonicalStatePath = if ($AllowTradeQualifiedResearch) {
  Join-Path $projectRoot 'state\perp-twr-trade-qualified\latest_active_top10.json'
} elseif ($AllowPartialResearch) {
  Join-Path $projectRoot 'state\perp-twr-research\latest_active_top10.json'
} else { Join-Path $projectRoot 'state\perp-twr-top10\latest_active_top10.json' }
$canonicalReportPath = if ($AllowTradeQualifiedResearch) {
  Join-Path $projectRoot 'reports\perp-twr-trade-qualified\latest.json'
} elseif ($AllowPartialResearch) {
  Join-Path $projectRoot 'reports\perp-twr-research\latest.json'
} else { Join-Path $projectRoot 'reports\perp-twr-discovery\latest.json' }
$canonicalCandidatesPath = if ($AllowTradeQualifiedResearch) {
  Join-Path $projectRoot 'reports\perp-twr-rescue\latest-summary.json'
} elseif ($AllowPartialResearch) {
  Join-Path $projectRoot 'reports\perp-twr-research\latest-candidates.json'
} else { Join-Path $projectRoot 'reports\perp-twr-candidates\latest-top2000.json' }
$stateRoot = Join-Path $env:LOCALAPPDATA 'WhaleLens'
$statePath = Join-Path $stateRoot 'local-copy-state.json'
$localSimulationToken = 'whale-lens-local-simulation-only-v1'

function Assert-CanonicalPaperStart {
  if ($Action -ne 'Start') { return }
  if ($AllowPartialResearch -and $AllowTradeQualifiedResearch) {
    throw 'Choose either partial research or trade-qualified research, not both.'
  }
  if ($WhaleAddress.Count -ne 0) {
    throw 'Local paper start always uses the hash-linked selected TOP 10; WhaleAddress overrides are not allowed.'
  }
  if ($CopyRatio -ne 0.01) {
    throw 'Local paper start uses the fixed canonical copy ratio of 0.01.'
  }
  if ($FollowerCapitalUsd -ne 1000) {
    throw 'Local paper start uses exactly $1000 total capital ($100 for each canonical whale).'
  }
  if ($SessionDays -ne 7) {
    throw 'Local paper start always creates an exact 7-day session.'
  }
  if ($EntryPolicy -ne 'REPLAY_OPEN_EPISODES') {
    throw 'Local paper start always uses REPLAY_OPEN_EPISODES.'
  }
  if ($AllowedSymbols -ne '*') {
    throw 'Local paper start always monitors all canonical source symbols.'
  }
}

Assert-CanonicalPaperStart

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
    # Omit the override so the runner reads the verified canonical TOP 10.
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
  $trackedRunner = $state -and (Test-ManagedProcess $state.Runner)
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
  if ($runnerListeners.Count -gt 0) {
    throw "Port $RunnerPort is already listening (PID(s): $($runnerListeners -join ', ')). Stop it before creating a new canonical paper session."
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
  $sessionStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $sessionEndsAtMs = $sessionStartedAtMs + ([int64]$SessionDays * 86400000)
  $sessionStamp = [DateTimeOffset]::FromUnixTimeMilliseconds($sessionStartedAtMs).UtcDateTime.ToString('yyyyMMddTHHmmssfffZ')
  $sessionNonce = [guid]::NewGuid().ToString('N')
  $selectionSuffix = if ($AllowTradeQualifiedResearch) { 'trade-qualified-top10' } elseif ($AllowPartialResearch) { 'research-top10' } else { 'canonical-top10' }
  $sessionDatabase = Join-Path $dashboardRoot "data\sessions\paper-$sessionStamp-$sessionNonce-$selectionSuffix-${SessionDays}d.sqlite"
  if (Test-Path -LiteralPath $sessionDatabase) {
    throw "Refusing to reuse an existing paper-session database: $sessionDatabase"
  }
  $runnerEnvironment = @{
    COPY_RUNNER_ALLOWED_SYMBOLS = $AllowedSymbols
    COPY_RUNNER_MODE = 'SIMULATION'
    COPY_RUNNER_HOST = '127.0.0.1'
    COPY_RUNNER_PORT = [string]$RunnerPort
    COPY_RUNNER_CONTROL_TOKEN = $token
    COPY_RUNNER_AUTOSTART = 'true'
    COPY_RUNNER_REQUIRE_FLAT_START = 'true'
    COPY_RUNNER_ENTRY_POLICY = $EntryPolicy
    COPY_RUNNER_FOLLOWER_CAPITAL_USD = [string]$FollowerCapitalUsd
    # The $10k filter is fixed at the cohort's screening as-of. Reapplying it
    # during the experiment would censor a whale precisely after a drawdown.
    # This exception is simulation-only and available only to the hash-linked
    # trade-qualified research cohort.
    COPY_RUNNER_MIN_SOURCE_ACCOUNT_VALUE_USD = $(if ($AllowTradeQualifiedResearch) { '0' } else { '10000' })
    COPY_RUNNER_SESSION_STARTED_AT_MS = [string]$sessionStartedAtMs
    COPY_RUNNER_SESSION_ENDS_AT_MS = [string]$sessionEndsAtMs
    COPY_RUNNER_DATABASE = $sessionDatabase
    COPY_RUNNER_CANONICAL_STATE = $canonicalStatePath
    COPY_RUNNER_CANONICAL_REPORT = $canonicalReportPath
    COPY_RUNNER_CANONICAL_CANDIDATES = $canonicalCandidatesPath
    COPY_RUNNER_RESCUE_SUMMARY = $canonicalCandidatesPath
    COPY_RUNNER_ALLOW_PARTIAL_RESEARCH = $(if ($AllowPartialResearch) { 'true' } else { 'false' })
    COPY_RUNNER_ALLOW_TRADE_QUALIFIED_RESEARCH = $(if ($AllowTradeQualifiedResearch) { 'true' } else { 'false' })
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
    foreach ($canonicalPath in @($canonicalStatePath, $canonicalReportPath, $canonicalCandidatesPath)) {
      if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
        throw "Verified screener output is missing: $canonicalPath. Complete the screener before starting a new runner."
      }
    }
    foreach ($pair in $runnerEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process') }
    $runner = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'copy-runner') -WorkingDirectory $dashboardRoot -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and -not (Test-AdoptableRunner)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-AdoptableRunner)) {
      Stop-Process -Id $runner.Id -ErrorAction SilentlyContinue
      throw 'The local runner did not become a healthy simulation bridge. Check npm run copy-runner manually for configuration errors.'
    }
    foreach ($pair in $siteEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process') }
    $site = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', [string]$SitePort) -WorkingDirectory $dashboardRoot -WindowStyle Hidden -PassThru
    # A cold Vinext/Miniflare worker can take longer than 15 seconds after a
    # stale worker or cache rebuild. Do not kill an otherwise healthy site
    # before its first request has finished compiling.
    $siteDeadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $siteDeadline -and -not (Test-LocalSiteHealth $SitePort)) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-LocalSiteHealth $SitePort)) {
      Stop-ManagedProcess ([pscustomobject]@{ Owned = $true; Pid = $site.Id; StartedUtc = $site.StartTime.ToUniversalTime().ToString('o') }) 'site'
      throw 'The local site process started but did not become reachable.'
    }
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    [ordered]@{
      Runner = [ordered]@{ Owned = $true; Pid = $runner.Id; StartedUtc = $runner.StartTime.ToUniversalTime().ToString('o') }
      Site = [ordered]@{ Owned = $true; Pid = $site.Id; StartedUtc = $site.StartTime.ToUniversalTime().ToString('o') }
      RunnerPort = $RunnerPort
      SitePort = $SitePort
      ControlToken = $token
      StartedUtc = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
    Write-Host "Started local runner at http://127.0.0.1:$RunnerPort and started site at http://127.0.0.1:$SitePort."
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
  $runner = Test-ManagedProcess $state.Runner
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
        entryPolicy = $status.engine.entryPolicy
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
        selectionMode = $status.canonical.selectionMode
        researchOverride = $status.canonical.researchOverride
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
