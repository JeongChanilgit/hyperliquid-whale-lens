param(
  [string[]]$WhaleAddress = @(),
  [double]$CopyRatio = 0.01,
  [double]$FollowerCapitalUsd = 1000,
  [string]$AllowedSymbols = '*',
  [switch]$AllowPartialResearch,
  [switch]$AllowTradeQualifiedResearch,
  [int]$RunnerPort = 8788,
  [int]$SitePort = 3000
)

& (Join-Path $PSScriptRoot 'Local-CopyRunner.ps1') -Action Start -WhaleAddress $WhaleAddress -CopyRatio $CopyRatio -FollowerCapitalUsd $FollowerCapitalUsd -AllowedSymbols $AllowedSymbols -AllowPartialResearch:$AllowPartialResearch -AllowTradeQualifiedResearch:$AllowTradeQualifiedResearch -RunnerPort $RunnerPort -SitePort $SitePort
