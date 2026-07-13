import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as realFileOperations from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getPaths } from "../src/shared/paths.mjs";
import {
  discoverSupervisor,
  SupervisorClient,
  ensureSupervisor,
  readControlToken,
  readSupervisorState,
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

function makeTempHome() {
  return mkdtempSync(join(os.tmpdir(), "crp-home-"));
}

function makeHomeEnv(homeDir) {
  return {
    ...process.env,
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

async function invokeCli(args, overrides = {}) {
  const stdout = [];
  const stderr = [];
  const { runCli } = await import(CLI_URL);
  const status = await runCli(args, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
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
      proxyUrl: "http://127.0.0.1:15100"
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

test("init without config fails cleanly without sqlite warnings", () => {
  const homeDir = makeTempHome();
  try {
    const result = runCrp(["init"], makeHomeEnv(homeDir));
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /Error: Upstream base URL is required/);
    assert.doesNotMatch(output, /ExperimentalWarning: SQLite/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("start reports a safe supervisor failure and exit code without real spawn", async () => {
  const result = await invokeCli(["start", "--json"], {
    ensureSupervisorImpl: async () => {
      throw new Error("The local supervisor could not be started.");
    }
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Error: The local supervisor could not be started.\n");
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

test("prints the approved supervisor CLI help without discovery", async () => {
  let discovered = false;
  const result = await invokeCli(["--help"], {
    discoverSupervisorImpl: async () => { discovered = true; },
    ensureSupervisorImpl: async () => { discovered = true; }
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  for (const line of [
    "crp ui [--no-open] [--json]",
    "crp restart [--json]",
    "crp shutdown [--json]",
    "crp provider list|add|test|activate|delete [--json]"
  ]) {
    assert.match(result.stdout, new RegExp(line.replace(/[|[\]]/g, "\\$&")));
  }
  assert.equal(discovered, false);
});

test("guide JSON describes the V1 supervisor flow without legacy mutations", () => {
  const homeDir = makeTempHome();
  try {
    const result = runCrp(["guide", "--json"], makeHomeEnv(homeDir));

    assert.equal(result.status, 0, result.stderr);
    const guide = JSON.parse(result.stdout);
    const flowCommands = [
      ["providerAdd", "crp provider add --name <NAME> --base-url <URL> --api-key <KEY> --json"],
      ["providerTest", "crp provider test --id <ID> --model <MODEL> --json"],
      ["providerActivate", "crp provider activate --id <ID> --json"],
      ["start", "crp start --json"],
      ["status", "crp status --json"],
      ["ui", "crp ui --json"],
      ["shutdown", "crp shutdown --json"]
    ];
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
      "crp provider add --name <NAME> --base-url <URL> --api-key <KEY> --json",
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

test("rejects legacy start options before supervisor discovery or mutation", async () => {
  const clientCalls = [];
  let ensureCalls = 0;
  let discoverCalls = 0;
  const result = await invokeCli([
    "start",
    "--upstream-base-url", "https://provider.example/v1",
    "--api-key", "legacy-complete-secret",
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

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Error: The start command contains an unsupported option.\n");
  assert.doesNotMatch(result.stderr, /legacy-complete-secret/);
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
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/codex/bootstrap") return { result: { changed: true, backupCreated: true } };
      if (path === "/proxy/stop") {
        return { worker: { phase: "stopped", pid: null, generation: 1 } };
      }
      return { worker: { phase: "running", pid: path.endsWith("restart") ? 8002 : 8001, generation: 1 } };
    }
  };
  const context = discoveredContext(client);
  const dependencies = {
    ensureSupervisorImpl: async () => context,
    discoverSupervisorImpl: async () => context
  };

  const started = await invokeCli(["start", "--json"], dependencies);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(calls.splice(0), [
    ["POST", "/codex/bootstrap", undefined],
    ["POST", "/proxy/start", undefined]
  ]);
  assert.equal(JSON.parse(started.stdout).worker.pid, 8001);

  const stopped = await invokeCli(["stop", "--json"], dependencies);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(calls.splice(0), [["POST", "/proxy/stop", undefined]]);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);

  const restarted = await invokeCli(["restart", "--json"], dependencies);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(calls.splice(0), [["POST", "/proxy/restart", undefined]]);
  assert.equal(JSON.parse(restarted.stdout).worker.pid, 8002);
});

test("install and setup add only one deprecation field to start JSON", async () => {
  const client = {
    async request(method, path) {
      assert.equal(method, "POST");
      assert.equal(path, "/proxy/start");
      return { worker: { phase: "running", pid: 8001, generation: 1 } };
    }
  };
  const status = adminStatus();
  status.codex.configured = true;
  const dependencies = {
    ensureSupervisorImpl: async () => discoveredContext(client, status)
  };
  const start = JSON.parse((await invokeCli(["start", "--json"], dependencies)).stdout);

  for (const alias of ["install", "setup"]) {
    const result = await invokeCli([alias, "--json"], dependencies);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.deprecated, true);
    delete payload.deprecated;
    assert.deepEqual(payload, start);
  }
});

test("shutdown cross-checks authenticated status before SIGTERM and never removes state", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = prepareSupervisorFiles(homeDir);
  const calls = [];
  const signals = [];
  let alive = true;
  let clock = 0;
  let stateExistedBeforeSupervisorCleanup = false;
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/status") return adminStatus(4242);
      throw new Error("unexpected request");
    }
  };
  const result = await invokeCli(["shutdown", "--json"], {
    paths,
    discoverSupervisorImpl: async () => discoveredContext(client),
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      alive = false;
    },
    isProcessAlive: () => alive,
    wait: async (milliseconds) => {
      stateExistedBeforeSupervisorCleanup = existsSync(paths.statePath);
      rmSync(paths.statePath, { force: true });
      clock += milliseconds;
    },
    now: () => clock
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [["GET", "/status", undefined]]);
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    shutdown: true,
    supervisorPid: 4242,
    workerStopped: true
  });
  assert.equal(stateExistedBeforeSupervisorCleanup, true);
  assert.equal(existsSync(paths.statePath), false);
});

test("shutdown refuses a same-PID replacement without mutating or signalling it", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const calls = [];
  const signals = [];
  const replacementStatus = adminStatus(4242);
  replacementStatus.supervisor.startedAt = "2026-07-13T08:01:00.000Z";
  const client = {
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === "/proxy/stop") {
        return { worker: { phase: "stopped", pid: null, generation: 1 } };
      }
      if (path === "/status") return replacementStatus;
      throw new Error("unexpected request");
    }
  };

  const result = await invokeCli(["shutdown", "--json"], {
    paths: getPaths(homeDir),
    discoverSupervisorImpl: async () => discoveredContext(client),
    killProcess(pid, signal) {
      signals.push([pid, signal]);
    },
    isProcessAlive: () => false
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity changed/);
  assert.deepEqual(calls, [["GET", "/status", undefined]]);
  assert.deepEqual(signals, []);
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
      "--api-key", secret,
      "--fallback-consent"
    ], ["POST", "/providers", {
      provider: { name: "Primary", baseUrl: "https://provider.example/v1" },
      credential: secret,
      fallbackConsent: true
    }]],
    ["test", ["--id", "provider/1", "--model", "test-model"], [
      "POST", "/providers/provider%2F1/test", { model: "test-model" }
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
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    assert.deepEqual(calls.shift(), expectedCall);
    assert.equal(result.stdout.includes(secret), false);
  }
  assert.deepEqual(calls, []);
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
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
      JSON.parse(result.stdout);
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
    assert.match(result.stderr, /read-only in this version/);
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

  chmodSync(paths.controlTokenPath, 0o644);
  assert.throws(
    () => readControlToken({ path: paths.controlTokenPath }),
    (error) => error?.code === "SUPERVISOR_TOKEN_INVALID"
  );
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
  await assert.rejects(
    () => client.request("POST", "/providers", {}),
    (error) => error?.code === "PROVIDER_INPUT_INVALID"
      && error.status === 400
      && error.details.field === "name"
      && error.details.authorization === "[REDACTED]"
      && JSON.stringify(error).includes(secret) === false
  );
});

test("spawns one detached supervisor and shares concurrent bounded discovery", async (t) => {
  const homeDir = makeTempHome();
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const paths = getPaths(homeDir);
  let spawnCalls = 0;
  let clock = 0;
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
    fetchImpl: async () => new Response(JSON.stringify({
      supervisor: { pid: 4242, startedAt: "2026-07-13T08:00:00.000Z" },
      worker: { phase: "stopped", pid: null }
    }), { status: 200, headers: { "content-type": "application/json" } }),
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

  const reused = await ensureSupervisor(options);
  assert.equal(reused.spawned, false);
  assert.equal(spawnCalls, 1);
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
  const child = spawnDetachedSupervisor({
    paths,
    home: homeDir,
    spawnImpl(command, args, options) {
      received = { command, args, options };
      return {
        pid: 4242,
        once() {},
        unref() { unrefCalls += 1; }
      };
    }
  });

  assert.equal(child.pid, 4242);
  assert.equal(received.command, process.execPath);
  assert.match(received.args[0], /supervisor-entry\.mjs$/);
  assert.equal(received.options.detached, true);
  assert.deepEqual(received.options.stdio.slice(0, 1), ["ignore"]);
  assert.equal(received.options.stdio[1], received.options.stdio[2]);
  assert.equal(received.options.env.CRP_HOME, homeDir);
  assert.equal(received.options.shell, false);
  assert.equal(unrefCalls, 1);
  if (process.platform !== "win32") {
    assert.equal(statSync(paths.logPath).mode & 0o777, 0o600);
  }
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
