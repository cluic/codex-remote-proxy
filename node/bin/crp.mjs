#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
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
  readSupervisorState,
  readSupervisorStateSnapshot,
  removeStaleSupervisorState
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
const HELP_FLAGS = new Set(["-h", "--help"]);
const PROVIDER_ACTIONS = new Set(["list", "add", "models", "test", "activate", "delete"]);
const SAFE_CLI_COMMANDS = new Set([
  "ui", "start", "status", "stop", "restart", "shutdown",
  "provider", "check", "capture", "guide", "install-cli"
]);
const REMOVED_CLI_COMMANDS = new Map([
  ["init", "crp ui"],
  ["install", "crp start"],
  ["setup", "crp start"]
]);
const SAFE_ERROR_DETAIL_FIELDS = new Set([
  "field", "reason", "committed", "degraded", "pending", "generation", "httpStatus",
  "forced", "graceful", "processStopped", "stateRemoved"
]);
const SHUTDOWN_FORCE_FALLBACK_CODES = new Set([
  "API_METHOD_NOT_ALLOWED",
  "API_NOT_FOUND",
  "SUPERVISOR_SHUTDOWN_UNAVAILABLE",
  "SUPERVISOR_UNAVAILABLE"
]);
const CODEX_BOOTSTRAP_REQUEST_TIMEOUT_MS = 300_000;
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
    "help.rootSyntax": "  crp <command> [options]",
    "help.commands": "Commands:",
    "help.examples": "Examples:",
    "help.recommended": "Recommended commands:",
    "help.providerCommands": "Provider commands:",
    "help.otherCommands": "Other commands:",
    "help.options": "Options:",
    "help.option.json": "  --json                 Write the stable machine-readable response.",
    "help.option.noOpen": "  --no-open              Start management without opening a browser.",
    "help.option.locale": "  --locale <en|zh-CN>    Select human output language for this process.",
    "help.option.help": "  -h, --help              Show help without starting CRP.",
    "help.option.provider.name": "  --name <NAME>          Select a provider by its unique name.",
    "help.option.provider.id": "  --id <ID>              Select a provider by its stable ID.",
    "help.option.provider.baseUrl": "  --base-url <URL>       Provider API base URL, normally ending in /v1.",
    "help.option.provider.apiKey": "  --api-key <KEY>        Write-only provider credential.",
    "help.option.provider.model": "  --model <MODEL>        Model used for the compatibility test.",
    "help.option.provider.authHeader": "  --auth-header <NAME>  Authentication header name (default: authorization).",
    "help.option.provider.authScheme": "  --auth-scheme <TOKEN> Authentication scheme (default: Bearer).",
    "help.option.provider.modelMode": "  --model-mode <MODE>    Routing mode: passthrough or override.",
    "help.option.provider.modelOverride": "  --model-override <ID> Model sent upstream when override mode is used.",
    "help.hint": "Run `crp <command> --help` for command-specific help.",
    "help.check": "  crp check [--json] [--codex-config PATH] [--auth PATH]",
    "help.ui": "  crp ui [--no-open] [--json]",
    "help.start": "  crp start [--json]",
    "help.capture": "  crp capture <on|off|status> [--json]",
    "help.status": "  crp status [--json]",
    "help.stop": "  crp stop [--json]",
    "help.restart": "  crp restart [--json]",
    "help.shutdown": "  crp shutdown [--json]",
    "help.provider": "  crp provider <command> [options]",
    "help.guide": "  crp guide [--json]",
    "help.installCli": "  crp install-cli [--json]",
    "help.description.check": "Inspect local Codex and legacy CRP configuration.",
    "help.description.ui": "Start the Supervisor if needed and open the local management UI.",
    "help.description.start": "Ensure the Supervisor is running, bootstrap Codex if needed, and start the proxy Worker.",
    "help.description.capture": "Inspect or change the legacy capture preference.",
    "help.description.status": "Show Supervisor, Worker, active-provider, Codex, and proxy status.",
    "help.description.stop": "Stop the proxy Worker while the Supervisor and management UI remain running.",
    "help.description.restart": "Drain and replace the proxy Worker while keeping the Supervisor running.",
    "help.description.shutdown": "Stop the proxy Worker and Supervisor completely.",
    "help.description.provider": "Provider commands manage named upstream profiles.",
    "help.description.guide": "Show the recommended provider and lifecycle flow.",
    "help.description.installCli": "Install the deprecated local command shim.",
    "help.provider.list": "  crp provider list [--json]",
    "help.provider.add": "  crp provider add --name <NAME> --base-url <URL> --api-key <KEY> [--model <MODEL>] [--json]",
    "help.provider.models": "  crp provider models (--id <ID> | --name <NAME>) [--json]",
    "help.provider.test": "  crp provider test (--id <ID> | --name <NAME>) --model <MODEL> [--json]",
    "help.provider.activate": "  crp provider activate (--id <ID> | --name <NAME>) [--json]",
    "help.provider.delete": "  crp provider delete (--id <ID> | --name <NAME>) [--json]",
    "help.provider.addAdvanced": "  --model runs a compatibility test after saving. Routing override: --model-mode, --model-override. Authentication: --auth-header, --auth-scheme.",
    "help.provider.description.list": "List configured providers and their non-secret status.",
    "help.provider.description.add": "Add a named provider profile and write its credential.",
    "help.provider.description.models": "Refresh and list available models for one provider.",
    "help.provider.description.test": "Test Responses API compatibility for one provider.",
    "help.provider.description.activate": "Make a tested provider the active provider for new requests.",
    "help.provider.description.delete": "Delete an inactive provider and its saved credential.",
    "help.example.providerAdd": "  crp provider add --name Primary --base-url https://api.example/v1 --api-key <KEY> --model <MODEL>",
    "help.example.providerModels": "  crp provider models --name Primary",
    "help.example.providerList": "  crp provider list",
    "help.example.providerTest": "  crp provider test --name Primary --model <MODEL>",
    "help.example.providerActivate": "  crp provider activate --name Backup",
    "help.example.providerDelete": "  crp provider delete --name Retired",
    "help.example.status": "  crp status",
    "validation.unexpectedPositional": "Unexpected positional argument.",
    "validation.providerAction": "Unknown provider action.",
    "validation.providerOption": "The provider command contains an unsupported option.",
    "validation.providerRequired": "The provider {name} option is required.",
    "validation.providerSelector": "Provide exactly one of --id or --name.",
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
    "guide.add": "  Add and test a provider with `{command}`; the first successful provider is selected automatically.",
    "guide.models": "  Refresh its model cache with `{command}`.",
    "guide.test": "  Retest a saved provider with `{command}`.",
    "guide.activate": "  Switch to another tested provider with `{command}`.",
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
    "status.header": "CRP status:",
    "status.supervisor": "Supervisor: {state}",
    "status.worker": "Worker: {state}",
    "status.pid": "  PID: {value}",
    "status.startedAt": "  Started at: {value}",
    "status.generation": "  Generation: {value}",
    "status.listening": "  Listening: {value}",
    "status.inFlight": "  In flight: {value}",
    "status.activeProvider": "Active provider: {name} ({id})",
    "status.activeProviderNone": "Active provider: none",
    "status.codex": "Codex: {state}",
    "status.historyRepairPending": "History repair pending: {value}",
    "status.modelProvider": "Model provider: {value}",
    "status.proxyUrl": "Proxy URL: {value}",
    "status.state.running": "running",
    "status.state.stopped": "stopped",
    "status.state.starting": "starting",
    "status.state.draining": "draining",
    "status.state.failed": "failed",
    "status.state.crashed": "crashed",
    "status.state.backoff": "waiting to retry",
    "status.state.configured": "configured",
    "status.state.notConfigured": "not configured",
    "provider.add.completed": "Provider add completed.",
    "provider.add.testPassed": "Automatic compatibility test passed.",
    "provider.add.testFailed": "Provider saved, but the automatic test failed ({code}).",
    "provider.test.initialSelected": "This is the first tested provider, so it is now selected. Run `crp start` to start the proxy Worker.",
    "provider.activate.completed": "Provider activate completed.",
    "provider.delete.completed": "Provider delete completed.",
    "provider.list.completed": "Provider list completed.",
    "provider.test.completed": "Provider test completed.",
    "provider.models.completed": "Provider model discovery completed.",
    "provider.models.header": "Models for {name} ({id}) ({count}):",
    "provider.models.empty": "No models were returned by this provider.",
    "provider.models.item": "- {model}",
    "provider.models.more": "... and {count} more models",
    "provider.list.header": "Providers ({count}):",
    "provider.list.empty": "No providers configured.",
    "provider.list.active": "* {name} (active)",
    "provider.list.inactive": "- {name}",
    "provider.list.id": "  ID: {value}",
    "provider.list.baseUrl": "  Base URL: {value}",
    "provider.list.test": "  Test: {value}",
    "provider.list.model": "  Model: {value}",
    "provider.list.credential": "  Credential: {value}",
    "provider.test.untested": "untested",
    "provider.test.passed": "passed",
    "provider.test.failed": "failed",
    "provider.test.failedCode": "failed ({code})",
    "provider.model.passthrough": "passthrough",
    "provider.model.override": "override -> {model}",
    "provider.credential.configured": "configured",
    "provider.credential.notConfigured": "not configured",
    "command.removed": "The `{command}` command has been removed. Use `{replacement}` instead.",
    "start.ready": "Codex Remote Proxy is ready.",
    "start.historyRepairEncryptedWarning": "Warning: Some historical sessions contain encrypted content. Their provider metadata was repaired, but some messages may remain unavailable.",
    "status.notRunning": "CRP supervisor is not running.",
    "stop.notRunning": "No running proxy worker to stop.",
    "stop.completed": "Proxy worker stopped. CRP Supervisor is still running; use `crp shutdown` to stop it.",
    "restart.completed": "Proxy worker restarted.",
    "shutdown.notRunning": "CRP supervisor is not running.",
    "shutdown.notRunningStaleRemoved": "CRP supervisor is not running. Stale local state was safely removed.",
    "shutdown.identityChanged": "Supervisor identity changed; shutdown was cancelled.",
    "shutdown.timeout": "The supervisor did not stop in time.",
    "shutdown.stateTimeout": "The supervisor state was not cleaned up in time.",
    "shutdown.unavailable": "The supervisor could not be reached for a safe shutdown.",
    "shutdown.completed": "CRP Supervisor and proxy Worker stopped.",
    "shutdown.forcedCompleted": "CRP Supervisor and proxy Worker stopped using the forced fallback.",
    "shutdown.degradedCompleted": "CRP stopped, and stale local state was safely recovered.",
    "stage.supervisor_start.failed": "Supervisor startup failed. Review the supervisor log and try again.",
    "stage.codex_bootstrap.failed": "Codex configuration bootstrap failed. Review CRP activity and retry before starting the proxy.",
    "stage.proxy_start.failed": "Proxy startup failed. Review CRP activity and try again."
  }),
  "zh-CN": Object.freeze({
    "error.prefix": "错误：{message}",
    "error.commandFailed": "CRP 无法完成该命令。请查看 CRP 活动记录后重试。",
    "error.public": "命令失败（{code}）。请查看 CRP 活动记录后重试。",
    "help.usage": "用法：",
    "help.rootSyntax": "  crp <命令> [选项]",
    "help.commands": "命令：",
    "help.examples": "示例：",
    "help.recommended": "推荐命令：",
    "help.providerCommands": "提供商命令：",
    "help.otherCommands": "其他命令：",
    "help.options": "选项：",
    "help.option.json": "  --json                 输出稳定的机器可读响应。",
    "help.option.noOpen": "  --no-open              启动管理服务但不打开浏览器。",
    "help.option.locale": "  --locale <en|zh-CN>    选择当前进程的人类可读输出语言。",
    "help.option.help": "  -h, --help              显示帮助且不启动 CRP。",
    "help.option.provider.name": "  --name <NAME>          按唯一名称选择提供商。",
    "help.option.provider.id": "  --id <ID>              按稳定 ID 选择提供商。",
    "help.option.provider.baseUrl": "  --base-url <URL>       提供商 API 基础地址，通常以 /v1 结尾。",
    "help.option.provider.apiKey": "  --api-key <KEY>        只写的提供商凭据。",
    "help.option.provider.model": "  --model <MODEL>        用于兼容性测试的模型。",
    "help.option.provider.authHeader": "  --auth-header <NAME>  认证请求头名称（默认：authorization）。",
    "help.option.provider.authScheme": "  --auth-scheme <TOKEN> 认证方案（默认：Bearer）。",
    "help.option.provider.modelMode": "  --model-mode <MODE>    路由模式：passthrough 或 override。",
    "help.option.provider.modelOverride": "  --model-override <ID> override 模式下发送给上游的模型。",
    "help.hint": "运行 `crp <命令> --help` 查看命令专用帮助。",
    "help.check": "  crp check [--json] [--codex-config PATH] [--auth PATH]",
    "help.ui": "  crp ui [--no-open] [--json]",
    "help.start": "  crp start [--json]",
    "help.capture": "  crp capture <on|off|status> [--json]",
    "help.status": "  crp status [--json]",
    "help.stop": "  crp stop [--json]",
    "help.restart": "  crp restart [--json]",
    "help.shutdown": "  crp shutdown [--json]",
    "help.provider": "  crp provider <command> [options]",
    "help.guide": "  crp guide [--json]",
    "help.installCli": "  crp install-cli [--json]",
    "help.description.check": "检查本地 Codex 和旧版 CRP 配置。",
    "help.description.ui": "按需启动监督进程并打开本地管理页面。",
    "help.description.start": "确保监督进程运行，按需引导 Codex 配置，然后启动代理工作进程。",
    "help.description.capture": "检查或修改旧版抓取偏好。",
    "help.description.status": "显示监督进程、工作进程、当前提供商、Codex 和代理状态。",
    "help.description.stop": "停止代理工作进程，监督进程和管理页面继续运行。",
    "help.description.restart": "排空并替换代理工作进程，同时保持监督进程运行。",
    "help.description.shutdown": "完全停止代理工作进程和监督进程。",
    "help.description.provider": "提供商命令用于管理具名上游配置。",
    "help.description.guide": "显示推荐的提供商和生命周期流程。",
    "help.description.installCli": "安装已弃用的本地命令入口。",
    "help.provider.list": "  crp provider list [--json]",
    "help.provider.add": "  crp provider add --name <NAME> --base-url <URL> --api-key <KEY> [--model <MODEL>] [--json]",
    "help.provider.models": "  crp provider models (--id <ID> | --name <NAME>) [--json]",
    "help.provider.test": "  crp provider test (--id <ID> | --name <NAME>) --model <MODEL> [--json]",
    "help.provider.activate": "  crp provider activate (--id <ID> | --name <NAME>) [--json]",
    "help.provider.delete": "  crp provider delete (--id <ID> | --name <NAME>) [--json]",
    "help.provider.addAdvanced": "  --model 会在保存后执行兼容性测试。路由覆盖：--model-mode、--model-override。认证：--auth-header、--auth-scheme。",
    "help.provider.description.list": "列出已配置的提供商及其非敏感状态。",
    "help.provider.description.add": "添加具名提供商配置并写入凭据。",
    "help.provider.description.models": "刷新并列出一个提供商的可用模型。",
    "help.provider.description.test": "测试一个提供商的 Responses API 兼容性。",
    "help.provider.description.activate": "将已测试的提供商设为新请求的当前提供商。",
    "help.provider.description.delete": "删除一个未激活的提供商及其已保存凭据。",
    "help.example.providerAdd": "  crp provider add --name Primary --base-url https://api.example/v1 --api-key <KEY> --model <MODEL>",
    "help.example.providerModels": "  crp provider models --name Primary",
    "help.example.providerList": "  crp provider list",
    "help.example.providerTest": "  crp provider test --name Primary --model <MODEL>",
    "help.example.providerActivate": "  crp provider activate --name Backup",
    "help.example.providerDelete": "  crp provider delete --name Retired",
    "help.example.status": "  crp status",
    "validation.unexpectedPositional": "出现了意外的位置参数。",
    "validation.providerAction": "未知的提供商操作。",
    "validation.providerOption": "提供商命令包含不支持的选项。",
    "validation.providerRequired": "提供商选项 {name} 为必填项。",
    "validation.providerSelector": "必须且只能提供 --id 或 --name 其中一个选项。",
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
    "guide.add": "  使用 `{command}` 添加并测试提供商；首个测试成功的提供商会被自动选中。",
    "guide.models": "  使用 `{command}` 刷新其模型缓存。",
    "guide.test": "  使用 `{command}` 重新测试已保存的提供商。",
    "guide.activate": "  使用 `{command}` 切换到另一个已测试的提供商。",
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
    "status.header": "CRP 状态：",
    "status.supervisor": "监督进程：{state}",
    "status.worker": "工作进程：{state}",
    "status.pid": "  PID：{value}",
    "status.startedAt": "  启动时间：{value}",
    "status.generation": "  代次：{value}",
    "status.listening": "  正在监听：{value}",
    "status.inFlight": "  处理中：{value}",
    "status.activeProvider": "当前提供商：{name}（{id}）",
    "status.activeProviderNone": "当前提供商：无",
    "status.codex": "Codex：{state}",
    "status.historyRepairPending": "历史会话修复待完成：{value}",
    "status.modelProvider": "模型提供商：{value}",
    "status.proxyUrl": "代理地址：{value}",
    "status.state.running": "运行中",
    "status.state.stopped": "已停止",
    "status.state.starting": "启动中",
    "status.state.draining": "正在排空",
    "status.state.failed": "失败",
    "status.state.crashed": "已崩溃",
    "status.state.backoff": "等待重试",
    "status.state.configured": "已配置",
    "status.state.notConfigured": "未配置",
    "provider.add.completed": "提供商添加操作已完成。",
    "provider.add.testPassed": "自动兼容性测试已通过。",
    "provider.add.testFailed": "提供商已保存，但自动测试失败（{code}）。",
    "provider.test.initialSelected": "这是首个测试通过的提供商，现已自动选中。运行 `crp start` 启动代理工作进程。",
    "provider.activate.completed": "提供商激活操作已完成。",
    "provider.delete.completed": "提供商删除操作已完成。",
    "provider.list.completed": "提供商列表操作已完成。",
    "provider.test.completed": "提供商测试操作已完成。",
    "provider.models.completed": "提供商模型发现操作已完成。",
    "provider.models.header": "{name}（{id}）可用模型（{count}）：",
    "provider.models.empty": "该提供商未返回模型。",
    "provider.models.item": "- {model}",
    "provider.models.more": "……另有 {count} 个模型",
    "provider.list.header": "提供商（{count}）：",
    "provider.list.empty": "尚未配置提供商。",
    "provider.list.active": "* {name}（当前）",
    "provider.list.inactive": "- {name}",
    "provider.list.id": "  ID：{value}",
    "provider.list.baseUrl": "  基础地址：{value}",
    "provider.list.test": "  测试：{value}",
    "provider.list.model": "  模型：{value}",
    "provider.list.credential": "  凭据：{value}",
    "provider.test.untested": "未测试",
    "provider.test.passed": "已通过",
    "provider.test.failed": "失败",
    "provider.test.failedCode": "失败（{code}）",
    "provider.model.passthrough": "透传",
    "provider.model.override": "覆盖为 {model}",
    "provider.credential.configured": "已配置",
    "provider.credential.notConfigured": "未配置",
    "command.removed": "`{command}` 命令已移除。请改用 `{replacement}`。",
    "start.ready": "Codex Remote Proxy 已就绪。",
    "start.historyRepairEncryptedWarning": "警告：部分历史会话包含加密内容。提供商元数据已修复，但部分消息可能仍不可用。",
    "status.notRunning": "CRP 监督进程未运行。",
    "stop.notRunning": "没有正在运行的代理工作进程可停止。",
    "stop.completed": "代理工作进程已停止。CRP 监督进程仍在运行；如需停止，请使用 `crp shutdown`。",
    "restart.completed": "代理工作进程已重启。",
    "shutdown.notRunning": "CRP 监督进程未运行。",
    "shutdown.notRunningStaleRemoved": "CRP 监督进程未运行，残留的本地状态已安全清理。",
    "shutdown.identityChanged": "监督进程身份已变化，已取消关闭操作。",
    "shutdown.timeout": "监督进程未能及时停止。",
    "shutdown.stateTimeout": "监督进程状态未能及时清理。",
    "shutdown.unavailable": "无法连接监督进程以安全关闭。",
    "shutdown.completed": "CRP 监督进程和代理工作进程已停止。",
    "shutdown.forcedCompleted": "CRP 监督进程和代理工作进程已通过强制回退停止。",
    "shutdown.degradedCompleted": "CRP 已停止，残留的本地状态已安全恢复。",
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

function resolveCliLocale(argv) {
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
    return { argv: stripped, locale, explicit: true };
  }
  return { argv: stripped, locale: "en", explicit: false };
}

function cliMessage(locale, key, values = {}) {
  let message = CLI_MESSAGES[locale][key];
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, () => String(value));
  }
  return message;
}

function safeCommandName(argv) {
  return SAFE_CLI_COMMANDS.has(argv[0]) || REMOVED_CLI_COMMANDS.has(argv[0])
    ? argv[0]
    : "unknown";
}

function removedCommandError(command, replacement) {
  const error = new CrpError(
    "CLI_COMMAND_REMOVED",
    "This CLI command has been removed.",
    `Use \`${replacement}\` instead.`,
    { status: 400 }
  );
  error.cliMessageKey = "command.removed";
  error.cliMessageValues = { command: `crp ${command}`, replacement };
  return error;
}

function shutdownCliError(code, messageKey, {
  status = 500,
  details = {},
  cause
} = {}) {
  const contracts = {
    SUPERVISOR_IDENTITY_CHANGED: [
      "The local supervisor identity changed.",
      "Refresh CRP status and retry against the current supervisor."
    ],
    SUPERVISOR_SHUTDOWN_TIMEOUT: [
      "The local supervisor did not stop in time.",
      "Review CRP status and Activity before retrying shutdown."
    ],
    SUPERVISOR_STATE_CLEANUP_FAILED: [
      "The local supervisor stopped, but its state could not be cleaned up safely.",
      "Do not remove unrelated files; review CRP Activity and retry shutdown."
    ],
    SUPERVISOR_SHUTDOWN_UNAVAILABLE: [
      "The local supervisor could not be reached for a safe shutdown.",
      "Retry shutdown while the current supervisor is still running."
    ],
    SUPERVISOR_SHUTDOWN_RESPONSE_INVALID: [
      "The local supervisor returned an invalid shutdown response.",
      "Review CRP Activity and retry shutdown."
    ]
  };
  const [message, action] = contracts[code] ?? contracts.SUPERVISOR_SHUTDOWN_UNAVAILABLE;
  const error = new CrpError(code, message, action, { status, details, cause });
  error.cliMessageKey = messageKey;
  return error;
}

function sameSupervisorIdentity(left, right) {
  if (!left || !right
    || left.supervisorPid !== right.supervisorPid
    || left.startedAt !== right.startedAt) {
    return false;
  }
  const leftAdmin = left.admin;
  const rightAdmin = right.admin;
  return leftAdmin !== null && typeof leftAdmin === "object"
    && rightAdmin !== null && typeof rightAdmin === "object"
    && ["host", "port", "authority", "origin"].every(
      (field) => leftAdmin[field] === rightAdmin[field]
    );
}

function validShutdownAcceptance(payload, expected) {
  const shutdown = payload?.shutdown;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && Object.keys(payload).length === 1
    && shutdown !== null && typeof shutdown === "object" && !Array.isArray(shutdown)
    && Object.keys(shutdown).length === 3
    && shutdown.accepted === true
    && shutdown.supervisorPid === expected.supervisorPid
    && shutdown.startedAt === expected.startedAt;
}

function shutdownIdentityError() {
  return shutdownCliError("SUPERVISOR_IDENTITY_CHANGED", "shutdown.identityChanged", {
    status: 409
  });
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

function printHelpKeys(keys, writeLine, locale) {
  for (const key of keys) writeLine(cliMessage(locale, key));
}

function printHelp(writeLine = (line) => console.log(line), locale = "en") {
  printHelpKeys([
    "help.usage",
    "help.rootSyntax",
    "help.commands",
    "help.ui",
    "help.description.ui",
    "help.start",
    "help.description.start",
    "help.status",
    "help.description.status",
    "help.stop",
    "help.description.stop",
    "help.restart",
    "help.description.restart",
    "help.shutdown",
    "help.description.shutdown",
    "help.provider",
    "help.description.provider",
    "help.check",
    "help.description.check",
    "help.capture",
    "help.description.capture",
    "help.guide",
    "help.description.guide",
    "help.installCli",
    "help.description.installCli",
    "help.options",
    "help.option.json",
    "help.option.locale",
    "help.option.help",
    "help.examples",
    "help.example.providerAdd",
    "help.example.status",
    "help.hint"
  ], writeLine, locale);
}

function resolveHelpRequest(argv) {
  if (argv.length === 0
    || (argv.length === 1 && HELP_FLAGS.has(argv[0]))) return { type: "root" };
  if (argv.length === 2 && HELP_FLAGS.has(argv[1]) && SAFE_CLI_COMMANDS.has(argv[0])) {
    return argv[0] === "provider"
      ? { type: "provider" }
      : { type: "command", command: argv[0] };
  }
  if (argv.length === 3 && argv[0] === "provider"
    && PROVIDER_ACTIONS.has(argv[1]) && HELP_FLAGS.has(argv[2])) {
    return { type: "providerAction", action: argv[1] };
  }
  if (argv.length === 3 && argv[0] === "capture"
    && ["on", "off", "status"].includes(argv[1]) && HELP_FLAGS.has(argv[2])) {
    return { type: "command", command: "capture" };
  }
  return null;
}

function printCommandHelp(command, writeLine, locale) {
  const keys = [
    "help.usage",
    `help.${command === "install-cli" ? "installCli" : command}`,
    `help.description.${command === "install-cli" ? "installCli" : command}`,
    "help.options"
  ];
  if (command === "ui") keys.push("help.option.noOpen");
  keys.push("help.option.json", "help.option.locale", "help.option.help");
  keys.push("help.examples", `help.${command === "install-cli" ? "installCli" : command}`);
  printHelpKeys(keys, writeLine, locale);
}

function printProviderHelp(writeLine, locale) {
  printHelpKeys([
    "help.usage",
    "help.provider",
    "help.description.provider",
    "help.commands",
    "help.provider.list",
    "help.provider.add",
    "help.provider.models",
    "help.provider.test",
    "help.provider.activate",
    "help.provider.delete",
    "help.options",
    "help.option.locale",
    "help.option.help",
    "help.examples",
    "help.example.providerAdd",
    "help.example.providerModels"
  ], writeLine, locale);
}

function printProviderActionHelp(action, writeLine, locale) {
  const keys = [
    "help.usage",
    `help.provider.${action}`,
    `help.provider.description.${action}`
  ];
  if (action === "add") keys.push("help.provider.addAdvanced");
  keys.push("help.options");
  if (["models", "test", "activate", "delete"].includes(action)) {
    keys.push("help.option.provider.name", "help.option.provider.id");
  }
  if (action === "add") {
    keys.push(
      "help.option.provider.name",
      "help.option.provider.baseUrl",
      "help.option.provider.apiKey",
      "help.option.provider.model",
      "help.option.provider.authHeader",
      "help.option.provider.authScheme",
      "help.option.provider.modelMode",
      "help.option.provider.modelOverride"
    );
  } else if (action === "test") {
    keys.push("help.option.provider.model");
  }
  keys.push("help.option.json", "help.option.locale", "help.option.help", "help.examples");
  keys.push({
    list: "help.example.providerList",
    add: "help.example.providerAdd",
    models: "help.example.providerModels",
    test: "help.example.providerTest",
    activate: "help.example.providerActivate",
    delete: "help.example.providerDelete"
  }[action]);
  printHelpKeys(keys, writeLine, locale);
}

function printResolvedHelp(request, writeLine, locale) {
  if (request.type === "root") {
    printHelp(writeLine, locale);
  } else if (request.type === "provider") {
    printProviderHelp(writeLine, locale);
  } else if (request.type === "providerAction") {
    printProviderActionHelp(request.action, writeLine, locale);
  } else {
    printCommandHelp(request.command, writeLine, locale);
  }
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
      providerAdd: "crp provider add --name <NAME> --base-url <URL> --api-key <KEY> --model <MODEL> --json",
      providerModels: "crp provider models --name <NAME> --json",
      providerTest: "crp provider test --name <NAME> --model <MODEL> --json",
      providerActivate: "crp provider activate --name <NAME> --json",
      start: "crp start --json",
      status: "crp status --json",
      ui: "crp ui --json",
      stop: "crp stop --json",
      shutdown: "crp shutdown --json",
      installCli: "npm install -g @cluic/codex-remote-proxy",
      runWithoutInstall: "npx @cluic/codex-remote-proxy guide --json"
    },
    expectedFlow: [
      "Add and test a provider with `crp provider add --name <NAME> --base-url <URL> --api-key <KEY> --model <MODEL> --json`; the first successful provider is selected automatically.",
      "Start the proxy through the supervisor with `crp start --json`.",
      "Confirm supervisor and worker health with `crp status --json`.",
      "Open the local management UI with `crp ui --json`.",
      "When finished, stop the supervisor with `crp shutdown --json`."
    ],
    notes: [
      "Use `crp provider models --name <NAME> --json` to refresh the provider model cache.",
      "Use provider test to retest a saved provider and provider activate to switch to another tested provider.",
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
  const { backupPath } = await bootstrapCodexConfig({ configPath: codexConfigPath, proxyUrl });

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
      ["guide.models", data.commands.providerModels],
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

function writeHumanProviderAdd(result, locale, stdout) {
  const lines = [cliMessage(locale, "provider.add.completed")];
  if (result?.test?.ok === true) {
    lines.push(cliMessage(locale, "provider.add.testPassed"));
  } else if (result?.test?.ok === false) {
    const code = typeof result.test.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(result.test.code)
      ? result.test.code
      : cliMessage(locale, "common.unknown");
    lines.push(cliMessage(locale, "provider.add.testFailed", { code }));
  }
  if (result?.initialActivation?.automatic === true) {
    lines.push(cliMessage(locale, "provider.test.initialSelected"));
  }
  stdout(`${lines.join("\n")}\n`);
}

function writeHumanProviderTestResult(result, locale, stdout) {
  const lines = [cliMessage(locale, "provider.test.completed")];
  if (result?.result?.ok === true) {
    lines.push(cliMessage(locale, "provider.test.passed"));
  } else {
    const code = typeof result?.result?.code === "string"
      && /^[A-Z][A-Z0-9_]{0,127}$/.test(result.result.code)
      ? result.result.code
      : cliMessage(locale, "common.unknown");
    lines.push(cliMessage(locale, "provider.test.failedCode", { code }));
  }
  if (result?.result?.initialActivation?.automatic === true) {
    lines.push(cliMessage(locale, "provider.test.initialSelected"));
  }
  stdout(`${lines.join("\n")}\n`);
}

function terminalSafeText(value, { maxCodePoints = 160, fallback = "" } = {}) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const codePoints = Array.from(value);
  const truncated = codePoints.length > maxCodePoints;
  let output = "";
  for (const character of codePoints.slice(0, maxCodePoints)) {
    if (character === "\\") {
      output += "\\\\";
      continue;
    }
    if (character === "\"") {
      output += "\\\"";
      continue;
    }
    if (character === "\b") {
      output += "\\b";
      continue;
    }
    if (character === "\f") {
      output += "\\f";
      continue;
    }
    if (character === "\n") {
      output += "\\n";
      continue;
    }
    if (character === "\r") {
      output += "\\r";
      continue;
    }
    if (character === "\t") {
      output += "\\t";
      continue;
    }
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      || codePoint === 0x061c
      || (codePoint >= 0x200b && codePoint <= 0x200f)
      || codePoint === 0x2028 || codePoint === 0x2029
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2060 && codePoint <= 0x206f)
      || codePoint === 0xfeff) {
      output += `\\u${codePoint.toString(16).padStart(4, "0")}`;
      continue;
    }
    output += character;
  }
  return `${output}${truncated ? "..." : ""}`;
}

function humanInteger(value, locale, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    return cliMessage(locale, "common.unknown");
  }
  return String(value);
}

function humanBoolean(value, locale) {
  if (value === true) return cliMessage(locale, "common.yes");
  if (value === false) return cliMessage(locale, "common.no");
  return cliMessage(locale, "common.unknown");
}

function humanWorkerPhase(value, locale) {
  if (["running", "stopped", "starting", "draining", "failed", "crashed", "backoff"].includes(value)) {
    return cliMessage(locale, `status.state.${value}`);
  }
  return cliMessage(locale, "common.unknown");
}

function humanPublicBaseUrl(value, locale) {
  if (typeof value !== "string") return cliMessage(locale, "common.unknown");
  try {
    const parsed = new URL(value);
    return terminalSafeText(`${parsed.origin}${parsed.pathname}`, {
      maxCodePoints: 320,
      fallback: cliMessage(locale, "common.unknown")
    });
  } catch {
    return cliMessage(locale, "common.unknown");
  }
}

function humanIsoTimestamp(value, locale) {
  if (typeof value !== "string") return cliMessage(locale, "common.unknown");
  try {
    if (new Date(value).toISOString() !== value) return cliMessage(locale, "common.unknown");
  } catch {
    return cliMessage(locale, "common.unknown");
  }
  return value;
}

function humanProviderTest(provider, locale) {
  if (provider?.lastTestStatus === "untested") return cliMessage(locale, "provider.test.untested");
  if (provider?.lastTestStatus === "passed") return cliMessage(locale, "provider.test.passed");
  if (provider?.lastTestStatus === "failed") {
    return typeof provider.lastTestCode === "string"
      && /^[A-Z][A-Z0-9_]{0,127}$/.test(provider.lastTestCode)
      ? cliMessage(locale, "provider.test.failedCode", { code: provider.lastTestCode })
      : cliMessage(locale, "provider.test.failed");
  }
  return cliMessage(locale, "common.unknown");
}

function humanProviderModel(provider, locale) {
  if (provider?.modelMode === "passthrough") {
    return cliMessage(locale, "provider.model.passthrough");
  }
  if (provider?.modelMode === "override") {
    return cliMessage(locale, "provider.model.override", {
      model: terminalSafeText(provider.modelOverride, {
        maxCodePoints: 160,
        fallback: cliMessage(locale, "common.unknown")
      })
    });
  }
  return cliMessage(locale, "common.unknown");
}

function humanCredentialState(value, locale) {
  if (value === true) return cliMessage(locale, "provider.credential.configured");
  if (value === false) return cliMessage(locale, "provider.credential.notConfigured");
  return cliMessage(locale, "common.unknown");
}

function writeHumanProviderList(providers, activeProviderId, locale, stdout) {
  const safeProviders = Array.isArray(providers) ? providers : [];
  const lines = [cliMessage(locale, "provider.list.header", { count: safeProviders.length })];
  if (safeProviders.length === 0) {
    lines.push(cliMessage(locale, "provider.list.empty"));
    stdout(`${lines.join("\n")}\n`);
    return;
  }

  for (const provider of safeProviders) {
    const id = terminalSafeText(provider?.id, {
      maxCodePoints: 128,
      fallback: cliMessage(locale, "common.unknown")
    });
    const name = terminalSafeText(provider?.name, {
      maxCodePoints: 120,
      fallback: cliMessage(locale, "common.unknown")
    });
    const isActive = typeof provider?.id === "string" && provider.id === activeProviderId;
    lines.push(cliMessage(locale, isActive ? "provider.list.active" : "provider.list.inactive", { name }));
    lines.push(cliMessage(locale, "provider.list.id", { value: id }));
    lines.push(cliMessage(locale, "provider.list.baseUrl", {
      value: humanPublicBaseUrl(provider?.baseUrl, locale)
    }));
    lines.push(cliMessage(locale, "provider.list.test", {
      value: humanProviderTest(provider, locale)
    }));
    lines.push(cliMessage(locale, "provider.list.model", {
      value: humanProviderModel(provider, locale)
    }));
    lines.push(cliMessage(locale, "provider.list.credential", {
      value: humanCredentialState(provider?.credentialConfigured, locale)
    }));
  }
  stdout(`${lines.join("\n")}\n`);
}

function writeHumanProviderModels(result, selector, locale, stdout) {
  const catalog = result?.modelCatalog && typeof result.modelCatalog === "object"
    ? result.modelCatalog
    : result;
  const provider = result?.provider && typeof result.provider === "object"
    ? result.provider
    : {};
  const models = Array.isArray(catalog?.models)
    ? catalog.models.filter((model) => typeof model === "string").slice(0, 2_000)
    : [];
  const unknown = cliMessage(locale, "common.unknown");
  const providerId = terminalSafeText(
    provider.id ?? catalog?.providerId ?? (selector?.type === "id" ? selector.value : null),
    { maxCodePoints: 128, fallback: unknown }
  );
  const providerName = terminalSafeText(
    provider.name ?? (selector?.type === "name" ? selector.value : null),
    { maxCodePoints: 120, fallback: unknown }
  );
  const lines = [cliMessage(locale, "provider.models.header", {
    name: providerName,
    id: providerId,
    count: models.length
  })];
  if (models.length === 0) {
    lines.push(cliMessage(locale, "provider.models.empty"));
  } else {
    for (const model of models.slice(0, 20)) {
      lines.push(cliMessage(locale, "provider.models.item", {
        model: terminalSafeText(model, { maxCodePoints: 160, fallback: unknown })
      }));
    }
    if (models.length > 20) {
      lines.push(cliMessage(locale, "provider.models.more", { count: models.length - 20 }));
    }
  }
  stdout(`${lines.join("\n")}\n`);
}

function writeHumanStatus(payload, locale, stdout) {
  if (payload.running !== true) {
    stdout(`${cliMessage(locale, "status.notRunning")}\n`);
    return;
  }
  const unknown = cliMessage(locale, "common.unknown");
  const supervisor = payload.supervisor && typeof payload.supervisor === "object"
    ? payload.supervisor
    : {};
  const worker = payload.worker && typeof payload.worker === "object" ? payload.worker : {};
  const workerState = worker.state && typeof worker.state === "object" ? worker.state : {};
  const activeProvider = payload.activeProvider && typeof payload.activeProvider === "object"
    ? payload.activeProvider
    : null;
  const codex = payload.codex && typeof payload.codex === "object" ? payload.codex : {};
  const lines = [
    cliMessage(locale, "status.header"),
    cliMessage(locale, "status.supervisor", {
      state: cliMessage(locale, "status.state.running")
    }),
    cliMessage(locale, "status.pid", {
      value: humanInteger(supervisor.pid, locale, { positive: true })
    }),
    cliMessage(locale, "status.startedAt", {
      value: humanIsoTimestamp(supervisor.startedAt, locale)
    }),
    cliMessage(locale, "status.worker", { state: humanWorkerPhase(worker.phase, locale) }),
    cliMessage(locale, "status.pid", {
      value: humanInteger(worker.pid, locale, { positive: true })
    }),
    cliMessage(locale, "status.generation", {
      value: humanInteger(worker.generation, locale)
    }),
    cliMessage(locale, "status.listening", {
      value: humanBoolean(workerState.listening, locale)
    }),
    cliMessage(locale, "status.inFlight", {
      value: humanInteger(workerState.inFlight, locale)
    })
  ];

  const activeId = typeof activeProvider?.id === "string"
    ? activeProvider.id
    : payload.activeProviderId;
  if (typeof activeId === "string" && activeId.length > 0) {
    lines.push(cliMessage(locale, "status.activeProvider", {
      name: terminalSafeText(activeProvider?.name, { maxCodePoints: 120, fallback: unknown }),
      id: terminalSafeText(activeId, { maxCodePoints: 128, fallback: unknown })
    }));
  } else {
    lines.push(cliMessage(locale, "status.activeProviderNone"));
  }
  let codexState = unknown;
  if (codex.configured === true) codexState = cliMessage(locale, "status.state.configured");
  if (codex.configured === false) codexState = cliMessage(locale, "status.state.notConfigured");
  lines.push(cliMessage(locale, "status.codex", { state: codexState }));
  lines.push(cliMessage(locale, "status.historyRepairPending", {
    value: humanBoolean(codex.historyRepairPending, locale)
  }));
  lines.push(cliMessage(locale, "status.modelProvider", {
    value: codex.modelProvider === "OpenAI" ? "OpenAI" : unknown
  }));
  lines.push(cliMessage(locale, "status.proxyUrl", {
    value: codex.proxyUrl === "http://127.0.0.1:15100" ? codex.proxyUrl : unknown
  }));
  stdout(`${lines.join("\n")}\n`);
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
  if (!PROVIDER_ACTIONS.has(action)) {
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
      "model",
      "auth-header",
      "auth-scheme",
      "model-mode",
      "model-override"
    ]),
    models: new Set(["json", "id", "name"]),
    test: new Set(["json", "id", "name", "model"]),
    activate: new Set(["json", "id", "name"]),
    delete: new Set(["json", "id", "name"])
  }[action];
  if (Object.keys(options).some((field) => !allowed.has(field))) {
    throw cliInputError("validation.providerOption");
  }
  if (["models", "test", "activate", "delete"].includes(action)) {
    providerSelector(options, locale);
  }
  if (action === "test") requiredOption(options, "model", locale);
  if (action === "add" && Object.hasOwn(options, "model")) {
    requiredOption(options, "model", locale);
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

function providerSelector(options, locale) {
  const hasId = Object.hasOwn(options, "id");
  const hasName = Object.hasOwn(options, "name");
  if (hasId === hasName) throw cliInputError("validation.providerSelector");
  return hasId
    ? { type: "id", value: requiredOption(options, "id", locale) }
    : { type: "name", value: requiredOption(options, "name", locale) };
}

function providerNotFoundError() {
  return new CrpError(
    "PROVIDER_NOT_FOUND",
    "The provider does not exist.",
    "Run provider list and try again.",
    { status: 404 }
  );
}

async function resolveProviderSelector(client, selector) {
  if (selector.type === "id") return selector.value;
  const response = await client.request("GET", "/providers");
  const expected = selector.value.toLowerCase();
  const matches = Array.isArray(response?.providers)
    ? response.providers.filter((provider) => (
      typeof provider?.name === "string" && provider.name.toLowerCase() === expected
    ))
    : [];
  if (matches.length !== 1
    || typeof matches[0]?.id !== "string" || matches[0].id.length === 0) {
    throw providerNotFoundError();
  }
  const providerId = matches[0].id;
  const current = await client.request(
    "GET",
    `/providers/${encodeURIComponent(providerId)}`
  );
  if (current?.provider?.id !== providerId
    || typeof current.provider.name !== "string"
    || current.provider.name.toLowerCase() !== expected) {
    throw providerNotFoundError();
  }
  return providerId;
}

function providerAddTestFailed(cause) {
  const degraded = cause instanceof CrpError
    && cause.details?.committed === true
    && cause.details?.degraded === true;
  const safeCauseAction = typeof cause?.action === "string"
    && cause.action.length > 0 && cause.action.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(cause.action)
    ? cause.action
    : null;
  const error = degraded
    ? new CrpError(
      "PROVIDER_ADD_TEST_COMMITTED_DEGRADED",
      "The provider was added and its test result was saved, but persistence degraded.",
      safeCauseAction ?? "Repair CRP persistence before retrying the provider test.",
      {
        status: 500,
        cause,
        details: { committed: true, degraded: true }
      }
    )
    : new CrpError(
      "PROVIDER_ADD_TEST_FAILED",
      "The provider was added, but its automatic compatibility test could not be completed.",
      "Run provider list, then retry provider test for the saved provider.",
      { status: 500, cause, details: { committed: true } }
    );
  if (typeof cause?.requestId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(cause.requestId)) {
    error.requestId = cause.requestId;
  }
  return error;
}

async function dispatchProviderCommand(argv, dependencies) {
  const { action, options } = parseProviderOptions(argv, dependencies.locale);
  let addRequest = null;
  let addTestModel = null;
  let selector = null;
  if (action === "add") {
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
    addRequest = {
      provider,
      credential: requiredOption(options, "api-key", dependencies.locale)
    };
    if (Object.hasOwn(options, "model")) {
      addTestModel = requiredOption(options, "model", dependencies.locale);
    }
  } else if (action !== "list") {
    selector = providerSelector(options, dependencies.locale);
  }

  const context = await dependencies.ensureSupervisorImpl({
    paths: dependencies.paths,
    adminPort: dependencies.adminPort
  });
  let result;
  if (action === "list") {
    result = await context.client.request("GET", "/providers");
  } else if (action === "add") {
    result = await context.client.request("POST", "/providers", addRequest);
    if (addTestModel !== null) {
      const providerId = result?.provider?.id;
      if (typeof providerId !== "string" || providerId.length === 0) {
        throw providerAddTestFailed(new Error("provider identity missing after create"));
      }
      let tested;
      try {
        tested = await context.client.request(
          "POST",
          `/providers/${encodeURIComponent(providerId)}/test`,
          { model: addTestModel, activateIfNone: true }
        );
      } catch (error) {
        throw providerAddTestFailed(error);
      }
      result = {
        ...result,
        test: {
          ok: tested?.result?.ok === true,
          code: typeof tested?.result?.code === "string" ? tested.result.code : null
        },
        ...(tested?.result?.initialActivation
          ? { initialActivation: tested.result.initialActivation }
          : {})
      };
    }
  } else {
    const providerId = await resolveProviderSelector(context.client, selector);
    const encodedId = encodeURIComponent(providerId);
    if (action === "test") {
      result = await context.client.request("POST", `/providers/${encodedId}/test`, {
        model: requiredOption(options, "model", dependencies.locale),
        activateIfNone: true
      });
    } else if (action === "activate") {
      result = await context.client.request("POST", `/providers/${encodedId}/activate`);
    } else if (action === "models") {
      result = await context.client.request("POST", `/providers/${encodedId}/models`);
    } else {
      result = await context.client.request("DELETE", `/providers/${encodedId}`);
    }
  }
  const payload = {
    ok: true,
    action,
    ...result
  };
  if (action === "list" && options.json !== true) {
    writeHumanProviderList(
      result?.providers,
      context.status?.activeProviderId ?? null,
      dependencies.locale,
      dependencies.stdout
    );
  } else if (action === "models" && options.json !== true) {
    writeHumanProviderModels(result, selector, dependencies.locale, dependencies.stdout);
  } else if (action === "add" && options.json !== true) {
    writeHumanProviderAdd(result, dependencies.locale, dependencies.stdout);
  } else if (action === "test" && options.json !== true) {
    writeHumanProviderTestResult(result, dependencies.locale, dependencies.stdout);
  } else {
    writePayload(
      options,
      payload,
      dependencies.stdout,
      cliMessage(dependencies.locale, `provider.${action}.completed`)
    );
  }
}

function parseSupervisorOptions(argv, locale) {
  const { command, options } = parseCommandLine(argv, locale);
  const allowed = {
    ui: new Set(["json", "no-open"]),
    start: new Set(["json"]),
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
    "ui",
    "start",
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
    openManagementUrlImpl,
    readSupervisorStateImpl,
    readSupervisorStateSnapshotImpl,
    removeStaleSupervisorStateImpl
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
    }, stdout, opened ? cliMessage(dependencies.locale, "ui.opened") : url);
    return true;
  }

  if (command === "status") {
    const context = await discoverSupervisorImpl(discoveryOptions);
    const payload = context === null
      ? { ok: true, running: false, reason: "supervisor_not_running" }
      : { ok: true, running: true, ...context.status };
    if (options.json) {
      writePayload(options, payload, stdout, "");
    } else {
      writeHumanStatus(payload, dependencies.locale, stdout);
    }
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
    const stateSnapshot = readSupervisorStateSnapshotImpl({
      path: paths.statePath,
      adminPort
    });
    const context = await discoverSupervisorImpl(discoveryOptions);
    if (context === null) {
      let cleanupSnapshot = stateSnapshot;
      let staleState = readSupervisorStateImpl({ path: paths.statePath, adminPort });
      if (staleState === null && !existsSync(paths.statePath)) {
        const claimPath = `${paths.statePath}.stale`;
        cleanupSnapshot ??= readSupervisorStateSnapshotImpl({
          path: claimPath,
          adminPort
        });
        staleState = readSupervisorStateImpl({ path: claimPath, adminPort });
      }
      let staleStateRemoved = false;
      if (cleanupSnapshot !== null && staleState !== null) {
        const staleWorkerPid = Number.isSafeInteger(staleState.worker?.pid)
          ? staleState.worker.pid
          : null;
        if (isProcessAliveImpl(staleState.supervisorPid)
          || staleWorkerPid !== null && isProcessAliveImpl(staleWorkerPid)) {
          throw shutdownCliError(
            "SUPERVISOR_SHUTDOWN_UNAVAILABLE",
            "shutdown.unavailable",
            {
              details: {
                processStopped: false,
                stateRemoved: false
              }
            }
          );
        }
        const cleanup = removeStaleSupervisorStateImpl({
          path: paths.statePath,
          expectedSnapshot: cleanupSnapshot,
          adminPort,
          isProcessAlive: isProcessAliveImpl
        });
        staleStateRemoved = cleanup?.removed === true;
        if (!staleStateRemoved && cleanup?.reason !== "state_missing") {
          throw shutdownCliError(
            "SUPERVISOR_STATE_CLEANUP_FAILED",
            "shutdown.stateTimeout",
            {
              details: {
                reason: cleanup?.reason ?? "cleanup_failed",
                processStopped: true,
                stateRemoved: false
              }
            }
          );
        }
      }
      writePayload(options, {
        ok: true,
        shutdown: false,
        reason: "supervisor_not_running",
        ...(staleStateRemoved ? { staleStateRemoved: true } : {})
      }, stdout, cliMessage(
        dependencies.locale,
        staleStateRemoved ? "shutdown.notRunningStaleRemoved" : "shutdown.notRunning"
      ));
      return true;
    }
    const supervisorPid = context.state.supervisorPid;
    const startedAt = context.state.startedAt;
    const currentState = readSupervisorStateImpl({ path: paths.statePath, adminPort });
    if (stateSnapshot === null || !sameSupervisorIdentity(currentState, context.state)) {
      throw shutdownIdentityError();
    }
    const request = { supervisorPid, startedAt };
    let forced = false;
    try {
      const accepted = await context.client.request(
        "POST",
        "/supervisor/shutdown",
        request,
        { expectedStatus: 202 }
      );
      if (!validShutdownAcceptance(accepted, request)) {
        throw shutdownCliError(
          "SUPERVISOR_SHUTDOWN_RESPONSE_INVALID",
          "shutdown.unavailable"
        );
      }
    } catch (error) {
      if (error?.code === "SUPERVISOR_IDENTITY_CHANGED") throw shutdownIdentityError();
      if (!SHUTDOWN_FORCE_FALLBACK_CODES.has(error?.code)) throw error;
      const fallbackState = readSupervisorStateImpl({ path: paths.statePath, adminPort });
      if (!sameSupervisorIdentity(fallbackState, context.state)) throw shutdownIdentityError();
      const latestState = readSupervisorStateImpl({ path: paths.statePath, adminPort });
      if (!sameSupervisorIdentity(latestState, context.state)) throw shutdownIdentityError();
      try {
        killProcess(supervisorPid, "SIGTERM");
      } catch (cause) {
        throw shutdownCliError(
          "SUPERVISOR_SHUTDOWN_UNAVAILABLE",
          "shutdown.unavailable",
          { cause }
        );
      }
      forced = true;
    }

    const workerPid = Number.isSafeInteger(context.status?.worker?.pid)
      && context.status.worker.pid > 0
      ? context.status.worker.pid
      : null;
    const deadline = now() + shutdownTimeoutMs;
    while ((isProcessAliveImpl(supervisorPid)
      || workerPid !== null && isProcessAliveImpl(workerPid)) && now() < deadline) {
      await wait(Math.min(100, deadline - now()));
    }
    const supervisorStopped = !isProcessAliveImpl(supervisorPid);
    const workerStopped = workerPid === null || !isProcessAliveImpl(workerPid);
    if (!supervisorStopped || !workerStopped) {
      throw shutdownCliError("SUPERVISOR_SHUTDOWN_TIMEOUT", "shutdown.timeout", {
        details: {
          forced,
          graceful: !forced,
          processStopped: supervisorStopped && workerStopped,
          stateRemoved: !existsSync(paths.statePath)
        }
      });
    }

    let recoveredStaleState = false;
    if (existsSync(paths.statePath)) {
      const cleanup = removeStaleSupervisorStateImpl({
        path: paths.statePath,
        expectedSnapshot: stateSnapshot,
        adminPort,
        isProcessAlive: isProcessAliveImpl
      });
      recoveredStaleState = cleanup?.removed === true;
      if (!recoveredStaleState && cleanup?.reason !== "state_missing") {
        throw shutdownCliError(
          "SUPERVISOR_STATE_CLEANUP_FAILED",
          "shutdown.stateTimeout",
          {
            details: {
              reason: cleanup?.reason ?? "cleanup_failed",
              forced,
              graceful: false,
              processStopped: true,
              stateRemoved: false
            }
          }
        );
      }
    }
    const stateRemoved = !existsSync(paths.statePath);
    const degraded = !forced && recoveredStaleState;
    const humanMessageKey = forced
      ? "shutdown.forcedCompleted"
      : degraded
        ? "shutdown.degradedCompleted"
        : "shutdown.completed";
    writePayload(options, {
      ok: true,
      shutdown: true,
      graceful: !forced && !degraded,
      forced,
      degraded,
      supervisorPid,
      workerStopped,
      stateRemoved
    }, stdout, cliMessage(dependencies.locale, humanMessageKey));
    return true;
  }

  let context;
  try {
    context = await ensureSupervisorImpl(discoveryOptions);
  } catch (error) {
    if (command === "start") {
      throw withCliStage(error, "supervisor_start");
    }
    throw error;
  }
  let codexBootstrap = null;
  if (context.status?.codex?.configured !== true
    || context.status?.codex?.historyRepairPending === true) {
    try {
      const bootstrap = await context.client.request(
        "POST",
        "/codex/bootstrap",
        undefined,
        { requestTimeoutMs: CODEX_BOOTSTRAP_REQUEST_TIMEOUT_MS }
      );
      codexBootstrap = bootstrap?.result ?? null;
    } catch (error) {
      throw withCliStage(error, "codex_bootstrap");
    }
  }
  if (command === "restart") {
    const result = await context.client.request("POST", "/proxy/restart");
    const payload = {
      ok: true,
      command: "restart",
      supervisorPid: context.state.supervisorPid,
      worker: result?.worker ?? null,
      ...(codexBootstrap === null ? {} : { codexBootstrap })
    };
    const humanMessage = codexBootstrap?.historyRepair?.encryptedContentDetected === true
      ? `${cliMessage(dependencies.locale, "restart.completed")}\n${cliMessage(
        dependencies.locale,
        "start.historyRepairEncryptedWarning"
      )}`
      : cliMessage(dependencies.locale, "restart.completed");
    writePayload(options, payload, stdout, humanMessage);
    return true;
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
  const humanMessage = codexBootstrap?.historyRepair?.encryptedContentDetected === true
    ? `${cliMessage(dependencies.locale, "start.ready")}\n${cliMessage(
      dependencies.locale,
      "start.historyRepairEncryptedWarning"
    )}`
    : cliMessage(dependencies.locale, "start.ready");
  writePayload(options, payload, stdout, humanMessage);
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
  if (command === "start") return await startCommandAction(options);
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
  readSupervisorStateImpl = readSupervisorState,
  readSupervisorStateSnapshotImpl = readSupervisorStateSnapshot,
  removeStaleSupervisorStateImpl = removeStaleSupervisorState,
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
    const resolved = resolveCliLocale(argv);
    argv = resolved.argv;
    locale = resolved.locale;
    commandName = safeCommandName(argv);
    const helpRequest = resolveHelpRequest(argv);
    if (helpRequest !== null) {
      const helpLocale = resolved.explicit ? locale : "en";
      printResolvedHelp(helpRequest, (line) => stdout(`${line}\n`), helpLocale);
      return 0;
    }
    if (REMOVED_CLI_COMMANDS.has(argv[0])) {
      throw removedCommandError(argv[0], REMOVED_CLI_COMMANDS.get(argv[0]));
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
      readSupervisorStateImpl,
      readSupervisorStateSnapshotImpl,
      removeStaleSupervisorStateImpl,
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
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    const modulePath = resolve(fileURLToPath(metaUrl));
    const entryPath = resolve(argv1);
    if (modulePath === entryPath) return true;
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
