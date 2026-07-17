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
import {
  inspectCodexProviderBinding,
  planCodexProviderTransition
} from "../src/codex/codex-history-repair.mjs";
import { CrpError, toPublicError } from "../src/shared/errors.mjs";
import { getPaths } from "../src/shared/paths.mjs";

const PROXY_URL = "http://127.0.0.1:15100";
const NO_HISTORY_REPAIR = Object.freeze({
  required: false,
  completed: false,
  resumed: false,
  backupCreated: false,
  rolloutFiles: 0,
  rolloutRecords: 0,
  sqliteFiles: 0,
  sqliteRows: 0,
  encryptedContentDetected: false
});
const CONFIG_AT_PROXY_NEEDING_PATCH = [
  'model_provider = "custom"',
  "",
  "[model_providers.custom]",
  'name = "Custom"',
  `base_url = "${PROXY_URL}"`,
  ""
].join("\n");
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = join(PACKAGE_ROOT, "bin", "crp.mjs");
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

function expectedBootstrap(changed, backupPath) {
  return { changed, backupPath, historyRepair: NO_HISTORY_REPAIR };
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

test("patchCodexConfigText uses semantic TOML paths and ignores multiline decoys", () => {
  const decoy = [
    'developer_instructions = """',
    "[model_providers.OpenAI]",
    'base_url = "https://decoy.example/v1"',
    'model_provider = "decoy"',
    '"""'
  ].join("\n");
  const original = [
    decoy,
    '"model_provider" = "legacy"',
    "",
    "[ 'model_providers' . 'legacy' ] # retained provider",
    "'base_url' = 'https://legacy.example/v1'",
    "",
    "[ 'model_providers' . \"OpenAI\" ] # managed provider",
    "'name' = 'Wrong'",
    "'base_url' = 'https://wrong.example/v1'",
    "'wire_api' = 'chat'",
    "'requires_openai_auth' = false",
    ""
  ].join("\n");

  const patched = patchCodexConfigText(original, PROXY_URL);

  assert.equal(patched.includes(decoy), true);
  assert.equal(patched.includes("[ 'model_providers' . \"OpenAI\" ] # managed provider"), true);
  assert.equal(patched.includes('"model_provider" = "legacy"'), false);
  assert.deepEqual(inspectCodexProviderBinding(patched), {
    providerName: "OpenAI",
    baseUrl: PROXY_URL,
    normalizedBaseUrl: `${PROXY_URL}/`
  });
  assert.equal(patchCodexConfigText(patched, PROXY_URL), patched);
});

test("patchCodexConfigText fails closed on conflicting or invalid TOML key paths", () => {
  const invalidSources = [
    'model_provider. = "legacy"\n',
    '\"\"\"model_provider\"\"\" = "legacy"\n',
    'model_provider.child = "legacy"\n',
    'model_providers = { OpenAI = {} }\n',
    '[model_provider]\nchild = "legacy"\n',
    [
      'model_provider = "OpenAI"',
      "[model_providers.OpenAI]",
      "[model_providers.OpenAI.base_url]",
      'child = "legacy"',
      ""
    ].join("\n"),
    [
      'model_provider = "OpenAI"',
      "[[model_providers.OpenAI.base_url]]",
      'child = "legacy"',
      ""
    ].join("\n"),
  ];

  for (const source of invalidSources) {
    assert.throws(
      () => patchCodexConfigText(source, PROXY_URL),
      (error) => error?.code === "CODEX_HISTORY_REPAIR_INVALID"
    );
  }
});

test("patchCodexConfigText supports root and parent dotted provider fields", () => {
  const cases = [
    [
      'model_provider = "legacy"',
      'model_providers.OpenAI.base_url = "https://wrong.example/v1"',
      'model_providers.OpenAI.custom = "retained"',
      ""
    ].join("\n"),
    [
      'model_provider = "legacy"',
      "[model_providers]",
      'OpenAI.base_url = "https://wrong.example/v1"',
      'OpenAI.custom = "retained"',
      ""
    ].join("\n")
  ];

  for (const source of cases) {
    const patched = patchCodexConfigText(source, PROXY_URL);
    assert.deepEqual(inspectCodexProviderBinding(patched), {
      providerName: "OpenAI",
      baseUrl: PROXY_URL,
      normalizedBaseUrl: `${PROXY_URL}/`
    });
    assert.equal(patched.includes('custom = "retained"'), true);
    assert.equal(patchCodexConfigText(patched, PROXY_URL), patched);
  }
});

test("bootstrapCodexConfig safely upgrades a dotted provider binding", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-dotted-bootstrap-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const source = [
    'model_provider = "legacy"',
    'model_providers.legacy.base_url = "https://legacy.example/v1"',
    'model_providers.OpenAI.base_url = "https://wrong.example/v1"',
    'model_providers.OpenAI.custom = "retained"',
    ""
  ].join("\n");
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexDir, { mode: 0o700 });
  writeFileSync(configPath, source, { mode: 0o600 });

  const result = await bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL });
  const patched = readFileSync(configPath, "utf8");

  assert.equal(result.changed, true);
  assert.equal(result.historyRepair.required, true);
  assert.equal(result.historyRepair.completed, true);
  assert.equal(patched.includes('model_providers.OpenAI.custom = "retained"'), true);
  assert.deepEqual(inspectCodexProviderBinding(patched), {
    providerName: "OpenAI",
    baseUrl: PROXY_URL,
    normalizedBaseUrl: `${PROXY_URL}/`
  });
});

test("config-only completion failure reports committed degradation without pending", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-config-only-degraded-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  let lockRenames = 0;
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexDir, { mode: 0o700 });
  writeFileSync(configPath, CONFIG_AT_PROXY_NEEDING_PATCH, { mode: 0o600 });

  const error = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    fileOperations: {
      ...realFileOperations,
      renameSync(source, destination, ...args) {
        if (destination === lockPath) {
          lockRenames += 1;
          if (lockRenames === 2) throw new Error("simulated completion failure");
        }
        return realFileOperations.renameSync(source, destination, ...args);
      }
    }
  }).then(() => null, (failure) => failure);

  assert.equal(error?.code, "CODEX_CONFIG_COMMITTED_DEGRADED");
  assert.deepEqual(error?.details, { committed: true, degraded: true, pending: false });
  assert.equal(readFileSync(configPath, "utf8"),
    patchCodexConfigText(CONFIG_AT_PROXY_NEEDING_PATCH, PROXY_URL));
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(join(codexDir, ".crp-history-repair")), false);
});

test("config-only completion rechecks the published config before returning success", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-config-only-final-check-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const foreignConfig = 'model_provider = "foreign"\n';
  let lockRenames = 0;
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexDir, { mode: 0o700 });
  writeFileSync(configPath, CONFIG_AT_PROXY_NEEDING_PATCH, { mode: 0o600 });

  const error = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    fileOperations: {
      ...realFileOperations,
      renameSync(source, destination, ...args) {
        const result = realFileOperations.renameSync(source, destination, ...args);
        if (destination === lockPath) {
          lockRenames += 1;
          if (lockRenames === 2) writeFileSync(configPath, foreignConfig, "utf8");
        }
        return result;
      }
    }
  }).then(() => null, (failure) => failure);

  assert.equal(error?.code, "CODEX_CONFIG_COMMITTED_DEGRADED");
  assert.deepEqual(error?.details, { committed: true, degraded: true, pending: false });
  assert.equal(readFileSync(configPath, "utf8"), foreignConfig);
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(join(codexDir, ".crp-history-repair")), false);
});

test("successful config-only commit maps lock-release failure to pending-false degradation", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-config-release-degraded-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  let releaseFailed = false;
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexDir, { mode: 0o700 });
  writeFileSync(configPath, CONFIG_AT_PROXY_NEEDING_PATCH, { mode: 0o600 });

  const error = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    fileOperations: {
      ...realFileOperations,
      rmSync(path, ...args) {
        if (!releaseFailed && path.endsWith(".release")) {
          releaseFailed = true;
          throw new Error("simulated config lock release failure");
        }
        return realFileOperations.rmSync(path, ...args);
      }
    }
  }).then(() => null, (failure) => failure);

  assert.equal(releaseFailed, true);
  assert.equal(error?.code, "CODEX_CONFIG_COMMITTED_DEGRADED");
  assert.deepEqual(error?.details, { committed: true, degraded: true, pending: false });
  assert.equal(readFileSync(configPath, "utf8"),
    patchCodexConfigText(CONFIG_AT_PROXY_NEEDING_PATCH, PROXY_URL));
  assert.equal(existsSync(lockPath), true);
});

test("successful history repair maps lock-release failure to pending-false degradation", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-history-release-degraded-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const pendingPath = join(codexRoot, ".crp-history-repair", "pending.json");
  const clearingPath = `${pendingPath}.clearing`;
  const rolloutPath = join(codexRoot, "sessions", "rollout-release-degraded.jsonl");
  const source = [
    'model_provider = "legacy"',
    "[model_providers.legacy]",
    'base_url = "https://legacy.example/v1"',
    ""
  ].join("\n");
  let releaseFailed = false;
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(dirname(rolloutPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, source, { mode: 0o600 });
  writeFileSync(rolloutPath, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "release-degraded", model_provider: "legacy" }
  })}\n`, { mode: 0o600 });

  const error = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    fileOperations: {
      ...realFileOperations,
      rmSync(path, ...args) {
        if (!releaseFailed && path.endsWith(".release")) {
          releaseFailed = true;
          throw new Error("simulated config lock release failure");
        }
        return realFileOperations.rmSync(path, ...args);
      }
    }
  }).then(() => null, (failure) => failure);

  assert.equal(releaseFailed, true);
  assert.equal(error?.code, "CODEX_CONFIG_COMMITTED_DEGRADED");
  assert.deepEqual(error?.details, { committed: true, degraded: true, pending: false });
  assert.equal(JSON.parse(readFileSync(rolloutPath, "utf8")).payload.model_provider,
    "OpenAI");
  assert.equal(existsSync(pendingPath), false);
  assert.equal(existsSync(clearingPath), false);
  assert.equal(existsSync(lockPath), true);
});

test("bootstrapCodexConfig privately creates a missing Codex directory and config once", async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-clean-home-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const expectedText = patchCodexConfigText("", PROXY_URL);

  try {
    assert.equal(existsSync(codexDir), false);

    const first = await bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL });

    assert.deepEqual(first, expectedBootstrap(true, null));
    assert.equal(readFileSync(configPath, "utf8"), expectedText);
    if (process.platform !== "win32") {
      assert.equal(statSync(codexDir).mode & 0o777, 0o700);
      assert.equal(statSync(configPath).mode & 0o777, 0o600);
    }
    assert.deepEqual(readdirSync(codexDir), ["config.toml"]);

    const firstBytes = readFileSync(configPath);
    const firstMtime = statSync(configPath, { bigint: true }).mtimeNs;
    const second = await bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL });

    assert.deepEqual(second, expectedBootstrap(false, null));
    assert.deepEqual(readFileSync(configPath), firstBytes);
    assert.equal(statSync(configPath, { bigint: true }).mtimeNs, firstMtime);
    assert.deepEqual(readdirSync(codexDir), ["config.toml"]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig does not overwrite a config that appears during first publish", async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-create-race-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const externalBytes = Buffer.from('model_provider = "external"\n', "utf8");
  let appearanceInjected = false;
  const injectAppearance = () => {
    if (appearanceInjected) return;
    appearanceInjected = true;
    realFileOperations.writeFileSync(configPath, externalBytes, { flag: "wx" });
  };

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          linkSync(source, target) {
            if (target === configPath) injectAppearance();
            return realFileOperations.linkSync(source, target);
          },
          renameSync(source, target) {
            if (target === configPath) injectAppearance();
            return realFileOperations.renameSync(source, target);
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_CHANGED"
    );

    assert.equal(appearanceInjected, true);
    assert.deepEqual(readFileSync(configPath), externalBytes);
    assert.equal(existsSync(`${configPath}.crp.lock`), false);
    assert.deepEqual(
      readdirSync(codexDir).filter((name) => name.endsWith(".tmp") || name.endsWith(".bak")),
      []
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig rejects a changed parent identity before publishing", async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-parent-race-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  let parentReads = 0;

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          lstatSync(path, ...args) {
            const identity = realFileOperations.lstatSync(path, ...args);
            if (path !== codexDir) return identity;
            parentReads += 1;
            if (parentReads < 2) return identity;
            const changed = Object.create(identity);
            Object.defineProperty(changed, "ino", {
              value: typeof identity.ino === "bigint" ? identity.ino + 1n : identity.ino + 1
            });
            return changed;
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_PARENT_UNSAFE"
    );

    assert.ok(parentReads >= 2);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(`${configPath}.crp.lock`), true);
    assert.deepEqual(readdirSync(codexDir), ["config.toml.crp.lock"]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig never removes a foreign lock replacement", async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-lock-replacement-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const foreignLockBytes = Buffer.from("foreign lock replacement\n", "utf8");
  let lockDescriptor;
  let replaced = false;

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          openSync(path, ...args) {
            const descriptor = realFileOperations.openSync(path, ...args);
            if (path === lockPath) lockDescriptor = descriptor;
            return descriptor;
          },
          closeSync(descriptor) {
            realFileOperations.closeSync(descriptor);
            if (descriptor === lockDescriptor && !replaced) {
              replaced = true;
              realFileOperations.rmSync(lockPath);
              realFileOperations.writeFileSync(lockPath, foreignLockBytes);
            }
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_WRITE_FAILED"
    );

    assert.equal(replaced, true);
    assert.deepEqual(readFileSync(lockPath), foreignLockBytes);
    assert.equal(existsSync(configPath), false);
    assert.deepEqual(
      readdirSync(codexDir).filter((name) => name.endsWith(".tmp") || name.endsWith(".bak")),
      []
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig retains a foreign lock when lock identity acquisition fails", async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-lock-identity-failure-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const foreignLockBytes = Buffer.from("foreign lock after identity failure\n", "utf8");
  const identityFailure = new Error("forced lock identity failure");
  let lockDescriptor;

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          openSync(path, ...args) {
            const descriptor = realFileOperations.openSync(path, ...args);
            if (path === lockPath) lockDescriptor = descriptor;
            return descriptor;
          },
          fstatSync(descriptor, ...args) {
            if (descriptor === lockDescriptor) {
              realFileOperations.rmSync(lockPath);
              realFileOperations.writeFileSync(lockPath, foreignLockBytes);
              throw identityFailure;
            }
            return realFileOperations.fstatSync(descriptor, ...args);
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_WRITE_FAILED"
        && error?.cause === identityFailure
    );

    assert.deepEqual(readFileSync(lockPath), foreignLockBytes);
    assert.equal(existsSync(configPath), false);
    await assert.rejects(
      () => bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL }),
      (error) => error?.code === "CODEX_CONFIG_BUSY"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig atomically claims a lock before removing owned state", async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-lock-claim-race-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const foreignLockBytes = Buffer.from("foreign lock in cleanup race\n", "utf8");
  let injected = false;
  const injectReplacement = () => {
    if (injected) return;
    injected = true;
    const displacedPath = `${lockPath}.displaced`;
    realFileOperations.renameSync(lockPath, displacedPath);
    realFileOperations.rmSync(displacedPath);
    realFileOperations.writeFileSync(lockPath, foreignLockBytes);
  };

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          renameSync(source, target, ...args) {
            if (source === lockPath && /\.(?:claim|release)$/.test(target)) {
              injectReplacement();
            }
            return realFileOperations.renameSync(source, target, ...args);
          },
          rmSync(path, ...args) {
            if (path === lockPath) injectReplacement();
            return realFileOperations.rmSync(path, ...args);
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_COMMITTED_DEGRADED"
        && error?.details?.committed === true
        && error?.details?.degraded === true
        && error?.details?.pending === false
    );

    assert.equal(injected, true);
    assert.deepEqual(readFileSync(lockPath), foreignLockBytes);
    assert.equal(readFileSync(configPath, "utf8"), patchCodexConfigText("", PROXY_URL));
    assert.deepEqual(
      readdirSync(codexDir).filter((name) => name.endsWith(".claim") || name.endsWith(".release")),
      []
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig atomically claims a temp before cleanup", async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-temp-claim-race-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const foreignTempBytes = Buffer.from("foreign temp in cleanup race\n", "utf8");
  const publishFailure = new Error("forced first publish failure");
  let tempPath;
  let injected = false;
  const injectReplacement = () => {
    if (injected) return;
    injected = true;
    const displacedPath = `${tempPath}.displaced`;
    realFileOperations.renameSync(tempPath, displacedPath);
    realFileOperations.rmSync(displacedPath);
    realFileOperations.writeFileSync(tempPath, foreignTempBytes);
  };

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          openSync(path, ...args) {
            const descriptor = realFileOperations.openSync(path, ...args);
            if (path.endsWith(".tmp")) tempPath = path;
            return descriptor;
          },
          linkSync(source, target, ...args) {
            if (target === configPath) throw publishFailure;
            return realFileOperations.linkSync(source, target, ...args);
          },
          renameSync(source, target, ...args) {
            if (source === tempPath && target.endsWith(".claim")) injectReplacement();
            return realFileOperations.renameSync(source, target, ...args);
          },
          rmSync(path, ...args) {
            if (path === tempPath) injectReplacement();
            return realFileOperations.rmSync(path, ...args);
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_WRITE_FAILED"
        && error?.cause === publishFailure
    );

    assert.equal(injected, true);
    assert.deepEqual(readFileSync(tempPath), foreignTempBytes);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(`${configPath}.crp.lock`), false);
    assert.deepEqual(
      readdirSync(codexDir).filter((name) => name.endsWith(".claim")),
      []
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig preserves a primary write failure over lock cleanup failure", async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-primary-failure-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const primaryFailure = new Error("forced primary write failure");
  const cleanupFailure = new Error("forced lock close failure");
  let lockDescriptor;
  let tempDescriptor;
  let lockCloseFailed = false;
  let primaryThrown = false;

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          openSync(path, ...args) {
            const descriptor = realFileOperations.openSync(path, ...args);
            if (path === lockPath) lockDescriptor = descriptor;
            else if (path.endsWith(".tmp")) tempDescriptor = descriptor;
            return descriptor;
          },
          writeFileSync(target, ...args) {
            if (target === tempDescriptor) {
              primaryThrown = true;
              throw primaryFailure;
            }
            return realFileOperations.writeFileSync(target, ...args);
          },
          closeSync(descriptor) {
            realFileOperations.closeSync(descriptor);
            if (descriptor === lockDescriptor && primaryThrown && !lockCloseFailed) {
              lockCloseFailed = true;
              throw cleanupFailure;
            }
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_WRITE_FAILED"
        && error?.cause === primaryFailure
    );

    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(readdirSync(codexDir), []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig classifies private filesystem read and write failures", async () => {
  for (const failureCase of [
    {
      name: "read",
      code: "CODEX_CONFIG_READ_FAILED",
      prepare(configPath) {
        writeFileSync(configPath, CONFIG_AT_PROXY_NEEDING_PATCH, "utf8");
      },
      operations(configPath, privateFailure) {
        let sourceDescriptor;
        return {
          ...realFileOperations,
          openSync(path, ...args) {
            const descriptor = realFileOperations.openSync(path, ...args);
            if (path === configPath) sourceDescriptor = descriptor;
            return descriptor;
          },
          readFileSync(target, ...args) {
            if (target === configPath || target === sourceDescriptor) throw privateFailure;
            return realFileOperations.readFileSync(target, ...args);
          }
        };
      }
    },
    {
      name: "write",
      code: "CODEX_CONFIG_WRITE_FAILED",
      prepare() {},
      operations(_configPath, privateFailure) {
        let tempDescriptor;
        return {
          ...realFileOperations,
          openSync(path, ...args) {
            const descriptor = realFileOperations.openSync(path, ...args);
            if (path.endsWith(".tmp")) tempDescriptor = descriptor;
            return descriptor;
          },
          fsyncSync(descriptor) {
            if (descriptor === tempDescriptor) throw privateFailure;
            return realFileOperations.fsyncSync(descriptor);
          }
        };
      }
    }
  ]) {
    const homeDir = mkdtempSync(join(os.tmpdir(), `crp-codex-${failureCase.name}-failure-`));
    const codexDir = join(homeDir, ".codex");
    const configPath = join(codexDir, "config.toml");
    const privateMarker = `private-${failureCase.name}-filesystem-detail`;
    const privateFailure = new Error(privateMarker);
    let caught;
    try {
      mkdirSync(codexDir, { mode: 0o700 });
      failureCase.prepare(configPath);
      try {
        await bootstrapCodexConfig({
          configPath,
          proxyUrl: PROXY_URL,
          fileOperations: failureCase.operations(configPath, privateFailure)
        });
      } catch (error) {
        caught = error;
      }

      assert.ok(caught);
      assert.equal(caught.message.includes(privateMarker), false);
      assert.equal(caught.code, failureCase.code);
      assert.equal(caught.cause, privateFailure);
      assert.equal(existsSync(`${configPath}.crp.lock`), false);
      assert.deepEqual(
        readdirSync(codexDir).filter((name) => name.endsWith(".tmp") || name.endsWith(".bak")),
        []
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
});

test("bootstrapCodexConfig backs up and atomically writes only changed content", async () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-config-"));
  const configPath = join(tempDir, "config.toml");
  const original = CONFIG_AT_PROXY_NEEDING_PATCH;

  try {
    writeFileSync(configPath, original, "utf8");
    chmodSync(configPath, 0o640);

    const first = await bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      now: () => new Date("2026-07-10T12:34:56.789Z")
    });

    assert.deepEqual(first, expectedBootstrap(
      true,
      `${configPath}.20260710-123456.bak`
    ));
    assert.equal(dirname(first.backupPath), tempDir);
    assert.equal(readFileSync(first.backupPath, "utf8"), original);
    assert.equal(readFileSync(configPath, "utf8"), patchCodexConfigText(original, PROXY_URL));
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
    assert.equal(readdirSync(tempDir).filter((name) => name.endsWith(".bak")).length, 1);

    const firstWriteMtime = statSync(configPath, { bigint: true }).mtimeNs;
    const second = await bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      now: () => new Date("2026-07-10T12:35:56.789Z")
    });

    assert.deepEqual(second, expectedBootstrap(false, null));
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

test("bootstrapCodexConfig rejects an existing CRP lock without touching the config", async () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-busy-"));
  const configPath = join(tempDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const originalBytes = Buffer.from(CONFIG_AT_PROXY_NEEDING_PATCH, "utf8");
  const lockBytes = Buffer.from("existing lock owner\n", "utf8");

  try {
    writeFileSync(configPath, originalBytes);
    chmodSync(configPath, 0o640);
    writeFileSync(lockPath, lockBytes);
    const originalMode = statSync(configPath).mode & 0o777;

    await assert.rejects(
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
    const result = await bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL });
    assert.equal(result.changed, true);
    assert.equal(existsSync(result.backupPath), true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig preserves the original and removes its temp file when rename fails", async () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-rename-failure-"));
  const configPath = join(tempDir, "config.toml");
  const originalBytes = Buffer.from(CONFIG_AT_PROXY_NEEDING_PATCH, "utf8");
  const renameError = new Error("forced atomic rename failure");

  try {
    writeFileSync(configPath, originalBytes);
    chmodSync(configPath, 0o640);
    const originalMode = statSync(configPath).mode & 0o777;

    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        now: () => new Date("2026-07-10T12:36:56.789Z"),
        fileOperations: {
          ...realFileOperations,
          renameSync(source, target, ...args) {
            if (target === configPath) throw renameError;
            return realFileOperations.renameSync(source, target, ...args);
          }
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_WRITE_FAILED"
        && error?.cause === renameError
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

test("bootstrapCodexConfig preserves an external source change detected before rename", async () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-source-change-"));
  const configPath = join(tempDir, "config.toml");
  const originalBytes = Buffer.from(CONFIG_AT_PROXY_NEEDING_PATCH, "utf8");
  const externalBytes = Buffer.from('model_provider = "external"\n', "utf8");
  let sourceReadCount = 0;
  const sourceDescriptors = new Set();
  let renameCalled = false;

  try {
    writeFileSync(configPath, originalBytes);

    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          openSync(path, ...args) {
            const descriptor = realFileOperations.openSync(path, ...args);
            if (path === configPath) sourceDescriptors.add(descriptor);
            return descriptor;
          },
          closeSync(descriptor) {
            sourceDescriptors.delete(descriptor);
            return realFileOperations.closeSync(descriptor);
          },
          readFileSync(target, ...args) {
            if (target === configPath || sourceDescriptors.has(target)) {
              sourceReadCount += 1;
              if (sourceReadCount === 2) {
                realFileOperations.writeFileSync(configPath, externalBytes);
              }
            }
            return realFileOperations.readFileSync(target, ...args);
          },
          renameSync(source, target, ...args) {
            if (target === configPath) renameCalled = true;
            return realFileOperations.renameSync(source, target, ...args);
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

test("bootstrapCodexConfig keeps both backups when changes share a timestamp", async () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-backup-collision-"));
  const configPath = join(tempDir, "config.toml");
  const original = CONFIG_AT_PROXY_NEEDING_PATCH;
  const fixedNow = () => new Date("2026-07-10T12:37:56.789Z");

  try {
    writeFileSync(configPath, original, "utf8");

    const first = await bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      now: fixedNow
    });
    const firstPatched = readFileSync(configPath, "utf8");
    const secondSource = firstPatched.replace('name = "OpenAI"', 'name = "Legacy"');
    writeFileSync(configPath, secondSource, "utf8");
    const second = await bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      now: fixedNow
    });

    assert.equal(first.backupPath, `${configPath}.20260710-123756.bak`);
    assert.equal(second.backupPath, `${configPath}.20260710-123756.1.bak`);
    assert.equal(readFileSync(first.backupPath, "utf8"), original);
    assert.equal(readFileSync(second.backupPath, "utf8"), secondSource);
    assert.equal(
      readFileSync(configPath, "utf8"),
      patchCodexConfigText(secondSource, PROXY_URL)
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig rejects an existing config symlink without changing its target", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation requires platform privileges");
    return;
  }
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-config-symlink-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const targetPath = join(homeDir, "target.toml");
  const targetBytes = Buffer.from('model_provider = "external"\n', "utf8");

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    writeFileSync(targetPath, targetBytes);
    realFileOperations.symlinkSync(targetPath, configPath);

    await assert.rejects(
      () => bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL }),
      (error) => error?.code === "CODEX_CONFIG_READ_FAILED"
    );

    assert.equal(realFileOperations.lstatSync(configPath).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(targetPath), targetBytes);
    assert.equal(existsSync(`${configPath}.crp.lock`), false);
    assert.deepEqual(
      readdirSync(codexDir).filter((name) => name.endsWith(".bak") || name.endsWith(".tmp")),
      []
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig rejects invalid UTF-8 before backup, journal, or config writes", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-invalid-utf8-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const bytes = Buffer.concat([
    Buffer.from(patchCodexConfigText("", PROXY_URL), "utf8"),
    Buffer.from("# invalid utf8 ", "utf8"),
    Buffer.from([0xff]),
    Buffer.from("\n", "utf8")
  ]);
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexDir, { mode: 0o700 });
  writeFileSync(configPath, bytes, { mode: 0o600 });

  await assert.rejects(
    () => bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL }),
    (error) => error?.code === "CODEX_CONFIG_READ_FAILED"
  );

  assert.deepEqual(readFileSync(configPath), bytes);
  assert.deepEqual(readdirSync(codexDir), ["config.toml"]);
});

for (const replacementPhase of ["after-read", "after-backup"]) {
  test(`bootstrapCodexConfig rejects a same-byte inode replacement ${replacementPhase}`, async () => {
    const homeDir = mkdtempSync(join(os.tmpdir(), `crp-codex-config-${replacementPhase}-`));
    const codexDir = join(homeDir, ".codex");
    const configPath = join(codexDir, "config.toml");
    const originalBytes = Buffer.from(CONFIG_AT_PROXY_NEEDING_PATCH, "utf8");
    let sourceDescriptor;
    let backupDescriptor;
    let replaced = false;
    const replacedIdentity = (identity) => {
      const changed = Object.create(identity);
      Object.defineProperty(changed, "ino", {
        value: typeof identity.ino === "bigint" ? identity.ino + 1n : identity.ino + 1
      });
      return changed;
    };

    try {
      mkdirSync(codexDir, { mode: 0o700 });
      writeFileSync(configPath, originalBytes);
      chmodSync(configPath, 0o640);

      await assert.rejects(
        () => bootstrapCodexConfig({
          configPath,
          proxyUrl: PROXY_URL,
          now: () => new Date("2026-07-10T12:38:56.789Z"),
          fileOperations: {
            ...realFileOperations,
            openSync(path, ...args) {
              const descriptor = realFileOperations.openSync(path, ...args);
              if (path === configPath) sourceDescriptor = descriptor;
              if (path.startsWith(`${configPath}.`) && path.endsWith(".bak")) {
                backupDescriptor = descriptor;
              }
              return descriptor;
            },
            readFileSync(target, ...args) {
              const value = realFileOperations.readFileSync(target, ...args);
              if (replacementPhase === "after-read"
                && !replaced
                && (target === configPath || target === sourceDescriptor)) {
                replaced = true;
              }
              return value;
            },
            writeFileSync(target, ...args) {
              const value = realFileOperations.writeFileSync(target, ...args);
              if (replacementPhase === "after-backup" && target === backupDescriptor) {
                replaced = true;
              }
              return value;
            },
            lstatSync(path, ...args) {
              const identity = realFileOperations.lstatSync(path, ...args);
              return path === configPath && replaced
                ? replacedIdentity(identity)
                : identity;
            }
          }
        }),
        (error) => error?.code === "CODEX_CONFIG_CHANGED"
      );

      assert.equal(replaced, true);
      assert.deepEqual(readFileSync(configPath), originalBytes);
      assert.equal(statSync(configPath).mode & 0o777, 0o640);
      assert.equal(existsSync(`${configPath}.crp.lock`), false);
      assert.equal(
        readdirSync(codexDir).filter((name) => name.endsWith(".bak")).length,
        replacementPhase === "after-backup" ? 1 : 0
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
}

test("bootstrap plans from the locked root provider and journals before config publication", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-history-bootstrap-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const pendingDir = join(codexRoot, ".crp-history-repair");
  const pendingPath = join(pendingDir, "pending.json");
  const original = [
    'model_provider = "legacy"',
    "",
    "[model_providers.legacy]",
    'name = "Legacy"',
    'base_url = "https://legacy.example/v1"',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    `base_url = "${PROXY_URL}"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n");
  const target = patchCodexConfigText(original, PROXY_URL);
  const planInputs = [];
  const events = [];
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(configPath, original, "utf8");

  const result = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    historyRepair: {
      plan(input) {
        planInputs.push(input);
        return planCodexProviderTransition(input);
      },
      hasPending() {
        return false;
      },
      async run(input) {
        events.push("repair-started");
        assert.deepEqual(input.currentConfigBytes, Buffer.from(original));
        assert.deepEqual(input.targetConfigBytes, Buffer.from(target));
        assert.equal(input.transition.required, true);
        assert.equal(readFileSync(configPath, "utf8"), original);
        mkdirSync(pendingDir, { mode: 0o700 });
        writeFileSync(pendingPath, "pending-before-config\n", { mode: 0o600 });
        events.push("journal-created");
        const publishResult = await input.publishConfig();
        events.push("config-published");
        assert.equal(readFileSync(configPath, "utf8"), target);
        rmSync(pendingDir, { recursive: true });
        return {
          handled: true,
          configPublished: true,
          publishResult,
          historyRepair: {
            required: true,
            completed: true,
            resumed: false,
            backupCreated: true,
            rolloutFiles: 2,
            rolloutRecords: 3,
            sqliteFiles: 1,
            sqliteRows: 4,
            encryptedContentDetected: false
          }
        };
      }
    }
  });

  assert.equal(planInputs.length, 1);
  assert.equal(planInputs[0].sourceExists, true);
  assert.equal(planInputs[0].sourceText, original);
  assert.equal(planInputs[0].targetText, target);
  assert.equal(planInputs[0].targetProvider, "OpenAI");
  assert.equal(planInputs[0].targetBaseUrl, PROXY_URL);
  assert.deepEqual(events, ["repair-started", "journal-created", "config-published"]);
  assert.equal(existsSync(pendingPath), false);
  assert.equal(result.changed, true);
  assert.equal(typeof result.backupPath, "string");
  assert.deepEqual(result.historyRepair, {
    required: true,
    completed: true,
    resumed: false,
    backupCreated: true,
    rolloutFiles: 2,
    rolloutRecords: 3,
    sqliteFiles: 1,
    sqliteRows: 4,
    encryptedContentDetected: false
  });
});

test("bootstrap skips history repair for the same effective URL and first creation", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-history-skip-"));
  const existingRoot = join(homeDir, "existing", ".codex");
  const newRoot = join(homeDir, "new", ".codex");
  const existingConfigPath = join(existingRoot, "config.toml");
  const newConfigPath = join(newRoot, "config.toml");
  const matching = `${patchCodexConfigText("", PROXY_URL)}\n[model_providers.unused]\nbase_url = "https://unused.example/v1"\n`;
  const planInputs = [];
  let runCalls = 0;
  const historyRepair = {
    plan(input) {
      planInputs.push(input);
      return planCodexProviderTransition(input);
    },
    hasPending() {
      return false;
    },
    async run() {
      runCalls += 1;
      assert.fail("A non-transition bootstrap must not run history repair");
    }
  };
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(existingRoot, { recursive: true });
  mkdirSync(dirname(newRoot), { recursive: true });
  writeFileSync(existingConfigPath, matching, "utf8");

  const matchingResult = await bootstrapCodexConfig({
    configPath: existingConfigPath,
    proxyUrl: PROXY_URL,
    historyRepair
  });
  const creationResult = await bootstrapCodexConfig({
    configPath: newConfigPath,
    proxyUrl: PROXY_URL,
    historyRepair
  });

  assert.deepEqual(matchingResult, expectedBootstrap(false, null));
  assert.deepEqual(creationResult, expectedBootstrap(true, null));
  assert.equal(runCalls, 0);
  assert.equal(planInputs.length, 2);
  assert.equal(planInputs[0].sourceExists, true);
  assert.equal(planInputs[1].sourceExists, false);
  assert.equal(planInputs[0].sourceText, matching);
  assert.equal(planInputs[1].sourceText, "");
});

test("bootstrap resumes pending history repair after config already matches", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-history-resume-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const matching = patchCodexConfigText("", PROXY_URL);
  let runCalls = 0;
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(configPath, matching, "utf8");
  const originalMtime = statSync(configPath, { bigint: true }).mtimeNs;

  const result = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    historyRepair: {
      plan: planCodexProviderTransition,
      hasPending({ codexRoot: receivedRoot }) {
        assert.equal(receivedRoot, codexRoot);
        return true;
      },
      async run(input) {
        runCalls += 1;
        assert.equal(input.transition.required, false);
        assert.deepEqual(input.currentConfigBytes, Buffer.from(matching));
        assert.deepEqual(input.targetConfigBytes, Buffer.from(matching));
        assert.equal(readFileSync(configPath, "utf8"), matching);
        return {
          handled: true,
          configPublished: true,
          publishResult: undefined,
          historyRepair: {
            required: true,
            completed: true,
            resumed: true,
            backupCreated: true,
            rolloutFiles: 1,
            rolloutRecords: 2,
            sqliteFiles: 1,
            sqliteRows: 3,
            encryptedContentDetected: false
          }
        };
      }
    }
  });

  assert.equal(runCalls, 1);
  assert.deepEqual(result, {
    changed: false,
    backupPath: null,
    historyRepair: {
      required: true,
      completed: true,
      resumed: true,
      backupCreated: true,
      rolloutFiles: 1,
      rolloutRecords: 2,
      sqliteFiles: 1,
      sqliteRows: 3,
      encryptedContentDetected: false
    }
  });
  assert.equal(readFileSync(configPath, "utf8"), matching);
  assert.equal(statSync(configPath, { bigint: true }).mtimeNs, originalMtime);
});

test("ambiguous root provider binding fails closed before history or config writes", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-history-ambiguous-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const ambiguous = [
    'model_provider = "one"',
    'model_provider = "two"',
    "",
    "[model_providers.one]",
    'base_url = "https://one.example/v1"',
    "",
    "[model_providers.two]",
    'base_url = "https://two.example/v1"',
    ""
  ].join("\n");
  let runCalls = 0;
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(configPath, ambiguous, "utf8");

  await assert.rejects(
    () => bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      historyRepair: {
        plan: planCodexProviderTransition,
        hasPending() { return false; },
        async run() { runCalls += 1; }
      }
    }),
    (error) => error?.code === "CODEX_HISTORY_REPAIR_INVALID"
  );

  assert.equal(runCalls, 0);
  assert.equal(readFileSync(configPath, "utf8"), ambiguous);
  assert.equal(existsSync(join(codexRoot, ".crp-history-repair")), false);
  assert.deepEqual(readdirSync(codexRoot), ["config.toml"]);
});

test("mixed implicit and explicit selected-provider bindings fail before writes", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-history-mixed-binding-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const source = [
    'model_provider = "legacy"',
    'model_providers.legacy.base_url = "https://legacy.example/v1"',
    "[model_providers.legacy]",
    'name = "Legacy"',
    ""
  ].join("\n");
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(configPath, source, "utf8");

  await assert.rejects(
    () => bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL }),
    (error) => error?.code === "CODEX_HISTORY_REPAIR_INVALID"
  );

  assert.equal(readFileSync(configPath, "utf8"), source);
  assert.deepEqual(readdirSync(codexRoot), ["config.toml"]);
});

test("committed repair failure preserves the new config and pending journal", async (t) => {
  const secret = "history-repair-private-complete-secret";
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-history-degraded-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const pendingDir = join(codexRoot, ".crp-history-repair");
  const pendingPath = join(pendingDir, "pending.json");
  const original = [
    'model_provider = "legacy"',
    "",
    "[model_providers.legacy]",
    'base_url = "https://legacy.example/v1"',
    ""
  ].join("\n");
  const target = patchCodexConfigText(original, PROXY_URL);
  let publicFailure;
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(configPath, original, "utf8");

  const caught = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    historyRepair: {
      plan: planCodexProviderTransition,
      hasPending() { return false; },
      async run(input) {
        mkdirSync(pendingDir, { mode: 0o700 });
        writeFileSync(pendingPath, `${secret}\n`, { mode: 0o600 });
        await input.publishConfig();
        throw new CrpError(
          "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
          "Codex configuration was updated, but history repair remains pending.",
          "Retry crp start to resume Codex history repair before using the proxy.",
          {
            status: 500,
            details: { committed: true, degraded: true, pending: true },
            cause: new Error(`${secret} ${pendingPath}`)
          }
        );
      }
    }
  }).then(
    () => null,
    (error) => error
  );
  publicFailure = toPublicError(caught, "request-history-degraded");
  const publicBytes = JSON.stringify(publicFailure);

  assert.equal(publicBytes.includes(secret), false);
  assert.equal(publicBytes.includes(pendingPath), false);
  assert.equal(caught?.code, "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED");
  assert.deepEqual(caught?.details, { committed: true, degraded: true, pending: true });
  assert.equal(readFileSync(configPath, "utf8"), target);
  assert.equal(existsSync(pendingPath), true);
  assert.deepEqual(publicFailure.error.details, {
    committed: true,
    degraded: true,
    pending: true
  });
});

test("bootstrap retains its config lock when no pending marker can be preserved", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-retain-config-lock-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const source = [
    'model_provider = "legacy"',
    "[model_providers.legacy]",
    'base_url = "https://legacy.example/v1"',
    ""
  ].join("\n");
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(configPath, source, "utf8");

  const error = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    historyRepair: {
      plan: planCodexProviderTransition,
      hasPending() { return false; },
      async run(input) {
        const binding = {
          operationId: "retain-config-lock",
          sourceConfigSha256: input.transition.sourceConfigSha256,
          targetConfigSha256: input.transition.targetConfigSha256,
          pendingRequired: true
        };
        input.beforeJournalPublish(binding);
        input.publishConfig();
        input.beforePendingClear(binding);
        const failure = new CrpError(
          "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
          "The Codex provider change was published, but history repair is incomplete.",
          "Keep the pending repair state and retry before starting Codex.",
          {
            status: 500,
            details: { committed: true, degraded: true, pending: true }
          }
        );
        Object.defineProperty(failure, "retainConfigLock", { value: true });
        throw failure;
      }
    }
  }).then(() => null, (failure) => failure);

  assert.equal(error?.code, "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED");
  assert.deepEqual(error?.details, { committed: true, degraded: true, pending: true });
  assert.equal(existsSync(lockPath), true);
  assert.equal(readFileSync(configPath, "utf8"), patchCodexConfigText(source, PROXY_URL));
  assert.equal(JSON.stringify(error).includes("retainConfigLock"), false);
});

for (const crashPhase of ["after-journal", "after-config"]) {
  test(`bootstrap recovers an exact pending-bound dead lock after a crash ${crashPhase}`, async (t) => {
    const homeDir = mkdtempSync(join(os.tmpdir(), `crp-codex-lock-recovery-${crashPhase}-`));
    const codexRoot = join(homeDir, ".codex");
    const configPath = join(codexRoot, "config.toml");
    const lockPath = `${configPath}.crp.lock`;
    const pendingPath = join(codexRoot, ".crp-history-repair", "pending.json");
    const rolloutPath = join(codexRoot, "sessions", `rollout-${crashPhase}.jsonl`);
    const original = [
      'model_provider = "legacy"',
      "",
      "[model_providers.legacy]",
      'base_url = "https://legacy.example/v1"',
      ""
    ].join("\n");
    const staleOwner = Object.freeze({
      pid: 900001,
      startedAt: "2026-07-16T00:00:00.000Z",
      instanceId: `stale-${crashPhase}`
    });
    const replacementOwner = Object.freeze({
      pid: 900002,
      startedAt: "2026-07-16T00:01:00.000Z",
      instanceId: `replacement-${crashPhase}`
    });
    let injectedCrash = false;
    t.after(() => rmSync(homeDir, { recursive: true, force: true }));
    mkdirSync(dirname(rolloutPath), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, original, { mode: 0o600 });
    writeFileSync(rolloutPath, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "fixture", model_provider: "legacy" }
    })}\n`, { mode: 0o600 });

    const crashOperations = {
      ...realFileOperations,
      openSync(path, ...args) {
        if (crashPhase === "after-journal"
          && path.startsWith(`${configPath}.`) && path.endsWith(".bak") && !injectedCrash) {
          injectedCrash = true;
          throw new Error("simulated crash before config publication");
        }
        if (crashPhase === "after-config"
          && path.startsWith(`${dirname(rolloutPath)}/.rollout-${crashPhase}.jsonl.`)
          && path.endsWith(".tmp") && !injectedCrash) {
          injectedCrash = true;
          throw new Error("simulated crash after config publication");
        }
        return realFileOperations.openSync(path, ...args);
      },
      renameSync(source, destination) {
        if (source === lockPath && destination.endsWith(".release")) {
          throw new Error("simulate process death before lock cleanup");
        }
        return realFileOperations.renameSync(source, destination);
      }
    };

    await assert.rejects(() => bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      fileOperations: crashOperations,
      configLockOwner: staleOwner
    }));
    assert.equal(injectedCrash, true);
    assert.equal(existsSync(pendingPath), true);
    assert.equal(existsSync(lockPath), true);
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    const staleLockBytes = readFileSync(lockPath);
    const staleLock = JSON.parse(staleLockBytes);
    assert.deepEqual(staleLock.owner, staleOwner);
    assert.deepEqual(staleLock.binding, {
      operationId: pending.operationId,
      sourceConfigSha256: pending.sourceConfigSha256,
      targetConfigSha256: pending.targetConfigSha256,
      pendingRequired: true
    });

    for (const liveness of ["live", "unknown"]) {
      await assert.rejects(
        () => bootstrapCodexConfig({
          configPath,
          proxyUrl: PROXY_URL,
          configLockOwner: replacementOwner,
          configLockOwnerLiveness(owner) {
            assert.deepEqual(owner, staleOwner);
            return liveness;
          }
        }),
        (error) => error?.code === "CODEX_CONFIG_BUSY"
      );
      assert.deepEqual(readFileSync(lockPath), staleLockBytes);
      assert.equal(existsSync(pendingPath), true);
    }
    await assert.rejects(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        configLockOwner: replacementOwner,
        configLockOwnerLiveness() {
          throw new Error("probe unavailable");
        }
      }),
      (error) => error?.code === "CODEX_CONFIG_BUSY"
    );
    assert.deepEqual(readFileSync(lockPath), staleLockBytes);

    if (crashPhase === "after-journal") {
      const mismatched = structuredClone(staleLock);
      mismatched.binding.targetConfigSha256 = "0".repeat(64);
      const mismatchedBytes = Buffer.from(`${JSON.stringify(mismatched)}\n`);
      writeFileSync(lockPath, mismatchedBytes);
      await assert.rejects(
        () => bootstrapCodexConfig({
          configPath,
          proxyUrl: PROXY_URL,
          configLockOwner: replacementOwner,
          configLockOwnerLiveness() { return "dead"; }
        }),
        (error) => error?.code === "CODEX_HISTORY_REPAIR_CONFLICT"
      );
      assert.deepEqual(readFileSync(lockPath), mismatchedBytes);
      assert.equal(existsSync(pendingPath), true);
      writeFileSync(lockPath, staleLockBytes);
    }

    const recovered = await bootstrapCodexConfig({
      configPath,
      proxyUrl: PROXY_URL,
      configLockOwner: replacementOwner,
      configLockOwnerLiveness(owner) {
        assert.deepEqual(owner, staleOwner);
        return "dead";
      }
    });
    assert.equal(recovered.historyRepair.completed, true);
    assert.equal(recovered.historyRepair.resumed, true);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(pendingPath), false);
    assert.equal(
      JSON.parse(readFileSync(rolloutPath, "utf8")).payload.model_provider,
      "OpenAI"
    );
  });
}

test("bootstrap recovers an exact dead lock left in the initial acquired phase", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-lock-recovery-acquired-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const original = 'model_provider = "legacy"\n';
  const staleOwner = {
    pid: 900011,
    startedAt: "2026-07-16T00:02:00.000Z",
    instanceId: "stale-acquired"
  };
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { mode: 0o700 });
  writeFileSync(configPath, original, { mode: 0o600 });

  await assert.rejects(() => bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    configLockOwner: staleOwner,
    fileOperations: {
      ...realFileOperations,
      renameSync(source, destination) {
        if (source === lockPath && destination.endsWith(".release")) {
          throw new Error("simulate acquired-phase process death");
        }
        return realFileOperations.renameSync(source, destination);
      }
    },
    historyRepair: {
      inspectPending() { return null; },
      hasPending() { return false; },
      plan() { throw new Error("crash before transition binding"); },
      async run() { assert.fail("run must not begin"); }
    }
  }));
  const stale = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(stale.phase, "acquired");
  assert.equal(stale.binding, null);

  const recovered = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    configLockOwner: {
      pid: 900012,
      startedAt: "2026-07-16T00:03:00.000Z",
      instanceId: "replacement-acquired"
    },
    configLockOwnerLiveness(owner) {
      assert.deepEqual(owner, staleOwner);
      return "dead";
    }
  });
  assert.equal(recovered.changed, true);
  assert.equal(existsSync(lockPath), false);
});

test("bootstrap recovers a dead completed lock after pending was durably cleared", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-lock-recovery-completed-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const pendingPath = join(codexRoot, ".crp-history-repair", "pending.json");
  const rolloutPath = join(codexRoot, "sessions", "rollout-completed.jsonl");
  const original = [
    'model_provider = "legacy"',
    "[model_providers.legacy]",
    'base_url = "https://legacy.example/v1"',
    ""
  ].join("\n");
  const staleOwner = {
    pid: 900021,
    startedAt: "2026-07-16T00:04:00.000Z",
    instanceId: "stale-completed"
  };
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(dirname(rolloutPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, original, { mode: 0o600 });
  writeFileSync(rolloutPath, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "completed", model_provider: "legacy" }
  })}\n`, { mode: 0o600 });

  await assert.rejects(() => bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    configLockOwner: staleOwner,
    fileOperations: {
      ...realFileOperations,
      renameSync(source, destination) {
        if (source === lockPath && destination.endsWith(".release")) {
          throw new Error("simulate death after pending clear");
        }
        return realFileOperations.renameSync(source, destination);
      }
    }
  }));
  assert.equal(existsSync(pendingPath), false);
  const stale = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(stale.phase, "completed");
  assert.equal(stale.binding.pendingRequired, true);
  const configBeforeRetry = readFileSync(configPath);
  const rolloutBeforeRetry = readFileSync(rolloutPath);

  const recovered = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    configLockOwner: {
      pid: 900022,
      startedAt: "2026-07-16T00:05:00.000Z",
      instanceId: "replacement-completed"
    },
    configLockOwnerLiveness(owner) {
      assert.deepEqual(owner, staleOwner);
      return "dead";
    }
  });
  assert.equal(recovered.changed, false);
  assert.deepEqual(readFileSync(configPath), configBeforeRetry);
  assert.deepEqual(readFileSync(rolloutPath), rolloutBeforeRetry);
  assert.equal(existsSync(lockPath), false);
});

test("bootstrap recovers a dead prepared config-only lock after config publication", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-lock-recovery-config-only-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const original = CONFIG_AT_PROXY_NEEDING_PATCH;
  const staleOwner = {
    pid: 900031,
    startedAt: "2026-07-16T00:06:00.000Z",
    instanceId: "stale-config-only"
  };
  let lockTempOpens = 0;
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { mode: 0o700 });
  writeFileSync(configPath, original, { mode: 0o600 });

  await assert.rejects(() => bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    configLockOwner: staleOwner,
    fileOperations: {
      ...realFileOperations,
      openSync(path, ...args) {
        if (path.startsWith(`${codexRoot}/.config.toml.crp.lock.`)
          && path.endsWith(".tmp")) {
          lockTempOpens += 1;
          if (lockTempOpens === 2) {
            throw new Error("simulate death before config-only completion marker");
          }
        }
        return realFileOperations.openSync(path, ...args);
      },
      renameSync(source, destination) {
        if (source === lockPath && destination.endsWith(".release")) {
          throw new Error("simulate config-only process death");
        }
        return realFileOperations.renameSync(source, destination);
      }
    }
  }));
  assert.equal(lockTempOpens, 2);
  const stale = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(stale.phase, "prepared");
  assert.equal(stale.binding.pendingRequired, false);
  assert.equal(readFileSync(configPath, "utf8"), patchCodexConfigText(original, PROXY_URL));

  const recovered = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    configLockOwner: {
      pid: 900032,
      startedAt: "2026-07-16T00:07:00.000Z",
      instanceId: "replacement-config-only"
    },
    configLockOwnerLiveness(owner) {
      assert.deepEqual(owner, staleOwner);
      return "dead";
    }
  });
  assert.equal(recovered.changed, false);
  assert.equal(existsSync(lockPath), false);
});

test("bootstrap durably publishes pending before the replacement config directory entry", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-history-fsync-order-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const rolloutPath = join(codexRoot, "sessions", "rollout-fsync.jsonl");
  const pendingDirectory = join(codexRoot, ".crp-history-repair");
  const original = [
    'model_provider = "legacy"',
    "[model_providers.legacy]",
    'base_url = "https://legacy.example/v1"',
    ""
  ].join("\n");
  const events = [];
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(dirname(rolloutPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, original, { mode: 0o600 });
  writeFileSync(rolloutPath, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "fsync", model_provider: "legacy" }
  })}\n`, { mode: 0o600 });

  await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    fileOperations: {
      ...realFileOperations,
      fsyncDirectorySync(path) {
        events.push(path);
      }
    }
  });

  const pendingIndex = events.indexOf(pendingDirectory);
  const configPublishIndex = events.lastIndexOf(codexRoot);
  assert.ok(pendingIndex >= 0);
  assert.ok(configPublishIndex > pendingIndex);
});

test("bootstrap fsyncs the config backup and parent before replacing config", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-backup-fsync-order-"));
  const codexRoot = join(homeDir, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const descriptorPaths = new Map();
  const events = [];
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(codexRoot, { mode: 0o700 });
  writeFileSync(configPath, CONFIG_AT_PROXY_NEEDING_PATCH, { mode: 0o640 });

  const result = await bootstrapCodexConfig({
    configPath,
    proxyUrl: PROXY_URL,
    fileOperations: {
      ...realFileOperations,
      openSync(path, ...args) {
        const descriptor = realFileOperations.openSync(path, ...args);
        descriptorPaths.set(descriptor, path);
        return descriptor;
      },
      closeSync(descriptor) {
        descriptorPaths.delete(descriptor);
        return realFileOperations.closeSync(descriptor);
      },
      fsyncSync(descriptor) {
        events.push(["file-fsync", descriptorPaths.get(descriptor) ?? null]);
        return realFileOperations.fsyncSync(descriptor);
      },
      fsyncDirectorySync(path) {
        events.push(["directory-fsync", path]);
      },
      renameSync(source, destination) {
        if (destination === configPath) events.push(["config-rename", destination]);
        return realFileOperations.renameSync(source, destination);
      }
    }
  });

  const backupFileIndex = events.findIndex(([name, path]) => (
    name === "file-fsync" && path === result.backupPath
  ));
  const backupDirectoryIndex = events.findIndex(([name, path], index) => (
    index > backupFileIndex && name === "directory-fsync" && path === codexRoot
  ));
  const configRenameIndex = events.findIndex(([name]) => name === "config-rename");
  const configDirectoryIndex = events.findIndex(([name, path], index) => (
    index > configRenameIndex && name === "directory-fsync" && path === codexRoot
  ));
  assert.ok(backupFileIndex >= 0);
  assert.ok(backupDirectoryIndex > backupFileIndex);
  assert.ok(configRenameIndex > backupDirectoryIndex);
  assert.ok(configDirectoryIndex > configRenameIndex);
});

for (const command of ["start", "install", "setup"]) {
  test(`${command} safely rejects legacy direct-start options`, () => {
    const homeDir = mkdtempSync(join(os.tmpdir(), `crp-${command}-home-`));
    const env = makeHomeEnv(homeDir);
    const codexDir = join(homeDir, ".codex");
    const codexConfigPath = join(codexDir, "config.toml");
    const statePath = join(homeDir, ".codex-remote-proxy", "state.json");
    const originalConfig = 'model_provider = "custom"\n';
    const placeholderCredential = ["placeholder", "credential", randomUUID()].join("-");
    const upstreamBaseUrl = "http://127.0.0.1:1/v1";

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

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const removed = command !== "start";
      const expectedError = {
        ok: false,
        command,
        stage: null,
        error: {
          code: removed ? "CLI_COMMAND_REMOVED" : "CLI_INPUT_INVALID",
          message: removed
            ? "This CLI command has been removed."
            : "The command input is invalid.",
          action: removed
            ? "Use `crp start` instead."
            : "Review the command options and try again.",
          details: {}
        }
      };
      assert.equal(result.stderr.includes(placeholderCredential), false);
      assert.deepEqual(JSON.parse(result.stderr), expectedError);
      assert.equal(result.stderr, `${JSON.stringify(expectedError, null, 2)}\n`);
      assert.equal(readFileSync(codexConfigPath, "utf8"), originalConfig);
      assert.equal(existsSync(statePath), false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
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
    modelCachePath: resolve(
      injectedHome,
      ".codex-remote-proxy",
      "provider-model-cache.json"
    ),
    secretFallbackPath: resolve(injectedHome, ".codex-remote-proxy", "secrets.json"),
    statePath: resolve(injectedHome, ".codex-remote-proxy", "state.json"),
    controlTokenPath: resolve(injectedHome, ".codex-remote-proxy", "control-token"),
    activityPath: resolve(injectedHome, ".codex-remote-proxy", "activity.jsonl"),
    metricsPath: resolve(injectedHome, ".codex-remote-proxy", "metrics.json"),
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
