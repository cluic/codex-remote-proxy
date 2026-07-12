# CRP Multi-Provider Local Management V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Web management experience that can add, test, activate, and switch multiple OpenAI-compatible providers while keeping Codex on a fixed provider identity and reliably managing an independent proxy worker.

**Architecture:** A loopback-only supervisor owns provider metadata, credentials, Codex bootstrap, activity, the Admin API, and a static UI. It controls a child proxy worker through a versioned IPC protocol; the worker applies monotonically increasing immutable settings snapshots so new requests switch atomically while in-flight requests remain pinned.

**Tech Stack:** Node.js ESM 22.13+, built-in `node:http`, `node:test`, `child_process.fork`, JSON persistence, `@napi-rs/keyring`, vanilla HTML/CSS/ES modules, Playwright, npm/Changesets.

---

## Scope and File Map

### Existing files to modify

- `node/bin/crp.mjs`: reduce to CLI parsing, supervisor discovery, and command dispatch while retaining compatibility aliases.
- `node/src/server.mjs`: obtain an immutable settings snapshot at request start and support IPC-hosted execution.
- `node/src/capture-store.mjs`: preserve capture behavior while receiving snapshot-safe paths.
- `node/package.json`: add credential/E2E dependencies, scripts, and packaged UI files.
- `node/package-lock.json`: lock new dependencies.
- `README.md`, `README.zh-CN.md`, `node/README.md`, `node/CHANGELOG.md`: document the new lifecycle and migration.
- Living contracts under `docs/`: synchronize facts after each task.

### Focused modules to create

- `node/src/shared/errors.mjs`: stable local error codes and safe serialization.
- `node/src/shared/paths.mjs`: all CRP home, state, registry, token, log, and Codex paths.
- `node/src/codex/codex-config.mjs`: idempotent backup/bootstrap of the fixed Codex provider entry.
- `node/src/providers/provider-schema.mjs`: provider validation and public masking.
- `node/src/providers/provider-registry.mjs`: atomic schema-versioned provider persistence.
- `node/src/credentials/native-keyring.mjs`: native keyring adapter.
- `node/src/credentials/file-credential-store.mjs`: explicit `0600` fallback adapter.
- `node/src/credentials/credential-store.mjs`: adapter contract and backend selection.
- `node/src/worker/runtime-settings.mjs`: monotonic immutable snapshot store.
- `node/src/worker/protocol.mjs`: parent/child message constructors and validators.
- `node/src/worker/worker-entry.mjs`: IPC-driven worker entrypoint.
- `node/src/supervisor/activity-store.mjs`: bounded sanitized lifecycle events.
- `node/src/supervisor/worker-manager.mjs`: start, drain, stop, restart, backoff, and health.
- `node/src/supervisor/migration.mjs`: transactional v0.2.2 migration.
- `node/src/supervisor/provider-service.mjs`: test/activate/delete orchestration.
- `node/src/supervisor/session-auth.mjs`: local control token, browser session, and CSRF.
- `node/src/supervisor/admin-server.mjs`: versioned Admin API and static UI serving.
- `node/src/supervisor/supervisor.mjs`: composition root and runtime state.
- `node/src/supervisor/supervisor-entry.mjs`: detached supervisor process entrypoint.
- `node/src/supervisor/supervisor-client.mjs`: CLI HTTP client.
- `node/ui/index.html`, `node/ui/styles.css`, `node/ui/app.js`: guided utility console.
- `node/playwright.config.mjs`: E2E configuration.
- `node/scripts/check-source.mjs`: portable syntax/lint gate.

### Tests to create

- Unit tests mirror each focused module under `node/test/`.
- Multi-process and HTTP tests live under `node/test/integration/`.
- Browser specs live under `node/test/e2e/`.
- Deterministic child/upstream fixtures live under `node/test/fixtures/`.

## Task 1: Establish Portable Quality Gates and Dependencies

**Files:**
- Modify: `node/package.json`
- Modify: `node/package-lock.json`
- Create: `node/scripts/check-source.mjs`
- Create: `node/scripts/run-test-group.mjs`
- Test: existing `node/test/*.test.mjs`

- [x] **Step 1: Record the fresh baseline**

Run:

```bash
cd node
npm test
npm audit --omit=dev
```

Expected: 12 tests pass and the runtime audit reports zero vulnerabilities.

- [x] **Step 2: Add the portable source-check script**

Create `node/scripts/check-source.mjs`:

```js
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const roots = [join(root, "bin"), join(root, "src"), join(root, "scripts"), join(root, "ui")];
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walk(path);
    if (name.isFile() && /\.(mjs|js)$/.test(name.name)) files.push(path);
  }
}

for (const dir of roots) {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir);
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`${relative(root, file)}\n${result.stderr}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`Syntax checked ${files.length} source files.`);
```

- [x] **Step 3: Add the cross-platform grouped-test runner**

Create `node/scripts/run-test-group.mjs`:

```js
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const group = process.argv[2];
const testRoot = resolve("test");
const selectedRoot = group === "integration" ? join(testRoot, "integration") : testRoot;
const recursive = group === "integration";

function collect(dir, descend) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && descend) files.push(...collect(path, true));
    if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(path);
  }
  return files;
}

const files = collect(selectedRoot, recursive).sort();
if (files.length === 0) throw new Error(`No ${group} test files found`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
```

- [x] **Step 4: Add exact dependencies and scripts**

Run:

```bash
cd node
npm install @napi-rs/keyring@1.3.0
npm install --save-dev @playwright/test@1.61.1
```

Set these scripts in `node/package.json`:

```json
{
  "scripts": {
    "start": "node src/server.mjs",
    "check": "node bin/crp.mjs check",
    "status": "node bin/crp.mjs status",
    "guide": "node bin/crp.mjs guide",
    "lint": "node scripts/check-source.mjs",
    "test": "node --test",
    "test:unit": "node scripts/run-test-group.mjs unit",
    "test:integration": "node scripts/run-test-group.mjs integration",
    "test:e2e": "playwright test",
    "test:all": "npm run lint && npm run test && npm run test:e2e",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "changeset publish"
  },
  "files": ["bin/", "src/", "ui/", "proxy-config.example.json", "README.md"]
}
```

- [x] **Step 5: Verify gates**

Run:

```bash
cd node
npm run lint
npm test
npm audit --omit=dev
```

Expected: syntax check succeeds, 12 tests pass, and runtime audit reports zero vulnerabilities.

- [x] **Step 6: Commit**

```bash
git add node/package.json node/package-lock.json node/scripts/check-source.mjs node/scripts/run-test-group.mjs
git commit -m "build: add CRP quality gates"
```

## Task 2: Extract Stable Paths, Errors, and Codex Bootstrap

**Files:**
- Create: `node/src/shared/paths.mjs`
- Create: `node/src/shared/errors.mjs`
- Create: `node/src/codex/codex-config.mjs`
- Modify: `node/bin/crp.mjs:14-27,603-669`
- Create: `node/test/codex-config.test.mjs`

- [ ] **Step 1: Write failing idempotency and preservation tests**

Create `node/test/codex-config.test.mjs` with tests that import `patchCodexConfigText` and assert:

```js
const original = `model_provider = "custom"\n\n[model_providers.custom]\nname = "Custom"\nbase_url = "https://old.example/v1"\n`;
const once = patchCodexConfigText(original, "http://127.0.0.1:15100");
const twice = patchCodexConfigText(once, "http://127.0.0.1:15100");

assert.match(once, /^model_provider = "OpenAI"/m);
assert.match(once, /\[model_providers\.OpenAI\]/);
assert.match(once, /base_url = "http:\/\/127\.0\.0\.1:15100"/);
assert.match(once, /\[model_providers\.custom\]/);
assert.equal(twice, once);
```

Add a temporary-file test asserting `bootstrapCodexConfig()` creates one backup, writes mode-preserving content, and returns `{ changed: true, backupPath }`; a second call returns `{ changed: false, backupPath: null }`.

- [ ] **Step 2: Run the test and confirm the missing-module failure**

```bash
cd node
node --test test/codex-config.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/codex/codex-config.mjs`.

- [ ] **Step 3: Implement exact public contracts**

Create `node/src/shared/errors.mjs`:

```js
export class CrpError extends Error {
  constructor(code, message, action, { status = 500, details = {}, cause } = {}) {
    super(message, { cause });
    this.name = "CrpError";
    this.code = code;
    this.action = action;
    this.status = status;
    this.details = details;
  }
}

export function toPublicError(error, requestId) {
  const safe = error instanceof CrpError
    ? error
    : new CrpError("INTERNAL_ERROR", "CRP could not complete the operation.", "Open Activity for details.");
  return { error: { code: safe.code, message: safe.message, action: safe.action, requestId, details: safe.details } };
}
```

Create `node/src/shared/paths.mjs` exporting one `getPaths(home = os.homedir())` result containing `globalHome`, `registryPath`, `secretFallbackPath`, `statePath`, `controlTokenPath`, `activityPath`, `logPath`, `codexConfigPath`, and `authPath`.

Move TOML section helpers, `patchCodexConfigText`, backup logic, and file writes from `crp.mjs` into `node/src/codex/codex-config.mjs`. Export:

```js
export function patchCodexConfigText(text, proxyUrl) {}
export function bootstrapCodexConfig({ configPath, proxyUrl, now = () => new Date() }) {}
```

`bootstrapCodexConfig` must compare before writing, copy the original beside it with a UTC timestamp, write through a same-directory temporary file, then rename.

- [ ] **Step 4: Import the adapter from the existing CLI**

Replace the duplicated config-patching functions in `node/bin/crp.mjs` with:

```js
import { bootstrapCodexConfig } from "../src/codex/codex-config.mjs";
import { getPaths } from "../src/shared/paths.mjs";
```

Keep command output and aliases unchanged in this task.

- [ ] **Step 5: Verify focused and regression tests**

```bash
cd node
node --test test/codex-config.test.mjs
npm test
```

Expected: new tests pass and the existing 12 tests remain green.

- [ ] **Step 6: Commit**

```bash
git add node/src/shared node/src/codex node/bin/crp.mjs node/test/codex-config.test.mjs
git commit -m "refactor: isolate Codex bootstrap"
```

## Task 3: Add the Atomic Provider Registry

**Files:**
- Create: `node/src/providers/provider-schema.mjs`
- Create: `node/src/providers/provider-registry.mjs`
- Create: `node/test/provider-registry.test.mjs`

- [ ] **Step 1: Write failing registry behavior tests**

Cover create/list/get/update, case-insensitive duplicate names, activation, active-delete rejection, inactive deletion, reload, malformed JSON, and `0600` permissions. Use injected deterministic IDs and clocks:

```js
const registry = new ProviderRegistry({
  path: registryPath,
  createId: () => "provider-1",
  now: () => "2026-07-10T00:00:00.000Z"
});
const created = registry.create({
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  credentialRef: "provider-1",
  authHeader: "authorization",
  authScheme: "Bearer",
  extraHeaders: {},
  modelMode: "passthrough",
  modelOverride: null
});
assert.equal(created.id, "provider-1");
assert.equal(registry.list().length, 1);
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd node
node --test test/provider-registry.test.mjs
```

Expected: FAIL because the provider modules do not exist.

- [ ] **Step 3: Implement validation and masking**

Export from `provider-schema.mjs`:

```js
export const TEST_STATUSES = new Set(["untested", "passed", "failed"]);
export function validateProviderInput(input) {}
export function normalizeProvider(input, { id, now }) {}
export function toPublicProvider(profile, credentialConfigured) {
  const { credentialRef, ...safe } = profile;
  return { ...safe, credentialConfigured };
}
```

Reject missing names, duplicate names, credentials in `extraHeaders`, non-HTTP(S) URLs, non-loopback HTTP URLs, and missing override models.

- [ ] **Step 4: Implement atomic persistence**

`ProviderRegistry` must expose:

```js
list();
get(id);
create(input);
update(id, patch);
delete(id);
markTest(id, { status, code });
setActive(id);
getActive();
getDocument();
```

Every mutation writes a complete schema-version-2 document to a same-directory temporary file with mode `0600`, fsyncs it, and renames it over the registry. Failed validation must leave the original file byte-for-byte unchanged.

- [ ] **Step 5: Run focused and full tests**

```bash
cd node
node --test test/provider-registry.test.mjs
npm test
```

Expected: all provider tests and regressions pass.

- [ ] **Step 6: Commit**

```bash
git add node/src/providers node/test/provider-registry.test.mjs
git commit -m "feat: add atomic provider registry"
```

## Task 4: Add Native and Explicit-Fallback Credential Stores

**Files:**
- Create: `node/src/credentials/native-keyring.mjs`
- Create: `node/src/credentials/file-credential-store.mjs`
- Create: `node/src/credentials/credential-store.mjs`
- Create: `node/test/credential-store.test.mjs`

- [ ] **Step 1: Write one shared adapter contract test**

Run the same assertions against an in-memory test double and `FileCredentialStore`:

```js
await store.set("provider-1", "sk-test-secret");
assert.equal(await store.has("provider-1"), true);
assert.equal(await store.get("provider-1"), "sk-test-secret");
await store.delete("provider-1");
assert.equal(await store.has("provider-1"), false);
await assert.rejects(() => store.get("provider-1"), /CREDENTIAL_NOT_FOUND/);
```

Assert the fallback file is `0600`, stores no provider metadata, survives reload, and never returns all secrets through a list method.

- [ ] **Step 2: Verify the contract tests fail**

```bash
cd node
node --test test/credential-store.test.mjs
```

Expected: FAIL because credential modules do not exist.

- [ ] **Step 3: Implement the adapters**

Use `@napi-rs/keyring` exactly as follows in `native-keyring.mjs`:

```js
import { Entry } from "@napi-rs/keyring";
const SERVICE = "org.cluic.codex-remote-proxy";

export class NativeKeyringStore {
  async set(ref, secret) { new Entry(SERVICE, ref).setPassword(secret); }
  async get(ref) {
    const password = new Entry(SERVICE, ref).getPassword();
    if (!password) throw new Error("CREDENTIAL_NOT_FOUND");
    return password;
  }
  async has(ref) {
    try { return Boolean(await this.get(ref)); } catch { return false; }
  }
  async delete(ref) {
    try { new Entry(SERVICE, ref).deletePassword(); } catch { return false; }
    return true;
  }
}
```

`FileCredentialStore` persists `{ "schemaVersion": 1, "credentials": { "provider-1": "secret" } }` atomically with `0600` mode. `createCredentialStore({ backend, fallbackConsent, paths })` must never silently choose file storage; native failure returns `CREDENTIAL_BACKEND_UNAVAILABLE` unless `fallbackConsent === true`.

- [ ] **Step 4: Verify no secret is exposed by public helpers**

Add assertions that `JSON.stringify(toPublicProvider(profile, true))` contains neither `credentialRef` nor `sk-test-secret`, then run:

```bash
cd node
node --test test/credential-store.test.mjs test/provider-registry.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add node/src/credentials node/test/credential-store.test.mjs
git commit -m "feat: add secure credential stores"
```

## Task 5: Make Proxy Settings Snapshot-Based

**Files:**
- Create: `node/src/worker/runtime-settings.mjs`
- Modify: `node/src/server.mjs:48-94,242-518`
- Modify: `node/test/server.test.mjs`
- Create: `node/test/runtime-settings.test.mjs`

- [ ] **Step 1: Write failing snapshot-generation tests**

```js
const source = new RuntimeSettingsSource();
source.apply({ generation: 1, settings: settingsA });
assert.equal(source.current().generation, 1);
assert.throws(() => source.apply({ generation: 1, settings: settingsB }), /STALE_SNAPSHOT/);
source.apply({ generation: 2, settings: settingsB });
assert.equal(source.current().settings.upstream.baseUrl, settingsB.upstream.baseUrl);
```

Assert returned snapshots are deeply frozen and callers cannot mutate headers.

- [ ] **Step 2: Add an in-flight switch integration test to `server.test.mjs`**

Start delayed upstream A and immediate upstream B. Send request 1, wait until A receives it, apply generation 2, send request 2, release A, then assert response 1 came from A and response 2 came from B.

- [ ] **Step 3: Run both tests and verify failure**

```bash
cd node
node --test test/runtime-settings.test.mjs test/server.test.mjs
```

Expected: runtime module is missing and the static server cannot switch settings.

- [ ] **Step 4: Implement snapshot capture at request start**

`RuntimeSettingsSource` exposes `apply(snapshot)`, `current()`, and `publicState()`. Change `createServer` to accept an optional `settingsSource`; for every non-health request, obtain exactly one snapshot before reading the body:

```js
const active = settingsSource ? settingsSource.current() : { generation: 0, settings };
const requestSettings = active.settings;
```

Use `requestSettings` for target URL, headers, timeout, SSL, capture context, and logs. Health uses `settingsSource.publicState()` and must not include credentials.

- [ ] **Step 5: Verify snapshot behavior and regressions**

```bash
cd node
node --test test/runtime-settings.test.mjs test/server.test.mjs
npm test
```

Expected: in-flight/new-request assertions pass and existing proxy/capture behavior remains green.

- [ ] **Step 6: Commit**

```bash
git add node/src/worker/runtime-settings.mjs node/src/server.mjs node/test/runtime-settings.test.mjs node/test/server.test.mjs
git commit -m "feat: switch proxy settings atomically"
```

## Task 6: Define IPC and Build the Worker Entrypoint

**Files:**
- Create: `node/src/worker/protocol.mjs`
- Create: `node/src/worker/worker-entry.mjs`
- Create: `node/test/worker-protocol.test.mjs`
- Create: `node/test/integration/worker-entry.test.mjs`

- [ ] **Step 1: Write failing protocol validation tests**

Cover parent messages `configure`, `drain`, `shutdown`, `status` and child messages `ready`, `configured`, `drained`, `status`, `fatal`. Assert secrets are permitted only inside the parent-only configure payload and are removed by `sanitizeProtocolMessage()`.

- [ ] **Step 2: Write a child-process integration test**

Fork `worker-entry.mjs` with IPC, wait for `ready`, send generation 1 settings on port 0, wait for `configured`, issue a proxied request, request status, then send shutdown and assert exit code 0.

- [ ] **Step 3: Run tests and verify failure**

```bash
cd node
node --test test/worker-protocol.test.mjs test/integration/worker-entry.test.mjs
```

Expected: FAIL because protocol and entrypoint modules do not exist.

- [ ] **Step 4: Implement the versioned protocol**

Use `PROTOCOL_VERSION = 1`. Every message must contain `{ version: 1, type, requestId }`; configure additionally contains `{ generation, settings }`. Unknown versions/types return a `fatal` child message with stable code `WORKER_PROTOCOL_INVALID` and never echo the input payload.

- [ ] **Step 5: Implement graceful worker behavior**

`worker-entry.mjs` must:

1. Create `RuntimeSettingsSource` and the HTTP server once.
2. Listen only after the first valid configure message.
3. Stop accepting connections on drain, wait for tracked in-flight requests, and emit `drained`.
4. Close capture resources and exit 0 on shutdown.
5. Emit sanitized fatal messages for uncaught startup errors.

- [ ] **Step 6: Verify and commit**

```bash
cd node
node --test test/worker-protocol.test.mjs test/integration/worker-entry.test.mjs
npm test
git add node/src/worker node/test/worker-protocol.test.mjs node/test/integration/worker-entry.test.mjs
git commit -m "feat: add proxy worker protocol"
```

Expected: focused and full suites pass before commit.

## Task 7: Implement Reliable Worker Lifecycle Management

**Files:**
- Create: `node/src/supervisor/worker-manager.mjs`
- Create: `node/test/fixtures/fake-worker.mjs`
- Create: `node/test/worker-manager.test.mjs`
- Create: `node/test/integration/worker-restart.test.mjs`

- [ ] **Step 1: Write failing state-machine tests**

Assert transitions:

```text
stopped -> starting -> running
running -> draining -> stopped
running -> draining -> starting -> running
running -> crashed -> backoff -> starting
backoff -> failed after the configured crash threshold
```

Use injected `forkWorker`, `clock`, and `waitForPortFree` functions so unit tests contain no sleeps.

- [ ] **Step 2: Write the fixed-port restart test**

Start a real worker on a chosen free port, call `restart(snapshot)`, assert the PID changes, the supervisor-side manager remains available, the port is rebound, and health returns generation 1.

- [ ] **Step 3: Run and verify failures**

```bash
cd node
node --test test/worker-manager.test.mjs test/integration/worker-restart.test.mjs
```

Expected: FAIL because `WorkerManager` does not exist.

- [ ] **Step 4: Implement the lifecycle contract**

Export a `WorkerManager` with:

```js
start(snapshot);
applySnapshot(snapshot);
stop({ drainTimeoutMs = 5000 });
restart(snapshot, { drainTimeoutMs = 5000 });
getPublicState();
close();
```

Restart must wait for `drained`, escalate to `SIGTERM`, then `SIGKILL` after a bounded timeout, confirm port release by attempting an exclusive listen, spawn, configure, and require health before reporting success. Crash recovery uses delays 250ms, 500ms, 1000ms, 2000ms, 4000ms and enters `failed` after five crashes in 60 seconds.

- [ ] **Step 5: Verify and commit**

```bash
cd node
node --test test/worker-manager.test.mjs test/integration/worker-restart.test.mjs
npm test
git add node/src/supervisor/worker-manager.mjs node/test/worker-manager.test.mjs node/test/integration/worker-restart.test.mjs node/test/fixtures/fake-worker.mjs
git commit -m "feat: manage proxy worker lifecycle"
```

## Task 8: Add Activity, Migration, and Provider Orchestration

**Files:**
- Create: `node/src/supervisor/activity-store.mjs`
- Create: `node/src/supervisor/migration.mjs`
- Create: `node/src/supervisor/provider-service.mjs`
- Create: `node/test/activity-store.test.mjs`
- Create: `node/test/migration.test.mjs`
- Create: `node/test/provider-service.test.mjs`

- [ ] **Step 1: Write failing activity redaction tests**

Append an event containing authorization, cookie, token, secret, API key, and nested error fields. Assert the persisted JSONL contains `[REDACTED]`, never the test values, and retention truncates to the newest 10,000 rows.

- [ ] **Step 2: Write transactional migration tests**

Given the current flat `config.json`, assert migration creates one `Default` provider, stores its key through the injected credential adapter, backs up original files, and removes the secret from provider metadata. Inject a credential-write failure and assert original bytes are restored and no schema-2 file remains.

- [ ] **Step 3: Write provider-service tests**

Use two local mock upstreams and assert `testProvider(id, model)` classifies DNS/TLS/timeout/401/404/invalid-Responses errors, marks success, and that `activate(id)` rejects untested profiles, resolves only the selected credential, increments generation, persists active ID, and waits for worker acknowledgement.

- [ ] **Step 4: Run tests and verify failure**

```bash
cd node
node --test test/activity-store.test.mjs test/migration.test.mjs test/provider-service.test.mjs
```

Expected: FAIL because the orchestration modules do not exist.

- [ ] **Step 5: Implement the three services**

Use one safe recursive redactor shared by activity and errors. `ProviderService` exposes:

```js
listProviders();
createProvider(input, secret, { fallbackConsent });
updateProvider(id, patch, replacementSecret);
deleteProvider(id);
testProvider(id, model);
activate(id);
getStatus();
```

`testProvider` sends a minimal `POST /responses` request with `stream: false`, `input: "Reply with OK."`, and the selected model. Store only stable result codes and timestamps.

- [ ] **Step 6: Verify and commit**

```bash
cd node
node --test test/activity-store.test.mjs test/migration.test.mjs test/provider-service.test.mjs
npm test
git add node/src/supervisor/activity-store.mjs node/src/supervisor/migration.mjs node/src/supervisor/provider-service.mjs node/test/activity-store.test.mjs node/test/migration.test.mjs node/test/provider-service.test.mjs
git commit -m "feat: orchestrate provider lifecycle"
```

## Task 9: Build the Secured Loopback Admin API

**Files:**
- Create: `node/src/supervisor/session-auth.mjs`
- Create: `node/src/supervisor/admin-server.mjs`
- Create: `node/src/supervisor/supervisor.mjs`
- Create: `node/src/supervisor/supervisor-entry.mjs`
- Create: `node/test/session-auth.test.mjs`
- Create: `node/test/integration/admin-server.test.mjs`

- [ ] **Step 1: Write failing browser-auth tests**

Assert a 32-byte control token is created with `0600` mode. Test `/api/v1/session` with a valid bearer token returns an HttpOnly `SameSite=Strict` cookie and CSRF token, then clears access when expired. Invalid Host, non-loopback Origin, missing CSRF, missing cookie, and CORS preflight must be rejected.

- [ ] **Step 2: Write failing API contract tests**

Exercise every endpoint in `docs/API.md` against injected provider and worker services. Assert mutation status codes, `409` conflicts, sanitized error format, activity pagination, static UI fallback, and that serialized responses never contain `credentialRef` or a complete key.

- [ ] **Step 3: Run and verify failures**

```bash
cd node
node --test test/session-auth.test.mjs test/integration/admin-server.test.mjs
```

Expected: FAIL because auth and Admin API modules do not exist.

- [ ] **Step 4: Implement auth and route table**

Use `crypto.randomBytes(32).toString("base64url")` for control/session/CSRF tokens. Accept bearer auth for CLI and cookie+CSRF for browser mutations. Route only the methods and paths listed in `docs/API.md`; unmatched API paths return `404 API_NOT_FOUND`. Serve `ui/index.html`, `ui/styles.css`, and `ui/app.js` with explicit MIME types and `Cache-Control: no-store`.

- [ ] **Step 5: Compose the supervisor**

`createSupervisor(options)` builds paths, migration, registry, credential store, activity store, worker manager, provider service, auth, and Admin API. `supervisor-entry.mjs` loads the selected home, listens on `127.0.0.1:15101`, writes state only after health is ready, and shuts down cleanly on `SIGTERM`/`SIGINT`.

- [ ] **Step 6: Verify and commit**

```bash
cd node
node --test test/session-auth.test.mjs test/integration/admin-server.test.mjs
npm test
git add node/src/supervisor node/test/session-auth.test.mjs node/test/integration/admin-server.test.mjs
git commit -m "feat: add secured local Admin API"
```

## Task 10: Route CLI Commands Through the Supervisor

**Files:**
- Create: `node/src/supervisor/supervisor-client.mjs`
- Modify: `node/bin/crp.mjs`
- Modify: `node/test/crp.test.mjs`
- Create: `node/test/integration/crp-lifecycle.test.mjs`

- [ ] **Step 1: Extend failing CLI tests**

Assert help includes:

```text
crp ui [--no-open] [--json]
crp restart [--json]
crp shutdown [--json]
crp provider list|add|test|activate|delete [--json]
```

Using a temporary HOME, assert `ui --no-open --json` starts a supervisor, `start` starts the worker, `restart` changes only worker PID, `stop` stops only the worker, and `shutdown` stops the supervisor.

- [ ] **Step 2: Run and verify failures**

```bash
cd node
node --test test/crp.test.mjs test/integration/crp-lifecycle.test.mjs
```

Expected: FAIL because new commands and client do not exist.

- [ ] **Step 3: Implement supervisor discovery and client**

`ensureSupervisor({ paths, adminPort })` checks state and `/api/v1/status`; if absent, spawn detached `supervisor-entry.mjs`, wait up to 8 seconds for health, and return its URL. `SupervisorClient` reads the control token and exposes `request(method, path, body)` with bearer auth.

- [ ] **Step 4: Implement command semantics**

- `ui`: ensure supervisor, create the fragment URL `/#token=<controlToken>`, open with macOS `open`, Windows `cmd /c start`, or Linux `xdg-open`; `--no-open` only prints JSON.
- `start`: ensure supervisor, bootstrap Codex if required, then POST `/proxy/start`.
- `stop`: POST `/proxy/stop` and leave supervisor running.
- `restart`: POST `/proxy/restart`.
- `shutdown`: terminate supervisor after stopping worker.
- `install` and `setup`: remain aliases for `start` with one deprecation field in JSON.
- `provider`: expose automation-safe CRUD/test/activate commands without printing complete keys.

- [ ] **Step 5: Verify compatibility and commit**

```bash
cd node
node --test test/crp.test.mjs test/integration/crp-lifecycle.test.mjs
npm test
git add node/bin/crp.mjs node/src/supervisor/supervisor-client.mjs node/test/crp.test.mjs node/test/integration/crp-lifecycle.test.mjs
git commit -m "feat: manage CRP through supervisor CLI"
```

## Task 11: Implement the Guided Utility Web UI

**Files:**
- Create: `node/ui/index.html`
- Create: `node/ui/styles.css`
- Create: `node/ui/app.js`
- Create: `node/playwright.config.mjs`
- Create: `node/test/e2e/onboarding.spec.mjs`
- Create: `node/test/e2e/provider-switch.spec.mjs`
- Create: `node/test/e2e/restart-and-errors.spec.mjs`

- [ ] **Step 1: Write failing Playwright onboarding test**

The test starts the supervisor against a temporary HOME and mock upstream, opens the fragment-token URL, enters provider name/base URL/API key/test model, clicks `Test connection`, expects `Compatible`, activates, bootstraps Codex, and expects the Overview page. Assert the generated Codex config contains `model_provider = "OpenAI"` and fixed port 15100.

- [ ] **Step 2: Write failing daily-flow tests**

Create two providers through API fixtures, then use the UI to switch A → B, restart the worker, view an actionable 401 error, navigate with keyboard only, and assert no input contains the saved key. Add `axe`-free semantic assertions using Playwright roles and a screenshot for Overview at 1440×900.

- [ ] **Step 3: Run and verify UI absence**

```bash
cd node
npx playwright install chromium
npm run test:e2e
```

Expected: FAIL because the UI files and visible role names do not exist.

- [ ] **Step 4: Build the accessible static shell**

`index.html` contains semantic landmarks, a skip link, `aria-live="polite"` status region, onboarding and app roots, and no inline scripts. `styles.css` implements the approved guided utility console with system fonts, 8px spacing scale, 44px targets, visible focus, AA colors, status icons plus text, responsive desktop layout, and reduced-motion rules.

- [ ] **Step 5: Implement UI state and API calls**

`app.js` must:

1. Exchange the fragment token at `/api/v1/session`, then remove the fragment with `history.replaceState`.
2. Keep the returned CSRF token only in memory.
3. Render onboarding when no provider exists.
4. Render Overview, Providers, Activity, and Settings without exposing secrets.
5. Disable duplicate mutations while one is pending.
6. Map stable API errors to cause/action panels and expandable sanitized details.
7. Confirm destructive deletion and restart only when in-flight requests exist.

- [ ] **Step 6: Run visual and regression checks**

```bash
cd node
npm run lint
npm run test:e2e
npm test
```

Expected: all browser flows pass and Playwright writes the approved Overview screenshot artifact.

- [ ] **Step 7: Commit**

```bash
git add node/ui node/playwright.config.mjs node/test/e2e node/package.json node/package-lock.json
git commit -m "feat: add guided local management UI"
```

## Task 12: Complete Migration, Cross-Platform Gates, Docs, and Release Readiness

**Files:**
- Modify: `.github/workflows/release-preflight.yml`
- Create: `.github/workflows/platform-tests.yml`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `node/README.md`
- Modify: `node/CHANGELOG.md`
- Create: `node/.changeset/multi-provider-local-ui.md`
- Modify: all affected `docs/*.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/AI_HANDOFF.md`

- [ ] **Step 1: Add failing package-content verification**

Run `npm pack --dry-run --json` in a test and assert the package includes `bin/`, `src/`, `ui/index.html`, `ui/styles.css`, and `ui/app.js`, and excludes tests, `.superpowers`, credentials, state, and capture databases.

- [ ] **Step 2: Add platform workflow matrix**

Create a GitHub Actions matrix over `macos-latest`, `windows-latest`, and `ubuntu-latest` using Node 22. Each runs `npm ci`, `npm run lint`, and `npm test`. macOS and Windows also install Chromium and run E2E; native keyring jobs create/read/delete a synthetic CI credential and always clean it up.

- [ ] **Step 3: Run the complete local deterministic gate**

```bash
cd node
npm run lint
npm test
npm run test:integration
npm run test:e2e
npm audit --omit=dev
npm pack --dry-run
```

Expected: zero test failures, zero runtime vulnerabilities, and UI assets present in the tarball listing.

- [ ] **Step 4: Perform manual security and visual review**

Use temporary credentials only. Search generated logs, activity, diagnostics, capture records, API responses, screenshots, and the Git diff for the complete test key. Verify invalid Host/Origin requests fail, the Admin API is not reachable from a non-loopback bind, macOS/Windows screenshots match the approved guided console, and keyboard-only onboarding succeeds.

- [ ] **Step 5: Synchronize living docs and release notes**

Mark implemented facts rather than target facts, record verification commands/results, update migration and rollback instructions, document new commands, set `docs/STATUS.md` to expert review, and add a minor Changeset because the npm package gains user-visible provider/UI/lifecycle capabilities.

- [ ] **Step 6: Request two-stage review**

First request requirements review against the approved design spec. After all requirement findings are resolved, request code-quality/security review focused on credential boundaries, migration rollback, localhost security, worker lifecycle, and secret leakage.

- [ ] **Step 7: Commit the release-readiness change**

```bash
git add .github README.md README.zh-CN.md node/README.md node/CHANGELOG.md node/.changeset docs
git commit -m "docs: prepare multi-provider UI release"
```

## Final Verification and Merge Gate

- [ ] Re-run every command from Task 12 Step 3 on the final tree.
- [ ] Confirm macOS, Windows, and Linux CI is green.
- [ ] Confirm zero unresolved requirements, quality, security, accessibility, or visual-review findings.
- [ ] Confirm migration rollback evidence and a redacted diagnostic bundle are attached to the review.
- [ ] Confirm `docs/STATUS.md`, `docs/AI_HANDOFF.md`, and `docs/DECISIONS.md` match implemented behavior.
- [ ] Classify the implementation as L3 and obtain expert confirmation; do not auto-merge.
