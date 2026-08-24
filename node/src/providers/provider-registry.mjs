import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CrpError } from "../shared/errors.mjs";
import {
  MAX_PROVIDER_WEIGHT,
  MIN_PROVIDER_WEIGHT,
  normalizeProvider,
  validateProviderInput,
  validateStoredProvider
} from "./provider-schema.mjs";

export const ROUTING_MODES = Object.freeze(["custom_only", "account_first"]);
export const MAX_MODEL_MAPPING_GROUPS = 50;
export const MAX_MODEL_MAPPING_RULES = 50;
export const MAX_ROUTING_RULE_GROUPS = 50;
export const MAX_ROUTING_RULES = 100;
export const MAX_ROUTING_RULE_MODELS = 100;
export const MAX_ROUTING_RULE_PROVIDERS = 100;
const ROUTING_MODE_SET = new Set(ROUTING_MODES);
const MAX_MAPPING_NAME_CODE_POINTS = 100;
const MAX_MODEL_ID_CODE_POINTS = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const MODEL_MAPPING_INPUT_FIELDS = new Set(["name", "rules"]);
const MODEL_MAPPING_GROUP_FIELDS = new Set([
  "id",
  "name",
  "rules",
  "createdAt",
  "updatedAt"
]);
const MODEL_MAPPING_RULE_FIELDS = new Set(["sourceModel", "targetModel"]);
const ROUTING_RULE_GROUP_INPUT_FIELDS = new Set(["name", "rules"]);
const ROUTING_RULE_GROUP_FIELDS = new Set([
  "id",
  "name",
  "rules",
  "createdAt",
  "updatedAt"
]);
const ROUTING_RULE_FIELDS = new Set(["models", "providerIds"]);
const FIXED_SETTINGS = Object.freeze({
  proxyHost: "127.0.0.1",
  proxyPort: 15100,
  adminHost: "127.0.0.1",
  adminPort: 15101
});
const DEFAULT_SETTINGS = Object.freeze({
  ...FIXED_SETTINGS,
  captureEnabled: false,
  routingMode: "custom_only",
  routingRuleGroupId: null
});
const DOCUMENT_FIELDS = new Set([
  "schemaVersion",
  "activeProviderId",
  "providers",
  "modelMappingGroups",
  "routingRuleGroups",
  "settings"
]);
const SETTINGS_FIELDS = new Set(Object.keys(DEFAULT_SETTINGS));
const EDITABLE_FIELDS = new Set([
  "name",
  "baseUrl",
  "authHeader",
  "authScheme",
  "extraHeaders",
  "weight",
  "modelMode",
  "modelOverride",
  "modelMappingGroupId"
]);
const IMMUTABLE_FIELDS = new Set(["id", "createdAt", "credentialRef"]);
const TEST_INVALIDATING_FIELDS = [
  "baseUrl",
  "authHeader",
  "authScheme",
  "extraHeaders",
  "modelMode",
  "modelOverride",
  "modelMappingGroupId"
];
const TEST_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const LOCK_CLEANUP_ATTEMPTS = 2;
const NO_CHANGE = Symbol("provider-registry-no-change");
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
};

function clone(value) {
  return structuredClone(value);
}

function noChange(result) {
  return { [NO_CHANGE]: true, result };
}

function emptyDocument() {
  return {
    schemaVersion: 7,
    activeProviderId: null,
    providers: [],
    modelMappingGroups: [],
    routingRuleGroups: [],
    settings: { ...DEFAULT_SETTINGS }
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function registryInvalid(cause) {
  return new CrpError(
    "PROVIDER_REGISTRY_INVALID",
    "The provider registry is invalid.",
    "Restore a valid provider registry or remove it after making a backup.",
    { status: 500, cause }
  );
}

function inputError(code, message, action, status = 400) {
  return new CrpError(code, message, action, { status });
}

function normalizedName(name) {
  return name.toLowerCase();
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function normalizeMappingText(value, maximumCodePoints) {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || [...value].length > maximumCodePoints
    || Buffer.byteLength(value, "utf8") > maximumCodePoints * 2
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw inputError(
      "MODEL_MAPPING_INPUT_INVALID",
      "Model mapping settings are invalid.",
      "Review the mapping group and try again.",
      400
    );
  }
  return value;
}

function normalizeRoutingText(value, maximumCodePoints) {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || [...value].length > maximumCodePoints
    || Buffer.byteLength(value, "utf8") > maximumCodePoints * 2
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw inputError(
      "ROUTING_RULE_INPUT_INVALID",
      "Routing rule group settings are invalid.",
      "Review the routing rule group and try again.",
      400
    );
  }
  return value;
}

function normalizeMappingRules(value) {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > MAX_MODEL_MAPPING_RULES) {
    throw inputError(
      "MODEL_MAPPING_INPUT_INVALID",
      "Model mapping settings are invalid.",
      `Add between 1 and ${MAX_MODEL_MAPPING_RULES} exact model rules.`,
      400
    );
  }
  const sources = new Set();
  return value.map((rule) => {
    if (!validateExactFields(rule, MODEL_MAPPING_RULE_FIELDS)) {
      throw inputError(
        "MODEL_MAPPING_INPUT_INVALID",
        "Model mapping settings are invalid.",
        "Each rule must contain one source model and one target model.",
        400
      );
    }
    const sourceModel = normalizeMappingText(
      rule.sourceModel,
      MAX_MODEL_ID_CODE_POINTS
    );
    const targetModel = normalizeMappingText(
      rule.targetModel,
      MAX_MODEL_ID_CODE_POINTS
    );
    if (sources.has(sourceModel)) {
      throw inputError(
        "MODEL_MAPPING_INPUT_INVALID",
        "Model mapping settings are invalid.",
        "Use each source model only once per mapping group.",
        400
      );
    }
    sources.add(sourceModel);
    return { sourceModel, targetModel };
  });
}

function normalizeMappingInput(input) {
  if (!validateExactFields(input, MODEL_MAPPING_INPUT_FIELDS)) {
    throw inputError(
      "MODEL_MAPPING_INPUT_INVALID",
      "Model mapping settings are invalid.",
      "Submit only a group name and exact model rules.",
      400
    );
  }
  return {
    name: normalizeMappingText(input.name, MAX_MAPPING_NAME_CODE_POINTS),
    rules: normalizeMappingRules(input.rules)
  };
}

function normalizeMappingGroup(input, { id, now, createdAt = now }) {
  const normalized = normalizeMappingInput(input);
  const groupId = normalizeMappingText(id, 128);
  if (/[\\/]/.test(groupId) || !isIsoTimestamp(now) || !isIsoTimestamp(createdAt)) {
    throw inputError(
      "MODEL_MAPPING_INPUT_INVALID",
      "Model mapping settings are invalid.",
      "Retry the mapping group operation.",
      400
    );
  }
  return { id: groupId, ...normalized, createdAt, updatedAt: now };
}

function validateStoredMappingGroup(group) {
  if (!validateExactFields(group, MODEL_MAPPING_GROUP_FIELDS)
    || !isIsoTimestamp(group.createdAt)
    || !isIsoTimestamp(group.updatedAt)
    || group.updatedAt < group.createdAt) {
    throw new Error("invalid model mapping group");
  }
  const normalized = normalizeMappingGroup({ name: group.name, rules: group.rules }, {
    id: group.id,
    now: group.updatedAt,
    createdAt: group.createdAt
  });
  if (!isDeepStrictEqual(normalized, group)) {
    throw new Error("model mapping group is not normalized");
  }
  return true;
}

function normalizeRoutingRules(value) {
  if (!Array.isArray(value) || value.length > MAX_ROUTING_RULES) {
    throw inputError(
      "ROUTING_RULE_INPUT_INVALID",
      "Routing rule group settings are invalid.",
      `Keep at most ${MAX_ROUTING_RULES} exact model rules.`,
      400
    );
  }
  const assignedModels = new Set();
  return value.map((rule) => {
    if (!validateExactFields(rule, ROUTING_RULE_FIELDS)
      || !Array.isArray(rule.models)
      || rule.models.length < 1
      || rule.models.length > MAX_ROUTING_RULE_MODELS
      || !Array.isArray(rule.providerIds)
      || rule.providerIds.length < 1
      || rule.providerIds.length > MAX_ROUTING_RULE_PROVIDERS) {
      throw inputError(
        "ROUTING_RULE_INPUT_INVALID",
        "Routing rule group settings are invalid.",
        "Each rule must contain one or more models and at least one provider.",
        400
      );
    }
    const models = rule.models.map((model) => {
      const normalized = normalizeRoutingText(model, MAX_MODEL_ID_CODE_POINTS);
      if (assignedModels.has(normalized)) {
        throw inputError(
          "ROUTING_RULE_INPUT_INVALID",
          "Routing rule group settings are invalid.",
          "Assign each model to only one rule in the routing rule group.",
          400
        );
      }
      assignedModels.add(normalized);
      if (assignedModels.size > MAX_ROUTING_RULE_MODELS) {
        throw inputError(
          "ROUTING_RULE_INPUT_INVALID",
          "Routing rule group settings are invalid.",
          `Keep at most ${MAX_ROUTING_RULE_MODELS} model assignments per group.`,
          400
        );
      }
      return normalized;
    });
    const providerIds = rule.providerIds.map((providerId) => {
      const normalized = normalizeRoutingText(providerId, 128);
      if (/[\\/]/.test(normalized)) {
        throw inputError(
          "ROUTING_RULE_INPUT_INVALID",
          "Routing rule group settings are invalid.",
          "Provider identities must be normalized.",
          400
        );
      }
      return normalized;
    });
    if (new Set(providerIds).size !== providerIds.length) {
      throw inputError(
        "ROUTING_RULE_INPUT_INVALID",
        "Routing rule group settings are invalid.",
        "Use each provider only once per model rule.",
        400
      );
    }
    return { models, providerIds };
  });
}

function normalizeRoutingRuleInput(input) {
  if (!validateExactFields(input, ROUTING_RULE_GROUP_INPUT_FIELDS)) {
    throw inputError(
      "ROUTING_RULE_INPUT_INVALID",
      "Routing rule group settings are invalid.",
      "Submit only a group name and exact model rules.",
      400
    );
  }
  return {
    name: normalizeRoutingText(input.name, MAX_MAPPING_NAME_CODE_POINTS),
    rules: normalizeRoutingRules(input.rules)
  };
}

function normalizeRoutingRuleGroup(input, { id, now, createdAt = now }) {
  const normalized = normalizeRoutingRuleInput(input);
  const groupId = normalizeRoutingText(id, 128);
  if (/[\\/]/.test(groupId) || !isIsoTimestamp(now) || !isIsoTimestamp(createdAt)) {
    throw inputError(
      "ROUTING_RULE_INPUT_INVALID",
      "Routing rule group settings are invalid.",
      "Retry the routing rule group operation.",
      400
    );
  }
  return { id: groupId, ...normalized, createdAt, updatedAt: now };
}

function validateStoredRoutingRuleGroup(group) {
  if (!validateExactFields(group, ROUTING_RULE_GROUP_FIELDS)
    || !isIsoTimestamp(group.createdAt)
    || !isIsoTimestamp(group.updatedAt)
    || group.updatedAt < group.createdAt) {
    throw new Error("invalid routing rule group");
  }
  const normalized = normalizeRoutingRuleGroup({ name: group.name, rules: group.rules }, {
    id: group.id,
    now: group.updatedAt,
    createdAt: group.createdAt
  });
  if (!isDeepStrictEqual(normalized, group)) {
    throw new Error("routing rule group is not normalized");
  }
  return true;
}

function validateExactFields(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

export function validateProviderRegistryDocument(document) {
  try {
    if (!validateExactFields(document, DOCUMENT_FIELDS)) {
      throw new Error("invalid document fields");
    }
    if (document.schemaVersion !== 7) {
      throw new Error("unsupported schema version");
    }
    if (!Array.isArray(document.providers)) {
      throw new Error("providers must be an array");
    }
    if (!Array.isArray(document.modelMappingGroups)
      || document.modelMappingGroups.length > MAX_MODEL_MAPPING_GROUPS) {
      throw new Error("model mapping groups must be a bounded array");
    }
    if (!Array.isArray(document.routingRuleGroups)
      || document.routingRuleGroups.length > MAX_ROUTING_RULE_GROUPS) {
      throw new Error("routing rule groups must be a bounded array");
    }
    if (!validateExactFields(document.settings, SETTINGS_FIELDS)) {
      throw new Error("invalid settings fields");
    }
    for (const [key, value] of Object.entries(FIXED_SETTINGS)) {
      if (document.settings[key] !== value) {
        throw new Error("fixed settings changed");
      }
    }
    if (!ROUTING_MODE_SET.has(document.settings.routingMode)) {
      throw new Error("invalid routing mode");
    }
    if (document.settings.routingRuleGroupId !== null
      && typeof document.settings.routingRuleGroupId !== "string") {
      throw new Error("invalid active routing rule group id");
    }
    if (typeof document.settings.captureEnabled !== "boolean") {
      throw new Error("invalid Capture setting");
    }
    if (document.activeProviderId !== null && typeof document.activeProviderId !== "string") {
      throw new Error("invalid active provider id");
    }

    const mappingIds = new Set();
    const mappingNames = new Set();
    for (const group of document.modelMappingGroups) {
      validateStoredMappingGroup(group);
      if (mappingIds.has(group.id)) throw new Error("duplicate model mapping group id");
      const nameKey = normalizedName(group.name);
      if (mappingNames.has(nameKey)) throw new Error("duplicate model mapping group name");
      mappingIds.add(group.id);
      mappingNames.add(nameKey);
    }

    const ids = new Set();
    const names = new Set();
    for (const profile of document.providers) {
      validateStoredProvider(profile);
      if (ids.has(profile.id)) {
        throw new Error("duplicate provider id");
      }
      const nameKey = normalizedName(profile.name);
      if (names.has(nameKey)) {
        throw new Error("duplicate provider name");
      }
      ids.add(profile.id);
      names.add(nameKey);
      if (profile.modelMappingGroupId !== null
        && !mappingIds.has(profile.modelMappingGroupId)) {
        throw new Error("provider model mapping group does not exist");
      }
    }
    if (document.activeProviderId !== null && !ids.has(document.activeProviderId)) {
      throw new Error("active provider does not exist");
    }

    const routingGroupIds = new Set();
    const routingGroupNames = new Set();
    for (const group of document.routingRuleGroups) {
      validateStoredRoutingRuleGroup(group);
      if (routingGroupIds.has(group.id)) throw new Error("duplicate routing rule group id");
      const nameKey = normalizedName(group.name);
      if (routingGroupNames.has(nameKey)) {
        throw new Error("duplicate routing rule group name");
      }
      for (const rule of group.rules) {
        if (rule.providerIds.some((providerId) => !ids.has(providerId))) {
          throw new Error("routing rule references a missing provider");
        }
      }
      routingGroupIds.add(group.id);
      routingGroupNames.add(nameKey);
    }
    if (document.settings.routingRuleGroupId !== null
      && !routingGroupIds.has(document.settings.routingRuleGroupId)) {
      throw new Error("active routing rule group does not exist");
    }
    return true;
  } catch (error) {
    if (error instanceof CrpError && error.code === "PROVIDER_REGISTRY_INVALID") {
      throw error;
    }
    throw registryInvalid(error);
  }
}

function parseDocument(bytes) {
  let document;
  try {
    document = JSON.parse(bytes);
  } catch (error) {
    throw registryInvalid(error);
  }
  validateProviderRegistryDocument(document);
  return document;
}

function providerNotFound() {
  return inputError(
    "PROVIDER_NOT_FOUND",
    "The provider does not exist.",
    "Refresh the provider list and try again.",
    404
  );
}

function modelMappingNotFound() {
  return inputError(
    "MODEL_MAPPING_NOT_FOUND",
    "The model mapping group does not exist.",
    "Refresh model mappings and try again.",
    404
  );
}

function routingRuleGroupNotFound() {
  return inputError(
    "ROUTING_RULE_GROUP_NOT_FOUND",
    "The routing rule group does not exist.",
    "Refresh routing rules and try again.",
    404
  );
}

function registryBusy(cause) {
  return new CrpError(
    "PROVIDER_REGISTRY_BUSY",
    "The provider registry is already being updated.",
    "Wait for the current registry update to finish and try again.",
    { status: 409, cause }
  );
}

function committedLockDegraded() {
  return new CrpError(
    "PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED",
    "The provider change was saved, but its registry lock could not be fully released.",
    "Stop CRP, explicitly repair the residual registry lock, then restart CRP.",
    { status: 500, details: { committed: true } }
  );
}

function registryLockDegraded() {
  return new CrpError(
    "PROVIDER_REGISTRY_LOCK_DEGRADED",
    "The provider registry lock could not be safely recovered.",
    "Stop CRP, explicitly repair the residual registry lock, then restart CRP.",
    { status: 500, details: { committed: false } }
  );
}

function assertPatch(patch) {
  if (!isPlainObject(patch)) {
    throw inputError(
      "PROVIDER_INPUT_INVALID",
      "Provider settings are invalid.",
      "Submit a provider settings object and try again."
    );
  }
  for (const key of Object.keys(patch)) {
    if (IMMUTABLE_FIELDS.has(key)) {
      throw inputError(
        "PROVIDER_IMMUTABLE_FIELD",
        "An immutable provider field cannot be changed.",
        "Create a new provider when its identity or credential reference must change."
      );
    }
    if (!EDITABLE_FIELDS.has(key)) {
      throw inputError(
        "PROVIDER_INPUT_INVALID",
        "Provider settings are invalid.",
        "Remove system-managed fields and try again."
      );
    }
    if (patch[key] === undefined) {
      throw inputError(
        "PROVIDER_INPUT_INVALID",
        "Provider settings are invalid.",
        "Provide an explicit value for every updated field."
      );
    }
  }
}

export class ProviderRegistry {
  constructor({
    path,
    createId = randomUUID,
    now = () => new Date().toISOString(),
    fileOperations
  }) {
    this.path = path;
    this.lockPath = `${path}.crp.lock`;
    this.createId = createId;
    this.now = now;
    this.fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...fileOperations };
    this.degradedLock = null;
    this.document = this.#load();
  }

  #load() {
    if (!this.fileOperations.existsSync(this.path)) {
      return emptyDocument();
    }
    let bytes;
    try {
      bytes = this.fileOperations.readFileSync(this.path, "utf8");
    } catch (error) {
      throw new CrpError(
        "PROVIDER_REGISTRY_READ_FAILED",
        "The provider registry could not be read.",
        "Check the registry file permissions and try again.",
        { status: 500, cause: error }
      );
    }
    return parseDocument(bytes);
  }

  #findIndex(document, id) {
    return document.providers.findIndex((profile) => profile.id === id);
  }

  #findMappingIndex(document, id) {
    return document.modelMappingGroups.findIndex((group) => group.id === id);
  }

  #findRoutingRuleGroupIndex(document, id) {
    return document.routingRuleGroups.findIndex((group) => group.id === id);
  }

  #refresh() {
    const document = this.#load();
    this.document = document;
    return document;
  }

  #acquireLock() {
    this.fileOperations.mkdirSync(dirname(this.path), { recursive: true });
    if (this.degradedLock !== null) {
      throw registryLockDegraded();
    }

    let fileDescriptor;
    const token = `${randomUUID()}\n`;
    try {
      fileDescriptor = this.fileOperations.openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw registryBusy(error);
      }
      throw error;
    }

    const lock = { fileDescriptor, token };
    try {
      this.fileOperations.writeFileSync(fileDescriptor, token, "utf8");
      return lock;
    } catch (error) {
      const cleanup = this.#releaseLock(lock);
      if (cleanup.residualLock) {
        this.degradedLock = { token };
      }
      throw error;
    }
  }

  #closeLock(fileDescriptor) {
    let error = null;
    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        this.fileOperations.closeSync(fileDescriptor);
        return { closed: true, error: null };
      } catch (caught) {
        if (attempt > 0 && caught?.code === "EBADF") {
          return { closed: true, error: null };
        }
        error = caught;
      }
    }
    return { closed: false, error };
  }

  #removeOwnedLock(token) {
    let error = null;
    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      let currentToken;
      try {
        currentToken = this.fileOperations.readFileSync(this.lockPath, "utf8");
      } catch (caught) {
        if (caught?.code === "ENOENT") {
          return { removed: true, residualLock: false, foreign: false, error: null };
        }
        error = caught;
        continue;
      }
      if (currentToken !== token) {
        return { removed: false, residualLock: true, foreign: true, error: null };
      }
      try {
        this.fileOperations.rmSync(this.lockPath, { force: true });
        return { removed: true, residualLock: false, foreign: false, error: null };
      } catch (caught) {
        error = caught;
      }
    }
    return {
      removed: false,
      residualLock: this.fileOperations.existsSync(this.lockPath),
      foreign: false,
      error
    };
  }

  #releaseLock(lock) {
    const close = this.#closeLock(lock.fileDescriptor);
    const removal = this.#removeOwnedLock(lock.token);
    return {
      ok: close.closed && removal.removed,
      closeError: close.error,
      removalError: removal.error,
      residualLock: removal.residualLock,
      foreignLock: removal.foreign
    };
  }

  #recordCleanupState(lock, cleanup) {
    if (cleanup.residualLock) {
      this.degradedLock = { token: lock.token };
    } else {
      this.degradedLock = null;
    }
  }

  #getIndex(document, id) {
    const index = this.#findIndex(document, id);
    if (index === -1) {
      throw providerNotFound();
    }
    return index;
  }

  #getMappingIndex(document, id) {
    const index = this.#findMappingIndex(document, id);
    if (index === -1) throw modelMappingNotFound();
    return index;
  }

  #getRoutingRuleGroupIndex(document, id) {
    const index = this.#findRoutingRuleGroupIndex(document, id);
    if (index === -1) throw routingRuleGroupNotFound();
    return index;
  }

  #assertMappingGroupExists(document, id) {
    if (id !== null && this.#findMappingIndex(document, id) === -1) {
      throw modelMappingNotFound();
    }
  }

  #assertUniqueName(document, name, excludedId = null) {
    const nameKey = normalizedName(name);
    if (document.providers.some((profile) => (
      profile.id !== excludedId && normalizedName(profile.name) === nameKey
    ))) {
      throw inputError(
        "PROVIDER_NAME_CONFLICT",
        "A provider with this name already exists.",
        "Choose a different provider name.",
        409
      );
    }
  }

  #assertUniqueMappingName(document, name, excludedId = null) {
    const nameKey = normalizedName(name);
    if (document.modelMappingGroups.some((group) => (
      group.id !== excludedId && normalizedName(group.name) === nameKey
    ))) {
      throw inputError(
        "MODEL_MAPPING_NAME_CONFLICT",
        "A model mapping group with this name already exists.",
        "Choose a different mapping group name.",
        409
      );
    }
  }

  #assertUniqueRoutingRuleGroupName(document, name, excludedId = null) {
    const nameKey = normalizedName(name);
    if (document.routingRuleGroups.some((group) => (
      group.id !== excludedId && normalizedName(group.name) === nameKey
    ))) {
      throw inputError(
        "ROUTING_RULE_GROUP_NAME_CONFLICT",
        "A routing rule group with this name already exists.",
        "Choose a different routing rule group name.",
        409
      );
    }
  }

  #assertRoutingRuleProvidersExist(document, rules) {
    const providerIds = new Set(document.providers.map((provider) => provider.id));
    if (rules.some((rule) => rule.providerIds.some((providerId) => !providerIds.has(providerId)))) {
      throw inputError(
        "ROUTING_RULE_PROVIDER_NOT_FOUND",
        "A routing rule references a provider that does not exist.",
        "Refresh providers and update the routing rule group.",
        409
      );
    }
  }

  #pruneProviderFromRoutingRules(document, providerId, timestamp) {
    document.routingRuleGroups = document.routingRuleGroups.map((group) => {
      const rules = group.rules.map((rule) => ({
        ...rule,
        providerIds: rule.providerIds.filter((candidateId) => candidateId !== providerId)
      })).filter((rule) => rule.providerIds.length > 0);
      return isDeepStrictEqual(rules, group.rules)
        ? group
        : { ...group, rules, updatedAt: timestamp };
    });
  }

  #persist(document) {
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    const parent = dirname(this.path);
    const tempPath = join(
      parent,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`
    );
    let fileDescriptor;

    this.fileOperations.mkdirSync(parent, { recursive: true });
    try {
      fileDescriptor = this.fileOperations.openSync(tempPath, "wx", 0o600);
      this.fileOperations.writeFileSync(fileDescriptor, bytes, "utf8");
      this.fileOperations.fsyncSync(fileDescriptor);
      this.fileOperations.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      this.fileOperations.chmodSync(tempPath, 0o600);
      this.fileOperations.renameSync(tempPath, this.path);
    } catch (error) {
      if (fileDescriptor !== undefined) {
        try {
          this.fileOperations.closeSync(fileDescriptor);
        } catch {
          // Preserve the original persistence error.
        }
      }
      try {
        this.fileOperations.rmSync(tempPath, { force: true });
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
  }

  #commit(mutator) {
    let lock;
    let result;
    let primaryError;
    let committed = false;
    try {
      lock = this.#acquireLock();
      const candidate = clone(this.#load());
      const mutationResult = mutator(candidate);
      const changed = mutationResult?.[NO_CHANGE] !== true;
      validateProviderRegistryDocument(candidate);
      result = clone(changed ? mutationResult : mutationResult.result);
      if (changed) this.#persist(candidate);
      this.document = candidate;
      committed = changed;
    } catch (error) {
      primaryError = error;
    }

    let cleanup = { ok: true, residualLock: false };
    if (lock !== undefined) {
      cleanup = this.#releaseLock(lock);
      this.#recordCleanupState(lock, cleanup);
    }

    if (primaryError !== undefined) {
      throw primaryError;
    }
    if (!cleanup.ok) {
      if (committed) {
        throw committedLockDegraded();
      }
      throw registryLockDegraded();
    }
    return result;
  }

  list() {
    return clone(this.#refresh().providers);
  }

  get(id) {
    const document = this.#refresh();
    const index = this.#getIndex(document, id);
    return clone(document.providers[index]);
  }

  create(input) {
    validateProviderInput(input);
    const id = this.createId();
    const profile = normalizeProvider(input, { id, now: this.now() });
    return this.#commit((document) => {
      if (this.#findIndex(document, profile.id) !== -1) {
        throw inputError(
          "PROVIDER_ID_CONFLICT",
          "A provider identity conflict occurred.",
          "Retry creating the provider.",
          409
        );
      }
      this.#assertUniqueName(document, profile.name);
      this.#assertMappingGroupExists(document, profile.modelMappingGroupId);
      document.providers.push(profile);
      return profile;
    });
  }

  update(id, patch, { preserveTestStatus = false } = {}) {
    if (typeof preserveTestStatus !== "boolean") {
      throw inputError(
        "PROVIDER_INPUT_INVALID",
        "Provider settings are invalid.",
        "Retry the provider update."
      );
    }
    assertPatch(patch);
    const timestamp = this.now();

    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      const current = document.providers[index];
      const normalized = normalizeProvider({
        name: current.name,
        baseUrl: current.baseUrl,
        credentialRef: current.credentialRef,
        authHeader: current.authHeader,
        authScheme: current.authScheme,
        extraHeaders: current.extraHeaders,
        weight: current.weight,
        modelMode: current.modelMode,
        modelOverride: current.modelOverride,
        modelMappingGroupId: current.modelMappingGroupId,
        supportedModelsMode: current.supportedModelsMode,
        supportedModels: current.supportedModels,
        modelsPath: current.modelsPath,
        customModels: current.customModels,
        ...patch
      }, { id: current.id, now: timestamp });
      this.#assertUniqueName(document, normalized.name, id);
      this.#assertMappingGroupExists(document, normalized.modelMappingGroupId);
      const invalidatesTest = !preserveTestStatus && TEST_INVALIDATING_FIELDS.some((field) => (
        !isDeepStrictEqual(current[field], normalized[field])
      ));
      const updated = {
        ...normalized,
        credentialRef: current.credentialRef,
        lastTestAt: invalidatesTest ? null : current.lastTestAt,
        lastTestStatus: invalidatesTest ? "untested" : current.lastTestStatus,
        lastTestCode: invalidatesTest ? null : current.lastTestCode,
        createdAt: current.createdAt,
        updatedAt: timestamp
      };
      document.providers[index] = updated;
      return updated;
    });
  }

  listModelMappingGroups() {
    return clone(this.#refresh().modelMappingGroups);
  }

  getModelMappingGroup(id) {
    const document = this.#refresh();
    return clone(document.modelMappingGroups[this.#getMappingIndex(document, id)]);
  }

  createModelMappingGroup(input) {
    const id = this.createId();
    const timestamp = this.now();
    const group = normalizeMappingGroup(input, { id, now: timestamp });
    return this.#commit((document) => {
      if (document.modelMappingGroups.length >= MAX_MODEL_MAPPING_GROUPS) {
        throw inputError(
          "MODEL_MAPPING_LIMIT_REACHED",
          "The model mapping group limit was reached.",
          `Keep at most ${MAX_MODEL_MAPPING_GROUPS} mapping groups.`,
          409
        );
      }
      if (this.#findMappingIndex(document, group.id) !== -1) {
        throw inputError(
          "MODEL_MAPPING_ID_CONFLICT",
          "A model mapping identity conflict occurred.",
          "Retry creating the mapping group.",
          409
        );
      }
      this.#assertUniqueMappingName(document, group.name);
      document.modelMappingGroups.push(group);
      return group;
    });
  }

  updateModelMappingGroup(id, input) {
    const normalized = normalizeMappingInput(input);
    const timestamp = this.now();
    return this.#commit((document) => {
      const index = this.#getMappingIndex(document, id);
      const current = document.modelMappingGroups[index];
      this.#assertUniqueMappingName(document, normalized.name, id);
      const updated = normalizeMappingGroup(normalized, {
        id: current.id,
        now: timestamp,
        createdAt: current.createdAt
      });
      document.modelMappingGroups[index] = updated;
      return updated;
    });
  }

  deleteModelMappingGroup(id) {
    return this.#commit((document) => {
      const index = this.#getMappingIndex(document, id);
      if (document.providers.some((provider) => provider.modelMappingGroupId === id)) {
        throw inputError(
          "MODEL_MAPPING_IN_USE",
          "The model mapping group is still assigned to a provider.",
          "Remove the mapping group from every provider before deleting it.",
          409
        );
      }
      const [deleted] = document.modelMappingGroups.splice(index, 1);
      return deleted;
    });
  }

  listRoutingRuleGroups() {
    return clone(this.#refresh().routingRuleGroups);
  }

  getRoutingRuleGroup(id) {
    const document = this.#refresh();
    return clone(document.routingRuleGroups[this.#getRoutingRuleGroupIndex(document, id)]);
  }

  createRoutingRuleGroup(input) {
    const id = this.createId();
    const timestamp = this.now();
    const group = normalizeRoutingRuleGroup(input, { id, now: timestamp });
    return this.#commit((document) => {
      if (document.routingRuleGroups.length >= MAX_ROUTING_RULE_GROUPS) {
        throw inputError(
          "ROUTING_RULE_GROUP_LIMIT_REACHED",
          "The routing rule group limit was reached.",
          `Keep at most ${MAX_ROUTING_RULE_GROUPS} routing rule groups.`,
          409
        );
      }
      if (this.#findRoutingRuleGroupIndex(document, group.id) !== -1) {
        throw inputError(
          "ROUTING_RULE_GROUP_ID_CONFLICT",
          "A routing rule group identity conflict occurred.",
          "Retry creating the routing rule group.",
          409
        );
      }
      this.#assertUniqueRoutingRuleGroupName(document, group.name);
      this.#assertRoutingRuleProvidersExist(document, group.rules);
      document.routingRuleGroups.push(group);
      return group;
    });
  }

  updateRoutingRuleGroup(id, input) {
    const normalized = normalizeRoutingRuleInput(input);
    const timestamp = this.now();
    return this.#commit((document) => {
      const index = this.#getRoutingRuleGroupIndex(document, id);
      const current = document.routingRuleGroups[index];
      this.#assertUniqueRoutingRuleGroupName(document, normalized.name, id);
      this.#assertRoutingRuleProvidersExist(document, normalized.rules);
      const updated = normalizeRoutingRuleGroup(normalized, {
        id: current.id,
        now: timestamp,
        createdAt: current.createdAt
      });
      document.routingRuleGroups[index] = updated;
      return updated;
    });
  }

  deleteRoutingRuleGroup(id) {
    return this.#commit((document) => {
      const index = this.#getRoutingRuleGroupIndex(document, id);
      const [deleted] = document.routingRuleGroups.splice(index, 1);
      if (document.settings.routingRuleGroupId === id) {
        document.settings.routingRuleGroupId = null;
      }
      return deleted;
    });
  }

  setRoutingRuleGroup(id) {
    if (id === null) {
      return this.#commit((document) => {
        if (document.settings.routingRuleGroupId === null) return noChange(null);
        document.settings.routingRuleGroupId = null;
        return null;
      });
    }
    return this.#commit((document) => {
      this.#getRoutingRuleGroupIndex(document, id);
      if (document.settings.routingRuleGroupId === id) return noChange(id);
      document.settings.routingRuleGroupId = id;
      return id;
    });
  }

  setProviderSupportedModels(id, { mode, models, modelsPath, customModels }) {
    const timestamp = this.now();
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      const current = document.providers[index];
      const normalized = normalizeProvider({
        name: current.name,
        baseUrl: current.baseUrl,
        credentialRef: current.credentialRef,
        authHeader: current.authHeader,
        authScheme: current.authScheme,
        extraHeaders: current.extraHeaders,
        weight: current.weight,
        modelMode: current.modelMode,
        modelOverride: current.modelOverride,
        modelMappingGroupId: current.modelMappingGroupId,
        supportedModelsMode: mode,
        supportedModels: models,
        modelsPath: modelsPath ?? current.modelsPath,
        customModels: customModels ?? current.customModels
      }, { id: current.id, now: timestamp });
      if (normalized.supportedModelsMode === current.supportedModelsMode
        && isDeepStrictEqual(normalized.supportedModels, current.supportedModels)
        && normalized.modelsPath === current.modelsPath
        && isDeepStrictEqual(normalized.customModels, current.customModels)) {
        return noChange(current);
      }
      const updated = {
        ...current,
        supportedModelsMode: normalized.supportedModelsMode,
        supportedModels: normalized.supportedModels,
        modelsPath: normalized.modelsPath,
        customModels: normalized.customModels,
        updatedAt: timestamp
      };
      document.providers[index] = updated;
      return updated;
    });
  }

  setProviderWeightIfCurrent(id, expectedWeight, weight) {
    if (!Number.isInteger(expectedWeight)
      || expectedWeight < MIN_PROVIDER_WEIGHT
      || expectedWeight > MAX_PROVIDER_WEIGHT
      || !Number.isInteger(weight)
      || weight < MIN_PROVIDER_WEIGHT
      || weight > MAX_PROVIDER_WEIGHT) {
      throw inputError(
        "PROVIDER_INPUT_INVALID",
        "The provider weight is invalid.",
        `Choose an integer from ${MIN_PROVIDER_WEIGHT} to ${MAX_PROVIDER_WEIGHT}.`
      );
    }
    const timestamp = this.now();
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      const current = document.providers[index];
      if (current.weight !== expectedWeight) return noChange(false);
      if (expectedWeight === weight) return noChange(true);
      document.providers[index] = { ...current, weight, updatedAt: timestamp };
      return true;
    });
  }

  delete(id) {
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      if (document.activeProviderId === id) {
        throw inputError(
          "PROVIDER_ACTIVE",
          "The active provider cannot be deleted.",
          "Refresh provider state and try the deletion again.",
          409
        );
      }
      const [deleted] = document.providers.splice(index, 1);
      this.#pruneProviderFromRoutingRules(document, id, this.now());
      return deleted;
    });
  }

  deleteWithActiveFallback(id, fallbackId) {
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      if (document.activeProviderId !== id) {
        throw inputError(
          "PROVIDER_ACTIVE_CHANGED",
          "The active provider changed before deletion.",
          "Refresh providers and try again.",
          409
        );
      }
      if (fallbackId === id) {
        throw inputError(
          "PROVIDER_FALLBACK_INVALID",
          "The replacement provider is invalid.",
          "Choose a different available provider.",
          409
        );
      }
      if (fallbackId !== null) this.#getIndex(document, fallbackId);
      const [deleted] = document.providers.splice(index, 1);
      document.activeProviderId = fallbackId;
      this.#pruneProviderFromRoutingRules(document, id, this.now());
      return deleted;
    });
  }

  markTest(id, { status, code = null } = {}) {
    if (status !== "untested" && status !== "passed" && status !== "failed") {
      throw inputError(
        "PROVIDER_TEST_RESULT_INVALID",
        "The provider test result is invalid.",
        "Record an untested, passed, or failed compatibility test result."
      );
    }
    if (status === "untested" && code !== null) {
      throw inputError(
        "PROVIDER_TEST_RESULT_INVALID",
        "The provider test result is invalid.",
        "Do not include an error code when resetting the test result."
      );
    }
    if (status === "passed" && code !== null) {
      throw inputError(
        "PROVIDER_TEST_RESULT_INVALID",
        "The provider test result is invalid.",
        "Do not include an error code for a passed test."
      );
    }
    if (status === "failed" && (
      typeof code !== "string" || !TEST_CODE_PATTERN.test(code)
    )) {
      throw inputError(
        "PROVIDER_TEST_RESULT_INVALID",
        "The provider test result is invalid.",
        "Record a stable error code for a failed test."
      );
    }
    const timestamp = this.now();
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      const updated = {
        ...document.providers[index],
        lastTestAt: status === "untested" ? null : timestamp,
        lastTestStatus: status,
        lastTestCode: status === "untested" ? null : code,
        updatedAt: timestamp
      };
      document.providers[index] = updated;
      return updated;
    });
  }

  setActive(id) {
    if (id === null) {
      return this.#commit((document) => {
        document.activeProviderId = null;
        return null;
      });
    }
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      document.activeProviderId = id;
      return document.providers[index];
    });
  }

  setActiveIfNull(id) {
    return this.#commit((document) => {
      this.#getIndex(document, id);
      if (document.activeProviderId !== null) return noChange(false);
      document.activeProviderId = id;
      return true;
    });
  }

  clearActiveIf(id) {
    return this.#commit((document) => {
      this.#getIndex(document, id);
      if (document.activeProviderId !== id) return noChange(false);
      document.activeProviderId = null;
      return true;
    });
  }

  setRoutingMode(mode) {
    if (!ROUTING_MODE_SET.has(mode)) {
      throw inputError(
        "ROUTING_MODE_INVALID",
        "The routing mode is invalid.",
        "Choose custom_only or account_first."
      );
    }
    return this.#commit((document) => {
      if (document.settings.routingMode === mode) return noChange(mode);
      document.settings.routingMode = mode;
      return mode;
    });
  }

  setRoutingModeIfCurrent(expectedMode, mode) {
    if (!ROUTING_MODE_SET.has(expectedMode) || !ROUTING_MODE_SET.has(mode)) {
      throw inputError(
        "ROUTING_MODE_INVALID",
        "The routing mode is invalid.",
        "Choose custom_only or account_first."
      );
    }
    return this.#commit((document) => {
      if (document.settings.routingMode !== expectedMode) return noChange(false);
      if (expectedMode === mode) return noChange(true);
      document.settings.routingMode = mode;
      return true;
    });
  }

  setCaptureEnabled(enabled) {
    if (typeof enabled !== "boolean") {
      throw inputError(
        "CAPTURE_SETTING_INVALID",
        "The Capture setting is invalid.",
        "Choose whether forwarding metadata should be recorded."
      );
    }
    return this.#commit((document) => {
      if (document.settings.captureEnabled === enabled) return noChange(enabled);
      document.settings.captureEnabled = enabled;
      return enabled;
    });
  }

  setCaptureEnabledIfCurrent(expectedEnabled, enabled) {
    if (typeof expectedEnabled !== "boolean" || typeof enabled !== "boolean") {
      throw inputError(
        "CAPTURE_SETTING_INVALID",
        "The Capture setting is invalid.",
        "Choose whether forwarding metadata should be recorded."
      );
    }
    return this.#commit((document) => {
      if (document.settings.captureEnabled !== expectedEnabled) return noChange(false);
      if (expectedEnabled === enabled) return noChange(true);
      document.settings.captureEnabled = enabled;
      return true;
    });
  }

  replaceDocumentIfCurrent(expectedDocument, replacementDocument) {
    const expected = clone(expectedDocument);
    const replacement = clone(replacementDocument);
    validateProviderRegistryDocument(expected);
    validateProviderRegistryDocument(replacement);
    return this.#commit((document) => {
      if (!isDeepStrictEqual(document, expected)) return noChange(false);
      for (const key of Object.keys(document)) delete document[key];
      Object.assign(document, clone(replacement));
      return true;
    });
  }

  getActive() {
    const document = this.#refresh();
    if (document.activeProviderId === null) {
      return null;
    }
    const index = this.#getIndex(document, document.activeProviderId);
    return clone(document.providers[index]);
  }

  getDocument() {
    return clone(this.#refresh());
  }
}
