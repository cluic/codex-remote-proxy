import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as crpCli from "../bin/crp.mjs";
import { CrpError } from "../src/shared/errors.mjs";

const { runCli } = crpCli;

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
      proxyUrl: "http://127.0.0.1:15100"
    }
  };
}

function discoveredContext(client, status = adminStatus()) {
  return {
    origin: "http://127.0.0.1:15101",
    state: {
      supervisorPid: status.supervisor.pid,
      startedAt: status.supervisor.startedAt
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

test("locale environment precedence falls through unsupported values", async () => {
  const cases = [
    [{ CRP_LOCALE: "en_US.UTF-8", LC_ALL: "zh_CN", LC_MESSAGES: "zh_CN", LANG: "zh_CN" }, "CRP supervisor is not running.\n"],
    [{ CRP_LOCALE: "fr-FR", LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "en_US", LANG: "en_US" }, "CRP 监督进程未运行。\n"],
    [{ CRP_LOCALE: "fr", LC_ALL: "de", LC_MESSAGES: "zh-Hans", LANG: "en_US" }, "CRP 监督进程未运行。\n"],
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

test("explicit locale overrides environment and invalid explicit input fails before discovery", async () => {
  let discoveryCalls = 0;
  const dependencies = {
    environment: { CRP_LOCALE: "zh-CN" },
    ensureSupervisorImpl: async () => { discoveryCalls += 1; return null; },
    discoverSupervisorImpl: async () => { discoveryCalls += 1; return null; }
  };

  const explicit = await invokeCli(["status", "--locale", "en-US"], dependencies);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, "CRP supervisor is not running.\n");
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
  const english = await invokeCli(["--help", "--locale", "en"]);
  const chinese = await invokeCli(["--locale", "zh-CN", "--help"]);
  assert.equal(english.status, 0, english.stderr);
  assert.equal(chinese.status, 0, chinese.stderr);
  assert.match(english.stdout, /^Usage:\n/);
  assert.match(chinese.stdout, /^用法：\n/);
  for (const literal of [
    "crp start [--json]",
    "crp status [--json]",
    "crp provider list|add|test|activate|delete [--json]"
  ]) {
    assert.equal(english.stdout.includes(literal), true);
    assert.equal(chinese.stdout.includes(literal), true);
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

test("status and lifecycle success output are bilingual", async () => {
  const client = {
    async request(method, path) {
      if (path === "/status") return adminStatus();
      if (path === "/proxy/stop") return { worker: { phase: "stopped", pid: null, generation: 1 } };
      return { worker: { phase: "running", pid: 8001, generation: 1 } };
    }
  };
  const configuredStatus = adminStatus();
  configuredStatus.codex.configured = true;
  const context = discoveredContext(client, configuredStatus);
  const paths = { statePath: join(tmpdir(), `crp-cli-i18n-no-state-${process.pid}`) };

  const cases = [
    ["status", { discoverSupervisorImpl: async () => context }, "CRP supervisor is running.\n", "CRP 监督进程正在运行。\n"],
    ["start", { ensureSupervisorImpl: async () => context }, "Codex Remote Proxy is ready.\n", "Codex Remote Proxy 已就绪。\n"],
    ["stop", { discoverSupervisorImpl: async () => context }, "Proxy worker stopped.\n", "代理工作进程已停止。\n"],
    ["restart", { ensureSupervisorImpl: async () => context }, "Proxy worker restarted.\n", "代理工作进程已重启。\n"],
    ["shutdown", {
      paths,
      discoverSupervisorImpl: async () => context,
      killProcess() {},
      isProcessAlive: () => false
    }, "CRP supervisor stopped.\n", "CRP 监督进程已停止。\n"]
  ];

  for (const [command, dependencies, english, chinese] of cases) {
    const en = await invokeCli([command, "--locale", "en"], dependencies);
    const zh = await invokeCli([command, "--locale", "zh-CN"], dependencies);
    assert.equal(en.status, 0, `${command}: ${en.stderr}`);
    assert.equal(zh.status, 0, `${command}: ${zh.stderr}`);
    assert.equal(en.stdout, english);
    assert.equal(zh.stdout, chinese);
  }
});

test("all provider command success messages are bilingual", async () => {
  const client = {
    async request(method, path) {
      if (method === "GET") return { providers: [] };
      if (path.endsWith("/test")) return { result: { ok: true, code: null } };
      if (path.endsWith("/activate")) return { activation: { activeProviderId: "provider-1", generation: 1 } };
      return { provider: { id: "provider-1", name: "Primary", credentialConfigured: true } };
    }
  };
  const dependencies = { ensureSupervisorImpl: async () => discoveredContext(client) };
  const cases = [
    ["list", [], "Provider list completed.\n", "提供商列表操作已完成。\n"],
    ["add", ["--name", "Primary", "--base-url", "https://provider.example/v1", "--api-key", "write-only"], "Provider add completed.\n", "提供商添加操作已完成。\n"],
    ["test", ["--id", "provider-1", "--model", "test-model"], "Provider test completed.\n", "提供商测试操作已完成。\n"],
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

test("start aliases report the exact failed stage and stop later phases", async () => {
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

  for (const alias of ["start", "install", "setup"]) {
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
      const result = await invokeCli([alias, "--json"], {
        ensureSupervisorImpl: async () => {
          if (stage === "supervisor_start") throw failure;
          return discoveredContext(client);
        }
      });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.command, alias);
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
