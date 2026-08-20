import { spawn } from "node:child_process";

export const ACCOUNT_MONITOR_POLL_INTERVAL_MS = 5 * 60 * 1_000;
export const ACCOUNT_MONITOR_MAX_LINE_BYTES = 1024 * 1024;

const REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_000;
const MAX_TEXT_CODE_POINTS = 128;
const MAX_WINDOW_DURATION_MINS = 10 * 365 * 24 * 60;
const MAX_UNIX_SECONDS = 32_503_680_000;
const AUTH_MODES = new Set([
  "apikey",
  "chatgpt",
  "chatgptAuthTokens",
  "headers",
  "agentIdentity",
  "personalAccessToken",
  "bedrockApiKey"
]);
const CHATGPT_ACCOUNT_TYPES = new Set([
  "chatgpt",
  "chatgptAuthTokens",
  "agentIdentity",
  "personalAccessToken"
]);
const ACCOUNT_TYPE_TO_AUTH_MODE = new Map([
  ["apiKey", "apikey"],
  ["chatgpt", "chatgpt"],
  ["chatgptAuthTokens", "chatgptAuthTokens"],
  ["agentIdentity", "agentIdentity"],
  ["personalAccessToken", "personalAccessToken"],
  ["amazonBedrock", "bedrockApiKey"]
]);
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;
const DEFAULT_CLOCK = Object.freeze({
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer)
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, maximum = MAX_TEXT_CODE_POINTS) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > maximum * 2
    || [...value].length > maximum
    || value.trim() !== value
    || UNSAFE_TEXT_PATTERN.test(value)) {
    return null;
  }
  return value;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function initialState() {
  return {
    phase: "idle",
    authMode: null,
    planType: null,
    quotaSupported: null,
    quota: null,
    updatedAt: null,
    errorCode: null
  };
}

function normalizeAuthMode(value) {
  return AUTH_MODES.has(value) ? value : null;
}

function normalizeAccount(account) {
  if (!isPlainObject(account)) return { authMode: null, planType: null, chatgptBacked: false };
  const accountType = boundedText(account.type, 64);
  const authMode = ACCOUNT_TYPE_TO_AUTH_MODE.get(accountType) ?? null;
  return {
    authMode,
    planType: boundedText(account.planType, 64),
    chatgptBacked: CHATGPT_ACCOUNT_TYPES.has(accountType)
  };
}

function normalizeWindow(value, kind) {
  if (!isPlainObject(value)) return null;
  const usedPercent = boundedInteger(value.usedPercent, 0, 100);
  if (usedPercent === null) return null;
  const windowDurationMins = value.windowDurationMins === null
    || value.windowDurationMins === undefined
    ? null
    : boundedInteger(value.windowDurationMins, 1, MAX_WINDOW_DURATION_MINS);
  const resetsAt = value.resetsAt === null || value.resetsAt === undefined
    ? null
    : boundedInteger(value.resetsAt, 0, MAX_UNIX_SECONDS);
  return {
    kind,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins,
    resetsAt
  };
}

function selectRateLimits(result) {
  if (!isPlainObject(result)) return null;
  if (isPlainObject(result.rateLimitsByLimitId)
    && isPlainObject(result.rateLimitsByLimitId.codex)) {
    return result.rateLimitsByLimitId.codex;
  }
  return isPlainObject(result.rateLimits) ? result.rateLimits : null;
}

export function normalizeAccountRateLimits(result, updatedAt) {
  const selected = selectRateLimits(result);
  if (!selected) return null;
  const windows = [
    normalizeWindow(selected.primary, "primary"),
    normalizeWindow(selected.secondary, "secondary")
  ].filter(Boolean);
  const reachedType = selected.rateLimitReachedType === null
    || selected.rateLimitReachedType === undefined
    ? null
    : boundedText(selected.rateLimitReachedType, 64);
  let spendControlReached = typeof selected.spendControlReached === "boolean"
    ? selected.spendControlReached
    : null;
  let spendControlResetsAt = null;
  if (isPlainObject(selected.individualLimit)) {
    const remainingPercent = boundedInteger(
      selected.individualLimit.remainingPercent,
      0,
      100
    );
    if (remainingPercent !== null) {
      spendControlReached = remainingPercent === 0;
      spendControlResetsAt = spendControlReached
        ? boundedInteger(selected.individualLimit.resetsAt, 0, MAX_UNIX_SECONDS)
        : null;
    }
  }
  const exhausted = reachedType !== null
    || spendControlReached === true
    || windows.some((window) => window.usedPercent >= 100);
  return {
    status: exhausted ? "exhausted" : (windows.length > 0 ? "available" : "unknown"),
    limitId: boundedText(selected.limitId, 64),
    windows,
    rateLimitReachedType: reachedType,
    spendControlReached,
    spendControlResetsAt,
    updatedAt
  };
}

function mergeRollingQuota(current, incoming) {
  if (!current) return incoming;
  const windows = new Map(current.windows.map((window) => [window.kind, window]));
  for (const window of incoming.windows) windows.set(window.kind, window);
  const mergedWindows = [...windows.values()];
  const rateLimitReachedType = incoming.rateLimitReachedType ?? current.rateLimitReachedType;
  const spendControlReached = incoming.spendControlReached ?? current.spendControlReached;
  const spendControlResetsAt = spendControlReached === false
    ? null
    : (incoming.spendControlResetsAt ?? current.spendControlResetsAt ?? null);
  const exhausted = rateLimitReachedType !== null
    || spendControlReached === true
    || mergedWindows.some((window) => window.usedPercent >= 100);
  return {
    status: exhausted ? "exhausted" : (mergedWindows.length > 0 ? "available" : "unknown"),
    limitId: incoming.limitId ?? current.limitId,
    windows: mergedWindows,
    rateLimitReachedType,
    spendControlReached,
    spendControlResetsAt,
    updatedAt: incoming.updatedAt
  };
}

function requestError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function publicErrorCode(error) {
  if (error?.code === "APP_SERVER_METHOD_NOT_FOUND") return "ACCOUNT_QUOTA_UNSUPPORTED";
  if (error?.code === "ACCOUNT_MONITOR_TIMEOUT") return error.code;
  if (error?.code === "ACCOUNT_MONITOR_PROTOCOL_ERROR") return error.code;
  return "ACCOUNT_MONITOR_UNAVAILABLE";
}

function defaultSpawn(command, args) {
  return spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
}

export class AccountMonitor {
  #command;
  #args;
  #spawn;
  #now;
  #clock;
  #pollIntervalMs;
  #requestTimeoutMs;
  #maxLineBytes;
  #autoPoll;
  #clientVersion;
  #child = null;
  #stdoutBuffer = Buffer.alloc(0);
  #requestSequence = 0;
  #pending = new Map();
  #listeners = new Set();
  #startPromise = null;
  #refreshPromise = null;
  #pollTimer = null;
  #closed = false;
  #state = initialState();

  constructor({
    command = "codex",
    args = ["app-server", "--listen", "stdio://"],
    spawnImpl = defaultSpawn,
    now = () => new Date().toISOString(),
    clock = DEFAULT_CLOCK,
    pollIntervalMs = ACCOUNT_MONITOR_POLL_INTERVAL_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    maxLineBytes = ACCOUNT_MONITOR_MAX_LINE_BYTES,
    autoPoll = true,
    clientVersion = "unknown"
  } = {}) {
    this.#command = command;
    this.#args = [...args];
    this.#spawn = spawnImpl;
    this.#now = now;
    this.#clock = clock;
    this.#pollIntervalMs = pollIntervalMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxLineBytes = maxLineBytes;
    this.#autoPoll = autoPoll;
    this.#clientVersion = boundedText(clientVersion, 64) ?? "unknown";
  }

  getState() {
    return structuredClone(this.#state);
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Account monitor listener is invalid.");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start() {
    if (this.#closed) return Promise.reject(requestError("ACCOUNT_MONITOR_CLOSED"));
    if (this.#child && this.#state.phase !== "unavailable") return Promise.resolve(this.getState());
    if (this.#startPromise) return this.#startPromise;
    const attempt = this.#performStart();
    this.#startPromise = attempt;
    void attempt.finally(() => {
      if (this.#startPromise === attempt) this.#startPromise = null;
    }).catch(() => {});
    return attempt;
  }

  refresh() {
    if (this.#closed) return Promise.resolve(this.getState());
    if (this.#refreshPromise) return this.#refreshPromise;
    const attempt = this.#performRefresh();
    this.#refreshPromise = attempt;
    void attempt.finally(() => {
      if (this.#refreshPromise === attempt) this.#refreshPromise = null;
    }).catch(() => {});
    return attempt;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearPoll();
    this.#rejectPending(requestError("ACCOUNT_MONITOR_CLOSED"));
    const child = this.#child;
    this.#child = null;
    this.#setState({ ...initialState(), phase: "closed" });
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.#clock.clearTimeout(timer);
        resolvePromise();
      };
      const timer = this.#clock.setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish();
      }, CLOSE_TIMEOUT_MS);
      timer?.unref?.();
      child.once("exit", finish);
      try {
        child.stdin?.end?.();
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }

  async #performStart() {
    this.#setState({ ...this.#state, phase: "starting", errorCode: null });
    let child;
    try {
      child = this.#spawn(this.#command, [...this.#args]);
      if (!child?.stdin || !child?.stdout || !child?.stderr) {
        throw requestError("ACCOUNT_MONITOR_PROTOCOL_ERROR");
      }
      this.#stdoutBuffer = Buffer.alloc(0);
      this.#child = child;
      this.#attachChild(child);
      child.stderr.resume?.();
      await this.#request("initialize", {
        clientInfo: {
          name: "codex_remote_proxy",
          title: "Codex Remote Proxy",
          version: this.#clientVersion
        }
      });
      this.#notify("initialized", {});
      this.#setState({ ...this.#state, phase: "ready", errorCode: null });
      return this.getState();
    } catch (error) {
      if (this.#child === child) this.#child = null;
      this.#retireChild(child);
      this.#rejectPending(error);
      if (!this.#closed) {
        this.#setState({
          ...initialState(),
          phase: "unavailable",
          updatedAt: this.#now(),
          errorCode: publicErrorCode(error)
        });
      }
      throw error;
    }
  }

  async #performRefresh() {
    try {
      await this.start();
      if (this.#closed) return this.getState();
      const accountResult = await this.#request("account/read", { refreshToken: false });
      if (this.#closed) return this.getState();
      const account = normalizeAccount(accountResult?.account);
      let quota = null;
      let quotaSupported = null;
      let errorCode = null;
      if (account.chatgptBacked) {
        try {
          const quotaResult = await this.#request("account/rateLimits/read");
          if (this.#closed) return this.getState();
          quota = normalizeAccountRateLimits(quotaResult, this.#now());
          quotaSupported = true;
        } catch (error) {
          quotaSupported = error?.code === "APP_SERVER_METHOD_NOT_FOUND" ? false : null;
          errorCode = error?.code === "APP_SERVER_METHOD_NOT_FOUND"
            ? "ACCOUNT_QUOTA_UNSUPPORTED"
            : "ACCOUNT_QUOTA_UNAVAILABLE";
        }
      }
      if (this.#closed) return this.getState();
      this.#setState({
        phase: "ready",
        authMode: account.authMode,
        planType: account.planType,
        quotaSupported,
        quota,
        updatedAt: this.#now(),
        errorCode
      });
    } catch (error) {
      if (!this.#closed) {
        const child = this.#child;
        this.#child = null;
        this.#stdoutBuffer = Buffer.alloc(0);
        this.#retireChild(child);
        this.#rejectPending(error);
        this.#setState({
          ...this.#state,
          phase: "unavailable",
          quota: null,
          updatedAt: this.#now(),
          errorCode: publicErrorCode(error)
        });
      }
    } finally {
      this.#schedulePoll();
    }
    return this.getState();
  }

  #attachChild(child) {
    child.stdout.on("data", (chunk) => {
      if (child === this.#child) this.#acceptStdout(chunk);
    });
    child.stdout.once("error", () => this.#failProtocol(child));
    child.stdin.once("error", (error) => this.#handleChildExit(child, error));
    child.once("error", (error) => this.#handleChildExit(child, error));
    child.once("exit", () => this.#handleChildExit(
      child,
      requestError("ACCOUNT_MONITOR_UNAVAILABLE")
    ));
  }

  #acceptStdout(chunk) {
    if (this.#closed || !Buffer.isBuffer(chunk) && typeof chunk !== "string") return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, bytes]);
    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > this.#maxLineBytes) {
        this.#failProtocol();
        return;
      }
      const line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.length === 0) continue;
      this.#acceptLine(line);
    }
    if (this.#stdoutBuffer.length > this.#maxLineBytes) this.#failProtocol();
  }

  #acceptLine(line) {
    let message;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      this.#failProtocol();
      return;
    }
    if (!isPlainObject(message)) {
      this.#failProtocol();
      return;
    }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      this.#clock.clearTimeout(pending.timer);
      if (isPlainObject(message.error)) {
        pending.reject(message.error.code === -32601
          ? requestError("APP_SERVER_METHOD_NOT_FOUND")
          : requestError("ACCOUNT_MONITOR_REQUEST_FAILED"));
      } else if (Object.hasOwn(message, "result")) {
        pending.resolve(message.result);
      } else {
        pending.reject(requestError("ACCOUNT_MONITOR_PROTOCOL_ERROR"));
      }
      return;
    }
    this.#acceptNotification(message);
  }

  #acceptNotification(message) {
    if (message.method === "account/updated" && isPlainObject(message.params)) {
      this.#setState({
        ...this.#state,
        authMode: normalizeAuthMode(message.params.authMode),
        planType: boundedText(message.params.planType, 64),
        quota: null,
        updatedAt: this.#now(),
        errorCode: null
      });
      return;
    }
    if (message.method === "account/rateLimits/updated" && isPlainObject(message.params)) {
      const quota = normalizeAccountRateLimits(
        { rateLimits: message.params.rateLimits },
        this.#now()
      );
      if (quota) {
        this.#setState({
          ...this.#state,
          quotaSupported: true,
          quota: mergeRollingQuota(this.#state.quota, quota),
          updatedAt: this.#now(),
          errorCode: null
        });
      }
    }
  }

  #request(method, params) {
    if (!this.#child?.stdin?.writable) {
      return Promise.reject(requestError("ACCOUNT_MONITOR_UNAVAILABLE"));
    }
    const id = ++this.#requestSequence;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = this.#clock.setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(requestError("ACCOUNT_MONITOR_TIMEOUT"));
      }, this.#requestTimeoutMs);
      timer?.unref?.();
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.#child.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`);
      } catch {
        this.#pending.delete(id);
        this.#clock.clearTimeout(timer);
        rejectPromise(requestError("ACCOUNT_MONITOR_UNAVAILABLE"));
      }
    });
  }

  #notify(method, params) {
    if (!this.#child?.stdin?.writable) throw requestError("ACCOUNT_MONITOR_UNAVAILABLE");
    this.#child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  #failProtocol(child = this.#child) {
    if (child !== this.#child) return;
    const error = requestError("ACCOUNT_MONITOR_PROTOCOL_ERROR");
    this.#rejectPending(error);
    this.#setState({
      ...this.#state,
      phase: "unavailable",
      quota: null,
      updatedAt: this.#now(),
      errorCode: error.code
    });
    try { child?.kill?.("SIGTERM"); } catch {}
  }

  #handleChildExit(child, error) {
    if (this.#closed || child !== this.#child) return;
    const existingErrorCode = this.#state.phase === "unavailable"
      ? this.#state.errorCode
      : null;
    this.#child = null;
    this.#stdoutBuffer = Buffer.alloc(0);
    this.#rejectPending(error);
    this.#setState({
      ...this.#state,
      phase: "unavailable",
      quota: null,
      updatedAt: this.#now(),
      errorCode: existingErrorCode ?? publicErrorCode(error)
    });
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      this.#clock.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #retireChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    let timer = null;
    const clear = () => {
      if (timer !== null) this.#clock.clearTimeout(timer);
      timer = null;
    };
    child.once("exit", clear);
    timer = this.#clock.setTimeout(() => {
      timer = null;
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, CLOSE_TIMEOUT_MS);
    timer?.unref?.();
    try {
      child.kill("SIGTERM");
    } catch {
      clear();
    }
  }

  #setState(next) {
    this.#state = structuredClone(next);
    for (const listener of this.#listeners) {
      try { listener(this.getState()); } catch {}
    }
  }

  #schedulePoll() {
    this.#clearPoll();
    if (!this.#autoPoll || this.#closed) return;
    this.#pollTimer = this.#clock.setTimeout(() => {
      this.#pollTimer = null;
      void this.refresh();
    }, this.#pollIntervalMs);
    this.#pollTimer?.unref?.();
  }

  #clearPoll() {
    if (this.#pollTimer === null) return;
    this.#clock.clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }
}
