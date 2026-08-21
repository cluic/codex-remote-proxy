import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { CrpError } from "../shared/errors.mjs";

const MAX_LIMIT = 100;
const MAX_SEARCH_CODE_POINTS = 100;
const MAX_URL_CODE_POINTS = 2_048;
const MAX_ID_CODE_POINTS = 256;
const MAX_ERROR_CODE_POINTS = 512;
const OUTCOMES = new Set(["all", "success", "rejected", "error"]);

function serviceError(cause) {
  return new CrpError(
    "FORWARDING_RECORDS_UNAVAILABLE",
    "Forwarding records could not be read.",
    "Verify the Capture database and try again.",
    { status: 503, cause }
  );
}

function boundedText(value, maximumCodePoints) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
  const points = [...normalized];
  return points.length <= maximumCodePoints
    ? normalized
    : `${points.slice(0, maximumCodePoints - 1).join("")}…`;
}

function safeInteger(value, { minimum = 0 } = {}) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function normalizeProviderBase(provider) {
  try {
    const parsed = new URL(provider.baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return {
      id: boundedText(provider.id, MAX_ID_CODE_POINTS),
      name: boundedText(provider.name, MAX_ID_CODE_POINTS),
      origin: parsed.origin,
      pathname,
      specificity: pathname.length
    };
  } catch {
    return null;
  }
}

function pathMatchesBase(targetPath, basePath) {
  if (basePath === "") return true;
  return targetPath === basePath || targetPath.startsWith(`${basePath}/`);
}

function resolveProvider(targetUrl, providers) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return { id: null, name: null, route: "unknown" };
  }
  if (target.hostname.toLowerCase() === "chatgpt.com") {
    return { id: "chatgpt-account", name: "ChatGPT", route: "account" };
  }
  const matches = providers
    .filter((provider) => provider.origin === target.origin
      && pathMatchesBase(target.pathname, provider.pathname))
    .sort((left, right) => right.specificity - left.specificity);
  const provider = matches[0] ?? null;
  return {
    id: provider?.id ?? null,
    name: provider?.name ?? target.host,
    route: "custom"
  };
}

function rowOutcome(row) {
  if (row.error_type !== null) return "error";
  const status = safeInteger(row.response_status);
  if (status !== null && status >= 200 && status <= 299) return "success";
  if (status !== null && status >= 400 && status <= 499) return "rejected";
  return "error";
}

function projectRow(row, providers) {
  const targetUrl = boundedText(row.target_url, MAX_URL_CODE_POINTS);
  const inferredProvider = resolveProvider(targetUrl ?? "", providers);
  const persistedRoute = ["account", "custom", "unknown"].includes(row.route)
    ? row.route
    : null;
  const provider = persistedRoute === null
    ? inferredProvider
    : {
        id: boundedText(row.provider_id, MAX_ID_CODE_POINTS),
        name: boundedText(row.provider_name, MAX_ID_CODE_POINTS),
        route: persistedRoute
      };
  const outcome = rowOutcome(row);
  return {
    id: safeInteger(row.id, { minimum: 1 }),
    startedAt: boundedText(row.started_at, MAX_ID_CODE_POINTS),
    completedAt: boundedText(row.completed_at, MAX_ID_CODE_POINTS),
    durationMs: safeInteger(row.duration_ms),
    requestId: boundedText(row.request_id, MAX_ID_CODE_POINTS),
    sessionId: boundedText(row.session_id, MAX_ID_CODE_POINTS),
    threadId: boundedText(row.thread_id, MAX_ID_CODE_POINTS),
    method: boundedText(row.method, 32),
    incomingUrl: boundedText(row.incoming_url, MAX_URL_CODE_POINTS),
    targetUrl,
    requestBytes: safeInteger(row.request_body_bytes) ?? 0,
    responseStatus: safeInteger(row.response_status),
    responseBytes: safeInteger(row.response_body_bytes) ?? 0,
    stream: row.is_stream === 1,
    upstreamRequestId: boundedText(row.upstream_request_id, MAX_ID_CODE_POINTS),
    errorType: boundedText(row.error_type, MAX_ID_CODE_POINTS),
    errorMessage: boundedText(row.error_message, MAX_ERROR_CODE_POINTS),
    outcome,
    providerId: provider.id,
    providerName: provider.name,
    route: provider.route
  };
}

function normalizeOptions({ limit = 50, before = null, outcome = "all", search = "" } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT
    || (before !== null && (!Number.isSafeInteger(before) || before < 1))
    || !OUTCOMES.has(outcome)
    || typeof search !== "string"
    || [...search].length > MAX_SEARCH_CODE_POINTS
    || /[\u0000-\u001f\u007f]/.test(search)) {
    throw new TypeError("Forwarding record query is invalid.");
  }
  return { limit, before, outcome, search: search.trim() };
}

function outcomeSql(outcome) {
  if (outcome === "success") {
    return "error_type IS NULL AND response_status BETWEEN 200 AND 299";
  }
  if (outcome === "rejected") {
    return "error_type IS NULL AND response_status BETWEEN 400 AND 499";
  }
  if (outcome === "error") {
    return "(error_type IS NOT NULL OR response_status IS NULL OR response_status >= 500 OR response_status < 200 OR response_status BETWEEN 300 AND 399)";
  }
  return null;
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function buildWhere(options, { providerColumns = false } = {}) {
  const conditions = [];
  const parameters = {};
  if (options.before !== null) {
    conditions.push("id < @before");
    parameters.before = options.before;
  }
  const outcome = outcomeSql(options.outcome);
  if (outcome) conditions.push(outcome);
  if (options.search) {
    const fields = ["request_id", "incoming_url", "target_url", "error_type", "error_message"];
    if (providerColumns) fields.push("provider_id", "provider_name", "route");
    conditions.push(`(${fields.map((field) => (
      `${field} LIKE @search ESCAPE '\\'`
    )).join(" OR ")})`);
    parameters.search = `%${escapeLike(options.search)}%`;
  }
  return {
    sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    parameters
  };
}

function emptyResult(storageState = "missing") {
  return {
    storageState,
    records: [],
    page: { limit: 50, nextBefore: null },
    summary: { total: 0, success: 0, rejected: 0, error: 0 }
  };
}

export class ForwardingRecordsService {
  constructor({
    path,
    listProviders = () => [],
    fileOperations = { lstatSync },
    openDatabase = (databasePath) => new DatabaseSync(databasePath, { readOnly: true })
  } = {}) {
    if (typeof path !== "string" || path.length === 0
      || typeof listProviders !== "function"
      || typeof fileOperations?.lstatSync !== "function"
      || typeof openDatabase !== "function") {
      throw new TypeError("Forwarding records service options are invalid.");
    }
    this.path = path;
    this.listProviders = listProviders;
    this.fileOperations = fileOperations;
    this.openDatabase = openDatabase;
  }

  list(rawOptions = {}) {
    const options = normalizeOptions(rawOptions);
    try {
      const stats = this.fileOperations.lstatSync(this.path);
      if (!stats.isFile() || stats.isSymbolicLink()) throw serviceError();
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ...emptyResult(), page: { limit: options.limit, nextBefore: null } };
      }
      if (error instanceof CrpError) throw error;
      throw serviceError(error);
    }
    let database;
    try {
      database = this.openDatabase(this.path);
      const providerProfiles = this.listProviders();
      const providers = Array.isArray(providerProfiles)
        ? providerProfiles.map(normalizeProviderBase).filter(Boolean)
        : [];
      const columns = new Set(
        database.prepare("PRAGMA table_info(http_transactions)").all()
          .map((column) => column.name)
      );
      const hasProviderColumns = ["provider_id", "provider_name", "route"]
        .every((column) => columns.has(column));
      const where = buildWhere(options, { providerColumns: hasProviderColumns });
      const providerColumns = hasProviderColumns
        ? "provider_id, provider_name, route,"
        : "NULL AS provider_id, NULL AS provider_name, NULL AS route,";
      const rows = database.prepare(`
        SELECT
          id, started_at, completed_at, duration_ms,
          request_id, session_id, thread_id, method,
          incoming_url, target_url, ${providerColumns} request_body_bytes,
          response_status, response_body_bytes, is_stream,
          upstream_request_id, error_type, error_message
        FROM http_transactions
        ${where.sql}
        ORDER BY id DESC
        LIMIT @rowLimit
      `).all({ ...where.parameters, rowLimit: options.limit + 1 });
      const hasMore = rows.length > options.limit;
      const visibleRows = hasMore ? rows.slice(0, options.limit) : rows;
      const records = visibleRows.map((row) => projectRow(row, providers));
      const summary = database.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN error_type IS NULL AND response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN error_type IS NULL AND response_status BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS rejected,
          SUM(CASE WHEN error_type IS NOT NULL OR response_status IS NULL OR response_status >= 500 OR response_status < 200 OR response_status BETWEEN 300 AND 399 THEN 1 ELSE 0 END) AS error
        FROM http_transactions
      `).get();
      return {
        storageState: "ready",
        records,
        page: {
          limit: options.limit,
          nextBefore: hasMore ? records.at(-1)?.id ?? null : null
        },
        summary: {
          total: safeInteger(summary?.total) ?? 0,
          success: safeInteger(summary?.success) ?? 0,
          rejected: safeInteger(summary?.rejected) ?? 0,
          error: safeInteger(summary?.error) ?? 0
        }
      };
    } catch (error) {
      throw serviceError(error);
    } finally {
      try { database?.close(); } catch {}
    }
  }
}
