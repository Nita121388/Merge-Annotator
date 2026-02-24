#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const http = require("http");
const https = require("https");

const DEFAULT_API_BASE = "http://localhost:18000";
const DEFAULT_UI_BASE = "http://localhost:5173";

function log(message) {
  process.stdout.write(`${message}\n`);
}

function logError(message) {
  process.stderr.write(`${message}\n`);
}

function getLocalAppData() {
  if (process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA;
  }
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, "AppData", "Local");
  }
  return null;
}

function getEngineBase() {
  const local = getLocalAppData();
  if (!local) return null;
  return path.join(local, "svn-merge-annotator", "engine");
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

function buildStartCommand(backendRoot) {
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
    logError("LOCALAPPDATA is not available.");
    return false;
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
    engine_root: backendRoot,
    api_base: DEFAULT_API_BASE,
    ui_base: DEFAULT_UI_BASE,
    start_command: startCommand,
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
  const startCommand = config.start_command || buildStartCommand(backendRoot);
  const pid = startBackend(backendRoot, startCommand);
  writeEngineConfig({
    ...config,
    engine_root: backendRoot,
    api_base: apiBase,
    ui_base: config.ui_base || DEFAULT_UI_BASE,
    start_command: startCommand,
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
