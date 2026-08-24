export type Locale = "en" | "zh-CN";

export type Route = "overview" | "providers" | "model-mappings" | "routing-rules" | "forwarding" | "activity" | "system" | "setup";

export type AccessMode = "initializing" | "writable" | "read-only" | "terminal" | "stopped";

export type TestStatus = "untested" | "passed" | "failed";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  authHeader: string;
  authScheme: string;
  extraHeaders: Record<string, string>;
  weight: number;
  modelMode: "passthrough" | "override";
  modelOverride: string | null;
  modelMappingGroupId: string | null;
  supportedModelsMode: "auto" | "custom";
  supportedModels: string[];
  modelsPath: string;
  customModels: string[];
  lastTestAt: string | null;
  lastTestStatus: TestStatus;
  lastTestCode: string | null;
  createdAt: string;
  updatedAt: string;
  credentialConfigured: boolean;
}

export interface ProviderInput {
  name: string;
  baseUrl: string;
  authHeader: string;
  authScheme: string;
  extraHeaders: Record<string, string>;
  weight: number;
  modelMode: "passthrough" | "override";
  modelOverride: string | null;
  modelMappingGroupId: string | null;
}

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  authHeader: string;
  authScheme: string;
  extraHeaders: Record<string, string>;
  homepageUrl: string;
  documentationUrl: string;
}

export interface ModelMappingRule {
  sourceModel: string;
  targetModel: string;
}

export interface ModelMappingGroup {
  id: string;
  name: string;
  rules: ModelMappingRule[];
  providerIds: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ModelMappingGroupInput {
  name: string;
  rules: ModelMappingRule[];
}

export interface RoutingRule {
  models: string[];
  providerIds: string[];
}

export interface RoutingRuleGroup {
  id: string;
  name: string;
  rules: RoutingRule[];
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface RoutingRuleGroupInput {
  name: string;
  rules: RoutingRule[];
}

export interface WorkerChildState {
  phase: string;
  configured: boolean;
  generation: number;
  listening: boolean;
  listenHost: string;
  listenPort: number;
  inFlight: number;
}

export interface WorkerStatus {
  phase: string;
  pid: number | null;
  generation: number;
  state: WorkerChildState | null;
  restartCount: number;
  startedAt: string | null;
  error: { code?: string; message?: string } | null;
}

export interface SupervisorIdentity {
  pid: number;
  startedAt: string;
}

export interface SupervisorShutdownAcceptance {
  accepted: true;
  supervisorPid: number;
  startedAt: string;
}

export interface AccountQuotaWindow {
  kind: "primary" | "secondary";
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountStatus {
  phase: "idle" | "starting" | "ready" | "unavailable" | "closed";
  authMode: "apikey" | "chatgpt" | "chatgptAuthTokens" | "headers" | "agentIdentity" | "personalAccessToken" | "bedrockApiKey" | null;
  authenticated: boolean | null;
  planType: string | null;
  quotaSupported: boolean | null;
  quota: {
    status: "available" | "exhausted" | "unknown";
    windows: AccountQuotaWindow[];
    rateLimitReachedType: string | null;
    spendControlReached: boolean | null;
    updatedAt: string | null;
  } | null;
  updatedAt: string | null;
  errorCode: string | null;
}

export interface StatusResponse {
  build: {
    name: string;
    version: string;
    repositoryUrl: string | null;
    homepageUrl: string | null;
    issuesUrl: string | null;
  };
  supervisor: { pid: number | null; startedAt: string | null };
  activeProviderId: string | null;
  activeProvider: Provider | null;
  generation: number;
  worker: WorkerStatus | null;
  codex: {
    configured: boolean;
    historyRepairPending: boolean;
    modelProvider: string | null;
    proxyUrl: string | null;
  };
  account: AccountStatus;
  capture: {
    configured: boolean;
    workerAvailable: boolean;
    active: boolean;
    state: "stopped" | "unavailable" | "unknown" | "disabled" | "enabling" | "enabled" | "disabling" | "error";
    synchronized: boolean | null;
    failedWriteCount: number;
    lastWriteErrorAt: string | null;
  };
}

export interface Settings {
  proxyHost: string | null;
  proxyPort: number | null;
  adminHost: string | null;
  adminPort: number | null;
  captureEnabled: boolean;
  routingMode: "custom_only" | "account_first";
  credentialBackend: string | null;
  autoStartSupported: boolean;
  autoStartEnabled: boolean;
  autoStartState: "enabled" | "disabled" | "stale" | "conflict" | "unavailable";
  autoStartPlatform: string | null;
}

export interface ActivityEvent {
  timestamp: string | null;
  category: string | null;
  action: string | null;
  providerId: string | null;
  result: string | null;
  errorCode: string | null;
  details: Record<string, unknown>;
}

export interface ActivityPageData {
  events: ActivityEvent[];
  page: { limit: number; offset: number; nextOffset: number | null };
}

export type ForwardingOutcome = "all" | "success" | "rejected" | "aborted" | "error";

export interface ForwardingRecord {
  id: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  requestId: string | null;
  sessionId: string | null;
  threadId: string | null;
  method: string | null;
  incomingUrl: string | null;
  targetUrl: string | null;
  requestBytes: number;
  responseStatus: number | null;
  responseBytes: number;
  stream: boolean;
  upstreamRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageObservationStatus: "observed" | "upstream_unreported" | "protocol_unrecognized" | "not_applicable" | "legacy";
  errorType: string | null;
  errorMessage: string | null;
  outcome: Exclude<ForwardingOutcome, "all">;
  providerId: string | null;
  providerName: string | null;
  route: "account" | "custom" | "unknown";
}

export interface ForwardingRecordsPageData {
  storageState: "missing" | "ready";
  records: ForwardingRecord[];
  page: { limit: number; nextBefore: number | null };
  summary: { total: number; success: number; rejected: number; aborted: number; error: number };
}

export interface ForwardingRecordsQuery {
  limit?: number;
  before?: number | null;
  outcome?: ForwardingOutcome;
  search?: string;
}

export interface ModelCatalog {
  providerId: string | null;
  state: "missing" | "fresh" | "stale";
  fetchedAt: string | null;
  expiresAt: string | null;
  mode: "auto" | "custom";
  configuredModels: string[];
  modelsPath: string;
  defaultEnabled: boolean;
  customModels: string[];
  discoveredModels: string[];
  entries: Array<{
    id: string;
    discovered: boolean;
    custom: boolean;
    enabled: boolean;
  }>;
  models: string[];
}

export interface ProviderTestResult {
  ok: boolean;
  code: string | null;
  initialActivation: {
    automatic: boolean;
    activeProviderId: string | null;
    workerStarted: boolean;
  } | null;
}

export interface BootstrapResult {
  changed: boolean;
  backupCreated: boolean;
  historyRepair: {
    required: boolean;
    completed: boolean;
    resumed: boolean;
    backupCreated: boolean;
    rolloutFiles: number;
    rolloutRecords: number;
    sqliteFiles: number;
    sqliteRows: number;
    encryptedContentDetected: boolean;
  };
}

export interface DiagnosticResult {
  created: boolean;
  generatedAt: string | null;
  eventCount: number | null;
}

export type MetricsWindow = "24h" | "7d";

export type MetricsResultKey =
  | "success"
  | "upstreamRejected"
  | "upstreamError"
  | "timeout"
  | "networkError"
  | "clientAbort";

export type MetricsResults = Record<MetricsResultKey, number>;

export interface TokenTotals {
  input: number;
  output: number;
  observedRequests: number;
}

export interface LatencySummary {
  p50UpperBoundMs: number | null;
  p95UpperBoundMs: number | null;
  overflowRequests: number;
}

export interface MetricsSeriesPoint {
  start: string;
  requests: number;
  results: MetricsResults;
  tokens: TokenTotals;
}

export interface MetricsOverview {
  window: MetricsWindow;
  bucketMinutes: 60;
  storageState: "ready" | "degraded" | "unavailable";
  summary: {
    requests: number;
    results: MetricsResults;
    tokens: TokenTotals;
    latency: LatencySummary;
    responseStart: LatencySummary;
  };
  series: MetricsSeriesPoint[];
  providers: Array<{
    providerId: string;
    requests: number;
    successfulRequests: number;
    tokens: TokenTotals;
    latency: LatencySummary;
  }>;
  providerOtherRequests: number;
  models: Array<{ model: string; requests: number; tokens: TokenTotals }>;
  modelOtherRequests: number;
  dataQuality: {
    unknownModelRequests: number;
    modelOverflowRequests: number;
    providerOverflowRequests: number;
    droppedObservations: number;
  };
}

export interface WorkspaceData {
  status: StatusResponse;
  providers: Provider[];
  providerPresets: ProviderPreset[];
  modelMappingGroups: ModelMappingGroup[];
  routingRuleGroups: RoutingRuleGroup[];
  settings: Settings;
}

export interface SafeErrorDetails {
  field?: unknown;
  reason?: unknown;
  committed?: unknown;
  degraded?: unknown;
  pending?: unknown;
  generation?: unknown;
  httpStatus?: unknown;
}
