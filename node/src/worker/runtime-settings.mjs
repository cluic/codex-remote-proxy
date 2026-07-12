function runtimeSettingsError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.name = "RuntimeSettingsError";
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainData(value, seen = new WeakSet()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw runtimeSettingsError("RUNTIME_SETTINGS_INVALID", "Settings must contain only finite numbers.");
    }
    return;
  }
  if (typeof value !== "object" || (!Array.isArray(value) && !isPlainObject(value))) {
    throw runtimeSettingsError("RUNTIME_SETTINGS_INVALID", "Settings must contain only plain data.");
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    assertPlainData(item, seen);
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    deepFreeze(item, seen);
  }
  return Object.freeze(value);
}

function cloneAndFreezeSettings(settings) {
  let cloned;
  try {
    cloned = structuredClone(settings);
  } catch {
    throw runtimeSettingsError("RUNTIME_SETTINGS_INVALID", "Settings could not be cloned.");
  }
  assertPlainData(cloned);
  return deepFreeze(cloned);
}

export class RuntimeSettingsSource {
  #active = null;

  apply(snapshot) {
    if (!isPlainObject(snapshot) || !Number.isSafeInteger(snapshot.generation) || snapshot.generation <= 0) {
      throw runtimeSettingsError(
        "RUNTIME_SETTINGS_INVALID",
        "Snapshot generation must be a positive safe integer."
      );
    }
    if (!isPlainObject(snapshot.settings)) {
      throw runtimeSettingsError("RUNTIME_SETTINGS_INVALID", "Snapshot settings must be an object.");
    }
    if (this.#active && snapshot.generation <= this.#active.generation) {
      throw runtimeSettingsError("STALE_SNAPSHOT", "Snapshot generation must increase.");
    }

    const next = Object.freeze({
      generation: snapshot.generation,
      settings: cloneAndFreezeSettings(snapshot.settings)
    });
    this.#active = next;
    return next;
  }

  current() {
    if (!this.#active) {
      throw runtimeSettingsError("RUNTIME_SETTINGS_UNAVAILABLE", "Runtime settings have not been configured.");
    }
    return this.#active;
  }

  publicState() {
    return Object.freeze({
      configured: this.#active !== null,
      generation: this.#active?.generation ?? 0
    });
  }
}
