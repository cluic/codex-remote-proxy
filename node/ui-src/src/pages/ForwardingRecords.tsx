import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Copy,
  Database,
  FileClock,
  FileJson,
  Filter,
  LockKeyhole,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, asApiError } from "../api";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
  cx,
} from "../components/Primitives";
import { formatDate, formatDuration, formatNumber, type Translator } from "../i18n";
import type {
  ForwardingOutcome,
  ForwardingRecord,
  ForwardingRecordDetail,
  ForwardingRecordPayload,
  ForwardingRecordsPageData,
  ForwardingRecordsQuery,
  Locale,
  Provider,
  StatusResponse,
} from "../types";

type ForwardingRecordsProps = {
  locale: Locale;
  t: Translator;
  providers?: Pick<Provider, "id" | "name">[];
  captureEnabled: boolean;
  captureDetailsEnabled: boolean;
  captureStatus: StatusResponse["capture"];
  readOnly: boolean;
  pending: string | null;
  onLoad: (
    query: ForwardingRecordsQuery,
    signal?: AbortSignal
  ) => Promise<ForwardingRecordsPageData>;
  onLoadDetail: (
    id: number,
    signal?: AbortSignal
  ) => Promise<ForwardingRecordDetail>;
  onCaptureChange: (enabled: boolean) => Promise<boolean>;
  onCaptureDetailsChange: (enabled: boolean) => Promise<boolean>;
};

type TimeRange = "all" | "hour" | "day" | "week" | "month" | "custom";
type DetailTab = "summary" | "request" | "response";

type AppliedFilters = {
  search: string;
  model: string;
  providerId: string;
  sessionId: string;
  timeRange: TimeRange;
  since?: string;
  until?: string;
  includeModels: boolean;
};

function outcomeTone(
  outcome: ForwardingRecord["outcome"]
): "success" | "warning" | "danger" | "neutral" {
  if (outcome === "success") return "success";
  if (outcome === "rejected") return "warning";
  if (outcome === "aborted") return "neutral";
  return "danger";
}

function routeReasonLabel(record: ForwardingRecord, t: Translator): string {
  if (record.routeReason === "account_eligible") return t("forwarding.reason.accountEligible");
  if (record.routeReason === "account_cooldown") return t("forwarding.reason.accountCooldown");
  if (record.routeReason === "account_quota_exhausted") return t("forwarding.reason.accountQuotaExhausted");
  if (record.routeReason === "account_headers_missing") return t("forwarding.reason.accountHeadersMissing");
  if (record.routeReason === "account_body_too_large") return t("forwarding.reason.accountBodyTooLarge");
  if (record.routeReason === "not_chatgpt_auth") return t("forwarding.reason.notChatgptAuth");
  if (record.routeReason === "unsupported_operation") return t("forwarding.reason.unsupportedOperation");
  if (record.routeReason === "unsupported_account_model") return t("forwarding.reason.unsupportedAccountModel");
  if (record.routeReason === "unsupported_request_format") return t("forwarding.reason.unsupportedRequestFormat");
  if (record.routeReason === "model_not_detected") return t("forwarding.reason.modelNotDetected");
  if (record.routeReason === "invalid_multipart") return t("forwarding.reason.invalidMultipart");
  if (record.routeReason === "unsupported_method") return t("forwarding.reason.unsupportedMethod");
  if (record.routeReason === "unsupported_path") return t("forwarding.reason.unsupportedPath");
  if (record.routeReason === "custom_only") return t("forwarding.reason.customOnly");
  return t("forwarding.reason.legacy");
}

function routeLabel(record: ForwardingRecord, t: Translator): string {
  if (["unsupported_request_format", "model_not_detected", "invalid_multipart"].includes(
    record.routeReason ?? ""
  )) {
    return t("forwarding.route.rejected");
  }
  if (record.route === "account") return t("forwarding.route.account");
  if (record.route === "custom") return t("forwarding.route.custom");
  return t("forwarding.route.unknown");
}

function selectionReasonLabel(record: ForwardingRecord, t: Translator): string | null {
  if (record.providerSelectionReason === "model_priority") return t("forwarding.selection.modelPriority");
  if (record.providerSelectionReason === "weight") return t("forwarding.selection.weight");
  if (record.providerSelectionReason === "runtime_order") return t("forwarding.selection.runtimeOrder");
  if (record.providerSelectionReason === "cooldown_fallback") return t("forwarding.selection.cooldownFallback");
  if (record.providerSelectionReason === "retry_after_provider_failure") {
    return t("forwarding.selection.retryAfterFailure");
  }
  if (record.providerSelectionReason === "sole_eligible") return t("forwarding.selection.soleEligible");
  return null;
}

function byteLabel(locale: Locale, bytes: number): string {
  if (bytes < 1_024) return `${formatNumber(locale, bytes)} B`;
  if (bytes < 1_048_576) return `${formatNumber(locale, Math.round(bytes / 1_024))} KB`;
  return `${formatNumber(locale, Math.round(bytes / 1_048_576))} MB`;
}

function displayPath(record: ForwardingRecord): string {
  const value = record.incomingUrl ?? record.targetUrl;
  if (value === null) return "-";
  try {
    const parsed = new URL(value, "http://127.0.0.1");
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return value;
  }
}

function recordTimeParts(locale: Locale, value: string | null) {
  if (value === null) return { date: "-", time: "" };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { date: "-", time: "" };
  return {
    date: new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date),
  };
}

function modelValues(record: ForwardingRecord) {
  const requested = record.requestedModel ?? record.forwardedModel;
  const forwarded = record.forwardedModel ?? record.requestedModel;
  return {
    requested,
    forwarded,
    transformed: requested !== null && forwarded !== null && requested !== forwarded,
  };
}

function prettyBody(content: string, encoding: string): { text: string; json: boolean } {
  if (!content || !/utf-?8|text|json/i.test(encoding)) return { text: content, json: false };
  try {
    return { text: JSON.stringify(JSON.parse(content), null, 2), json: true };
  } catch {
    return { text: content, json: false };
  }
}

function normalizePayload(value: unknown): ForwardingRecordPayload {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const bodySource = source.body && typeof source.body === "object" && !Array.isArray(source.body)
    ? (source.body as Record<string, unknown>)
    : source;
  const headers = source.headers && typeof source.headers === "object" && !Array.isArray(source.headers)
    ? (source.headers as Record<string, string | string[]>)
    : {};
  return {
    headers,
    body: {
      content: typeof bodySource.content === "string" ? bodySource.content : "",
      encoding: typeof bodySource.encoding === "string" ? bodySource.encoding : "empty",
      bytes:
        typeof bodySource.bytes === "number" &&
        Number.isSafeInteger(bodySource.bytes) &&
        bodySource.bytes >= 0
          ? bodySource.bytes
          : 0,
      truncated: bodySource.truncated === true,
    },
  };
}

function timeBounds(
  range: TimeRange,
  customSince: string,
  customUntil: string
): { since?: string; until?: string; valid: boolean } {
  if (range === "all") return { valid: true };
  if (range === "custom") {
    const sinceDate = customSince ? new Date(customSince) : null;
    const untilDate = customUntil ? new Date(customUntil) : null;
    if (
      !sinceDate ||
      !untilDate ||
      !Number.isFinite(sinceDate.getTime()) ||
      !Number.isFinite(untilDate.getTime()) ||
      sinceDate >= untilDate
    ) {
      return { valid: false };
    }
    return { since: sinceDate.toISOString(), until: untilDate.toISOString(), valid: true };
  }
  const duration = range === "hour"
    ? 3_600_000
    : range === "day"
      ? 86_400_000
      : range === "week"
        ? 604_800_000
        : 2_592_000_000;
  return { since: new Date(Date.now() - duration).toISOString(), valid: true };
}

function DataPayload({
  side,
  payload,
  available,
  locale,
  t,
  record,
}: {
  side: "request" | "response";
  payload: ForwardingRecordPayload;
  available: boolean;
  locale: Locale;
  t: Translator;
  record: ForwardingRecord;
}) {
  const body = prettyBody(payload.body.content, payload.body.encoding);
  const headerEntries = Object.entries(payload.headers);
  const [formatted, setFormatted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const visibleBody = body.json && formatted ? body.text : payload.body.content;

  useEffect(() => {
    setFormatted(false);
    setExpanded(false);
    setCopied(false);
  }, [body.json, record.id, side]);

  const copyBody = async () => {
    if (!payload.body.content) return;
    try {
      await navigator.clipboard.writeText(payload.body.content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="record-data-pane" data-testid={`forwarding-${side}-data`}>
      <header className="record-data-heading">
        <div className="record-data-title">
          {side === "request" ? <ArrowRight aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
          <div>
            <span>{t(`forwarding.${side}`)}</span>
            <strong>
              {side === "request"
                ? `${record.method ?? "-"} ${displayPath(record)}`
                : `${t("forwarding.httpStatus")} ${record.responseStatus ?? "—"}`}
            </strong>
          </div>
        </div>
        <span className={cx("capture-state", available ? "capture-state-on" : "capture-state-off")}>
          {available ? <ShieldCheck aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
          {available ? t("forwarding.detailAvailable") : t("forwarding.detailNotAvailable")}
        </span>
      </header>

      {!available ? (
        <div className="record-data-empty">
          <LockKeyhole aria-hidden="true" />
          <strong>{t("forwarding.detailNotCaptured")}</strong>
          <p>{t("forwarding.detailNotCapturedHelp")}</p>
        </div>
      ) : (
        <>
          <div className="record-payload-meta" aria-label={t("forwarding.payloadInfo")}>
            <span><b>{t("forwarding.headers")}</b>{formatNumber(locale, headerEntries.length)}</span>
            <span><b>{t("forwarding.encoding")}</b><code>{payload.body.encoding || "-"}</code></span>
            <span><b>{t("forwarding.bytes")}</b>{byteLabel(locale, payload.body.bytes)}</span>
            {payload.body.truncated ? (
              <span className="payload-warning">{t("forwarding.truncated")}</span>
            ) : null}
          </div>

          <details className="record-header-details">
            <summary>
              <Braces aria-hidden="true" />
              <span>{t("forwarding.headers")}</span>
              <small>{formatNumber(locale, headerEntries.length)}</small>
            </summary>
            {headerEntries.length > 0 ? (
              <dl className="record-headers">
                {headerEntries.map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd><code>{Array.isArray(value) ? value.join(", ") : value}</code></dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="payload-muted">{t("forwarding.noHeaders")}</p>
            )}
          </details>

          <section className="record-body-section">
            <div className="record-body-heading">
              <h4><FileJson aria-hidden="true" />{t("forwarding.body")}</h4>
              <div className="record-body-actions">
                {body.json ? (
                  <div className="body-mode-switch" aria-label={t("forwarding.bodyView")}>
                    <button type="button" className={!formatted ? "selected" : undefined} onClick={() => setFormatted(false)}>
                      {t("forwarding.raw")}
                    </button>
                    <button type="button" className={formatted ? "selected" : undefined} onClick={() => setFormatted(true)}>
                      {t("forwarding.formatted")}
                    </button>
                  </div>
                ) : null}
                {visibleBody ? (
                  <>
                    <button type="button" className="body-tool-button" onClick={() => setExpanded((value) => !value)}>
                      <ChevronDown className={expanded ? "is-rotated" : undefined} aria-hidden="true" />
                      {t(expanded ? "forwarding.collapseBody" : "forwarding.expandBody")}
                    </button>
                    <button type="button" className="body-tool-button" onClick={() => void copyBody()}>
                      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      {t(copied ? "forwarding.copied" : "forwarding.copyRaw")}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            {visibleBody ? (
              <pre className={cx("record-body", !formatted && "record-body-raw", expanded && "is-expanded")}>
                <code>{visibleBody}</code>
              </pre>
            ) : (
              <div className="record-body-empty">
                <strong>
                  {payload.body.truncated
                    ? t("forwarding.bodyUnavailableTruncated")
                    : payload.body.bytes === 0
                      ? t("forwarding.bodyEmpty")
                      : t("forwarding.bodyUnavailable")}
                </strong>
                <p>
                  {payload.body.truncated
                    ? t("forwarding.bodyUnavailableTruncatedHelp")
                    : payload.body.bytes === 0
                      ? t("forwarding.bodyEmptyHelp")
                      : t("forwarding.bodyUnavailableHelp")}
                </p>
              </div>
            )}
            {visibleBody && payload.body.truncated ? (
              <p className="record-body-note">{t("forwarding.bodyTruncatedHelp")}</p>
            ) : null}
          </section>
        </>
      )}
    </article>
  );
}

function DetailFact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function RecordSummary({
  record,
  locale,
  t,
  onViewSession,
}: {
  record: ForwardingRecord;
  locale: Locale;
  t: Translator;
  onViewSession: () => void;
}) {
  const models = modelValues(record);
  const providerSelection = selectionReasonLabel(record, t);
  const hasRecordedError = Boolean(record.errorType || record.errorMessage);
  return (
    <div className="record-summary-tab" data-testid="forwarding-detail-summary">
      <section className={cx("record-outcome-summary", `is-${record.outcome}`)}>
        <div><span>{t("forwarding.finalOutcome")}</span><StatusBadge tone={outcomeTone(record.outcome)}>{t(`forwarding.outcome.${record.outcome}`)}</StatusBadge></div>
        <div><span>{t("forwarding.httpStatus")}</span><strong>{record.responseStatus ?? t("forwarding.noHttpStatus")}</strong></div>
        {record.outcome !== "success" ? (
          <div className="record-error-evidence">
            <span>{t("forwarding.recordedError")}</span>
            {hasRecordedError ? (
              <p>{record.errorType ? <code>{record.errorType}</code> : null}{record.errorMessage ? <span>{record.errorMessage}</span> : null}</p>
            ) : <p>{t("forwarding.errorReasonNotRecorded")}</p>}
          </div>
        ) : null}
      </section>

      {record.sessionId ? (
        <button type="button" className="view-session-button" data-testid="forwarding-view-session" onClick={onViewSession}>
          <Filter aria-hidden="true" />{t("forwarding.viewSession")}
        </button>
      ) : null}

      <dl className="record-detail-facts">
        <DetailFact label={t("forwarding.startedAt")}><time>{formatDate(locale, record.startedAt, true)}</time></DetailFact>
        <DetailFact label={t("forwarding.completedAt")}><time>{formatDate(locale, record.completedAt, true)}</time></DetailFact>
        <DetailFact label={t("forwarding.duration")}>{formatDuration(locale, record.durationMs)}</DetailFact>
        <DetailFact label={t("forwarding.requestedModel")}><code>{models.requested ?? t("forwarding.modelNotRecorded")}</code></DetailFact>
        <DetailFact label={t("forwarding.forwardedModel")}><code>{models.forwarded ?? t("forwarding.modelNotRecorded")}</code></DetailFact>
        <DetailFact label={t("forwarding.provider")}><span>{record.providerName ?? t("common.unknown")}</span>{record.providerId ? <code>{record.providerId}</code> : null}{providerSelection ? <small>{providerSelection}</small> : null}</DetailFact>
        <DetailFact label={t("forwarding.routeDecision")}><span>{routeLabel(record, t)}</span><small>{routeReasonLabel(record, t)}</small></DetailFact>
        <DetailFact label={t("forwarding.request")}><code>{record.method ?? "-"} {record.incomingUrl ?? displayPath(record)}</code></DetailFact>
        <DetailFact label={t("forwarding.targetUrl")}><code>{record.targetUrl ?? "-"}</code></DetailFact>
        <DetailFact label={t("forwarding.requestId")}><code>{record.requestId ?? "-"}</code></DetailFact>
        <DetailFact label={t("forwarding.upstreamRequestId")}><code>{record.upstreamRequestId ?? "-"}</code></DetailFact>
        <DetailFact label={t("forwarding.sessionId")}><code>{record.sessionId ?? "-"}</code></DetailFact>
        <DetailFact label={t("forwarding.threadId")}><code>{record.threadId ?? "-"}</code></DetailFact>
        <DetailFact label={t("forwarding.stream")}>{t(record.stream ? "common.yes" : "common.no")}</DetailFact>
        <DetailFact label={t("forwarding.transfer")}>{t("forwarding.transferBreakdown", { request: byteLabel(locale, record.requestBytes), response: byteLabel(locale, record.responseBytes) })}</DetailFact>
        <DetailFact label={t("forwarding.tokens")}>
          {t("forwarding.tokensBreakdown", { input: record.inputTokens === null ? "-" : formatNumber(locale, record.inputTokens), output: record.outputTokens === null ? "-" : formatNumber(locale, record.outputTokens) })}
          <small>{t("forwarding.usageStatus")}: {t(`forwarding.usage.${record.usageObservationStatus}`)}</small>
        </DetailFact>
      </dl>
    </div>
  );
}

function RecordDetails({
  record,
  detail,
  detailError,
  loading,
  locale,
  t,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onViewSession,
  onClose,
}: {
  record: ForwardingRecord;
  detail: ForwardingRecordDetail | null;
  detailError: ApiError | null;
  loading: boolean;
  locale: Locale;
  t: Translator;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onViewSession: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("summary");
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const models = modelValues(record);
  const available = detailError ? false : detail?.detailsAvailable ?? record.detailsAvailable;
  const fallback: ForwardingRecordPayload = { headers: {}, body: { content: "", encoding: "empty", bytes: 0, truncated: false } };

  useEffect(() => {
    setTab("summary");
    closeRef.current?.focus({ preventScroll: true });
  }, [record.id]);

  useEffect(() => {
    document.body.classList.add("record-detail-open");
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      document.body.classList.remove("record-detail-open");
      if (dialog?.open) dialog.close();
    };
  }, []);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="record-detail-dialog"
      aria-labelledby="forwarding-detail-title"
      data-testid="forwarding-record-detail-layer"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleDialogKeyDown}
    >
      <section
        className="record-detail-drawer"
        data-testid="forwarding-record-detail-drawer"
      >
        <header className="record-details-header">
          <div>
            <span className="record-detail-kicker">{t("forwarding.detailEyebrow")} · #{record.id}</span>
            <h2 id="forwarding-detail-title">{t("forwarding.details")}</h2>
            <p>{models.transformed ? `${models.requested} → ${models.forwarded}` : models.requested ?? t("forwarding.modelNotRecorded")}</p>
          </div>
          <div className="record-detail-header-actions">
            <StatusBadge tone={outcomeTone(record.outcome)}>{t(`forwarding.outcome.${record.outcome}`)}</StatusBadge>
            <button ref={closeRef} autoFocus className="icon-button" type="button" aria-label={t("common.close")} onClick={onClose}><X aria-hidden="true" /></button>
          </div>
        </header>

        <div className="record-detail-nav">
          <div className="record-detail-tabs" role="tablist" aria-label={t("forwarding.detailSections")}>
            {(["summary", "request", "response"] as DetailTab[]).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                data-testid={`forwarding-detail-tab-${item}`}
                className={tab === item ? "selected" : undefined}
                onClick={() => setTab(item)}
              >{t(`forwarding.tab.${item}`)}</button>
            ))}
          </div>
          <div className="record-detail-stepper" aria-label={t("forwarding.recordNavigation")}>
            <button type="button" data-testid="forwarding-detail-previous" disabled={!hasPrevious} onClick={onPrevious}><ArrowLeft aria-hidden="true" />{t("forwarding.previousRecord")}</button>
            <button type="button" data-testid="forwarding-detail-next" disabled={!hasNext} onClick={onNext}>{t("forwarding.nextRecord")}<ArrowRight aria-hidden="true" /></button>
          </div>
        </div>

        <div className="record-detail-scroll">
          {tab === "summary" ? <RecordSummary record={record} locale={locale} t={t} onViewSession={onViewSession} /> : null}
          {tab !== "summary" && loading ? (
            <div className="record-detail-loading" role="status"><RefreshCw className="spin" aria-hidden="true" />{t("forwarding.loadingDetail")}</div>
          ) : null}
          {tab !== "summary" && detailError ? (
            <div className="record-detail-failed" role="alert"><CircleAlert aria-hidden="true" /><div><strong>{t("forwarding.detailLoadFailed")}</strong><span>{t("forwarding.detailLoadFailedHelp")}</span></div></div>
          ) : null}
          {tab === "request" && !loading && !detailError ? (
            <DataPayload key={`request-${record.id}`} side="request" payload={normalizePayload(detail?.request ?? fallback)} available={available} locale={locale} t={t} record={record} />
          ) : null}
          {tab === "response" && !loading && !detailError ? (
            <DataPayload key={`response-${record.id}`} side="response" payload={normalizePayload(detail?.response ?? fallback)} available={available} locale={locale} t={t} record={record} />
          ) : null}
        </div>

        <p className="record-privacy-note"><LockKeyhole aria-hidden="true" />{t("forwarding.metadataOnly")}</p>
      </section>
    </dialog>
  );
}

function RecordModelOperation({ record, t }: { record: ForwardingRecord; t: Translator }) {
  const models = modelValues(record);
  return (
    <span className="record-model-operation">
      <span className={cx("record-model", models.transformed && "is-transformed")} title={
        models.transformed ? `${models.requested} → ${models.forwarded}` : models.requested ?? t("forwarding.modelNotRecorded")
      }>
        <code>{models.requested ?? t("forwarding.modelNotRecorded")}</code>
        {models.transformed ? <><ArrowRight aria-hidden="true" /><code>{models.forwarded}</code></> : null}
      </span>
      <small><strong>{record.method ?? "-"}</strong> <code>{displayPath(record)}</code></small>
    </span>
  );
}

function RecordTokens({ record, locale, t }: { record: ForwardingRecord; locale: Locale; t: Translator }) {
  return (
    <span className="record-tokens">
      <span><small>{t("forwarding.inputShort")}</small><b>{record.inputTokens === null ? "-" : formatNumber(locale, record.inputTokens)}</b></span>
      <span><small>{t("forwarding.outputShort")}</small><b>{record.outputTokens === null ? "-" : formatNumber(locale, record.outputTokens)}</b></span>
      <span><small>{t("forwarding.cacheShort")}</small><b>{record.cachedInputTokens === null ? "-" : formatNumber(locale, record.cachedInputTokens)}</b></span>
    </span>
  );
}

export function ForwardingRecordsPage({
  locale,
  t,
  providers = [],
  captureEnabled,
  captureDetailsEnabled,
  captureStatus,
  readOnly,
  pending,
  onLoad,
  onLoadDetail,
  onCaptureChange,
  onCaptureDetailsChange,
}: ForwardingRecordsProps) {
  const [data, setData] = useState<ForwardingRecordsPageData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [detailError, setDetailError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ForwardingOutcome>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [providerDraft, setProviderDraft] = useState("");
  const [timeRangeDraft, setTimeRangeDraft] = useState<TimeRange>("all");
  const [customSinceDraft, setCustomSinceDraft] = useState("");
  const [customUntilDraft, setCustomUntilDraft] = useState("");
  const [includeModelsDraft, setIncludeModelsDraft] = useState(false);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AppliedFilters>({ search: "", model: "", providerId: "", sessionId: "", timeRange: "all", includeModels: false });
  const [before, setBefore] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<number | null>>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [selectedDetail, setSelectedDetail] = useState<ForwardingRecordDetail | null>(null);
  const [captureSelection, setCaptureSelection] = useState(captureEnabled);
  const [captureDetailsSelection, setCaptureDetailsSelection] = useState(captureDetailsEnabled);
  const openerRef = useRef<HTMLElement | null>(null);
  const focusRevisionRef = useRef(0);
  const focusFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (pending !== "capture-setting") setCaptureSelection(captureEnabled);
  }, [captureEnabled, pending]);

  useEffect(() => {
    if (pending !== "capture-details-setting") setCaptureDetailsSelection(captureDetailsEnabled);
  }, [captureDetailsEnabled, pending]);

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const query: ForwardingRecordsQuery = {
      limit: 50,
      before,
      outcome,
      search: filters.search || undefined,
      includeModels: filters.includeModels,
      since: filters.since,
      until: filters.until,
      model: filters.model || undefined,
      providerId: filters.providerId || undefined,
      sessionId: filters.sessionId || undefined,
    };
    void onLoad(query, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setLastUpdatedAt(new Date().toISOString());
        setSelectedId((current) => {
          if (next.records.some((record) => record.id === current)) return current;
          setSelectedDetail(null);
          setDetailError(null);
          setDetailLoading(false);
          return null;
        });
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(asApiError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [before, filters, onLoad, outcome, refreshKey]);

  const records = data?.records ?? [];
  const selected = useMemo(() => records.find((record) => record.id === selectedId) ?? null, [records, selectedId]);
  const selectedIndex = selected ? records.findIndex((record) => record.id === selected.id) : -1;

  useEffect(() => {
    if (selectedId === null) {
      setSelectedDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setSelectedDetail(null);
    void onLoadDetail(selectedId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setSelectedDetail(detail);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setDetailError(asApiError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [detailRefreshKey, onLoadDetail, selectedId]);

  const selectRecord = (id: number, opener?: HTMLElement | null) => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    }
    focusRevisionRef.current += 1;
    if (opener) openerRef.current = opener;
    setSelectedDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setSelectedId(id);
    setDetailRefreshKey((value) => value + 1);
  };

  const dismissDetails = (restoreFocus: boolean) => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    }
    const active = document.activeElement;
    const shouldRestore = restoreFocus && (
      active === document.body || Boolean(active instanceof HTMLElement && active.closest("[data-testid='forwarding-record-detail-layer']"))
    );
    const opener = openerRef.current;
    const revision = ++focusRevisionRef.current;
    setSelectedDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    setSelectedId(null);
    if (!shouldRestore) return;
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (revision === focusRevisionRef.current && shouldRestore && document.activeElement === document.body && opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    });
  };

  const navigateRecord = (nextIndex: number) => {
    const nextRecord = records[nextIndex];
    if (!nextRecord) return;
    const possibleOpeners = Array.from(document.querySelectorAll<HTMLElement>(`[data-forwarding-record-id="${nextRecord.id}"]`));
    openerRef.current = possibleOpeners.find((element) => element.getClientRects().length > 0) ?? openerRef.current;
    selectRecord(nextRecord.id);
  };

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    const bounds = timeBounds(timeRangeDraft, customSinceDraft, customUntilDraft);
    if (!bounds.valid) {
      setFilterError(t("forwarding.invalidTimeRange"));
      return;
    }
    setFilterError(null);
    setHistory([]);
    setBefore(null);
    dismissDetails(false);
    setFilters({
      search: searchDraft.trim(),
      model: modelDraft.trim(),
      providerId: providerDraft,
      sessionId: filters.sessionId,
      timeRange: timeRangeDraft,
      since: bounds.since,
      until: bounds.until,
      includeModels: includeModelsDraft,
    });
  };

  const applySessionFilter = (sessionId: string) => {
    setHistory([]);
    setBefore(null);
    dismissDetails(false);
    setFilters((current) => ({ ...current, sessionId }));
  };

  const clearSessionFilter = () => {
    setHistory([]);
    setBefore(null);
    setFilters((current) => ({ ...current, sessionId: "" }));
  };

  const refreshRecords = () => {
    if (["hour", "day", "week", "month"].includes(filters.timeRange)) {
      const bounds = timeBounds(filters.timeRange, "", "");
      setFilters((current) => ({ ...current, since: bounds.since, until: undefined }));
      return;
    }
    setRefreshKey((value) => value + 1);
  };

  const selectOutcome = (next: ForwardingOutcome) => {
    setOutcome(next);
    setHistory([]);
    setBefore(null);
  };

  const nextPage = () => {
    if (data?.page.nextBefore === null || data?.page.nextBefore === undefined) return;
    setHistory((current) => [...current, before]);
    setBefore(data.page.nextBefore);
  };

  const previousPage = () => setHistory((current) => {
    if (current.length === 0) return current;
    setBefore(current.at(-1) ?? null);
    return current.slice(0, -1);
  });

  const toggleCapture = async (enabled: boolean) => {
    setCaptureSelection(enabled);
    if (!(await onCaptureChange(enabled))) setCaptureSelection(!enabled);
    else if (!enabled) setCaptureDetailsSelection(false);
    else setRefreshKey((value) => value + 1);
  };

  const toggleCaptureDetails = async (enabled: boolean) => {
    setCaptureDetailsSelection(enabled);
    if (!(await onCaptureDetailsChange(enabled))) setCaptureDetailsSelection(!enabled);
    else setRefreshKey((value) => value + 1);
  };

  const summary = data?.summary ?? { total: 0, success: 0, rejected: 0, aborted: 0, error: 0 };
  const outcomeOptions: ForwardingOutcome[] = ["all", "success", "rejected", "aborted", "error"];
  const initialLoading = loading && data === null;
  const refreshing = loading && data !== null;

  return (
    <div className="page-stack forwarding-page" data-testid="page-forwarding-records">
      <PageHeader title={t("forwarding.title")} subtitle={t("forwarding.subtitle")} />

      <Panel className="forwarding-command-panel">
        <div className="forwarding-status-bar">
          <div className="forwarding-capture-summary">
            <span className={cx("capture-status-dot", captureSelection && "is-active")} aria-hidden="true" />
            <div><strong>{t(captureSelection ? "forwarding.captureActive" : "forwarding.captureInactive")}</strong><span>{t(captureDetailsSelection ? "forwarding.captureSummaryDetails" : "forwarding.captureSummaryMetadata")}</span></div>
          </div>
          <div className="forwarding-summary" aria-label={t("forwarding.summary")}>
            <span><strong>{formatNumber(locale, summary.total)}</strong>{t("forwarding.total")}</span>
            <span className="summary-success"><strong>{formatNumber(locale, summary.success)}</strong>{t("forwarding.outcome.success")}</span>
            <span className="summary-rejected"><strong>{formatNumber(locale, summary.rejected)}</strong>{t("forwarding.outcome.rejected")}</span>
            <span className="summary-aborted"><strong>{formatNumber(locale, summary.aborted)}</strong>{t("forwarding.outcome.aborted")}</span>
            <span className="summary-error"><strong>{formatNumber(locale, summary.error)}</strong>{t("forwarding.outcome.error")}</span>
          </div>
          <div className="forwarding-refresh-slot">
            <span className="forwarding-updated" role="status">
              {refreshing ? t("forwarding.refreshing") : lastUpdatedAt ? t("forwarding.updatedAt", { value: formatDate(locale, lastUpdatedAt) }) : t("forwarding.notUpdated")}
            </span>
            <button type="button" className="icon-button" aria-label={t("common.refresh")} data-testid="forwarding-refresh" disabled={loading} onClick={refreshRecords}>
              <RefreshCw className={loading ? "spin" : undefined} aria-hidden="true" />
            </button>
          </div>
        </div>
        <p className="forwarding-summary-scope"><Filter aria-hidden="true" />{t("forwarding.summaryScope")}</p>
        <details className="capture-settings" data-testid="forwarding-capture-settings">
          <summary data-testid="forwarding-capture-settings-toggle"><Settings2 aria-hidden="true" /><span>{t("forwarding.captureSettings")}</span><small>{t("forwarding.privacyHint")}</small><ChevronDown aria-hidden="true" /></summary>
          <div className="capture-settings-grid">
            <div className={cx("capture-control", captureSelection && "capture-control-active")}>
              <div className="capture-indicator"><Database aria-hidden="true" /></div>
              <div><strong>{t("forwarding.capture")}</strong><span>{t(captureSelection ? "forwarding.captureOn" : "forwarding.captureOff")}</span></div>
              <label className="compact-switch"><input type="checkbox" checked={captureSelection} disabled={readOnly || pending !== null} aria-label={t("forwarding.capture")} onChange={(event) => void toggleCapture(event.target.checked)} /><span aria-hidden="true"><span /></span></label>
            </div>
            <div className={cx("capture-control", "capture-detail-control", !captureSelection && "is-disabled")}>
              <div className="capture-indicator"><FileJson aria-hidden="true" /></div>
              <div><strong>{t("forwarding.captureDetails")}</strong><span>{t(captureDetailsSelection ? "forwarding.captureDetailsOn" : "forwarding.captureDetailsOff")}</span></div>
              <label className="compact-switch"><input type="checkbox" checked={captureDetailsSelection} disabled={!captureSelection || readOnly || pending !== null} aria-label={t("forwarding.captureDetails")} onChange={(event) => void toggleCaptureDetails(event.target.checked)} /><span aria-hidden="true"><span /></span></label>
            </div>
          </div>
        </details>
      </Panel>

      {captureStatus.configured && captureStatus.state !== "stopped" && !captureStatus.active ? (
        <Notice title={t("forwarding.captureMismatchTitle")} tone="warning"><p>{t("forwarding.captureMismatchHelp")}</p></Notice>
      ) : null}

      <Panel className="records-panel">
        <div className="records-toolbar">
          <div className="records-toolbar-heading"><span className="eyebrow">{t("forwarding.ledgerEyebrow")}</span><strong>{t("forwarding.recordsTitle")}</strong></div>
          <div className="segmented-control records-outcome-filter" aria-label={t("forwarding.filterOutcome")}>
            {outcomeOptions.map((option) => (
              <button key={option} type="button" className={outcome === option ? "selected" : undefined} aria-pressed={outcome === option} data-testid={`forwarding-outcome-${option}`} onClick={() => selectOutcome(option)}>{t(`forwarding.filter.${option}`)}</button>
            ))}
          </div>
        </div>

        <form className="records-filter-form" role="search" onSubmit={applyFilters}>
          <label className="records-search"><Search aria-hidden="true" /><span className="visually-hidden">{t("forwarding.search")}</span><input value={searchDraft} maxLength={100} data-testid="forwarding-search" placeholder={t("forwarding.searchPlaceholder")} onChange={(event) => setSearchDraft(event.target.value)} /></label>
          <label className="records-filter-field"><span>{t("forwarding.timeRange")}</span><select data-testid="forwarding-time-range" value={timeRangeDraft} onChange={(event) => setTimeRangeDraft(event.target.value as TimeRange)}>{(["all", "hour", "day", "week", "month", "custom"] as TimeRange[]).map((range) => <option key={range} value={range}>{t(`forwarding.timeRange.${range}`)}</option>)}</select></label>
          <label className="records-filter-field"><span>{t("forwarding.modelFilter")}</span><input value={modelDraft} maxLength={256} data-testid="forwarding-model-filter" placeholder={t("forwarding.modelFilterPlaceholder")} onChange={(event) => setModelDraft(event.target.value)} /></label>
          <label className="records-filter-field"><span>{t("forwarding.providerFilter")}</span><select data-testid="forwarding-provider-filter" value={providerDraft} onChange={(event) => setProviderDraft(event.target.value)}><option value="">{t("forwarding.providerAll")}</option><option value="chatgpt-account">{t("forwarding.route.account")}</option>{providers.filter((provider) => provider.id !== "chatgpt-account").map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
          <label className="records-model-filter"><input type="checkbox" checked={includeModelsDraft} onChange={(event) => setIncludeModelsDraft(event.target.checked)} /><span>{t("forwarding.showModelRequests")}</span></label>
          <Button type="submit" className="button-small records-apply-filter" data-testid="forwarding-apply-filters">{t("forwarding.applyFilters")}</Button>
          {timeRangeDraft === "custom" ? (
            <div className="records-custom-range" data-testid="forwarding-custom-time-range"><label><span>{t("forwarding.since")}</span><input type="datetime-local" value={customSinceDraft} onChange={(event) => setCustomSinceDraft(event.target.value)} /></label><ArrowRight aria-hidden="true" /><label><span>{t("forwarding.until")}</span><input type="datetime-local" value={customUntilDraft} onChange={(event) => setCustomUntilDraft(event.target.value)} /></label></div>
          ) : null}
          {filterError ? <p className="records-filter-error" role="alert">{filterError}</p> : null}
        </form>

        {filters.sessionId ? (
          <div className="records-active-filters" data-testid="forwarding-session-filter">
            <span>{t("forwarding.sessionFilter")} <code>{filters.sessionId}</code></span>
            <button type="button" data-testid="forwarding-clear-session-filter" onClick={clearSessionFilter}><X aria-hidden="true" />{t("forwarding.clearSessionFilter")}</button>
          </div>
        ) : null}

        {error ? <div className={cx("records-state", data && "records-state-inline")}><ErrorNotice error={error} t={t} /></div> : null}

        {!error && !initialLoading && records.length === 0 ? (
          <div className="records-state"><EmptyState icon={<FileClock aria-hidden="true" />} title={t(data?.storageState === "missing" ? "forwarding.noDatabase" : "forwarding.empty")} description={t(captureSelection ? "forwarding.emptyHelp" : "forwarding.enableHelp")} /></div>
        ) : null}

        {initialLoading ? (
          <div className="records-skeleton" aria-label={t("common.loading")} aria-busy="true" data-testid="forwarding-initial-loading">{Array.from({ length: 7 }, (_, index) => <span key={index} />)}</div>
        ) : null}

        {records.length > 0 ? (
          <>
            <div className="records-table-wrap" aria-busy={refreshing || undefined}>
              <table className="records-table">
                <caption className="visually-hidden">{t("forwarding.tableCaption")}</caption>
                <thead><tr><th>{t("forwarding.time")}</th><th>{t("forwarding.modelOperation")}</th><th>{t("forwarding.result")}</th><th>{t("forwarding.provider")}</th><th>{t("forwarding.duration")}</th><th>{t("forwarding.tokens")}</th></tr></thead>
                <tbody>
                  {records.map((record) => {
                    const startedAt = recordTimeParts(locale, record.startedAt);
                    return (
                      <tr
                        key={record.id}
                        tabIndex={0}
                        className={record.id === selectedId ? "selected" : undefined}
                        aria-selected={record.id === selectedId}
                        aria-label={t("forwarding.openRecord", { value: record.id })}
                        data-forwarding-record-id={record.id}
                        data-testid={`forwarding-record-row-${record.id}`}
                        onClick={(event) => selectRecord(record.id, event.currentTarget)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectRecord(record.id, event.currentTarget);
                          }
                        }}
                      >
                        <td><time className="record-time" dateTime={record.startedAt ?? undefined}><span>{startedAt.date}</span><strong>{startedAt.time}</strong></time></td>
                        <td><RecordModelOperation record={record} t={t} /></td>
                        <td><span className="record-result"><StatusBadge tone={outcomeTone(record.outcome)}>{t(`forwarding.outcome.${record.outcome}`)}</StatusBadge><small>{t("forwarding.httpShort")} <code>{record.responseStatus ?? "—"}</code></small></span></td>
                        <td><span className="record-provider-cell"><span className="record-provider"><i className={cx("route-dot", `route-dot-${record.route}`)} aria-hidden="true" />{record.providerName ?? t("common.unknown")}</span><small>{routeLabel(record, t)}</small></span></td>
                        <td><span className="record-duration"><Clock3 aria-hidden="true" />{formatDuration(locale, record.durationMs)}</span></td>
                        <td><RecordTokens record={record} locale={locale} t={t} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="records-mobile-list" data-testid="forwarding-mobile-list">
              {records.map((record) => {
                const startedAt = recordTimeParts(locale, record.startedAt);
                const models = modelValues(record);
                return (
                  <button key={record.id} type="button" className={cx("record-mobile-card", record.id === selectedId && "selected")} data-forwarding-record-id={record.id} data-testid={`forwarding-record-card-${record.id}`} onClick={(event) => selectRecord(record.id, event.currentTarget)}>
                    <span className="record-mobile-primary"><StatusBadge tone={outcomeTone(record.outcome)}>{t(`forwarding.outcome.${record.outcome}`)}</StatusBadge><code>{models.requested ?? t("forwarding.modelNotRecorded")}</code><span><Clock3 aria-hidden="true" />{formatDuration(locale, record.durationMs)}</span></span>
                    <span className="record-mobile-secondary"><time dateTime={record.startedAt ?? undefined}>{startedAt.date} {startedAt.time}</time><span>{record.providerName ?? t("common.unknown")}</span><code>{record.method ?? "-"} {displayPath(record)}</code></span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        <div className="records-pagination">
          <span>{history.length === 0 ? t("forwarding.latest") : t("forwarding.page", { value: history.length + 1 })}</span>
          <div><Button className="button-small" disabled={history.length === 0 || loading} onClick={previousPage}><ArrowLeft className="icon" aria-hidden="true" />{t("common.previous")}</Button><Button className="button-small" disabled={data?.page.nextBefore === null || loading} onClick={nextPage}>{t("common.next")}<ArrowRight className="icon" aria-hidden="true" /></Button></div>
        </div>
      </Panel>

      {selected ? (
        <RecordDetails
          record={selected}
          detail={selectedDetail}
          detailError={detailError}
          loading={detailLoading}
          locale={locale}
          t={t}
          hasPrevious={selectedIndex > 0}
          hasNext={selectedIndex >= 0 && selectedIndex < records.length - 1}
          onPrevious={() => navigateRecord(selectedIndex - 1)}
          onNext={() => navigateRecord(selectedIndex + 1)}
          onViewSession={() => selected.sessionId && applySessionFilter(selected.sessionId)}
          onClose={() => dismissDetails(true)}
        />
      ) : null}
    </div>
  );
}
