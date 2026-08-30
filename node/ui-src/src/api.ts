import type {
  AccessKey,
  AccessKeyInput,
  AccessKeyPatch,
  ActivityPageData,
  AccountStatus,
  BootstrapResult,
  DiagnosticResult,
  ForwardingRecordsPageData,
  ForwardingRecordsQuery,
  ForwardingRecordDetail,
  MetricsOverview,
  MetricsWindow,
  TokenHeatmapOverview,
  TokenHeatmapWindow,
  ModelCatalog,
  ModelMappingGroup,
  ModelMappingGroupInput,
  Provider,
  ProviderInput,
  ProviderPreset,
  ProviderTestResult,
  RoutingRuleGroup,
  RoutingRuleGroupInput,
  RoutePreview,
  RouteOperation,
  SafeErrorDetails,
  Settings,
  StatusResponse,
  SupervisorIdentity,
  SupervisorShutdownAcceptance,
  WorkerStatus
} from "./types";

const TERMINAL_ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_SESSION_INVALID",
  "AUTH_SESSION_EXPIRED",
  "AUTH_CSRF_MISSING",
  "AUTH_CSRF_INVALID"
]);

const SAFE_DETAIL_KEYS = new Set([
  "field",
  "reason",
  "committed",
  "degraded",
  "pending",
  "generation",
  "httpStatus"
]);

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  emptyBody?: boolean;
  signal?: AbortSignal;
  sessionResume?: boolean;
  expectedStatus?: number;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactShutdownPayload(
  value: unknown,
  identity: SupervisorIdentity
): value is { shutdown: SupervisorShutdownAcceptance } {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1
    || !isPlainRecord(value.shutdown)) return false;
  return Object.keys(value.shutdown).length === 3
    && value.shutdown.accepted === true
    && value.shutdown.supervisorPid === identity.pid
    && value.shutdown.startedAt === identity.startedAt;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly action: string | null;
  readonly requestId: string | null;
  readonly details: SafeErrorDetails;

  constructor(
    code: string,
    status = 0,
    options: {
      message?: string;
      action?: string | null;
      requestId?: string | null;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(options.message ?? code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.action = options.action ?? null;
    this.requestId = typeof options.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(options.requestId)
      ? options.requestId
      : null;
    this.details = Object.fromEntries(
      Object.entries(options.details ?? {}).filter(([key]) => SAFE_DETAIL_KEYS.has(key))
    );
  }

  static fromTestResult(result: ProviderTestResult): ApiError {
    return new ApiError(result.code ?? "PROVIDER_TEST_INVALID_RESPONSES", 200);
  }
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  return new ApiError("INTERNAL_ERROR");
}

export function readAndClearControlToken(): string | null {
  const hash = location.hash;
  const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash);
  if (hash.length > 0) history.replaceState(null, "", `${location.pathname}${location.search}`);
  return match?.[1] ?? null;
}

export class CrpApi {
  #csrfToken: string | null = null;
  #mutationAllowed = false;
  #terminal = false;
  readonly #onTerminal: (error: ApiError) => void;

  constructor(onTerminal: (error: ApiError) => void) {
    this.#onTerminal = onTerminal;
  }

  get mutationAllowed(): boolean {
    return this.#mutationAllowed && !this.#terminal;
  }

  enterReadOnly(): void {
    this.#csrfToken = null;
    this.#mutationAllowed = false;
  }

  terminate(error: ApiError): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#csrfToken = null;
    this.#mutationAllowed = false;
    this.#onTerminal(error);
  }

  async exchangeSession(controlToken: string): Promise<void> {
    try {
      const payload = await this.#request<{ csrfToken?: unknown }>("/api/v1/session", {
        method: "POST",
        emptyBody: true,
        authorization: `Bearer ${controlToken}`
      });
      if (typeof payload.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.csrfToken)) {
        throw new ApiError("AUTH_SESSION_INVALID", 401);
      }
      this.#csrfToken = payload.csrfToken;
      this.#mutationAllowed = true;
    } catch (error) {
      const apiError = asApiError(error);
      this.terminate(apiError);
      throw apiError;
    }
  }

  async resumeSession(): Promise<void> {
    const payload = await this.#request<{ csrfToken?: unknown }>("/api/v1/session/resume", {
      method: "POST",
      emptyBody: true,
      sessionResume: true
    });
    if (typeof payload.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.csrfToken)) {
      const error = new ApiError("AUTH_SESSION_INVALID", 401);
      this.terminate(error);
      throw error;
    }
    this.#csrfToken = payload.csrfToken;
    this.#mutationAllowed = true;
  }

  async getStatus(signal?: AbortSignal): Promise<StatusResponse> {
    return await this.get<StatusResponse>("/api/v1/status", signal);
  }

  async listProviders(signal?: AbortSignal): Promise<Provider[]> {
    const payload = await this.get<{ providers: Provider[] }>("/api/v1/providers", signal);
    return payload.providers;
  }

  async listProviderPresets(signal?: AbortSignal): Promise<ProviderPreset[]> {
    const payload = await this.get<{ providerPresets: ProviderPreset[] }>(
      "/api/v1/provider-presets",
      signal
    );
    return payload.providerPresets;
  }

  async listModelMappingGroups(signal?: AbortSignal): Promise<ModelMappingGroup[]> {
    const payload = await this.get<{ modelMappingGroups: ModelMappingGroup[] }>(
      "/api/v1/model-mappings",
      signal
    );
    return payload.modelMappingGroups;
  }

  async createModelMappingGroup(input: ModelMappingGroupInput): Promise<ModelMappingGroup> {
    const payload = await this.mutate<{ modelMappingGroup: ModelMappingGroup }>(
      "/api/v1/model-mappings",
      { method: "POST", body: { mappingGroup: input } }
    );
    return payload.modelMappingGroup;
  }

  async updateModelMappingGroup(
    id: string,
    input: ModelMappingGroupInput
  ): Promise<ModelMappingGroup> {
    const payload = await this.mutate<{ modelMappingGroup: ModelMappingGroup }>(
      this.modelMappingPath(id),
      { method: "PATCH", body: { mappingGroup: input } }
    );
    return payload.modelMappingGroup;
  }

  async deleteModelMappingGroup(id: string): Promise<ModelMappingGroup> {
    const payload = await this.mutate<{ modelMappingGroup: ModelMappingGroup }>(
      this.modelMappingPath(id),
      { method: "DELETE", emptyBody: true }
    );
    return payload.modelMappingGroup;
  }

  async listRoutingRuleGroups(signal?: AbortSignal): Promise<RoutingRuleGroup[]> {
    const payload = await this.get<{ routingRuleGroups: RoutingRuleGroup[] }>(
      "/api/v1/routing-rule-groups",
      signal
    );
    return payload.routingRuleGroups;
  }

  async getRoutePreview(
    model: string,
    operation: RouteOperation,
    signal?: AbortSignal
  ): Promise<RoutePreview> {
    const parameters = new URLSearchParams({ model, operation });
    const payload = await this.get<{ routePreview: RoutePreview }>(
      `/api/v1/routing-preview?${parameters.toString()}`,
      signal
    );
    return payload.routePreview;
  }

  async createRoutingRuleGroup(input: RoutingRuleGroupInput): Promise<RoutingRuleGroup> {
    const payload = await this.mutate<{ routingRuleGroup: RoutingRuleGroup }>(
      "/api/v1/routing-rule-groups",
      { method: "POST", body: { routingRuleGroup: input } }
    );
    return payload.routingRuleGroup;
  }

  async updateRoutingRuleGroup(
    id: string,
    input: RoutingRuleGroupInput
  ): Promise<RoutingRuleGroup> {
    const payload = await this.mutate<{ routingRuleGroup: RoutingRuleGroup }>(
      this.routingRuleGroupPath(id),
      { method: "PATCH", body: { routingRuleGroup: input } }
    );
    return payload.routingRuleGroup;
  }

  async deleteRoutingRuleGroup(id: string): Promise<RoutingRuleGroup> {
    const payload = await this.mutate<{ routingRuleGroup: RoutingRuleGroup }>(
      this.routingRuleGroupPath(id),
      { method: "DELETE", emptyBody: true }
    );
    return payload.routingRuleGroup;
  }

  async setActiveRoutingRuleGroup(id: string | null): Promise<void> {
    await this.mutate("/api/v1/routing-rule-groups/active", {
      method: "PATCH",
      body: { id }
    });
  }

  async getSettings(signal?: AbortSignal): Promise<Settings> {
    const payload = await this.get<{ settings: Settings }>("/api/v1/settings", signal);
    return payload.settings;
  }

  async listAccessKeys(signal?: AbortSignal): Promise<AccessKey[]> {
    const payload = await this.get<{ accessKeys: AccessKey[] }>("/api/v1/access-keys", signal);
    return payload.accessKeys;
  }

  async createAccessKey(input: AccessKeyInput): Promise<AccessKey> {
    const payload = await this.mutate<{ accessKey: AccessKey }>("/api/v1/access-keys", {
      method: "POST",
      body: { accessKey: input },
      expectedStatus: 201
    });
    return payload.accessKey;
  }

  async updateAccessKey(id: string, patch: AccessKeyPatch): Promise<AccessKey> {
    const payload = await this.mutate<{ accessKey: AccessKey }>(this.accessKeyPath(id), {
      method: "PATCH",
      body: { accessKey: patch }
    });
    return payload.accessKey;
  }

  async deleteAccessKey(id: string): Promise<AccessKey> {
    const payload = await this.mutate<{ accessKey: AccessKey }>(this.accessKeyPath(id), {
      method: "DELETE",
      emptyBody: true
    });
    return payload.accessKey;
  }

  async refreshAccount(): Promise<AccountStatus> {
    const payload = await this.mutate<{ account: AccountStatus }>("/api/v1/account/refresh", {
      method: "POST",
      emptyBody: true
    });
    return payload.account;
  }

  async updateRoutingMode(routingMode: Settings["routingMode"]): Promise<Settings> {
    const payload = await this.mutate<{ settings: Settings }>("/api/v1/settings", {
      method: "PATCH",
      body: { routingMode }
    });
    return payload.settings;
  }

  async updateCaptureEnabled(captureEnabled: boolean): Promise<Settings> {
    const payload = await this.mutate<{ settings: Settings }>("/api/v1/settings", {
      method: "PATCH",
      body: { captureEnabled }
    });
    return payload.settings;
  }

  async updateCaptureDetailsEnabled(captureDetailsEnabled: boolean): Promise<Settings> {
    const payload = await this.mutate<{ settings: Settings }>("/api/v1/settings", {
      method: "PATCH",
      body: { captureDetailsEnabled }
    });
    return payload.settings;
  }

  async updateAutoStartEnabled(autoStartEnabled: boolean): Promise<Settings> {
    const payload = await this.mutate<{ settings: Settings }>("/api/v1/settings", {
      method: "PATCH",
      body: { autoStartEnabled }
    });
    return payload.settings;
  }

  async updateApiKeyAuthEnabled(apiKeyAuthEnabled: boolean): Promise<Settings> {
    const payload = await this.mutate<{ settings: Settings }>("/api/v1/settings", {
      method: "PATCH",
      body: { apiKeyAuthEnabled }
    });
    return payload.settings;
  }

  async updateProxyHost(proxyHost: "127.0.0.1" | "0.0.0.0"): Promise<Settings> {
    const payload = await this.mutate<{ settings: Settings }>("/api/v1/settings", {
      method: "PATCH",
      body: { proxyHost }
    });
    return payload.settings;
  }

  async getActivity(offset = 0, signal?: AbortSignal): Promise<ActivityPageData> {
    return await this.get<ActivityPageData>(`/api/v1/activity?limit=50&offset=${offset}`, signal);
  }

  async getForwardingRecords(
    query: ForwardingRecordsQuery = {},
    signal?: AbortSignal
  ): Promise<ForwardingRecordsPageData> {
    const parameters = new URLSearchParams();
    parameters.set("limit", String(query.limit ?? 50));
    if (query.before !== null && query.before !== undefined) {
      parameters.set("before", String(query.before));
    }
    if (query.outcome && query.outcome !== "all") parameters.set("outcome", query.outcome);
    if (query.search) parameters.set("search", query.search);
    if (query.includeModels !== undefined) {
      parameters.set("includeModels", String(query.includeModels));
    }
    return await this.get<ForwardingRecordsPageData>(
      `/api/v1/forwarding-records?${parameters.toString()}`,
      signal
    );
  }

  async getForwardingRecordDetail(id: number, signal?: AbortSignal): Promise<ForwardingRecordDetail> {
    const payload = await this.get<{ record: ForwardingRecordDetail }>(
      `/api/v1/forwarding-records/${encodeURIComponent(String(id))}`,
      signal
    );
    return payload.record;
  }

  async getMetrics(window: MetricsWindow, signal?: AbortSignal): Promise<MetricsOverview> {
    const payload = await this.get<{ metrics: MetricsOverview }>(
      `/api/v1/metrics/overview?window=${window}`,
      signal
    );
    return payload.metrics;
  }

  async getTokenHeatmap(
    window: TokenHeatmapWindow = "12w",
    signal?: AbortSignal
  ): Promise<TokenHeatmapOverview> {
    const payload = await this.get<{ heatmap: TokenHeatmapOverview }>(
      `/api/v1/metrics/token-heatmap?window=${window}`,
      signal
    );
    return payload.heatmap;
  }

  async createProvider(provider: ProviderInput, credential: string): Promise<Provider> {
    const payload = await this.mutate<{ provider: Provider }>("/api/v1/providers", {
      method: "POST",
      body: { provider, credential }
    });
    return payload.provider;
  }

  async updateProvider(id: string, patch: ProviderInput, replacementCredential?: string): Promise<Provider> {
    const body = replacementCredential === undefined ? { patch } : { patch, replacementCredential };
    const payload = await this.mutate<{ provider: Provider }>(this.providerPath(id), {
      method: "PATCH",
      body
    });
    return payload.provider;
  }

  async updateProviderWeight(id: string, weight: number): Promise<Provider> {
    const payload = await this.mutate<{ provider: Provider }>(`${this.providerPath(id)}/weight`, {
      method: "PATCH",
      body: { weight }
    });
    return payload.provider;
  }

  async deleteProvider(id: string): Promise<Provider> {
    const payload = await this.mutate<{ provider: Provider }>(this.providerPath(id), {
      method: "DELETE",
      emptyBody: true
    });
    return payload.provider;
  }

  async testProvider(id: string, model: string, activateIfNone = false): Promise<ProviderTestResult> {
    const payload = await this.mutate<{ result: ProviderTestResult }>(`${this.providerPath(id)}/test`, {
      method: "POST",
      body: activateIfNone ? { model, activateIfNone: true } : { model }
    });
    return payload.result;
  }

  async getProviderModels(id: string, signal?: AbortSignal): Promise<ModelCatalog> {
    const payload = await this.get<{ modelCatalog: ModelCatalog }>(`${this.providerPath(id)}/models`, signal);
    return payload.modelCatalog;
  }

  async refreshProviderModels(id: string): Promise<ModelCatalog> {
    const payload = await this.mutate<{ modelCatalog: ModelCatalog }>(`${this.providerPath(id)}/models`, {
      method: "POST",
      emptyBody: true
    });
    return payload.modelCatalog;
  }

  async updateProviderModels(
    id: string,
    input: {
      modelsPath: string;
      defaultEnabled: boolean;
      customModels: string[];
      overrides: string[];
    }
  ): Promise<ModelCatalog> {
    const payload = await this.mutate<{ modelCatalog: ModelCatalog }>(`${this.providerPath(id)}/models`, {
      method: "PATCH",
      body: input
    });
    return payload.modelCatalog;
  }

  async activateProvider(id: string): Promise<void> {
    await this.mutate(`${this.providerPath(id)}/activate`, { method: "POST", emptyBody: true });
  }

  async startProxy(): Promise<WorkerStatus> {
    const payload = await this.mutate<{ worker: WorkerStatus }>("/api/v1/proxy/start", {
      method: "POST",
      emptyBody: true
    });
    return payload.worker;
  }

  async stopProxy(): Promise<WorkerStatus> {
    const payload = await this.mutate<{ worker: WorkerStatus }>("/api/v1/proxy/stop", {
      method: "POST",
      emptyBody: true
    });
    return payload.worker;
  }

  async restartProxy(): Promise<WorkerStatus> {
    const payload = await this.mutate<{ worker: WorkerStatus }>("/api/v1/proxy/restart", {
      method: "POST",
      emptyBody: true
    });
    return payload.worker;
  }

  async shutdownSupervisor(identity: SupervisorIdentity): Promise<SupervisorShutdownAcceptance> {
    const payload = await this.mutate<unknown>("/api/v1/supervisor/shutdown", {
      method: "POST",
      body: {
        supervisorPid: identity.pid,
        startedAt: identity.startedAt
      },
      expectedStatus: 202
    });
    if (!isExactShutdownPayload(payload, identity)) {
      throw new ApiError("INTERNAL_ERROR", 202);
    }
    this.#terminal = true;
    this.#csrfToken = null;
    this.#mutationAllowed = false;
    return payload.shutdown;
  }

  async bootstrapCodex(): Promise<BootstrapResult> {
    const payload = await this.mutate<{ result: BootstrapResult }>("/api/v1/codex/bootstrap", {
      method: "POST",
      emptyBody: true
    });
    return payload.result;
  }

  async generateDiagnostics(): Promise<DiagnosticResult> {
    const payload = await this.mutate<{ diagnostics: DiagnosticResult }>("/api/v1/diagnostics/export", {
      method: "POST",
      emptyBody: true
    });
    return payload.diagnostics;
  }

  private providerPath(id: string): string {
    return `/api/v1/providers/${encodeURIComponent(id)}`;
  }

  private modelMappingPath(id: string): string {
    return `/api/v1/model-mappings/${encodeURIComponent(id)}`;
  }

  private routingRuleGroupPath(id: string): string {
    return `/api/v1/routing-rule-groups/${encodeURIComponent(id)}`;
  }

  private accessKeyPath(id: string): string {
    return `/api/v1/access-keys/${encodeURIComponent(id)}`;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return await this.#request<T>(path, { method: "GET", signal });
  }

  private async mutate<T = unknown>(path: string, options: RequestOptions): Promise<T> {
    if (!this.mutationAllowed || this.#csrfToken === null) throw new ApiError("AUTH_REQUIRED", 401);
    return await this.#request<T>(path, options);
  }

  async #request<T>(
    path: string,
    options: RequestOptions & { authorization?: string } = {}
  ): Promise<T> {
    if (this.#terminal) throw new ApiError("AUTH_REQUIRED", 401);
    const method = options.method ?? "GET";
    const mutation = method !== "GET";
    const sessionBootstrap = path === "/api/v1/session" || path === "/api/v1/session/resume";
    const headers: Record<string, string> = {};
    if (options.authorization !== undefined) headers.authorization = options.authorization;
    if (options.sessionResume) headers["x-crp-session-resume"] = "1";
    if (mutation && !sessionBootstrap) {
      if (!this.mutationAllowed || this.#csrfToken === null) throw new ApiError("AUTH_REQUIRED", 401);
      headers["x-crp-csrf"] = this.#csrfToken;
    }
    const request: RequestInit = {
      method,
      headers,
      credentials: "same-origin",
      signal: options.signal
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      request.body = JSON.stringify(options.body);
    }
    try {
      const response = await fetch(path, request);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ApiError("INTERNAL_ERROR", response.status);
      }
      if (!response.ok) {
        const envelope = payload as {
          error?: {
            code?: unknown;
            message?: unknown;
            action?: unknown;
            requestId?: unknown;
            details?: unknown;
          };
        };
        const code = typeof envelope.error?.code === "string" ? envelope.error.code : "INTERNAL_ERROR";
        const error = new ApiError(code, response.status, {
          message: typeof envelope.error?.message === "string" ? envelope.error.message : undefined,
          action: typeof envelope.error?.action === "string" ? envelope.error.action : null,
          requestId: typeof envelope.error?.requestId === "string" ? envelope.error.requestId : null,
          details: envelope.error?.details && typeof envelope.error.details === "object"
            ? envelope.error.details as Record<string, unknown>
            : {}
        });
        if (response.status === 401 || response.status === 403 && TERMINAL_ERROR_CODES.has(error.code)) {
          this.terminate(error);
        }
        throw error;
      }
      if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
        throw new ApiError("INTERNAL_ERROR", response.status);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ApiError || error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError("INTERNAL_ERROR");
    }
  }
}
