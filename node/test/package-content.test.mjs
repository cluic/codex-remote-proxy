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
  "src/access-key-store.mjs",
  "src/capture-config.mjs",
  "src/capture-index-worker.mjs",
  "src/capture-store.mjs",
  "src/codex/codex-config.mjs",
  "src/codex/codex-history-repair.mjs",
  "src/credentials/credential-store.mjs",
  "src/credentials/file-credential-store.mjs",
  "src/credentials/native-keyring.mjs",
  "src/http/multipart-model.mjs",
  "src/providers/provider-model-cache.mjs",
  "src/providers/provider-presets.mjs",
  "src/providers/provider-registry.mjs",
  "src/providers/provider-schema.mjs",
  "src/routing/account-routing.mjs",
  "src/routing/provider-scheduler.mjs",
  "src/routing/route-preview.mjs",
  "src/server.mjs",
  "src/shared/errors.mjs",
  "src/shared/build-info.mjs",
  "src/shared/paths.mjs",
  "src/shared/private-token.mjs",
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
  "src/supervisor/ui-assets.mjs",
  "src/supervisor/worker-manager.mjs",
  "src/worker/account-routing-state.mjs",
  "src/worker/protocol.mjs",
  "src/worker/runtime-settings.mjs",
  "src/worker/worker-entry.mjs",
  "ui/.crp-ui-manifest.json",
  "ui/404.html",
  "ui/__next.__PAGE__.txt",
  "ui/__next._full.txt",
  "ui/__next._tree.txt",
  "ui/_next/static/chunks/158-1bfb115fdb023826.js",
  "ui/_next/static/chunks/313-2f8466e707e35ec0.js",
  "ui/_next/static/chunks/996-a0f483af1b22140d.js",
  "ui/_next/static/chunks/app/_global-error/page-72850c6b7154b5cf.js",
  "ui/_next/static/chunks/app/_not-found/page-72850c6b7154b5cf.js",
  "ui/_next/static/chunks/app/activity/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/app/forwarding/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/app/global-error-c3441224e90990a1.js",
  "ui/_next/static/chunks/app/layout-1e45b7c268af9839.js",
  "ui/_next/static/chunks/app/model-mappings/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/app/not-found-f9320e13bb9b8591.js",
  "ui/_next/static/chunks/app/overview/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/app/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/app/providers/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/app/routing-rules/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/app/setup/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/app/system/page-d34dd020730b4798.js",
  "ui/_next/static/chunks/c7879cf7-33323d49ba6da96a.js",
  "ui/_next/static/chunks/framework-16b238f3c63ce812.js",
  "ui/_next/static/chunks/main-33617d8be64c197f.js",
  "ui/_next/static/chunks/main-app-bae101f4363f8895.js",
  "ui/_next/static/chunks/next/dist/client/components/builtin/app-error-72850c6b7154b5cf.js",
  "ui/_next/static/chunks/next/dist/client/components/builtin/forbidden-72850c6b7154b5cf.js",
  "ui/_next/static/chunks/next/dist/client/components/builtin/unauthorized-72850c6b7154b5cf.js",
  "ui/_next/static/chunks/polyfills-42372ed130431b0a.js",
  "ui/_next/static/chunks/webpack-595b3be39883ebd5.js",
  "ui/_next/static/crp-c000f69fcd8493278df3809ab25b8d42f0687ec4255264dbe4c1f6e6d42c6d1a/_buildManifest.js",
  "ui/_next/static/crp-c000f69fcd8493278df3809ab25b8d42f0687ec4255264dbe4c1f6e6d42c6d1a/_ssgManifest.js",
  "ui/_next/static/css/5ee22adf52b0619f.css",
  "ui/_next/static/css/9e1661e816f29201.css",
  "ui/_not-found.html",
  "ui/_not-found.txt",
  "ui/_not-found/__next._full.txt",
  "ui/_not-found/__next._not-found.__PAGE__.txt",
  "ui/_not-found/__next._tree.txt",
  "ui/activity.html",
  "ui/activity.txt",
  "ui/activity/__next._full.txt",
  "ui/activity/__next._tree.txt",
  "ui/activity/__next.activity.__PAGE__.txt",
  "ui/forwarding.html",
  "ui/forwarding.txt",
  "ui/forwarding/__next._full.txt",
  "ui/forwarding/__next._tree.txt",
  "ui/forwarding/__next.forwarding.__PAGE__.txt",
  "ui/index.html",
  "ui/index.txt",
  "ui/model-mappings.html",
  "ui/model-mappings.txt",
  "ui/model-mappings/__next._full.txt",
  "ui/model-mappings/__next._tree.txt",
  "ui/model-mappings/__next.model-mappings.__PAGE__.txt",
  "ui/overview.html",
  "ui/overview.txt",
  "ui/overview/__next._full.txt",
  "ui/overview/__next._tree.txt",
  "ui/overview/__next.overview.__PAGE__.txt",
  "ui/providers.html",
  "ui/providers.txt",
  "ui/providers/__next._full.txt",
  "ui/providers/__next._tree.txt",
  "ui/providers/__next.providers.__PAGE__.txt",
  "ui/routing-rules.html",
  "ui/routing-rules.txt",
  "ui/routing-rules/__next._full.txt",
  "ui/routing-rules/__next._tree.txt",
  "ui/routing-rules/__next.routing-rules.__PAGE__.txt",
  "ui/setup.html",
  "ui/setup.txt",
  "ui/setup/__next._full.txt",
  "ui/setup/__next._tree.txt",
  "ui/setup/__next.setup.__PAGE__.txt",
  "ui/system.html",
  "ui/system.txt",
  "ui/system/__next._full.txt",
  "ui/system/__next._tree.txt",
  "ui/system/__next.system.__PAGE__.txt"
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
  "access-keys.sqlite3",
  "activity.jsonl",
  "auth.json",
  "control-token",
  "cli-preferences.json",
  "credentials.json",
  "metrics.json",
  "local-access-token",
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
  assert.equal(REVIEWED_PACKAGE_PATHS.size, 127);
  assert.deepEqual(comparePackagePaths(reviewed), { missing: [], unexpected: [] });

  const runtimeExtras = [
    "access-keys.sqlite3",
    "cli-preferences.json",
    "local-access-token",
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
    comparePackagePaths(reviewed.filter((path) => path !== "ui/index.html")),
    { missing: ["ui/index.html"], unexpected: [] }
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
