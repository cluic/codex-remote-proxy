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
import { CrpError } from "../src/shared/errors.mjs";
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
const BOOLEAN_OPTIONS = new Set(["json", "no-open", "capture", "no-capture", "debug"]);
const SAFE_CLI_COMMANDS = new Set([
  "init", "ui", "start", "install", "setup", "status", "stop", "restart", "shutdown",
  "provider", "check", "capture", "guide", "install-cli"
]);
const SAFE_ERROR_DETAIL_FIELDS = new Set([
  "field", "reason", "committed", "degraded", "generation", "httpStatus"
]);
const CLI_ERROR_CONTRACTS = Object.freeze({
  CLI_INPUT_INVALID: Object.freeze({
    message: "The command input is invalid.",
    action: "Review the command options and try again."
  }),
  CLI_COMMAND_FAILED: Object.freeze({
    message: "CRP could not complete the command.",
    action: "Review CRP activity and try again."
  })
});
export const CLI_MESSAGES = Object.freeze({
  en: Object.freeze({
    "error.prefix": "Error: {message}",
    "error.commandFailed": "CRP could not complete the command. Review CRP activity and try again.",
    "error.public": "{message} {action}",
    "help.usage": "Usage:",
    "help.check": "  crp check [--json] [--codex-config PATH] [--auth PATH]",
    "help.init": "  crp init [--no-open] [--json] (alias of ui)",
    "help.ui": "  crp ui [--no-open] [--json]",
    "help.start": "  crp start [--json]",
    "help.install": "  crp install [same as start]",
    "help.capture": "  crp capture <on|off|status> [--json]",
    "help.status": "  crp status [--json]",
    "help.stop": "  crp stop [--json]",
    "help.restart": "  crp restart [--json]",
    "help.shutdown": "  crp shutdown [--json]",
    "help.provider": "  crp provider list|add|test|activate|delete [--json]",
    "help.setup": "  crp setup [same as start]",
    "help.guide": "  crp guide [--json]",
    "help.installCli": "  crp install-cli [--json]",
    "validation.unexpectedPositional": "Unexpected positional argument.",
    "validation.providerAction": "Unknown provider action.",
    "validation.providerOption": "The provider command contains an unsupported option.",
    "validation.providerRequired": "The provider {name} option is required.",
    "validation.commandOption": "The {command} command contains an unsupported option.",
    "validation.localeDuplicate": "The --locale option may only be provided once.",
    "validation.localeRequired": "The --locale option requires en or zh-CN.",
    "validation.localeUnsupported": "The --locale option supports only en or zh-CN.",
    "validation.captureAction": "Unknown capture action.",
    "validation.captureOption": "The capture command contains an unsupported option.",
    "common.yes": "yes",
    "common.no": "no",
    "common.unknown": "(unknown)",
    "common.missing": "(missing)",
    "common.notConfigured": "(not configured)",
    "check.codexConfigPath": "Codex config path: {value}",
    "check.authPath": "Codex auth path:   {value}",
    "check.authMode": "auth_mode: {value}",
    "check.configured": "{name} configured: {value}",
    "check.section": "Codex [{name}]:",
    "check.field": "  {name}: {value}",
    "check.runtimeStatus": "Runtime status:",
    "check.node": "  node: {value}",
    "check.installHint": "        Run `npm install` in the package directory first.",
    "check.globalHome": "Global home: {value}",
    "check.globalCommand": "Global command: {value}",
    "check.proxySection": "Codex proxy section: {value}",
    "check.savedConfig": "Saved config: {value}",
    "guide.header": "CRP V1 guide:",
    "guide.add": "  Add a provider with `{command}`.",
    "guide.test": "  Validate it with `{command}`.",
    "guide.activate": "  Activate it with `{command}`.",
    "guide.start": "  Start the proxy through the supervisor with `{command}`.",
    "guide.status": "  Confirm supervisor and worker health with `{command}`.",
    "guide.ui": "  Open the local management UI with `{command}`.",
    "guide.shutdown": "  When finished, stop the supervisor with `{command}`.",
    "capture.running": "Capture running: {value}",
    "capture.persistedEnabled": "Persisted capture enabled: {value}",
    "capture.persistedDb": "Persisted capture DB: {value}",
    "capture.runtimeEnabled": "Runtime capture enabled: {value}",
    "capture.runtimeDb": "Runtime capture DB: {value}",
    "capture.savedNextStart": "Capture preference saved. It will apply the next time the proxy starts.",
    "capture.savedRuntime": "Capture preference saved and runtime config updated.",
    "installCli.installed": "Legacy local shim installed.",
    "installCli.prefer": "For public distribution, prefer:",
    "ui.opened": "CRP management UI opened.",
    "status.running": "CRP supervisor is running.",
    "provider.add.completed": "Provider add completed.",
    "provider.activate.completed": "Provider activate completed.",
    "provider.delete.completed": "Provider delete completed.",
    "provider.list.completed": "Provider list completed.",
    "provider.test.completed": "Provider test completed.",
    "start.ready": "Codex Remote Proxy is ready.",
    "status.notRunning": "CRP supervisor is not running.",
    "stop.notRunning": "No running proxy worker to stop.",
    "stop.completed": "Proxy worker stopped.",
    "restart.completed": "Proxy worker restarted.",
    "shutdown.notRunning": "CRP supervisor is not running.",
    "shutdown.identityChanged": "Supervisor identity changed; shutdown was cancelled.",
    "shutdown.timeout": "The supervisor did not stop in time.",
    "shutdown.stateTimeout": "The supervisor state was not cleaned up in time.",
    "shutdown.completed": "CRP supervisor stopped.",
    "stage.supervisor_start.failed": "Supervisor startup failed. Review the supervisor log and try again.",
    "stage.codex_bootstrap.failed": "Codex configuration bootstrap failed. Review CRP activity and retry before starting the proxy.",
    "stage.proxy_start.failed": "Proxy startup failed. Review CRP activity and try again."
  }),
  "zh-CN": Object.freeze({
    "error.prefix": "错误：{message}",
    "error.commandFailed": "CRP 无法完成该命令。请查看 CRP 活动记录后重试。",
    "error.public": "命令失败（{code}）。请查看 CRP 活动记录后重试。",
    "help.usage": "用法：",
    "help.check": "  crp check [--json] [--codex-config PATH] [--auth PATH]",
    "help.init": "  crp init [--no-open] [--json]（ui 的别名）",
    "help.ui": "  crp ui [--no-open] [--json]",
    "help.start": "  crp start [--json]",
    "help.install": "  crp install [等同于 start]",
    "help.capture": "  crp capture <on|off|status> [--json]",
    "help.status": "  crp status [--json]",
    "help.stop": "  crp stop [--json]",
    "help.restart": "  crp restart [--json]",
    "help.shutdown": "  crp shutdown [--json]",
    "help.provider": "  crp provider list|add|test|activate|delete [--json]",
    "help.setup": "  crp setup [等同于 start]",
    "help.guide": "  crp guide [--json]",
    "help.installCli": "  crp install-cli [--json]",
    "validation.unexpectedPositional": "出现了意外的位置参数。",
    "validation.providerAction": "未知的提供商操作。",
    "validation.providerOption": "提供商命令包含不支持的选项。",
    "validation.providerRequired": "提供商选项 {name} 为必填项。",
    "validation.commandOption": "{command} 命令包含不支持的选项。",
    "validation.localeDuplicate": "--locale 选项只能提供一次。",
    "validation.localeRequired": "--locale 选项需要 en 或 zh-CN。",
    "validation.localeUnsupported": "--locale 选项仅支持 en 或 zh-CN。",
    "validation.captureAction": "未知的 capture 操作。",
    "validation.captureOption": "capture 命令包含不支持的选项。",
    "common.yes": "是",
    "common.no": "否",
    "common.unknown": "（未知）",
    "common.missing": "（缺失）",
    "common.notConfigured": "（未配置）",
    "check.codexConfigPath": "Codex 配置路径：{value}",
    "check.authPath": "Codex 认证路径：{value}",
    "check.authMode": "auth_mode：{value}",
    "check.configured": "{name} 已配置：{value}",
    "check.section": "Codex [{name}]：",
    "check.field": "  {name}：{value}",
    "check.runtimeStatus": "运行时状态：",
    "check.node": "  node：{value}",
    "check.installHint": "        请先在软件包目录中运行 `npm install`。",
    "check.globalHome": "全局目录：{value}",
    "check.globalCommand": "全局命令：{value}",
    "check.proxySection": "Codex 代理配置段：{value}",
    "check.savedConfig": "已保存配置：{value}",
    "guide.header": "CRP V1 指南：",
    "guide.add": "  使用 `{command}` 添加提供商。",
    "guide.test": "  使用 `{command}` 验证提供商。",
    "guide.activate": "  使用 `{command}` 激活提供商。",
    "guide.start": "  使用 `{command}` 通过监督进程启动代理。",
    "guide.status": "  使用 `{command}` 确认监督进程和工作进程状态。",
    "guide.ui": "  使用 `{command}` 打开本地管理页面。",
    "guide.shutdown": "  完成后使用 `{command}` 停止监督进程。",
    "capture.running": "抓取功能运行中：{value}",
    "capture.persistedEnabled": "持久化抓取设置已启用：{value}",
    "capture.persistedDb": "持久化抓取数据库：{value}",
    "capture.runtimeEnabled": "运行时抓取已启用：{value}",
    "capture.runtimeDb": "运行时抓取数据库：{value}",
    "capture.savedNextStart": "抓取偏好已保存，将在代理下次启动时生效。",
    "capture.savedRuntime": "抓取偏好已保存，运行时配置已更新。",
    "installCli.installed": "旧版本地命令入口已安装。",
    "installCli.prefer": "公开分发请优先使用：",
    "ui.opened": "CRP 管理页面已打开。",
    "status.running": "CRP 监督进程正在运行。",
    "provider.add.completed": "提供商添加操作已完成。",
    "provider.activate.completed": "提供商激活操作已完成。",
    "provider.delete.completed": "提供商删除操作已完成。",
    "provider.list.completed": "提供商列表操作已完成。",
    "provider.test.completed": "提供商测试操作已完成。",
    "start.ready": "Codex Remote Proxy 已就绪。",
    "status.notRunning": "CRP 监督进程未运行。",
    "stop.notRunning": "没有正在运行的代理工作进程可停止。",
    "stop.completed": "代理工作进程已停止。",
    "restart.completed": "代理工作进程已重启。",
    "shutdown.notRunning": "CRP 监督进程未运行。",
    "shutdown.identityChanged": "监督进程身份已变化，已取消关闭操作。",
    "shutdown.timeout": "监督进程未能及时停止。",
    "shutdown.stateTimeout": "监督进程状态未能及时清理。",
    "shutdown.completed": "CRP 监督进程已停止。",
    "stage.supervisor_start.failed": "启动监督进程失败。请检查监督进程日志后重试。",
    "stage.codex_bootstrap.failed": "引导 Codex 配置失败。请查看 CRP 活动记录，修复后再启动代理。",
    "stage.proxy_start.failed": "启动代理失败。请查看 CRP 活动记录后重试。"
  })
});

function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().split(/[.@]/, 1)[0].replaceAll("_", "-").toLowerCase();
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("en")) return "en";
  return null;
}

function cliInputError(messageKey, values = {}) {
  const contract = CLI_ERROR_CONTRACTS.CLI_INPUT_INVALID;
  const error = new CrpError(
    "CLI_INPUT_INVALID",
    contract.message,
    contract.action,
    { status: 400 }
  );
  error.cliMessageKey = messageKey;
  error.cliMessageValues = values;
  return error;
}

function resolveCliLocale(argv, environment) {
  const stripped = [];
  let explicit = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--locale") {
      stripped.push(argv[index]);
      continue;
    }
    if (explicit !== null) throw cliInputError("validation.localeDuplicate");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw cliInputError("validation.localeRequired");
    }
    explicit = value;
    index += 1;
  }
  if (explicit !== null) {
    const locale = normalizeLocale(explicit);
    if (locale === null) throw cliInputError("validation.localeUnsupported");
    return { argv: stripped, locale };
  }
  for (const key of ["CRP_LOCALE", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const locale = normalizeLocale(environment?.[key]);
    if (locale !== null) return { argv: stripped, locale };
  }
  return { argv: stripped, locale: "en" };
}

function cliMessage(locale, key, values = {}) {
  let message = CLI_MESSAGES[locale][key];
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

function safeCommandName(argv) {
  return SAFE_CLI_COMMANDS.has(argv[0]) ? argv[0] : "unknown";
}

function sanitizeCliErrorDetails(details) {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_ERROR_DETAIL_FIELDS.has(key)) continue;
    if (typeof value === "boolean" || value === null
      || (typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value))) {
      safe[key] = value;
    }
  }
  return safe;
}

function projectCliError(error) {
  if (error instanceof CrpError
    && typeof error.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    && typeof error.message === "string" && error.message.length > 0
    && typeof error.action === "string" && error.action.length > 0) {
    const projected = {
      code: error.code,
      message: error.message,
      action: error.action,
      details: sanitizeCliErrorDetails(error.details)
    };
    if (typeof error.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(error.requestId)) {
      projected.requestId = error.requestId;
    }
    return projected;
  }
  return {
    code: "CLI_COMMAND_FAILED",
    ...CLI_ERROR_CONTRACTS.CLI_COMMAND_FAILED,
    details: {}
  };
}

function withCliStage(error, stage) {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "cliStage", { value: stage, configurable: true });
      return error;
    } catch {
      // Fall through to a static wrapper when the original error is not extensible.
    }
  }
  const wrapper = new Error();
  wrapper.cliStage = stage;
  return wrapper;
}

function humanCliError(error, locale) {
  if (["supervisor_start", "codex_bootstrap", "proxy_start"].includes(error?.cliStage)) {
    return cliMessage(locale, `stage.${error.cliStage}.failed`);
  }
  if (error instanceof CrpError && typeof error.cliMessageKey === "string") {
    return cliMessage(locale, error.cliMessageKey, error.cliMessageValues);
  }
  if (error instanceof CrpError) {
    return locale === "en"
      ? cliMessage(locale, "error.public", { message: error.message, action: error.action })
      : cliMessage(locale, "error.public", { code: error.code });
  }
  return cliMessage(locale, "error.commandFailed");
}

function parseCommandLine(argv, locale = "en") {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = argv[0];
  const options = {};

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw cliInputError("validation.unexpectedPositional");
    }
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
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

function printHelp(writeLine = (line) => console.log(line), locale = "en") {
  for (const key of [
    "help.usage",
    "help.check",
    "help.init",
    "help.ui",
    "help.start",
    "help.install",
    "help.capture",
    "help.status",
    "help.stop",
    "help.restart",
    "help.shutdown",
    "help.provider",
    "help.setup",
    "help.guide",
    "help.installCli"
  ]) writeLine(cliMessage(locale, key));
}

function maybePrintJson(options, payload, stdout = (text) => process.stdout.write(text)) {
  if (options.json) {
    stdout(`${JSON.stringify(payload, null, 2)}\n`);
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

function printHumanCheck(data, locale, stdout) {
  const writeLine = (line = "") => stdout(`${line}\n`);
  const value = (key) => cliMessage(locale, key);
  const yesNo = (enabled) => value(enabled ? "common.yes" : "common.no");
  const missing = (candidate) => candidate ?? value("common.missing");
  writeLine(cliMessage(locale, "check.codexConfigPath", { value: data.codexConfigPath }));
  writeLine(cliMessage(locale, "check.authPath", { value: data.authPath }));
  writeLine();
  writeLine(cliMessage(locale, "check.authMode", {
    value: data.auth.authMode || value("common.unknown")
  }));
  writeLine(cliMessage(locale, "check.configured", {
    name: "OPENAI_API_KEY",
    value: yesNo(data.auth.openAiApiKeyConfigured)
  }));
  writeLine(cliMessage(locale, "check.configured", {
    name: "tokens.access_token",
    value: yesNo(data.auth.accessTokenConfigured)
  }));
  writeLine();
  writeLine(cliMessage(locale, "check.section", { name: "model_providers.OpenAI" }));
  writeLine(cliMessage(locale, "check.field", { name: "base_url", value: missing(data.codexOpenAiProvider.baseUrl) }));
  writeLine(cliMessage(locale, "check.field", { name: "wire_api", value: missing(data.codexOpenAiProvider.wireApi) }));
  writeLine(cliMessage(locale, "check.field", {
    name: "requires_openai_auth",
    value: missing(data.codexOpenAiProvider.requiresOpenAiAuth)
  }));
  writeLine();
  writeLine(cliMessage(locale, "check.section", { name: "codex_remote_proxy" }));
  writeLine(cliMessage(locale, "check.field", {
    name: "upstream_base_url",
    value: missing(data.codexRemoteProxy.upstreamBaseUrl)
  }));
  writeLine(cliMessage(locale, "check.field", {
    name: "credential configured",
    value: yesNo(data.codexRemoteProxy.credentialConfigured)
  }));
  writeLine(cliMessage(locale, "check.field", {
    name: "capture_enabled",
    value: missing(data.codexRemoteProxy.captureEnabled)
  }));
  writeLine(cliMessage(locale, "check.field", {
    name: "capture_db_path",
    value: missing(data.codexRemoteProxy.captureDbPath)
  }));
  writeLine();
  writeLine(cliMessage(locale, "check.runtimeStatus"));
  writeLine(cliMessage(locale, "check.node", {
    value: data.runtimeStatus.node.available ? data.runtimeStatus.node.version : data.runtimeStatus.node.error
  }));
  if (data.runtimeStatus.node.available && !data.runtimeStatus.node.dependenciesReady) {
    writeLine(cliMessage(locale, "check.installHint"));
  }
  writeLine();
  writeLine(cliMessage(locale, "check.globalHome", { value: data.globalHome }));
  writeLine(cliMessage(locale, "check.globalCommand", { value: data.globalCommand }));
  writeLine(cliMessage(locale, "check.proxySection", {
    value: data.configSources.codexConfigSectionPresent
      ? data.codexConfigPath
      : value("common.notConfigured")
  }));
  writeLine(cliMessage(locale, "check.savedConfig", {
    value: data.configSources.savedConfigPresent
      ? data.configSources.savedConfigPath
      : value("common.notConfigured")
  }));
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

function checkCommand(options, locale, stdout) {
  const data = buildCheckData(options);
  if (!maybePrintJson(options, data, stdout)) {
    printHumanCheck(data, locale, stdout);
  }
}

function guideCommand(options, locale, stdout) {
  const data = buildGuideData();
  if (!maybePrintJson(options, data, stdout)) {
    stdout(`${cliMessage(locale, "guide.header")}\n`);
    for (const [key, command] of [
      ["guide.add", data.commands.providerAdd],
      ["guide.test", data.commands.providerTest],
      ["guide.activate", data.commands.providerActivate],
      ["guide.start", data.commands.start],
      ["guide.status", data.commands.status],
      ["guide.ui", data.commands.ui],
      ["guide.shutdown", data.commands.shutdown]
    ]) {
      stdout(`${cliMessage(locale, key, { command })}\n`);
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

async function captureCommand(options, action, locale, stdout) {
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
    if (!maybePrintJson(options, payload, stdout)) {
      const yesNo = (enabled) => cliMessage(locale, enabled ? "common.yes" : "common.no");
      stdout(`${cliMessage(locale, "capture.running", { value: yesNo(payload.running) })}\n`);
      stdout(`${cliMessage(locale, "capture.persistedEnabled", {
        value: yesNo(payload.persistedConfig.captureEnabled)
      })}\n`);
      stdout(`${cliMessage(locale, "capture.persistedDb", {
        value: payload.persistedConfig.captureDbPath || DEFAULT_CAPTURE_DB_PATH
      })}\n`);
      if (payload.runtimeConfig) {
        stdout(`${cliMessage(locale, "capture.runtimeEnabled", {
          value: yesNo(payload.runtimeConfig.enabled)
        })}\n`);
        stdout(`${cliMessage(locale, "capture.runtimeDb", {
          value: payload.runtimeConfig.dbPath || DEFAULT_CAPTURE_DB_PATH
        })}\n`);
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
    if (!maybePrintJson(options, payload, stdout)) {
      stdout(`${cliMessage(locale, "capture.savedNextStart")}\n`);
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

  if (!maybePrintJson(options, payload, stdout)) {
    stdout(`${cliMessage(locale, "capture.savedRuntime")}\n`);
  }
}

async function stopCommand(options) {
  const result = stopManagedService(loadManagedState());
  const payload = { ok: true, stopped: result.stopped, reason: result.reason };
  if (!maybePrintJson(options, payload)) {
    console.log(result.stopped ? "Proxy stopped." : "No running proxy to stop.");
  }
}

async function installCliCommand(options, locale, stdout) {
  const result = installCliShim();
  const payload = {
    ok: true,
    shimPath: result.shimPath,
    binDir: BIN_DIR,
    exportCommand: result.exportCommand,
    deprecated: true,
    message: "install-cli is deprecated for public distribution; prefer npm global installation."
  };
  if (!maybePrintJson(options, payload, stdout)) {
    stdout(`${cliMessage(locale, "installCli.installed")}\n`);
    stdout(`${cliMessage(locale, "installCli.prefer")}\n`);
    stdout("npm install -g @cluic/codex-remote-proxy\n");
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

function parseProviderOptions(argv, locale) {
  const action = argv[1];
  if (!["list", "add", "test", "activate", "delete"].includes(action)) {
    throw cliInputError("validation.providerAction");
  }
  const { options } = parseCommandLine(["provider", ...argv.slice(2)], locale);
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
      "model-override"
    ]),
    test: new Set(["json", "id", "model"]),
    activate: new Set(["json", "id"]),
    delete: new Set(["json", "id"])
  }[action];
  if (Object.keys(options).some((field) => !allowed.has(field))) {
    throw cliInputError("validation.providerOption");
  }
  return { action, options };
}

function requiredOption(options, name, locale) {
  const value = options[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw cliInputError("validation.providerRequired", { name });
  }
  return value.trim();
}

async function dispatchProviderCommand(argv, dependencies) {
  const { action, options } = parseProviderOptions(argv, dependencies.locale);
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
      name: requiredOption(options, "name", dependencies.locale),
      baseUrl: requiredOption(options, "base-url", dependencies.locale)
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
      credential: requiredOption(options, "api-key", dependencies.locale)
    };
  } else {
    const id = encodeURIComponent(requiredOption(options, "id", dependencies.locale));
    if (action === "test") {
      method = "POST";
      path = `/providers/${id}/test`;
      body = { model: requiredOption(options, "model", dependencies.locale) };
    } else if (action === "activate") {
      method = "POST";
      path = `/providers/${id}/activate`;
    } else {
      method = "DELETE";
      path = `/providers/${id}`;
    }
  }
  const context = await dependencies.ensureSupervisorImpl({
    paths: dependencies.paths,
    adminPort: dependencies.adminPort
  });
  const result = await context.client.request(method, path, body);
  writePayload(options, {
    ok: true,
    action,
    ...result
  }, dependencies.stdout, cliMessage(dependencies.locale, `provider.${action}.completed`));
}

function parseSupervisorOptions(argv, locale) {
  const { command, options } = parseCommandLine(argv, locale);
  const allowed = {
    init: new Set(["json", "no-open"]),
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
    throw cliInputError("validation.commandOption", { command });
  }
  return { command, options };
}

function parseCaptureOptions(argv, locale) {
  const action = argv[1];
  if (!["on", "off", "status"].includes(action)) {
    throw cliInputError("validation.captureAction");
  }
  const { options } = parseCommandLine(["capture", ...argv.slice(2)], locale);
  if (Object.keys(options).some((field) => field !== "json")) {
    throw cliInputError("validation.captureOption");
  }
  return { action, options };
}

async function dispatchSupervisorCommand(argv, dependencies) {
  const supervisorCommands = new Set([
    "init",
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
  const { command, options } = parseSupervisorOptions(argv, dependencies.locale);
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

  if (command === "ui" || command === "init") {
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
    }, stdout, opened ? cliMessage(dependencies.locale, "ui.opened") : url);
    return true;
  }

  if (command === "status") {
    const context = await discoverSupervisorImpl(discoveryOptions);
    const payload = context === null
      ? { ok: true, running: false, reason: "supervisor_not_running" }
      : { ok: true, running: true, ...context.status };
    writePayload(options, payload, stdout, payload.running
      ? cliMessage(dependencies.locale, "status.running")
      : cliMessage(dependencies.locale, "status.notRunning"));
    return true;
  }

  if (command === "stop") {
    const context = await discoverSupervisorImpl(discoveryOptions);
    if (context === null) {
      writePayload(options, {
        ok: true,
        stopped: false,
        reason: "supervisor_not_running"
      }, stdout, cliMessage(dependencies.locale, "stop.notRunning"));
      return true;
    }
    const result = await context.client.request("POST", "/proxy/stop");
    const payload = {
      ok: true,
      stopped: result?.worker?.phase === "stopped",
      worker: result?.worker ?? null
    };
    writePayload(options, payload, stdout, cliMessage(dependencies.locale, "stop.completed"));
    return true;
  }

  if (command === "shutdown") {
    const context = await discoverSupervisorImpl(discoveryOptions);
    if (context === null) {
      writePayload(options, {
        ok: true,
        shutdown: false,
        reason: "supervisor_not_running"
      }, stdout, cliMessage(dependencies.locale, "shutdown.notRunning"));
      return true;
    }
    const latest = await context.client.request("GET", "/status");
    const supervisorPid = context.state.supervisorPid;
    if (latest?.supervisor?.pid !== supervisorPid
      || latest?.supervisor?.startedAt !== context.state.startedAt) {
      throw new Error(cliMessage(dependencies.locale, "shutdown.identityChanged"));
    }
    killProcess(supervisorPid, "SIGTERM");
    const deadline = now() + shutdownTimeoutMs;
    while ((isProcessAliveImpl(supervisorPid) || existsSync(paths.statePath)) && now() < deadline) {
      await wait(Math.min(100, deadline - now()));
    }
    if (isProcessAliveImpl(supervisorPid)) {
      throw new Error(cliMessage(dependencies.locale, "shutdown.timeout"));
    }
    if (existsSync(paths.statePath)) {
      throw new Error(cliMessage(dependencies.locale, "shutdown.stateTimeout"));
    }
    writePayload(options, {
      ok: true,
      shutdown: true,
      supervisorPid,
      workerStopped: true
    }, stdout, cliMessage(dependencies.locale, "shutdown.completed"));
    return true;
  }

  let context;
  try {
    context = await ensureSupervisorImpl(discoveryOptions);
  } catch (error) {
    if (command === "start" || command === "install" || command === "setup") {
      throw withCliStage(error, "supervisor_start");
    }
    throw error;
  }
  if (command === "restart") {
    const result = await context.client.request("POST", "/proxy/restart");
    writePayload(options, {
      ok: true,
      command: "restart",
      supervisorPid: context.state.supervisorPid,
      worker: result?.worker ?? null
    }, stdout, cliMessage(dependencies.locale, "restart.completed"));
    return true;
  }

  let codexBootstrap = null;
  if (context.status?.codex?.configured !== true) {
    try {
      const bootstrap = await context.client.request("POST", "/codex/bootstrap");
      codexBootstrap = bootstrap?.result ?? null;
    } catch (error) {
      throw withCliStage(error, "codex_bootstrap");
    }
  }
  let result;
  try {
    result = await context.client.request("POST", "/proxy/start");
  } catch (error) {
    throw withCliStage(error, "proxy_start");
  }
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
  writePayload(options, payload, stdout, cliMessage(dependencies.locale, "start.ready"));
  return true;
}

async function main(argv = process.argv.slice(2), {
  locale = "en",
  stdout = (text) => process.stdout.write(text)
} = {}) {
  if (argv[0] === "capture") {
    const { action, options } = parseCaptureOptions(argv, locale);
    return await captureCommand(options, action, locale, stdout);
  }

  const { command, options } = parseCommandLine(argv, locale);
  if (command === "check") return checkCommand(options, locale, stdout);
  if (command === "guide") return guideCommand(options, locale, stdout);
  if (command === "start" || command === "install" || command === "setup") return await startCommandAction(options);
  if (command === "status") return await statusCommand(options);
  if (command === "stop") return await stopCommand(options);
  if (command === "install-cli") return await installCliCommand(options, locale, stdout);
  throw new Error("Unknown command.");
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
  shutdownTimeoutMs = 8_000,
  environment = process.env
} = {}) {
  let locale = "en";
  const jsonIntent = argv.includes("--json");
  let commandName = safeCommandName(argv);
  try {
    const resolved = resolveCliLocale(argv, environment);
    argv = resolved.argv;
    locale = resolved.locale;
    commandName = safeCommandName(argv);
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      printHelp((line) => stdout(`${line}\n`), locale);
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
      openManagementUrlImpl,
      locale
    });
    if (!handled) await main(argv, { locale, stdout });
    return 0;
  } catch (error) {
    if (jsonIntent) {
      stderr(`${JSON.stringify({
        ok: false,
        command: commandName,
        stage: ["supervisor_start", "codex_bootstrap", "proxy_start"].includes(error?.cliStage)
          ? error.cliStage
          : null,
        error: projectCliError(error)
      }, null, 2)}\n`);
    } else {
      stderr(`${cliMessage(locale, "error.prefix", {
        message: humanCliError(error, locale)
      })}\n`);
    }
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
