#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

DIST_DIR="dist"
if [[ ! -d "${DIST_DIR}" ]]; then
  echo "dist directory not found: ${DIST_DIR}" >&2
  exit 1
fi

cd "${DIST_DIR}"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum * > checksums.txt
else
  shasum -a 256 * > checksums.txt
fi
echo "Checksums written: ${DIST_DIR}/checksums.txt"
