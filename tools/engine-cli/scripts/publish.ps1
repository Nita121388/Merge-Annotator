param(
  [string]$Registry = "",
  [string]$Access = "public",
  [string]$Tag = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$pkgRoot = Split-Path -Parent $PSScriptRoot
Set-Location $pkgRoot

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Error "npm not found. Install Node.js first."
  exit 1
}

$argsList = @("publish")
if ($Access) {
  $argsList += @("--access", $Access)
}
if ($Tag) {
  $argsList += @("--tag", $Tag)
}
if ($Registry) {
  $argsList += @("--registry", $Registry)
}
if ($DryRun) {
  $argsList += "--dry-run"
}

Write-Output ("npm " + ($argsList -join " "))
& npm @argsList
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Output "publish done."
