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

test("bootstrapCodexConfig privately creates a missing Codex directory and config once", () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-clean-home-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const expectedText = patchCodexConfigText("", PROXY_URL);

  try {
    assert.equal(existsSync(codexDir), false);

    const first = bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL });

    assert.deepEqual(first, { changed: true, backupPath: null });
    assert.equal(readFileSync(configPath, "utf8"), expectedText);
    if (process.platform !== "win32") {
      assert.equal(statSync(codexDir).mode & 0o777, 0o700);
      assert.equal(statSync(configPath).mode & 0o777, 0o600);
    }
    assert.deepEqual(readdirSync(codexDir), ["config.toml"]);

    const firstBytes = readFileSync(configPath);
    const firstMtime = statSync(configPath, { bigint: true }).mtimeNs;
    const second = bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL });

    assert.deepEqual(second, { changed: false, backupPath: null });
    assert.deepEqual(readFileSync(configPath), firstBytes);
    assert.equal(statSync(configPath, { bigint: true }).mtimeNs, firstMtime);
    assert.deepEqual(readdirSync(codexDir), ["config.toml"]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig does not overwrite a config that appears during first publish", () => {
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
    assert.throws(
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

test("bootstrapCodexConfig rejects a changed parent identity before publishing", () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-parent-race-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  let parentReads = 0;

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    assert.throws(
      () => bootstrapCodexConfig({
        configPath,
        proxyUrl: PROXY_URL,
        fileOperations: {
          ...realFileOperations,
          lstatSync(path, ...args) {
            const identity = realFileOperations.lstatSync(path, ...args);
            if (path !== codexDir) return identity;
            parentReads += 1;
            if (parentReads !== 2) return identity;
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
    assert.equal(existsSync(`${configPath}.crp.lock`), false);
    assert.deepEqual(readdirSync(codexDir), []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig never removes a foreign lock replacement", () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-lock-replacement-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const foreignLockBytes = Buffer.from("foreign lock replacement\n", "utf8");
  let lockDescriptor;
  let replaced = false;

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    assert.throws(
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
    assert.equal(readFileSync(configPath, "utf8"), patchCodexConfigText("", PROXY_URL));
    assert.deepEqual(
      readdirSync(codexDir).filter((name) => name.endsWith(".tmp") || name.endsWith(".bak")),
      []
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig retains a foreign lock when lock identity acquisition fails", () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-lock-identity-failure-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const foreignLockBytes = Buffer.from("foreign lock after identity failure\n", "utf8");
  const identityFailure = new Error("forced lock identity failure");
  let lockDescriptor;

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    assert.throws(
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
    assert.throws(
      () => bootstrapCodexConfig({ configPath, proxyUrl: PROXY_URL }),
      (error) => error?.code === "CODEX_CONFIG_BUSY"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("bootstrapCodexConfig atomically claims a lock before removing owned state", () => {
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
    assert.throws(
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
      (error) => error?.code === "CODEX_CONFIG_WRITE_FAILED"
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

test("bootstrapCodexConfig atomically claims a temp before cleanup", () => {
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
    assert.throws(
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

test("bootstrapCodexConfig preserves a primary write failure over lock cleanup failure", () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "crp-codex-primary-failure-"));
  const codexDir = join(homeDir, ".codex");
  const configPath = join(codexDir, "config.toml");
  const lockPath = `${configPath}.crp.lock`;
  const primaryFailure = new Error("forced primary write failure");
  const cleanupFailure = new Error("forced lock close failure");
  let lockDescriptor;
  let tempDescriptor;
  let lockCloseFailed = false;

  try {
    mkdirSync(codexDir, { mode: 0o700 });
    assert.throws(
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
            if (target === tempDescriptor) throw primaryFailure;
            return realFileOperations.writeFileSync(target, ...args);
          },
          closeSync(descriptor) {
            realFileOperations.closeSync(descriptor);
            if (descriptor === lockDescriptor && !lockCloseFailed) {
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

test("bootstrapCodexConfig classifies private filesystem read and write failures", () => {
  for (const failureCase of [
    {
      name: "read",
      code: "CODEX_CONFIG_READ_FAILED",
      prepare(configPath) {
        writeFileSync(configPath, 'model_provider = "custom"\n', "utf8");
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
        bootstrapCodexConfig({
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

test("bootstrapCodexConfig preserves an external source change detected before rename", () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), "crp-codex-source-change-"));
  const configPath = join(tempDir, "config.toml");
  const originalBytes = Buffer.from('model_provider = "custom"\n', "utf8");
  const externalBytes = Buffer.from('model_provider = "external"\n', "utf8");
  let sourceReadCount = 0;
  const sourceDescriptors = new Set();
  let renameCalled = false;

  try {
    writeFileSync(configPath, originalBytes);

    assert.throws(
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

test("bootstrapCodexConfig rejects an existing config symlink without changing its target", (t) => {
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

    assert.throws(
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

for (const replacementPhase of ["after-read", "after-backup"]) {
  test(`bootstrapCodexConfig rejects a same-byte inode replacement ${replacementPhase}`, () => {
    const homeDir = mkdtempSync(join(os.tmpdir(), `crp-codex-config-${replacementPhase}-`));
    const codexDir = join(homeDir, ".codex");
    const configPath = join(codexDir, "config.toml");
    const originalBytes = Buffer.from('model_provider = "custom"\n', "utf8");
    let sourceDescriptor;
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

      assert.throws(
        () => bootstrapCodexConfig({
          configPath,
          proxyUrl: PROXY_URL,
          now: () => new Date("2026-07-10T12:38:56.789Z"),
          fileOperations: {
            ...realFileOperations,
            openSync(path, ...args) {
              const descriptor = realFileOperations.openSync(path, ...args);
              if (path === configPath) sourceDescriptor = descriptor;
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
            copyFileSync(...args) {
              const value = realFileOperations.copyFileSync(...args);
              if (replacementPhase === "after-backup") replaced = true;
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
      const expectedError = {
        ok: false,
        command,
        stage: null,
        error: {
          code: "CLI_INPUT_INVALID",
          message: "The command input is invalid.",
          action: "Review the command options and try again.",
          details: {}
        }
      };
      assert.deepEqual(JSON.parse(result.stderr), expectedError);
      assert.equal(result.stderr, `${JSON.stringify(expectedError, null, 2)}\n`);
      assert.equal(result.stderr.includes(placeholderCredential), false);
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
