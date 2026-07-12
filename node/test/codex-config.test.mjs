import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as realFileOperations from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  bootstrapCodexConfig,
  patchCodexConfigText
} from "../src/codex/codex-config.mjs";
import { CrpError, toPublicError } from "../src/shared/errors.mjs";
import { getPaths } from "../src/shared/paths.mjs";

const PROXY_URL = "http://127.0.0.1:15100";
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = join(PACKAGE_ROOT, "bin", "crp.mjs");
const START_PAYLOAD_KEYS = [
  "captureActive",
  "captureConfigured",
  "captureDbPath",
  "captureRestartRequired",
  "captureState",
  "codexConfigBackup",
  "codexConfigPath",
  "configSource",
  "failedWriteCount",
  "health",
  "implementation",
  "lastWriteErrorAt",
  "lastWriteErrorMessage",
  "listenHost",
  "listenPort",
  "logFile",
  "managedStatePath",
  "message",
  "ok",
  "pid",
  "proxyConfigPath",
  "proxyUrl",
  "upstreamBaseUrl"
].sort();

function makeHomeEnv(homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir
  };
}

function runCrp(args, env) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL"
  });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !isProcessAlive(pid);
}

async function cleanupCliHome({ homeDir, env, pid }) {
  const statePath = join(homeDir, ".codex-remote-proxy", "state.json");
  let managedPid = pid;
  let cleanupError;

  try {
    if (!managedPid && existsSync(statePath)) {
      try {
        managedPid = JSON.parse(readFileSync(statePath, "utf8")).pid;
      } catch {
        managedPid = null;
      }
    }
    if (existsSync(statePath)) {
      runCrp(["stop", "--json"], env);
    }
    if (isProcessAlive(managedPid)) {
      try {
        process.kill(managedPid, "SIGTERM");
      } catch {
        // The process may exit between the liveness check and the signal.
      }
    }
    if (isProcessAlive(managedPid) && !(await waitForProcessExit(managedPid))) {
      try {
        process.kill(managedPid, "SIGKILL");
      } catch {
        // The process may exit between the liveness check and the signal.
      }
      if (!(await waitForProcessExit(managedPid))) {
        cleanupError = new Error(`Could not stop test proxy process ${managedPid}`);
      }
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }

  if (cleanupError) {
    throw cleanupError;
  }
}

test("patchCodexConfigText creates the fixed OpenAI provider and preserves custom providers", () => {
  const original = [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    'base_url = "https://old.example/v1"',
    ""
  ].join("\n");

  const once = patchCodexConfigText(original, PROXY_URL);
  const twice = patchCodexConfigText(once, PROXY_URL);

  assert.match(once, /^model_provider = "OpenAI"$/m);
  assert.match(
    once,
    /\[model_providers\.OpenAI\]\nname = "OpenAI"\nbase_url = "http:\/\/127\.0\.0\.1:15100"\nwire_api = "responses"\nrequires_openai_auth = true/
  );
  assert.match(
    once,
    /\[model_providers\.custom\]\nname = "Custom"\nbase_url = "https:\/\/old\.example\/v1"/
  );
  assert.equal(twice, once);
});

test("patchCodexConfigText updates every fixed OpenAI provider field", () => {
  const original = [
    'model_provider = "legacy"',
    "",
    "[model_providers.OpenAI]",
    'name = "Legacy"',
    'base_url = "https://wrong.example/v1"',
    'wire_api = "chat"',
    "requires_openai_auth = false",
    ""
  ].join("\n");

  const patched = patchCodexConfigText(original, PROXY_URL);

  assert.match(patched, /^model_provider = "OpenAI"$/m);
  assert.match(patched, /^name = "OpenAI"$/m);
  assert.match(patched, /^base_url = "http:\/\/127\.0\.0\.1:15100"$/m);
  assert.match(patched, /^wire_api = "responses"$/m);
  assert.match(patched, /^requires_openai_auth = true$/m);
  assert.equal(patchCodexConfigText(patched, PROXY_URL), patched);
});

test("patchCodexConfigText preserves CRLF line endings byte-for-byte after the first patch", () => {
  const original = [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    ""
  ].join("\r\n");

  const once = patchCodexConfigText(original, PROXY_URL);
  const twice = patchCodexConfigText(once, PROXY_URL);

  assert.equal(once.includes("\r\n"), true);
  assert.equal(once.replaceAll("\r\n", "").includes("\n"), false);
  assert.equal(twice, once);
});

test("bootstrapCodexConfig backs up and atomically writes only changed content", () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-config-"));
  const configPath = join(tempDir, "config.toml");
  const original = 'model_provider = "custom"\n';

  try {
    writeFileSync(configPath, original, "utf8");
    chmodSync(configPath, 0o640);

    const first = bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      now: () => new Date("2026-07-10T12:34:56.789Z")
    });

    assert.deepEqual(first, {
      changed: true,
      backupPath: `${configPath}.20260710-123456.bak`
    });
    assert.equal(dirname(first.backupPath), tempDir);
    assert.equal(readFileSync(first.backupPath, "utf8"), original);
    assert.equal(readFileSync(configPath, "utf8"), patchCodexConfigText(original, PROXY_URL));
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
    assert.equal(readdirSync(tempDir).filter((name) => name.endsWith(".bak")).length, 1);

    const firstWriteMtime = statSync(configPath, { bigint: true }).mtimeNs;
    const second = bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      now: () => new Date("2026-07-10T12:35:56.789Z")
    });

    assert.deepEqual(second, { changed: false, backupPath: null });
    assert.equal(statSync(configPath, { bigint: true }).mtimeNs, firstWriteMtime);
    assert.equal(readdirSync(tempDir).filter((name) => name.endsWith(".bak")).length, 1);
    assert.deepEqual(
      readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
      []
    );
    assert.equal(existsSync(`${configPath}.crp.lock`), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig rejects an existing CRP lock without touching the config", () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-busy-"));
  const configPath = join(tempDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const originalBytes = Buffer.from('model_provider = "custom"\n', "utf8");
  const lockBytes = Buffer.from("existing lock owner\n", "utf8");

  try {
    writeFileSync(configPath, originalBytes);
    chmodSync(configPath, 0o640);
    writeFileSync(lockPath, lockBytes);
    const originalMode = statSync(configPath).mode & 0o777;

    assert.throws(
      () => bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL }),
      (error) => error?.code === "CODEX_CONFIG_BUSY"
    );
    assert.deepEqual(readFileSync(configPath), originalBytes);
    assert.equal(statSync(configPath).mode & 0o777, originalMode);
    assert.deepEqual(readFileSync(lockPath), lockBytes);
    assert.deepEqual(
      readdirSync(tempDir).filter((name) => name.endsWith(".bak") || name.endsWith(".tmp")),
      []
    );

    rmSync(lockPath);
    const result = bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL });
    assert.equal(result.changed, true);
    assert.equal(existsSync(result.backupPath), true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig preserves the original and removes its temp file when rename fails", () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-rename-failure-"));
  const configPath = join(tempDir, "config.toml");
  const originalBytes = Buffer.from('model_provider = "custom"\n', "utf8");
  const renameError = new Error("forced atomic rename failure");

  try {
    writeFileSync(configPath, originalBytes);
    chmodSync(configPath, 0o640);
    const originalMode = statSync(configPath).mode & 0o777;

    assert.throws(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        now: () => new Date("2026-07-10T12:36:56.789Z"),
        fileOperations: {
          ...realFileOperations,
          renameSync() {
            throw renameError;
          }
        }
      }),
      (error) => error === renameError
    );

    assert.deepEqual(readFileSync(configPath), originalBytes);
    assert.equal(statSync(configPath).mode & 0o777, originalMode);
    assert.deepEqual(
      readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
      []
    );
    assert.equal(existsSync(`${configPath}.crp.lock`), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig preserves an external source change detected before rename", () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-source-change-"));
  const configPath = join(tempDir, "config.toml");
  const originalBytes = Buffer.from('model_provider = "custom"\n', "utf8");
  const externalBytes = Buffer.from('model_provider = "external"\n', "utf8");
  let sourceReadCount = 0;
  let renameCalled = false;

  try {
    writeFileSync(configPath, originalBytes);

    assert.throws(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          readFileSync(path, ...args) {
            if (path === configPath) {
              sourceReadCount += 1;
              if (sourceReadCount === 2) {
                realFileOperations.writeFileSync(configPath, externalBytes);
              }
            }
            return realFileOperations.readFileSync(path, ...args);
          },
          renameSync(...args) {
            renameCalled = true;
            return realFileOperations.renameSync(...args);
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_CHANGED"
    );

    assert.equal(sourceReadCount, 2);
    assert.equal(renameCalled, false);
    assert.deepEqual(readFileSync(configPath), externalBytes);
    assert.deepEqual(
      readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
      []
    );
    assert.equal(existsSync(`${configPath}.crp.lock`), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig keeps both backups when changes share a timestamp", () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-backup-collision-"));
  const configPath = join(tempDir, "config.toml");
  const original = 'model_provider = "custom"\n';
  const fixedNow = () => new Date("2026-07-10T12:37:56.789Z");

  try {
    writeFileSync(configPath, original, "utf8");

    const first = bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      now: fixedNow
    });
    const firstPatched = readFileSync(configPath, "utf8");
    const secondProxyUrl = "http://127.0.0.1:15101";
    const second = bootstrapCodexConfig({
      configPath,
      proxyUrl: secondProxyUrl,
      now: fixedNow
    });

    assert.equal(first.backupPath, `${configPath}.20260710-123756.bak`);
    assert.equal(second.backupPath, `${configPath}.20260710-123756.1.bak`);
    assert.equal(readFileSync(first.backupPath, "utf8"), original);
    assert.equal(readFileSync(second.backupPath, "utf8"), firstPatched);
    assert.equal(
      readFileSync(configPath, "utf8"),
      patchCodexConfigText(firstPatched, secondProxyUrl)
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const command of ["start", "install", "setup"]) {
  test(`${command} preserves the JSON contract and propagates the Codex backup`, async (t) => {
    const homeDir = mkdtempSync(join(os.tmpdir(), `crp-${command}-home-`));
    const env = makeHomeEnv(homeDir);
    const codexDir = join(homeDir, ".codex");
    const codexConfigPath = join(codexDir, "config.toml");
    const statePath = join(homeDir, ".codex-remote-proxy", "state.json");
    const originalConfig = 'model_provider = "custom"\n';
    const placeholderCredential = ["placeholder", "credential", randomUUID()].join("-");
    const upstreamBaseUrl = "http://127.0.0.1:1/v1";
    let managedPid = null;
    let cleanupPromise;
    const cleanup = () => {
      cleanupPromise ??= cleanupCliHome({ homeDir, env, pid: managedPid });
      return cleanupPromise;
    };
    t.after(cleanup);

    try {
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(codexConfigPath, originalConfig, "utf8");

      const result = runCrp([
        command,
        "--json",
        "--upstream-base-url",
        upstreamBaseUrl,
        "--api-key",
        placeholderCredential
      ], env);

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      managedPid = payload.pid;

      assert.deepEqual(Object.keys(payload).sort(), START_PAYLOAD_KEYS);
      assert.equal(payload.ok, true);
      assert.equal(payload.implementation, "node");
      assert.equal(payload.listenHost, "127.0.0.1");
      assert.equal(payload.upstreamBaseUrl, upstreamBaseUrl);
      assert.equal(payload.codexConfigPath, codexConfigPath);
      assert.equal(payload.configSource.upstreamBaseUrl, "cli");
      assert.equal(payload.configSource.apiKey, "cli");
      assert.equal(payload.configSource.listenPort, "auto");
      assert.equal(payload.message, "Proxy configured and started");
      assert.match(payload.proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(state.pid, payload.pid);
      assert.equal(state.proxyUrl, payload.proxyUrl);
      assert.equal(state.codexConfigBackup, payload.codexConfigBackup);
      assert.equal(existsSync(payload.codexConfigBackup), true);
      assert.equal(readFileSync(payload.codexConfigBackup, "utf8"), originalConfig);
      assert.equal(
        readFileSync(codexConfigPath, "utf8"),
        patchCodexConfigText(originalConfig, payload.proxyUrl)
      );
    } finally {
      await cleanup();
    }
  });
}

test("guide explains that Codex backups are created only for config changes", () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-guide-home-"));
  try {
    const result = runCrp(["guide", "--json"], makeHomeEnv(homeDir));

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(
      payload.notes.find((note) => note.includes("backup")),
      "The start command creates a backup only when it changes ~/.codex/config.toml."
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("getPaths derives every managed path from the injected home", () => {
  const injectedHome = resolve(os.tmpdir(), "crp-injected-home");

  assert.deepEqual(getPaths(injectedHome), {
    globalHome: resolve(injectedHome, ".codex-remote-proxy"),
    registryPath: resolve(injectedHome, ".codex-remote-proxy", "providers.json"),
    secretFallbackPath: resolve(injectedHome, ".codex-remote-proxy", "secrets.json"),
    statePath: resolve(injectedHome, ".codex-remote-proxy", "state.json"),
    controlTokenPath: resolve(injectedHome, ".codex-remote-proxy", "control-token"),
    activityPath: resolve(injectedHome, ".codex-remote-proxy", "activity.jsonl"),
    logPath: resolve(injectedHome, ".codex-remote-proxy", "supervisor.log"),
    codexConfigPath: resolve(injectedHome, ".codex", "config.toml"),
    authPath: resolve(injectedHome, ".codex", "auth.json")
  });
  assert.notEqual(getPaths(injectedHome).globalHome, getPaths().globalHome);
});

test("CrpError retains stable fields and toPublicError exposes only safe fields", () => {
  const cause = new Error("private-cause-message");
  const error = new CrpError(
    "PROVIDER_CONFLICT",
    "That provider already exists.",
    "Choose a different provider name.",
    { status: 409, details: { field: "name" }, cause }
  );

  assert.equal(error.name, "CrpError");
  assert.equal(error.code, "PROVIDER_CONFLICT");
  assert.equal(error.message, "That provider already exists.");
  assert.equal(error.action, "Choose a different provider name.");
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, { field: "name" });
  assert.equal(error.cause, cause);

  const publicError = toPublicError(error, "request-known");
  assert.deepEqual(publicError, {
    error: {
      code: "PROVIDER_CONFLICT",
      message: "That provider already exists.",
      action: "Choose a different provider name.",
      requestId: "request-known",
      details: { field: "name" }
    }
  });
  assert.doesNotMatch(JSON.stringify(publicError), /cause|stack|private-cause-message/);
});

test("toPublicError replaces unknown errors without leaking their message or stack", () => {
  const error = new Error("upstream returned a private credential");
  error.stack = "private stack trace";

  const publicError = toPublicError(error, "request-unknown");

  assert.deepEqual(publicError, {
    error: {
      code: "INTERNAL_ERROR",
      message: "CRP could not complete the operation.",
      action: "Open Activity for details.",
      requestId: "request-unknown",
      details: {}
    }
  });
  assert.doesNotMatch(
    JSON.stringify(publicError),
    /private credential|private stack trace|cause|stack/
  );
});
