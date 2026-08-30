import {
  ArrowLeft,
  ArrowRight,
  Braces,
  CircleAlert,
  Clock3,
  Database,
  FileClock,
  FileJson,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ApiError, asApiError } from "../api";
import {
  Button,
  EmptyState,
  ErrorNotice,
  IconButton,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
  cx,
} from "../components/Primitives";
import { formatDuration, formatNumber, type Translator } from "../i18n";
import type {
  ForwardingOutcome,
  ForwardingRecord,
  ForwardingRecordDetail,
  ForwardingRecordPayload,
  ForwardingRecordsPageData,
  ForwardingRecordsQuery,
  Locale,
  StatusResponse,
} from "../types";

type ForwardingRecordsProps = {
  locale: Locale;
  t: Translator;
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
  if (record.routeReason === "not_chatgpt_auth") return t("forwarding.reason.notChatgptAuth");
  if (record.routeReason === "unsupported_operation") return t("forwarding.reason.unsupportedOperation");
  if (record.routeReason === "unsupported_account_model") return t("forwarding.reason.unsupportedAccountModel");
  if (record.routeReason === "unsupported_method") return t("forwarding.reason.unsupportedMethod");
  if (record.routeReason === "unsupported_path") return t("forwarding.reason.unsupportedPath");
  if (record.routeReason === "custom_only") return t("forwarding.reason.customOnly");
  return t("forwarding.reason.legacy");
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
  if (bytes < 1_048_576)
    return `${formatNumber(locale, Math.round(bytes / 1_024))} KB`;
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
    transformed:
      requested !== null && forwarded !== null && requested !== forwarded,
  };
}
function prettyBody(
  content: string,
  encoding: string
): { text: string; json: boolean } {
  if (!content || !/utf-?8|text|json/i.test(encoding))
    return { text: content, json: false };
  try {
    return { text: JSON.stringify(JSON.parse(content), null, 2), json: true };
  } catch {
    return { text: content, json: false };
  }
}
function normalizePayload(value: unknown): ForwardingRecordPayload {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const bodySource =
    source.body &&
    typeof source.body === "object" &&
    !Array.isArray(source.body)
      ? (source.body as Record<string, unknown>)
      : source;
  const headers =
    source.headers &&
    typeof source.headers === "object" &&
    !Array.isArray(source.headers)
      ? (source.headers as Record<string, string | string[]>)
      : {};
  return {
    headers,
    body: {
      content: typeof bodySource.content === "string" ? bodySource.content : "",
      encoding:
        typeof bodySource.encoding === "string" ? bodySource.encoding : "empty",
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
  return (
    <article
      className="record-data-pane"
      data-testid={`forwarding-${side}-data`}
    >
      <header className="record-data-heading">
        <div className="record-data-title">
          {side === "request" ? (
            <ArrowRight aria-hidden="true" />
          ) : (
            <ArrowLeft aria-hidden="true" />
          )}
          <div>
            <span>{t(`forwarding.${side}`)}</span>
            <strong>
              {side === "request"
                ? `${record.method ?? "-"} ${displayPath(record)}`
                : `${record.responseStatus ?? "-"} ${t("forwarding.response")}`}
            </strong>
          </div>
        </div>
        <span
          className={cx(
            "capture-state",
            available ? "capture-state-on" : "capture-state-off"
          )}
        >
          {available ? (
            <ShieldCheck aria-hidden="true" />
          ) : (
            <LockKeyhole aria-hidden="true" />
          )}
          {available
            ? t("forwarding.detailAvailable")
            : t("forwarding.detailNotAvailable")}
        </span>
      </header>
      {!available ? (
        <div className="record-data-empty">
          <LockKeyhole aria-hidden="true" />
          <strong>{t("forwarding.detailNotCaptured")}</strong>
          <p>{t("forwarding.detailNotCapturedHelp")}</p>
        </div>
      ) : null}
      <div
        className="record-payload-meta"
        aria-label={t("forwarding.payloadInfo")}
      >
        <span>
          <b>{t("forwarding.headers")}</b>
          {formatNumber(locale, headerEntries.length)}
        </span>
        <span>
          <b>{t("forwarding.encoding")}</b>
          <code>{payload.body.encoding || "-"}</code>
        </span>
        <span>
          <b>{t("forwarding.bytes")}</b>
          {byteLabel(locale, payload.body.bytes)}
        </span>
        {payload.body.truncated ? (
          <span className="payload-warning">{t("forwarding.truncated")}</span>
        ) : null}
      </div>
      <div className="record-payload-grid">
        <section>
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
                    <dd>
                      <code>
                        {Array.isArray(value) ? value.join(", ") : value}
                      </code>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="payload-muted">{t("forwarding.noHeaders")}</p>
            )}
          </details>
        </section>
        <section className="record-body-section">
          <h4>
            <FileJson aria-hidden="true" />
            {t("forwarding.body")}
            {body.json ? <span>{t("forwarding.jsonFormatted")}</span> : null}
          </h4>
          {payload.body.content ? (
            <pre className={cx("record-body", !body.json && "record-body-raw")}>
              <code>{body.text}</code>
            </pre>
          ) : (
            <p className="payload-muted">{t("forwarding.noBody")}</p>
          )}
        </section>
      </div>
    </article>
  );
}
function RecordDetails({
  record,
  detail,
  detailError,
  loading,
  locale,
  t,
  onClose,
}: {
  record: ForwardingRecord;
  detail: ForwardingRecordDetail | null;
  detailError: ApiError | null;
  loading: boolean;
  locale: Locale;
  t: Translator;
  onClose: () => void;
}) {
  const models = modelValues(record);
  const providerSelection = selectionReasonLabel(record, t);
  const available = detailError
    ? false
    : detail?.detailsAvailable ?? record.detailsAvailable;
  const fallback: ForwardingRecordPayload = {
    headers: {},
    body: { content: "", encoding: "utf-8", bytes: 0, truncated: false },
  };
  return (
    <section
      className="record-details-section"
      aria-label={t("forwarding.details")}
      data-testid="forwarding-record-details"
    >
      <header className="record-details-header">
        <div>
          <span className="record-detail-kicker">
            {t("forwarding.detailEyebrow")} · #{record.id}
          </span>
          <h2>{t("forwarding.details")}</h2>
          <p>
            {models.transformed
              ? `${models.requested} → ${models.forwarded}`
              : models.requested ?? t("forwarding.modelNotRecorded")}
          </p>
        </div>
        <div className="record-detail-header-actions">
          <StatusBadge tone={outcomeTone(record.outcome)}>
            {t(`forwarding.outcome.${record.outcome}`)}
          </StatusBadge>
          <IconButton label={t("common.close")} onClick={onClose}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
      </header>
      <div className="record-detail-meta">
        <span>
          <b>{t("forwarding.request")}</b>
          <code>
            {record.method ?? "-"} {record.incomingUrl ?? displayPath(record)}
          </code>
        </span>
        <span>
          <b>{t("forwarding.targetUrl")}</b>
          <code>{record.targetUrl ?? "-"}</code>
        </span>
        <span>
          <b>{t("forwarding.sessionId")}</b>
          <code>{record.sessionId ?? "-"}</code>
        </span>
        <span>
          <b>{t("forwarding.provider")}</b>
          <span className="record-provider-detail">
            {record.providerName ?? t("common.unknown")}
            {providerSelection ? (
              <small>{providerSelection}</small>
            ) : null}
          </span>
        </span>
        <span>
          <b>{t("forwarding.routeDecision")}</b>
          <span className="record-provider-detail">
            {t(record.route === "account"
              ? "forwarding.route.account"
              : record.route === "custom"
                ? "forwarding.route.custom"
                : "forwarding.route.unknown")}
            <small>{routeReasonLabel(record, t)}</small>
          </span>
        </span>
        <span>
          <b>{t("forwarding.duration")}</b>
          {formatDuration(locale, record.durationMs)}
        </span>
        <span>
          <b>{t("forwarding.result")}</b>
          <code>{record.responseStatus ?? "-"}</code>
        </span>
      </div>
      {loading ? (
        <div className="record-detail-loading">
          <RefreshCw className="spin" aria-hidden="true" />
          {t("forwarding.loadingDetail")}
        </div>
      ) : null}
      {detailError ? (
        <div className="record-detail-failed">
          <CircleAlert aria-hidden="true" />
          <div>
            <strong>{t("forwarding.detailLoadFailed")}</strong>
            <span>{t("forwarding.detailLoadFailedHelp")}</span>
          </div>
        </div>
      ) : null}
      {!loading ? (
        <div className="record-data-grid">
          <DataPayload
            side="request"
            payload={normalizePayload(detail?.request ?? fallback)}
            available={available}
            locale={locale}
            t={t}
            record={record}
          />
          <DataPayload
            side="response"
            payload={normalizePayload(detail?.response ?? fallback)}
            available={available}
            locale={locale}
            t={t}
            record={record}
          />
        </div>
      ) : null}
      <p className="record-privacy-note">
        <LockKeyhole aria-hidden="true" />
        {t("forwarding.metadataOnly")}
      </p>
    </section>
  );
}

export function ForwardingRecordsPage({
  locale,
  t,
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
  const [outcome, setOutcome] = useState<ForwardingOutcome>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [showModelRequests, setShowModelRequests] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<number | null>>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [selectedDetail, setSelectedDetail] =
    useState<ForwardingRecordDetail | null>(null);
  const [captureSelection, setCaptureSelection] = useState(captureEnabled);
  const [captureDetailsSelection, setCaptureDetailsSelection] = useState(
    captureDetailsEnabled
  );
  useEffect(() => {
    if (pending !== "capture-setting") setCaptureSelection(captureEnabled);
  }, [captureEnabled, pending]);
  useEffect(() => {
    if (pending !== "capture-details-setting")
      setCaptureDetailsSelection(captureDetailsEnabled);
  }, [captureDetailsEnabled, pending]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void onLoad(
      { limit: 50, before, outcome, search, includeModels: showModelRequests },
      controller.signal
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
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
  }, [before, onLoad, outcome, refreshKey, search, showModelRequests]);
  const selected = useMemo(
    () => data?.records.find((record) => record.id === selectedId) ?? null,
    [data, selectedId]
  );
  useEffect(() => {
    if (!selected) {
      setSelectedDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setSelectedDetail(null);
    void onLoadDetail(selected.id, controller.signal)
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
  }, [detailRefreshKey, onLoadDetail, selected]);
  const selectRecord = (id: number) => {
    setSelectedDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setSelectedId(id);
    setDetailRefreshKey((value) => value + 1);
  };
  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setHistory([]);
    setBefore(null);
    setSearch(searchDraft.trim());
  };
  const selectOutcome = (next: ForwardingOutcome) => {
    setOutcome(next);
    setHistory([]);
    setBefore(null);
  };
  const nextPage = () => {
    if (data?.page.nextBefore === null || data?.page.nextBefore === undefined)
      return;
    setHistory((current) => [...current, before]);
    setBefore(data.page.nextBefore);
  };
  const previousPage = () =>
    setHistory((current) => {
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
    if (!(await onCaptureDetailsChange(enabled)))
      setCaptureDetailsSelection(!enabled);
    else setRefreshKey((value) => value + 1);
  };
  const records = data?.records ?? [];
  const summary = data?.summary ?? {
    total: 0,
    success: 0,
    rejected: 0,
    aborted: 0,
    error: 0,
  };
  const outcomeOptions: ForwardingOutcome[] = [
    "all",
    "success",
    "rejected",
    "aborted",
    "error",
  ];
  return (
    <div
      className="page-stack forwarding-page"
      data-testid="page-forwarding-records"
    >
      <PageHeader
        title={t("forwarding.title")}
        subtitle={t("forwarding.subtitle")}
      />
      <Panel className="forwarding-command-panel">
        <div className="forwarding-command-bar">
          <div
            className={cx(
              "capture-control",
              captureSelection && "capture-control-active"
            )}
          >
            <div className="capture-indicator">
              <Database aria-hidden="true" />
            </div>
            <div>
              <strong>{t("forwarding.capture")}</strong>
              <span>
                {t(
                  captureSelection
                    ? "forwarding.captureOn"
                    : "forwarding.captureOff"
                )}
              </span>
            </div>
            <label className="compact-switch">
              <input
                type="checkbox"
                checked={captureSelection}
                disabled={readOnly || pending !== null}
                aria-label={t("forwarding.capture")}
                onChange={(event) => void toggleCapture(event.target.checked)}
              />
              <span aria-hidden="true">
                <span />
              </span>
            </label>
          </div>
          <div
            className={cx(
              "capture-control",
              "capture-detail-control",
              !captureSelection && "is-disabled"
            )}
          >
            <div className="capture-indicator">
              <FileJson aria-hidden="true" />
            </div>
            <div>
              <strong>{t("forwarding.captureDetails")}</strong>
              <span>
                {t(
                  captureDetailsSelection
                    ? "forwarding.captureDetailsOn"
                    : "forwarding.captureDetailsOff"
                )}
              </span>
            </div>
            <label className="compact-switch">
              <input
                type="checkbox"
                checked={captureDetailsSelection}
                disabled={!captureSelection || readOnly || pending !== null}
                aria-label={t("forwarding.captureDetails")}
                onChange={(event) =>
                  void toggleCaptureDetails(event.target.checked)
                }
              />
              <span aria-hidden="true">
                <span />
              </span>
            </label>
          </div>
          <div
            className="forwarding-summary"
            aria-label={t("forwarding.summary")}
          >
            <span>
              <strong>{formatNumber(locale, summary.total)}</strong>
              {t("forwarding.total")}
            </span>
            <span className="summary-success">
              <strong>{formatNumber(locale, summary.success)}</strong>
              {t("forwarding.outcome.success")}
            </span>
            <span className="summary-error">
              <strong>{formatNumber(locale, summary.error)}</strong>
              {t("forwarding.outcome.error")}
            </span>
          </div>
          <IconButton
            label={t("common.refresh")}
            disabled={loading}
            onClick={() => setRefreshKey((value) => value + 1)}
          >
            <RefreshCw
              className={loading ? "spin" : undefined}
              aria-hidden="true"
            />
          </IconButton>
        </div>
        <div className="forwarding-command-footer">
          <span className="privacy-inline">
            <ShieldCheck aria-hidden="true" />
            {t("forwarding.privacyHint")}
          </span>
          <label className="records-model-filter">
            <input
              type="checkbox"
              checked={showModelRequests}
              onChange={(event) => setShowModelRequests(event.target.checked)}
            />
            <span>{t("forwarding.showModelRequests")}</span>
          </label>
        </div>
      </Panel>
      {captureStatus.configured &&
      captureStatus.state !== "stopped" &&
      !captureStatus.active ? (
        <Notice title={t("forwarding.captureMismatchTitle")} tone="warning">
          <p>{t("forwarding.captureMismatchHelp")}</p>
        </Notice>
      ) : null}
      <Panel className="records-panel">
        <div className="records-toolbar">
          <div className="records-toolbar-heading">
            <span className="eyebrow">{t("forwarding.ledgerEyebrow")}</span>
            <strong>{t("forwarding.recordsTitle")}</strong>
          </div>
          <div className="records-tools">
            <div
              className="segmented-control"
              aria-label={t("forwarding.filterOutcome")}
            >
              {outcomeOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={outcome === option ? "selected" : undefined}
                  aria-pressed={outcome === option}
                  onClick={() => selectOutcome(option)}
                >
                  {t(`forwarding.filter.${option}`)}
                </button>
              ))}
            </div>
            <form
              className="records-search"
              role="search"
              onSubmit={applySearch}
            >
              <Search aria-hidden="true" />
              <input
                value={searchDraft}
                maxLength={100}
                aria-label={t("forwarding.search")}
                placeholder={t("forwarding.searchPlaceholder")}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
              <Button type="submit" className="button-small">
                {t("common.search")}
              </Button>
            </form>
          </div>
        </div>
        {error ? (
          <div className="records-state">
            <ErrorNotice error={error} t={t} />
          </div>
        ) : null}
        {!error && !loading && records.length === 0 ? (
          <div className="records-state">
            <EmptyState
              icon={<FileClock aria-hidden="true" />}
              title={t(
                data?.storageState === "missing"
                  ? "forwarding.noDatabase"
                  : "forwarding.empty"
              )}
              description={t(
                captureSelection
                  ? "forwarding.emptyHelp"
                  : "forwarding.enableHelp"
              )}
            />
          </div>
        ) : null}
        {!error && (loading || records.length > 0) ? (
          <div
            className="records-table-wrap table-scroll"
            aria-busy={loading || undefined}
          >
            <table className="records-table">
              <caption className="visually-hidden">
                {t("forwarding.tableCaption")}
              </caption>
              <thead>
                <tr>
                  <th>{t("forwarding.time")}</th>
                  <th>{t("forwarding.request")}</th>
                  <th>{t("forwarding.routeDecision")}</th>
                  <th>{t("forwarding.result")}</th>
                  <th>{t("forwarding.model")}</th>
                  <th>{t("forwarding.sessionId")}</th>
                  <th>{t("forwarding.provider")}</th>
                  <th>{t("forwarding.tokens")}</th>
                  <th>{t("forwarding.duration")}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => {
                  const models = modelValues(record);
                  const providerSelection = selectionReasonLabel(record, t);
                  const startedAt = recordTimeParts(locale, record.startedAt);
                  return (
                    <tr
                      key={record.id}
                      className={
                        record.id === selectedId ? "selected" : undefined
                      }
                      tabIndex={0}
                      aria-selected={record.id === selectedId}
                      onClick={() => selectRecord(record.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectRecord(record.id);
                        }
                      }}
                    >
                      <td>
                        <time
                          className="record-time"
                          dateTime={record.startedAt ?? undefined}
                        >
                          <span>{startedAt.date}</span>
                          <strong>{startedAt.time}</strong>
                        </time>
                      </td>
                      <td>
                        <span className="record-open">
                          <strong>{record.method ?? "-"}</strong>
                          <code>{displayPath(record)}</code>
                        </span>
                      </td>
                      <td>
                        <span className="record-route-decision">
                          <span className="record-provider">
                            <i
                              className={cx("route-dot", `route-dot-${record.route}`)}
                              aria-hidden="true"
                            />
                            {t(record.route === "account"
                              ? "forwarding.route.account"
                              : record.route === "custom"
                                ? "forwarding.route.custom"
                                : "forwarding.route.unknown")}
                          </span>
                          <small>{routeReasonLabel(record, t)}</small>
                        </span>
                      </td>
                      <td>
                        <span className="record-result">
                          <StatusBadge tone={outcomeTone(record.outcome)}>
                            {t(`forwarding.outcome.${record.outcome}`)}
                          </StatusBadge>
                          <code>{record.responseStatus ?? "-"}</code>
                        </span>
                      </td>
                      <td>
                        <span
                          className={cx(
                            "record-model",
                            models.transformed && "is-transformed"
                          )}
                          title={
                            models.transformed
                              ? `${models.requested} → ${models.forwarded}`
                              : models.requested ??
                                t("forwarding.modelNotRecorded")
                          }
                        >
                          <code>
                            {models.requested ??
                              t("forwarding.modelNotRecorded")}
                          </code>
                          {models.transformed ? (
                            <>
                              <ArrowRight aria-hidden="true" />
                              <code>{models.forwarded}</code>
                            </>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        <code className="record-session-id">
                          {record.sessionId ?? "-"}
                        </code>
                      </td>
                      <td>
                        <span className="record-provider-cell">
                          <span className="record-provider">
                            {record.providerName ?? t("common.unknown")}
                          </span>
                          {providerSelection ? (
                            <small>{providerSelection}</small>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        <span className="record-tokens">
                          <span>
                            <b>
                              {record.inputTokens === null
                                ? "-"
                                : formatNumber(locale, record.inputTokens)}
                            </b>
                            <small>{t("forwarding.inputShort")}</small>
                          </span>
                          <span>
                            <b>
                              {record.outputTokens === null
                                ? "-"
                                : formatNumber(locale, record.outputTokens)}
                            </b>
                            <small>{t("forwarding.outputShort")}</small>
                          </span>
                          <span>
                            <b>
                              {record.cachedInputTokens === null
                                ? "-"
                                : formatNumber(
                                    locale,
                                    record.cachedInputTokens
                                  )}
                            </b>
                            <small>{t("forwarding.cacheShort")}</small>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="record-duration">
                          <Clock3 aria-hidden="true" />
                          {formatDuration(locale, record.durationMs)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {loading && records.length === 0 ? (
              <div className="table-loading">{t("common.loading")}</div>
            ) : null}
          </div>
        ) : null}
        <div className="records-pagination">
          <span>
            {history.length === 0
              ? t("forwarding.latest")
              : t("forwarding.page", { value: history.length + 1 })}
          </span>
          <div>
            <Button
              className="button-small"
              disabled={history.length === 0 || loading}
              onClick={previousPage}
            >
              <ArrowLeft className="icon" aria-hidden="true" />
              {t("common.previous")}
            </Button>
            <Button
              className="button-small"
              disabled={data?.page.nextBefore === null || loading}
              onClick={nextPage}
            >
              {t("common.next")}
              <ArrowRight className="icon" aria-hidden="true" />
            </Button>
          </div>
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
        onClose={() => {
          setSelectedDetail(null);
          setDetailError(null);
          setDetailLoading(false);
          setSelectedId(null);
        }}
        />
      ) : (
        <section
          className="record-details-section record-detail-empty"
          aria-label={t("forwarding.details")}
        >
          <FileClock aria-hidden="true" />
          <strong>{t("forwarding.selectRecord")}</strong>
          <span>{t("forwarding.selectRecordHelp")}</span>
        </section>
      )}
    </div>
  );
}
