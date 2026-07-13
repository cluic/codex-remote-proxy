import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  isNativeKeyringSmokeAuthorized,
  runNativeKeyringSmoke,
  runNativeKeyringSmokeMain
} from "../scripts/native-keyring-smoke.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/native-keyring-smoke.mjs", import.meta.url));

function makeIdentity(label = "test") {
  return {
    ref: `crp-ci-${label}-${randomUUID()}`,
    secret: ["crp", "ci", label, randomUUID(), randomUUID()].join("-")
  };
}

function assertRedacted(value, { ref, secret }) {
  const serialized = String(value);
  assert.equal(serialized.includes(ref), false);
  assert.equal(serialized.includes(secret), false);
}

function createRecordingStore({
  setWritesThenThrows = false,
  wrongGet = false,
  firstHasFalse = false,
  deletePlan = []
} = {}) {
  const values = new Map();
  const calls = [];
  let hasCalls = 0;
  let deleteCalls = 0;
  return {
    calls,
    values,
    async set(ref, secret) {
      calls.push({ operation: "set", args: [ref, secret] });
      values.set(ref, secret);
      if (setWritesThenThrows) {
        throw new Error(`set failed after write: ${ref}:${secret}`);
      }
    },
    async get(ref) {
      calls.push({ operation: "get", args: [ref] });
      if (wrongGet) {
        return "wrong-credential-value";
      }
      return values.get(ref);
    },
    async has(ref) {
      calls.push({ operation: "has", args: [ref] });
      hasCalls += 1;
      if (firstHasFalse && hasCalls === 1) {
        return false;
      }
      return values.has(ref);
    },
    async delete(ref) {
      calls.push({ operation: "delete", args: [ref] });
      const action = deletePlan[deleteCalls];
      deleteCalls += 1;
      if (action === "throw") {
        const secret = values.get(ref) ?? "missing";
        throw new Error(`delete failed: ${ref}:${secret}`);
      }
      if (action === "keep-true") {
        return true;
      }
      if (action === "false") {
        return false;
      }
      return values.delete(ref);
    }
  };
}

function operationNames(store) {
  return store.calls.map(({ operation }) => operation);
}

function assertExactIdentity(store, { ref, secret }) {
  assert.equal(store.calls.length > 0, true);
  assert.equal(store.calls.every(({ args }) => args[0] === ref), true);
  const setCalls = store.calls.filter(({ operation }) => operation === "set");
  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].args[1] === secret, true);
}

async function captureFailure(options) {
  try {
    await runNativeKeyringSmoke(options);
  } catch (error) {
    return error;
  }
  assert.fail("Expected native keyring smoke to fail");
}

test("native keyring smoke uses one exact identity for the complete successful contract", async () => {
  const identity = makeIdentity("success");
  const store = createRecordingStore();
  const output = [];

  const result = await runNativeKeyringSmoke({
    storeFactory: () => store,
    createRef: () => identity.ref,
    createSecret: () => identity.secret,
    writeLine: (line) => output.push(line)
  });

  assertRedacted(JSON.stringify(result), identity);
  assertRedacted(output.join("\n"), identity);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(operationNames(store), ["set", "get", "has", "delete", "has"]);
  assertExactIdentity(store, identity);
  assert.equal(store.values.size, 0);
  assert.deepEqual(output, ["Native keyring smoke passed."]);
});

test("default identity generation is unique across smoke runs", async () => {
  const stores = [createRecordingStore(), createRecordingStore()];
  for (const store of stores) {
    await runNativeKeyringSmoke({ storeFactory: () => store, writeLine: () => {} });
  }

  const identities = stores.map((store) => ({
    ref: store.calls[0].args[0],
    secret: store.calls[0].args[1]
  }));
  assert.equal(identities[0].ref === identities[1].ref, false);
  assert.equal(identities[0].secret === identities[1].secret, false);
  for (let index = 0; index < stores.length; index += 1) {
    assertExactIdentity(stores[index], identities[index]);
  }
});

test("primary smoke failures clean up and remain redacted", async (t) => {
  const cases = [
    {
      name: "set writes before throwing",
      options: { setWritesThenThrows: true },
      operations: ["set", "delete", "has"]
    },
    {
      name: "get returns the wrong credential",
      options: { wrongGet: true },
      operations: ["set", "get", "delete", "has"]
    },
    {
      name: "has reports false after an exact get",
      options: { firstHasFalse: true },
      operations: ["set", "get", "has", "delete", "has"]
    },
    {
      name: "delete reports success but the credential remains",
      options: { deletePlan: ["keep-true"] },
      operations: ["set", "get", "has", "delete", "has", "delete", "has"]
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const identity = makeIdentity("primary");
      const store = createRecordingStore(entry.options);
      const output = [];
      const error = await captureFailure({
        storeFactory: () => store,
        createRef: () => identity.ref,
        createSecret: () => identity.secret,
        writeLine: (line) => output.push(line)
      });

      assert.equal(error?.code, "NATIVE_KEYRING_SMOKE_FAILED");
      assertRedacted(error?.message, identity);
      assertRedacted(error?.stack, identity);
      assertRedacted(output.join("\n"), identity);
      assert.deepEqual(operationNames(store), entry.operations);
      assertExactIdentity(store, identity);
      assert.equal(store.values.size, 0);
      assert.deepEqual(output, []);
    });
  }
});

test("delete failures remain cleanup failures even when the finally retry succeeds", async () => {
  const identity = makeIdentity("delete");
  const store = createRecordingStore({ deletePlan: ["throw"] });
  const error = await captureFailure({
    storeFactory: () => store,
    createRef: () => identity.ref,
    createSecret: () => identity.secret,
    writeLine: () => {}
  });

  assert.equal(error?.code, "NATIVE_KEYRING_SMOKE_CLEANUP_FAILED");
  assertRedacted(error?.message, identity);
  assertRedacted(error?.stack, identity);
  assert.deepEqual(
    operationNames(store),
    ["set", "get", "has", "delete", "delete", "has"]
  );
  assertExactIdentity(store, identity);
  assert.equal(store.values.size, 0);
});

test("cleanup uncertainty overrides a primary error and never exposes identifiers", async () => {
  const identity = makeIdentity("cleanup");
  const store = createRecordingStore({
    setWritesThenThrows: true,
    deletePlan: ["throw"]
  });
  const error = await captureFailure({
    storeFactory: () => store,
    createRef: () => identity.ref,
    createSecret: () => identity.secret,
    writeLine: () => {}
  });

  assert.equal(error?.code, "NATIVE_KEYRING_SMOKE_CLEANUP_FAILED");
  assertRedacted(error?.message, identity);
  assertRedacted(error?.stack, identity);
  assert.deepEqual(operationNames(store), ["set", "delete"]);
  assertExactIdentity(store, identity);
  assert.equal(store.values.get(identity.ref) === identity.secret, true);
});

test("native keyring smoke main authorizes before constructing an adapter", async () => {
  let constructions = 0;
  const stdout = [];
  const stderr = [];
  const status = await runNativeKeyringSmokeMain({
    environment: {},
    smokeOptions: {
      storeFactory: () => {
        constructions += 1;
        return createRecordingStore();
      }
    },
    writeStdout: (chunk) => stdout.push(chunk),
    writeStderr: (chunk) => stderr.push(chunk)
  });

  assert.equal(status, 2);
  assert.equal(constructions, 0);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, [
    "Native keyring smoke requires an explicitly authorized platform runner.\n"
  ]);
});

test("native keyring smoke main returns success and failure exit codes with redacted streams", async () => {
  const environment = { GITHUB_ACTIONS: "true", CRP_NATIVE_KEYRING_SMOKE: "1" };

  const successIdentity = makeIdentity("main-success");
  const successStore = createRecordingStore();
  const successStdout = [];
  const successStderr = [];
  const successStatus = await runNativeKeyringSmokeMain({
    environment,
    smokeOptions: {
      storeFactory: () => successStore,
      createRef: () => successIdentity.ref,
      createSecret: () => successIdentity.secret
    },
    writeStdout: (chunk) => successStdout.push(chunk),
    writeStderr: (chunk) => successStderr.push(chunk)
  });
  assertRedacted(successStdout.join(""), successIdentity);
  assertRedacted(successStderr.join(""), successIdentity);
  assert.equal(successStatus, 0);
  assert.deepEqual(successStdout, ["Native keyring smoke passed.\n"]);
  assert.deepEqual(successStderr, []);
  assertExactIdentity(successStore, successIdentity);

  const failureIdentity = makeIdentity("main-failure");
  const failureStore = createRecordingStore({ wrongGet: true });
  const failureStdout = [];
  const failureStderr = [];
  const failureStatus = await runNativeKeyringSmokeMain({
    environment,
    smokeOptions: {
      storeFactory: () => failureStore,
      createRef: () => failureIdentity.ref,
      createSecret: () => failureIdentity.secret
    },
    writeStdout: (chunk) => failureStdout.push(chunk),
    writeStderr: (chunk) => failureStderr.push(chunk)
  });
  assertRedacted(failureStdout.join(""), failureIdentity);
  assertRedacted(failureStderr.join(""), failureIdentity);
  assert.equal(failureStatus, 1);
  assert.deepEqual(failureStdout, []);
  assert.deepEqual(failureStderr, [
    "Native keyring smoke failed (NATIVE_KEYRING_SMOKE_FAILED).\n"
  ]);
  assertExactIdentity(failureStore, failureIdentity);
});

test("direct CLI refuses unauthorized execution quickly without a test backdoor", () => {
  const environment = { ...process.env };
  delete environment.GITHUB_ACTIONS;
  delete environment.CRP_NATIVE_KEYRING_SMOKE;
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: environment,
    timeout: 2_000
  });
  const elapsed = performance.now() - startedAt;

  assert.ifError(result.error);
  assert.equal(elapsed < 2_000, true);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Native keyring smoke requires an explicitly authorized platform runner.\n"
  );
});

test("native keyring smoke authorization requires both explicit runner signals", () => {
  assert.equal(isNativeKeyringSmokeAuthorized({}), false);
  assert.equal(isNativeKeyringSmokeAuthorized({ GITHUB_ACTIONS: "true" }), false);
  assert.equal(isNativeKeyringSmokeAuthorized({ CRP_NATIVE_KEYRING_SMOKE: "1" }), false);
  assert.equal(isNativeKeyringSmokeAuthorized({
    GITHUB_ACTIONS: "true",
    CRP_NATIVE_KEYRING_SMOKE: "1"
  }), true);
});
