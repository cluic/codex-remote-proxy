import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NativeKeyringStore } from "../src/credentials/native-keyring.mjs";

class NativeKeyringSmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeKeyringSmokeError";
    this.code = code;
  }
}

function smokeFailed() {
  return new NativeKeyringSmokeError(
    "NATIVE_KEYRING_SMOKE_FAILED",
    "Native keyring smoke failed."
  );
}

function cleanupFailed() {
  return new NativeKeyringSmokeError(
    "NATIVE_KEYRING_SMOKE_CLEANUP_FAILED",
    "Native keyring smoke cleanup failed."
  );
}

export function isNativeKeyringSmokeAuthorized(environment = process.env) {
  return environment.GITHUB_ACTIONS === "true"
    && environment.CRP_NATIVE_KEYRING_SMOKE === "1";
}

export async function runNativeKeyringSmoke({
  storeFactory = () => new NativeKeyringStore(),
  createRef = () => `crp-ci-${randomUUID()}`,
  createSecret = () => `crp-ci-secret-${randomUUID()}-${randomUUID()}`,
  writeLine = (line) => process.stdout.write(`${line}\n`)
} = {}) {
  let store;
  let ref;
  let secret;
  try {
    store = storeFactory();
    ref = createRef();
    secret = createSecret();
    if (!store || typeof ref !== "string" || ref.length === 0
      || typeof secret !== "string" || secret.length === 0) {
      throw new TypeError("Invalid smoke dependency");
    }
  } catch {
    throw smokeFailed();
  }

  let deleted = false;
  let failure = null;
  try {
    await store.set(ref, secret);
    if (await store.get(ref) !== secret) {
      throw smokeFailed();
    }
    if (await store.has(ref) !== true) {
      throw smokeFailed();
    }

    let deletion;
    try {
      deletion = await store.delete(ref);
    } catch {
      throw cleanupFailed();
    }
    if (deletion !== true) {
      throw cleanupFailed();
    }
    if (await store.has(ref) !== false) {
      throw smokeFailed();
    }
    deleted = true;
  } catch (error) {
    failure = error instanceof NativeKeyringSmokeError ? error : smokeFailed();
  } finally {
    if (!deleted) {
      try {
        await store.delete(ref);
        if (await store.has(ref) !== false) {
          throw cleanupFailed();
        }
      } catch {
        failure = cleanupFailed();
      }
    }
  }

  if (failure) {
    throw failure;
  }
  try {
    writeLine("Native keyring smoke passed.");
  } catch {
    throw smokeFailed();
  }
  return { ok: true };
}

export async function runNativeKeyringSmokeMain({
  environment = process.env,
  smokeOptions = {},
  runSmoke = runNativeKeyringSmoke,
  writeStdout = (chunk) => process.stdout.write(chunk),
  writeStderr = (chunk) => process.stderr.write(chunk)
} = {}) {
  if (!isNativeKeyringSmokeAuthorized(environment)) {
    writeStderr(
      "Native keyring smoke requires an explicitly authorized platform runner.\n"
    );
    return 2;
  }

  try {
    await runSmoke({
      ...smokeOptions,
      writeLine: (line) => writeStdout(`${line}\n`)
    });
    return 0;
  } catch (error) {
    const code = error instanceof NativeKeyringSmokeError
      ? error.code
      : "NATIVE_KEYRING_SMOKE_FAILED";
    writeStderr(`Native keyring smoke failed (${code}).\n`);
    return 1;
  }
}

const directInvocation = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (directInvocation) {
  process.exitCode = await runNativeKeyringSmokeMain();
}
