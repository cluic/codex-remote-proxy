import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as realFileOperations from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

import {
  hasPendingCodexHistoryRepair,
  inspectCodexProviderBinding,
  planCodexProviderTransition,
  runCodexHistoryRepairTransition
} from "../src/codex/codex-history-repair.mjs";

const TARGET_PROVIDER = "OpenAI";
const TARGET_BASE_URL = "http://127.0.0.1:15100";
const FIXED_TIME = new Date("2025-01-02T03:04:05.000Z");
const SECRET = "history-secret-sentinel-93fce7";
const HISTORY_MODULE_PATH = resolve(import.meta.dirname, "../src/codex/codex-history-repair.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceConfig({
  provider = "legacy.provider",
  baseUrl = "https://legacy.example/v1",
  lineEnding = "\n",
  quotedSection = true
} = {}) {
  const section = quotedSection
    ? `[model_providers."${provider}"]`
    : `[model_providers.${provider}]`;
  return Buffer.from([
    `model_provider = "${provider}"`,
    "model = \"legacy-model\"",
    "",
    section,
    `base_url = "${baseUrl}"`,
    "wire_api = \"responses\"",
    ""
  ].join(lineEnding), "utf8");
}

function targetConfig() {
  return Buffer.from([
    'model_provider = "OpenAI"',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    `base_url = "${TARGET_BASE_URL}"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n"), "utf8");
}

function makeHarness(label) {
  const tmpRoot = realpathSync(os.tmpdir());
  const sandbox = mkdtempSync(join(tmpRoot, `crp-history-${label}-`));
  const relation = relative(tmpRoot, realpathSync(sandbox));
  assert.equal(relation.startsWith(`..${sep}`) || relation === "..", false);
  assert.equal(resolve(tmpRoot, relation), realpathSync(sandbox));

  const codexRoot = join(sandbox, ".codex");
  mkdirSync(codexRoot, { mode: 0o700 });
  return {
    sandbox,
    codexRoot,
    configPath: join(codexRoot, "config.toml"),
    cleanup() {
      rmSync(sandbox, { recursive: true, force: true });
    }
  };
}

function writePrivate(path, bytes, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode });
  if (process.platform !== "win32") chmodSync(path, mode);
}

function rolloutLine(provider, id, extra = {}) {
  return JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      model_provider: provider,
      cwd: `/workspace/${SECRET}/${id}`,
      ...extra
    }
  });
}

function writeRollout(path, bytes, { mode = 0o640, mtime = FIXED_TIME } = {}) {
  writePrivate(path, bytes, mode);
  utimesSync(path, mtime, mtime);
}

function createThreadsDatabase(path, rows, {
  columns = true,
  table = true,
  triggerSecret = null,
  triggerIgnore = false
} = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  try {
    if (!table) {
      database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY, value TEXT)");
      return;
    }
    if (!columns) {
      database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, has_user_event INTEGER)");
      for (const row of rows) {
        database.prepare("INSERT INTO threads VALUES (?, ?, ?)")
          .run(row.id, row.cwd, row.hasUserEvent);
      }
      return;
    }
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      model_provider TEXT,
      cwd TEXT,
      has_user_event INTEGER,
      title TEXT
    )`);
    const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)");
    for (const row of rows) {
      insert.run(
        row.id,
        row.provider,
        row.cwd,
        row.hasUserEvent,
        row.title ?? `title-${SECRET}`
      );
    }
    if (triggerSecret || triggerIgnore) {
      database.exec(`CREATE TRIGGER block_history_repair
        BEFORE UPDATE OF model_provider ON threads
        BEGIN SELECT RAISE(${triggerIgnore ? "IGNORE" : `ABORT, '${triggerSecret}'`}); END`);
    }
  } finally {
    database.close();
  }
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function readThreads(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(
      "SELECT id, model_provider, cwd, has_user_event, title FROM threads ORDER BY id"
    ).all().map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

function removeTrigger(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec("DROP TRIGGER IF EXISTS block_history_repair");
  } finally {
    database.close();
  }
}

function mtimeNs(path) {
  return statSync(path, { bigint: true }).mtimeNs;
}

function captureFile(path) {
  return {
    bytes: readFileSync(path),
    mtime: mtimeNs(path),
    mode: statSync(path).mode & 0o777
  };
}

function assertUnchanged(path, snapshot) {
  assert.deepEqual(readFileSync(path), snapshot.bytes);
  assert.equal(mtimeNs(path), snapshot.mtime);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, snapshot.mode);
  }
}

function plan(sourceBytes, { sourceExists = true } = {}) {
  const targetBytes = targetConfig();
  return planCodexProviderTransition({
    sourceExists,
    sourceText: sourceBytes.toString("utf8"),
    targetText: targetBytes.toString("utf8"),
    targetProvider: TARGET_PROVIDER,
    targetBaseUrl: TARGET_BASE_URL
  });
}

async function executeTransition(harness, sourceBytes, {
  transition = plan(sourceBytes),
  currentConfigBytes = sourceBytes,
  targetConfigBytes = targetConfig(),
  publishConfig,
  fileOperations,
  databaseOperations,
  beforeJournalPublish,
  beforePendingClear,
  assertConfigLock,
  id = "op-test-001"
} = {}) {
  return runCodexHistoryRepairTransition({
    codexRoot: harness.codexRoot,
    currentConfigBytes,
    targetConfigBytes,
    transition,
    publishConfig: publishConfig ?? ((bytes) => {
      writeFileSync(harness.configPath, bytes);
      return { changed: true };
    }),
    fileOperations,
    databaseOperations,
    beforeJournalPublish,
    beforePendingClear,
    assertConfigLock,
    now: () => "2026-07-16T12:00:00.000Z",
    createId: () => id
  });
}

function pendingPath(codexRoot) {
  return join(codexRoot, ".crp-history-repair", "pending.json");
}

function clearingPath(codexRoot) {
  return join(codexRoot, ".crp-history-repair", "pending.json.clearing");
}

function backupPath(codexRoot, id = "op-test-001") {
  return join(codexRoot, ".crp-history-repair", "backups", id);
}

function publicErrorText(error) {
  return JSON.stringify({
    code: error?.code,
    message: error?.message,
    action: error?.action,
    details: error?.details
  });
}

function assertSafeError(error, code, harness) {
  const serialized = publicErrorText(error);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(harness.codexRoot), false);
  assert.equal(serialized.includes(harness.sandbox), false);
  assert.equal(error?.code, code);
  const expectedDetails = code === "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED"
    ? { committed: true, degraded: true, pending: true }
    : code === "CODEX_CONFIG_COMMITTED_DEGRADED"
      ? { committed: true, degraded: true, pending: false }
      : {};
  assert.deepEqual(error?.details ?? {}, expectedDetails);
  return true;
}

function assertPrivateTree(path) {
  if (process.platform === "win32") return;
  const visit = (current) => {
    const entry = lstatSync(current);
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) {
      assert.equal(entry.mode & 0o777, 0o700);
      for (const name of readdirSync(current)) visit(join(current, name));
      return;
    }
    assert.equal(entry.isFile(), true);
    assert.equal(entry.mode & 0o777, 0o600);
  };
  visit(path);
}

test("inspects the root provider binding, including a quoted provider section", () => {
  const bytes = sourceConfig();
  const inspected = inspectCodexProviderBinding(bytes.toString("utf8"));

  assert.deepEqual(inspected, {
    providerName: "legacy.provider",
    baseUrl: "https://legacy.example/v1",
    normalizedBaseUrl: "https://legacy.example/v1"
  });

  const transition = plan(bytes);
  assert.deepEqual(transition, {
    required: true,
    reason: "base-url-changed",
    sourceConfigSha256: sha256(bytes),
    targetConfigSha256: sha256(targetConfig())
  });

  for (const dotted of [
    [
      'model_provider = "legacy.provider"',
      'model_providers."legacy.provider".base_url = "https://legacy.example/v1"',
      ""
    ].join("\n"),
    [
      'model_provider = "legacy.provider"',
      "[model_providers]",
      '"legacy.provider".base_url = "https://legacy.example/v1"',
      ""
    ].join("\n")
  ]) {
    assert.deepEqual(inspectCodexProviderBinding(dotted), inspected);
    assert.equal(plan(Buffer.from(dotted)).reason, "base-url-changed");
  }
});

test("binding inspection skips multiline and collection decoys", () => {
  const source = [
    'developer_instructions = """',
    'model_provider = "decoy-basic"',
    "[model_providers.decoy-basic]",
    'base_url = "https://decoy-basic.example/v1"',
    '"""',
    "literal_instructions = '''",
    'model_provider = "decoy-literal"',
    "[model_providers.decoy-literal]",
    'base_url = "https://decoy-literal.example/v1"',
    "'''",
    "examples = [",
    "  '''[model_providers.decoy-array]''',",
    "  '''model_provider = \"decoy-array\"''',",
    "]",
    'continued_instructions = """',
    "continued \\",
    '  model_provider = "decoy-continuation"',
    "  [model_providers.decoy-continuation]",
    '  base_url = "https://decoy-continuation.example/v1"',
    '"""',
    '"model_provider" = "legacy.provider"',
    "[ 'model_providers' . \"legacy.provider\" ] # real binding",
    "'base_url' = 'https://legacy.example/v1'",
    ""
  ].join("\n");

  assert.deepEqual(inspectCodexProviderBinding(source), {
    providerName: "legacy.provider",
    baseUrl: "https://legacy.example/v1",
    normalizedBaseUrl: "https://legacy.example/v1"
  });
});

test("keeps node:sqlite behind the actual repair path", () => {
  const source = readFileSync(HISTORY_MODULE_PATH, "utf8");
  assert.equal(source.includes('from "node:sqlite"'), false);
  assert.equal(source.includes("from 'node:sqlite'"), false);
});

test("plans no history scan for an unchanged base URL or first config creation", () => {
  const same = sourceConfig({
    provider: "custom.proxy",
    baseUrl: TARGET_BASE_URL
  });
  assert.deepEqual(plan(same), {
    required: false,
    reason: "base-url-unchanged",
    sourceConfigSha256: sha256(same),
    targetConfigSha256: sha256(targetConfig())
  });

  const missing = Buffer.alloc(0);
  assert.deepEqual(plan(missing, { sourceExists: false }), {
    required: false,
    reason: "source-missing",
    sourceConfigSha256: null,
    targetConfigSha256: sha256(targetConfig())
  });
});

test("treats missing existing bindings as a transition while duplicate or invalid bindings fail closed", () => {
  const missingBindings = [
    {
      source: '[model_providers.OpenAI]\nbase_url = "https://example.test/v1"\n',
      inspected: { providerName: null, baseUrl: null, normalizedBaseUrl: null }
    },
    {
      source: 'model_provider = "legacy"\n',
      inspected: { providerName: "legacy", baseUrl: null, normalizedBaseUrl: null }
    },
    {
      source: 'model_provider = "legacy"\n[model_providers.legacy]\nname = "Legacy"\n',
      inspected: { providerName: "legacy", baseUrl: null, normalizedBaseUrl: null }
    }
  ];
  for (const { source, inspected } of missingBindings) {
    const bytes = Buffer.from(source);
    assert.deepEqual(inspectCodexProviderBinding(source), inspected);
    assert.deepEqual(plan(bytes), {
      required: true,
      reason: "source-binding-missing",
      sourceConfigSha256: sha256(bytes),
      targetConfigSha256: sha256(targetConfig())
    });
  }

  const invalidSources = [
    [
      'model_provider = "one"',
      'model_provider = "two"',
      '[model_providers.one]',
      'base_url = "https://one.example/v1"',
      '[model_providers.two]',
      'base_url = "https://two.example/v1"'
    ].join("\n"),
    [
      'model_provider = "legacy"',
      '[model_providers.legacy]',
      'base_url = "https://one.example/v1"',
      '[model_providers."legacy"]',
      'base_url = "https://two.example/v1"'
    ].join("\n"),
    [
      'model_provider = "legacy"',
      '[model_providers.legacy]',
      'base_url = "https://one.example/v1"',
      'base_url = "https://two.example/v1"'
    ].join("\n"),
    [
      'model_provider = "legacy"',
      '[model_providers.legacy]',
      'base_url = "not a URL"'
    ].join("\n"),
    [
      'model_provider = "legacy"',
      '[model_providers.legacy]',
      `base_url = "https://${SECRET}@legacy.example/v1"`
    ].join("\n"),
    [
      'model_provider = "legacy"',
      'model_providers.legacy.base_url = "https://legacy.example/v1"',
      "[model_providers.legacy]",
      'name = "Legacy"'
    ].join("\n"),
    'model_provider = "unterminated\n',
    [
      'model_provider = "legacy"',
      "this is invalid toml",
      "[model_providers.legacy]",
      'base_url = "https://legacy.example/v1"'
    ].join("\n")
  ];

  for (const source of invalidSources) {
    assert.throws(
      () => inspectCodexProviderBinding(source),
      (error) => {
        const serialized = publicErrorText(error);
        assert.equal(serialized.includes("https://one.example"), false);
        assert.equal(serialized.includes("https://two.example"), false);
        assert.equal(serialized.includes(SECRET), false);
        assert.equal(error?.code, "CODEX_HISTORY_REPAIR_INVALID");
        return true;
      }
    );
  }
});

test("repairs active and archived rollouts plus every eligible SQLite store without changing unrelated state", async (t) => {
  const harness = makeHarness("complete");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);

  const activePath = join(harness.codexRoot, "sessions", "2026", "07", "rollout-active.jsonl");
  const archivedPath = join(harness.codexRoot, "archived_sessions", "rollout-archived.jsonl");
  const badJson = `{bad-json-${SECRET}`;
  const eventLine = JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: `message-${SECRET}` }
  });
  const encryptedLine = JSON.stringify({
    type: "response_item",
    payload: { encrypted_content: `encrypted-${SECRET}`, untouched: true }
  });
  writeRollout(activePath, Buffer.from([
    rolloutLine("legacy.provider", "thread-active-1"),
    eventLine,
    rolloutLine("second-provider", "thread-active-2"),
    badJson,
    encryptedLine,
    ""
  ].join("\n"), "utf8"));
  writeRollout(archivedPath, Buffer.from([
    rolloutLine("archived-provider", "thread-archived"),
    eventLine
  ].join("\r\n"), "utf8"), { mode: 0o600 });
  const activeBefore = captureFile(activePath);
  const archivedBefore = captureFile(archivedPath);

  const globalStatePath = join(harness.codexRoot, ".codex-global-state.json");
  const sessionIndexPath = join(harness.codexRoot, "session_index.jsonl");
  writePrivate(globalStatePath, `${JSON.stringify({
    "projectless-thread-ids": ["thread-active-1"],
    secret: SECRET
  })}\n`);
  writePrivate(sessionIndexPath, `${JSON.stringify({
    id: "index-only",
    thread_name: `title-${SECRET}`
  })}\n`);
  utimesSync(globalStatePath, FIXED_TIME, FIXED_TIME);
  utimesSync(sessionIndexPath, FIXED_TIME, FIXED_TIME);
  const globalBefore = captureFile(globalStatePath);
  const indexBefore = captureFile(sessionIndexPath);

  const legacyDb = join(harness.codexRoot, "state_5.sqlite");
  const currentDb = join(harness.codexRoot, "sqlite", "codex-dev.db");
  const secondDb = join(harness.codexRoot, "sqlite", "sessions.sqlite");
  const thirdDb = join(harness.codexRoot, "sqlite", "more.sqlite3");
  const unrelatedDb = join(harness.codexRoot, "sqlite", "unrelated.db");
  const missingColumnDb = join(harness.codexRoot, "sqlite", "old-shape.sqlite");
  const originalRows = [
    { id: "index-only", provider: "legacy.provider", cwd: `/db/${SECRET}/one`, hasUserEvent: 0 },
    { id: "thread-active-1", provider: "already-other", cwd: "/db/two", hasUserEvent: 1 }
  ];
  createThreadsDatabase(legacyDb, originalRows);
  createThreadsDatabase(currentDb, [
    { id: "thread-current", provider: "legacy.provider", cwd: "/db/current", hasUserEvent: 0 }
  ]);
  createThreadsDatabase(secondDb, [
    { id: "thread-second", provider: "x", cwd: "/db/second", hasUserEvent: 1 }
  ]);
  createThreadsDatabase(thirdDb, [
    { id: "thread-third", provider: TARGET_PROVIDER, cwd: "/db/third", hasUserEvent: 0 }
  ]);
  createThreadsDatabase(unrelatedDb, [], { table: false });
  createThreadsDatabase(missingColumnDb, [
    { id: "thread-old", cwd: "/db/old", hasUserEvent: 1 }
  ], { columns: false });
  const unrelatedBefore = readFileSync(unrelatedDb);
  const missingColumnBefore = readFileSync(missingColumnDb);

  let publishCalls = 0;
  const result = await executeTransition(harness, sourceBytes, {
    publishConfig(bytes) {
      publishCalls += 1;
      assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
      assert.equal(existsSync(backupPath(harness.codexRoot)), true);
      writeFileSync(harness.configPath, bytes);
      return { changed: true, backupCreated: true };
    }
  });

  assert.equal(publishCalls, 1);
  assert.deepEqual(result, {
    handled: true,
    configPublished: true,
    publishResult: { changed: true, backupCreated: true },
    historyRepair: {
      required: true,
      completed: true,
      resumed: false,
      rolloutFiles: 2,
      rolloutRecords: 3,
      sqliteFiles: 3,
      sqliteRows: 4,
      encryptedContentDetected: true,
      backupCreated: true
    }
  });
  const serializedResult = JSON.stringify(result);
  assert.equal(serializedResult.includes(SECRET), false);
  assert.equal(serializedResult.includes(harness.codexRoot), false);
  assert.equal(serializedResult.includes("thread-active"), false);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);

  const activeText = readFileSync(activePath, "utf8");
  const activeLines = activeText.split("\n");
  assert.equal(activeText.endsWith("\n"), true);
  assert.equal(JSON.parse(activeLines[0]).payload.model_provider, TARGET_PROVIDER);
  assert.equal(activeLines[1], eventLine);
  assert.equal(JSON.parse(activeLines[2]).payload.model_provider, TARGET_PROVIDER);
  assert.equal(activeLines[3], badJson);
  assert.equal(activeLines[4], encryptedLine);
  assert.equal(activeLines[4].includes(`encrypted-${SECRET}`), true);
  const archivedText = readFileSync(archivedPath, "utf8");
  assert.equal(archivedText.endsWith("\r\n"), false);
  assert.equal(archivedText.replaceAll("\r\n", "").includes("\n"), false);
  assert.equal(JSON.parse(archivedText.split("\r\n")[0]).payload.model_provider, TARGET_PROVIDER);
  assert.equal(archivedText.split("\r\n")[1], eventLine);
  assert.equal(mtimeNs(activePath), activeBefore.mtime);
  assert.equal(mtimeNs(archivedPath), archivedBefore.mtime);
  if (process.platform !== "win32") {
    assert.equal(statSync(activePath).mode & 0o777, activeBefore.mode);
    assert.equal(statSync(archivedPath).mode & 0o777, archivedBefore.mode);
  }

  assert.deepEqual(readThreads(legacyDb), originalRows.map((row) => ({
    id: row.id,
    model_provider: TARGET_PROVIDER,
    cwd: row.cwd,
    has_user_event: row.hasUserEvent,
    title: `title-${SECRET}`
  })));
  assert.equal(readThreads(currentDb)[0].model_provider, TARGET_PROVIDER);
  assert.equal(readThreads(currentDb)[0].cwd, "/db/current");
  assert.equal(readThreads(currentDb)[0].has_user_event, 0);
  assert.equal(readThreads(secondDb)[0].model_provider, TARGET_PROVIDER);
  assert.equal(readThreads(thirdDb)[0].model_provider, TARGET_PROVIDER);
  assert.deepEqual(readFileSync(unrelatedDb), unrelatedBefore);
  assert.deepEqual(readFileSync(missingColumnDb), missingColumnBefore);
  assertUnchanged(globalStatePath, globalBefore);
  assertUnchanged(sessionIndexPath, indexBefore);
  assertPrivateTree(join(harness.codexRoot, ".crp-history-repair"));
});

test("writes a private bounded journal and backup before publishing config", async (t) => {
  const harness = makeHarness("private");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-private.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-private")}\n${JSON.stringify({
    type: "event_msg",
    payload: { message: SECRET }
  })}\n`);
  const dbPath = join(harness.codexRoot, "state_5.sqlite");
  createThreadsDatabase(dbPath, [
    { id: "thread-private", provider: "legacy.provider", cwd: `/cwd/${SECRET}`, hasUserEvent: 1 }
  ]);

  let inspected = false;
  await executeTransition(harness, sourceBytes, {
    publishConfig(bytes) {
      const journalPath = pendingPath(harness.codexRoot);
      const operationBackup = backupPath(harness.codexRoot);
      assert.equal(existsSync(journalPath), true);
      assert.equal(existsSync(operationBackup), true);
      assertPrivateTree(join(harness.codexRoot, ".crp-history-repair"));
      const journalBytes = readFileSync(journalPath, "utf8");
      const metadataBytes = readFileSync(join(operationBackup, "metadata.json"), "utf8");
      for (const managedBytes of [journalBytes, metadataBytes]) {
        assert.equal(managedBytes.includes(harness.codexRoot), false);
        assert.equal(managedBytes.includes(harness.sandbox), false);
        assert.equal(managedBytes.includes(TARGET_BASE_URL), false);
        assert.equal(managedBytes.includes("legacy.example"), false);
        assert.equal(managedBytes.includes(SECRET), false);
        assert.equal(managedBytes.includes("thread-private"), false);
        assert.equal(managedBytes.includes("rollout-private"), false);
        assert.equal(managedBytes.includes("/cwd/"), false);
      }
      const journal = JSON.parse(journalBytes);
      assert.equal(journal.sourceConfigSha256, sha256(sourceBytes));
      assert.equal(journal.targetConfigSha256, sha256(targetConfig()));
      assert.equal(journal.targetProvider, TARGET_PROVIDER);
      assert.equal(journal.operationId, "op-test-001");
      inspected = true;
      writeFileSync(harness.configPath, bytes);
      return null;
    }
  });
  assert.equal(inspected, true);
});

test("does not scan, publish, back up, or change mtimes when transition repair is unnecessary", async (t) => {
  const harness = makeHarness("noop");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig({ baseUrl: TARGET_BASE_URL });
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-noop.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-noop")}\n`);
  const before = captureFile(rolloutPath);
  let publishCalls = 0;

  const result = await executeTransition(harness, sourceBytes, {
    transition: plan(sourceBytes),
    publishConfig() {
      publishCalls += 1;
      throw new Error("must not publish");
    }
  });

  assert.equal(publishCalls, 0);
  assert.deepEqual(result, {
    handled: false,
    configPublished: false,
    publishResult: undefined,
    historyRepair: {
      required: false,
      completed: true,
      resumed: false,
      rolloutFiles: 0,
      rolloutRecords: 0,
      sqliteFiles: 0,
      sqliteRows: 0,
      encryptedContentDetected: false,
      backupCreated: false
    }
  });
  assertUnchanged(rolloutPath, before);
  assert.equal(existsSync(join(harness.codexRoot, ".crp-history-repair")), false);
});

test("does not inspect existing history during first-time config creation", async (t) => {
  const harness = makeHarness("first-config");
  t.after(() => harness.cleanup());
  const missingConfig = Buffer.alloc(0);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-before-config.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-before-config")}\n`);
  const before = captureFile(rolloutPath);
  let publishCalls = 0;

  const result = await executeTransition(harness, missingConfig, {
    currentConfigBytes: missingConfig,
    transition: plan(missingConfig, { sourceExists: false }),
    publishConfig() {
      publishCalls += 1;
      throw new Error("first config publication belongs to bootstrap");
    }
  });

  assert.equal(result.handled, false);
  assert.equal(result.historyRepair.required, false);
  assert.equal(publishCalls, 0);
  assert.equal(existsSync(harness.configPath), false);
  assertUnchanged(rolloutPath, before);
  assert.equal(existsSync(join(harness.codexRoot, ".crp-history-repair")), false);
});

test("publishes a changed binding without journal or backup when history is already aligned", async (t) => {
  const harness = makeHarness("empty-repair");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-aligned.jsonl");
  writeRollout(rolloutPath, `${rolloutLine(TARGET_PROVIDER, "thread-aligned")}\n`);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  createThreadsDatabase(databasePath, [
    { id: "thread-aligned", provider: TARGET_PROVIDER, cwd: "/already/aligned", hasUserEvent: 1 }
  ]);
  const rolloutBefore = captureFile(rolloutPath);
  const databaseBefore = readFileSync(databasePath);
  let publishCalls = 0;

  const result = await executeTransition(harness, sourceBytes, {
    publishConfig(bytes) {
      publishCalls += 1;
      assert.equal(existsSync(join(harness.codexRoot, ".crp-history-repair")), false);
      writeFileSync(harness.configPath, bytes);
      return { changed: true };
    }
  });

  assert.equal(publishCalls, 1);
  assert.deepEqual(result, {
    handled: true,
    configPublished: true,
    publishResult: { changed: true },
    historyRepair: {
      required: true,
      completed: true,
      resumed: false,
      backupCreated: false,
      rolloutFiles: 0,
      rolloutRecords: 0,
      sqliteFiles: 0,
      sqliteRows: 0,
      encryptedContentDetected: false
    }
  });
  assert.deepEqual(readFileSync(harness.configPath), targetConfig());
  assertUnchanged(rolloutPath, rolloutBefore);
  assert.deepEqual(readFileSync(databasePath), databaseBefore);
  assert.equal(existsSync(join(harness.codexRoot, ".crp-history-repair")), false);
});

test("reports config-only committed degradation without a pending journal", async (t) => {
  const harness = makeHarness("config-only-callback-degraded");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-aligned-degraded.jsonl");
  writeRollout(rolloutPath, `${rolloutLine(TARGET_PROVIDER, "aligned-degraded")}\n`);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig(bytes) {
        writeFileSync(harness.configPath, bytes);
        throw new Error(`post-commit ${SECRET}`);
      }
    }),
    (error) => assertSafeError(error, "CODEX_CONFIG_COMMITTED_DEGRADED", harness)
  );

  assert.deepEqual(readFileSync(harness.configPath), targetConfig());
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);
});

test("rejects config-only completion when the published config changes before return", async (t) => {
  const harness = makeHarness("config-only-final-config-change");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const foreignBytes = Buffer.from('model_provider = "foreign"\n', "utf8");

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      beforePendingClear() {
        writeFileSync(harness.configPath, foreignBytes);
      }
    }),
    (error) => assertSafeError(error, "CODEX_CONFIG_COMMITTED_DEGRADED", harness)
  );

  assert.deepEqual(readFileSync(harness.configPath), foreignBytes);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);
});

test("maps a config-only post-publication read failure to committed degradation", async (t) => {
  const harness = makeHarness("config-only-post-read");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  let published = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      fileOperations: {
        ...realFileOperations,
        lstatSync(path, ...args) {
          if (published && path === harness.configPath) {
            throw new Error(`post-publication read ${SECRET}`);
          }
          return realFileOperations.lstatSync(path, ...args);
        }
      },
      publishConfig(bytes) {
        writeFileSync(harness.configPath, bytes);
        published = true;
        return { changed: true };
      }
    }),
    (error) => assertSafeError(error, "CODEX_CONFIG_COMMITTED_DEGRADED", harness)
  );

  assert.equal(published, true);
  assert.deepEqual(readFileSync(harness.configPath), targetConfig());
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
});

test("maps a journaled post-publication read failure to pending degradation", async (t) => {
  const harness = makeHarness("history-post-read");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-history-post-read.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "history-post-read")}\n`);
  const rolloutBefore = captureFile(rolloutPath);
  let published = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      fileOperations: {
        ...realFileOperations,
        lstatSync(path, ...args) {
          if (published && path === harness.configPath) {
            throw new Error(`post-publication history read ${SECRET}`);
          }
          return realFileOperations.lstatSync(path, ...args);
        }
      },
      publishConfig(bytes) {
        writeFileSync(harness.configPath, bytes);
        published = true;
        return { changed: true };
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(published, true);
  assert.deepEqual(readFileSync(harness.configPath), targetConfig());
  assertUnchanged(rolloutPath, rolloutBefore);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});

test("resumes from the source hash after config publication fails", async (t) => {
  const harness = makeHarness("source-resume");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-source-resume.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-source-resume")}\n`);
  const before = captureFile(rolloutPath);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig() {
        throw new Error(`publish failed ${SECRET} ${harness.codexRoot}`);
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_FAILED", harness)
  );
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assertUnchanged(rolloutPath, before);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);

  let publishCalls = 0;
  const resumed = await executeTransition(harness, sourceBytes, {
    publishConfig(bytes) {
      publishCalls += 1;
      writeFileSync(harness.configPath, bytes);
      return "published-on-retry";
    }
  });
  assert.equal(publishCalls, 1);
  assert.equal(resumed.configPublished, true);
  assert.equal(resumed.publishResult, "published-on-retry");
  assert.equal(resumed.historyRepair.resumed, true);
  assert.equal(resumed.historyRepair.completed, true);
  assert.equal(JSON.parse(readFileSync(rolloutPath, "utf8")).payload.model_provider, TARGET_PROVIDER);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);
});

test("discovers and resumes a clearing-only pending journal", async (t) => {
  const harness = makeHarness("clearing-resume");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  const targetBytes = targetConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-clearing.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "clearing")}\n`);
  let deletionBlocked = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-clearing",
      fileOperations: {
        ...realFileOperations,
        rmSync(path, ...args) {
          if (path === clearingPath(harness.codexRoot) && !deletionBlocked) {
            deletionBlocked = true;
            throw new Error("simulated clearing interruption");
          }
          return realFileOperations.rmSync(path, ...args);
        }
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(deletionBlocked, true);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
  assert.equal(existsSync(clearingPath(harness.codexRoot)), true);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);

  const resumed = await executeTransition(harness, sourceBytes, {
    currentConfigBytes: targetBytes,
    transition: plan(targetBytes),
    id: "op-clearing-resume",
    publishConfig() {
      assert.fail("A clearing-only target transition must not republish config");
    }
  });
  assert.equal(resumed.historyRepair.resumed, true);
  assert.equal(resumed.historyRepair.completed, true);
  assert.equal(existsSync(clearingPath(harness.codexRoot)), false);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);
});

test("rebuilds a discoverable pending marker when post-delete durability fails", async (t) => {
  const harness = makeHarness("clear-durability");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-clear-durability.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "clear-durability")}\n`);
  const managed = dirname(pendingPath(harness.codexRoot));
  let clearStarted = false;
  let durabilityFailed = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-clear-durability",
      fileOperations: {
        ...realFileOperations,
        fsyncDirectorySync(path) {
          if (path !== managed) return;
          if (existsSync(clearingPath(harness.codexRoot))) clearStarted = true;
          if (clearStarted && !durabilityFailed
            && !existsSync(pendingPath(harness.codexRoot))
            && !existsSync(clearingPath(harness.codexRoot))) {
            durabilityFailed = true;
            throw new Error("simulated directory fsync failure");
          }
        }
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(durabilityFailed, true);
  assert.equal(existsSync(clearingPath(harness.codexRoot)), false);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), true);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});

test("requests config-lock retention when pending restoration also fails", async (t) => {
  const harness = makeHarness("clear-retain-lock");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-retain-lock.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "retain-lock")}\n`);
  const managed = dirname(pendingPath(harness.codexRoot));
  let clearStarted = false;
  let durabilityFailed = false;
  let restorationBlocked = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-retain-lock",
      fileOperations: {
        ...realFileOperations,
        fsyncDirectorySync(path) {
          if (path !== managed) return;
          if (existsSync(clearingPath(harness.codexRoot))) clearStarted = true;
          if (clearStarted && !durabilityFailed
            && !existsSync(pendingPath(harness.codexRoot))
            && !existsSync(clearingPath(harness.codexRoot))) {
            durabilityFailed = true;
            throw new Error("simulated clear durability failure");
          }
        },
        linkSync(source, destination, ...args) {
          if (durabilityFailed && destination === pendingPath(harness.codexRoot)) {
            restorationBlocked = true;
            const error = new Error("simulated pending restoration failure");
            error.code = "EIO";
            throw error;
          }
          return realFileOperations.linkSync(source, destination, ...args);
        }
      }
    }),
    (error) => {
      assertSafeError(error, "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED", harness);
      assert.equal(error.retainConfigLock, true);
      assert.equal(Object.keys(error).includes("retainConfigLock"), false);
      return true;
    }
  );

  assert.equal(durabilityFailed, true);
  assert.equal(restorationBlocked, true);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
  assert.equal(existsSync(clearingPath(harness.codexRoot)), false);
});

test("resumes partial SQLite completion from the target hash and is idempotent after final verification", async (t) => {
  const harness = makeHarness("target-resume");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  const targetBytes = targetConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-target-resume.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-target-resume")}\n`);
  const firstDb = join(harness.codexRoot, "sqlite", "a-first.sqlite");
  const failingDb = join(harness.codexRoot, "sqlite", "z-failing.sqlite");
  createThreadsDatabase(firstDb, [
    { id: "first-index-only", provider: "legacy.provider", cwd: "/one", hasUserEvent: 0 }
  ]);
  createThreadsDatabase(failingDb, [
    { id: "second-index-only", provider: "legacy.provider", cwd: "/two", hasUserEvent: 1 }
  ], { triggerIgnore: true });

  await assert.rejects(
    () => executeTransition(harness, sourceBytes),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED", harness)
  );
  assert.deepEqual(readFileSync(harness.configPath), targetBytes);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
  assert.equal(readThreads(firstDb)[0].model_provider, TARGET_PROVIDER);
  assert.equal(readThreads(failingDb)[0].model_provider, "legacy.provider");
  removeTrigger(failingDb);

  let publishCalls = 0;
  const resumed = await executeTransition(harness, sourceBytes, {
    currentConfigBytes: targetBytes,
    transition: plan(targetBytes),
    publishConfig() {
      publishCalls += 1;
      throw new Error("must not republish a target-hash config");
    }
  });
  assert.equal(publishCalls, 0);
  assert.equal(resumed.configPublished, true);
  assert.equal(resumed.historyRepair.resumed, true);
  assert.equal(resumed.historyRepair.completed, true);
  assert.equal(readThreads(firstDb)[0].model_provider, TARGET_PROVIDER);
  assert.equal(readThreads(failingDb)[0].model_provider, TARGET_PROVIDER);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);

  const rolloutAfter = captureFile(rolloutPath);
  const firstDbAfter = captureFile(firstDb);
  const backupNames = readdirSync(join(harness.codexRoot, ".crp-history-repair", "backups"));
  const noOpTransition = plan(targetBytes);
  const noOp = await executeTransition(harness, targetBytes, {
    currentConfigBytes: targetBytes,
    transition: noOpTransition,
    id: "must-not-be-created",
    publishConfig() {
      throw new Error("must remain idempotent");
    }
  });
  assert.equal(noOp.handled, false);
  assertUnchanged(rolloutPath, rolloutAfter);
  assert.deepEqual(readFileSync(firstDb), firstDbAfter.bytes);
  assert.deepEqual(
    readdirSync(join(harness.codexRoot, ".crp-history-repair", "backups")),
    backupNames
  );
});

test("a conflicting pending transition fails with zero writes and no sensitive error data", async (t) => {
  const harness = makeHarness("conflict");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-conflict.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-conflict")}\n`);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig() {
        throw new Error("leave pending");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_FAILED", harness)
  );

  const foreignConfig = Buffer.from([
    'model_provider = "foreign"',
    '[model_providers.foreign]',
    `base_url = "https://${SECRET}@foreign.example/v1"`,
    ""
  ].join("\n"));
  writeFileSync(harness.configPath, foreignConfig);
  const rolloutBefore = captureFile(rolloutPath);
  const pendingBefore = captureFile(pendingPath(harness.codexRoot));
  const backupBefore = readdirSync(join(harness.codexRoot, ".crp-history-repair", "backups"));
  let publishCalls = 0;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      currentConfigBytes: foreignConfig,
      publishConfig() {
        publishCalls += 1;
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );
  assert.equal(publishCalls, 0);
  assert.deepEqual(readFileSync(harness.configPath), foreignConfig);
  assertUnchanged(rolloutPath, rolloutBefore);
  assertUnchanged(pendingPath(harness.codexRoot), pendingBefore);
  assert.deepEqual(
    readdirSync(join(harness.codexRoot, ".crp-history-repair", "backups")),
    backupBefore
  );
});

test("fails closed when canonical and clearing pending markers coexist", async (t) => {
  const harness = makeHarness("dual-pending-marker");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-dual-marker.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "dual-marker")}\n`);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-dual-marker",
      publishConfig() {
        throw new Error("leave pending");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_FAILED", harness)
  );
  writePrivate(clearingPath(harness.codexRoot), readFileSync(pendingPath(harness.codexRoot)));
  const rolloutBefore = captureFile(rolloutPath);

  assert.throws(
    () => hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );
  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig() {
        assert.fail("Conflicting pending markers must block config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );
  assertUnchanged(rolloutPath, rolloutBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
});

test("rejects unsafe rollout symlinks and backup failures before config or history writes", async (t) => {
  const harness = makeHarness("unsafe");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const externalPath = join(harness.sandbox, "external-rollout.jsonl");
  writePrivate(externalPath, `${rolloutLine("legacy.provider", "thread-external")}\n`);
  const symlinkPath = join(harness.codexRoot, "sessions", "rollout-link.jsonl");
  mkdirSync(dirname(symlinkPath), { recursive: true });
  try {
    symlinkSync(externalPath, symlinkPath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("symlink creation is unavailable on this platform");
      return;
    }
    throw error;
  }
  const externalBefore = captureFile(externalPath);
  let publishCalls = 0;
  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig() {
        publishCalls += 1;
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_INVALID", harness)
  );
  assert.equal(publishCalls, 0);
  assertUnchanged(externalPath, externalBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);

  unlinkSync(symlinkPath);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-backup-failure.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-backup-failure")}\n`);
  const dbPath = join(harness.codexRoot, "state_5.sqlite");
  createThreadsDatabase(dbPath, [
    { id: "thread-backup-failure", provider: "legacy.provider", cwd: "/safe", hasUserEvent: 0 }
  ]);
  const rolloutBefore = captureFile(rolloutPath);
  const databaseBefore = readFileSync(dbPath);
  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-backup-failure",
      databaseOperations: {
        open(path) {
          return new DatabaseSync(path);
        },
        async backup(_database, destination) {
          writeFileSync(destination, "partial sqlite backup", "utf8");
          throw new Error(`backup ${SECRET} ${harness.codexRoot}`);
        }
      },
      publishConfig() {
        publishCalls += 1;
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_FAILED", harness)
  );
  assert.equal(publishCalls, 0);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assertUnchanged(rolloutPath, rolloutBefore);
  assert.deepEqual(readFileSync(dbPath), databaseBefore);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
  assert.deepEqual(
    readdirSync(backupPath(harness.codexRoot, "op-backup-failure"), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".tmp") || path.endsWith(".claim")),
    []
  );
});

test("publishes SQLite backups exclusively without overwriting a raced destination", async (t) => {
  const harness = makeHarness("sqlite-backup-race");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  createThreadsDatabase(databasePath, [
    { id: "sqlite-race", provider: "legacy.provider", cwd: "/race", hasUserEvent: 1 }
  ]);
  const databaseBefore = readFileSync(databasePath);
  const racedBytes = Buffer.from("foreign raced sqlite backup\n", "utf8");
  let racedDestination = null;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-sqlite-backup-race",
      fileOperations: {
        ...realFileOperations,
        linkSync(source, destination, ...args) {
          if (racedDestination === null && destination.endsWith(".bak")
            && basename(destination).startsWith("state_5.sqlite.")) {
            racedDestination = destination;
            writePrivate(destination, racedBytes);
          }
          return realFileOperations.linkSync(source, destination, ...args);
        }
      },
      publishConfig() {
        assert.fail("A raced backup destination must block config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );

  assert.notEqual(racedDestination, null);
  assert.deepEqual(readFileSync(racedDestination), racedBytes);
  assert.deepEqual(readFileSync(databasePath), databaseBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.deepEqual(
    readdirSync(backupPath(harness.codexRoot, "op-sqlite-backup-race"), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".tmp") || path.endsWith(".claim")),
    []
  );
});

test("falls back to an exclusive SQLite backup copy when hard links are unavailable", async (t) => {
  const harness = makeHarness("sqlite-backup-copy-fallback");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  createThreadsDatabase(databasePath, [
    { id: "sqlite-copy", provider: "legacy.provider", cwd: "/copy", hasUserEvent: 1 }
  ]);
  let hardLinkRejected = false;

  const result = await executeTransition(harness, sourceBytes, {
    id: "op-sqlite-backup-copy-fallback",
    fileOperations: {
      ...realFileOperations,
      linkSync(source, destination, ...args) {
        if (destination.endsWith(".bak")
          && basename(destination).startsWith("state_5.sqlite.")) {
          hardLinkRejected = true;
          const error = new Error("hard links unavailable");
          error.code = "EPERM";
          throw error;
        }
        return realFileOperations.linkSync(source, destination, ...args);
      }
    },
    publishConfig(bytes) {
      writeFileSync(harness.configPath, bytes);
      return { changed: true };
    }
  });

  assert.equal(hardLinkRejected, true);
  assert.equal(result.historyRepair.completed, true);
  assert.equal(result.historyRepair.sqliteFiles, 1);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);
});

test("rejects a SQLite backup destination replaced during temp-link cleanup", async (t) => {
  const harness = makeHarness("sqlite-backup-final-race");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  createThreadsDatabase(databasePath, [
    { id: "sqlite-final-race", provider: "legacy.provider", cwd: "/race", hasUserEvent: 1 }
  ]);
  const databaseBefore = readFileSync(databasePath);
  const foreignBytes = Buffer.from("foreign replacement sqlite backup\n", "utf8");
  let destinationPath = null;
  let replaced = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-sqlite-backup-final-race",
      fileOperations: {
        ...realFileOperations,
        linkSync(source, destination, ...args) {
          if (destination.endsWith(".bak")
            && basename(destination).startsWith("state_5.sqlite.")) {
            destinationPath = destination;
          }
          return realFileOperations.linkSync(source, destination, ...args);
        },
        rmSync(path, ...args) {
          const result = realFileOperations.rmSync(path, ...args);
          if (!replaced && destinationPath !== null && path.endsWith(".claim")) {
            replaced = true;
            realFileOperations.rmSync(destinationPath);
            writePrivate(destinationPath, foreignBytes);
          }
          return result;
        }
      },
      publishConfig() {
        assert.fail("A replaced backup destination must block config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );

  assert.equal(replaced, true);
  assert.deepEqual(readFileSync(destinationPath), foreignBytes);
  assert.deepEqual(readFileSync(databasePath), databaseBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
});

test("rejects hard-linked SQLite files before config or history writes", async (t) => {
  const harness = makeHarness("sqlite-hardlink");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  const externalPath = join(harness.sandbox, "external-state.sqlite");
  createThreadsDatabase(databasePath, [
    { id: "hardlink", provider: "legacy.provider", cwd: "/hardlink", hasUserEvent: 1 }
  ]);
  try {
    realFileOperations.linkSync(databasePath, externalPath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOTSUP") {
      t.skip("hard-link creation is unavailable on this platform");
      return;
    }
    throw error;
  }
  const externalBefore = readFileSync(externalPath);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig() {
        assert.fail("A hard-linked database must block config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_INVALID", harness)
  );

  assert.deepEqual(readFileSync(databasePath), externalBefore);
  assert.deepEqual(readFileSync(externalPath), externalBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(existsSync(join(harness.codexRoot, ".crp-history-repair")), false);
});

test("rejects a symbolic-link SQLite sidecar before opening the database", async (t) => {
  const harness = makeHarness("sqlite-sidecar-symlink");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  const externalPath = join(harness.sandbox, "external-wal");
  const sidecarPath = `${databasePath}-wal`;
  createThreadsDatabase(databasePath, [
    { id: "sidecar-link", provider: "legacy.provider", cwd: "/sidecar", hasUserEvent: 1 }
  ]);
  writePrivate(externalPath, "external wal bytes\n");
  try {
    symlinkSync(externalPath, sidecarPath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("symlink creation is unavailable on this platform");
      return;
    }
    throw error;
  }
  const externalBefore = readFileSync(externalPath);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig() {
        assert.fail("An unsafe SQLite sidecar must block config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_INVALID", harness)
  );

  assert.deepEqual(readFileSync(externalPath), externalBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(existsSync(join(harness.codexRoot, ".crp-history-repair")), false);
});

test("rejects a hard-linked SQLite sidecar before opening the database", async (t) => {
  const harness = makeHarness("sqlite-sidecar-hardlink");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  const sidecarPath = `${databasePath}-journal`;
  const externalPath = join(harness.sandbox, "external-journal");
  createThreadsDatabase(databasePath, [
    { id: "sidecar-hardlink", provider: "legacy.provider", cwd: "/sidecar", hasUserEvent: 1 }
  ]);
  writePrivate(sidecarPath, "journal bytes\n");
  try {
    realFileOperations.linkSync(sidecarPath, externalPath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOTSUP") {
      t.skip("hard-link creation is unavailable on this platform");
      return;
    }
    throw error;
  }
  const externalBefore = readFileSync(externalPath);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig() {
        assert.fail("A hard-linked SQLite sidecar must block config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_INVALID", harness)
  );

  assert.deepEqual(readFileSync(sidecarPath), externalBefore);
  assert.deepEqual(readFileSync(externalPath), externalBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(existsSync(join(harness.codexRoot, ".crp-history-repair")), false);
});

test("rejects a corrupt existing rollout backup before config or history writes", async (t) => {
  const harness = makeHarness("corrupt-rollout-backup");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutBytes = Buffer.from(`${rolloutLine("legacy.provider", "corrupt-backup")}\n`);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-corrupt.jsonl");
  writeRollout(rolloutPath, rolloutBytes);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-corrupt-backup",
      publishConfig() {
        throw new Error("leave source-hash pending");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_FAILED", harness)
  );
  const destination = join(
    backupPath(harness.codexRoot, "op-corrupt-backup"),
    "rollouts",
    "sessions",
    `rollout-corrupt.jsonl.${sha256(rolloutBytes)}.bak`
  );
  writeFileSync(destination, "corrupt", { mode: 0o600 });
  const rolloutBefore = captureFile(rolloutPath);
  let publishCalls = 0;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-corrupt-backup-resume",
      publishConfig() {
        publishCalls += 1;
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );
  assert.equal(publishCalls, 0);
  assertUnchanged(rolloutPath, rolloutBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});

test("does not expose a final rollout backup when atomic publication fails", async (t) => {
  const harness = makeHarness("atomic-rollout-backup");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutBytes = Buffer.from(`${rolloutLine("legacy.provider", "atomic-backup")}\n`);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-atomic.jsonl");
  writeRollout(rolloutPath, rolloutBytes);
  const suffix = `rollout-atomic.jsonl.${sha256(rolloutBytes)}.bak`;
  let publicationBlocked = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-atomic-backup",
      fileOperations: {
        ...realFileOperations,
        linkSync(source, destination, ...args) {
          if (destination.endsWith(suffix)) {
            publicationBlocked = true;
            const error = new Error("simulated backup publication failure");
            error.code = "EIO";
            throw error;
          }
          return realFileOperations.linkSync(source, destination, ...args);
        }
      },
      publishConfig() {
        assert.fail("A backup publication failure must precede config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_FAILED", harness)
  );

  assert.equal(publicationBlocked, true);
  const operationRoot = backupPath(harness.codexRoot, "op-atomic-backup");
  const names = existsSync(operationRoot)
    ? readdirSync(operationRoot, { recursive: true }).map(String)
    : [];
  assert.equal(names.some((name) => name.endsWith(suffix)), false);
  assert.equal(names.some((name) => name.includes(".tmp") || name.includes(".claim")), false);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
});

test("validates rollout backups published by an EEXIST race", async (t) => {
  for (const [label, racedBytes, expectedCode] of [
    ["matching", null, null],
    ["conflicting", Buffer.from("conflicting-backup"), "CODEX_HISTORY_REPAIR_CONFLICT"]
  ]) {
    await t.test(label, async (subtest) => {
      const harness = makeHarness(`backup-race-${label}`);
      subtest.after(() => harness.cleanup());
      const sourceBytes = sourceConfig();
      writePrivate(harness.configPath, sourceBytes);
      const rolloutBytes = Buffer.from(`${rolloutLine("legacy.provider", `race-${label}`)}\n`);
      const rolloutPath = join(harness.codexRoot, "sessions", `rollout-race-${label}.jsonl`);
      writeRollout(rolloutPath, rolloutBytes);
      const suffix = `rollout-race-${label}.jsonl.${sha256(rolloutBytes)}.bak`;
      let raced = false;
      let publishCalls = 0;
      const options = {
        id: `op-backup-race-${label}`,
        fileOperations: {
          ...realFileOperations,
          linkSync(source, destination, ...args) {
            if (!raced && destination.endsWith(suffix)) {
              raced = true;
              writePrivate(destination, racedBytes ?? rolloutBytes);
              const error = new Error("simulated EEXIST race");
              error.code = "EEXIST";
              throw error;
            }
            return realFileOperations.linkSync(source, destination, ...args);
          }
        },
        publishConfig(bytes) {
          publishCalls += 1;
          writeFileSync(harness.configPath, bytes);
          return { changed: true };
        }
      };

      if (expectedCode === null) {
        const result = await executeTransition(harness, sourceBytes, options);
        assert.equal(result.historyRepair.completed, true);
        assert.equal(result.historyRepair.backupCreated, true);
        assert.equal(publishCalls, 1);
      } else {
        await assert.rejects(
          () => executeTransition(harness, sourceBytes, options),
          (error) => assertSafeError(error, expectedCode, harness)
        );
        assert.equal(publishCalls, 0);
        assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
      }
      assert.equal(raced, true);
    });
  }
});

test("preserves a discoverable replacement when pending changes during clear", async (t) => {
  const harness = makeHarness("clear-replacement");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  const targetBytes = targetConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-clear-replacement.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "clear-replacement")}\n`);
  let replaced = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-clear-replacement",
      fileOperations: {
        ...realFileOperations,
        renameSync(source, destination, ...args) {
          const result = realFileOperations.renameSync(source, destination, ...args);
          if (!replaced && source === pendingPath(harness.codexRoot)
            && destination === clearingPath(harness.codexRoot)) {
            const bytes = readFileSync(destination);
            unlinkSync(destination);
            writePrivate(destination, bytes);
            replaced = true;
          }
          return result;
        }
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(replaced, true);
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
  assert.equal(existsSync(clearingPath(harness.codexRoot)), true);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
  const resumed = await executeTransition(harness, sourceBytes, {
    currentConfigBytes: targetBytes,
    transition: plan(targetBytes),
    id: "op-clear-replacement-resume",
    publishConfig() {
      assert.fail("A target-hash clear recovery must not republish config");
    }
  });
  assert.equal(resumed.historyRepair.resumed, true);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);
});

test("rejects a symlinked rollout backup without reading or changing its target", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink behavior requires a POSIX test host");
    return;
  }
  const harness = makeHarness("symlink-rollout-backup");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutBytes = Buffer.from(`${rolloutLine("legacy.provider", "symlink-backup")}\n`);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-symlink-backup.jsonl");
  writeRollout(rolloutPath, rolloutBytes);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-symlink-backup",
      publishConfig() {
        throw new Error("leave source-hash pending");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_FAILED", harness)
  );
  const destination = join(
    backupPath(harness.codexRoot, "op-symlink-backup"),
    "rollouts",
    "sessions",
    `rollout-symlink-backup.jsonl.${sha256(rolloutBytes)}.bak`
  );
  const external = join(harness.sandbox, "external-backup-target");
  writePrivate(external, `external-${SECRET}`);
  unlinkSync(destination);
  symlinkSync(external, destination);
  const externalBefore = captureFile(external);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-symlink-backup-resume",
      publishConfig() {
        assert.fail("A symlinked backup must block config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );
  assertUnchanged(external, externalBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
});

test("rejects a symlinked backups ancestor before resume reads external state", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink behavior requires a POSIX test host");
    return;
  }
  const harness = makeHarness("symlink-backups-parent");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-backups-parent.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "backups-parent")}\n`);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-backups-parent",
      publishConfig() {
        throw new Error("leave source-hash pending");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_FAILED", harness)
  );
  const backups = join(harness.codexRoot, ".crp-history-repair", "backups");
  const external = join(harness.sandbox, "external-backups");
  realFileOperations.renameSync(backups, external);
  symlinkSync(external, backups);
  const externalMetadata = join(external, "op-backups-parent", "metadata.json");
  const metadataBefore = captureFile(externalMetadata);
  const rolloutBefore = captureFile(rolloutPath);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-backups-parent-resume",
      publishConfig() {
        assert.fail("A symlinked backups parent must block config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );
  assertUnchanged(externalMetadata, metadataBefore);
  assertUnchanged(rolloutPath, rolloutBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
});

test("rejects rollout identity replacement without overwriting either identity", async (t) => {
  const harness = makeHarness("identity");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-identity.jsonl");
  const originalBytes = Buffer.from(`${rolloutLine("legacy.provider", "thread-original")}\n`);
  const replacementBytes = Buffer.from(`${rolloutLine("foreign", "thread-replacement", {
    note: SECRET
  })}\n`);
  writeRollout(rolloutPath, originalBytes);
  let rolloutDescriptor;
  let descriptorRead = false;
  let replaced = false;
  let publishCalls = 0;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      fileOperations: {
        ...realFileOperations,
        openSync(path, ...args) {
          const descriptor = realFileOperations.openSync(path, ...args);
          if (path === rolloutPath) rolloutDescriptor = descriptor;
          return descriptor;
        },
        readFileSync(pathOrDescriptor, ...args) {
          const value = realFileOperations.readFileSync(pathOrDescriptor, ...args);
          if (pathOrDescriptor === rolloutDescriptor && !descriptorRead) {
            descriptorRead = true;
            realFileOperations.unlinkSync(rolloutPath);
            realFileOperations.writeFileSync(rolloutPath, replacementBytes, { mode: 0o600 });
            replaced = true;
          }
          return value;
        }
      },
      publishConfig() {
        publishCalls += 1;
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );
  assert.equal(descriptorRead, true);
  assert.equal(replaced, true);
  assert.equal(publishCalls, 0);
  assert.deepEqual(readFileSync(rolloutPath), replacementBytes);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
});

test("applies rollout mode and timestamps before publishing the replacement inode", async (t) => {
  const harness = makeHarness("rollout-metadata-before-publish");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-metadata.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "metadata")}\n`, {
    mode: 0o640,
    mtime: FIXED_TIME
  });
  const before = captureFile(rolloutPath);
  let metadataBlocked = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      fileOperations: {
        ...realFileOperations,
        futimesSync(...args) {
          if (!metadataBlocked) {
            metadataBlocked = true;
            throw new Error("simulated metadata failure");
          }
          return realFileOperations.futimesSync(...args);
        }
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(metadataBlocked, true);
  assertUnchanged(rolloutPath, before);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});

test("retry fsyncs a previously published rollout directory before clearing pending", async (t) => {
  const harness = makeHarness("rollout-directory-retry");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  const targetBytes = targetConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-directory.jsonl");
  const rolloutDirectory = dirname(rolloutPath);
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "directory-retry")}\n`, {
    mode: 0o640,
    mtime: FIXED_TIME
  });
  const before = captureFile(rolloutPath);
  let directoryFsyncFailed = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      fileOperations: {
        ...realFileOperations,
        fsyncDirectorySync(path) {
          if (path === rolloutDirectory && !directoryFsyncFailed) {
            directoryFsyncFailed = true;
            throw new Error("simulated rollout directory fsync failure");
          }
        }
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );
  assert.equal(directoryFsyncFailed, true);
  assert.equal(JSON.parse(readFileSync(rolloutPath, "utf8")).payload.model_provider,
    TARGET_PROVIDER);
  assert.equal(mtimeNs(rolloutPath), before.mtime);
  if (process.platform !== "win32") {
    assert.equal(statSync(rolloutPath).mode & 0o777, before.mode);
  }

  const fsynced = [];
  const resumed = await executeTransition(harness, sourceBytes, {
    currentConfigBytes: targetBytes,
    transition: plan(targetBytes),
    id: "op-rollout-directory-resume",
    fileOperations: {
      ...realFileOperations,
      fsyncDirectorySync(path) { fsynced.push(path); }
    },
    publishConfig() {
      assert.fail("A target-hash directory recovery must not republish config");
    }
  });
  assert.equal(resumed.historyRepair.resumed, true);
  assert.equal(fsynced.includes(rolloutDirectory), true);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), false);
});

test("rejects asynchronous config publication so completion cannot outrun the config commit", async (t) => {
  const harness = makeHarness("async-publish");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-async.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-async")}\n`);
  const before = captureFile(rolloutPath);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      publishConfig() {
        return Promise.resolve({ changed: true });
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_INVALID", harness)
  );
  assertUnchanged(rolloutPath, before);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
});

test("repairs only rollout snapshots backed before config publication and defers later files", async (t) => {
  const harness = makeHarness("exact-rollout-set");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  const targetBytes = targetConfig();
  writePrivate(harness.configPath, sourceBytes);
  const changedPath = join(harness.codexRoot, "sessions", "rollout-changed.jsonl");
  const addedPath = join(harness.codexRoot, "sessions", "rollout-added.jsonl");
  writeRollout(changedPath, `${rolloutLine("legacy.provider", "before-publish")}\n`);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-exact-rollout",
      publishConfig(bytes) {
        writeFileSync(harness.configPath, bytes);
        writeRollout(changedPath, `${rolloutLine("changed-after-backup", "after-publish")}\n`);
        writeRollout(addedPath, `${rolloutLine("added-after-backup", "new-after-publish")}\n`);
        return { changed: true };
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(JSON.parse(readFileSync(changedPath, "utf8")).payload.model_provider,
    "changed-after-backup");
  assert.equal(JSON.parse(readFileSync(addedPath, "utf8")).payload.model_provider,
    "added-after-backup");
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);

  const resumed = await executeTransition(harness, sourceBytes, {
    currentConfigBytes: targetBytes,
    transition: plan(targetBytes),
    id: "op-exact-rollout-retry",
    publishConfig() {
      assert.fail("A target-hash recovery must not republish config");
    }
  });
  assert.equal(resumed.historyRepair.resumed, true);
  assert.equal(resumed.historyRepair.rolloutFiles, 2);
  assert.equal(JSON.parse(readFileSync(changedPath, "utf8")).payload.model_provider,
    TARGET_PROVIDER);
  assert.equal(JSON.parse(readFileSync(addedPath, "utf8")).payload.model_provider,
    TARGET_PROVIDER);
});

test("updates only SQLite rows included in the completed online backup snapshot", async (t) => {
  const harness = makeHarness("exact-sqlite-set");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  const targetBytes = targetConfig();
  writePrivate(harness.configPath, sourceBytes);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  createThreadsDatabase(databasePath, [
    { id: "backed-row", provider: "legacy.provider", cwd: "/backed", hasUserEvent: 1 }
  ]);
  let injected = false;
  let openCalls = 0;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-exact-sqlite",
      databaseOperations: {
        open(path) {
          openCalls += 1;
          const database = new DatabaseSync(path);
          if (openCalls !== 2) return database;
          return {
            prepare(sql) { return database.prepare(sql); },
            exec(sql) {
              const result = database.exec(sql);
              if (sql === "COMMIT" && !injected) {
                injected = true;
                const writer = new DatabaseSync(databasePath);
                try {
                  writer.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
                    "post-backup-row",
                    "legacy.provider",
                    "/post-backup",
                    0,
                    "post-backup"
                  );
                } finally {
                  writer.close();
                }
              }
              return result;
            },
            close() { return database.close(); }
          };
        },
        async backup(database, destination) {
          await sqliteBackup(database, destination);
        }
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(injected, true);
  const afterFirstAttempt = readThreads(databasePath);
  assert.equal(afterFirstAttempt.find((row) => row.id === "backed-row").model_provider,
    TARGET_PROVIDER);
  assert.equal(afterFirstAttempt.find((row) => row.id === "post-backup-row").model_provider,
    "legacy.provider");

  const resumed = await executeTransition(harness, sourceBytes, {
    currentConfigBytes: targetBytes,
    transition: plan(targetBytes),
    id: "op-exact-sqlite-retry",
    publishConfig() {
      assert.fail("A target-hash recovery must not republish config");
    }
  });
  assert.equal(resumed.historyRepair.resumed, true);
  assert.equal(resumed.historyRepair.sqliteRows, 1);
  assert.equal(readThreads(databasePath).every(
    (row) => row.model_provider === TARGET_PROVIDER
  ), true);
});

test("rejects a canonical SQLite inode replacement after open and before backup", async (t) => {
  const harness = makeHarness("sqlite-open-identity");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const databasePath = join(harness.codexRoot, "state_5.sqlite");
  const displacedPath = join(harness.codexRoot, "displaced.sqlite");
  createThreadsDatabase(databasePath, [
    { id: "original", provider: "legacy.provider", cwd: "/original", hasUserEvent: 1 }
  ]);
  let openCalls = 0;
  let replaced = false;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-sqlite-identity",
      databaseOperations: {
        open(path) {
          openCalls += 1;
          const database = new DatabaseSync(path);
          if (openCalls === 2) {
            realFileOperations.renameSync(databasePath, displacedPath);
            createThreadsDatabase(databasePath, [
              { id: "foreign", provider: "foreign", cwd: "/foreign", hasUserEvent: 0 }
            ]);
            replaced = true;
          }
          return database;
        },
        async backup(database, destination) {
          await sqliteBackup(database, destination);
        }
      },
      publishConfig() {
        assert.fail("An identity conflict must be rejected before config publication");
      }
    }),
    (error) => assertSafeError(error, "CODEX_HISTORY_REPAIR_CONFLICT", harness)
  );

  assert.equal(replaced, true);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(readThreads(databasePath)[0].id, "foreign");
  assert.equal(readThreads(displacedPath)[0].id, "original");
  assert.equal(existsSync(pendingPath(harness.codexRoot)), false);
});

test("maps target-hash discovery failures to committed degradation and retains pending", async (t) => {
  const harness = makeHarness("target-discovery-failure");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  const targetBytes = targetConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-initial.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "initial")}\n`);

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      id: "op-target-discovery",
      publishConfig(bytes) {
        writeFileSync(harness.configPath, bytes);
        throw new Error("post-commit callback failure");
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );
  const external = join(harness.sandbox, "external.jsonl");
  writePrivate(external, `${rolloutLine("foreign", "external")}\n`);
  const unsafeLink = join(harness.codexRoot, "sessions", "rollout-link.jsonl");
  try {
    symlinkSync(external, unsafeLink);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("symlink creation is unavailable on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      currentConfigBytes: targetBytes,
      transition: plan(targetBytes),
      id: "op-target-discovery-retry",
      publishConfig() {
        assert.fail("A target-hash recovery must not republish config");
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});

test("fsyncs backup and pending directory entries before invoking config publication", async (t) => {
  const harness = makeHarness("directory-fsync-order");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-fsync.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "fsync-order")}\n`);
  const events = [];

  await executeTransition(harness, sourceBytes, {
    id: "op-directory-fsync",
    fileOperations: {
      ...realFileOperations,
      fsyncDirectorySync(path) {
        events.push(["directory-fsync", path]);
      }
    },
    publishConfig(bytes) {
      events.push(["publish-config", harness.configPath]);
      writeFileSync(harness.configPath, bytes);
      return { changed: true };
    }
  });

  const publishIndex = events.findIndex(([name]) => name === "publish-config");
  const pendingDirectory = dirname(pendingPath(harness.codexRoot));
  const pendingFsyncIndex = events.findLastIndex(([name, path], index) => (
    index < publishIndex && name === "directory-fsync" && path === pendingDirectory
  ));
  const backupFsyncIndex = events.findIndex(([name, path]) => (
    name === "directory-fsync" && path.includes(`${sep}backups${sep}`)
  ));
  assert.ok(backupFsyncIndex >= 0 && backupFsyncIndex < pendingFsyncIndex);
  assert.ok(pendingFsyncIndex >= 0 && pendingFsyncIndex < publishIndex);
});

test("stops before history writes when config-lock ownership changes after publication", async (t) => {
  const harness = makeHarness("post-publish-lock");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-lock.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "thread-lock")}\n`);
  const before = captureFile(rolloutPath);
  let ownershipChecks = 0;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      assertConfigLock() {
        ownershipChecks += 1;
        if (ownershipChecks === 2) throw new Error("lock ownership changed");
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(ownershipChecks, 2);
  assert.deepEqual(readFileSync(harness.configPath), targetConfig());
  assertUnchanged(rolloutPath, before);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});

test("preserves pending when config-lock ownership changes after final verification", async (t) => {
  const harness = makeHarness("final-verify-lock");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-final-lock.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "final-lock")}\n`);
  let ownershipChecks = 0;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      assertConfigLock() {
        ownershipChecks += 1;
        if (ownershipChecks === 4) throw new Error("lock changed after final verify");
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(ownershipChecks, 4);
  assert.equal(JSON.parse(readFileSync(rolloutPath, "utf8")).payload.model_provider,
    TARGET_PROVIDER);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});

test("stops before history writes when config changes after publication verification", async (t) => {
  const harness = makeHarness("post-publish-config-change");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-config-change.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "config-change")}\n`);
  const rolloutBefore = captureFile(rolloutPath);
  let ownershipChecks = 0;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      assertConfigLock() {
        ownershipChecks += 1;
        if (ownershipChecks === 2) writeFileSync(harness.configPath, sourceBytes);
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(ownershipChecks, 2);
  assertUnchanged(rolloutPath, rolloutBefore);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});

test("preserves pending when config changes after final history verification", async (t) => {
  const harness = makeHarness("final-config-change");
  t.after(() => harness.cleanup());
  const sourceBytes = sourceConfig();
  writePrivate(harness.configPath, sourceBytes);
  const rolloutPath = join(harness.codexRoot, "sessions", "rollout-final-config.jsonl");
  writeRollout(rolloutPath, `${rolloutLine("legacy.provider", "final-config")}\n`);
  let ownershipChecks = 0;

  await assert.rejects(
    () => executeTransition(harness, sourceBytes, {
      assertConfigLock() {
        ownershipChecks += 1;
        if (ownershipChecks === 4) writeFileSync(harness.configPath, sourceBytes);
      }
    }),
    (error) => assertSafeError(
      error,
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      harness
    )
  );

  assert.equal(ownershipChecks, 4);
  assert.equal(JSON.parse(readFileSync(rolloutPath, "utf8")).payload.model_provider,
    TARGET_PROVIDER);
  assert.deepEqual(readFileSync(harness.configPath), sourceBytes);
  assert.equal(hasPendingCodexHistoryRepair({ codexRoot: harness.codexRoot }), true);
});
