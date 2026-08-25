import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import * as crpCli from "../bin/crp.mjs";
import { CrpError } from "../src/shared/errors.mjs";
import { getPaths } from "../src/shared/paths.mjs";

const { runCli } = crpCli;
let invocationSequence = 0;

function adminStatus() {
  return {
    supervisor: { pid: 4242, startedAt: "2026-07-13T08:00:00.000Z" },
    activeProviderId: "provider-1",
    activeProvider: { id: "provider-1", name: "Primary", credentialConfigured: true },
    generation: 0,
    worker: { phase: "stopped", pid: null, generation: 0 },
    codex: {
      configured: false,
      modelProvider: "OpenAI",
      proxyUrl: "http://127.0.0.1:15100",
      historyRepairPending: false
    }
  };
}

function discoveredContext(client, status = adminStatus()) {
  return {
    origin: "http://127.0.0.1:15101",
    state: {
      supervisorPid: status.supervisor.pid,
      startedAt: status.supervisor.startedAt,
      admin: {
        host: "127.0.0.1",
        port: 15101,
        authority: "127.0.0.1:15101",
        origin: "http://127.0.0.1:15101"
      },
      worker: status.worker
    },
    status,
    client,
    spawned: false
  };
}

async function invokeCli(args, overrides = {}) {
  const stdout = [];
  const stderr = [];
  const status = await runCli(args, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    paths: getPaths(join(tmpdir(), `crp-cli-i18n-${process.pid}-${++invocationSequence}`)),
    ...overrides
  });
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("explicit locale works anywhere and normalizes common Chinese tags", async () => {
  const dependencies = { discoverSupervisorImpl: async () => null };
  for (const args of [
    ["--locale", "zh_CN.UTF-8", "status"],
    ["status", "--locale", "ZH-hans@variant"]
  ]) {
    const result = await invokeCli(args, dependencies);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "CRP 监督进程未运行。\n");
    assert.equal(result.stderr, "");
  }
});

test("CLI defaults to English and only the explicit CRP locale environment override applies", async () => {
  const cases = [
    [{ CRP_LOCALE: "en_US.UTF-8", LC_ALL: "zh_CN", LC_MESSAGES: "zh_CN", LANG: "zh_CN" }, "CRP supervisor is not running.\n"],
    [{ CRP_LOCALE: "zh-CN", LC_ALL: "en_US", LANG: "en_US" }, "CRP 监督进程未运行。\n"],
    [{ CRP_LOCALE: "fr-FR", LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "zh_CN", LANG: "zh_CN" }, "CRP supervisor is not running.\n"],
    [{ LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "zh-Hans", LANG: "zh_CN" }, "CRP supervisor is not running.\n"],
    [{ CRP_LOCALE: "fr", LC_ALL: "de", LC_MESSAGES: "ja", LANG: "en_GB@calendar" }, "CRP supervisor is not running.\n"],
    [{ CRP_LOCALE: "fr", LC_ALL: "de", LC_MESSAGES: "ja", LANG: "ko" }, "CRP supervisor is not running.\n"]
  ];

  for (const [environment, expected] of cases) {
    const result = await invokeCli(["status"], {
      environment,
      discoverSupervisorImpl: async () => null
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
  }
});

test("language command persists Chinese and can switch future CLI output back to English", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "crp-cli-language-"));
  const paths = getPaths(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dependencies = {
    paths,
    environment: { LANG: "en_US.UTF-8" },
    discoverSupervisorImpl: async () => null
  };

  const chinese = await invokeCli(["language", "zh"], dependencies);
  assert.equal(chinese.status, 0, chinese.stderr);
  assert.equal(chinese.stdout, "CLI 语言已切换为简体中文。\n");
  assert.deepEqual(JSON.parse(readFileSync(paths.cliPreferencesPath, "utf8")), {
    schemaVersion: 1,
    locale: "zh-CN"
  });
  const afterChinese = await invokeCli(["status"], dependencies);
  assert.equal(afterChinese.stdout, "CRP 监督进程未运行。\n");

  const english = await invokeCli(["language", "en", "--json"], dependencies);
  assert.equal(english.status, 0, english.stderr);
  assert.deepEqual(JSON.parse(english.stdout), {
    ok: true,
    command: "language",
    locale: "en",
    persisted: true
  });
  const afterEnglish = await invokeCli(["status"], dependencies);
  assert.equal(afterEnglish.stdout, "CRP supervisor is not running.\n");
});

test("explicit locale selects Chinese and invalid explicit input fails before discovery", async () => {
  let discoveryCalls = 0;
  const dependencies = {
    environment: { CRP_LOCALE: "zh-CN" },
    ensureSupervisorImpl: async () => { discoveryCalls += 1; return null; },
    discoverSupervisorImpl: async () => { discoveryCalls += 1; return null; }
  };

  const defaultResult = await invokeCli(["status"], dependencies);
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(defaultResult.stdout, "CRP 监督进程未运行。\n");
  assert.equal(discoveryCalls, 1);

  discoveryCalls = 0;
  const explicit = await invokeCli(["status", "--locale", "zh-CN"], dependencies);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, "CRP 监督进程未运行。\n");
  assert.equal(discoveryCalls, 1);

  discoveryCalls = 0;
  for (const args of [
    ["status", "--locale", "fr-FR"],
    ["--locale", "zh-CN", "status", "--locale", "en"]
  ]) {
    const result = await invokeCli(args, dependencies);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error: .+\n$/);
    assert.equal(discoveryCalls, 0);
  }
});

test("CLI validation errors follow the detected locale and explicit locale wins", async () => {
  const dependencies = {
    environment: { CRP_LOCALE: "zh-CN", LC_ALL: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" },
    ensureSupervisorImpl: async () => {
      throw new Error("validation must run before Supervisor discovery");
    },
    discoverSupervisorImpl: async () => {
      throw new Error("validation must run before Supervisor discovery");
    }
  };

  const english = await invokeCli(["status", "--unsupported"], dependencies);
  assert.equal(english.status, 1);
  assert.equal(english.stdout, "");
  assert.equal(english.stderr, "错误：status 命令包含不支持的选项。\n");

  const chinese = await invokeCli(["status", "--unsupported", "--locale", "zh-CN"], dependencies);
  assert.equal(chinese.status, 1);
  assert.equal(chinese.stdout, "");
  assert.equal(chinese.stderr, "错误：status 命令包含不支持的选项。\n");
});

test("locale extraction never consumes or changes the provider credential value", async () => {
  const secret = "locale-scan-complete-secret-sentinel";
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      return { provider: { id: "provider-1", name: "Primary", credentialConfigured: true } };
    }
  };
  const result = await invokeCli([
    "provider", "add",
    "--name", "Primary",
    "--api-key", secret,
    "--locale", "zh-CN",
    "--base-url", "https://provider.example/v1"
  ], {
    ensureSupervisorImpl: async () => discoveredContext(client)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(calls[0][2].credential, secret);
  assert.equal(result.stdout, "提供商添加操作已完成。\n");
});

test("English and Chinese CLI dictionaries have exact non-empty key parity", () => {
  assert.equal(typeof crpCli.CLI_MESSAGES, "object");
  const englishKeys = Object.keys(crpCli.CLI_MESSAGES.en).sort();
  const chineseKeys = Object.keys(crpCli.CLI_MESSAGES["zh-CN"]).sort();
  assert.deepEqual(chineseKeys, englishKeys);
  assert.ok(englishKeys.length > 20);
  for (const locale of ["en", "zh-CN"]) {
    for (const key of englishKeys) {
      assert.equal(typeof crpCli.CLI_MESSAGES[locale][key], "string");
      assert.notEqual(crpCli.CLI_MESSAGES[locale][key].length, 0);
    }
  }
});

test("help and validation output are bilingual while commands remain literal", async () => {
  const english = await invokeCli(["--help"], {
    environment: { CRP_LOCALE: "en", LANG: "zh_CN.UTF-8" }
  });
  const chinese = await invokeCli(["--locale", "zh-CN", "--help"]);
  assert.equal(english.status, 0, english.stderr);
  assert.equal(chinese.status, 0, chinese.stderr);
  assert.match(english.stdout, /^Usage:\n/);
  assert.match(chinese.stdout, /^用法：\n/);
  for (const heading of ["Commands:", "Options:", "Examples:"]) {
    assert.equal(english.stdout.includes(heading), true);
  }
  for (const heading of ["命令：", "选项：", "示例："]) {
    assert.equal(chinese.stdout.includes(heading), true);
  }
  for (const literal of [
    "crp ui [--no-open] [--json]",
    "crp start [--json]",
    "crp status [--json]",
    "crp stop [--json]",
    "crp restart [--json]",
    "crp shutdown [--json]",
    "crp provider"
  ]) {
    assert.equal(english.stdout.includes(literal), true);
    assert.equal(chinese.stdout.includes(literal), true);
  }
  for (const removed of ["init", "install", "setup"]) {
    assert.doesNotMatch(english.stdout, new RegExp(`^\\s*(?:crp\\s+)?${removed}(?:\\s|$)`, "m"));
    assert.doesNotMatch(chinese.stdout, new RegExp(`^\\s*(?:crp\\s+)?${removed}(?:\\s|$)`, "m"));
  }

  let discoveryCalls = 0;
  const invalid = await invokeCli(["status", "--unsupported", "--locale", "zh-CN"], {
    ensureSupervisorImpl: async () => { discoveryCalls += 1; },
    discoverSupervisorImpl: async () => { discoveryCalls += 1; }
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, "错误：status 命令包含不支持的选项。\n");
  assert.equal(discoveryCalls, 0);
});

test("layered command help is bilingual and exits before discovery or Admin requests", async () => {
  let discoveryCalls = 0;
  let adminCalls = 0;
  const client = {
    async request() {
      adminCalls += 1;
      throw new Error("help must not call Admin");
    }
  };
  const dependencies = {
    ensureSupervisorImpl: async () => {
      discoveryCalls += 1;
      return discoveredContext(client);
    },
    discoverSupervisorImpl: async () => {
      discoveryCalls += 1;
      return discoveredContext(client);
    }
  };
  const providerActions = [
    ["presets", "crp provider presets [--json]", /built-in provider/i, /内置提供商/],
    ["list", "crp provider list [--json]", /configured providers/i, /已配置.*提供商/],
    ["add", "crp provider add", /provider profile/i, /提供商配置/],
    ["models", "crp provider models", /available models/i, /可用模型/],
    ["test", "crp provider test", /compatibility/i, /兼容性/],
    ["activate", "crp provider activate", /active provider/i, /当前提供商/],
    ["delete", "crp provider delete", /inactive provider/i, /未激活.*提供商/]
  ];
  const commands = [
    ["status", "crp status [--json]", /Supervisor.*Worker/i, /监督进程.*工作进程/],
    ["start", "crp start [--json]", /Supervisor.*Worker/i, /监督进程.*工作进程/],
    ["stop", "crp stop [--json]", /Supervisor.*running/i, /监督进程.*运行/],
    [
      "shutdown",
      "crp shutdown [--json]",
      /Supervisor.*Worker|Worker.*Supervisor/i,
      /监督进程.*工作进程|工作进程.*监督进程/
    ]
  ];

  for (const flag of ["-h", "--help"]) {
    for (const [locale, usage, providerDescription] of [
      ["en", "Usage:", /provider commands/i],
      ["zh-CN", "用法：", /提供商命令/]
    ]) {
      const group = await invokeCli(["provider", flag, "--locale", locale], dependencies);
      assert.equal(group.status, 0, group.stderr);
      assert.equal(group.stderr, "");
      assert.match(group.stdout, new RegExp(`^${usage}`));
      assert.match(group.stdout, providerDescription);
      assert.match(group.stdout, locale === "en" ? /Commands:/ : /命令：/);
      assert.match(group.stdout, locale === "en" ? /Options:/ : /选项：/);
      assert.match(group.stdout, locale === "en" ? /Examples:/ : /示例：/);
      for (const [, literal] of providerActions) assert.equal(group.stdout.includes(literal), true);
    }

    for (const [action, literal, englishDescription, chineseDescription] of providerActions) {
      for (const [locale, usage, description] of [
        ["en", "Usage:", englishDescription],
        ["zh-CN", "用法：", chineseDescription]
      ]) {
        const result = await invokeCli([
          "provider", action, flag, "--locale", locale
        ], dependencies);
        assert.equal(result.status, 0, `${action} ${flag}: ${result.stderr}`);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, new RegExp(`^${usage}`));
        assert.equal(result.stdout.includes(literal), true);
        assert.match(result.stdout, description);
        assert.match(result.stdout, locale === "en" ? /Options:/ : /选项：/);
        assert.match(result.stdout, locale === "en" ? /Examples:/ : /示例：/);
      }
    }

    for (const [command, literal, englishDescription, chineseDescription] of commands) {
      for (const [locale, usage, description] of [
        ["en", "Usage:", englishDescription],
        ["zh-CN", "用法：", chineseDescription]
      ]) {
        const result = await invokeCli([command, flag, "--locale", locale], dependencies);
        assert.equal(result.status, 0, `${command} ${flag}: ${result.stderr}`);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, new RegExp(`^${usage}`));
        assert.equal(result.stdout.includes(literal), true);
        assert.match(result.stdout, description);
        assert.match(result.stdout, locale === "en" ? /Options:/ : /选项：/);
        assert.match(result.stdout, locale === "en" ? /Examples:/ : /示例：/);
      }
    }
  }

  assert.equal(discoveryCalls, 0);
  assert.equal(adminCalls, 0);
});

test("a short help token used as an option value is not treated as a help request", async () => {
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      return { provider: { id: "provider-1", name: "Primary", credentialConfigured: true } };
    }
  };
  const result = await invokeCli([
    "provider", "add",
    "--name", "Primary",
    "--base-url", "https://provider.example/v1",
    "--api-key", "-h",
    "--locale", "en"
  ], {
    ensureSupervisorImpl: async () => discoveredContext(client)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /^Usage:/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].credential, "-h");
});

test("help with unexpected trailing input fails without discovery or process exit", async () => {
  let discoveryCalls = 0;
  let adminCalls = 0;
  let processExitCalls = 0;
  const client = {
    async request() {
      adminCalls += 1;
      throw new Error("invalid help must not call Admin");
    }
  };
  const dependencies = {
    ensureSupervisorImpl: async () => {
      discoveryCalls += 1;
      return discoveredContext(client);
    },
    discoverSupervisorImpl: async () => {
      discoveryCalls += 1;
      return discoveredContext(client);
    }
  };
  const originalExit = process.exit;
  const results = [];
  try {
    process.exit = () => {
      processExitCalls += 1;
      throw new Error("runCli must return instead of exiting the process");
    };
    for (const args of [
      ["--help", "unexpected", "--locale", "en"],
      ["status", "--help", "unexpected", "--locale", "en"],
      ["provider", "--help", "unexpected", "--locale", "en"],
      ["provider", "list", "--help", "unexpected", "--locale", "en"]
    ]) {
      results.push(await invokeCli(args, dependencies));
    }
  } finally {
    process.exit = originalExit;
  }

  assert.equal(processExitCalls, 0);
  assert.equal(discoveryCalls, 0);
  assert.equal(adminCalls, 0);
  for (const result of results) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /^Usage:/);
  }
});

test("status human output shows Supervisor, Worker, active provider, Codex, and proxy details", async () => {
  const status = adminStatus();
  status.generation = 7;
  status.worker = {
    phase: "running",
    pid: 8001,
    generation: 7,
    state: {
      phase: "running",
      configured: true,
      generation: 7,
      listening: true,
      listenHost: "127.0.0.1",
      listenPort: 15100,
      inFlight: 2
    }
  };
  status.codex.configured = true;
  const context = discoveredContext({ request: async () => ({}) }, status);
  const cases = [
    [
      "en",
      [
        /Supervisor:.*running/i,
        /PID:.*4242/,
        /Worker:.*running/i,
        /PID:.*8001/,
        /Active provider:.*Primary.*provider-1/i,
        /Codex:.*configured/i,
        /Model provider:.*OpenAI/i,
        /Proxy URL:.*http:\/\/127\.0\.0\.1:15100/i
      ]
    ],
    [
      "zh-CN",
      [
        /监督进程：.*运行中/,
        /PID：.*4242/,
        /工作进程：.*运行中/,
        /PID：.*8001/,
        /当前提供商：.*Primary.*provider-1/,
        /Codex：.*已配置/,
        /模型提供商：.*OpenAI/,
        /代理地址：.*http:\/\/127\.0\.0\.1:15100/
      ]
    ]
  ];

  for (const [locale, patterns] of cases) {
    const result = await invokeCli(["status", "--locale", locale], {
      discoverSupervisorImpl: async () => context
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    for (const pattern of patterns) assert.match(result.stdout, pattern);
  }
});

test("status human output distinguishes a stopped Worker from a missing Supervisor", async () => {
  const stopped = adminStatus();
  stopped.activeProviderId = null;
  stopped.activeProvider = null;
  stopped.worker = { phase: "stopped", pid: null, generation: 3, state: null };
  stopped.codex.configured = false;
  const context = discoveredContext({ request: async () => ({}) }, stopped);

  for (const [locale, workerPattern, providerPattern, codexPattern, missingSupervisor] of [
    ["en", /Worker:.*stopped/i, /Active provider:.*none/i, /Codex:.*not configured/i, "CRP supervisor is not running.\n"],
    ["zh-CN", /工作进程：.*已停止/, /当前提供商：.*无/, /Codex：.*未配置/, "CRP 监督进程未运行。\n"]
  ]) {
    const stoppedResult = await invokeCli(["status", "--locale", locale], {
      discoverSupervisorImpl: async () => context
    });
    assert.equal(stoppedResult.status, 0, stoppedResult.stderr);
    assert.match(stoppedResult.stdout, /4242/);
    assert.match(stoppedResult.stdout, workerPattern);
    assert.match(stoppedResult.stdout, providerPattern);
    assert.match(stoppedResult.stdout, codexPattern);

    const missingResult = await invokeCli(["status", "--locale", locale], {
      discoverSupervisorImpl: async () => null
    });
    assert.equal(missingResult.status, 0, missingResult.stderr);
    assert.equal(missingResult.stdout, missingSupervisor);
  }
});

test("lifecycle success output is bilingual", async () => {
  const client = {
    async request(method, path, body) {
      if (path === "/status") return adminStatus();
      if (path === "/proxy/stop") return { worker: { phase: "stopped", pid: null, generation: 1 } };
      if (path === "/supervisor/shutdown") {
        return {
          shutdown: {
            accepted: true,
            supervisorPid: body.supervisorPid,
            startedAt: body.startedAt
          }
        };
      }
      return { worker: { phase: "running", pid: 8001, generation: 1 } };
    }
  };
  const configuredStatus = adminStatus();
  configuredStatus.codex.configured = true;
  const context = discoveredContext(client, configuredStatus);
  const paths = { statePath: join(tmpdir(), `crp-cli-i18n-no-state-${process.pid}`) };

  const cases = [
    ["start", { ensureSupervisorImpl: async () => context }, "Codex Remote Proxy is ready.\n", "Codex Remote Proxy 已就绪。\n"],
    ["restart", { ensureSupervisorImpl: async () => context }, "Proxy worker restarted.\n", "代理工作进程已重启。\n"]
  ];

  for (const [command, dependencies, english, chinese] of cases) {
    const en = await invokeCli([command, "--locale", "en"], dependencies);
    const zh = await invokeCli([command, "--locale", "zh-CN"], dependencies);
    assert.equal(en.status, 0, `${command}: ${en.stderr}`);
    assert.equal(zh.status, 0, `${command}: ${zh.stderr}`);
    assert.equal(en.stdout, english);
    assert.equal(zh.stdout, chinese);
  }

  for (const [locale, supervisorPattern, workerPattern] of [
    ["en", /Supervisor.*stopped/i, /Worker.*stopped/i],
    ["zh-CN", /监督进程.*停止/, /工作进程.*停止/]
  ]) {
    const result = await invokeCli(["shutdown", "--locale", locale], {
      paths,
      discoverSupervisorImpl: async () => context,
      readSupervisorStateSnapshotImpl: () => Object.freeze({}),
      readSupervisorStateImpl: () => context.state,
      isProcessAlive: () => false
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, supervisorPattern);
    assert.match(result.stdout, workerPattern);
  }
});

test("removed aliases provide localized migration guidance without side effects", async () => {
  let ensureCalls = 0;
  let discoverCalls = 0;
  let openCalls = 0;
  const dependencies = {
    ensureSupervisorImpl: async () => { ensureCalls += 1; },
    discoverSupervisorImpl: async () => { discoverCalls += 1; },
    openManagementUrlImpl: () => { openCalls += 1; }
  };

  for (const [command, replacement] of [
    ["init", "ui"],
    ["install", "start"],
    ["setup", "start"]
  ]) {
    for (const [locale, removed, guidance] of [
      ["en", /removed/i, new RegExp(`crp ${replacement}`)],
      ["zh-CN", /已移除/, new RegExp(`crp ${replacement}`)]
    ]) {
      for (const suffix of [[], ["--help"]]) {
        const result = await invokeCli([
          command,
          ...suffix,
          "--locale", locale
        ], dependencies);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, removed);
        assert.match(result.stderr, guidance);
      }
    }
  }
  assert.equal(ensureCalls, 0);
  assert.equal(discoverCalls, 0);
  assert.equal(openCalls, 0);
});

test("stop explains that the Supervisor remains running and points to shutdown", async () => {
  const client = {
    async request(method, path) {
      assert.equal(method, "POST");
      assert.equal(path, "/proxy/stop");
      return { worker: { phase: "stopped", pid: null, generation: 1 } };
    }
  };
  const dependencies = {
    discoverSupervisorImpl: async () => discoveredContext(client)
  };
  for (const [locale, stopped, supervisor] of [
    ["en", /Proxy worker stopped/i, /Supervisor.*still running/i],
    ["zh-CN", /代理工作进程已停止/, /监督进程仍在运行/]
  ]) {
    const result = await invokeCli(["stop", "--locale", locale], dependencies);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, stopped);
    assert.match(result.stdout, supervisor);
    assert.match(result.stdout, /crp shutdown/);
  }
});

test("provider list human output is bilingual, useful, active-aware, and terminal-safe", async () => {
  const privateSentinel = "provider-private-complete-sentinel";
  const extraHeaderSentinel = "provider-extra-header-value-sentinel";
  const querySentinel = "provider-query-secret-sentinel";
  const fragmentSentinel = "provider-fragment-secret-sentinel";
  const longDynamicValue = `Backup-${"x".repeat(4096)}-provider-dynamic-tail-sentinel`;
  const longTestCode = `PROVIDER_${"A".repeat(4096)}_FAILURE_CODE_TAIL`;
  const providers = [
    {
      id: "provider-1",
      name: "Primary$&\u001b[31m\u0085\u061c\u200e\u200f\u202e\u206a\nLine",
      baseUrl: `https://primary.example/v1?token=${querySentinel}#${fragmentSentinel}`,
      modelMode: "passthrough",
      modelOverride: null,
      modelMappingGroupId: null,
      lastTestStatus: "passed",
      credentialConfigured: true,
      credentialRef: privateSentinel,
      apiKey: privateSentinel,
      extraHeaders: { "x-display-trap": extraHeaderSentinel }
    },
    {
      id: "provider-2",
      name: longDynamicValue,
      baseUrl: "https://backup.example/v1",
      modelMode: "override",
      modelOverride: "backup-model",
      modelMappingGroupId: null,
      lastTestStatus: "failed",
      lastTestCode: longTestCode,
      credentialConfigured: false
    },
    {
      id: "provider-3",
      name: "Mapped provider",
      baseUrl: "https://mapped.example/v1",
      modelMode: "passthrough",
      modelOverride: null,
      modelMappingGroupId: "mapping-openrouter",
      lastTestStatus: "passed",
      credentialConfigured: true
    }
  ];
  const client = {
    async request(method, path) {
      assert.equal(method, "GET");
      assert.equal(path, "/providers");
      return { providers };
    }
  };
  const context = discoveredContext(client);
  const cases = [
    [
      "en",
      [
        /Providers.*3/i,
        /Primary\$&\\u001b\[31m\\u0085\\u061c\\u200e\\u200f\\u202e\\u206a\\nLine.*\(active\)/i,
        /ID:.*provider-1/,
        /Base URL:.*https:\/\/primary\.example\/v1/,
        /Test:.*passed/i,
        /Model:.*passthrough/i,
        /Credential:.*configured/i,
        /Backup-/,
        /ID:.*provider-2/,
        /Test: failed(?:\n|$)/i,
        /Model:.*override.*backup-model/i,
        /Mapped provider/,
        /Model:.*mapping group.*mapping-openrouter/i
      ]
    ],
    [
      "zh-CN",
      [
        /提供商.*3/,
        /Primary\$&\\u001b\[31m\\u0085\\u061c\\u200e\\u200f\\u202e\\u206a\\nLine（当前）/,
        /ID：.*provider-1/,
        /基础地址：.*https:\/\/primary\.example\/v1/,
        /测试：.*已通过/,
        /模型：.*透传/,
        /凭据：.*已配置/,
        /Backup-/,
        /ID：.*provider-2/,
        /测试：失败(?:\n|$)/,
        /模型：.*覆盖.*backup-model/,
        /Mapped provider/,
        /模型：.*映射规则组.*mapping-openrouter/
      ]
    ]
  ];

  for (const [locale, patterns] of cases) {
    const result = await invokeCli(["provider", "list", "--locale", locale], {
      ensureSupervisorImpl: async () => context
    });
    assert.equal(result.stdout.includes(privateSentinel), false);
    assert.equal(result.stderr.includes(privateSentinel), false);
    assert.equal(result.stdout.includes(extraHeaderSentinel), false);
    assert.equal(result.stderr.includes(extraHeaderSentinel), false);
    assert.equal(result.stdout.includes(querySentinel), false);
    assert.equal(result.stderr.includes(querySentinel), false);
    assert.equal(result.stdout.includes(fragmentSentinel), false);
    assert.equal(result.stderr.includes(fragmentSentinel), false);
    assert.equal(result.stdout.includes(longDynamicValue), false);
    assert.equal(result.stdout.includes(longTestCode), false);
    assert.equal(result.stderr.includes(longTestCode), false);
    assert.equal(result.stdout.includes("\u001b"), false);
    assert.equal(result.stdout.includes("\u0085"), false);
    assert.equal(result.stdout.includes("\u061c"), false);
    assert.equal(result.stdout.includes("\u200e"), false);
    assert.equal(result.stdout.includes("\u200f"), false);
    assert.equal(result.stdout.includes("\u202e"), false);
    assert.equal(result.stdout.includes("\u206a"), false);
    assert.ok(result.stdout.length < 4096, `provider list output was ${result.stdout.length} bytes`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    for (const pattern of patterns) assert.match(result.stdout, pattern);
  }
});

test("provider list human output has an explicit bilingual empty state", async () => {
  const client = { request: async () => ({ providers: [] }) };
  const context = discoveredContext(client);
  for (const [locale, expected] of [
    ["en", /No providers configured\./],
    ["zh-CN", /尚未配置提供商。/]
  ]) {
    const result = await invokeCli(["provider", "list", "--locale", locale], {
      ensureSupervisorImpl: async () => context
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, expected);
  }
});

test("provider models human output is bilingual, bounded, and terminal-safe", async () => {
  const privateSentinel = "provider-models-private-complete-sentinel";
  const longModel = `long-model-${"x".repeat(4096)}-model-tail-sentinel`;
  const unsafeModel = "model$&\u001b[31m\u061c\u202e\nnext";
  const provider = { id: "provider-1", name: "Primary" };
  const client = {
    async request(method, path, body) {
      if (method === "GET" && path === "/providers") return { providers: [provider] };
      if (method === "GET" && path === "/providers/provider-1") return { provider };
      assert.equal(method, "POST");
      assert.equal(path, "/providers/provider-1/models");
      assert.equal(body, undefined);
      return {
        modelCatalog: {
          providerId: provider.id,
          state: "fresh",
          fetchedAt: "2026-07-16T00:00:00.000Z",
          expiresAt: "2026-07-17T00:00:00.000Z",
          models: ["model-a", unsafeModel, longModel],
          credentialRef: privateSentinel,
          extraHeaders: { "x-private": privateSentinel }
        },
        privateValue: privateSentinel
      };
    }
  };
  const context = discoveredContext(client);

  for (const [locale, header] of [
    ["en", /Models.*Primary.*provider-1.*3/i],
    ["zh-CN", /Primary.*provider-1.*模型.*3/]
  ]) {
    const result = await invokeCli([
      "provider", "models",
      "--name", "Primary",
      "--locale", locale
    ], { ensureSupervisorImpl: async () => context });
    assert.equal(result.stdout.includes(privateSentinel), false);
    assert.equal(result.stderr.includes(privateSentinel), false);
    assert.equal(result.stdout.includes(longModel), false);
    assert.equal(result.stdout.includes("\u001b"), false);
    assert.equal(result.stdout.includes("\u061c"), false);
    assert.equal(result.stdout.includes("\u202e"), false);
    assert.ok(result.stdout.length < 4096, `provider models output was ${result.stdout.length} bytes`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, header);
    assert.match(result.stdout, /model-a/);
    assert.match(result.stdout, /model\$&\\u001b\[31m\\u061c\\u202e\\nnext/);
  }
});

test("provider models JSON preserves the exact public model projection", async () => {
  const modelCatalog = {
    providerId: "provider-1",
    state: "fresh",
    fetchedAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-17T00:00:00.000Z",
    models: ["model-a", "model-b"]
  };
  const client = {
    async request(method, path, body) {
      assert.deepEqual([method, path, body], ["POST", "/providers/provider-1/models", undefined]);
      return { modelCatalog };
    }
  };
  const result = await invokeCli([
    "provider", "models",
    "--id", "provider-1",
    "--json",
    "--locale", "en"
  ], { ensureSupervisorImpl: async () => discoveredContext(client) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    action: "models",
    modelCatalog
  });
});

test("provider mutation success messages are bilingual", async () => {
  const client = {
    async request(method, path) {
      if (path.endsWith("/test")) return { result: { ok: true, code: null } };
      if (path.endsWith("/activate")) return { activation: { activeProviderId: "provider-1", generation: 1 } };
      return { provider: { id: "provider-1", name: "Primary", credentialConfigured: true } };
    }
  };
  const dependencies = { ensureSupervisorImpl: async () => discoveredContext(client) };
  const cases = [
    ["add", ["--name", "Primary", "--base-url", "https://provider.example/v1", "--api-key", "write-only"], "Provider add completed.\n", "提供商添加操作已完成。\n"],
    ["activate", ["--id", "provider-1"], "Provider activate completed.\n", "提供商激活操作已完成。\n"],
    ["delete", ["--id", "provider-1"], "Provider delete completed.\n", "提供商删除操作已完成。\n"]
  ];

  for (const [action, args, english, chinese] of cases) {
    const en = await invokeCli(["provider", action, ...args, "--locale", "en"], dependencies);
    const zh = await invokeCli(["provider", action, ...args, "--locale", "zh-CN"], dependencies);
    assert.equal(en.status, 0, `${action}: ${en.stderr}`);
    assert.equal(zh.status, 0, `${action}: ${zh.stderr}`);
    assert.equal(en.stdout, english);
    assert.equal(zh.stdout, chinese);
  }
});

test("provider test human output reports passed and failed results with bounded safe codes", async () => {
  let testResult = { ok: true, code: null };
  const client = {
    async request(method, path, body) {
      assert.deepEqual([method, path, body], [
        "POST",
        "/providers/provider-1/test",
        { model: "test-model", activateIfNone: true }
      ]);
      return { result: testResult };
    }
  };
  const dependencies = { ensureSupervisorImpl: async () => discoveredContext(client) };
  const cases = [
    [
      "en",
      { ok: true, code: null },
      [/Provider test completed\./, /passed/i]
    ],
    [
      "zh-CN",
      { ok: true, code: null },
      [/提供商测试操作已完成。/, /已通过/]
    ],
    [
      "en",
      { ok: false, code: "PROVIDER_TEST_AUTH" },
      [/Provider test completed\./, /failed.*PROVIDER_TEST_AUTH/i]
    ],
    [
      "zh-CN",
      { ok: false, code: "PROVIDER_TEST_AUTH" },
      [/提供商测试操作已完成。/, /失败.*PROVIDER_TEST_AUTH/]
    ]
  ];

  for (const [locale, response, patterns] of cases) {
    testResult = response;
    const result = await invokeCli([
      "provider", "test",
      "--id", "provider-1",
      "--model", "test-model",
      "--locale", locale
    ], dependencies);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.length < 4096, `provider test output was ${result.stdout.length} bytes`);
    for (const pattern of patterns) assert.match(result.stdout, pattern);
  }

  const unsafeCode = `PROVIDER_TEST_${"X".repeat(4_096)}\u001b[31m\nInjected-Line`;
  testResult = { ok: false, code: unsafeCode };
  const unsafe = await invokeCli([
    "provider", "test",
    "--id", "provider-1",
    "--model", "test-model",
    "--locale", "en"
  ], dependencies);
  assert.equal(unsafe.stdout.includes(unsafeCode), false);
  assert.equal(unsafe.stdout.includes("\u001b"), false);
  assert.equal(unsafe.stdout.includes("Injected-Line"), false);
  assert.equal(unsafe.status, 0, unsafe.stderr);
  assert.equal(unsafe.stderr, "");
  assert.ok(unsafe.stdout.length < 4096, `provider test output was ${unsafe.stdout.length} bytes`);
  assert.match(unsafe.stdout, /failed/i);
});

test("JSON validation failures are one language-independent stderr document", async () => {
  let discoveryCalls = 0;
  const expected = {
    ok: false,
    command: "status",
    stage: null,
    error: {
      code: "CLI_INPUT_INVALID",
      message: "The command input is invalid.",
      action: "Review the command options and try again.",
      details: {}
    }
  };
  const outputs = [];
  for (const locale of ["en", "zh-CN"]) {
    const result = await invokeCli(["status", "--unsupported", "--json", "--locale", locale], {
      ensureSupervisorImpl: async () => { discoveryCalls += 1; },
      discoverSupervisorImpl: async () => { discoveryCalls += 1; }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), expected);
    assert.equal(result.stderr, `${JSON.stringify(expected, null, 2)}\n`);
    outputs.push(result.stderr);
  }
  assert.equal(outputs[0], outputs[1]);
  assert.equal(discoveryCalls, 0);
});

test("JSON failures retain only safe public Admin error fields", async () => {
  const secret = "admin-error-complete-secret-sentinel";
  const error = new CrpError(
    "PROVIDER_INPUT_INVALID",
    "Provider settings are invalid.",
    "Review the provider settings and try again.",
    { details: { field: "name", privateValue: secret } }
  );
  error.requestId = "request-safe_1";
  const client = { request: async () => { throw error; } };
  const result = await invokeCli(["provider", "list", "--json", "--locale", "zh-CN"], {
    ensureSupervisorImpl: async () => discoveredContext(client)
  });

  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    command: "provider",
    stage: null,
    error: {
      code: "PROVIDER_INPUT_INVALID",
      message: "Provider settings are invalid.",
      action: "Review the provider settings and try again.",
      details: { field: "name" },
      requestId: "request-safe_1"
    }
  });
});

test("JSON failures replace unknown secret-bearing errors with a static contract", async () => {
  const secret = "unknown-error-complete-secret-sentinel";
  const result = await invokeCli(["status", "--json", "--locale", "zh-CN"], {
    discoverSupervisorImpl: async () => {
      const error = new Error(secret);
      error.cause = new Error(`cause-${secret}`);
      throw error;
    }
  });

  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stderr.includes("cause"), false);
  assert.equal(result.stderr.includes("stack"), false);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    command: "status",
    stage: null,
    error: {
      code: "CLI_COMMAND_FAILED",
      message: "CRP could not complete the command.",
      action: "Review CRP activity and try again.",
      details: {}
    }
  });
});

test("start reports the exact failed stage and stops later phases", async () => {
  const contracts = {
    supervisor_start: [
      "SUPERVISOR_START_FAILED",
      "The local supervisor could not be started.",
      "Review the supervisor log and try again."
    ],
    codex_bootstrap: [
      "CODEX_CONFIG_WRITE_FAILED",
      "Codex configuration could not be written safely.",
      "Repair local filesystem access and retry."
    ],
    proxy_start: [
      "WORKER_START_FAILED",
      "The proxy worker could not be started.",
      "Review CRP activity and try again."
    ]
  };

  for (const [stage, [code, message, action]] of Object.entries(contracts)) {
      const calls = [];
      const failure = new CrpError(code, message, action);
      const client = {
        async request(method, path) {
          calls.push([method, path]);
          if (stage === "codex_bootstrap" && path === "/codex/bootstrap") throw failure;
          if (stage === "proxy_start" && path === "/proxy/start") throw failure;
          if (path === "/codex/bootstrap") return { result: { changed: true, backupCreated: false } };
          return { worker: { phase: "running", pid: 8001, generation: 1 } };
        }
      };
      const result = await invokeCli(["start", "--json", "--locale", "en"], {
        ensureSupervisorImpl: async () => {
          if (stage === "supervisor_start") throw failure;
          return discoveredContext(client);
        }
      });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.command, "start");
      assert.equal(payload.stage, stage);
      assert.deepEqual(payload.error, { code, message, action, details: {} });
      if (stage === "supervisor_start") assert.deepEqual(calls, []);
      if (stage === "codex_bootstrap") assert.deepEqual(calls, [["POST", "/codex/bootstrap"]]);
      if (stage === "proxy_start") {
        assert.deepEqual(calls, [
          ["POST", "/codex/bootstrap"],
          ["POST", "/proxy/start"]
        ]);
      }
  }
});

test("human start failures use localized stage guidance without raw errors", async () => {
  const secret = "staged-start-complete-secret-sentinel";
  const cases = [
    ["en", "Error: Supervisor startup failed. Review the supervisor log and try again.\n"],
    ["zh-CN", "错误：启动监督进程失败。请检查监督进程日志后重试。\n"]
  ];
  for (const [locale, expected] of cases) {
    const result = await invokeCli(["start", "--locale", locale], {
      ensureSupervisorImpl: async () => { throw new Error(secret); }
    });
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, expected);
  }
});

test("pending restart bootstraps first and prints only the static encrypted-history warning", async () => {
  const secret = "restart-history-warning-private-secret";
  const calls = [];
  const client = {
    async request(method, path) {
      calls.push([method, path]);
      if (path === "/codex/bootstrap") {
        return {
          result: {
            changed: false,
            backupCreated: true,
            historyRepair: {
              required: true,
              completed: true,
              resumed: true,
              backupCreated: true,
              rolloutFiles: 1,
              rolloutRecords: 2,
              sqliteFiles: 1,
              sqliteRows: 3,
              encryptedContentDetected: true,
              privatePath: `/private/${secret}`
            }
          }
        };
      }
      return { worker: { phase: "running", pid: 8002, generation: 2 } };
    }
  };
  const status = adminStatus();
  status.codex.configured = false;
  status.codex.historyRepairPending = true;
  const context = discoveredContext(client, status);

  const english = await invokeCli(["restart", "--locale", "en"], {
    ensureSupervisorImpl: async () => context
  });
  const chinese = await invokeCli(["restart", "--locale", "zh-CN"], {
    ensureSupervisorImpl: async () => context
  });

  for (const result of [english, chinese]) {
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
  assert.equal(english.stdout, [
    "Proxy worker restarted.",
    "Warning: Some historical sessions contain encrypted content. Their provider metadata was repaired, but some messages may remain unavailable.",
    ""
  ].join("\n"));
  assert.equal(chinese.stdout, [
    "代理工作进程已重启。",
    "警告：部分历史会话包含加密内容。提供商元数据已修复，但部分消息可能仍不可用。",
    ""
  ].join("\n"));
  assert.deepEqual(calls, [
    ["POST", "/codex/bootstrap"],
    ["POST", "/proxy/restart"],
    ["POST", "/codex/bootstrap"],
    ["POST", "/proxy/restart"]
  ]);
});

test("pending restart localizes codex_bootstrap failure and stops before Worker restart", async () => {
  const secret = "restart-bootstrap-private-error";
  const failure = new CrpError(
    "CODEX_CONFIG_WRITE_FAILED",
    "Codex configuration could not be written safely.",
    "Repair local filesystem access and retry.",
    { cause: new Error(secret) }
  );
  const cases = [
    ["en", "Error: Codex configuration bootstrap failed. Review CRP activity and retry before starting the proxy.\n"],
    ["zh-CN", "错误：引导 Codex 配置失败。请查看 CRP 活动记录，修复后再启动代理。\n"]
  ];
  for (const [locale, expected] of cases) {
    const calls = [];
    const status = adminStatus();
    status.codex.configured = false;
    status.codex.historyRepairPending = true;
    const result = await invokeCli(["restart", "--locale", locale], {
      ensureSupervisorImpl: async () => discoveredContext({
        async request(method, path) {
          calls.push([method, path]);
          if (path === "/codex/bootstrap") throw failure;
          return assert.fail("Worker restart must not run after bootstrap failure");
        }
      }, status)
    });

    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, expected);
    assert.deepEqual(calls, [["POST", "/codex/bootstrap"]]);
  }
});

test("configured start skips bootstrap and provider required fields fail before discovery", async () => {
  const calls = [];
  const client = {
    async request(method, path) {
      calls.push([method, path]);
      return { worker: { phase: "running", pid: 8001, generation: 1 } };
    }
  };
  const status = adminStatus();
  status.codex.configured = true;
  const started = await invokeCli(["start", "--json"], {
    ensureSupervisorImpl: async () => discoveredContext(client, status)
  });
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(calls, [["POST", "/proxy/start"]]);

  let ensureCalls = 0;
  for (const args of [
    ["provider", "add", "--name", "Primary", "--base-url", "https://provider.example/v1", "--json"],
    ["provider", "test", "--id", "provider-1", "--json"],
    ["provider", "activate", "--json"],
    ["provider", "delete", "--json"]
  ]) {
    const result = await invokeCli(args, {
      ensureSupervisorImpl: async () => { ensureCalls += 1; throw new Error("must not discover"); }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "CLI_INPUT_INVALID");
  }
  assert.equal(ensureCalls, 0);
});

test("JSON command is derived only from the real first argv token after locale removal", async () => {
  for (const args of [
    ["not-a-command", "--label", "status", "--json"],
    ["--locale", "zh-CN", "not-a-command", "--label", "provider", "--json"],
    ["not-a-command", "--locale", "en", "--label", "start", "--json"]
  ]) {
    const result = await invokeCli(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).command, "unknown");
  }

  const known = await invokeCli(["--locale", "zh-CN", "status", "--unsupported", "provider", "--json"]);
  assert.equal(known.status, 1);
  assert.equal(JSON.parse(known.stderr).command, "status");
});
