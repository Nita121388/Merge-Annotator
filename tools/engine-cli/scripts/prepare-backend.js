#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
]);

const SKIP_FILES = new Set([
  ".DS_Store",
  "uvicorn.out.log",
  "uvicorn.err.log",
]);

function shouldSkipFile(name) {
  if (SKIP_FILES.has(name)) return true;
  if (name.endsWith(".pyc") || name.endsWith(".pyo")) return true;
  return false;
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyDir(path.join(src, entry.name), path.join(dst, entry.name));
      continue;
    }
    if (entry.isFile()) {
      if (shouldSkipFile(entry.name)) continue;
      fs.copyFileSync(path.join(src, entry.name), path.join(dst, entry.name));
    }
  }
}

function main() {
  const pkgRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(pkgRoot, "..", "..");
  const backendSrc = path.join(repoRoot, "backend");
  const backendDst = path.join(pkgRoot, "backend");

  if (!fs.existsSync(path.join(backendSrc, "requirements.txt"))) {
    console.error("backend source not found:", backendSrc);
    process.exit(1);
  }

  if (fs.existsSync(backendDst)) {
    fs.rmSync(backendDst, { recursive: true, force: true });
  }
  copyDir(backendSrc, backendDst);
  console.log("backend prepared:", backendDst);
}

main();
