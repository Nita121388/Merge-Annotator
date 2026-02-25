$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$dist = Join-Path (Get-Location) 'dist'
if (-not (Test-Path $dist)) {
  Write-Error "dist directory not found: $dist"
  exit 1
}

$lines = @()
Get-ChildItem $dist -File | ForEach-Object {
  $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  $lines += "$hash $($_.Name)"
}

$output = Join-Path $dist 'checksums.txt'
$lines | Set-Content -Encoding ASCII $output
Write-Output "Checksums written: $output"
