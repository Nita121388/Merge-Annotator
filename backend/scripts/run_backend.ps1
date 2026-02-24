param(
  [string]$BindHost = "0.0.0.0",
  [int]$Port = 8000,
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PYTHONDONTWRITEBYTECODE = "1"

$logOut = Join-Path $root "uvicorn.out.log"
$logErr = Join-Path $root "uvicorn.err.log"

$cmd = @(
  "python",
  "-m",
  "uvicorn",
  "app.main:app",
  "--host",
  $BindHost,
  "--port",
  $Port
)

if ($Foreground) {
  & $cmd
  exit $LASTEXITCODE
}

Start-Process `
  -FilePath $cmd[0] `
  -ArgumentList $cmd[1..($cmd.Length - 1)] `
  -WorkingDirectory $root `
  -NoNewWindow `
  -RedirectStandardOutput $logOut `
  -RedirectStandardError $logErr | Out-Null

Write-Output "uvicorn started."
Write-Output "stdout: $logOut"
Write-Output "stderr: $logErr"
