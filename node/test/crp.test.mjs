import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as realFileOperations from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getPaths } from "../src/shared/paths.mjs";
import { CrpError } from "../src/shared/errors.mjs";
import {
  discoverSupervisor,
  SupervisorClient,
  ensureSupervisor,
  readControlToken,
  readSupervisorState,
  readSupervisorStateSnapshot,
  removeStaleSupervisorState,
  spawnDetachedSupervisor
} from "../src/supervisor/supervisor-client.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_URL = pathToFileURL(join(PACKAGE_ROOT, "bin", "crp.mjs")).href;
const CONTROL_TOKEN = Buffer.alloc(32, 0x41).toString("base64url");
const OTHER_CONTROL_TOKEN = Buffer.alloc(32, 0x42).toString("base64url");

function supervisorState(pid = 4242, adminPort = 15101) {
  return {
    schemaVersion: 1,
    supervisorPid: pid,
    startedAt: "2026-07-13T08:00:00.000Z",
    admin: {
      host: "127.0.0.1",
      port: adminPort,
      authority: `127.0.0.1:${adminPort}`,
      origin: `http://127.0.0.1:${adminPort}`
    },
    worker: {
      phase: "stopped",
      pid: null,
      generation: 0,
      state: null,
      restartCount: 0,
      startedAt: null,
      error: null
    }
  };
}

function prepareSupervisorFiles(homeDir, { state = supervisorState(), token = CONTROL_TOKEN } = {}) {
  const paths = getPaths(homeDir);
  mkdirSync(paths.globalHome, { recursive: true, mode: 0o700 });
  chmodSync(paths.globalHome, 0o700);
  writeFileSync(paths.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  writeFileSync(paths.controlTokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(paths.statePath, 0o600);
  chmodSync(paths.controlTokenPath, 0o600);
  return paths;
}

function trackControlTokenReads(paths) {
  const descriptorPaths = new Map();
  let tokenReads = 0;
  return {
    fileOperations: {
      ...realFileOperations,
      openSync(path, ...args) {
        const descriptor = realFileOperations.openSync(path, ...args);
        descriptorPaths.set(descriptor, path);
        return descriptor;
      },
      readFileSync(pathOrDescriptor, ...args) {
        if (descriptorPaths.get(pathOrDescriptor) === paths.controlTokenPath) tokenReads += 1;
        return realFileOperations.readFileSync(pathOrDescriptor, ...args);
      },
      closeSync(descriptor) {
        descriptorPaths.delete(descriptor);
        return realFileOperations.closeSync(descriptor);
      }
    },
    tokenReads: () => tokenReads
  };
}

function delayedJsonResponse(payload, { delayMs, signal }) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    }, delayMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function makeTempHome() {
  return mkdtempSync(join(os.tmpdir(), "crp-home-"));
}

function makeHomeEnv(homeDir) {
  return {
    ...process.env,
    CRP_LOCALE: "en",
    HOME: homeDir,
    USERPROFILE: homeDir
  };
}

function runCrp(args, env) {
  return spawnSync(process.execPath, [join(PACKAGE_ROOT, "bin", "crp.mjs"), ...args], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: "utf8"
  });
}

function containsSecret(value, secret, seen = new Set()) {
  if (typeof value === "string" || Buffer.isBuffer(value)) return value.includes(secret);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => (
    String(key).includes(secret) || containsSecret(value[key], secret, seen)
  ));
}

function assertSecretAbsent(secret, {
  stdout = "",
  stderr = "",
  files = [],
  objects = []
} = {}) {
  assert.equal(containsSecret(stdout, secret), false);
  assert.equal(containsSecret(stderr, secret), false);
  for (const path of files) {
    if (existsSync(path)) {
      assert.equal(containsSecret(readFileSync(path), secret), false);
    }
  }
  for (const value of objects) {
    assert.equal(containsSecret(value, secret), false);
  }
}

function invokeCliInTempHome(args, homeDir, secrets = []) {
  const marker = "__CRP_RESULT__";
  const source = `
    const stdout = [];
    const stderr = [];
    let ensureCalls = 0;
    let discoverCalls = 0;
    let openCalls = 0;
    const { runCli } = await import(${JSON.stringify(CLI_URL)});
    const status = await runCli(${JSON.stringify(args)}, {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      ensureSupervisorImpl: async () => {
        ensureCalls += 1;
        return {
          origin: "http://127.0.0.1:15101",
          state: { supervisorPid: 4242 },
          status: {},
          client: { request: async () => { throw new Error("unexpected Admin request"); } },
          spawned: false
        };
      },
      discoverSupervisorImpl: async () => {
        discoverCalls += 1;
        return null;
      },
      readControlTokenImpl: () => ${JSON.stringify(CONTROL_TOKEN)},
      openManagementUrlImpl: () => { openCalls += 1; }
    });
    process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({
      status,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      ensureCalls,
      discoverCalls,
      openCalls
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: PACKAGE_ROOT,
    env: {
      ...makeHomeEnv(homeDir),
      CRP_UPSTREAM_BASE_URL: "",
      CRP_UPSTREAM_API_KEY: ""
    },
    encoding: "utf8"
  });
  for (const secret of secrets) {
    assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr });
  }
  assert.equal(result.status, 0);
  const markerIndex = result.stdout.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1);
  return JSON.parse(result.stdout.slice(markerIndex + marker.length));
}

async function invokeCli(args, overrides = {}) {
  const stdout = [];
  const stderr = [];
  const { runCli } = await import(CLI_URL);
  const status = await runCli(args, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    environment: { CRP_LOCALE: "en" },
    ...overrides
  });
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}

function adminStatus(pid = 4242, worker = { phase: "stopped", pid: null, generation: 0 }) {
  return {
    supervisor: { pid, startedAt: "2026-07-13T08:00:00.000Z" },
    activeProviderId: "provider-1",
    activeProvider: { id: "provider-1", name: "Primary", credentialConfigured: true },
    generation: worker.generation,
    worker,
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
    state: supervisorState(status.supervisor.pid),
    status,
    client,
    spawned: false
  };
}

test("check does not emit sqlite experimental warnings", () => {
  const homeDir = makeTempHome();
  try {
    const result = runCrp(["check", "--json"], makeHomeEnv(homeDir));
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 0);
    assert.doesNotMatch(output, /ExperimentalWarning: SQLite/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("removed aliases return exact migration guidance without discovery", async () => {
  let ensureCalls = 0;
  let discoverCalls = 0;
  let openCalls = 0;
  const dependencies = {
    ensureSupervisorImpl: async () => { ensureCalls += 1; },
    discoverSupervisorImpl: async () => { discoverCalls += 1; },
    openManagementUrlImpl: () => { openCalls += 1; }
  };
  for (const [command, replacement] of [
    ["init", "crp ui"],
    ["install", "crp start"],
    ["setup", "crp start"]
  ]) {
    const result = await invokeCli([command, "--json", "--locale", "en"], dependencies);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      command,
      stage: null,
      error: {
        code: "CLI_COMMAND_REMOVED",
        message: "This CLI command has been removed.",
        action: `Use \`${replacement}\` instead.`,
        details: {}
      }
    });
  }
  assert.equal(ensureCalls, 0);
  assert.equal(discoverCalls, 0);
  assert.equal(openCalls, 0);
});

test("start reports a safe supervisor failure and exit code without real spawn", async () => {
  const result = await invokeCli(["start", "--json"], {
    ensureSupervisorImpl: async () => {
      throw new Error("The local supervisor could not be started.");
    }
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    command: "start",
    stage: "supervisor_start",
    error: {
      code: "CLI_COMMAND_FAILED",
      message: "CRP could not complete the command.",
      action: "Review CRP activity and try again.",
      details: {}
    }
  });
});

test("imports the CLI module without executing a command", () => {
  const cliUrl = pathToFileURL(join(PACKAGE_ROOT, "bin", "crp.mjs")).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(cliUrl)}); process.stdout.write("imported\\n");`
  ], { cwd: PACKAGE_ROOT, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "imported\n");
});

test("executes help through an npm-style POSIX bin symlink without making imports executable", {
  skip: process.platform === "win32"
}, (t) => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "crp-cli-bin-link-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const binDir = join(tempRoot, "bin");
  const packageScopeDir = join(tempRoot, "lib", "node_modules", "@cluic");
  const packageInstallDir = join(packageScopeDir, "codex-remote-proxy");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(packageScopeDir, { recursive: true });
  symlinkSync(PACKAGE_ROOT, packageInstallDir, "dir");

  const cliLink = join(binDir, "crp");
  const homeDir = join(tempRoot, "home");
  symlinkSync("../lib/node_modules/@cluic/codex-remote-proxy/bin/crp.mjs", cliLink);
  const environment = {
    ...process.env,
    CRP_LOCALE: "en",
    HOME: homeDir,
    USERPROFILE: homeDir,
    LANG: "C",
    LC_ALL: "C"
  };

  const executed = spawnSync(process.execPath, [cliLink, "--locale", "en", "--help"], {
    cwd: tempRoot,
    env: environment,
    encoding: "utf8"
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stderr, "");
  assert.match(executed.stdout, /^Usage:$/m);
  assert.match(executed.stdout, /^  crp <command> \[options\]$/m);

  const cliLinkUrl = pathToFileURL(cliLink).href;
  const missingEntryPath = join(tempRoot, "missing-entry.mjs");
  const imported = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `process.argv[1] = ${JSON.stringify(missingEntryPath)}; await import(${JSON.stringify(cliLinkUrl)}); process.stdout.write("imported\\n");`
  ], {
    cwd: tempRoot,
    env: environment,
    encoding: "utf8"
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stderr, "");
  assert.equal(imported.stdout, "imported\n");
});

test("prints mature English-default CLI help without discovery", async () => {
  let discovered = false;
  const result = await invokeCli(["--help"], {
    environment: { CRP_LOCALE: "zh-CN", LANG: "zh_CN.UTF-8" },
    discoverSupervisorImpl: async () => { discovered = true; },
    ensureSupervisorImpl: async () => { discovered = true; }
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  for (const heading of ["Usage:", "Commands:", "Options:", "Examples:"]) {
    assert.equal(result.stdout.includes(heading), true);
  }
  for (const line of [
    "crp ui [--no-open] [--json]",
    "crp restart [--json]",
    "crp shutdown [--json]",
    "crp provider"
  ]) {
    assert.match(result.stdout, new RegExp(line.replace(/[|[\]]/g, "\\$&")));
  }
  assert.doesNotMatch(result.stdout, /^\s*(?:crp\s+)?(?:init|install|setup)(?:\s|$)/m);
  assert.equal(discovered, false);
});

test("positional argument errors never echo the original value", async () => {
  const secret = "positional-complete-secret-sentinel";
  let ensureCalls = 0;
  let discoverCalls = 0;
  for (const args of [
    ["status", secret],
    ["status", "--json", secret],
    ["provider", "list", secret],
    ["provider", "list", "--json", secret],
    ["capture", "status", secret],
    ["capture", "status", "--json", secret]
  ]) {
    const result = await invokeCli(args, {
      ensureSupervisorImpl: async () => { ensureCalls += 1; },
      discoverSupervisorImpl: async () => { discoverCalls += 1; }
    });
    assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    if (args.includes("--json")) {
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.ok, false);
      assert.equal(payload.command, args[0]);
      assert.equal(payload.stage, null);
      assert.equal(payload.error.code, "CLI_INPUT_INVALID");
    } else {
      assert.equal(result.stderr, "Error: Unexpected positional argument.\n");
    }
  }
  assert.equal(ensureCalls, 0);
  assert.equal(discoverCalls, 0);

  for (const [args, expectedError] of [
    [[secret], "Error: CRP could not complete the command. Review CRP activity and try again.\n"],
    [["capture", secret], "Error: Unknown capture action.\n"]
  ]) {
    const result = await invokeCli(args);
    assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, expectedError);
  }
});

test("guide JSON describes the V1 supervisor flow without legacy mutations", () => {
  const homeDir = makeTempHome();
  try {
    const result = runCrp(["guide", "--json"], makeHomeEnv(homeDir));

    assert.equal(result.status, 0, result.stderr);
    const guide = JSON.parse(result.stdout);
    const flowCommands = [
      ["providerAdd", "crp provider add --name <NAME> --base-url <URL> --api-key <KEY> --model <MODEL> --json"],
      ["start", "crp start --json"],
      ["status", "crp status --json"],
      ["ui", "crp ui --json"],
      ["shutdown", "crp shutdown --json"]
    ];
    assert.equal(
      guide.commands.providerModels,
      "crp provider models --name <NAME> --json"
    );
    assert.equal(
      guide.commands.providerTest,
      "crp provider test --name <NAME> --model <MODEL> --json"
    );
    assert.equal(
      guide.commands.providerActivate,
      "crp provider activate --name <NAME> --json"
    );
    const expectedFlow = guide.expectedFlow.join("\n");
    let previousIndex = -1;
    for (const [name, command] of flowCommands) {
      assert.equal(guide.commands[name], command);
      const commandIndex = expectedFlow.indexOf(command);
      assert.ok(commandIndex > previousIndex, `${command} must appear in V1 flow order`);
      previousIndex = commandIndex;
    }

    const serializedGuide = JSON.stringify(guide);
    assert.doesNotMatch(serializedGuide, /crp start[^"\n]*--(?:upstream-base-url|api-key|capture)/);
    assert.doesNotMatch(serializedGuide, /crp capture (?:on|off)\b/);
    assert.match(serializedGuide, /credential[^"\n]*write-only/i);
    assert.match(serializedGuide, /credential[^"\n]*(?:not echoed|never echoed)/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("guide human output presents the V1 flow without stale fields", () => {
  const homeDir = makeTempHome();
  try {
    const result = runCrp(["guide"], makeHomeEnv(homeDir));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /undefined/);
    for (const command of [
      "crp provider add --name <NAME> --base-url <URL> --api-key <KEY> --model <MODEL> --json",
      "crp provider models --name <NAME> --json",
      "crp provider test --name <NAME> --model <MODEL> --json",
      "crp provider activate --name <NAME> --json",
      "crp start --json",
      "crp ui --json"
    ]) {
      assert.match(result.stdout, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(result.stdout, /crp start[^\n]*--(?:upstream-base-url|api-key|capture)/);
    assert.doesNotMatch(result.stdout, /crp capture (?:on|off)\b/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("legacy human commands render English and Chinese without changing technical literals", () => {
  for (const [args, englishSignal, chineseSignal, literal] of [
    [["check"], "Codex config path:", "Codex 配置路径：", "model_providers.OpenAI"],
    [["guide"], "CRP V1 guide:", "CRP V1 指南：", "crp start --json"],
    [["capture", "status"], "Capture running:", "抓取功能运行中：", ".codex-remote-proxy"],
    [["install-cli"], "Legacy local shim installed.", "旧版本地命令入口已安装。", "npm install -g @cluic/codex-remote-proxy"]
  ]) {
    const homeDir = makeTempHome();
    try {
      const english = runCrp([...args, "--locale", "en"], makeHomeEnv(homeDir));
      const chinese = runCrp([...args, "--locale", "zh-CN"], makeHomeEnv(homeDir));
      assert.equal(english.status, 0, `${args.join(" ")}: ${english.stderr}`);
      assert.equal(chinese.status, 0, `${args.join(" ")}: ${chinese.stderr}`);
      assert.equal(english.stdout.includes(englishSignal), true);
      assert.equal(chinese.stdout.includes(chineseSignal), true);
      assert.equal(english.stdout.includes(literal), true);
      assert.equal(chinese.stdout.includes(literal), true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
});

test("capture rejects invalid action, positional input, and unsupported options before mutation", () => {
  const cases = [
    ["capture", "unknown", "--json"],
    ["capture", "on", "unexpected-value", "--json"],
    ["capture", "on", "--unsupported", "value", "--json"]
  ];
  for (const args of cases) {
    const homeDir = makeTempHome();
    try {
      const paths = getPaths(homeDir);
      const result = runCrp(args, makeHomeEnv(homeDir));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.command, "capture");
      assert.equal(failure.stage, null);
      assert.equal(failure.error.code, "CLI_INPUT_INVALID");
      assert.equal(existsSync(join(paths.globalHome, "config.json")), false);
      assert.equal(existsSync(paths.statePath), false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
});

test("status never starts a missing supervisor", async () => {
  let ensureCalls = 0;
  const result = await invokeCli(["status", "--json"], {
    discoverSupervisorImpl: async () => null,
    ensureSupervisorImpl: async () => {
      ensureCalls += 1;
      throw new Error("must not start");
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    running: false,
    reason: "supervisor_not_running"
  });
  assert.equal(ensureCalls, 0);
});

test("CRP_HOME selects the same CLI instance paths used by login startup", async (t) => {
  const customHome = makeTempHome();
  t.after(() => rmSync(customHome, { recursive: true, force: true }));
  let observedPaths = null;
  const result = await invokeCli(["status", "--json"], {
    environment: { CRP_HOME: customHome, CRP_LOCALE: "en" },
    discoverSupervisorImpl: async ({ paths }) => {
      observedPaths = paths;
      return null;
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(observedPaths.statePath, getPaths(customHome).statePath);
  assert.equal(observedPaths.controlTokenPath, getPaths(customHome).controlTokenPath);
});

test("rejects legacy start options before supervisor discovery or mutation", async () => {
  const secret = "legacy-complete-secret";
  const clientCalls = [];
  let ensureCalls = 0;
  let discoverCalls = 0;
  const result = await invokeCli([
    "start",
    "--upstream-base-url", "https://provider.example/v1",
    "--api-key", secret,
    "--json"
  ], {
    ensureSupervisorImpl: async () => {
      ensureCalls += 1;
      return discoveredContext({
        async request(...args) {
          clientCalls.push(args);
          return { worker: { phase: "running", pid: 8001, generation: 1 } };
        }
      });
    },
    discoverSupervisorImpl: async () => {
      discoverCalls += 1;
      return null;
    }
  });

  assertSecretAbsent(secret, {
    stdout: result.stdout,
    stderr: result.stderr,
    objects: [clientCalls]
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "CLI_INPUT_INVALID");
  assert.equal(ensureCalls, 0);
  assert.equal(discoverCalls, 0);
  assert.deepEqual(clientCalls, []);
});

test("rejects misspelled restart options before supervisor discovery or mutation", async () => {
  const clientCalls = [];
  let ensureCalls = 0;
  let discoverCalls = 0;
  const result = await invokeCli(["restart", "--jsno"], {
    ensureSupervisorImpl: async () => {
      ensureCalls += 1;
      return discoveredContext({
        async request(...args) {
          clientCalls.push(args);
          return { worker: { phase: "running", pid: 8002, generation: 1 } };
        }
      });
    },
    discoverSupervisorImpl: async () => {
      discoverCalls += 1;
      return null;
    }
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Error: The restart command contains an unsupported option.\n");
  assert.equal(ensureCalls, 0);
  assert.equal(discoverCalls, 0);
  assert.deepEqual(clientCalls, []);
});

test("routes start, stop, and restart through exact Admin methods with empty bodies", async () => {
  const calls = [];
  const historyRepair = {
    required: false,
    completed: false,
    resumed: false,
    backupCreated: false,
    rolloutFiles: 0,
    rolloutRecords: 0,
    sqliteFiles: 0,
    sqliteRows: 0,
    encryptedContentDetected: false
  };
  const client = {
    async request(method, path, body, options) {
      calls.push([method, path, body, options]);
      if (path === "/codex/bootstrap") {
        return { result: { changed: true, backupCreated: true, historyRepair } };
      }
      if (path === "/proxy/stop") {
        return { worker: { phase: "stopped", pid: null, generation: 1 } };
      }
      return { worker: { phase: "running", pid: path.endsWith("restart") ? 8002 : 8001, generation: 1 } };
    }
  };
  const status = adminStatus();
  status.codex.configured = true;
  status.codex.historyRepairPending = true;
  const context = discoveredContext(client, status);
  const dependencies = {
    ensureSupervisorImpl: async () => context,
    discoverSupervisorImpl: async () => context
  };

  const started = await invokeCli(["start", "--json"], dependencies);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(calls.splice(0), [
    ["POST", "/codex/bootstrap", undefined, { requestTimeoutMs: 300_000 }],
    ["POST", "/proxy/start", undefined, undefined]
  ]);
  assert.deepEqual(JSON.parse(started.stdout).codexBootstrap, {
    changed: true,
    backupCreated: true,
    historyRepair
  });
  assert.equal(JSON.parse(started.stdout).worker.pid, 8001);

  const stopped = await invokeCli(["stop", "--json"], dependencies);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(calls.splice(0), [["POST", "/proxy/stop", undefined, undefined]]);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);

  const restarted = await invokeCli(["restart", "--json"], dependencies);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(calls.splice(0), [
    ["POST", "/codex/bootstrap", undefined, { requestTimeoutMs: 300_000 }],
    ["POST", "/proxy/restart", undefined, undefined]
  ]);
  assert.deepEqual(JSON.parse(restarted.stdout).codexBootstrap, {
    changed: true,
    backupCreated: true,
    historyRepair
  });
  assert.equal(JSON.parse(restarted.stdout).worker.pid, 8002);
});

test("start blocks Worker startup when the mandatory bootstrap fails", async () => {
  const secret = "bootstrap-failure-complete-secret-sentinel";
  const calls = [];
  const failure = new CrpError(
    "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
    "Codex configuration was updated, but history repair remains pending.",
    "Retry crp start to resume Codex history repair before using the proxy.",
    {
      status: 500,
      details: { committed: true, degraded: true, pending: true },
      cause: new Error(secret)
    }
  );
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/codex/bootstrap") throw failure;
      return assert.fail("Worker start must not run after bootstrap failure");
    }
  };
  const status = adminStatus();
  status.codex.configured = true;
  status.codex.historyRepairPending = true;

  const result = await invokeCli(["start", "--json"], {
    ensureSupervisorImpl: async () => discoveredContext(client, status)
  });

  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).stage, "codex_bootstrap");
  assert.deepEqual(calls, [["POST", "/codex/bootstrap", undefined]]);
});

test("start preserves config-only committed degradation and never starts Worker", async () => {
  const secret = "config-only-bootstrap-secret-sentinel";
  const calls = [];
  const failure = new CrpError(
    "CODEX_CONFIG_COMMITTED_DEGRADED",
    "The Codex configuration was updated, but completion could not be confirmed.",
    "Review the Codex configuration and retry before starting the proxy.",
    {
      status: 500,
      details: { committed: true, degraded: true, pending: false },
      cause: new Error(secret)
    }
  );
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/codex/bootstrap") throw failure;
      return assert.fail("Worker start must not run after config-only degradation");
    }
  };
  const status = adminStatus();
  status.codex.configured = false;

  const result = await invokeCli(["start", "--json"], {
    ensureSupervisorImpl: async () => discoveredContext(client, status)
  });

  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.stage, "codex_bootstrap");
  assert.equal(payload.error.code, "CODEX_CONFIG_COMMITTED_DEGRADED");
  assert.deepEqual(payload.error.details, {
    committed: true,
    degraded: true,
    pending: false
  });
  assert.deepEqual(calls, [["POST", "/codex/bootstrap", undefined]]);
});

test("restart reports codex_bootstrap and never restarts Worker after bootstrap failure", async () => {
  const secret = "restart-bootstrap-failure-complete-secret-sentinel";
  const calls = [];
  const failure = new CrpError(
    "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
    "Codex configuration was updated, but history repair remains pending.",
    "Retry crp start to resume Codex history repair before using the proxy.",
    {
      status: 500,
      details: { committed: true, degraded: true, pending: true },
      cause: new Error(secret)
    }
  );
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/codex/bootstrap") throw failure;
      return assert.fail("Worker restart must not run after bootstrap failure");
    }
  };
  const status = adminStatus();
  status.codex.configured = false;
  status.codex.historyRepairPending = true;

  const result = await invokeCli(["restart", "--json"], {
    ensureSupervisorImpl: async () => discoveredContext(client, status)
  });

  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).stage, "codex_bootstrap");
  assert.deepEqual(calls, [["POST", "/codex/bootstrap", undefined]]);
});

test("human start prints only a static encrypted-history warning after repair", async () => {
  const secret = "history-warning-private-complete-secret";
  const historyRepair = {
    required: true,
    completed: true,
    resumed: false,
    backupCreated: true,
    rolloutFiles: 1,
    rolloutRecords: 2,
    sqliteFiles: 1,
    sqliteRows: 3,
    encryptedContentDetected: true,
    privatePath: `/private/${secret}`,
    sessionBody: secret
  };
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/codex/bootstrap") {
        return { result: { changed: true, backupCreated: true, historyRepair } };
      }
      return { worker: { phase: "running", pid: 8001, generation: 1 } };
    }
  };
  const status = adminStatus();
  status.codex.configured = true;
  status.codex.historyRepairPending = true;
  const dependencies = {
    ensureSupervisorImpl: async () => discoveredContext(client, status)
  };

  const english = await invokeCli(["start", "--locale", "en"], dependencies);
  const chinese = await invokeCli(["start", "--locale", "zh-CN"], dependencies);

  for (const result of [english, chinese]) {
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
  assert.equal(english.stdout, [
    "Codex Remote Proxy is ready.",
    "Warning: Some historical sessions contain encrypted content. Their provider metadata was repaired, but some messages may remain unavailable.",
    ""
  ].join("\n"));
  assert.equal(chinese.stdout, [
    "Codex Remote Proxy 已就绪。",
    "警告：部分历史会话包含加密内容。提供商元数据已修复，但部分消息可能仍不可用。",
    ""
  ].join("\n"));
  assert.deepEqual(calls, [
    ["POST", "/codex/bootstrap", undefined],
    ["POST", "/proxy/start", undefined],
    ["POST", "/codex/bootstrap", undefined],
    ["POST", "/proxy/start", undefined]
  ]);
});

test("shutdown requests an identity-bound graceful close without signalling", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const calls = [];
  const signals = [];
  let alive = true;
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      assert.equal(path, "/supervisor/shutdown");
      alive = false;
      rmSync(paths.statePath, { force: true });
      return {
        shutdown: {
          accepted: true,
          supervisorPid: 4242,
          startedAt: "2026-07-13T08:00:00.000Z"
        }
      };
    }
  };
  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => discoveredContext(client),
    killProcess(pid, signal) {
      signals.push([pid, signal]);
    },
    isProcessAlive: (pid) => pid === 4242 && alive
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [["POST", "/supervisor/shutdown", {
    supervisorPid: 4242,
    startedAt: "2026-07-13T08:00:00.000Z"
  }]]);
  assert.deepEqual(signals, []);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    shutdown: true,
    graceful: true,
    forced: false,
    degraded: false,
    supervisorPid: 4242,
    workerStopped: true,
    stateRemoved: true
  });
  assert.equal(existsSync(paths.statePath), false);
});

test("shutdown uses a verified forced fallback and safely removes matching stale state", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const calls = [];
  const signals = [];
  let supervisorAlive = true;
  let workerAlive = true;
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      throw new CrpError(
        "API_NOT_FOUND",
        "The requested endpoint does not exist.",
        "Upgrade the local supervisor and retry.",
        { status: 404 }
      );
    }
  };
  const status = adminStatus(4242, { phase: "running", pid: 5353, generation: 1 });
  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => discoveredContext(client, status),
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      supervisorAlive = false;
    },
    isProcessAlive: (pid) => pid === 4242 ? supervisorAlive : pid === 5353 && workerAlive,
    wait: async () => { workerAlive = false; }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [["POST", "/supervisor/shutdown", {
    supervisorPid: 4242,
    startedAt: "2026-07-13T08:00:00.000Z"
  }]]);
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    shutdown: true,
    graceful: false,
    forced: true,
    degraded: false,
    supervisorPid: 4242,
    workerStopped: true,
    stateRemoved: true
  });
  assert.equal(existsSync(paths.statePath), false);
  assert.equal(existsSync(`${paths.statePath}.stale`), false);
});

test("shutdown fails closed when the authenticated live Worker survives forced fallback", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  let supervisorAlive = true;
  let clock = 0;
  const client = {
    async request() {
      throw new CrpError(
        "SUPERVISOR_UNAVAILABLE",
        "The local supervisor is unavailable.",
        "Retry the operation.",
        { status: 503 }
      );
    }
  };
  const status = adminStatus(4242, { phase: "running", pid: 5353, generation: 1 });

  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => discoveredContext(client, status),
    killProcess() { supervisorAlive = false; },
    isProcessAlive: (pid) => pid === 4242 ? supervisorAlive : pid === 5353,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    shutdownTimeoutMs: 200
  });

  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, "SUPERVISOR_SHUTDOWN_TIMEOUT");
  assert.deepEqual(error.details, {
    forced: true,
    graceful: false,
    processStopped: false,
    stateRemoved: false
  });
  assert.equal(existsSync(paths.statePath), true);
});

test("shutdown cleans exact dead state while remaining idempotently stopped", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);

  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => null,
    isProcessAlive: () => false
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    shutdown: false,
    reason: "supervisor_not_running",
    staleStateRemoved: true
  });
  assert.equal(existsSync(paths.statePath), false);
  assert.equal(existsSync(`${paths.statePath}.stale`), false);
});

test("shutdown recovers a lone fixed stale-state claim from an interrupted cleanup", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  realFileOperations.renameSync(paths.statePath, `${paths.statePath}.stale`);

  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => null,
    isProcessAlive: () => false
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    shutdown: false,
    reason: "supervisor_not_running",
    staleStateRemoved: true
  });
  assert.equal(existsSync(paths.statePath), false);
  assert.equal(existsSync(`${paths.statePath}.stale`), false);
});

test("shutdown preserves stale state while its recorded Worker is still alive", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const state = supervisorState();
  state.worker = {
    ...state.worker,
    phase: "running",
    pid: 5353,
    generation: 1,
    startedAt: "2026-07-13T08:00:01.000Z"
  };
  const paths = prepareSupervisorFiles(homeDir, { state });

  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => null,
    isProcessAlive: (pid) => pid === 5353
  });

  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, "SUPERVISOR_SHUTDOWN_UNAVAILABLE");
  assert.deepEqual(error.details, {
    processStopped: false,
    stateRemoved: false
  });
  assert.deepEqual(JSON.parse(readFileSync(paths.statePath, "utf8")), state);
  assert.equal(existsSync(`${paths.statePath}.stale`), false);
});

test("shutdown refuses a same-PID replacement without mutating or signalling it", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const calls = [];
  const signals = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      throw new CrpError(
        "SUPERVISOR_IDENTITY_CHANGED",
        "The local supervisor identity changed.",
        "Refresh status and retry.",
        { status: 409 }
      );
    }
  };

  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => discoveredContext(client),
    killProcess(pid, signal) {
      signals.push([pid, signal]);
    },
    isProcessAlive: () => true
  });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "SUPERVISOR_IDENTITY_CHANGED");
  assert.deepEqual(calls, [["POST", "/supervisor/shutdown", {
    supervisorPid: 4242,
    startedAt: "2026-07-13T08:00:00.000Z"
  }]]);
  assert.deepEqual(signals, []);
  assert.equal(existsSync(paths.statePath), true);
});

test("shutdown revalidates identity before the legacy signal fallback", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const calls = [];
  const signals = [];
  const replacement = supervisorState(5252);
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/supervisor/shutdown") {
        writeFileSync(paths.statePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        throw new CrpError(
          "API_NOT_FOUND",
          "The requested endpoint does not exist.",
          "Upgrade the local supervisor and retry.",
          { status: 404 }
        );
      }
      assert.fail("replacement Supervisor must not receive another request");
    }
  };

  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => discoveredContext(client),
    killProcess(pid, signal) { signals.push([pid, signal]); },
    isProcessAlive: () => true
  });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "SUPERVISOR_IDENTITY_CHANGED");
  assert.deepEqual(calls, [["POST", "/supervisor/shutdown", {
    supervisorPid: 4242,
    startedAt: "2026-07-13T08:00:00.000Z"
  }]]);
  assert.deepEqual(signals, []);
  assert.deepEqual(JSON.parse(readFileSync(paths.statePath, "utf8")), replacement);
});

test("stale-state cleanup preserves a canonical replacement", (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const snapshot = readSupervisorStateSnapshot({ path: paths.statePath });
  const replacement = supervisorState(5252);
  writeFileSync(paths.statePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

  const cleanup = removeStaleSupervisorState({
    path: paths.statePath,
    expectedSnapshot: snapshot,
    isProcessAlive: () => false
  });

  assert.deepEqual(cleanup, { removed: false, reason: "state_changed" });
  assert.deepEqual(JSON.parse(readFileSync(paths.statePath, "utf8")), replacement);
  assert.equal(existsSync(`${paths.statePath}.stale`), false);
});

test("stale-state cleanup restores canonical state without leaving a marker after a liveness race", (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const snapshot = readSupervisorStateSnapshot({ path: paths.statePath });
  let livenessChecks = 0;

  const cleanup = removeStaleSupervisorState({
    path: paths.statePath,
    expectedSnapshot: snapshot,
    isProcessAlive: () => {
      livenessChecks += 1;
      return livenessChecks > 1;
    }
  });

  assert.deepEqual(cleanup, { removed: false, reason: "process_running" });
  assert.deepEqual(JSON.parse(readFileSync(paths.statePath, "utf8")), supervisorState());
  assert.equal(existsSync(`${paths.statePath}.stale`), false);
});

test("stale-state cleanup removes a same-inode residual claim before deleting canonical state", (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const snapshot = readSupervisorStateSnapshot({ path: paths.statePath });
  realFileOperations.linkSync(paths.statePath, `${paths.statePath}.stale`);

  const cleanup = removeStaleSupervisorState({
    path: paths.statePath,
    expectedSnapshot: snapshot,
    isProcessAlive: () => false
  });

  assert.deepEqual(cleanup, { removed: true, reason: "removed" });
  assert.equal(existsSync(paths.statePath), false);
  assert.equal(existsSync(`${paths.statePath}.stale`), false);
});

test("stale-state cleanup preserves state while its recorded Worker is alive", (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const state = supervisorState();
  state.worker = {
    ...state.worker,
    phase: "running",
    pid: 5353,
    generation: 1,
    startedAt: "2026-07-13T08:00:01.000Z"
  };
  const paths = prepareSupervisorFiles(homeDir, { state });
  const snapshot = readSupervisorStateSnapshot({ path: paths.statePath });

  const cleanup = removeStaleSupervisorState({
    path: paths.statePath,
    expectedSnapshot: snapshot,
    isProcessAlive: (pid) => pid === 5353
  });

  assert.deepEqual(cleanup, { removed: false, reason: "process_running" });
  assert.deepEqual(JSON.parse(readFileSync(paths.statePath, "utf8")), state);
  assert.equal(existsSync(`${paths.statePath}.stale`), false);
});

test("ui keeps the control token in the fragment and honors no-open", async () => {
  const client = { request: async () => assert.fail("ui must not call an Admin mutation") };
  const context = discoveredContext(client);
  let openCalls = 0;
  const dependencies = {
    ensureSupervisorImpl: async () => context,
    readControlTokenImpl: () => CONTROL_TOKEN,
    openManagementUrlImpl: () => { openCalls += 1; }
  };

  const noOpen = await invokeCli(["ui", "--no-open", "--json"], dependencies);
  assert.equal(noOpen.status, 0, noOpen.stderr);
  assert.deepEqual(JSON.parse(noOpen.stdout), {
    ok: true,
    opened: false,
    origin: "http://127.0.0.1:15101",
    supervisorPid: 4242,
    url: `http://127.0.0.1:15101/#token=${CONTROL_TOKEN}`
  });
  assert.equal(openCalls, 0);

  const opened = await invokeCli(["ui", "--json"], dependencies);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(JSON.parse(opened.stdout).opened, true);
  assert.equal(openCalls, 1);
});

test("opens management URLs with platform argv and never a shell", async () => {
  const { openManagementUrl } = await import(CLI_URL);
  const url = `http://127.0.0.1:15101/#token=${CONTROL_TOKEN}`;
  const cases = [
    ["darwin", "open", [url]],
    ["linux", "xdg-open", [url]],
    ["win32", "cmd", ["/d", "/s", "/c", "start", "", url]]
  ];
  for (const [platform, expectedCommand, expectedArgs] of cases) {
    let received;
    let unrefCalls = 0;
    openManagementUrl(url, {
      platform,
      spawnImpl(command, args, options) {
        received = { command, args, options };
        return { once() {}, unref() { unrefCalls += 1; } };
      }
    });
    assert.equal(received.command, expectedCommand);
    assert.deepEqual(received.args, expectedArgs);
    assert.equal(received.options.shell, false);
    assert.equal(received.options.detached, true);
    assert.equal(unrefCalls, 1);
  }
});

test("routes automation-safe provider commands without returning the write-only credential", async () => {
  const secret = "provider-write-only-complete-secret";
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/providers") {
        return method === "GET"
          ? { providers: [{ id: "provider-1", name: "Primary", credentialConfigured: true }] }
          : { provider: { id: "provider-1", name: "Primary", credentialConfigured: true } };
      }
      if (path.endsWith("/test")) return { result: { ok: true, code: null } };
      if (path.endsWith("/activate")) {
        return { activation: { activeProviderId: "provider/1", generation: 1 } };
      }
      return { provider: { id: "provider/1", name: "Primary", credentialConfigured: true } };
    }
  };
  const dependencies = { ensureSupervisorImpl: async () => discoveredContext(client) };
  const commands = [
    ["list", [], ["GET", "/providers", undefined]],
    ["add", [
      "--name", "Primary",
      "--base-url", "https://provider.example/v1",
      "--api-key", secret
    ], ["POST", "/providers", {
      provider: { name: "Primary", baseUrl: "https://provider.example/v1" },
      credential: secret
    }]],
    ["test", ["--id", "provider/1", "--model", "test-model"], [
      "POST", "/providers/provider%2F1/test", { model: "test-model", activateIfNone: true }
    ]],
    ["activate", ["--id", "provider/1"], [
      "POST", "/providers/provider%2F1/activate", undefined
    ]],
    ["delete", ["--id", "provider/1"], [
      "DELETE", "/providers/provider%2F1", undefined
    ]]
  ];

  for (const [action, args, expectedCall] of commands) {
    const result = await invokeCli(["provider", action, ...args, "--json"], dependencies);
    assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    const actualCall = calls.shift();
    if (action === "add") {
      assert.deepEqual(Object.keys(actualCall[2]).sort(), ["credential", "provider"]);
      assert.deepEqual(actualCall[2].provider, expectedCall[2].provider);
      assert.equal(actualCall[2].credential, secret);
    } else {
      assert.deepEqual(actualCall, expectedCall);
    }
  }
  assert.deepEqual(calls, []);
});

test("provider add without a model preserves its one-request JSON contract", async () => {
  const secret = "provider-add-old-json-complete-secret";
  const provider = { id: "provider-1", name: "Primary", credentialConfigured: true };
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      return { provider };
    }
  };
  const result = await invokeCli([
    "provider", "add",
    "--name", "Primary",
    "--base-url", "https://provider.example/v1",
    "--api-key", secret,
    "--json",
    "--locale", "en"
  ], { ensureSupervisorImpl: async () => discoveredContext(client) });

  assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [["POST", "/providers", {
    provider: { name: "Primary", baseUrl: "https://provider.example/v1" },
    credential: secret
  }]]);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    action: "add",
    provider
  });
});

test("provider add with a model creates first and reports the automatic test result", async () => {
  const secret = "provider-add-and-test-complete-secret";
  const provider = { id: "provider/1", name: "Primary", credentialConfigured: true };
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/providers") return { provider };
      return { result: { ok: false, code: "PROVIDER_TEST_AUTH" } };
    }
  };
  const result = await invokeCli([
    "provider", "add",
    "--name", "Primary",
    "--base-url", "https://provider.example/v1",
    "--api-key", secret,
    "--model", "test-model",
    "--json",
    "--locale", "en"
  ], { ensureSupervisorImpl: async () => discoveredContext(client) });

  assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    ["POST", "/providers", {
      provider: { name: "Primary", baseUrl: "https://provider.example/v1" },
      credential: secret
    }],
    ["POST", "/providers/provider%2F1/test", { model: "test-model", activateIfNone: true }]
  ]);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    action: "add",
    provider,
    test: { ok: false, code: "PROVIDER_TEST_AUTH" }
  });
});

test("provider add keeps the created provider when automatic test transport fails", async () => {
  const secret = "provider-add-test-transport-complete-secret";
  const provider = { id: "provider-1", name: "Primary", credentialConfigured: true };
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/providers") return { provider };
      throw new Error(`transport failed: ${secret}`);
    }
  };
  const result = await invokeCli([
    "provider", "add",
    "--name", "Primary",
    "--base-url", "https://provider.example/v1",
    "--api-key", secret,
    "--model", "test-model",
    "--json",
    "--locale", "en"
  ], { ensureSupervisorImpl: async () => discoveredContext(client) });

  assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    command: "provider",
    stage: null,
    error: {
      code: "PROVIDER_ADD_TEST_FAILED",
      message: "The provider was added, but its automatic compatibility test could not be completed.",
      action: "Run provider list, then retry provider test for the saved provider.",
      details: { committed: true }
    }
  });
  assert.deepEqual(calls.map(([method, path]) => [method, path]), [
    ["POST", "/providers"],
    ["POST", "/providers/provider-1/test"]
  ]);
});

test("provider add preserves committed-degraded automatic test semantics", async () => {
  const secret = "provider-add-test-committed-complete-secret";
  const provider = { id: "provider-1", name: "Primary", credentialConfigured: true };
  const safeAction = "Repair Activity persistence before retrying the provider test.";
  const failure = new CrpError(
    "PROVIDER_TEST_COMMITTED_DEGRADED",
    "The provider test result was saved, but its Activity record degraded.",
    safeAction,
    {
      status: 500,
      details: { committed: true, degraded: true }
    }
  );
  failure.requestId = "request-add-test-safe";
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/providers") return { provider };
      throw failure;
    }
  };
  const result = await invokeCli([
    "provider", "add",
    "--name", "Primary",
    "--base-url", "https://provider.example/v1",
    "--api-key", secret,
    "--model", "test-model",
    "--json",
    "--locale", "en"
  ], { ensureSupervisorImpl: async () => discoveredContext(client) });
  const payload = JSON.parse(result.stderr);

  assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr, objects: [payload] });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(payload.error.code, "PROVIDER_ADD_TEST_COMMITTED_DEGRADED");
  assert.equal(payload.error.action, safeAction);
  assert.equal(payload.error.requestId, "request-add-test-safe");
  assert.deepEqual(payload.error.details, { committed: true, degraded: true });
  assert.notEqual(
    payload.error.action,
    "Run provider list, then retry provider test for the saved provider."
  );
  assert.deepEqual(calls.map(([method, path]) => [method, path]), [
    ["POST", "/providers"],
    ["POST", "/providers/provider-1/test"]
  ]);
});

test("provider actions resolve names case-insensitively before the selected operation", async () => {
  const provider = { id: "provider/1", name: "Primary", credentialConfigured: true };
  const cases = [
    [
      "test",
      ["--model", "test-model"],
      "POST",
      "/providers/provider%2F1/test",
      { model: "test-model", activateIfNone: true }
    ],
    ["activate", [], "POST", "/providers/provider%2F1/activate", undefined],
    ["delete", [], "DELETE", "/providers/provider%2F1", undefined],
    ["models", [], "POST", "/providers/provider%2F1/models", undefined]
  ];

  for (const [action, extraArgs, expectedMethod, expectedPath, expectedBody] of cases) {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push([method, path, body]);
        if (method === "GET" && path === "/providers") return { providers: [provider] };
        if (method === "GET" && path === "/providers/provider%2F1") return { provider };
        if (action === "test") return { result: { ok: true, code: null } };
        if (action === "activate") return { activation: { activeProviderId: provider.id, generation: 1 } };
        if (action === "models") {
          return {
            modelCatalog: {
              providerId: provider.id,
              state: "fresh",
              fetchedAt: "2026-07-16T00:00:00.000Z",
              expiresAt: "2026-07-17T00:00:00.000Z",
              models: ["model-a"]
            }
          };
        }
        return { provider };
      }
    };
    const result = await invokeCli([
      "provider", action,
      "--name", "pRiMaRy",
      ...extraArgs,
      "--json",
      "--locale", "en"
    ], { ensureSupervisorImpl: async () => discoveredContext(client) });

    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    assert.deepEqual(calls, [
      ["GET", "/providers", undefined],
      ["GET", "/providers/provider%2F1", undefined],
      [expectedMethod, expectedPath, expectedBody]
    ]);
  }
});

test("name selectors revalidate the resolved provider snapshot before mutation", async () => {
  const listedProvider = { id: "provider/1", name: "Primary", credentialConfigured: true };
  const renamedProvider = { ...listedProvider, name: "Renamed" };
  const cases = [
    ["test", ["--model", "test-model"]],
    ["activate", []],
    ["delete", []],
    ["models", []]
  ];

  for (const [action, extraArgs] of cases) {
    const calls = [];
    const client = {
      async request(method, path, body) {
        calls.push([method, path, body]);
        if (method === "GET" && path === "/providers") {
          return { providers: [listedProvider] };
        }
        if (method === "GET" && path === "/providers/provider%2F1") {
          return { provider: renamedProvider };
        }
        if (action === "test") return { result: { ok: true, code: null } };
        if (action === "activate") {
          return { activation: { activeProviderId: listedProvider.id, generation: 1 } };
        }
        if (action === "models") {
          return { modelCatalog: { providerId: listedProvider.id, models: [] } };
        }
        return { provider: listedProvider };
      }
    };
    const result = await invokeCli([
      "provider", action,
      "--name", "pRiMaRy",
      ...extraArgs,
      "--json",
      "--locale", "en"
    ], { ensureSupervisorImpl: async () => discoveredContext(client) });

    assert.equal(result.status, 1, `${action}: ${result.stdout}`);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.error.code, "PROVIDER_NOT_FOUND");
    assert.deepEqual(calls, [
      ["GET", "/providers", undefined],
      ["GET", "/providers/provider%2F1", undefined]
    ]);
  }
});

test("provider selectors reject missing or conflicting id/name before discovery", async () => {
  let ensureCalls = 0;
  for (const [action, requiredArgs] of [
    ["test", ["--model", "test-model"]],
    ["activate", []],
    ["delete", []],
    ["models", []]
  ]) {
    for (const selectorArgs of [
      [],
      ["--id", "provider-1", "--name", "Primary"]
    ]) {
      const result = await invokeCli([
        "provider", action,
        ...selectorArgs,
        ...requiredArgs,
        "--json",
        "--locale", "en"
      ], { ensureSupervisorImpl: async () => { ensureCalls += 1; } });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).error.code, "CLI_INPUT_INVALID");
    }
  }
  assert.equal(ensureCalls, 0);
});

test("a missing provider name performs only the public lookup and never mutates", async () => {
  const selector = "missing-provider-name-secret-sentinel";
  const calls = [];
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      return { providers: [{ id: "provider-1", name: "Primary" }] };
    }
  };
  const result = await invokeCli([
    "provider", "delete",
    "--name", selector,
    "--json",
    "--locale", "en"
  ], { ensureSupervisorImpl: async () => discoveredContext(client) });

  assertSecretAbsent(selector, { stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "PROVIDER_NOT_FOUND");
  assert.deepEqual(calls, [["GET", "/providers", undefined]]);
});

test("provider add rejects public fallback consent before supervisor discovery", async () => {
  const secret = "fallback-option-complete-secret-sentinel";
  let ensureCalls = 0;
  const result = await invokeCli([
    "provider", "add",
    "--name", "Primary",
    "--base-url", "https://provider.example/v1",
    "--api-key", secret,
    "--fallback-consent",
    "--json"
  ], {
    ensureSupervisorImpl: async () => { ensureCalls += 1; }
  });

  assertSecretAbsent(secret, { stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "CLI_INPUT_INVALID");
  assert.equal(ensureCalls, 0);
});

test("check and capture JSON positively project legacy config without complete keys", () => {
  const homeDir = makeTempHome();
  const secret = "legacy-complete-secret-sentinel";
  try {
    const paths = getPaths(homeDir);
    const nodeDir = join(paths.globalHome, "node");
    const codexDir = join(homeDir, ".codex");
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(paths.globalHome, "config.json"), JSON.stringify({
      upstreamBaseUrl: "https://provider.example/v1",
      apiKey: secret,
      captureEnabled: true,
      captureDbPath: join(paths.globalHome, "traffic.sqlite3")
    }), { mode: 0o600 });
    writeFileSync(join(nodeDir, "proxy-config.json"), JSON.stringify({
      server: { host: "127.0.0.1", port: 15100 },
      upstream: { baseUrl: "https://provider.example/v1", apiKey: secret },
      capture: { enabled: true, dbPath: join(paths.globalHome, "traffic.sqlite3") }
    }), { mode: 0o600 });
    writeFileSync(join(codexDir, "config.toml"), [
      "[codex_remote_proxy]",
      'upstream_base_url = "https://provider.example/v1"',
      `upstream_api_key = "${secret}"`,
      ""
    ].join("\n"));
    writeFileSync(join(codexDir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: secret,
      tokens: { access_token: secret }
    }));
    const env = makeHomeEnv(homeDir);

    for (const args of [["check", "--json"], ["capture", "status", "--json"]]) {
      const result = runCrp(args, env);
      const payload = JSON.parse(result.stdout);
      assertSecretAbsent(secret, {
        stdout: result.stdout,
        stderr: result.stderr,
        objects: [payload]
      });
      assert.equal(result.status, 0, result.stderr);
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("capture mutation refuses a V1 supervisor state without modifying legacy config", () => {
  const homeDir = makeTempHome();
  try {
    const paths = prepareSupervisorFiles(homeDir, { state: supervisorState(process.pid) });
    const configPath = join(paths.globalHome, "config.json");
    const original = '{"captureEnabled":false}\n';
    writeFileSync(configPath, original, { mode: 0o600 });

    const result = runCrp(["capture", "on", "--json"], makeHomeEnv(homeDir));
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "CLI_COMMAND_FAILED");
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("reads only the exact fixed-loopback supervisor state and private canonical token", (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);

  assert.deepEqual(readSupervisorState({ path: paths.statePath, adminPort: 15101 }), supervisorState());
  assert.equal(readControlToken({ path: paths.controlTokenPath }), CONTROL_TOKEN);

  writeFileSync(paths.statePath, `${JSON.stringify({
    ...supervisorState(),
    admin: { ...supervisorState().admin, origin: "http://attacker.example:15101" }
  })}\n`, { mode: 0o600 });
  assert.equal(readSupervisorState({ path: paths.statePath, adminPort: 15101 }), null);

  writeFileSync(paths.statePath, `${JSON.stringify({
    ...supervisorState(),
    supervisorPid: Number.MAX_SAFE_INTEGER + 1
  })}\n`, { mode: 0o600 });
  assert.equal(readSupervisorState({ path: paths.statePath, adminPort: 15101 }), null);

  if (process.platform !== "win32") {
    chmodSync(paths.controlTokenPath, 0o644);
    assert.throws(
      () => readControlToken({ path: paths.controlTokenPath }),
      (error) => error?.code === "SUPERVISOR_TOKEN_INVALID"
    );
  }
});

test("rejects a control-token path swapped after its descriptor is opened", (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const originalPath = `${paths.controlTokenPath}.original`;
  let swapped = false;
  const fileOperations = {
    ...realFileOperations,
    openSync(path, flags, mode) {
      const descriptor = realFileOperations.openSync(path, flags, mode);
      if (path === paths.controlTokenPath && !swapped) {
        swapped = true;
        realFileOperations.renameSync(path, originalPath);
        realFileOperations.writeFileSync(path, `${OTHER_CONTROL_TOKEN}\n`, { mode: 0o600 });
      }
      return descriptor;
    }
  };

  assert.throws(
    () => readControlToken({ path: paths.controlTokenPath, fileOperations }),
    (error) => error?.code === "SUPERVISOR_TOKEN_INVALID"
  );
  assert.equal(readFileSync(paths.controlTokenPath, "utf8"), `${OTHER_CONTROL_TOKEN}\n`);
});

test("SupervisorClient pins the Admin origin, bearer, JSON bodies, and safe public errors", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const calls = [];
  let response = new Response(JSON.stringify({ supervisor: { pid: 4242 } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const client = new SupervisorClient({
    origin: "http://127.0.0.1:15101",
    controlTokenPath: paths.controlTokenPath,
    fetchImpl: async (...args) => {
      calls.push(args);
      return response;
    }
  });

  assert.deepEqual(await client.request("GET", "/status"), { supervisor: { pid: 4242 } });
  assert.equal(calls[0][0], "http://127.0.0.1:15101/api/v1/status");
  assert.equal(calls[0][1].headers.authorization, `Bearer ${CONTROL_TOKEN}`);
  assert.equal("content-type" in calls[0][1].headers, false);
  assert.equal("body" in calls[0][1], false);

  response = new Response(JSON.stringify({ worker: { phase: "running" } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  await client.request("POST", "/proxy/start");
  assert.equal("content-type" in calls[1][1].headers, false);
  assert.equal("body" in calls[1][1], false);

  response = new Response(JSON.stringify({ provider: { id: "provider-1" } }), {
    status: 201,
    headers: { "content-type": "application/json" }
  });
  await client.request("POST", "/providers", { provider: { name: "Primary" }, credential: "write-only" });
  assert.equal(calls[2][1].headers["content-type"], "application/json; charset=utf-8");
  assert.equal(calls[2][1].body, JSON.stringify({
    provider: { name: "Primary" },
    credential: "write-only"
  }));

  const secret = "must-not-escape-public-error";
  response = new Response(JSON.stringify({
    error: {
      code: "PROVIDER_INPUT_INVALID",
      message: "Provider settings are invalid.",
      action: "Review the provider settings and try again.",
      requestId: "request-1",
      details: { field: "name", unknown: secret, authorization: "[REDACTED]" }
    }
  }), { status: 400, headers: { "content-type": "application/json" } });
  const publicError = await client.request("POST", "/providers", {}).then(
    () => null,
    (error) => error
  );
  assertSecretAbsent(secret, { objects: [publicError] });
  assert.equal(publicError?.code, "PROVIDER_INPUT_INVALID");
  assert.equal(publicError.status, 400);
  assert.equal(publicError.details.field, "name");
  assert.equal(publicError.details.authorization, "[REDACTED]");

  const shutdown = {
    shutdown: {
      accepted: true,
      supervisorPid: 4242,
      startedAt: "2026-07-13T08:00:00.000Z"
    }
  };
  response = new Response(JSON.stringify(shutdown), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  await assert.rejects(
    () => client.request("POST", "/supervisor/shutdown", {}, { expectedStatus: 202 }),
    (error) => error?.code === "SUPERVISOR_RESPONSE_INVALID"
  );
  response = new Response(JSON.stringify(shutdown), {
    status: 202,
    headers: { "content-type": "application/json" }
  });
  assert.deepEqual(
    await client.request("POST", "/supervisor/shutdown", {}, { expectedStatus: 202 }),
    shutdown
  );
});

test("SupervisorClient rejects malformed per-call timeout overrides before fetch", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  let fetchCalls = 0;
  const client = new SupervisorClient({
    origin: "http://127.0.0.1:15101",
    controlTokenPath: paths.controlTokenPath,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  for (const override of [
    null,
    {},
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 1.5 },
    { requestTimeoutMs: 1, unknown: true },
    { expectedStatus: 99 },
    { expectedStatus: 600 },
    { expectedStatus: 202.5 }
  ]) {
    await assert.rejects(
      async () => client.request("GET", "/status", undefined, override),
      (error) => error?.code === "SUPERVISOR_CLIENT_INPUT_INVALID"
    );
  }
  assert.equal(fetchCalls, 0);
});

test("spawns one detached supervisor and shares concurrent bounded discovery", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = getPaths(homeDir);
  const tokenTracker = trackControlTokenReads(paths);
  let spawnCalls = 0;
  let clock = 0;
  const calls = [];
  const spawnSupervisor = () => {
    spawnCalls += 1;
    prepareSupervisorFiles(homeDir);
    return { pid: 4242 };
  };
  const options = {
    paths,
    adminPort: 15101,
    spawnSupervisor,
    isProcessAlive: () => true,
    fileOperations: tokenTracker.fileOperations,
    probeTimeoutMs: 20,
    requestTimeoutMs: 250,
    fetchImpl: async (url, { signal }) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/status")) {
        return new Response(JSON.stringify({
          supervisor: { pid: 4242, startedAt: "2026-07-13T08:00:00.000Z" },
          worker: { phase: "stopped", pid: null }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return delayedJsonResponse({ result: { ok: true } }, { delayMs: 80, signal });
    },
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    timeoutMs: 8_000,
    pollIntervalMs: 100
  };

  const first = ensureSupervisor(options);
  const second = ensureSupervisor(options);
  assert.equal(first, second);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(left.state.supervisorPid, 4242);
  assert.equal(left.spawned, true);
  assert.equal(spawnCalls, 1);
  assert.deepEqual(
    await left.client.request("POST", "/providers/provider-1/test", { model: "test-model" }),
    { result: { ok: true } }
  );
  assert.equal(tokenTracker.tokenReads(), 1);

  const reused = await ensureSupervisor(options);
  assert.equal(reused.spawned, false);
  assert.equal(spawnCalls, 1);
  assert.equal(tokenTracker.tokenReads(), 2);
  assert.deepEqual(calls, [
    "/api/v1/status",
    "/api/v1/providers/provider-1/test",
    "/api/v1/status"
  ]);
});

test("ensureSupervisor removes a dead lone cleanup claim before spawning", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const claimPath = `${paths.statePath}.stale`;
  realFileOperations.renameSync(paths.statePath, claimPath);
  let spawned = false;

  const context = await ensureSupervisor({
    paths,
    adminPort: 15101,
    spawnSupervisor: () => {
      assert.equal(existsSync(paths.statePath), false);
      assert.equal(existsSync(claimPath), false);
      spawned = true;
      prepareSupervisorFiles(homeDir);
      return { pid: 4242 };
    },
    isProcessAlive: () => spawned,
    fetchImpl: async () => new Response(JSON.stringify(adminStatus(4242)), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    wait: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 10
  });

  assert.equal(context.spawned, true);
  assert.equal(spawned, true);
  assert.equal(existsSync(claimPath), false);
});

test("ensureSupervisor preserves a lone cleanup claim while its Supervisor is alive", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const claimPath = `${paths.statePath}.stale`;
  realFileOperations.renameSync(paths.statePath, claimPath);
  let spawnCalls = 0;

  await assert.rejects(
    () => ensureSupervisor({
      paths,
      spawnSupervisor: () => { spawnCalls += 1; },
      isProcessAlive: () => true
    }),
    (error) => error?.code === "SUPERVISOR_START_FAILED"
  );
  assert.equal(spawnCalls, 0);
  assert.equal(existsSync(paths.statePath), false);
  assert.equal(existsSync(claimPath), true);
});

test("ensureSupervisor reads one token and keeps probe timeout separate from later operations", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const tokenTracker = trackControlTokenReads(paths);
  const calls = [];
  const status = adminStatus(4242);

  const context = await ensureSupervisor({
    paths,
    adminPort: 15101,
    spawnSupervisor: () => assert.fail("a ready supervisor must not be spawned again"),
    isProcessAlive: () => true,
    fileOperations: tokenTracker.fileOperations,
    probeTimeoutMs: 20,
    requestTimeoutMs: 250,
    fetchImpl: async (url, { signal }) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/status")) {
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return delayedJsonResponse({ result: { ok: true } }, { delayMs: 80, signal });
    }
  });

  assert.deepEqual(
    await context.client.request("POST", "/providers/provider-1/test", { model: "test-model" }),
    { result: { ok: true } }
  );
  assert.deepEqual(calls, [
    "/api/v1/status",
    "/api/v1/providers/provider-1/test"
  ]);
  assert.equal(tokenTracker.tokenReads(), 1);
});

test("discoverSupervisor times out a slow identity probe before the request timeout", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);

  const context = await discoverSupervisor({
    paths,
    adminPort: 15101,
    isProcessAlive: () => true,
    probeTimeoutMs: 20,
    requestTimeoutMs: 250,
    fetchImpl: async (_url, { signal }) => delayedJsonResponse(adminStatus(4242), {
      delayMs: 80,
      signal
    })
  });

  assert.equal(context, null);
});

test("ensureSupervisor rejects invalid probe and request timeouts before spawning", async (t) => {
  for (const [field, value] of [
    ["probeTimeoutMs", 0],
    ["probeTimeoutMs", 1.5],
    ["requestTimeoutMs", 0],
    ["requestTimeoutMs", Number.MAX_SAFE_INTEGER + 1]
  ]) {
    const homeDir = makeTempHome();
    t.after(() => rmSync(homeDir, { recursive: true, force: true }));
    let spawnCalls = 0;
    let clock = 0;

    await assert.rejects(
      () => ensureSupervisor({
        paths: getPaths(homeDir),
        adminPort: 15101,
        spawnSupervisor: () => {
          spawnCalls += 1;
          return { pid: 4242 };
        },
        isProcessAlive: () => true,
        fetchImpl: async () => assert.fail("invalid timeouts must not reach Admin"),
        timeoutMs: 1,
        pollIntervalMs: 1,
        now: () => clock,
        wait: async (milliseconds) => { clock += milliseconds; },
        [field]: value
      }),
      (error) => error?.code === "SUPERVISOR_CLIENT_INPUT_INVALID",
      `${field}=${value}`
    );
    assert.equal(spawnCalls, 0, `${field}=${value}`);
  }
});

test("discovery rejects a status with the same PID but a different startedAt", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const status = adminStatus(4242);
  status.supervisor.startedAt = "2026-07-13T08:01:00.000Z";

  const discovered = await discoverSupervisor({
    paths,
    adminPort: 15101,
    isProcessAlive: () => true,
    fetchImpl: async () => new Response(JSON.stringify(status), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });

  assert.equal(discovered, null);
});

test("detached spawn redirects logs, sets CRP_HOME, and unrefs without a shell", (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = getPaths(homeDir);
  let received = null;
  let unrefCalls = 0;
  let channelUnrefCalls = 0;
  const child = spawnDetachedSupervisor({
    paths,
    home: homeDir,
    spawnImpl(command, args, options) {
      received = { command, args, options };
      const spawned = new EventEmitter();
      spawned.pid = 4242;
      spawned.channel = { unref() { channelUnrefCalls += 1; } };
      spawned.unref = () => { unrefCalls += 1; };
      return spawned;
    }
  });

  assert.equal(child.pid, 4242);
  assert.equal(received.command, process.execPath);
  assert.match(received.args[0], /supervisor-entry\.mjs$/);
  assert.equal(received.options.detached, true);
  assert.equal(received.options.stdio.length, 4);
  assert.deepEqual(received.options.stdio.slice(0, 1), ["ignore"]);
  assert.equal(received.options.stdio[1], received.options.stdio[2]);
  assert.equal(received.options.stdio[3], "ipc");
  assert.equal(received.options.serialization, "json");
  assert.equal(received.options.env.CRP_HOME, homeDir);
  assert.equal(received.options.shell, false);
  assert.equal(received.options.windowsHide, true);
  assert.equal(unrefCalls, 1);
  assert.equal(channelUnrefCalls, 1);
  assert.equal(typeof child.startupFailure?.then, "function");
  assert.equal(typeof child.disposeStartupMonitor, "function");
  child.disposeStartupMonitor();
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 1);
  assert.equal(child.listenerCount("close"), 0);
  if (process.platform !== "win32") {
    assert.equal(statSync(paths.logPath).mode & 0o777, 0o600);
  }
});

test("detached spawn tears down a child when post-spawn setup fails", (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = getPaths(homeDir);
  const child = new EventEmitter();
  child.pid = 4243;
  child.connected = true;
  child.channel = { unref() {} };
  const signals = [];
  let disconnectCalls = 0;
  child.unref = () => { throw new Error("post-spawn setup failed"); };
  child.kill = (signal) => { signals.push(signal); return true; };
  child.disconnect = () => {
    disconnectCalls += 1;
    child.connected = false;
  };

  assert.throws(
    () => spawnDetachedSupervisor({
      paths,
      home: homeDir,
      spawnImpl: () => child
    }),
    (error) => error?.code === "SUPERVISOR_START_FAILED"
  );
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(disconnectCalls, 1);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 1);
  assert.doesNotThrow(() => child.emit("error", new Error("late teardown error")));
});

test("detached startup failure interrupts CLI discovery with the safe child error", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = getPaths(homeDir);
  let child;
  let spawnCalls = 0;
  let childUnrefCalls = 0;
  let channelUnrefCalls = 0;
  const signals = [];
  let clock = 0;
  let waitCalls = 0;

  const result = await invokeCli(["provider", "list", "--json"], {
    ensureSupervisorImpl: () => ensureSupervisor({
      paths,
      adminPort: 15101,
      spawnSupervisor: () => spawnDetachedSupervisor({
        paths,
        home: homeDir,
        spawnImpl(_command, _args, options) {
          spawnCalls += 1;
          assert.equal(options.stdio[3], "ipc");
          child = new EventEmitter();
          child.pid = 5000;
          child.channel = { unref() { channelUnrefCalls += 1; } };
          child.unref = () => { childUnrefCalls += 1; };
          child.kill = (signal) => {
            signals.push(signal);
            queueMicrotask(() => child.emit("close", 1, signal));
            return true;
          };
          queueMicrotask(() => {
            child.emit("close", 1, null);
            child.emit("message", {
              version: 1,
              type: "startup-failed",
              error: {
                code: "MIGRATION_INPUT_INVALID",
                message: "The legacy provider configuration is invalid.",
                action: "Restore a complete legacy provider URL and credential before migrating.",
                status: 400,
                details: {}
              }
            });
          });
          return child;
        }
      }),
      isProcessAlive: () => true,
      fetchImpl: async () => assert.fail("startup failure must not reach Admin"),
      now: () => clock,
      wait: async (milliseconds) => {
        waitCalls += 1;
        clock += milliseconds;
      },
      timeoutMs: 8_000,
      pollIntervalMs: 100
    })
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    command: "provider",
    stage: null,
    error: {
      code: "MIGRATION_INPUT_INVALID",
      message: "The legacy provider configuration is invalid.",
      action: "Restore a complete legacy provider URL and credential before migrating.",
      details: {}
    }
  });
  assert.equal(spawnCalls, 1);
  assert.equal(childUnrefCalls, 1);
  assert.equal(channelUnrefCalls, 1);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.ok(clock <= 100, `startup failure consumed ${clock} ms`);
  assert.ok(waitCalls <= 1, `startup failure waited ${waitCalls} times`);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 1);
  assert.equal(child.listenerCount("close"), 0);
  assert.doesNotThrow(() => child.emit("error", new Error("late teardown error")));
});

test("detached startup monitor contains malformed child messages", async (t) => {
  const secret = "malformed-startup-message-must-not-escape";
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = getPaths(homeDir);
  let child;
  let clock = 0;

  const failure = await ensureSupervisor({
    paths,
    adminPort: 15101,
    spawnSupervisor: () => spawnDetachedSupervisor({
      paths,
      home: homeDir,
      spawnImpl() {
        child = new EventEmitter();
        child.pid = 5001;
        child.channel = { unref() {} };
        child.unref = () => {};
        child.kill = () => true;
        queueMicrotask(() => child.emit("message", {
          version: 1,
          type: "startup-failed",
          error: {
            code: "MIGRATION_INPUT_INVALID",
            message: secret,
            action: "Restore a complete legacy provider URL and credential before migrating.",
            status: 400,
            details: {}
          }
        }));
        return child;
      }
    }),
    isProcessAlive: () => true,
    fetchImpl: async () => assert.fail("malformed startup message must not reach Admin"),
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    timeoutMs: 8_000,
    pollIntervalMs: 100
  }).then(
    () => null,
    (error) => error
  );

  assertSecretAbsent(secret, { objects: [failure] });
  assert.equal(failure?.code, "SUPERVISOR_START_FAILED");
  assert.ok(clock <= 100, `malformed startup message consumed ${clock} ms`);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 1);
  assert.equal(child.listenerCount("close"), 0);
});

test("detached child close before readiness returns a start failure", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = getPaths(homeDir);
  let child;
  let clock = 0;

  const failure = await ensureSupervisor({
    paths,
    adminPort: 15101,
    spawnSupervisor: () => spawnDetachedSupervisor({
      paths,
      home: homeDir,
      spawnImpl() {
        child = new EventEmitter();
        child.pid = 5002;
        child.channel = { unref() {} };
        child.unref = () => {};
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 1, null));
        return child;
      }
    }),
    isProcessAlive: () => true,
    fetchImpl: async () => assert.fail("closed startup child must not reach Admin"),
    now: () => clock,
    wait: (milliseconds) => new Promise((resolvePromise) => {
      setImmediate(() => {
        clock += milliseconds;
        resolvePromise();
      });
    }),
    timeoutMs: 8_000,
    pollIntervalMs: 100
  }).then(
    () => null,
    (error) => error
  );

  assert.equal(failure?.code, "SUPERVISOR_START_FAILED");
  assert.ok(clock <= 100, `closed startup child consumed ${clock} ms`);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 1);
  assert.equal(child.listenerCount("close"), 0);
});

test("successful monitored supervisor discovery disposes startup IPC without killing child", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = getPaths(homeDir);
  let child;
  let killCalls = 0;
  let disconnectCalls = 0;

  const context = await ensureSupervisor({
    paths,
    adminPort: 15101,
    spawnSupervisor: () => spawnDetachedSupervisor({
      paths,
      home: homeDir,
      spawnImpl() {
        prepareSupervisorFiles(homeDir, { state: supervisorState(5003) });
        child = new EventEmitter();
        child.pid = 5003;
        child.connected = true;
        child.channel = { unref() {} };
        child.unref = () => {};
        child.disconnect = () => {
          disconnectCalls += 1;
          child.connected = false;
        };
        child.kill = () => { killCalls += 1; return true; };
        return child;
      }
    }),
    isProcessAlive: () => true,
    fetchImpl: async () => new Response(JSON.stringify(adminStatus(5003)), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });

  assert.equal(context.spawned, true);
  assert.equal(context.state.supervisorPid, 5003);
  assert.equal(killCalls, 0);
  assert.equal(disconnectCalls, 1);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 1);
  assert.equal(child.listenerCount("close"), 0);
});

test("discovery timeout preserves an invalid state file", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const invalidBytes = '{"legacy":true}\n';
  writeFileSync(paths.statePath, invalidBytes, { mode: 0o600 });
  let clock = 0;
  const signals = [];

  await assert.rejects(
    () => ensureSupervisor({
      paths,
      adminPort: 15101,
      spawnSupervisor: () => ({
        pid: 5000,
        kill(signal) {
          signals.push(signal);
          throw new Error("cleanup failed");
        }
      }),
      isProcessAlive: () => true,
      fetchImpl: async () => assert.fail("invalid state must not receive the bearer"),
      now: () => clock,
      wait: async (milliseconds) => { clock += milliseconds; },
      timeoutMs: 200,
      pollIntervalMs: 50
    }),
    (error) => error?.code === "SUPERVISOR_START_TIMEOUT"
  );
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(readFileSync(paths.statePath, "utf8"), invalidBytes);
});
