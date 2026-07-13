#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
import readline from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_CAPTURE_DB_PATH } from "../src/capture-config.mjs";
import { bootstrapCodexConfig } from "../src/codex/codex-config.mjs";
import { getPaths } from "../src/shared/paths.mjs";
import {
  discoverSupervisor,
  ensureSupervisor,
  readControlToken,
  readSupervisorState
} from "../src/supervisor/supervisor-client.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const {
  codexConfigPath: DEFAULT_CODEX_CONFIG_PATH,
  authPath: DEFAULT_AUTH_PATH,
  globalHome: GLOBAL_HOME,
  statePath: STATE_FILE,
  logPath: LOG_FILE
} = getPaths();
const BIN_DIR = resolve(GLOBAL_HOME, "bin");
const CRP_SHIM_PATH = resolve(BIN_DIR, "crp");
const USER_CONFIG_FILE = resolve(GLOBAL_HOME, "config.json");
const NODE_RUNTIME_CONFIG_PATH = resolve(GLOBAL_HOME, "node", "proxy-config.json");
const OPENAI_SECTION_HEADER = "[model_providers.OpenAI]";
const CRP_SECTION_HEADER = "[codex_remote_proxy]";
const ENV_KEYS = {
  upstreamBaseUrl: "CRP_UPSTREAM_BASE_URL",
  apiKey: "CRP_UPSTREAM_API_KEY",
  listenHost: "CRP_LISTEN_HOST",
  listenPort: "CRP_LISTEN_PORT",
  captureEnabled: "CRP_CAPTURE_ENABLED",
  captureDbPath: "CRP_CAPTURE_DB_PATH"
};

function parseCommandLine(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = argv[0];
  const options = {};

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }

  return { command, options };
}

function printHelp(writeLine = (line) => console.log(line)) {
  writeLine("Usage:");
  writeLine("  crp check [--json] [--codex-config PATH] [--auth PATH]");
  writeLine("  crp init [--json] [--upstream-base-url URL] [--api-key KEY]");
  writeLine("  crp ui [--no-open] [--json]");
  writeLine("  crp start [--json]");
  writeLine("  crp install [same as start]");
  writeLine("  crp capture <on|off|status> [--json]");
  writeLine("  crp status [--json]");
  writeLine("  crp stop [--json]");
  writeLine("  crp restart [--json]");
  writeLine("  crp shutdown [--json]");
  writeLine("  crp provider list|add|test|activate|delete [--json]");
  writeLine("  crp setup [same as start]");
  writeLine("  crp guide [--json]");
  writeLine("  crp install-cli [--json]");
}

function maybePrintJson(options, payload) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }
  return false;
}

function getCommonPaths(options) {
  return {
    codexConfigPath: resolve(options["codex-config"] || DEFAULT_CODEX_CONFIG_PATH),
    authPath: resolve(options.auth || DEFAULT_AUTH_PATH)
  };
}

function readJson(path) {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadUserConfig() {
  return readJson(USER_CONFIG_FILE);
}

function writeUserConfig(config) {
  ensureStateDirs();
  writeFileSync(USER_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    chmodSync(USER_CONFIG_FILE, 0o600);
  } catch {
    // Best effort only.
  }
}

function applyUserConfigPatch(patch) {
  const current = loadUserConfig();
  const next = {
    ...current,
    ...patch
  };
  writeUserConfig(next);
  return next;
}

function loadRuntimeProxyConfig() {
  if (!existsSync(NODE_RUNTIME_CONFIG_PATH)) {
    return null;
  }
  return readJson(NODE_RUNTIME_CONFIG_PATH);
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

function findSectionRange(lines, sectionHeader) {
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() !== sectionHeader) {
      continue;
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const stripped = lines[index].trim();
      if (stripped.startsWith("[") && stripped.endsWith("]")) {
        end = index;
        break;
      }
    }
    return [start, end];
  }
  return null;
}

function parseTomlScalar(rawValue) {
  if (rawValue === "true" || rawValue === "false") {
    return rawValue === "true";
  }
  if (rawValue.startsWith("\"") && rawValue.endsWith("\"")) {
    try {
      return JSON.parse(rawValue);
    } catch {
      return rawValue;
    }
  }
  const numeric = Number(rawValue);
  if (!Number.isNaN(numeric) && rawValue.trim() !== "") {
    return numeric;
  }
  return rawValue;
}

function extractTomlSection(text, sectionHeader) {
  const lines = splitLines(text);
  const range = findSectionRange(lines, sectionHeader);
  const result = {};
  if (!range) {
    return result;
  }

  for (let index = range[0] + 1; index < range[1]; index += 1) {
    const stripped = lines[index].trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) {
      continue;
    }
    const [key, rawValue] = stripped.split("=", 2).map((item) => item.trim());
    result[key] = parseTomlScalar(rawValue);
  }
  return result;
}

function extractOpenAiSection(text) {
  return extractTomlSection(text, OPENAI_SECTION_HEADER);
}

function extractCodexRemoteProxySection(text) {
  return extractTomlSection(text, CRP_SECTION_HEADER);
}

function getCodexRemoteProxyUpstreamBaseUrl(section) {
  return section.upstream_base_url ?? section.base_url ?? null;
}

function getCodexRemoteProxyUpstreamApiKey(section) {
  return section.upstream_api_key ?? section.api_key ?? null;
}

function getCodexRemoteProxyCaptureEnabled(section) {
  return typeof section.capture_enabled === "boolean" ? section.capture_enabled : null;
}

function getCodexRemoteProxyCaptureDbPath(section) {
  return section.capture_db_path ?? null;
}

function normalizeBooleanInput(value, fallback = null) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const lowered = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(lowered)) {
    return false;
  }
  return fallback;
}

function ensureCaptureDbPath(path) {
  return typeof path === "string" && path.trim() ? path.trim() : DEFAULT_CAPTURE_DB_PATH;
}

function detectNodeRuntime() {
  const depCheck = spawnSync("node", ["-e", "import('fzstd').then(()=>process.exit(0)).catch(()=>process.exit(1))"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8"
  });
  return {
    available: true,
    version: process.version,
    dependenciesReady: depCheck.status === 0,
    installHint: depCheck.status === 0 ? null : "Run `npm install` in the package directory first.",
    error: null
  };
}

function maskSecret(value) {
  if (!value) {
    return "(empty)";
  }
  if (value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function startCommand(configPath) {
  return `CODEX_PROXY_CONFIG=${quoteShell(configPath)} node ${quoteShell(resolve(PACKAGE_ROOT, "src", "server.mjs"))}`;
}

function healthCommand(listenHost, listenPort) {
  return `curl http://${listenHost}:${listenPort}/_proxy/health`;
}

function ensureStateDirs() {
  mkdirSync(BIN_DIR, { recursive: true });
  mkdirSync(resolve(GLOBAL_HOME, "node"), { recursive: true });
}

function loadManagedState() {
  if (!existsSync(STATE_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function removeManagedState() {
  if (existsSync(STATE_FILE)) {
    try {
      rmSync(STATE_FILE);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getManagedServiceInfo() {
  const supervisorState = readSupervisorState({ path: STATE_FILE, adminPort: 15101 });
  if (supervisorState) {
    return {
      state: {
        ...supervisorState,
        alive: isProcessAlive(supervisorState.supervisorPid)
      },
      staleStateRemoved: false
    };
  }
  const state = loadManagedState();
  if (!state) {
    return { state: null, staleStateRemoved: false };
  }
  if (!Number.isSafeInteger(state.pid) || state.pid < 1) {
    return { state: null, staleStateRemoved: false };
  }
  const alive = Boolean(state.pid && isProcessAlive(state.pid));
  if (!alive) {
    return { state: null, staleStateRemoved: removeManagedState() };
  }
  return {
    state: {
      ...state,
      alive: true
    },
    staleStateRemoved: false
  };
}

function saveManagedState(state) {
  ensureStateDirs();
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function chooseFreePort(host) {
  return await new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((closeError) => {
        if (closeError) {
          rejectPort(closeError);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function promptValue(question, defaultValue = "") {
  if (!process.stdin.isTTY) {
    if (defaultValue) {
      return defaultValue;
    }
    throw new Error(`${question} is required`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptSecret(question, defaultValue = "") {
  return await promptValue(question, defaultValue);
}

async function waitForHealthyProxy(proxyUrl, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${proxyUrl}/_proxy/health`);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Proxy did not become healthy at ${proxyUrl}: ${lastError?.message || "timeout"}`);
}

async function probeConfiguredLocalProxy(codexConfigPath) {
  const codexText = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
  const provider = extractOpenAiSection(codexText);
  const baseUrl = provider.base_url;
  if (typeof baseUrl !== "string" || !baseUrl) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return null;
  }

  if (!new Set(["127.0.0.1", "localhost"]).has(parsedUrl.hostname)) {
    return null;
  }

  try {
    const health = await waitForHealthyProxy(baseUrl, 1500);
    return { proxyUrl: baseUrl, managed: false, health };
  } catch (error) {
    return { proxyUrl: baseUrl, managed: false, healthError: error.message };
  }
}

function stopManagedService(state = loadManagedState()) {
  if (!state?.pid) {
    return { stopped: false, reason: "no_state" };
  }
  if (!isProcessAlive(state.pid)) {
    const cleared = removeManagedState();
    return { stopped: false, reason: cleared ? "already_stopped" : "already_stopped_state_uncleared" };
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    const cleared = removeManagedState();
    return { stopped: false, reason: cleared ? "signal_failed" : "signal_failed_state_uncleared" };
  }
  const cleared = removeManagedState();
  return { stopped: true, reason: cleared ? "signal_sent" : "signal_sent_state_uncleared" };
}

function startManagedService(proxyConfigPath, debug) {
  const env = {
    ...process.env,
    CODEX_PROXY_CONFIG: proxyConfigPath
  };

  if (debug) {
    const child = spawn("node", [resolve(PACKAGE_ROOT, "src", "server.mjs")], {
      cwd: PACKAGE_ROOT,
      env,
      stdio: "inherit"
    });
    return { pid: child.pid, mode: "foreground", child };
  }

  ensureStateDirs();
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn("node", [resolve(PACKAGE_ROOT, "src", "server.mjs")], {
    cwd: PACKAGE_ROOT,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  closeSync(logFd);
  return { pid: child.pid, mode: "background", logFile: LOG_FILE };
}

function installCliShim() {
  ensureStateDirs();
  const shim = `#!/bin/sh\nexec node ${quoteShell(resolve(PACKAGE_ROOT, "bin", "crp.mjs"))} "$@"\n`;
  writeFileSync(CRP_SHIM_PATH, shim, "utf8");
  chmodSync(CRP_SHIM_PATH, 0o755);
  return {
    shimPath: CRP_SHIM_PATH,
    exportCommand: `export PATH=${quoteShell(BIN_DIR)}:$PATH`
  };
}

function buildGuideData() {
  return {
    entrypoint: "crp",
    preferredImplementation: "node",
    commands: {
      inspect: "crp check --json",
      providerAdd: "crp provider add --name <NAME> --base-url <URL> --api-key <KEY> --json",
      providerTest: "crp provider test --id <ID> --model <MODEL> --json",
      providerActivate: "crp provider activate --id <ID> --json",
      start: "crp start --json",
      status: "crp status --json",
      ui: "crp ui --json",
      stop: "crp stop --json",
      shutdown: "crp shutdown --json",
      installCli: "npm install -g @cluic/codex-remote-proxy",
      runWithoutInstall: "npx @cluic/codex-remote-proxy guide --json"
    },
    expectedFlow: [
      "Add a provider with `crp provider add --name <NAME> --base-url <URL> --api-key <KEY> --json`.",
      "Validate it with `crp provider test --id <ID> --model <MODEL> --json`.",
      "Activate it with `crp provider activate --id <ID> --json`.",
      "Start the proxy through the supervisor with `crp start --json`.",
      "Confirm supervisor and worker health with `crp status --json`.",
      "Open the local management UI with `crp ui --json`.",
      "When finished, stop the supervisor with `crp shutdown --json`."
    ],
    notes: [
      "The start command creates a backup only when it changes ~/.codex/config.toml.",
      "Provider credential is write-only and never echoed by CLI or Admin API responses.",
      "The supervisor owns proxy lifecycle and applies the active provider when start is requested.",
      "The proxy configuration and state are stored under ~/.codex-remote-proxy/."
    ]
  };
}

function buildCheckData(options) {
  const { codexConfigPath, authPath } = getCommonPaths(options);
  const codexText = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
  const provider = extractOpenAiSection(codexText);
  const codexRemoteProxy = extractCodexRemoteProxySection(codexText);
  const codexRemoteProxyUpstreamBaseUrl = getCodexRemoteProxyUpstreamBaseUrl(codexRemoteProxy);
  const codexRemoteProxyUpstreamApiKey = getCodexRemoteProxyUpstreamApiKey(codexRemoteProxy);
  const codexRemoteProxyCaptureEnabled = getCodexRemoteProxyCaptureEnabled(codexRemoteProxy);
  const codexRemoteProxyCaptureDbPath = getCodexRemoteProxyCaptureDbPath(codexRemoteProxy);
  const authData = readJson(authPath);
  const userConfig = loadUserConfig();
  const runtimeProxyConfig = loadRuntimeProxyConfig();
  const managedInfo = getManagedServiceInfo();
  const runtimeStatus = { node: detectNodeRuntime() };

  return {
    codexConfigPath,
    authPath,
    codexOpenAiProvider: {
      baseUrl: provider.base_url ?? null,
      wireApi: provider.wire_api ?? null,
      requiresOpenAiAuth: provider.requires_openai_auth ?? null
    },
    codexRemoteProxy: {
      upstreamBaseUrl: codexRemoteProxyUpstreamBaseUrl,
      credentialConfigured: typeof codexRemoteProxyUpstreamApiKey === "string"
        && codexRemoteProxyUpstreamApiKey.length > 0,
      captureEnabled: codexRemoteProxyCaptureEnabled,
      captureDbPath: codexRemoteProxyCaptureDbPath
    },
    auth: {
      authMode: authData.auth_mode ?? null,
      openAiApiKeyConfigured: typeof authData.OPENAI_API_KEY === "string"
        && authData.OPENAI_API_KEY.length > 0,
      accessTokenConfigured: typeof authData?.tokens?.access_token === "string"
        && authData.tokens.access_token.length > 0
    },
    runtimeStatus,
    configSources: {
      codexConfigSectionPresent: Boolean(codexRemoteProxyUpstreamBaseUrl || codexRemoteProxyUpstreamApiKey),
      savedConfigPath: USER_CONFIG_FILE,
      savedConfigPresent: Boolean(userConfig.upstreamBaseUrl || userConfig.apiKey),
      envPresent: {
        upstreamBaseUrl: Boolean(process.env[ENV_KEYS.upstreamBaseUrl]),
        apiKey: Boolean(process.env[ENV_KEYS.apiKey]),
        listenHost: Boolean(process.env[ENV_KEYS.listenHost]),
        listenPort: Boolean(process.env[ENV_KEYS.listenPort]),
        captureEnabled: Boolean(process.env[ENV_KEYS.captureEnabled]),
        captureDbPath: Boolean(process.env[ENV_KEYS.captureDbPath])
      }
    },
    implementation: {
      configPath: NODE_RUNTIME_CONFIG_PATH,
      configExists: existsSync(NODE_RUNTIME_CONFIG_PATH),
      runtimeConfig: runtimeProxyConfig === null ? null : {
        server: {
          host: runtimeProxyConfig.server?.host ?? null,
          port: runtimeProxyConfig.server?.port ?? null
        },
        upstream: {
          baseUrl: runtimeProxyConfig.upstream?.baseUrl ?? null
        },
        capture: {
          enabled: runtimeProxyConfig.capture?.enabled === true,
          dbPath: runtimeProxyConfig.capture?.dbPath ?? null
        }
      },
      startCommand: startCommand(NODE_RUNTIME_CONFIG_PATH)
    },
    recommendedImplementation: "node",
    managedService: managedInfo.state,
    staleStateRemoved: managedInfo.staleStateRemoved,
    globalHome: GLOBAL_HOME,
    globalCommand: "crp"
  };
}

function printHumanCheck(data) {
  console.log(`Codex config path: ${data.codexConfigPath}`);
  console.log(`Codex auth path:   ${data.authPath}`);
  console.log("");
  console.log(`auth_mode: ${data.auth.authMode || "(unknown)"}`);
  console.log(`OPENAI_API_KEY configured: ${data.auth.openAiApiKeyConfigured ? "yes" : "no"}`);
  console.log(`tokens.access_token configured: ${data.auth.accessTokenConfigured ? "yes" : "no"}`);
  console.log("");
  console.log("Codex [model_providers.OpenAI]:");
  console.log(`  base_url: ${data.codexOpenAiProvider.baseUrl || "(missing)"}`);
  console.log(`  wire_api: ${data.codexOpenAiProvider.wireApi || "(missing)"}`);
  console.log(`  requires_openai_auth: ${data.codexOpenAiProvider.requiresOpenAiAuth ?? "(missing)"}`);
  console.log("");
  console.log("Codex [codex_remote_proxy]:");
  console.log(`  upstream_base_url: ${data.codexRemoteProxy.upstreamBaseUrl || "(missing)"}`);
  console.log(`  credential configured: ${data.codexRemoteProxy.credentialConfigured ? "yes" : "no"}`);
  console.log(`  capture_enabled: ${data.codexRemoteProxy.captureEnabled ?? "(missing)"}`);
  console.log(`  capture_db_path: ${data.codexRemoteProxy.captureDbPath || "(missing)"}`);
  console.log("");
  console.log("Runtime status:");
  console.log(`  node: ${data.runtimeStatus.node.available ? data.runtimeStatus.node.version : data.runtimeStatus.node.error}`);
  if (data.runtimeStatus.node.available && !data.runtimeStatus.node.dependenciesReady) {
    console.log(`        ${data.runtimeStatus.node.installHint}`);
  }
  console.log("");
  console.log(`Global home: ${data.globalHome}`);
  console.log(`Global command: ${data.globalCommand}`);
  console.log(`Codex proxy section: ${data.configSources.codexConfigSectionPresent ? data.codexConfigPath : "(not configured)"}`);
  console.log(`Saved config: ${data.configSources.savedConfigPresent ? data.configSources.savedConfigPath : "(not configured)"}`);
}

function writeProxyConfig(path, config) {
  ensureStateDirs();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function resolveConfigValue({ cliValue, envKey, savedValues = [], defaultValue = "" }) {
  if (typeof cliValue === "string" && cliValue.trim()) {
    return { value: cliValue.trim(), source: "cli" };
  }
  if (typeof process.env[envKey] === "string" && process.env[envKey].trim()) {
    return { value: process.env[envKey].trim(), source: "env" };
  }
  for (const savedValue of savedValues) {
    if (typeof savedValue?.value === "string" && savedValue.value.trim()) {
      return { value: savedValue.value.trim(), source: savedValue.source || "saved" };
    }
  }
  if (defaultValue) {
    return { value: defaultValue, source: "default" };
  }
  return { value: "", source: "missing" };
}

function resolveUserSettings(options) {
  const saved = loadUserConfig();
  const { codexConfigPath } = getCommonPaths(options);
  const codexText = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
  const codexRemoteProxy = extractCodexRemoteProxySection(codexText);
  const codexRemoteProxyUpstreamBaseUrl = getCodexRemoteProxyUpstreamBaseUrl(codexRemoteProxy);
  const codexRemoteProxyUpstreamApiKey = getCodexRemoteProxyUpstreamApiKey(codexRemoteProxy);
  const codexRemoteProxyCaptureEnabled = getCodexRemoteProxyCaptureEnabled(codexRemoteProxy);
  const codexRemoteProxyCaptureDbPath = getCodexRemoteProxyCaptureDbPath(codexRemoteProxy);
  return {
    upstreamBaseUrl: resolveConfigValue({
      cliValue: options["upstream-base-url"],
      envKey: ENV_KEYS.upstreamBaseUrl,
      savedValues: [
        { value: codexRemoteProxyUpstreamBaseUrl, source: "codex_config" },
        { value: saved.upstreamBaseUrl, source: "saved" }
      ]
    }),
    apiKey: resolveConfigValue({
      cliValue: options["api-key"],
      envKey: ENV_KEYS.apiKey,
      savedValues: [
        { value: codexRemoteProxyUpstreamApiKey, source: "codex_config" },
        { value: saved.apiKey, source: "saved" }
      ]
    }),
    listenHost: resolveConfigValue({
      cliValue: options["listen-host"],
      envKey: ENV_KEYS.listenHost,
      savedValues: [
        { value: saved.listenHost, source: "saved" }
      ],
      defaultValue: "127.0.0.1"
    }),
    listenPort: resolveConfigValue({
      cliValue: options["listen-port"],
      envKey: ENV_KEYS.listenPort,
      savedValues: [
        { value: saved.listenPort ? String(saved.listenPort) : "", source: "saved" }
      ]
    }),
    captureEnabled: (() => {
      if (options.capture === true) {
        return { value: true, source: "cli" };
      }
      if (options["no-capture"] === true) {
        return { value: false, source: "cli" };
      }
      const envValue = normalizeBooleanInput(process.env[ENV_KEYS.captureEnabled], null);
      if (envValue !== null) {
        return { value: envValue, source: "env" };
      }
      if (typeof codexRemoteProxyCaptureEnabled === "boolean") {
        return { value: codexRemoteProxyCaptureEnabled, source: "codex_config" };
      }
      if (typeof saved.captureEnabled === "boolean") {
        return { value: saved.captureEnabled, source: "saved" };
      }
      return { value: false, source: "default" };
    })(),
    captureDbPath: resolveConfigValue({
      cliValue: options["capture-db-path"],
      envKey: ENV_KEYS.captureDbPath,
      savedValues: [
        { value: codexRemoteProxyCaptureDbPath, source: "codex_config" },
        { value: saved.captureDbPath, source: "saved" }
      ],
      defaultValue: DEFAULT_CAPTURE_DB_PATH
    })
  };
}

async function installCommand(options) {
  if (options.json && options.debug) {
    throw new Error("--json cannot be combined with --debug");
  }

  const checkData = buildCheckData(options);
  if (!checkData.runtimeStatus.node.dependenciesReady) {
    throw new Error("Node dependencies are missing. Run `npm install` first.");
  }

  const resolved = resolveUserSettings(options);
  const upstreamBaseUrl = resolved.upstreamBaseUrl.value || await promptValue("Upstream base URL", "");
  const apiKey = resolved.apiKey.value || await promptSecret("Upstream API key", "");
  if (!upstreamBaseUrl || !apiKey) {
    throw new Error("Upstream base URL and API key are required");
  }

  const listenHost = resolved.listenHost.value || "127.0.0.1";
  const listenPort = resolved.listenPort.value ? Number.parseInt(resolved.listenPort.value, 10) : await chooseFreePort(listenHost);
  const codexConfigPath = getCommonPaths(options).codexConfigPath;
  const authPath = getCommonPaths(options).authPath;
  const proxyConfigPath = NODE_RUNTIME_CONFIG_PATH;
  const proxyUrl = `http://${listenHost}:${listenPort}`;
  const captureEnabled = Boolean(resolved.captureEnabled.value);
  const captureDbPath = ensureCaptureDbPath(resolved.captureDbPath.value);

  const proxyConfig = {
    server: { host: listenHost, port: listenPort, logLevel: "info" },
    upstream: {
      baseUrl: upstreamBaseUrl.replace(/\/$/, ""),
      apiKey,
      timeoutMs: 300000,
      verifySsl: true,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {}
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    },
    capture: {
      enabled: captureEnabled,
      dbPath: captureDbPath
    }
  };

  ensureStateDirs();
  writeProxyConfig(proxyConfigPath, proxyConfig);
  if (!existsSync(codexConfigPath)) {
    throw new Error(`Codex config not found: ${codexConfigPath}`);
  }
  const { backupPath } = bootstrapCodexConfig({ configPath: codexConfigPath, proxyUrl });

  const existingState = loadManagedState();
  if (existingState?.pid && isProcessAlive(existingState.pid)) {
    stopManagedService(existingState);
  }

  const startResult = startManagedService(proxyConfigPath, Boolean(options.debug));
  const managedState = {
    version: 1,
    implementation: "node",
    pid: startResult.pid,
    mode: startResult.mode,
    listenHost,
    listenPort,
    proxyUrl,
    codexConfigPath,
    authPath,
    proxyConfigPath,
    logFile: startResult.logFile || null,
    upstreamBaseUrl,
    codexConfigBackup: backupPath,
    startedAt: new Date().toISOString()
  };
  saveManagedState(managedState);

  if (options.debug) {
    console.log(`Proxy configured at ${proxyUrl}`);
    console.log("Debug mode is active; the proxy runs in the foreground.");
    await delay(250);
    if (startResult.child?.exitCode != null) {
      stopManagedService(managedState);
      throw new Error(`Proxy exited immediately with code ${startResult.child.exitCode}`);
    }
    if (startResult.child && startResult.child.exitCode == null && startResult.child.signalCode == null) {
      await new Promise((resolveExit) => startResult.child.once("exit", resolveExit));
    }
    return;
  }

  const health = await waitForHealthyProxy(proxyUrl);
  const payload = {
    ok: true,
    implementation: "node",
    proxyUrl,
    pid: startResult.pid,
    listenHost,
    listenPort,
    upstreamBaseUrl,
    codexConfigPath,
    proxyConfigPath,
    codexConfigBackup: backupPath,
    configSource: {
      upstreamBaseUrl: resolved.upstreamBaseUrl.source,
      apiKey: resolved.apiKey.source,
      listenHost: resolved.listenHost.source,
      listenPort: resolved.listenPort.source === "missing" ? "auto" : resolved.listenPort.source,
      captureEnabled: resolved.captureEnabled.source,
      captureDbPath: resolved.captureDbPath.source
    },
    logFile: managedState.logFile,
    managedStatePath: STATE_FILE,
    health,
    captureConfigured: health.captureConfigured ?? captureEnabled,
    captureActive: health.captureActive ?? false,
    captureDbPath: health.captureDbPath ?? captureDbPath,
    captureState: health.captureState ?? (captureEnabled ? "enabled" : "disabled"),
    captureRestartRequired: health.captureRestartRequired ?? false,
    failedWriteCount: health.failedWriteCount ?? 0,
    lastWriteErrorAt: health.lastWriteErrorAt ?? null,
    lastWriteErrorMessage: health.lastWriteErrorMessage ?? null,
    message: "Proxy configured and started"
  };

  if (!maybePrintJson(options, payload)) {
    console.log("Codex Remote Proxy is ready.");
    console.log(`Proxy URL: ${proxyUrl}`);
    console.log("Running in background: yes");
    console.log("");
    console.log("Next steps:");
    console.log("1. Restart Codex Desktop.");
    console.log("2. Sign in with your ChatGPT account.");
    console.log("3. Continue using Codex as usual; requests will be forwarded to your upstream API.");
    console.log("");
    console.log(`Health check: curl ${proxyUrl}/_proxy/health`);
    console.log("Status: crp status --json");
    console.log("Stop:   crp stop --json");
  }
}

const startCommandAction = installCommand;

async function initCommand(options) {
  const resolved = resolveUserSettings(options);
  const upstreamBaseUrl = resolved.upstreamBaseUrl.value || await promptValue("Upstream base URL", "");
  const apiKey = resolved.apiKey.value || await promptSecret("Upstream API key", "");
  const listenHost = resolved.listenHost.value || "127.0.0.1";
  const listenPort = resolved.listenPort.value ? Number.parseInt(resolved.listenPort.value, 10) : undefined;
  const captureEnabled = Boolean(resolved.captureEnabled.value);
  const captureDbPath = ensureCaptureDbPath(resolved.captureDbPath.value);

  if (!upstreamBaseUrl || !apiKey) {
    throw new Error("Upstream base URL and API key are required");
  }

  writeUserConfig({
    upstreamBaseUrl,
    apiKey,
    listenHost,
    listenPort,
    captureEnabled,
    captureDbPath
  });

  const payload = {
    ok: true,
    configPath: USER_CONFIG_FILE,
    saved: {
      upstreamBaseUrl,
      apiKeyPreview: maskSecret(apiKey),
      listenHost,
      listenPort: listenPort ?? null,
      captureEnabled,
      captureDbPath
    }
  };

  if (!maybePrintJson(options, payload)) {
    console.log("Saved CRP configuration.");
    console.log(`Config path: ${USER_CONFIG_FILE}`);
    console.log("You can now run: crp start");
  }
}

function checkCommand(options) {
  const data = buildCheckData(options);
  if (!maybePrintJson(options, data)) {
    printHumanCheck(data);
  }
}

function guideCommand(options) {
  const data = buildGuideData();
  if (!maybePrintJson(options, data)) {
    console.log("CRP V1 guide:");
    for (const step of data.expectedFlow) {
      console.log(`  ${step}`);
    }
  }
}

async function statusCommand(options) {
  const managedInfo = getManagedServiceInfo();
  const state = managedInfo.state;
  const alive = Boolean(state);
  const payload = {
    ok: true,
    running: alive,
    state,
    staleStateRemoved: managedInfo.staleStateRemoved
  };
  if (state?.proxyUrl && alive) {
    try {
      payload.health = await waitForHealthyProxy(state.proxyUrl, 2000);
      payload.captureConfigured = payload.health.captureConfigured ?? null;
      payload.captureActive = payload.health.captureActive ?? null;
      payload.captureDbPath = payload.health.captureDbPath ?? null;
      payload.captureState = payload.health.captureState ?? null;
      payload.captureRestartRequired = payload.health.captureRestartRequired ?? null;
      payload.failedWriteCount = payload.health.failedWriteCount ?? 0;
      payload.lastWriteErrorAt = payload.health.lastWriteErrorAt ?? null;
      payload.lastWriteErrorMessage = payload.health.lastWriteErrorMessage ?? null;
    } catch (error) {
      payload.healthError = error.message;
    }
  } else {
    const probe = await probeConfiguredLocalProxy(getCommonPaths(options).codexConfigPath);
    if (probe) {
      payload.probe = probe;
    }
  }
  if (!maybePrintJson(options, payload)) {
    if (alive) {
      console.log("Proxy is running.");
    } else if (payload.probe?.health) {
      console.log("A proxy is running, but it is unmanaged by this CLI.");
      console.log(`Proxy URL: ${payload.probe.proxyUrl}`);
    } else {
      console.log("Proxy is not running.");
    }
  }
}

async function captureCommand(options, action) {
  if (!["on", "off", "status"].includes(action)) {
    throw new Error(`Unknown capture action: ${action}`);
  }

  if (action === "status") {
    const runtime = loadRuntimeProxyConfig();
    const state = loadManagedState();
    const supervisorState = readSupervisorState({ path: STATE_FILE, adminPort: 15101 });
    const payload = {
      ok: true,
      running: supervisorState
        ? isProcessAlive(supervisorState.supervisorPid)
        : Boolean(state?.pid && isProcessAlive(state.pid)),
      managedBySupervisor: supervisorState !== null,
      persistedConfig: {
        captureEnabled: loadUserConfig().captureEnabled === true,
        captureDbPath: loadUserConfig().captureDbPath ?? null
      },
      runtimeConfig: runtime?.capture ? {
        enabled: runtime.capture.enabled === true,
        dbPath: runtime.capture.dbPath ?? null
      } : null
    };
    if (state?.proxyUrl && payload.running) {
      try {
        payload.health = await waitForHealthyProxy(state.proxyUrl, 2000);
      } catch (error) {
        payload.healthError = error.message;
      }
    }
    if (!maybePrintJson(options, payload)) {
      console.log(`Capture running: ${payload.running ? "yes" : "no"}`);
      console.log(`Persisted capture enabled: ${payload.persistedConfig.captureEnabled ? "yes" : "no"}`);
      console.log(`Persisted capture DB: ${payload.persistedConfig.captureDbPath || DEFAULT_CAPTURE_DB_PATH}`);
      if (payload.runtimeConfig) {
        console.log(`Runtime capture enabled: ${payload.runtimeConfig.enabled ? "yes" : "no"}`);
        console.log(`Runtime capture DB: ${payload.runtimeConfig.dbPath || DEFAULT_CAPTURE_DB_PATH}`);
      }
    }
    return;
  }

  if (readSupervisorState({ path: STATE_FILE, adminPort: 15101 })) {
    throw new Error("Capture settings are read-only in this version.");
  }
  const enabled = action === "on";
  const persistedConfig = applyUserConfigPatch({
    captureEnabled: enabled,
    captureDbPath: ensureCaptureDbPath(loadUserConfig().captureDbPath)
  });

  const payload = {
    ok: true,
    action,
    persistedConfig: {
      captureEnabled: persistedConfig.captureEnabled === true,
      captureDbPath: persistedConfig.captureDbPath ?? null
    },
    runtimeUpdated: false,
    message: ""
  };

  const managedState = loadManagedState();
  const running = Boolean(managedState?.pid && isProcessAlive(managedState.pid));
  if (!running) {
    payload.message = "Capture preference saved. It will apply the next time the proxy starts.";
    if (!maybePrintJson(options, payload)) {
      console.log(payload.message);
    }
    return;
  }

  const runtimeConfig = loadRuntimeProxyConfig();
  if (!runtimeConfig) {
    throw new Error(`Runtime proxy config not found: ${NODE_RUNTIME_CONFIG_PATH}`);
  }
  runtimeConfig.capture = {
    enabled,
    dbPath: ensureCaptureDbPath(
      runtimeConfig.capture?.dbPath || persistedConfig.captureDbPath || DEFAULT_CAPTURE_DB_PATH
    )
  };
  writeProxyConfig(NODE_RUNTIME_CONFIG_PATH, runtimeConfig);
  payload.runtimeUpdated = true;
  payload.message = "Capture preference saved and runtime config updated.";

  if (managedState.proxyUrl) {
    try {
      const health = await waitForHealthyProxy(managedState.proxyUrl, 4000);
      payload.health = health;
    } catch (error) {
      payload.healthError = error.message;
    }
  }

  if (!maybePrintJson(options, payload)) {
    console.log(payload.message);
  }
}

async function stopCommand(options) {
  const result = stopManagedService(loadManagedState());
  const payload = { ok: true, stopped: result.stopped, reason: result.reason };
  if (!maybePrintJson(options, payload)) {
    console.log(result.stopped ? "Proxy stopped." : "No running proxy to stop.");
  }
}

async function installCliCommand(options) {
  const result = installCliShim();
  const payload = {
    ok: true,
    shimPath: result.shimPath,
    binDir: BIN_DIR,
    exportCommand: result.exportCommand,
    deprecated: true,
    message: "install-cli is deprecated for public distribution; prefer npm global installation."
  };
  if (!maybePrintJson(options, payload)) {
    console.log("Legacy local shim installed.");
    console.log("For public distribution, prefer:");
    console.log("npm install -g @cluic/codex-remote-proxy");
  }
}

function writePayload(options, payload, stdout, humanMessage) {
  if (options.json) {
    stdout(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  stdout(`${humanMessage}\n`);
}

export function openManagementUrl(url, {
  platform = process.platform,
  spawnImpl = spawn
} = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The local management URL is invalid.");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
    || !parsed.port || parsed.pathname !== "/" || parsed.search
    || !/^#token=[A-Za-z0-9_-]{43}$/.test(parsed.hash)) {
    throw new Error("The local management URL is invalid.");
  }
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/d", "/s", "/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true
  });
  child.once?.("error", () => {});
  child.unref();
  return child;
}

function parseProviderOptions(argv) {
  const action = argv[1];
  if (!["list", "add", "test", "activate", "delete"].includes(action)) {
    throw new Error("Unknown provider action.");
  }
  const { options } = parseCommandLine(["provider", ...argv.slice(2)]);
  const allowed = {
    list: new Set(["json"]),
    add: new Set([
      "json",
      "name",
      "base-url",
      "api-key",
      "auth-header",
      "auth-scheme",
      "model-mode",
      "model-override",
      "fallback-consent"
    ]),
    test: new Set(["json", "id", "model"]),
    activate: new Set(["json", "id"]),
    delete: new Set(["json", "id"])
  }[action];
  if (Object.keys(options).some((field) => !allowed.has(field))) {
    throw new Error("The provider command contains an unsupported option.");
  }
  return { action, options };
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`The provider ${name} option is required.`);
  }
  return value.trim();
}

async function dispatchProviderCommand(argv, dependencies) {
  const { action, options } = parseProviderOptions(argv);
  const context = await dependencies.ensureSupervisorImpl({
    paths: dependencies.paths,
    adminPort: dependencies.adminPort
  });
  let method;
  let path;
  let body;
  if (action === "list") {
    method = "GET";
    path = "/providers";
  } else if (action === "add") {
    method = "POST";
    path = "/providers";
    const provider = {
      name: requiredOption(options, "name"),
      baseUrl: requiredOption(options, "base-url")
    };
    for (const [option, field] of [
      ["auth-header", "authHeader"],
      ["auth-scheme", "authScheme"],
      ["model-mode", "modelMode"],
      ["model-override", "modelOverride"]
    ]) {
      if (typeof options[option] === "string") provider[field] = options[option];
    }
    body = {
      provider,
      credential: requiredOption(options, "api-key"),
      fallbackConsent: options["fallback-consent"] === true
    };
  } else {
    const id = encodeURIComponent(requiredOption(options, "id"));
    if (action === "test") {
      method = "POST";
      path = `/providers/${id}/test`;
      body = { model: requiredOption(options, "model") };
    } else if (action === "activate") {
      method = "POST";
      path = `/providers/${id}/activate`;
    } else {
      method = "DELETE";
      path = `/providers/${id}`;
    }
  }
  const result = await context.client.request(method, path, body);
  writePayload(options, {
    ok: true,
    action,
    ...result
  }, dependencies.stdout, `Provider ${action} completed.`);
}

function parseSupervisorOptions(argv) {
  const { command, options } = parseCommandLine(argv);
  const allowed = {
    ui: new Set(["json", "no-open"]),
    start: new Set(["json"]),
    install: new Set(["json"]),
    setup: new Set(["json"]),
    status: new Set(["json"]),
    stop: new Set(["json"]),
    restart: new Set(["json"]),
    shutdown: new Set(["json"])
  }[command];
  if (Object.keys(options).some((field) => !allowed.has(field))) {
    throw new Error(`The ${command} command contains an unsupported option.`);
  }
  return { command, options };
}

async function dispatchSupervisorCommand(argv, dependencies) {
  const supervisorCommands = new Set([
    "ui",
    "start",
    "install",
    "setup",
    "status",
    "stop",
    "restart",
    "shutdown",
    "provider"
  ]);
  if (!supervisorCommands.has(argv[0])) return false;
  if (argv[0] === "provider") {
    await dispatchProviderCommand(argv, dependencies);
    return true;
  }
  const { command, options } = parseSupervisorOptions(argv);
  const {
    paths,
    adminPort,
    ensureSupervisorImpl,
    discoverSupervisorImpl,
    stdout,
    killProcess,
    isProcessAliveImpl,
    wait,
    now,
    shutdownTimeoutMs,
    readControlTokenImpl,
    openManagementUrlImpl
  } = dependencies;
  const discoveryOptions = { paths, adminPort };

  if (command === "ui") {
    const context = await ensureSupervisorImpl(discoveryOptions);
    const token = readControlTokenImpl({ path: paths.controlTokenPath });
    const url = `${context.origin}/#token=${token}`;
    const opened = options["no-open"] !== true;
    if (opened) openManagementUrlImpl(url);
    writePayload(options["no-open"] === true ? { ...options, json: true } : options, {
      ok: true,
      opened,
      origin: context.origin,
      supervisorPid: context.state.supervisorPid,
      url
    }, stdout, opened ? "CRP management UI opened." : url);
    return true;
  }

  if (command === "status") {
    const context = await discoverSupervisorImpl(discoveryOptions);
    const payload = context === null
      ? { ok: true, running: false, reason: "supervisor_not_running" }
      : { ok: true, running: true, ...context.status };
    writePayload(options, payload, stdout, payload.running
      ? "CRP supervisor is running."
      : "CRP supervisor is not running.");
    return true;
  }

  if (command === "stop") {
    const context = await discoverSupervisorImpl(discoveryOptions);
    if (context === null) {
      writePayload(options, {
        ok: true,
        stopped: false,
        reason: "supervisor_not_running"
      }, stdout, "No running proxy worker to stop.");
      return true;
    }
    const result = await context.client.request("POST", "/proxy/stop");
    const payload = {
      ok: true,
      stopped: result?.worker?.phase === "stopped",
      worker: result?.worker ?? null
    };
    writePayload(options, payload, stdout, "Proxy worker stopped.");
    return true;
  }

  if (command === "shutdown") {
    const context = await discoverSupervisorImpl(discoveryOptions);
    if (context === null) {
      writePayload(options, {
        ok: true,
        shutdown: false,
        reason: "supervisor_not_running"
      }, stdout, "CRP supervisor is not running.");
      return true;
    }
    const latest = await context.client.request("GET", "/status");
    const supervisorPid = context.state.supervisorPid;
    if (latest?.supervisor?.pid !== supervisorPid
      || latest?.supervisor?.startedAt !== context.state.startedAt) {
      throw new Error("Supervisor identity changed; shutdown was cancelled.");
    }
    killProcess(supervisorPid, "SIGTERM");
    const deadline = now() + shutdownTimeoutMs;
    while ((isProcessAliveImpl(supervisorPid) || existsSync(paths.statePath)) && now() < deadline) {
      await wait(Math.min(100, deadline - now()));
    }
    if (isProcessAliveImpl(supervisorPid)) {
      throw new Error("The supervisor did not stop in time.");
    }
    if (existsSync(paths.statePath)) {
      throw new Error("The supervisor state was not cleaned up in time.");
    }
    writePayload(options, {
      ok: true,
      shutdown: true,
      supervisorPid,
      workerStopped: true
    }, stdout, "CRP supervisor stopped.");
    return true;
  }

  const context = await ensureSupervisorImpl(discoveryOptions);
  if (command === "restart") {
    const result = await context.client.request("POST", "/proxy/restart");
    writePayload(options, {
      ok: true,
      command: "restart",
      supervisorPid: context.state.supervisorPid,
      worker: result?.worker ?? null
    }, stdout, "Proxy worker restarted.");
    return true;
  }

  let codexBootstrap = null;
  if (context.status?.codex?.configured !== true) {
    const bootstrap = await context.client.request("POST", "/codex/bootstrap");
    codexBootstrap = bootstrap?.result ?? null;
  }
  const result = await context.client.request("POST", "/proxy/start");
  const payload = {
    ok: true,
    command: "start",
    implementation: "node",
    supervisorPid: context.state.supervisorPid,
    proxyUrl: context.status?.codex?.proxyUrl ?? "http://127.0.0.1:15100",
    worker: result?.worker ?? null,
    codexBootstrap
  };
  if (command === "install" || command === "setup") payload.deprecated = true;
  writePayload(options, payload, stdout, "Codex Remote Proxy is ready.");
  return true;
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "capture") {
    const action = argv[1];
    const options = {};
    for (let index = 2; index < argv.length; index += 1) {
      const token = argv[index];
      if (!token.startsWith("--")) {
        throw new Error(`Unexpected argument: ${token}`);
      }
      const key = token.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options[key] = true;
        continue;
      }
      options[key] = next;
      index += 1;
    }
    return await captureCommand(options, action);
  }

  const { command, options } = parseCommandLine(argv);
  if (command === "check") return checkCommand(options);
  if (command === "init") return await initCommand(options);
  if (command === "guide") return guideCommand(options);
  if (command === "start" || command === "install" || command === "setup") return await startCommandAction(options);
  if (command === "status") return await statusCommand(options);
  if (command === "stop") return await stopCommand(options);
  if (command === "install-cli") return await installCliCommand(options);
  throw new Error(`Unknown command: ${command}`);
}

export async function runCli(argv, {
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  paths = getPaths(),
  adminPort = 15101,
  ensureSupervisorImpl = ensureSupervisor,
  discoverSupervisorImpl = discoverSupervisor,
  readControlTokenImpl = readControlToken,
  openManagementUrlImpl = (url) => openManagementUrl(url),
  killProcess = (pid, signal) => process.kill(pid, signal),
  isProcessAlive: isProcessAliveImpl = isProcessAlive,
  wait = (milliseconds) => delay(milliseconds),
  now = () => Date.now(),
  shutdownTimeoutMs = 8_000
} = {}) {
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      printHelp((line) => stdout(`${line}\n`));
      return 0;
    }
    const handled = await dispatchSupervisorCommand(argv, {
      paths,
      adminPort,
      ensureSupervisorImpl,
      discoverSupervisorImpl,
      stdout,
      killProcess,
      isProcessAliveImpl,
      wait,
      now,
      shutdownTimeoutMs,
      readControlTokenImpl,
      openManagementUrlImpl
    });
    if (!handled) await main(argv);
    return 0;
  } catch (error) {
    stderr(`Error: ${error?.message || "CRP could not complete the command."}\n`);
    return 1;
  }
}

function isDirectExecution(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  return typeof argv1 === "string"
    && argv1.length > 0
    && resolve(fileURLToPath(metaUrl)) === resolve(argv1);
}

if (isDirectExecution()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
