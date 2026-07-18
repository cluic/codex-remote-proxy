import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const METRICS_SCHEMA_VERSION = 1;
export const METRICS_BUCKET_MINUTES = 60;
export const METRICS_RETENTION_BUCKETS = 7 * 24;
export const METRICS_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const METRICS_LATENCY_BOUNDS_MS = Object.freeze([
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
  120_000,
  300_000
]);

const LATENCY_BIN_COUNT = METRICS_LATENCY_BOUNDS_MS.length + 1;
const BUCKET_MS = METRICS_BUCKET_MINUTES * 60 * 1_000;
const MAX_PROVIDERS_PER_BUCKET = 32;
const MAX_MODELS_PER_BUCKET = 64;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_COUNTER = 1_000_000_000_000;
const MAX_OBSERVATION_TOKENS = 100_000_000;
const MAX_TOKEN_TOTAL = 9_000_000_000_000_000;
const DEFAULT_FLUSH_DELAY_MS = 1_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const RESULTS = Object.freeze([
  "success",
  "upstreamRejected",
  "upstreamError",
  "timeout",
  "networkError",
  "clientAbort"
]);
const OBSERVATION_FIELDS = new Set([
  "providerId",
  "result",
  "model",
  "inputTokens",
  "outputTokens",
  "durationBin",
  "responseStartBin"
]);
const DOCUMENT_FIELDS = new Set(["schemaVersion", "bucketMinutes", "retentionBuckets", "buckets"]);
const BUCKET_FIELDS = new Set([
  "start",
  "requests",
  "results",
  "usageObservedRequests",
  "inputTokens",
  "outputTokens",
  "durationBins",
  "responseStartBins",
  "unknownModelRequests",
  "modelOverflowRequests",
  "providerOverflowRequests",
  "droppedObservations",
  "providers",
  "models"
]);
const PROVIDER_FIELDS = new Set([
  "providerId",
  "requests",
  "successfulRequests",
  "usageObservedRequests",
  "inputTokens",
  "outputTokens",
  "durationBins"
]);
const MODEL_FIELDS = new Set([
  "model",
  "requests",
  "usageObservedRequests",
  "inputTokens",
  "outputTokens"
]);
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
};

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function isBoundedText(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum * 2
    && [...value].length <= maximum
    && value.trim() === value
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function isBoundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function canonicalHour(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp % BUCKET_MS !== 0) return null;
  const canonical = new Date(timestamp).toISOString();
  return canonical === value ? timestamp : null;
}

function emptyResults() {
  return Object.fromEntries(RESULTS.map((result) => [result, 0]));
}

function emptyBins() {
  return Array.from({ length: LATENCY_BIN_COUNT }, () => 0);
}

function emptyBucket(start) {
  return {
    start,
    requests: 0,
    results: emptyResults(),
    usageObservedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationBins: emptyBins(),
    responseStartBins: emptyBins(),
    unknownModelRequests: 0,
    modelOverflowRequests: 0,
    providerOverflowRequests: 0,
    droppedObservations: 0,
    providers: [],
    models: []
  };
}

function validateResults(results) {
  return hasExactFields(results, new Set(RESULTS))
    && RESULTS.every((result) => isBoundedInteger(results[result], MAX_COUNTER));
}

function validateBins(bins) {
  return Array.isArray(bins)
    && bins.length === LATENCY_BIN_COUNT
    && bins.every((count) => isBoundedInteger(count, MAX_COUNTER));
}

function validateProviderRow(row) {
  return hasExactFields(row, PROVIDER_FIELDS)
    && isBoundedText(row.providerId, MAX_PROVIDER_ID_LENGTH)
    && isBoundedInteger(row.requests, MAX_COUNTER)
    && isBoundedInteger(row.successfulRequests, MAX_COUNTER)
    && row.successfulRequests <= row.requests
    && isBoundedInteger(row.usageObservedRequests, MAX_COUNTER)
    && row.usageObservedRequests <= row.requests
    && isBoundedInteger(row.inputTokens, MAX_TOKEN_TOTAL)
    && isBoundedInteger(row.outputTokens, MAX_TOKEN_TOTAL)
    && validateBins(row.durationBins)
    && row.durationBins.reduce((sum, count) => sum + count, 0) === row.requests;
}

function validateModelRow(row) {
  return hasExactFields(row, MODEL_FIELDS)
    && isBoundedText(row.model, MAX_MODEL_ID_LENGTH)
    && isBoundedInteger(row.requests, MAX_COUNTER)
    && isBoundedInteger(row.usageObservedRequests, MAX_COUNTER)
    && row.usageObservedRequests <= row.requests
    && isBoundedInteger(row.inputTokens, MAX_TOKEN_TOTAL)
    && isBoundedInteger(row.outputTokens, MAX_TOKEN_TOTAL);
}

function validateBucket(bucket) {
  if (!hasExactFields(bucket, BUCKET_FIELDS)
    || canonicalHour(bucket.start) === null
    || !isBoundedInteger(bucket.requests, MAX_COUNTER)
    || !validateResults(bucket.results)
    || RESULTS.reduce((sum, result) => sum + bucket.results[result], 0) !== bucket.requests
    || !isBoundedInteger(bucket.usageObservedRequests, MAX_COUNTER)
    || bucket.usageObservedRequests > bucket.requests
    || !isBoundedInteger(bucket.inputTokens, MAX_TOKEN_TOTAL)
    || !isBoundedInteger(bucket.outputTokens, MAX_TOKEN_TOTAL)
    || !validateBins(bucket.durationBins)
    || !validateBins(bucket.responseStartBins)
    || bucket.durationBins.reduce((sum, count) => sum + count, 0) !== bucket.requests
    || bucket.responseStartBins.reduce((sum, count) => sum + count, 0) > bucket.requests
    || !isBoundedInteger(bucket.unknownModelRequests, MAX_COUNTER)
    || !isBoundedInteger(bucket.modelOverflowRequests, MAX_COUNTER)
    || !isBoundedInteger(bucket.providerOverflowRequests, MAX_COUNTER)
    || !isBoundedInteger(bucket.droppedObservations, MAX_COUNTER)
    || !Array.isArray(bucket.providers)
    || bucket.providers.length > MAX_PROVIDERS_PER_BUCKET
    || !bucket.providers.every(validateProviderRow)
    || new Set(bucket.providers.map((row) => row.providerId)).size !== bucket.providers.length
    || !Array.isArray(bucket.models)
    || bucket.models.length > MAX_MODELS_PER_BUCKET
    || !bucket.models.every(validateModelRow)
    || new Set(bucket.models.map((row) => row.model)).size !== bucket.models.length
    || bucket.providers.reduce((sum, row) => sum + row.requests, 0)
      + bucket.providerOverflowRequests !== bucket.requests
    || bucket.models.reduce((sum, row) => sum + row.requests, 0)
      + bucket.unknownModelRequests + bucket.modelOverflowRequests !== bucket.requests) {
    throw new Error("Metrics bucket is invalid.");
  }
  return structuredClone(bucket);
}

function validateDocument(document) {
  if (!hasExactFields(document, DOCUMENT_FIELDS)
    || document.schemaVersion !== METRICS_SCHEMA_VERSION
    || document.bucketMinutes !== METRICS_BUCKET_MINUTES
    || document.retentionBuckets !== METRICS_RETENTION_BUCKETS
    || !Array.isArray(document.buckets)
    || document.buckets.length > METRICS_RETENTION_BUCKETS) {
    throw new Error("Metrics document is invalid.");
  }
  const buckets = document.buckets.map(validateBucket);
  for (let index = 1; index < buckets.length; index += 1) {
    if (buckets[index - 1].start >= buckets[index].start) {
      throw new Error("Metrics buckets are not strictly ordered.");
    }
  }
  return buckets;
}

function validateObservation(observation) {
  if (!hasExactFields(observation, OBSERVATION_FIELDS)
    || !isBoundedText(observation.providerId, MAX_PROVIDER_ID_LENGTH)
    || !RESULTS.includes(observation.result)
    || (observation.model !== null && !isBoundedText(observation.model, MAX_MODEL_ID_LENGTH))
    || !Number.isInteger(observation.durationBin)
    || observation.durationBin < 0
    || observation.durationBin >= LATENCY_BIN_COUNT
    || (observation.responseStartBin !== null
      && (!Number.isInteger(observation.responseStartBin)
        || observation.responseStartBin < 0
        || observation.responseStartBin >= LATENCY_BIN_COUNT))) {
    return false;
  }
  const noUsage = observation.inputTokens === null && observation.outputTokens === null;
  const completeUsage = isBoundedInteger(observation.inputTokens, MAX_OBSERVATION_TOKENS)
    && isBoundedInteger(observation.outputTokens, MAX_OBSERVATION_TOKENS);
  return noUsage || completeUsage;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateMode(stats, platform) {
  return platform === "win32" || (stats.mode & 0o777) === 0o600;
}

function addBounded(target, field, amount, maximum, bucket) {
  const next = target[field] + amount;
  if (Number.isSafeInteger(next) && next <= maximum) {
    target[field] = next;
    return;
  }
  target[field] = maximum;
  bucket.droppedObservations = Math.min(MAX_COUNTER, bucket.droppedObservations + 1);
}

function addBin(bins, index, bucket) {
  const next = bins[index] + 1;
  if (next <= MAX_COUNTER) bins[index] = next;
  else bucket.droppedObservations = Math.min(MAX_COUNTER, bucket.droppedObservations + 1);
}

function mergeBins(target, source) {
  for (let index = 0; index < LATENCY_BIN_COUNT; index += 1) {
    target[index] = Math.min(MAX_COUNTER, target[index] + source[index]);
  }
}

function projectRequestRows(rows, trackedRequests, limit = 16) {
  const projected = [];
  let remaining = trackedRequests;
  for (const row of rows) {
    if (projected.length === limit || remaining === 0) break;
    const requests = Math.min(row.requests, remaining);
    if (requests > 0) projected.push({ row, requests });
    remaining -= requests;
  }
  return projected;
}

function leastRequestedIndex(rows, field) {
  let selected = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const current = rows[selected];
    if (row.requests < current.requests
      || row.requests === current.requests && compareText(row[field], current[field]) > 0) {
      selected = index;
    }
  }
  return selected;
}

function percentileUpperBound(bins, percentile) {
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const threshold = Math.max(1, Math.ceil(total * percentile));
  let observed = 0;
  for (let index = 0; index < bins.length; index += 1) {
    observed += bins[index];
    if (observed >= threshold) return METRICS_LATENCY_BOUNDS_MS[index] ?? null;
  }
  return null;
}

function latencyProjection(bins) {
  return {
    p50UpperBoundMs: percentileUpperBound(bins, 0.5),
    p95UpperBoundMs: percentileUpperBound(bins, 0.95),
    overflowRequests: bins.at(-1)
  };
}

function tokenProjection(source) {
  return {
    input: source.inputTokens,
    output: source.outputTokens,
    observedRequests: source.usageObservedRequests
  };
}

export function latencyBinForMs(value) {
  if (!Number.isFinite(value) || value < 0) return METRICS_LATENCY_BOUNDS_MS.length;
  const index = METRICS_LATENCY_BOUNDS_MS.findIndex((boundary) => value <= boundary);
  return index === -1 ? METRICS_LATENCY_BOUNDS_MS.length : index;
}

export class MetricsStore {
  constructor({
    path,
    now = () => Date.now(),
    flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
    fileOperations = DEFAULT_FILE_OPERATIONS,
    createId = randomUUID,
    platform = process.platform
  } = {}) {
    if (typeof path !== "string" || path.length === 0
      || typeof now !== "function"
      || !Number.isSafeInteger(flushDelayMs) || flushDelayMs < 0
      || !fileOperations || typeof createId !== "function") {
      throw new TypeError("Metrics store options are invalid.");
    }
    this.path = path;
    this.now = now;
    this.flushDelayMs = flushDelayMs;
    this.fileOperations = fileOperations;
    this.createId = createId;
    this.platform = platform;
    this.buckets = [];
    this.storageState = "ready";
    this.writeBlocked = false;
    this.dirty = false;
    this.closed = false;
    this.flushTimer = null;
    this.#load();
  }

  record(observation) {
    if (this.closed || !validateObservation(observation)) return false;
    const nowMs = this.#nowMs();
    this.#prune(nowMs);
    const start = new Date(Math.floor(nowMs / BUCKET_MS) * BUCKET_MS).toISOString();
    let bucket = this.buckets.at(-1);
    if (!bucket || bucket.start !== start) {
      bucket = emptyBucket(start);
      this.buckets.push(bucket);
    }

    if (bucket.requests === MAX_COUNTER) {
      bucket.droppedObservations = Math.min(MAX_COUNTER, bucket.droppedObservations + 1);
      this.dirty = true;
      this.#scheduleFlush();
      return true;
    }

    addBounded(bucket, "requests", 1, MAX_COUNTER, bucket);
    addBounded(bucket.results, observation.result, 1, MAX_COUNTER, bucket);
    addBin(bucket.durationBins, observation.durationBin, bucket);
    if (observation.responseStartBin !== null) {
      addBin(bucket.responseStartBins, observation.responseStartBin, bucket);
    }
    const hasUsage = observation.inputTokens !== null && observation.outputTokens !== null;
    if (hasUsage) {
      addBounded(bucket, "usageObservedRequests", 1, MAX_COUNTER, bucket);
      addBounded(bucket, "inputTokens", observation.inputTokens, MAX_TOKEN_TOTAL, bucket);
      addBounded(bucket, "outputTokens", observation.outputTokens, MAX_TOKEN_TOTAL, bucket);
    }

    let provider = bucket.providers.find((row) => row.providerId === observation.providerId);
    if (!provider && bucket.providers.length === MAX_PROVIDERS_PER_BUCKET) {
      const [evicted] = bucket.providers.splice(leastRequestedIndex(bucket.providers, "providerId"), 1);
      addBounded(bucket, "providerOverflowRequests", evicted.requests, MAX_COUNTER, bucket);
    }
    if (!provider) {
      provider = {
        providerId: observation.providerId,
        requests: 0,
        successfulRequests: 0,
        usageObservedRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationBins: emptyBins()
      };
      bucket.providers.push(provider);
    }
    addBounded(provider, "requests", 1, MAX_COUNTER, bucket);
    if (observation.result === "success") {
      addBounded(provider, "successfulRequests", 1, MAX_COUNTER, bucket);
    }
    addBin(provider.durationBins, observation.durationBin, bucket);
    if (hasUsage) {
      addBounded(provider, "usageObservedRequests", 1, MAX_COUNTER, bucket);
      addBounded(provider, "inputTokens", observation.inputTokens, MAX_TOKEN_TOTAL, bucket);
      addBounded(provider, "outputTokens", observation.outputTokens, MAX_TOKEN_TOTAL, bucket);
    }

    if (observation.model === null) {
      addBounded(bucket, "unknownModelRequests", 1, MAX_COUNTER, bucket);
    } else {
      let model = bucket.models.find((row) => row.model === observation.model);
      if (!model && bucket.models.length === MAX_MODELS_PER_BUCKET) {
        const [evicted] = bucket.models.splice(leastRequestedIndex(bucket.models, "model"), 1);
        addBounded(bucket, "modelOverflowRequests", evicted.requests, MAX_COUNTER, bucket);
      }
      if (!model) {
        model = {
          model: observation.model,
          requests: 0,
          usageObservedRequests: 0,
          inputTokens: 0,
          outputTokens: 0
        };
        bucket.models.push(model);
      }
      addBounded(model, "requests", 1, MAX_COUNTER, bucket);
      if (hasUsage) {
        addBounded(model, "usageObservedRequests", 1, MAX_COUNTER, bucket);
        addBounded(model, "inputTokens", observation.inputTokens, MAX_TOKEN_TOTAL, bucket);
        addBounded(model, "outputTokens", observation.outputTokens, MAX_TOKEN_TOTAL, bucket);
      }
    }

    bucket.providers.sort((left, right) => compareText(left.providerId, right.providerId));
    bucket.models.sort((left, right) => compareText(left.model, right.model));
    this.dirty = true;
    this.#scheduleFlush();
    return true;
  }

  noteDropped() {
    if (this.closed) return;
    const nowMs = this.#nowMs();
    this.#prune(nowMs);
    const start = new Date(Math.floor(nowMs / BUCKET_MS) * BUCKET_MS).toISOString();
    let bucket = this.buckets.at(-1);
    if (!bucket || bucket.start !== start) {
      bucket = emptyBucket(start);
      this.buckets.push(bucket);
    }
    bucket.droppedObservations = Math.min(MAX_COUNTER, bucket.droppedObservations + 1);
    this.dirty = true;
    this.#scheduleFlush();
  }

  getOverview({ window = "24h" } = {}) {
    const bucketCount = window === "24h" ? 24 : window === "7d" ? METRICS_RETENTION_BUCKETS : null;
    if (bucketCount === null) throw new TypeError("Metrics window is invalid.");
    const nowMs = this.#nowMs();
    this.#prune(nowMs);
    const currentStart = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
    const firstStart = currentStart - ((bucketCount - 1) * BUCKET_MS);
    const selected = this.buckets.filter((bucket) => Date.parse(bucket.start) >= firstStart);
    const byStart = new Map(selected.map((bucket) => [bucket.start, bucket]));
    const summary = emptyBucket(new Date(firstStart).toISOString());
    const providerTotals = new Map();
    const modelTotals = new Map();
    const series = [];

    for (let index = 0; index < bucketCount; index += 1) {
      const start = new Date(firstStart + (index * BUCKET_MS)).toISOString();
      const bucket = byStart.get(start) ?? emptyBucket(start);
      addBounded(summary, "requests", bucket.requests, MAX_COUNTER, summary);
      for (const result of RESULTS) {
        addBounded(summary.results, result, bucket.results[result], MAX_COUNTER, summary);
      }
      addBounded(summary, "usageObservedRequests", bucket.usageObservedRequests, MAX_COUNTER, summary);
      addBounded(summary, "inputTokens", bucket.inputTokens, MAX_TOKEN_TOTAL, summary);
      addBounded(summary, "outputTokens", bucket.outputTokens, MAX_TOKEN_TOTAL, summary);
      mergeBins(summary.durationBins, bucket.durationBins);
      mergeBins(summary.responseStartBins, bucket.responseStartBins);
      for (const field of [
        "unknownModelRequests",
        "modelOverflowRequests",
        "providerOverflowRequests",
        "droppedObservations"
      ]) {
        addBounded(summary, field, bucket[field], MAX_COUNTER, summary);
      }
      series.push({
        start,
        requests: bucket.requests,
        results: { ...bucket.results },
        tokens: tokenProjection(bucket)
      });

      for (const row of bucket.providers) {
        let total = providerTotals.get(row.providerId);
        if (!total) {
          total = {
            providerId: row.providerId,
            requests: 0,
            successfulRequests: 0,
            usageObservedRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            durationBins: emptyBins()
          };
          providerTotals.set(row.providerId, total);
        }
        for (const field of ["requests", "successfulRequests", "usageObservedRequests"]) {
          total[field] = Math.min(MAX_COUNTER, total[field] + row[field]);
        }
        total.inputTokens = Math.min(MAX_TOKEN_TOTAL, total.inputTokens + row.inputTokens);
        total.outputTokens = Math.min(MAX_TOKEN_TOTAL, total.outputTokens + row.outputTokens);
        mergeBins(total.durationBins, row.durationBins);
      }
      for (const row of bucket.models) {
        let total = modelTotals.get(row.model);
        if (!total) {
          total = {
            model: row.model,
            requests: 0,
            usageObservedRequests: 0,
            inputTokens: 0,
            outputTokens: 0
          };
          modelTotals.set(row.model, total);
        }
        for (const field of ["requests", "usageObservedRequests"]) {
          total[field] = Math.min(MAX_COUNTER, total[field] + row[field]);
        }
        total.inputTokens = Math.min(MAX_TOKEN_TOTAL, total.inputTokens + row.inputTokens);
        total.outputTokens = Math.min(MAX_TOKEN_TOTAL, total.outputTokens + row.outputTokens);
      }
    }

    const providerRows = [...providerTotals.values()]
      .sort((left, right) => right.requests - left.requests || compareText(left.providerId, right.providerId));
    const modelRows = [...modelTotals.values()]
      .sort((left, right) => right.requests - left.requests || compareText(left.model, right.model));
    const providerTrackedRequests = summary.requests - Math.min(
      summary.requests,
      summary.providerOverflowRequests
    );
    const modelGroupedRequests = Math.min(
      summary.requests,
      summary.unknownModelRequests + summary.modelOverflowRequests
    );
    const providerProjection = projectRequestRows(providerRows, providerTrackedRequests);
    const modelProjection = projectRequestRows(modelRows, summary.requests - modelGroupedRequests);
    const projectedProviderRequests = providerProjection.reduce((sum, entry) => sum + entry.requests, 0);
    const projectedModelRequests = modelProjection.reduce((sum, entry) => sum + entry.requests, 0);
    return {
      window,
      bucketMinutes: METRICS_BUCKET_MINUTES,
      storageState: this.storageState,
      summary: {
        requests: summary.requests,
        results: { ...summary.results },
        tokens: tokenProjection(summary),
        latency: latencyProjection(summary.durationBins),
        responseStart: latencyProjection(summary.responseStartBins)
      },
      series,
      providers: providerProjection.map(({ row, requests }) => ({
        providerId: row.providerId,
        requests,
        successfulRequests: Math.min(row.successfulRequests, requests),
        tokens: {
          ...tokenProjection(row),
          observedRequests: Math.min(row.usageObservedRequests, requests)
        },
        latency: latencyProjection(row.durationBins)
      })),
      providerOtherRequests: summary.requests - projectedProviderRequests,
      models: modelProjection.map(({ row, requests }) => ({
        model: row.model,
        requests,
        tokens: {
          ...tokenProjection(row),
          observedRequests: Math.min(row.usageObservedRequests, requests)
        }
      })),
      modelOtherRequests: summary.requests - projectedModelRequests,
      dataQuality: {
        unknownModelRequests: summary.unknownModelRequests,
        modelOverflowRequests: summary.modelOverflowRequests,
        providerOverflowRequests: summary.providerOverflowRequests,
        droppedObservations: summary.droppedObservations
      }
    };
  }

  flush() {
    if (this.closed || !this.dirty || this.writeBlocked) return false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.#persist();
      this.dirty = false;
      this.storageState = "ready";
      return true;
    } catch {
      this.storageState = "degraded";
      return false;
    }
  }

  close() {
    if (this.closed) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty && !this.writeBlocked) {
      try {
        this.#persist();
        this.dirty = false;
      } catch {
        this.storageState = "degraded";
      }
    }
    this.closed = true;
  }

  #nowMs() {
    const value = this.now();
    const timestamp = value instanceof Date || typeof value === "string" ? Date.parse(value) : Number(value);
    if (!Number.isFinite(timestamp) || timestamp < 0 || !Number.isSafeInteger(Math.trunc(timestamp))) {
      throw new TypeError("Metrics clock is invalid.");
    }
    return Math.trunc(timestamp);
  }

  #prune(nowMs) {
    const currentStart = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
    const firstStart = currentStart - ((METRICS_RETENTION_BUCKETS - 1) * BUCKET_MS);
    this.buckets = this.buckets.filter((bucket) => {
      const start = Date.parse(bucket.start);
      return start >= firstStart && start <= currentStart;
    });
  }

  #scheduleFlush() {
    if (this.writeBlocked || this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  #load() {
    let before;
    try {
      before = this.fileOperations.lstatSync(this.path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      this.#blockWrites();
      return;
    }
    try {
      if (!before.isFile() || before.isSymbolicLink()
        || before.size > METRICS_MAX_FILE_BYTES
        || !privateMode(before, this.platform)) {
        throw new Error("Metrics path is unsafe.");
      }
      const noFollow = typeof this.fileOperations.constants.O_NOFOLLOW === "number"
        ? this.fileOperations.constants.O_NOFOLLOW
        : 0;
      let descriptor;
      try {
        descriptor = this.fileOperations.openSync(
          this.path,
          this.fileOperations.constants.O_RDONLY | noFollow
        );
        const opened = this.fileOperations.fstatSync(descriptor);
        if (!opened.isFile() || !sameIdentity(before, opened)
          || opened.size > METRICS_MAX_FILE_BYTES || !privateMode(opened, this.platform)) {
          throw new Error("Metrics identity changed.");
        }
        const bytes = this.fileOperations.readFileSync(descriptor);
        const after = this.fileOperations.lstatSync(this.path);
        if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
          throw new Error("Metrics identity changed.");
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        this.buckets = validateDocument(JSON.parse(text));
        this.#prune(this.#nowMs());
      } finally {
        if (descriptor !== undefined) this.fileOperations.closeSync(descriptor);
      }
    } catch {
      this.buckets = [];
      this.#blockWrites();
    }
  }

  #blockWrites() {
    this.storageState = "unavailable";
    this.writeBlocked = true;
  }

  #persist() {
    const parent = dirname(this.path);
    this.fileOperations.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { this.fileOperations.chmodSync(parent, 0o700); } catch {}
    const document = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      bucketMinutes: METRICS_BUCKET_MINUTES,
      retentionBuckets: METRICS_RETENTION_BUCKETS,
      buckets: this.buckets
    };
    validateDocument(document);
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
    if (bytes.length > METRICS_MAX_FILE_BYTES) throw new Error("Metrics document is too large.");
    const tempPath = join(parent, `.${basename(this.path)}.${this.createId()}.tmp`);
    let descriptor;
    try {
      descriptor = this.fileOperations.openSync(tempPath, "wx", 0o600);
      this.fileOperations.writeFileSync(descriptor, bytes);
      this.fileOperations.fsyncSync(descriptor);
      this.fileOperations.fchmodSync(descriptor, 0o600);
      this.fileOperations.closeSync(descriptor);
      descriptor = undefined;
      this.fileOperations.renameSync(tempPath, this.path);
    } catch (error) {
      if (descriptor !== undefined) {
        try { this.fileOperations.closeSync(descriptor); } catch {}
      }
      try { this.fileOperations.rmSync(tempPath, { force: true }); } catch {}
      throw error;
    }
  }
}
