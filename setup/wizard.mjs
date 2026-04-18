#!/usr/bin/env node
/**
 * Claude Companion — Setup Wizard
 *
 * Local HTTP server + browser UI that walks the user through installation.
 * Focus: one tab, a few clicks, linked to Claude Max.
 *
 * Endpoints:
 *   GET  /                      → wizard UI
 *   GET  /api/probe             → { node, claude, extension, hostRegistered, mcp, maxLoggedIn }
 *   POST /api/install-claude    → npm install -g @anthropic-ai/claude-code
 *   POST /api/login             → spawn `claude login` (opens browser for OAuth)
 *   POST /api/open-ext-page     → opens chrome://extensions in default browser
 *   POST /api/register-host     → run install.ps1/sh equivalent logic
 *   POST /api/register-mcp      → add MCP to claude config
 *   POST /api/restart-browser   → kills + restarts Brave/Chrome/Edge
 *   POST /api/launch-panel      → opens the side-panel URL
 *   GET  /api/events            → SSE: live progress stream
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // claude-companion/
const EXT_DIR = path.join(ROOT, "extension");
const HOST_DIR = path.join(ROOT, "host");
const HOST_NAME = "com.anthropic.claude_companion";

const PORT = 5557;
const PLATFORM = process.platform;
const IS_WIN = PLATFORM === "win32";

// ──────────────────────────────────────────────────────────────────────────
// SSE event broadcasting
// ──────────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}
function log(level, msg) {
  broadcast("log", { level, msg, ts: Date.now() });
}

// ──────────────────────────────────────────────────────────────────────────
// Detection helpers
// ──────────────────────────────────────────────────────────────────────────
function cmd(bin, args = [], opts = {}) {
  try {
    const r = spawnSync(bin, args, { encoding: "utf-8", shell: IS_WIN, ...opts });
    return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
  } catch (e) {
    return { code: -1, stderr: e.message };
  }
}

function findClaudeBin() {
  if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const candidates = [path.join(appData, "npm", "claude.cmd"), path.join(appData, "npm", "claude.exe")];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } else {
    const candidates = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(os.homedir(), ".local", "bin", "claude"), path.join(os.homedir(), ".npm-global", "bin", "claude")];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  const w = cmd(IS_WIN ? "where" : "which", ["claude"]);
  if (w.code === 0 && w.stdout) return w.stdout.split("\n")[0].trim();
  return null;
}

function detectExtensionIds() {
  const ids = new Set();
  const needle = "claude-companion";
  const browsers = [];
  if (IS_WIN) {
    browsers.push({ root: path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "User Data") });
    browsers.push({ root: path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data") });
    browsers.push({ root: path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data") });
    browsers.push({ root: path.join(process.env.LOCALAPPDATA || "", "Chromium", "User Data") });
    browsers.push({ root: path.join(process.env.LOCALAPPDATA || "", "Vivaldi", "User Data") });
  } else if (PLATFORM === "darwin") {
    const base = path.join(os.homedir(), "Library", "Application Support");
    browsers.push({ root: path.join(base, "Google", "Chrome") });
    browsers.push({ root: path.join(base, "BraveSoftware", "Brave-Browser") });
    browsers.push({ root: path.join(base, "Microsoft Edge") });
    browsers.push({ root: path.join(base, "Chromium") });
    browsers.push({ root: path.join(base, "Arc", "User Data") });
  } else {
    browsers.push({ root: path.join(os.homedir(), ".config", "google-chrome") });
    browsers.push({ root: path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser") });
    browsers.push({ root: path.join(os.homedir(), ".config", "microsoft-edge") });
    browsers.push({ root: path.join(os.homedir(), ".config", "chromium") });
  }

  for (const b of browsers) {
    if (!fs.existsSync(b.root)) continue;
    const profiles = fs.readdirSync(b.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === "Default" || /^Profile \d+$/.test(d.name)))
      .map((d) => path.join(b.root, d.name));
    for (const p of profiles) {
      for (const f of ["Secure Preferences", "Preferences"]) {
        const fp = path.join(p, f);
        if (!fs.existsSync(fp)) continue;
        try {
          const d = JSON.parse(fs.readFileSync(fp, "utf-8"));
          const s = d?.extensions?.settings || {};
          for (const [id, e] of Object.entries(s)) {
            if ((e.path || "").toLowerCase().includes(needle)) {
              ids.add(id);
            }
          }
        } catch {}
      }
    }
  }
  return Array.from(ids);
}

function isHostRegistered() {
  if (IS_WIN) {
    const key = `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`;
    const r = cmd("reg", ["query", key]);
    return r.code === 0;
  }
  const manifests = PLATFORM === "darwin"
    ? [
        path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${HOST_NAME}.json`),
        path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", `${HOST_NAME}.json`),
      ]
    : [
        path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts", `${HOST_NAME}.json`),
        path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", `${HOST_NAME}.json`),
      ];
  return manifests.some((m) => fs.existsSync(m));
}

function isMcpRegistered() {
  const claudeBin = findClaudeBin();
  if (!claudeBin) return false;
  const r = cmd(claudeBin, ["mcp", "list"]);
  return (r.stdout || "").includes("claude-companion");
}

// ──────────────────────────────────────────────────────────────────────────
// Actions
// ──────────────────────────────────────────────────────────────────────────

function probe() {
  const nodeVersion = cmd("node", ["--version"]).stdout || null;
  const claudeBin = findClaudeBin();
  const claudeVersion = claudeBin ? cmd(claudeBin, ["--version"]).stdout : null;
  const extensionIds = detectExtensionIds();
  const hostRegistered = isHostRegistered();
  const mcpRegistered = isMcpRegistered();
  return {
    node: { ok: !!nodeVersion, version: nodeVersion },
    claude: { ok: !!claudeBin, version: claudeVersion, path: claudeBin },
    extension: { ok: extensionIds.length > 0, ids: extensionIds },
    hostRegistered,
    mcpRegistered,
  };
}

async function installClaudeCli() {
  log("info", "تثبيت Claude Code CLI (npm install -g)...");
  return new Promise((resolve) => {
    const proc = spawn("npm", ["install", "-g", "@anthropic-ai/claude-code"], {
      shell: IS_WIN,
      env: { ...process.env },
    });
    proc.stdout.on("data", (c) => log("info", c.toString().trim()));
    proc.stderr.on("data", (c) => log("warn", c.toString().trim()));
    proc.on("close", (code) => {
      if (code === 0) { log("ok", "تم تثبيت Claude Code ✓"); resolve({ ok: true }); }
      else { log("error", `npm exited with code ${code}`); resolve({ ok: false, code }); }
    });
  });
}

function runClaudeLogin() {
  log("info", "تشغيل claude login — سيفتح المتصفح لتسجيل الدخول...");
  const claudeBin = findClaudeBin();
  if (!claudeBin) return { ok: false, error: "Claude CLI غير مثبّت" };
  // Spawn detached so the process lives after our response
  const proc = spawn(claudeBin, ["login"], {
    shell: IS_WIN,
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  return { ok: true, pid: proc.pid };
}

function openExtensionsPage() {
  // Try Brave first (most common among power users), then Chrome, then Edge
  const browsers = IS_WIN
    ? [
        path.join("C:", "Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join("C:", "Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join("C:", "Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        path.join("C:", "Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : PLATFORM === "darwin"
    ? ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
       "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/brave-browser", "/usr/bin/chromium"];

  for (const b of browsers) {
    if (!fs.existsSync(b)) continue;
    try {
      const proc = spawn(b, ["chrome://extensions"], { detached: true, stdio: "ignore" });
      proc.unref();
      return { ok: true, browser: path.basename(b) };
    } catch {}
  }
  return { ok: false, error: "لم أجد متصفحاً Chromium مثبتاً" };
}

function registerNativeHost(extensionIds) {
  log("info", "تسجيل Native Messaging Host...");
  if (extensionIds.length === 0) {
    return { ok: false, error: "لم يُحمَّل الإضافة بعد. اتبع خطوة 'Load unpacked'." };
  }
  try {
    if (IS_WIN) {
      const script = path.join(ROOT, "install.ps1");
      const args = ["-ExecutionPolicy", "Bypass", "-File", script, ...extensionIds];
      const r = cmd("powershell", args);
      if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
      log("ok", "تم تسجيل Native Host ✓");
      return { ok: true };
    } else {
      const script = path.join(ROOT, "install.sh");
      const r = cmd("bash", [script, ...extensionIds]);
      if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
      log("ok", "تم تسجيل Native Host ✓");
      return { ok: true };
    }
  } catch (e) { return { ok: false, error: e.message }; }
}

function registerMcp() {
  const claudeBin = findClaudeBin();
  if (!claudeBin) return { ok: false, error: "Claude CLI غير مثبّت" };
  const mcpPath = path.join(HOST_DIR, "mcp-server.js");
  cmd(claudeBin, ["mcp", "remove", "claude-companion"]); // ignore errors
  const r = cmd(claudeBin, ["mcp", "add", "--scope", "user", "claude-companion", "--", "node", mcpPath]);
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  log("ok", "تم ربط MCP بـ Claude Code ✓");
  return { ok: true };
}

function restartBrowsers() {
  log("info", "إعادة تشغيل المتصفح(ات)...");
  if (IS_WIN) {
    for (const exe of ["brave.exe", "chrome.exe", "msedge.exe"]) {
      cmd("taskkill", ["/F", "/IM", exe, "/T"]);
    }
  } else {
    cmd("pkill", ["-f", "Brave Browser"]);
    cmd("pkill", ["-f", "Google Chrome"]);
    cmd("pkill", ["-f", "Microsoft Edge"]);
  }
  log("ok", "تم إغلاق المتصفحات. افتحها يدوياً لإعادة قراءة native messaging.");
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP server
// ──────────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
      catch { resolve({}); }
    });
  });
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type + "; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function serveStatic(url, res) {
  const rel = url === "/" ? "/index.html" : url;
  const file = path.join(__dirname, "ui", rel.slice(1));
  if (!fs.existsSync(file)) { send(res, 404, "Not found", "text/plain"); return; }
  const ext = path.extname(file).toLowerCase();
  const mime = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png" }[ext] || "text/plain";
  fs.createReadStream(file).pipe(res.writeHead(200, { "Content-Type": mime + "; charset=utf-8" }) && res);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // SSE
  if (url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(`event: connected\ndata: {}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // JSON endpoints
  if (url === "/api/probe") return send(res, 200, probe());
  if (url === "/api/install-claude" && req.method === "POST") return send(res, 200, await installClaudeCli());
  if (url === "/api/login" && req.method === "POST") return send(res, 200, runClaudeLogin());
  if (url === "/api/open-ext-page" && req.method === "POST") return send(res, 200, openExtensionsPage());
  if (url === "/api/register-host" && req.method === "POST") {
    const b = await readBody(req);
    return send(res, 200, registerNativeHost(b.extensionIds || detectExtensionIds()));
  }
  if (url === "/api/register-mcp" && req.method === "POST") return send(res, 200, registerMcp());
  if (url === "/api/restart-browser" && req.method === "POST") return send(res, 200, restartBrowsers());
  if (url === "/api/shutdown" && req.method === "POST") {
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }

  // Static UI
  if (req.method === "GET") return serveStatic(url, res);
  send(res, 405, "Method not allowed", "text/plain");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\nClaude Companion Setup Wizard\nافتح: ${url}\n`);

  // Open the default browser to the wizard
  if (IS_WIN) spawn("cmd", ["/c", "start", url], { detached: true, stdio: "ignore", shell: true }).unref();
  else if (PLATFORM === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
});
