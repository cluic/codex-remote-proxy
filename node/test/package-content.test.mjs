import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const REVIEWED_PACKAGE_PATHS = new Set([
  "LICENSE",
  "README.md",
  "bin/crp.mjs",
  "package.json",
  "proxy-config.example.json",
  "src/capture-config.mjs",
  "src/capture-store.mjs",
  "src/codex/codex-config.mjs",
  "src/codex/codex-history-repair.mjs",
  "src/credentials/credential-store.mjs",
  "src/credentials/file-credential-store.mjs",
  "src/credentials/native-keyring.mjs",
  "src/providers/provider-model-cache.mjs",
  "src/providers/provider-presets.mjs",
  "src/providers/provider-registry.mjs",
  "src/providers/provider-schema.mjs",
  "src/routing/account-routing.mjs",
  "src/routing/provider-scheduler.mjs",
  "src/server.mjs",
  "src/shared/errors.mjs",
  "src/shared/build-info.mjs",
  "src/shared/paths.mjs",
  "src/supervisor/activity-store.mjs",
  "src/supervisor/account-monitor.mjs",
  "src/supervisor/admin-server.mjs",
  "src/supervisor/autostart-service.mjs",
  "src/supervisor/forwarding-records-service.mjs",
  "src/supervisor/migration.mjs",
  "src/supervisor/metrics-store.mjs",
  "src/supervisor/provider-service.mjs",
  "src/supervisor/session-auth.mjs",
  "src/supervisor/supervisor-client.mjs",
  "src/supervisor/supervisor-entry.mjs",
  "src/supervisor/supervisor.mjs",
  "src/supervisor/worker-manager.mjs",
  "src/worker/account-routing-state.mjs",
  "src/worker/protocol.mjs",
  "src/worker/runtime-settings.mjs",
  "src/worker/worker-entry.mjs",
  "ui/app.js",
  "ui/index.html",
  "ui/styles.css"
]);
const FORBIDDEN_TOP_LEVEL_DIRECTORIES = new Set([
  ".changeset",
  ".codex-remote-proxy",
  ".superpowers",
  "credentials",
  "logs",
  "output",
  "runtime",
  "secrets",
  "state",
  "test",
  "tests"
]);
const FORBIDDEN_RUNTIME_NAMES = new Set([
  ".env",
  "activity.jsonl",
  "auth.json",
  "control-token",
  "credentials.json",
  "metrics.json",
  "provider-model-cache.json",
  "providers.json",
  "secrets.json",
  "state.json",
  "supervisor.log",
  "traffic.sqlite3"
]);
const PACK_ARGUMENTS = ["pack", "--dry-run", "--json", "--ignore-scripts"];

function buildPackInvocation(platform = process.platform, environment = process.env) {
  if (platform === "win32") {
    return {
      command: environment.ComSpec || environment.COMSPEC || "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npm.cmd pack --dry-run --json --ignore-scripts"
      ]
    };
  }
  return { command: "npm", args: [...PACK_ARGUMENTS] };
}

function normalizePackPath(filePath) {
  assert.equal(typeof filePath, "string");
  assert.notEqual(filePath.length, 0);
  assert.equal(filePath.includes("\0"), false);
  const normalized = filePath.replaceAll("\\", "/");
  assert.equal(normalized.startsWith("/"), false);
  assert.equal(normalized.split("/").includes(".."), false);
  return normalized;
}

function isRuntimeOrDevelopmentPath(filePath) {
  const segments = filePath.split("/");
  const basename = segments.at(-1).toLowerCase();
  const topLevel = segments[0].toLowerCase();
  return FORBIDDEN_TOP_LEVEL_DIRECTORIES.has(topLevel)
    || FORBIDDEN_RUNTIME_NAMES.has(basename)
    || basename.startsWith(".env.")
    || /\.(?:db|log|pem|key|p12|sqlite|sqlite3)(?:-(?:shm|wal)|-journal)?$/i.test(basename);
}

function parsePackFilePaths(stdout) {
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(stdout);
  }, "npm pack must emit one structured JSON document");
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  assert.equal(Array.isArray(parsed[0]?.files), true);

  const paths = parsed[0].files.map((entry) => {
    assert.equal(entry !== null && typeof entry === "object", true);
    return normalizePackPath(entry.path);
  });
  assert.equal(new Set(paths).size, paths.length, "packed paths must be unique");
  return new Set(paths);
}

function comparePackagePaths(actualPaths, expectedPaths = REVIEWED_PACKAGE_PATHS) {
  const actual = new Set(actualPaths);
  const expected = new Set(expectedPaths);
  return {
    missing: [...expected].filter((path) => !actual.has(path)).sort(),
    unexpected: [...actual].filter((path) => !expected.has(path)).sort()
  };
}

test("npm pack invocation uses an explicit command interpreter only on Windows", () => {
  assert.deepEqual(
    buildPackInvocation("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npm.cmd pack --dry-run --json --ignore-scripts"
      ]
    }
  );
  assert.deepEqual(buildPackInvocation("linux", {}), {
    command: "npm",
    args: ["pack", "--dry-run", "--json", "--ignore-scripts"]
  });
});

test("exact package path comparison detects every extra and missing path", () => {
  const reviewed = [...REVIEWED_PACKAGE_PATHS];
  assert.equal(REVIEWED_PACKAGE_PATHS.size, 42);
  assert.deepEqual(comparePackagePaths(reviewed), { missing: [], unexpected: [] });

  const runtimeExtras = [
    "secrets.json",
    "state.json",
    "metrics.json",
    "traffic.sqlite3",
    "supervisor.log",
    "cluic-codex-remote-proxy-0.2.2.tgz"
  ];
  assert.deepEqual(
    comparePackagePaths([...reviewed, ...runtimeExtras]),
    { missing: [], unexpected: [...runtimeExtras].sort() }
  );

  assert.deepEqual(
    comparePackagePaths(reviewed.filter((path) => path !== "ui/app.js")),
    { missing: ["ui/app.js"], unexpected: [] }
  );
});

test("npm package contains executable, source, and UI assets without development or runtime state", () => {
  const invocation = buildPackInvocation();
  const result = spawnSync(
    invocation.command,
    invocation.args,
    {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000
    }
  );

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const paths = parsePackFilePaths(result.stdout);

  assert.deepEqual(comparePackagePaths(paths), { missing: [], unexpected: [] });
  assert.equal(paths.has("src/credentials/native-keyring.mjs"), true);
  assert.equal(isRuntimeOrDevelopmentPath("src/credentials/native-keyring.mjs"), false);
  assert.equal(isRuntimeOrDevelopmentPath("credentials/provider.json"), true);

  const prohibited = [...paths].filter(isRuntimeOrDevelopmentPath);
  assert.deepEqual(prohibited, []);
});
