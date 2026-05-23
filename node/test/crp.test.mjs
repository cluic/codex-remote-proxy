import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

test("start without config fails cleanly without sqlite warnings", () => {
  const homeDir = makeTempHome();
  try {
    const result = runCrp(["start"], makeHomeEnv(homeDir));
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /Error: Upstream base URL is required/);
    assert.doesNotMatch(output, /ExperimentalWarning: SQLite/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
