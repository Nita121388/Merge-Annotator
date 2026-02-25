#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

python3 -m pip install -U pyinstaller

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

NAME=""
if [[ "${OS_NAME}" == "Darwin" ]]; then
  if [[ "${ARCH_NAME}" == "arm64" ]]; then
    NAME="svn-merge-annotator-backend-macos-arm64"
  else
    NAME="svn-merge-annotator-backend-macos-x64"
  fi
elif [[ "${OS_NAME}" == "Linux" ]]; then
  if [[ "${ARCH_NAME}" == "aarch64" || "${ARCH_NAME}" == "arm64" ]]; then
    NAME="svn-merge-annotator-backend-linux-arm64"
  else
    NAME="svn-merge-annotator-backend-linux-x64"
  fi
else
  echo "Unsupported OS: ${OS_NAME}"
  exit 1
fi

pyinstaller --onefile --name "${NAME}" \
  --collect-all fastapi \
  --collect-all starlette \
  --collect-all uvicorn \
  --collect-all pydantic \
  --collect-all pydantic_core \
  engine_entry.py
