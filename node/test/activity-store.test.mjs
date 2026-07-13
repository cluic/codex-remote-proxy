import test from "node:test";
import assert from "node:assert/strict";
import * as realFileOperations from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { ActivityStore } from "../src/supervisor/activity-store.mjs";

const NOW = "2026-07-13T00:00:00.000Z";

function makeStore(t) {
  const root = mkdtempSync(join(os.tmpdir(), "crp-activity-"));
  const path = join(root, "private", "activity.jsonl");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { path, store: new ActivityStore({ path, now: () => NOW }) };
}

function event(action, details = {}) {
  return {
    category: "provider",
    action,
    providerId: "provider-1",
    result: "success",
    errorCode: null,
    details
  };
}

function makeSecret(label) {
  return `${label}-${crypto.randomUUID()}`;
}

test("persists the exact activity-event allowlist and recursively redacts sensitive fields", (t) => {
  const { path, store } = makeStore(t);
  const values = {
    authorization: makeSecret("authorization"),
    cookie: makeSecret("cookie"),
    token: makeSecret("token"),
    secret: makeSecret("secret"),
    apiKey: makeSecret("api-key")
  };

  store.append({
    category: "provider",
    action: "test",
    providerId: "provider-1",
    result: "failed",
    errorCode: "PROVIDER_TEST_HTTP_401",
    details: {
      Authorization: values.authorization,
      "session.cookie": values.cookie,
      access_token: values.token,
      clientSecret: values.secret,
      "API-Key": values.apiKey,
      safe: { attempt: 1 }
    },
    ignored: "must-not-persist"
  });

  const bytes = readFileSync(path, "utf8");
  for (const value of Object.values(values)) {
    assert.equal(bytes.includes(value), false);
  }
  const event = JSON.parse(bytes.trim());
  assert.deepEqual(Object.keys(event), [
    "timestamp",
    "category",
    "action",
    "providerId",
    "result",
    "errorCode",
    "details"
  ]);
  assert.equal(event.timestamp, NOW);
  assert.equal(event.details.Authorization, "[REDACTED]");
  assert.equal(event.details["session.cookie"], "[REDACTED]");
  assert.equal(event.details.access_token, "[REDACTED]");
  assert.equal(event.details.clientSecret, "[REDACTED]");
  assert.equal(event.details["API-Key"], "[REDACTED]");
  assert.deepEqual(event.details.safe, { attempt: 1 });
  assert.equal("ignored" in event, false);
});

test("serializes nested Error, cyclic, bigint, and unsupported detail values safely", (t) => {
  const { path, store } = makeStore(t);
  const errorSecret = makeSecret("error-message");
  const nested = { count: 2n, missing: undefined };
  nested.self = nested;
  const error = new Error(errorSecret, {
    cause: new Error(makeSecret("cause-message"))
  });
  error.accessToken = makeSecret("error-token");
  nested.error = error;
  nested.callback = () => errorSecret;

  assert.doesNotThrow(() => store.append({
    category: "provider",
    action: "test",
    providerId: "provider-1",
    result: "failed",
    errorCode: "PROVIDER_TEST_FAILED",
    details: nested
  }));

  const bytes = readFileSync(path, "utf8");
  assert.equal(bytes.includes(errorSecret), false);
  assert.equal(bytes.includes(error.accessToken), false);
  assert.equal(bytes.includes(error.cause.message), false);
  const event = JSON.parse(bytes.trim());
  assert.equal(event.details.count, "2");
  assert.equal(event.details.self, "[CIRCULAR]");
  assert.deepEqual(event.details.error, {
    name: "Error",
    accessToken: "[REDACTED]"
  });
  assert.equal(event.details.missing, "[UNSERIALIZABLE]");
  assert.equal(event.details.callback, "[UNSERIALIZABLE]");
});

test("redacts orchestration metadata, bodies, headers, paths, causes, and stacks", (t) => {
  const { path, store } = makeStore(t);
  const values = Object.fromEntries([
    "credential-ref",
    "request-body",
    "response-body",
    "cause",
    "stack",
    "headers",
    "backup-path"
  ].map((label) => [label, makeSecret(label)]));

  store.append(event("security-boundary", {
    "Credential.Ref": values["credential-ref"],
    REQUEST_body: values["request-body"],
    "response-body": values["response-body"],
    CaUsE: values.cause,
    "error.stack": values.stack,
    requestHeaders: { safe: values.headers },
    "backup-path": values["backup-path"]
  }));

  const bytes = readFileSync(path, "utf8");
  for (const value of Object.values(values)) assert.equal(bytes.includes(value), false);
  const details = JSON.parse(bytes).details;
  for (const value of Object.values(details)) assert.equal(value, "[REDACTED]");
});

test("retains only events within 30 days and the newest configured row limit", (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "crp-activity-retention-"));
  const path = join(root, "private", "activity.jsonl");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ActivityStore({
    path,
    now: () => "2026-07-13T00:00:00.000Z",
    maxEvents: 3,
    retentionMs: 30 * 24 * 60 * 60 * 1_000
  });

  for (const [timestamp, sequence] of [
    ["2026-06-01T00:00:00.000Z", 0],
    ["2026-07-09T00:00:00.000Z", 1],
    ["2026-07-10T00:00:00.000Z", 2],
    ["2026-07-11T00:00:00.000Z", 3],
    ["2026-07-12T00:00:00.000Z", 4]
  ]) {
    store.append({ ...event("retention", { sequence }), timestamp });
  }

  assert.deepEqual(
    store.list().map((entry) => entry.details.sequence),
    [4, 3, 2]
  );
  assert.deepEqual(
    readFileSync(path, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line).details.sequence),
    [2, 3, 4]
  );
});

test("uses a private atomic replacement and preserves old bytes on rename failure", (t) => {
  const { path, store } = makeStore(t);
  store.append(event("created"));
  const original = readFileSync(path);
  const failingStore = new ActivityStore({
    path,
    now: () => NOW,
    fileOperations: {
      ...realFileOperations,
      renameSync(from, to) {
        if (to === path && from.endsWith(".tmp")) {
          const error = new Error("private rename detail");
          error.code = "EIO";
          throw error;
        }
        return realFileOperations.renameSync(from, to);
      }
    }
  });

  assert.throws(
    () => failingStore.append(event("failed-write")),
    (error) => error?.code === "ACTIVITY_STORE_WRITE_FAILED"
      && !error.message.includes("private rename detail")
  );
  assert.deepEqual(readFileSync(path), original);
  assert.equal(existsSync(`${path}.crp.lock`), false);
  assert.deepEqual(
    readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp")),
    []
  );

  if (process.platform !== "win32") {
    assert.equal(lstatSync(join(path, "..")).mode & 0o777, 0o700);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  }
});

test("rejects a foreign activity lock without changing or deleting it", (t) => {
  const { path, store } = makeStore(t);
  store.append(event("created"));
  const original = readFileSync(path);
  const lockPath = `${path}.crp.lock`;
  const foreign = Buffer.from("foreign-activity-owner\n", "utf8");
  writeFileSync(lockPath, foreign, { mode: 0o600 });

  assert.throws(
    () => store.append(event("blocked")),
    (error) => error?.code === "ACTIVITY_STORE_BUSY"
  );
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(readFileSync(lockPath), foreign);
});

test("restores a canonical blocker and stops later mutations after committed lock degradation", (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "crp-activity-degraded-"));
  const path = join(root, "private", "activity.jsonl");
  const lockPath = `${path}.crp.lock`;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ActivityStore({
    path,
    now: () => NOW,
    fileOperations: {
      ...realFileOperations,
      rmSync(target, options) {
        if (typeof target === "string" && target.endsWith(".release")) {
          const error = new Error("private claim cleanup failure");
          error.code = "EACCES";
          throw error;
        }
        return realFileOperations.rmSync(target, options);
      }
    }
  });

  assert.throws(
    () => store.append(event("committed")),
    (error) => error?.code === "ACTIVITY_STORE_COMMITTED_LOCK_DEGRADED"
      && error.details.committed === true
  );
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(
    readdirSync(join(path, "..")).filter((name) => name.endsWith(".release")),
    []
  );
  assert.throws(
    () => store.append(event("must-not-write")),
    (error) => error?.code === "ACTIVITY_STORE_LOCK_DEGRADED"
  );
  assert.equal(readFileSync(path, "utf8").includes("must-not-write"), false);
});

test("never deletes a foreign canonical replacement after lock initialization fails", (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "crp-activity-acquire-swap-"));
  const path = join(root, "private", "activity.jsonl");
  const lockPath = `${path}.crp.lock`;
  const displacedPath = `${lockPath}.displaced`;
  const foreign = Buffer.from("foreign-replacement\n", "utf8");
  let swapped = false;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ActivityStore({
    path,
    now: () => NOW,
    fileOperations: {
      ...realFileOperations,
      writeFileSync(target, bytes, options) {
        if (!swapped && typeof target === "number") {
          swapped = true;
          realFileOperations.renameSync(lockPath, displacedPath);
          realFileOperations.writeFileSync(lockPath, foreign, { mode: 0o600 });
          const error = new Error("private lock initialization failure");
          error.code = "EIO";
          throw error;
        }
        return realFileOperations.writeFileSync(target, bytes, options);
      }
    }
  });

  assert.throws(
    () => store.append(event("must-not-commit")),
    (error) => error?.code === "ACTIVITY_STORE_LOCK_DEGRADED"
      && error.details.committed === false
  );
  assert.deepEqual(readFileSync(lockPath), foreign);
  assert.equal(existsSync(path), false);
  assert.throws(
    () => store.append(event("must-stay-blocked")),
    (error) => error?.code === "ACTIVITY_STORE_LOCK_DEGRADED"
  );
  assert.deepEqual(readFileSync(lockPath), foreign);
});
