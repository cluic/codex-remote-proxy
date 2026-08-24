import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccessKeyStore } from "../src/access-key-store.mjs";

function fixture(t, { nowMs = Date.parse("2030-01-01T00:00:00.000Z") } = {}) {
  const root = mkdtempSync(join(tmpdir(), "crp-access-key-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let currentNow = nowMs;
  const path = join(root, "access-keys.sqlite3");
  const store = new AccessKeyStore({
    path,
    now: () => currentNow,
    createId: () => "key_test"
  });
  t.after(() => store.close());
  return {
    path,
    store,
    advance(milliseconds) {
      currentNow += milliseconds;
    }
  };
}

const SECRET = "crp_0123456789abcdefghijklmnopqrstuv";

test("access key values are write-only and authorization increments a durable count", (t) => {
  const { path, store } = fixture(t);
  const created = store.create({
    name: "Primary client",
    secret: SECRET,
    expiresAt: "2030-02-01T00:00:00.000Z",
    requestLimit: 2
  });

  assert.deepEqual(created, {
    id: "key_test",
    name: "Primary client",
    keyHint: "crp_\u2026stuv",
    enabled: true,
    expiresAt: "2030-02-01T00:00:00.000Z",
    requestLimit: 2,
    requestCount: 0,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastUsedAt: null
  });
  assert.equal(Object.hasOwn(created, "secret"), false);
  assert.equal(readFileSync(path).includes(Buffer.from(SECRET)), false);

  assert.deepEqual(store.authorize(SECRET), {
    ok: true,
    keyId: "key_test",
    requestCount: 1,
    requestLimit: 2
  });
  assert.equal(store.authorize(SECRET).ok, true);
  assert.deepEqual(store.authorize(SECRET), {
    ok: false,
    code: "API_KEY_LIMIT_EXCEEDED",
    status: 429
  });
  assert.equal(store.get("key_test").requestCount, 2);
  store.close();
  const reopened = new AccessKeyStore({ path });
  t.after(() => reopened.close());
  assert.equal(reopened.get("key_test").requestCount, 2);
});

test("disabled, expired, invalid, and deleted keys are rejected without resetting usage", (t) => {
  const fixtureState = fixture(t);
  const { store } = fixtureState;
  store.create({
    name: "Rotating client",
    secret: SECRET,
    expiresAt: "2030-01-01T00:00:01.000Z",
    requestLimit: null
  });
  assert.equal(store.authorize(SECRET).ok, true);

  store.update("key_test", { enabled: false });
  assert.equal(store.authorize(SECRET).code, "API_KEY_DISABLED");
  store.update("key_test", { enabled: true });
  fixtureState.advance(1_000);
  assert.equal(store.authorize(SECRET).code, "API_KEY_EXPIRED");
  assert.equal(store.authorize("crp_not-a-real-client-key").code, "API_KEY_INVALID");

  const deleted = store.delete("key_test");
  assert.equal(deleted.requestCount, 1);
  assert.deepEqual(store.list(), []);
});

test("access key inputs and duplicate names or values are bounded", (t) => {
  const root = mkdtempSync(join(tmpdir(), "crp-access-key-store-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = new AccessKeyStore({
    path: join(root, "access-keys.sqlite3"),
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    createId: () => `key_${sequence += 1}`
  });
  t.after(() => store.close());

  assert.throws(() => store.create({
    name: "Short",
    secret: "too-short",
    expiresAt: null,
    requestLimit: null
  }), { code: "ACCESS_KEY_INPUT_INVALID" });
  assert.throws(() => store.create({
    name: "Unsendable",
    secret: "crp_invalid key value 012345",
    expiresAt: null,
    requestLimit: null
  }), { code: "ACCESS_KEY_INPUT_INVALID" });
  store.create({ name: "Client", secret: SECRET, expiresAt: null, requestLimit: null });
  assert.throws(() => store.create({
    name: "client",
    secret: "crp_abcdefghijklmnopqrstuvwxyz012345",
    expiresAt: null,
    requestLimit: null
  }), { code: "ACCESS_KEY_CONFLICT" });
  assert.throws(() => store.create({
    name: "Other",
    secret: SECRET,
    expiresAt: null,
    requestLimit: null
  }), { code: "ACCESS_KEY_CONFLICT" });
  assert.throws(() => store.update("key_1", { requestLimit: 1_000_000_000_001 }), {
    code: "ACCESS_KEY_INPUT_INVALID"
  });
});
