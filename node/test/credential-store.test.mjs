import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as realFileOperations from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";

import { FileCredentialStore } from "../src/credentials/file-credential-store.mjs";
import { NativeKeyringStore } from "../src/credentials/native-keyring.mjs";
import { createCredentialStore } from "../src/credentials/credential-store.mjs";
import {
  normalizeProvider,
  toPublicProvider
} from "../src/providers/provider-schema.mjs";
import { CrpError, toPublicError } from "../src/shared/errors.mjs";

const NATIVE_SERVICE = "org.cluic.codex-remote-proxy";

function makeRef(label = "provider") {
  return `${label}-${randomUUID()}`;
}

function makeSecret() {
  return ["test", "credential", randomUUID()].join("-");
}

function makeFileError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertCrpError(expectedCode, expectedStatus) {
  return (error) => {
    assert.ok(error instanceof CrpError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, expectedStatus);
    assert.equal(typeof error.action, "string");
    assert.notEqual(error.action.length, 0);
    return true;
  };
}

function assertSafePublicError(error, prohibited) {
  const serialized = JSON.stringify(toPublicError(error, "request-test"));
  for (const value of prohibited) {
    assert.equal(serialized.includes(value), false);
  }
}

function makeTempCredentialPath(t, prefix = "crp-credentials-") {
  const tempRoot = mkdtempSync(join(os.tmpdir(), prefix));
  const parent = join(tempRoot, "private");
  const path = join(parent, "secrets.json");
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return { tempRoot, parent, path, lockPath: `${path}.crp.lock` };
}

function writeCredentialBytes(path, bytes, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

function credentialDocument(credentials = {}) {
  return { schemaVersion: 1, credentials };
}

function listTempFiles(path) {
  if (!existsSync(dirname(path))) return [];
  const fileName = basename(path);
  return readdirSync(dirname(path)).filter((name) => (
    name.startsWith(`.${fileName}.`) && name.endsWith(".tmp")
  ));
}

function isLockReleasePath(filePath, lockPath) {
  if (typeof filePath !== "string" || dirname(filePath) !== dirname(lockPath)) {
    return false;
  }
  const name = basename(filePath);
  return name.startsWith(`.${basename(lockPath)}.`) && name.endsWith(".release");
}

function listLockReleaseFiles(lockPath) {
  if (!existsSync(dirname(lockPath))) return [];
  return readdirSync(dirname(lockPath))
    .map((name) => join(dirname(lockPath), name))
    .filter((filePath) => isLockReleasePath(filePath, lockPath));
}

function isGateClaimPath(filePath, gatePath) {
  if (typeof filePath !== "string" || dirname(filePath) !== dirname(gatePath)) {
    return false;
  }
  const name = basename(filePath);
  return name.startsWith(`.${basename(gatePath)}.`) && name.endsWith(".claim");
}

function listGateClaimPaths(gatePath) {
  if (!existsSync(dirname(gatePath))) return [];
  return readdirSync(dirname(gatePath))
    .map((name) => join(dirname(gatePath), name))
    .filter((filePath) => isGateClaimPath(filePath, gatePath));
}

class MemoryCredentialStore {
  constructor() {
    this.values = new Map();
    this.backend = "memory";
  }

  async set(ref, secret) {
    this.values.set(ref, secret);
  }

  async get(ref) {
    if (!this.values.has(ref)) {
      throw new CrpError(
        "CREDENTIAL_NOT_FOUND",
        "The credential does not exist.",
        "Save the provider credential and try again.",
        { status: 404 }
      );
    }
    return this.values.get(ref);
  }

  async has(ref) {
    return this.values.has(ref);
  }

  async delete(ref) {
    return this.values.delete(ref);
  }
}

async function assertCredentialContract(store, { afterSet } = {}) {
  const ref = makeRef();
  const secret = makeSecret();

  assert.equal(typeof store.list, "undefined");
  await store.set(ref, secret);
  assert.equal(await store.has(ref), true);
  assert.equal(await store.get(ref), secret);
  await afterSet?.({ ref, secret });
  assert.equal(await store.delete(ref), true);
  assert.equal(await store.has(ref), false);
  await assert.rejects(
    () => store.get(ref),
    assertCrpError("CREDENTIAL_NOT_FOUND", 404)
  );
  assert.equal(await store.delete(ref), false);
}

function createFakeEntryClass() {
  const values = new Map();
  const constructions = [];
  class FakeEntry {
    constructor(service, ref) {
      constructions.push({ service, ref });
      this.ref = ref;
    }

    setPassword(secret) {
      values.set(this.ref, secret);
    }

    getPassword() {
      return values.get(this.ref) ?? null;
    }

    deletePassword() {
      return values.delete(this.ref);
    }
  }
  return { FakeEntry, values, constructions };
}

test("shared async credential contract works for an in-memory test double", async () => {
  await assertCredentialContract(new MemoryCredentialStore());
});

test("shared async credential contract persists the exact file schema and reloads", async (t) => {
  const { parent, path } = makeTempCredentialPath(t);
  const store = new FileCredentialStore({ path });

  await assertCredentialContract(store, {
    afterSet: async ({ ref, secret }) => {
      assert.deepEqual(
        JSON.parse(readFileSync(path, "utf8")),
        credentialDocument({ [ref]: secret })
      );
      assert.equal(readFileSync(path, "utf8").includes("providerMetadata"), false);
      assert.equal(readFileSync(path, "utf8").includes("baseUrl"), false);
      const reloaded = new FileCredentialStore({ path });
      assert.equal(await reloaded.get(ref), secret);
      assert.equal(typeof reloaded.list, "undefined");
    }
  });

  if (process.platform !== "win32") {
    assert.equal(lstatSync(parent).mode & 0o777, 0o700);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  }
});

test("file mutations avoid lost updates and reads refresh committed disk state", async (t) => {
  const { path } = makeTempCredentialPath(t, "crp-credentials-multi-");
  const first = new FileCredentialStore({ path });
  const second = new FileCredentialStore({ path });
  const firstRef = makeRef("first");
  const secondRef = makeRef("second");
  const firstSecret = makeSecret();
  const secondSecret = makeSecret();

  await first.set(firstRef, firstSecret);
  await second.set(secondRef, secondSecret);

  assert.equal(await first.get(secondRef), secondSecret);
  assert.equal(await second.get(firstRef), firstSecret);
  assert.deepEqual(
    JSON.parse(readFileSync(path, "utf8")),
    credentialDocument({
      [firstRef]: firstSecret,
      [secondRef]: secondSecret
    })
  );

  await first.delete(firstRef);
  assert.equal(await second.has(firstRef), false);
  assert.equal(await second.get(secondRef), secondSecret);
});

test("file persistence uses exclusive 0600 lock and temp files in atomic order", async (t) => {
  const { parent, path, lockPath } = makeTempCredentialPath(t, "crp-credentials-atomic-");
  const gatePath = `${lockPath}.gate`;
  const events = [];
  const descriptorPaths = new Map();
  const fileOperations = {
    ...realFileOperations,
    openSync(filePath, flags, mode) {
      const descriptor = realFileOperations.openSync(filePath, flags, mode);
      descriptorPaths.set(descriptor, filePath);
      events.push({ operation: "open", path: filePath, flags, mode });
      return descriptor;
    },
    fsyncSync(descriptor) {
      events.push({ operation: "fsync", path: descriptorPaths.get(descriptor) });
      return realFileOperations.fsyncSync(descriptor);
    },
    closeSync(descriptor) {
      events.push({ operation: "close", path: descriptorPaths.get(descriptor) });
      return realFileOperations.closeSync(descriptor);
    },
    chmodSync(filePath, mode) {
      events.push({ operation: "chmod", path: filePath, mode });
      return realFileOperations.chmodSync(filePath, mode);
    },
    renameSync(source, target) {
      events.push({ operation: "rename", source, target });
      return realFileOperations.renameSync(source, target);
    }
  };
  const store = new FileCredentialStore({ path, fileOperations });

  await store.set(makeRef(), makeSecret());

  const lockOpen = events.find((event) => event.operation === "open" && event.path === lockPath);
  const tempOpen = events.find((event) => (
    event.operation === "open"
    && event.path !== lockPath
    && event.path.endsWith(".tmp")
  ));
  assert.deepEqual(
    { flags: lockOpen.flags, mode: lockOpen.mode },
    { flags: "wx", mode: 0o600 }
  );
  assert.deepEqual(
    { flags: tempOpen.flags, mode: tempOpen.mode },
    { flags: "wx", mode: 0o600 }
  );
  assert.equal(dirname(tempOpen.path), dirname(path));

  const fsyncIndex = events.findIndex((event) => (
    event.operation === "fsync" && event.path === tempOpen.path
  ));
  const closeIndex = events.findIndex((event) => (
    event.operation === "close" && event.path === tempOpen.path
  ));
  const chmodIndex = events.findIndex((event) => (
    event.operation === "chmod" && event.path === tempOpen.path && event.mode === 0o600
  ));
  const renameIndex = events.findIndex((event) => (
    event.operation === "rename"
    && event.source === tempOpen.path
    && event.target === path
  ));
  assert.ok(fsyncIndex < closeIndex);
  assert.ok(closeIndex < chmodIndex);
  assert.ok(chmodIndex < renameIndex);
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(gatePath), false);
  assert.deepEqual(listGateClaimPaths(gatePath), []);
  assert.deepEqual(listTempFiles(path), []);

  await store.set(makeRef("later"), makeSecret());
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(gatePath), false);
  assert.deepEqual(listGateClaimPaths(gatePath), []);

  if (process.platform !== "win32") {
    assert.equal(lstatSync(parent).mode & 0o777, 0o700);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  }
});

test("malformed and schema-invalid files fail closed without overwrite", async (t) => {
  const secret = makeSecret();
  const ref = makeRef();
  const cases = [
    ["malformed JSON", `{${secret}`],
    ["unsupported schema", JSON.stringify({ schemaVersion: 2, credentials: {} })],
    ["extra metadata", JSON.stringify({
      schemaVersion: 1,
      credentials: {},
      providerMetadata: { ref }
    })],
    ["array credentials", JSON.stringify({ schemaVersion: 1, credentials: [] })],
    ["unsafe reference", JSON.stringify(credentialDocument({ ["__proto__"]: secret }))],
    ["empty secret", JSON.stringify(credentialDocument({ [ref]: "" }))],
    ["non-string secret", JSON.stringify(credentialDocument({ [ref]: 42 }))]
  ];

  for (const [label, bytes] of cases) {
    await t.test(label, async (nested) => {
      const { path, lockPath } = makeTempCredentialPath(nested, "crp-credentials-invalid-");
      const store = new FileCredentialStore({ path });
      writeCredentialBytes(path, bytes);

      let caught;
      try {
        await store.set(makeRef("new"), makeSecret());
      } catch (error) {
        caught = error;
      }
      assertCrpError("CREDENTIAL_FILE_INVALID", 500)(caught);
      assert.equal(readFileSync(path, "utf8"), bytes);
      assert.equal(existsSync(lockPath), false);
      assert.deepEqual(listTempFiles(path), []);
      assertSafePublicError(caught, [secret, ref, bytes]);
    });
  }
});

test("symbolic-link credential files are rejected before reading", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation requires platform privileges");
    return;
  }
  const { parent, path } = makeTempCredentialPath(t, "crp-credentials-symlink-");
  const target = join(dirname(parent), "target.json");
  const secret = makeSecret();
  const bytes = `${JSON.stringify(credentialDocument({ [makeRef()]: secret }))}\n`;
  writeCredentialBytes(target, bytes);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  symlinkSync(target, path);

  let caught;
  try {
    new FileCredentialStore({ path });
  } catch (error) {
    caught = error;
  }
  assertCrpError("CREDENTIAL_FILE_INSECURE", 500)(caught);
  assert.equal(readFileSync(target, "utf8"), bytes);
  assertSafePublicError(caught, [secret, target, path]);
});

test("group or other accessible credential files are rejected before reading", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not authoritative on Windows");
    return;
  }
  const { path } = makeTempCredentialPath(t, "crp-credentials-mode-");
  const secret = makeSecret();
  const bytes = `${JSON.stringify(credentialDocument({ [makeRef()]: secret }))}\n`;
  writeCredentialBytes(path, bytes, 0o644);

  let caught;
  try {
    new FileCredentialStore({ path });
  } catch (error) {
    caught = error;
  }
  assertCrpError("CREDENTIAL_FILE_INSECURE", 500)(caught);
  assertSafePublicError(caught, [secret, bytes, path]);
});

test("credential reads fail closed when the path is swapped between lstat and open", async (t) => {
  const platforms = process.platform === "win32"
    ? ["win32"]
    : [process.platform, "win32"];

  for (const platform of platforms) {
    await t.test(`fd identity on ${platform}`, (nested) => {
      const { tempRoot, path } = makeTempCredentialPath(
        nested,
        `crp-credentials-swap-${platform}-`
      );
      const originalPath = join(tempRoot, "original.json");
      const targetPath = join(tempRoot, "target.json");
      const originalSecret = makeSecret();
      const targetSecret = makeSecret();
      writeCredentialBytes(
        path,
        `${JSON.stringify(credentialDocument({ [makeRef("original")]: originalSecret }))}\n`
      );
      writeCredentialBytes(
        targetPath,
        `${JSON.stringify(credentialDocument({ [makeRef("target")]: targetSecret }))}\n`
      );
      let swapped = false;
      let pathReadAttempts = 0;
      const fileOperations = {
        ...realFileOperations,
        openSync(filePath, flags, mode) {
          if (filePath === path && typeof flags === "number" && !swapped) {
            realFileOperations.renameSync(path, originalPath);
            realFileOperations.renameSync(targetPath, path);
            swapped = true;
            return realFileOperations.openSync(originalPath, flags, mode);
          }
          return realFileOperations.openSync(filePath, flags, mode);
        },
        readFileSync(fileOrDescriptor, options) {
          if (fileOrDescriptor === path || fileOrDescriptor === targetPath) {
            pathReadAttempts += 1;
          }
          return realFileOperations.readFileSync(fileOrDescriptor, options);
        }
      };

      let caught;
      try {
        new FileCredentialStore({ path, platform, fileOperations });
      } catch (error) {
        caught = error;
      }
      assertCrpError("CREDENTIAL_FILE_INSECURE", 500)(caught);
      assert.equal(swapped, true);
      assert.equal(pathReadAttempts, 0);
      assertSafePublicError(caught, [
        originalSecret,
        targetSecret,
        originalPath,
        targetPath,
        path
      ]);
    });
  }
});

test("POSIX parent and file modes are validated before reading secret bytes", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not authoritative on Windows");
    return;
  }
  const cases = [
    {
      label: "parent broader than 0700",
      setup({ parent, path }, bytes) {
        writeCredentialBytes(path, bytes, 0o600);
        chmodSync(parent, 0o750);
      }
    },
    {
      label: "file mode is not exactly 0600",
      setup({ path }, bytes) {
        writeCredentialBytes(path, bytes, 0o400);
      }
    },
    {
      label: "parent is a symbolic link",
      setup({ tempRoot, parent }, bytes) {
        const realParent = join(tempRoot, "real-private");
        const realPath = join(realParent, "secrets.json");
        writeCredentialBytes(realPath, bytes, 0o600);
        symlinkSync(realParent, parent);
      }
    }
  ];

  for (const { label, setup } of cases) {
    await t.test(label, (nested) => {
      const paths = makeTempCredentialPath(nested, "crp-credentials-parent-mode-");
      const secret = makeSecret();
      const bytes = `${JSON.stringify(credentialDocument({ [makeRef()]: secret }))}\n`;
      setup(paths, bytes);
      let pathReadAttempts = 0;
      const fileOperations = {
        ...realFileOperations,
        readFileSync(fileOrDescriptor, options) {
          if (fileOrDescriptor === paths.path) pathReadAttempts += 1;
          return realFileOperations.readFileSync(fileOrDescriptor, options);
        }
      };

      let caught;
      try {
        new FileCredentialStore({ path: paths.path, fileOperations });
      } catch (error) {
        caught = error;
      }
      assertCrpError("CREDENTIAL_FILE_INSECURE", 500)(caught);
      assert.equal(pathReadAttempts, 0);
      assertSafePublicError(caught, [secret, bytes, paths.path, paths.parent]);
    });
  }
});

test("rename failure preserves committed bytes and cleans temporary state", async (t) => {
  const { path, lockPath } = makeTempCredentialPath(t, "crp-credentials-rename-");
  const oldRef = makeRef("old");
  const oldSecret = makeSecret();
  const newRef = makeRef("new");
  const newSecret = makeSecret();
  const original = new FileCredentialStore({ path });
  await original.set(oldRef, oldSecret);
  const before = readFileSync(path, "utf8");
  const failure = makeFileError(`${newRef}:${newSecret}`, "EIO");
  const store = new FileCredentialStore({
    path,
    fileOperations: {
      ...realFileOperations,
      renameSync(source, target) {
        if (target === path) throw failure;
        return realFileOperations.renameSync(source, target);
      }
    }
  });

  let caught;
  try {
    await store.set(newRef, newSecret);
  } catch (error) {
    caught = error;
  }
  assertCrpError("CREDENTIAL_BACKEND_UNAVAILABLE", 500)(caught);
  assert.equal(caught.cause, failure);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(await store.get(oldRef), oldSecret);
  assert.equal(await store.has(newRef), false);
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(listTempFiles(path), []);
  assertSafePublicError(caught, [newRef, newSecret, failure.message, before]);
});

test("permanent secret-temp cleanup failure degrades the instance before later opens", async (t) => {
  const { path, lockPath } = makeTempCredentialPath(t, "crp-credentials-temp-degraded-");
  const ref = makeRef();
  const secret = makeSecret();
  const persistenceFailure = makeFileError(`${ref}:${secret}`, "EIO");
  const descriptorPaths = new Map();
  let openCalls = 0;
  let tempRemovalAttempts = 0;
  const store = new FileCredentialStore({
    path,
    fileOperations: {
      ...realFileOperations,
      openSync(filePath, flags, mode) {
        openCalls += 1;
        const descriptor = realFileOperations.openSync(filePath, flags, mode);
        descriptorPaths.set(descriptor, filePath);
        return descriptor;
      },
      fsyncSync(descriptor) {
        if (descriptorPaths.get(descriptor)?.endsWith(".tmp")) {
          throw persistenceFailure;
        }
        return realFileOperations.fsyncSync(descriptor);
      },
      rmSync(filePath, options) {
        if (filePath.endsWith(".tmp")) {
          tempRemovalAttempts += 1;
          throw makeFileError("permanent temp removal", "EPERM");
        }
        return realFileOperations.rmSync(filePath, options);
      }
    }
  });

  let caught;
  try {
    await store.set(ref, secret);
  } catch (error) {
    caught = error;
  }
  assertCrpError("CREDENTIAL_STORE_TEMP_DEGRADED", 500)(caught);
  assert.deepEqual(caught.details, { committed: false });
  assert.equal(caught.cause, persistenceFailure);
  assert.match(caught.action, /explicitly remove/i);
  assert.equal(tempRemovalAttempts, 2);
  assert.equal(listTempFiles(path).length, 1);
  assert.equal(existsSync(lockPath), false);
  assertSafePublicError(caught, [ref, secret, persistenceFailure.message, path]);
  const opensAfterFailure = openCalls;

  await assert.rejects(
    () => store.set(makeRef("blocked"), makeSecret()),
    assertCrpError("CREDENTIAL_STORE_TEMP_DEGRADED", 500)
  );
  assert.equal(openCalls, opensAfterFailure);
  assert.equal(tempRemovalAttempts, 2);
  assert.equal(listTempFiles(path).length, 1);
});

test("one-shot secret-temp removal failure is retried without degrading later writes", async (t) => {
  const { path, lockPath } = makeTempCredentialPath(t, "crp-credentials-temp-retry-");
  const failure = makeFileError("forced pre-rename failure", "EIO");
  const descriptorPaths = new Map();
  let persistenceFailures = 0;
  let tempRemovalAttempts = 0;
  const store = new FileCredentialStore({
    path,
    fileOperations: {
      ...realFileOperations,
      openSync(filePath, flags, mode) {
        const descriptor = realFileOperations.openSync(filePath, flags, mode);
        descriptorPaths.set(descriptor, filePath);
        return descriptor;
      },
      fsyncSync(descriptor) {
        if (
          descriptorPaths.get(descriptor)?.endsWith(".tmp")
          && persistenceFailures === 0
        ) {
          persistenceFailures += 1;
          throw failure;
        }
        return realFileOperations.fsyncSync(descriptor);
      },
      rmSync(filePath, options) {
        if (filePath.endsWith(".tmp")) {
          tempRemovalAttempts += 1;
          if (tempRemovalAttempts === 1) {
            throw makeFileError("transient temp removal", "EBUSY");
          }
        }
        return realFileOperations.rmSync(filePath, options);
      }
    }
  });

  await assert.rejects(
    () => store.set(makeRef("first"), makeSecret()),
    (error) => {
      assertCrpError("CREDENTIAL_BACKEND_UNAVAILABLE", 500)(error);
      assert.equal(error.cause, failure);
      return true;
    }
  );
  assert.equal(tempRemovalAttempts, 2);
  assert.deepEqual(listTempFiles(path), []);
  assert.equal(existsSync(lockPath), false);

  const ref = makeRef("second");
  const secret = makeSecret();
  await store.set(ref, secret);
  assert.equal(await store.get(ref), secret);
  assert.deepEqual(listTempFiles(path), []);
});

test("transient lock close and removal failures are retried", async (t) => {
  const { path, lockPath } = makeTempCredentialPath(t, "crp-credentials-retry-");
  const descriptorPaths = new Map();
  let closeFailures = 0;
  let removalFailures = 0;
  const store = new FileCredentialStore({
    path,
    fileOperations: {
      ...realFileOperations,
      openSync(filePath, flags, mode) {
        const descriptor = realFileOperations.openSync(filePath, flags, mode);
        descriptorPaths.set(descriptor, filePath);
        return descriptor;
      },
      closeSync(descriptor) {
        if (descriptorPaths.get(descriptor) === lockPath && closeFailures === 0) {
          closeFailures += 1;
          throw makeFileError("transient close", "EINTR");
        }
        return realFileOperations.closeSync(descriptor);
      },
      rmSync(filePath, options) {
        if (isLockReleasePath(filePath, lockPath) && removalFailures === 0) {
          removalFailures += 1;
          throw makeFileError("transient removal", "EBUSY");
        }
        return realFileOperations.rmSync(filePath, options);
      }
    }
  });

  await store.set(makeRef(), makeSecret());

  assert.equal(closeFailures, 1);
  assert.equal(removalFailures, 1);
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(listLockReleaseFiles(lockPath), []);
});

test("permanent residual lock reports committed degradation and is never auto-removed", async (t) => {
  const { path, lockPath } = makeTempCredentialPath(t, "crp-credentials-degraded-");
  const gatePath = `${lockPath}.gate`;
  let lockReads = 0;
  let lockRemovals = 0;
  const ref = makeRef();
  const secret = makeSecret();
  const store = new FileCredentialStore({
    path,
    fileOperations: {
      ...realFileOperations,
      readFileSync(filePath, options) {
        if (isLockReleasePath(filePath, lockPath)) lockReads += 1;
        return realFileOperations.readFileSync(filePath, options);
      },
      rmSync(filePath, options) {
        if (isLockReleasePath(filePath, lockPath)) {
          lockRemovals += 1;
          throw makeFileError("permanent removal", "EPERM");
        }
        return realFileOperations.rmSync(filePath, options);
      }
    }
  });

  await assert.rejects(
    () => store.set(ref, secret),
    (error) => {
      assertCrpError("CREDENTIAL_STORE_COMMITTED_LOCK_DEGRADED", 500)(error);
      assert.deepEqual(error.details, { committed: true });
      return true;
    }
  );
  assert.equal(await store.get(ref), secret);
  assert.equal(existsSync(lockPath), true);
  assert.notEqual(readFileSync(lockPath, "utf8").length, 0);
  assert.equal(listLockReleaseFiles(lockPath).length, 1);
  assert.equal(existsSync(gatePath), false);
  const readsAfterCommit = lockReads;
  const removalsAfterCommit = lockRemovals;

  await assert.rejects(
    () => store.set(makeRef("blocked"), makeSecret()),
    assertCrpError("CREDENTIAL_STORE_LOCK_DEGRADED", 500)
  );
  assert.equal(lockReads, readsAfterCommit);
  assert.equal(lockRemovals, removalsAfterCommit);
  assert.equal(existsSync(lockPath), true);
  assert.equal(listLockReleaseFiles(lockPath).length, 1);

  const second = new FileCredentialStore({ path });
  await assert.rejects(
    () => second.set(makeRef("blocked-fresh"), makeSecret()),
    assertCrpError("CREDENTIAL_STORE_BUSY", 409)
  );
  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(gatePath), false);
});

test("a preexisting foreign lock remains in place and reports busy", async (t) => {
  const { parent, path, lockPath } = makeTempCredentialPath(
    t,
    "crp-credentials-preexisting-lock-"
  );
  const foreignToken = `${randomUUID()}\n`;
  const store = new FileCredentialStore({ path });
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  writeFileSync(lockPath, foreignToken, { mode: 0o600 });

  await assert.rejects(
    () => store.set(makeRef(), makeSecret()),
    assertCrpError("CREDENTIAL_STORE_BUSY", 409)
  );
  assert.equal(readFileSync(lockPath, "utf8"), foreignToken);
  assert.deepEqual(listLockReleaseFiles(lockPath), []);
});

test("a preexisting foreign gate remains intact and blocks mutation", async (t) => {
  const { parent, path, lockPath } = makeTempCredentialPath(
    t,
    "crp-credentials-preexisting-gate-"
  );
  const gatePath = `${lockPath}.gate`;
  const markerPath = join(gatePath, "foreign-marker");
  const marker = `${randomUUID()}\n`;
  const store = new FileCredentialStore({ path });
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  mkdirSync(gatePath, { mode: 0o700 });
  writeFileSync(markerPath, marker, { mode: 0o600 });

  await assert.rejects(
    () => store.set(makeRef(), makeSecret()),
    assertCrpError("CREDENTIAL_STORE_BUSY", 409)
  );
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(markerPath, "utf8"), marker);
  assert.equal(existsSync(gatePath), true);
});

test("gate release claims before delete and preserves an immediate foreign replacement", async (t) => {
  const { path, lockPath } = makeTempCredentialPath(t, "crp-credentials-gate-claim-");
  const gatePath = `${lockPath}.gate`;
  const displacedOwnedGatePath = `${gatePath}.${randomUUID()}.displaced`;
  const ref = makeRef();
  const secret = makeSecret();
  let injected = false;
  let foreignDeletedByCanonicalRmdir = false;
  let foreignClaimPath = null;

  function replaceCanonicalGate(targetPath = null) {
    realFileOperations.renameSync(gatePath, displacedOwnedGatePath);
    realFileOperations.mkdirSync(gatePath, { mode: 0o700 });
    if (isGateClaimPath(targetPath, gatePath)) foreignClaimPath = targetPath;
    injected = true;
  }

  const store = new FileCredentialStore({
    path,
    fileOperations: {
      ...realFileOperations,
      renameSync(source, target) {
        if (!injected && source === gatePath) replaceCanonicalGate(target);
        return realFileOperations.renameSync(source, target);
      },
      rmdirSync(directoryPath) {
        if (!injected && directoryPath === gatePath) replaceCanonicalGate();
        const result = realFileOperations.rmdirSync(directoryPath);
        if (directoryPath === gatePath && injected) {
          foreignDeletedByCanonicalRmdir = !existsSync(gatePath);
        }
        return result;
      }
    }
  });

  await assert.rejects(
    () => store.set(ref, secret),
    assertCrpError("CREDENTIAL_STORE_COMMITTED_LOCK_DEGRADED", 500)
  );
  assert.equal(injected, true);
  assert.equal(foreignDeletedByCanonicalRmdir, false);
  assert.equal(await store.get(ref), secret);
  assert.equal(typeof foreignClaimPath, "string");
  assert.equal(existsSync(foreignClaimPath), true);
  assert.deepEqual(listGateClaimPaths(gatePath), [foreignClaimPath]);
  assert.equal(existsSync(gatePath), true);
  assert.equal(lstatSync(gatePath).isDirectory(), true);

  const committedBytes = readFileSync(path, "utf8");
  const second = new FileCredentialStore({ path });
  await assert.rejects(
    () => second.set(makeRef("blocked-after-gate-swap"), makeSecret()),
    assertCrpError("CREDENTIAL_STORE_BUSY", 409)
  );
  assert.equal(readFileSync(path, "utf8"), committedBytes);
  assert.equal(existsSync(foreignClaimPath), true);
  assert.equal(existsSync(gatePath), true);
});

test("primary lock blocks a synchronous second mutation during gate claim validation", async (t) => {
  const { path, lockPath } = makeTempCredentialPath(t, "crp-credentials-gate-gap-");
  const gatePath = `${lockPath}.gate`;
  const firstRef = makeRef("first-gap");
  const firstSecret = makeSecret();
  const secondRef = makeRef("second-gap");
  const secondSecret = makeSecret();
  const second = new FileCredentialStore({ path });
  let injected = false;
  let bytesBeforeSecond;
  let secondAttempt;
  const first = new FileCredentialStore({
    path,
    fileOperations: {
      ...realFileOperations,
      lstatSync(filePath) {
        if (!injected && isGateClaimPath(filePath, gatePath)) {
          injected = true;
          bytesBeforeSecond = realFileOperations.readFileSync(path, "utf8");
          secondAttempt = second.set(secondRef, secondSecret);
          secondAttempt.catch(() => {});
        }
        return realFileOperations.lstatSync(filePath);
      }
    }
  });

  await first.set(firstRef, firstSecret);

  assert.equal(injected, true);
  assert.ok(secondAttempt instanceof Promise);
  await assert.rejects(
    secondAttempt,
    assertCrpError("CREDENTIAL_STORE_BUSY", 409)
  );
  assert.equal(readFileSync(path, "utf8"), bytesBeforeSecond);
  assert.equal(await first.get(firstRef), firstSecret);
  assert.equal(await first.has(secondRef), false);
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(gatePath), false);
  assert.deepEqual(listGateClaimPaths(gatePath), []);
});

test("an immediate pre-claim lock swap preserves foreign bytes", async (t) => {
  const { path, lockPath } = makeTempCredentialPath(t, "crp-credentials-foreign-");
  const gatePath = `${lockPath}.gate`;
  const foreignToken = `${randomUUID()}\n`;
  const displacedPath = `${lockPath}.${randomUUID()}.displaced`;
  const ref = makeRef();
  const secret = makeSecret();
  let swapTriggered = false;
  const store = new FileCredentialStore({
    path,
    fileOperations: {
      ...realFileOperations,
      renameSync(source, target) {
        if (source === lockPath && isLockReleasePath(target, lockPath)) {
          realFileOperations.renameSync(lockPath, displacedPath);
          realFileOperations.writeFileSync(lockPath, foreignToken, { mode: 0o600 });
          swapTriggered = true;
        }
        return realFileOperations.renameSync(source, target);
      }
    }
  });

  await assert.rejects(
    () => store.set(ref, secret),
    assertCrpError("CREDENTIAL_STORE_COMMITTED_LOCK_DEGRADED", 500)
  );
  assert.equal(swapTriggered, true);
  assert.equal(await store.get(ref), secret);
  const survivingPaths = [lockPath, ...listLockReleaseFiles(lockPath)]
    .filter((filePath) => existsSync(filePath));
  assert.equal(
    survivingPaths.some((filePath) => readFileSync(filePath, "utf8") === foreignToken),
    true
  );
  assert.equal(existsSync(lockPath), true);
  assert.notEqual(readFileSync(lockPath, "utf8").length, 0);
  assert.equal(existsSync(gatePath), false);

  const before = readFileSync(path, "utf8");
  const second = new FileCredentialStore({ path });
  await assert.rejects(
    () => second.set(makeRef("blocked-second"), makeSecret()),
    assertCrpError("CREDENTIAL_STORE_BUSY", 409)
  );
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(gatePath), false);
});

test("native adapter uses the injected Entry class and exact service contract", async () => {
  const { FakeEntry, constructions } = createFakeEntryClass();
  const store = new NativeKeyringStore({ entryLoader: () => FakeEntry });

  await assertCredentialContract(store);

  assert.equal(store.backend, "native");
  assert.equal(typeof store.list, "undefined");
  assert.ok(constructions.length > 0);
  assert.equal(constructions.every(({ service }) => service === NATIVE_SERVICE), true);
});

test("native adapter distinguishes missing credentials from backend outages", async () => {
  const ref = makeRef();
  const secret = makeSecret();
  const backendFailure = new Error(`${ref}:${secret}`);
  class MissingEntry {
    getPassword() { return null; }
    deletePassword() { return false; }
  }
  const missing = new NativeKeyringStore({ entryLoader: () => MissingEntry });
  await assert.rejects(
    () => missing.get(ref),
    assertCrpError("CREDENTIAL_NOT_FOUND", 404)
  );
  assert.equal(await missing.has(ref), false);
  assert.equal(await missing.delete(ref), false);

  class FailingEntry {
    setPassword() { throw backendFailure; }
    getPassword() { throw backendFailure; }
    deletePassword() { throw backendFailure; }
  }
  const failing = new NativeKeyringStore({ entryLoader: () => FailingEntry });
  for (const operation of [
    () => failing.set(ref, secret),
    () => failing.get(ref),
    () => failing.has(ref),
    () => failing.delete(ref)
  ]) {
    let caught;
    try {
      await operation();
    } catch (error) {
      caught = error;
    }
    assertCrpError("CREDENTIAL_BACKEND_UNAVAILABLE", 500)(caught);
    assert.equal(caught.cause, backendFailure);
    assertSafePublicError(caught, [ref, secret, backendFailure.message]);
  }
});

test("credential adapters reject unsafe references and empty secrets", async (t) => {
  const { path } = makeTempCredentialPath(t, "crp-credentials-input-");
  const { FakeEntry } = createFakeEntryClass();
  const stores = [
    new FileCredentialStore({ path }),
    new NativeKeyringStore({ entryLoader: () => FakeEntry })
  ];
  const unsafeReferences = ["", "   ", "__proto__", "constructor", "prototype", null, {}];

  for (const store of stores) {
    for (const ref of unsafeReferences) {
      await assert.rejects(
        () => store.get(ref),
        assertCrpError("CREDENTIAL_INPUT_INVALID", 400)
      );
    }
    await assert.rejects(
      () => store.set(makeRef(), ""),
      assertCrpError("CREDENTIAL_INPUT_INVALID", 400)
    );
    await assert.rejects(
      () => store.set(makeRef(), null),
      assertCrpError("CREDENTIAL_INPUT_INVALID", 400)
    );
  }
});

test("credential store selection requires explicit file fallback consent", () => {
  const nativeMarker = { backend: "native-marker" };
  const fileMarker = { backend: "file-marker" };
  const paths = { secretFallbackPath: "/unused/test/secrets.json" };
  let nativeCalls = 0;
  let fileCalls = 0;
  const nativeStoreFactory = () => {
    nativeCalls += 1;
    return nativeMarker;
  };
  const fileStoreFactory = () => {
    fileCalls += 1;
    return fileMarker;
  };

  assert.equal(createCredentialStore({ paths, nativeStoreFactory, fileStoreFactory }), nativeMarker);
  assert.equal(nativeCalls, 1);
  assert.equal(fileCalls, 0);

  assert.throws(
    () => createCredentialStore({
      backend: "file",
      fallbackConsent: false,
      paths,
      nativeStoreFactory,
      fileStoreFactory
    }),
    assertCrpError("CREDENTIAL_FALLBACK_CONSENT_REQUIRED", 400)
  );
  assert.equal(fileCalls, 0);

  assert.equal(
    createCredentialStore({
      backend: "file",
      fallbackConsent: true,
      paths,
      nativeStoreFactory,
      fileStoreFactory
    }),
    fileMarker
  );
  assert.equal(nativeCalls, 1);
  assert.equal(fileCalls, 1);

  assert.throws(
    () => createCredentialStore({
      backend: "unknown",
      fallbackConsent: true,
      paths,
      nativeStoreFactory,
      fileStoreFactory
    }),
    assertCrpError("CREDENTIAL_BACKEND_INVALID", 400)
  );
  assert.equal(nativeCalls, 1);
  assert.equal(fileCalls, 1);
});

test("native factory failure is safe and falls back only with consent", () => {
  const ref = makeRef();
  const secret = makeSecret();
  const factoryFailure = new Error(`${ref}:${secret}`);
  const fileMarker = { backend: "file-marker" };
  let fileCalls = 0;
  const options = {
    paths: { secretFallbackPath: "/unused/test/secrets.json" },
    nativeStoreFactory: () => { throw factoryFailure; },
    fileStoreFactory: () => {
      fileCalls += 1;
      return fileMarker;
    }
  };

  let caught;
  try {
    createCredentialStore(options);
  } catch (error) {
    caught = error;
  }
  assertCrpError("CREDENTIAL_BACKEND_UNAVAILABLE", 500)(caught);
  assert.equal(caught.cause, factoryFailure);
  assert.equal(fileCalls, 0);
  assertSafePublicError(caught, [ref, secret, factoryFailure.message]);

  assert.equal(
    createCredentialStore({ ...options, fallbackConsent: true }),
    fileMarker
  );
  assert.equal(fileCalls, 1);
});

test("native addon loader failure is caught before any Entry construction", () => {
  const ref = makeRef();
  const secret = makeSecret();
  const loaderFailure = new Error(`${ref}:${secret}`);
  const fileMarker = { backend: "file" };
  let fileCalls = 0;
  let entryConstructions = 0;
  class NeverConstructedEntry {
    constructor() {
      entryConstructions += 1;
    }
  }
  const nativeStoreFactory = () => new NativeKeyringStore({
    entryLoader: () => {
      void NeverConstructedEntry;
      throw loaderFailure;
    }
  });
  const fileStoreFactory = () => {
    fileCalls += 1;
    return fileMarker;
  };
  const options = {
    paths: { secretFallbackPath: "/unused/test/secrets.json" },
    nativeStoreFactory,
    fileStoreFactory
  };

  let caught;
  try {
    createCredentialStore(options);
  } catch (error) {
    caught = error;
  }
  assertCrpError("CREDENTIAL_BACKEND_UNAVAILABLE", 500)(caught);
  assert.equal(caught.cause, loaderFailure);
  assert.equal(fileCalls, 0);
  assert.equal(entryConstructions, 0);
  assertSafePublicError(caught, [ref, secret, loaderFailure.message]);

  assert.equal(
    createCredentialStore({ ...options, fallbackConsent: true }),
    fileMarker
  );
  assert.equal(fileCalls, 1);
  assert.equal(entryConstructions, 0);
});

test("native operation outages never replay into file after native selection", async () => {
  const ref = makeRef();
  const secret = makeSecret();
  const backendFailure = new CrpError(
    "CREDENTIAL_BACKEND_UNAVAILABLE",
    "The credential backend is unavailable.",
    "Check the credential backend and try again.",
    { status: 500 }
  );
  const nativeCalls = { set: 0, get: 0, has: 0, delete: 0 };
  const fileCalls = { factory: 0, set: 0, get: 0, has: 0, delete: 0 };
  const nativeStore = {
    backend: "native",
    async set() { nativeCalls.set += 1; throw backendFailure; },
    async get() { nativeCalls.get += 1; throw backendFailure; },
    async has() { nativeCalls.has += 1; throw backendFailure; },
    async delete() { nativeCalls.delete += 1; throw backendFailure; }
  };
  const fileStore = {
    backend: "file",
    async set() { fileCalls.set += 1; },
    async get() { fileCalls.get += 1; },
    async has() { fileCalls.has += 1; },
    async delete() { fileCalls.delete += 1; }
  };
  const store = createCredentialStore({
    fallbackConsent: true,
    paths: { secretFallbackPath: "/unused/test/secrets.json" },
    nativeStoreFactory: () => nativeStore,
    fileStoreFactory: () => {
      fileCalls.factory += 1;
      return fileStore;
    }
  });

  assert.equal(store.backend, "native");
  for (const operation of [
    () => store.set(ref, secret),
    () => store.get(ref),
    () => store.has(ref),
    () => store.delete(ref)
  ]) {
    await assert.rejects(operation, (error) => error === backendFailure);
  }
  assert.equal(store.backend, "native");
  assert.deepEqual(nativeCalls, { set: 1, get: 1, has: 1, delete: 1 });
  assert.deepEqual(fileCalls, { factory: 0, set: 0, get: 0, has: 0, delete: 0 });
});

test("construction fallback stays explicit across restart without credential migration", async () => {
  const ref = makeRef();
  const secret = makeSecret();
  const values = new Map();
  let nativeFactoryCalls = 0;
  let fileFactoryCalls = 0;
  const fileStoreFactory = () => {
    fileFactoryCalls += 1;
    return {
      backend: "file",
      async set(key, value) { values.set(key, value); },
      async get(key) { return values.get(key); },
      async has(key) { return values.has(key); },
      async delete(key) { return values.delete(key); }
    };
  };
  const first = createCredentialStore({
    fallbackConsent: true,
    paths: { secretFallbackPath: "/unused/test/secrets.json" },
    nativeStoreFactory: () => {
      nativeFactoryCalls += 1;
      throw new Error("native unavailable before selection");
    },
    fileStoreFactory
  });
  await first.set(ref, secret);
  assert.equal(first.backend, "file");

  const restarted = createCredentialStore({
    backend: first.backend,
    fallbackConsent: true,
    paths: { secretFallbackPath: "/unused/test/secrets.json" },
    nativeStoreFactory: () => {
      nativeFactoryCalls += 1;
      return { backend: "native" };
    },
    fileStoreFactory
  });
  assert.equal(restarted.backend, "file");
  assert.equal(await restarted.get(ref), secret);
  assert.equal(nativeFactoryCalls, 1);
  assert.equal(fileFactoryCalls, 2);
});

test("consented native selection does not fall back for input or not-found errors", async () => {
  const errors = [
    new CrpError(
      "CREDENTIAL_INPUT_INVALID",
      "The credential input is invalid.",
      "Use a valid credential input.",
      { status: 400 }
    ),
    new CrpError(
      "CREDENTIAL_NOT_FOUND",
      "The credential does not exist.",
      "Save the credential and try again.",
      { status: 404 }
    )
  ];

  for (const expected of errors) {
    let fileCalls = 0;
    const store = createCredentialStore({
      fallbackConsent: true,
      paths: { secretFallbackPath: "/unused/test/secrets.json" },
      nativeStoreFactory: () => ({
        backend: "native",
        async get() { throw expected; }
      }),
      fileStoreFactory: () => {
        fileCalls += 1;
        return { backend: "file" };
      }
    });

    await assert.rejects(() => store.get(makeRef()), (error) => error === expected);
    assert.equal(store.backend, "native");
    assert.equal(fileCalls, 0);
  }
});

test("public provider projection never exposes the credential reference or secret", async (t) => {
  const { path } = makeTempCredentialPath(t, "crp-credentials-public-");
  const store = new FileCredentialStore({ path });
  const ref = makeRef();
  const secret = makeSecret();
  await store.set(ref, secret);
  const profile = normalizeProvider({
    name: "Public Test",
    baseUrl: "https://public-test.example/v1",
    credentialRef: ref
  }, {
    id: makeRef("id"),
    now: "2026-07-12T00:00:00.000Z"
  });

  const publicProfile = toPublicProvider(profile, true);
  const serialized = JSON.stringify(publicProfile);
  assert.equal(Object.hasOwn(publicProfile, "credentialRef"), false);
  assert.equal(serialized.includes(ref), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(publicProfile.credentialConfigured, true);
});
