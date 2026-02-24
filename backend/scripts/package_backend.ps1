param(
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$dist = if ($OutputDir) { $OutputDir } else { Join-Path $root "dist" }
if (-not (Test-Path $dist)) {
  New-Item -ItemType Directory -Path $dist | Out-Null
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stage = Join-Path $dist "backend-$stamp"
if (Test-Path $stage) {
  Remove-Item -Recurse -Force $stage
}
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item -Recurse -Force (Join-Path $root "app") (Join-Path $stage "app")
Copy-Item -Force (Join-Path $root "requirements.txt") (Join-Path $stage "requirements.txt")
if (Test-Path (Join-Path $root "ai_annotate_example.py")) {
  Copy-Item -Force (Join-Path $root "ai_annotate_example.py") (Join-Path $stage "ai_annotate_example.py")
}

$info = @(
  "build_time=$stamp",
  "package=backend",
  "python=python"
) -join [Environment]::NewLine
Set-Content -Path (Join-Path $stage "build_info.txt") -Value $info -Encoding UTF8

$zip = Join-Path $dist "backend-$stamp.zip"
if (Test-Path $zip) {
  Remove-Item -Force $zip
}
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force

Write-Output "package created: $zip"
