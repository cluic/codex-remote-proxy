import { createRequire } from "node:module";

import { CrpError } from "../shared/errors.mjs";

const SERVICE = "org.cluic.codex-remote-proxy";
const FORBIDDEN_REFS = new Set(["__proto__", "constructor", "prototype"]);
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const require = createRequire(import.meta.url);

function loadEntry() {
  const { Entry } = require("@napi-rs/keyring");
  if (typeof Entry !== "function") {
    throw new TypeError("Native credential Entry is unavailable");
  }
  return Entry;
}

function credentialInputInvalid() {
  return new CrpError(
    "CREDENTIAL_INPUT_INVALID",
    "The credential input is invalid.",
    "Use a valid credential reference and a non-empty secret.",
    { status: 400 }
  );
}

function credentialNotFound() {
  return new CrpError(
    "CREDENTIAL_NOT_FOUND",
    "The credential does not exist.",
    "Save the provider credential and try again.",
    { status: 404 }
  );
}

function backendUnavailable(cause) {
  return new CrpError(
    "CREDENTIAL_BACKEND_UNAVAILABLE",
    "The credential backend is unavailable.",
    "Check the operating-system credential service and try again.",
    { status: 500, cause }
  );
}

function assertRef(ref) {
  if (
    typeof ref !== "string"
    || !REF_PATTERN.test(ref)
    || FORBIDDEN_REFS.has(ref)
  ) {
    throw credentialInputInvalid();
  }
}

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw credentialInputInvalid();
  }
}

export class NativeKeyringStore {
  constructor({ entryLoader = loadEntry, entryFactory } = {}) {
    this.backend = "native";
    if (entryFactory !== undefined) {
      if (typeof entryFactory !== "function") {
        throw backendUnavailable(new TypeError("Native entry factory is invalid"));
      }
      this.entryFactory = entryFactory;
      return;
    }
    try {
      const EntryClass = entryLoader();
      if (typeof EntryClass !== "function") {
        throw new TypeError("Native credential Entry is unavailable");
      }
      this.entryFactory = (service, ref) => new EntryClass(service, ref);
    } catch (error) {
      throw backendUnavailable(error);
    }
  }

  #entry(ref) {
    return this.entryFactory(SERVICE, ref);
  }

  async set(ref, secret) {
    assertRef(ref);
    assertSecret(secret);
    try {
      this.#entry(ref).setPassword(secret);
    } catch (error) {
      throw backendUnavailable(error);
    }
  }

  async get(ref) {
    assertRef(ref);
    let password;
    try {
      password = this.#entry(ref).getPassword();
    } catch (error) {
      throw backendUnavailable(error);
    }
    if (password === null || password === undefined || password === "") {
      throw credentialNotFound();
    }
    if (typeof password !== "string") {
      throw backendUnavailable(new TypeError("Native credential was not a string"));
    }
    return password;
  }

  async has(ref) {
    try {
      await this.get(ref);
      return true;
    } catch (error) {
      if (error instanceof CrpError && error.code === "CREDENTIAL_NOT_FOUND") {
        return false;
      }
      throw error;
    }
  }

  async delete(ref) {
    assertRef(ref);
    try {
      return this.#entry(ref).deletePassword() !== false;
    } catch (error) {
      throw backendUnavailable(error);
    }
  }
}
