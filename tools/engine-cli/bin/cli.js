#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const http = require("http");
const https = require("https");
const os = require("os");
const crypto = require("crypto");

const DEFAULT_API_BASE = "http://localhost:18000";
const DEFAULT_UI_BASE = "http://localhost:5173";

function log(message) {
  process.stdout.write(`${message}\n`);
}

function logError(message) {
  process.stderr.write(`${message}\n`);
}

function getAppDataBase() {
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
    if (process.env.USERPROFILE) {
      return path.join(process.env.USERPROFILE, "AppData", "Local");
    }
    return null;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function getEngineBase() {
  const base = getAppDataBase();
  if (!base) return null;
  return path.join(base, "svn-merge-annotator", "engine");
}

function getEngineJsonPath() {
  const base = getEngineBase();
  if (!base) return null;
  return path.join(base, "engine.json");
}

function getBackendRoot() {
  const base = getEngineBase();
  if (!base) return null;
  return path.join(base, "backend");
}

function getBackendBinDir() {
  const base = getEngineBase();
  if (!base) return null;
  return path.join(base, "backend-bin");
}

function getBackendBinaryName() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32" && arch === "x64") {
    return "svn-merge-annotator-backend-windows-x64.exe";
  }
  if (platform === "darwin" && arch === "x64") {
    return "svn-merge-annotator-backend-macos-x64";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "svn-merge-annotator-backend-macos-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "svn-merge-annotator-backend-linux-x64";
  }
  if (platform === "linux" && arch === "arm64") {
    return "svn-merge-annotator-backend-linux-arm64";
  }
  return null;
}

function getBackendBinaryPath() {
  const binDir = getBackendBinDir();
  const name = getBackendBinaryName();
  if (!binDir || !name) return null;
  return path.join(binDir, name);
}

function getChecksumSuffix() {
  const name = getBackendBinaryName();
  if (!name) return "";
  let suffix = name.replace("svn-merge-annotator-backend-", "");
  suffix = suffix.replace(/\.exe$/, "");
  return suffix;
}

function getChecksumsCandidates() {
  const candidates = ["checksums.txt"];
  const suffix = getChecksumSuffix();
  if (suffix) {
    candidates.push(`checksums-${suffix}.txt`);
  }
  return candidates;
}

function getPackageVersion() {
  const pkgRoot = path.resolve(__dirname, "..");
  const pkgJson = path.join(pkgRoot, "package.json");
  try {
    const raw = fs.readFileSync(pkgJson, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version) return String(parsed.version);
  } catch (err) {
    return "0.0.0";
  }
  return "0.0.0";
}

function getBackendDownloadBase(version) {
  return (
    process.env.SVN_MERGE_ANNOTATOR_BACKEND_BASE_URL ||
    process.env.SVN_MERGE_ANNOTATOR_BACKEND_RELEASE_BASE ||
    `https://github.com/Nita121388/Merge-Annotator/releases/download/v${version}`
  );
}

function shouldUseBinary() {
  const raw = (process.env.SVN_MERGE_ANNOTATOR_DISABLE_BINARY || "").toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return false;
  return true;
}

function readEngineConfig() {
  const configPath = getEngineJsonPath();
  if (!configPath || !fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

function writeEngineConfig(next) {
  const configPath = getEngineJsonPath();
  if (!configPath) return;
  const payload = {
    api_base: next.api_base || DEFAULT_API_BASE,
    ui_base: next.ui_base || DEFAULT_UI_BASE,
    engine_root: next.engine_root || "",
    start_command: next.start_command || "",
    backend_binary: next.backend_binary || "",
    backend_version: next.backend_version || "",
    updated_at: new Date().toISOString(),
    pid: next.pid || "",
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), "utf-8");
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(body || `HTTP ${res.statusCode}`));
          }
          if (!body) return resolve({});
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function requestText(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("Too many redirects."));
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, target).toString();
          res.resume();
          return resolve(requestText(next, depth + 1));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(body || `HTTP ${res.statusCode}`));
          }
          resolve(body || "");
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function downloadFile(url, destPath, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("Too many redirects."));
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    const req = lib.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, target).toString();
          res.resume();
          file.close();
          fs.rmSync(destPath, { force: true });
          return resolve(downloadFile(next, destPath, depth + 1));
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          file.close();
          fs.rmSync(destPath, { force: true });
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      }
    );
    req.on("error", (err) => {
      file.close();
      fs.rmSync(destPath, { force: true });
      reject(err);
    });
    req.end();
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function parseChecksums(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      map.set(parts[1], parts[0]);
    }
  }
  return map;
}

async function ensureBackendBinary(version) {
  const binaryPath = getBackendBinaryPath();
  if (!binaryPath) return null;
  if (fs.existsSync(binaryPath)) return binaryPath;
  const baseUrl = getBackendDownloadBase(version);
  const fileName = path.basename(binaryPath);
  const checksumCandidates = getChecksumsCandidates();
  let expected = "";
  const errors = [];
  for (const candidate of checksumCandidates) {
    const checksumUrl = `${baseUrl}/${candidate}`;
    let checksumsText = "";
    try {
      checksumsText = await requestText(checksumUrl);
    } catch (err) {
      errors.push(`Failed to download ${candidate}: ${err.message || err}`);
      continue;
    }
    const checksums = parseChecksums(checksumsText);
    const value = checksums.get(fileName);
    if (!value) {
      errors.push(`Checksum entry not found for ${fileName} in ${candidate}.`);
      continue;
    }
    expected = value;
    break;
  }
  if (!expected) {
    if (errors.length === 0) {
      logError(`Checksum entry not found for ${fileName}.`);
    } else {
      for (const message of errors) logError(message);
    }
    return null;
  }
  try {
    await downloadFile(`${baseUrl}/${fileName}`, binaryPath);
  } catch (err) {
    logError(`Failed to download backend binary: ${err.message || err}`);
    return null;
  }
  let actual = "";
  try {
    actual = await sha256File(binaryPath);
  } catch (err) {
    logError(`Failed to verify backend binary: ${err.message || err}`);
    fs.rmSync(binaryPath, { force: true });
    return null;
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    logError("Backend binary checksum mismatch.");
    fs.rmSync(binaryPath, { force: true });
    return null;
  }
  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }
  return binaryPath;
}

async function healthCheck(apiBase) {
  try {
    await requestJson(`${apiBase.replace(/\/+$/, "")}/api/health`);
    return true;
  } catch (err) {
    return false;
  }
}

function findBackendSource() {
  const envSource = process.env.SVN_MERGE_ANNOTATOR_BACKEND_SOURCE;
  if (envSource && fs.existsSync(envSource)) return envSource;
  const pkgRoot = path.resolve(__dirname, "..");
  const candidates = [
    path.join(pkgRoot, "backend"),
    path.resolve(pkgRoot, "..", "..", "backend"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "requirements.txt"))) {
      return candidate;
    }
  }
  return null;
}

function copyDirSync(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function findPython() {
  const candidates = [
    { cmd: "python", args: ["--version"] },
    { cmd: "py", args: ["-3", "--version"] },
  ];
  for (const candidate of candidates) {
    const result = child_process.spawnSync(candidate.cmd, candidate.args, {
      stdio: "ignore",
      shell: true,
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return null;
}

function runCommand(cmd, args, cwd) {
  const result = child_process.spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: true,
  });
  return result.status === 0;
}

function ensureVenv(backendRoot, python) {
  const venvPath = path.join(backendRoot, ".venv");
  if (fs.existsSync(path.join(venvPath, "pyvenv.cfg"))) {
    return venvPath;
  }
  log("Creating virtual environment...");
  const args = [...python.args, "-m", "venv", ".venv"];
  const ok = runCommand(python.cmd, args, backendRoot);
  if (!ok) return null;
  return venvPath;
}

function getVenvPython(backendRoot) {
  if (process.platform === "win32") {
    return path.join(backendRoot, ".venv", "Scripts", "python.exe");
  }
  return path.join(backendRoot, ".venv", "bin", "python");
}

function ensureDependencies(backendRoot) {
  const venvPython = getVenvPython(backendRoot);
  if (!fs.existsSync(venvPython)) {
    return false;
  }
  log("Installing backend dependencies...");
  const requirements = path.join(backendRoot, "requirements.txt");
  if (!fs.existsSync(requirements)) {
    logError("requirements.txt not found in backend.");
    return false;
  }
  const ok = runCommand(
    venvPython,
    ["-m", "pip", "install", "-r", "requirements.txt"],
    backendRoot
  );
  return ok;
}

function buildStartCommand(backendRoot, backendBinary = "") {
  if (backendBinary && fs.existsSync(backendBinary)) {
    return `"${backendBinary}" --host 0.0.0.0 --port 18000`;
  }
  const venvPython = getVenvPython(backendRoot);
  return `"${venvPython}" -m uvicorn app.main:app --host 0.0.0.0 --port 18000`;
}

function startBackend(backendRoot, command) {
  const child = child_process.spawn(command, {
    cwd: backendRoot,
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid ? String(child.pid) : "";
}

async function ensureEngine() {
  const backendRoot = getBackendRoot();
  if (!backendRoot) {
    logError("App data directory is not available.");
    return false;
  }

  fs.mkdirSync(backendRoot, { recursive: true });
  const pkgVersion = getPackageVersion();
  const config = readEngineConfig();
  const binaryPath = getBackendBinaryPath();
  if (
    binaryPath &&
    config.backend_version &&
    config.backend_version !== pkgVersion &&
    fs.existsSync(binaryPath)
  ) {
    fs.rmSync(binaryPath, { force: true });
  }
  let backendBinary = null;
  if (shouldUseBinary()) {
    backendBinary = await ensureBackendBinary(pkgVersion);
  }
  if (backendBinary) {
    const startCommand = buildStartCommand(backendRoot, backendBinary);
    writeEngineConfig({
      ...config,
      engine_root: backendRoot,
      api_base: DEFAULT_API_BASE,
      ui_base: DEFAULT_UI_BASE,
      start_command: startCommand,
      backend_binary: backendBinary,
      backend_version: pkgVersion,
    });
    return true;
  }

  if (!fs.existsSync(path.join(backendRoot, "requirements.txt"))) {
    const source = findBackendSource();
    if (!source) {
      logError("Backend source not found. Set SVN_MERGE_ANNOTATOR_BACKEND_SOURCE.");
      return false;
    }
    log(`Copying backend from ${source}`);
    copyDirSync(source, backendRoot);
  }

  const python = findPython();
  if (!python) {
    logError("Python not found. Install Python first.");
    return false;
  }

  const venvPath = ensureVenv(backendRoot, python);
  if (!venvPath) {
    logError("Failed to create virtual environment.");
    return false;
  }

  if (!ensureDependencies(backendRoot)) {
    logError("Failed to install backend dependencies.");
    return false;
  }

  const startCommand = buildStartCommand(backendRoot);
  writeEngineConfig({
    ...config,
    engine_root: backendRoot,
    api_base: DEFAULT_API_BASE,
    ui_base: DEFAULT_UI_BASE,
    start_command: startCommand,
    backend_binary: "",
    backend_version: "",
  });
  return true;
}

async function ensureAndStart() {
  const ok = await ensureEngine();
  if (!ok) return false;
  const config = readEngineConfig();
  const apiBase = config.api_base || DEFAULT_API_BASE;
  if (await healthCheck(apiBase)) {
    log("Backend already running.");
    return true;
  }
  const backendRoot = config.engine_root || getBackendRoot();
  const backendBinary = config.backend_binary || "";
  const startCommand =
    config.start_command || buildStartCommand(backendRoot, backendBinary);
  const pid = startBackend(backendRoot, startCommand);
  writeEngineConfig({
    ...config,
    engine_root: backendRoot,
    api_base: apiBase,
    ui_base: config.ui_base || DEFAULT_UI_BASE,
    start_command: startCommand,
    backend_binary: backendBinary,
    backend_version: config.backend_version || "",
    pid,
  });
  const startTime = Date.now();
  const timeoutMs = 20000;
  while (Date.now() - startTime < timeoutMs) {
    if (await healthCheck(apiBase)) {
      log("Backend started.");
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  logError("Backend start timeout.");
  return false;
}

async function stopBackend() {
  const config = readEngineConfig();
  const pid = config.pid;
  if (!pid) {
    log("No managed backend pid found.");
    return false;
  }
  try {
    process.kill(Number(pid));
    log(`Stopped backend pid ${pid}.`);
    writeEngineConfig({ ...config, pid: "" });
    return true;
  } catch (err) {
    logError(`Failed to stop pid ${pid}.`);
    return false;
  }
}

async function statusBackend() {
  const config = readEngineConfig();
  const apiBase = config.api_base || DEFAULT_API_BASE;
  const ok = await healthCheck(apiBase);
  log(ok ? "running" : "stopped");
  return ok;
}

async function main() {
  const command = (process.argv[2] || "ensure").toLowerCase();
  if (command === "install") {
    const ok = await ensureEngine();
    process.exit(ok ? 0 : 1);
  }
  if (command === "start" || command === "ensure") {
    const ok = await ensureAndStart();
    process.exit(ok ? 0 : 1);
  }
  if (command === "stop") {
    const ok = await stopBackend();
    process.exit(ok ? 0 : 1);
  }
  if (command === "status") {
    const ok = await statusBackend();
    process.exit(ok ? 0 : 1);
  }
  log("Usage: svn-merge-annotator <install|start|ensure|stop|status>");
  process.exit(1);
}

main().catch((err) => {
  logError(String(err));
  process.exit(1);
});
