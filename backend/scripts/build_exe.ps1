$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

python -m pip install -U pyinstaller
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

python -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$name = 'svn-merge-annotator-backend-windows-x64'
pyinstaller --onefile --name $name `
  --collect-all fastapi `
  --collect-all starlette `
  --collect-all uvicorn `
  --collect-all pydantic `
  --collect-all pydantic_core `
  engine_entry.py

exit $LASTEXITCODE
