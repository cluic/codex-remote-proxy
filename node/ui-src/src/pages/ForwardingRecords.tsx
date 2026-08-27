import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Clock3,
  Database,
  FileClock,
  RefreshCw,
  Search,
  X
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
  cx
} from "../components/Primitives";
import { formatDate, formatDuration, formatNumber, type Translator } from "../i18n";
import type {
  ForwardingOutcome,
  ForwardingRecord,
  ForwardingRecordsPageData,
  ForwardingRecordsQuery,
  Locale,
  StatusResponse
} from "../types";

type ForwardingRecordsProps = {
  locale: Locale;
  t: Translator;
  captureEnabled: boolean;
  captureStatus: StatusResponse["capture"];
  readOnly: boolean;
  pending: string | null;
  onLoad: (
    query: ForwardingRecordsQuery,
    signal?: AbortSignal
  ) => Promise<ForwardingRecordsPageData>;
  onCaptureChange: (enabled: boolean) => Promise<boolean>;
};

function outcomeTone(outcome: ForwardingRecord["outcome"]): "success" | "warning" | "danger" | "neutral" {
  if (outcome === "success") return "success";
  if (outcome === "rejected") return "warning";
  if (outcome === "aborted") return "neutral";
  return "danger";
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
      day: "numeric"
    }).format(date),
    time: new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(date)
  };
}

function usageStatusLabel(record: ForwardingRecord, t: Translator): string {
  return t(`forwarding.usage.${record.usageObservationStatus}`);
}

function modelValues(record: ForwardingRecord) {
  const requested = record.requestedModel ?? record.forwardedModel;
  const forwarded = record.forwardedModel ?? record.requestedModel;
  return {
    requested,
    forwarded,
    transformed: requested !== null && forwarded !== null && requested !== forwarded
  };
}

function RecordDetails({
  record,
  locale,
  t,
  onClose
}: {
  record: ForwardingRecord;
  locale: Locale;
  t: Translator;
  onClose: () => void;
}) {
  const rows = [
    [t("forwarding.startedAt"), formatDate(locale, record.startedAt, true)],
    [t("forwarding.completedAt"), formatDate(locale, record.completedAt, true)],
    [t("forwarding.duration"), formatDuration(locale, record.durationMs)],
    [t("forwarding.provider"), record.providerName ?? t("common.unknown")],
    [t("forwarding.route"), t(`forwarding.route.${record.route}`)],
    [t("forwarding.requestedModel"), record.requestedModel ?? t("forwarding.modelNotRecorded")],
    [t("forwarding.forwardedModel"), record.forwardedModel ?? t("forwarding.modelNotRecorded")],
    [t("forwarding.incomingUrl"), record.incomingUrl ?? "-"],
    [t("forwarding.targetUrl"), record.targetUrl ?? "-"],
    [t("forwarding.requestId"), record.requestId ?? "-"],
    [t("forwarding.upstreamRequestId"), record.upstreamRequestId ?? "-"],
    [t("forwarding.sessionId"), record.sessionId ?? "-"],
    [t("forwarding.threadId"), record.threadId ?? "-"],
    [t("forwarding.inputTokens"), record.inputTokens === null ? t("forwarding.notObserved") : formatNumber(locale, record.inputTokens)],
    [t("forwarding.outputTokens"), record.outputTokens === null ? t("forwarding.notObserved") : formatNumber(locale, record.outputTokens)],
    [t("forwarding.totalTokens"), record.inputTokens === null || record.outputTokens === null
      ? t("forwarding.notObserved")
      : formatNumber(locale, record.inputTokens + record.outputTokens)],
    [t("forwarding.usageStatus"), usageStatusLabel(record, t)],
    [t("forwarding.transfer"), `${byteLabel(locale, record.requestBytes)} → ${byteLabel(locale, record.responseBytes)}`],
    [t("forwarding.stream"), record.stream ? t("common.yes") : t("common.no")]
  ] as const;
  return (
    <aside className="record-detail" aria-label={t("forwarding.details")}>
      <div className="record-detail-header">
        <div>
          <span className="record-detail-kicker">#{record.id}</span>
          <h2>{t("forwarding.details")}</h2>
        </div>
        <IconButton label={t("common.close")} onClick={onClose}><X aria-hidden="true" /></IconButton>
      </div>
      <div className="record-detail-status">
        <StatusBadge tone={outcomeTone(record.outcome)}>{t(`forwarding.outcome.${record.outcome}`)}</StatusBadge>
        <strong>{record.responseStatus ?? "-"}</strong>
        <span>{record.method ?? "-"}</span>
      </div>
      <dl className="record-detail-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{label.includes("URL") || label.includes("地址") || label.includes("ID")
              || label.includes("model") || label.includes("模型")
              ? <code>{value}</code>
              : value}</dd>
          </div>
        ))}
      </dl>
      {record.errorType || record.errorMessage ? (
        <div className="record-error-box">
          <CircleAlert aria-hidden="true" />
          <div>
            <strong>{record.errorType ?? t("forwarding.error")}</strong>
            {record.errorMessage ? <span>{record.errorMessage}</span> : null}
          </div>
        </div>
      ) : null}
      <p className="record-privacy-note">{t("forwarding.metadataOnly")}</p>
    </aside>
  );
}

export function ForwardingRecordsPage({
  locale,
  t,
  captureEnabled,
  captureStatus,
  readOnly,
  pending,
  onLoad,
  onCaptureChange
}: ForwardingRecordsProps) {
  const [data, setData] = useState<ForwardingRecordsPageData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState<ForwardingOutcome>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [showModelRequests, setShowModelRequests] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<number | null>>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [captureSelection, setCaptureSelection] = useState(captureEnabled);

  useEffect(() => {
    if (pending !== "capture-setting") setCaptureSelection(captureEnabled);
  }, [captureEnabled, pending]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void onLoad({
      limit: 50,
      before,
      outcome,
      search,
      includeModels: showModelRequests
    }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setSelectedId((current) => next.records.some((record) => record.id === current)
          ? current
          : null);
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

  const toggleModelRequests = (visible: boolean) => {
    setHistory([]);
    setBefore(null);
    setShowModelRequests(visible);
  };

  const nextPage = () => {
    if (data?.page.nextBefore === null || data?.page.nextBefore === undefined) return;
    setHistory((current) => [...current, before]);
    setBefore(data.page.nextBefore);
  };

  const previousPage = () => {
    setHistory((current) => {
      if (current.length === 0) return current;
      setBefore(current.at(-1) ?? null);
      return current.slice(0, -1);
    });
  };

  const toggleCapture = async (enabled: boolean) => {
    setCaptureSelection(enabled);
    if (!await onCaptureChange(enabled)) setCaptureSelection(!enabled);
    else setRefreshKey((value) => value + 1);
  };

  const records = data?.records ?? [];
  const summary = data?.summary ?? { total: 0, success: 0, rejected: 0, aborted: 0, error: 0 };
  const outcomeOptions: ForwardingOutcome[] = ["all", "success", "rejected", "aborted", "error"];

  return (
    <div className="page-stack forwarding-page" data-testid="page-forwarding-records">
      <PageHeader title={t("forwarding.title")} subtitle={t("forwarding.subtitle")} />
      <Panel className="forwarding-command-panel">
        <div className="forwarding-command-bar">
          <div className="capture-control">
            <div className={cx("capture-indicator", captureSelection && "capture-indicator-active")}>
              <Database aria-hidden="true" />
            </div>
            <div>
              <strong>{t("forwarding.capture")}</strong>
              <span>{t(captureSelection ? "forwarding.captureOn" : "forwarding.captureOff")}</span>
            </div>
            <label className="compact-switch">
              <input
                type="checkbox"
                checked={captureSelection}
                disabled={readOnly || pending !== null}
                aria-label={t("forwarding.capture")}
                onChange={(event) => void toggleCapture(event.target.checked)}
              />
              <span aria-hidden="true"><span /></span>
            </label>
          </div>
          <div className="forwarding-summary" aria-label={t("forwarding.summary")}>
            <span><strong>{formatNumber(locale, summary.total)}</strong>{t("forwarding.total")}</span>
            <span className="summary-success"><strong>{formatNumber(locale, summary.success)}</strong>{t("forwarding.outcome.success")}</span>
            <span className="summary-rejected"><strong>{formatNumber(locale, summary.rejected)}</strong>{t("forwarding.outcome.rejected")}</span>
            <span className="summary-aborted"><strong>{formatNumber(locale, summary.aborted)}</strong>{t("forwarding.outcome.aborted")}</span>
            <span className="summary-error"><strong>{formatNumber(locale, summary.error)}</strong>{t("forwarding.outcome.error")}</span>
          </div>
          <IconButton
            label={t("common.refresh")}
            disabled={loading}
            onClick={() => setRefreshKey((value) => value + 1)}
          ><RefreshCw className={loading ? "spin" : undefined} aria-hidden="true" /></IconButton>
        </div>
      </Panel>
      {captureStatus.configured && captureStatus.state !== "stopped" && !captureStatus.active ? (
        <Notice title={t("forwarding.captureMismatchTitle")} tone="warning">
          <p>{t("forwarding.captureMismatchHelp")}</p>
        </Notice>
      ) : null}

      <div className="forwarding-workspace">
        <Panel className="records-panel">
          <div className="records-toolbar">
            <div className="segmented-control" aria-label={t("forwarding.filterOutcome")}>
              {outcomeOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={outcome === option ? "selected" : undefined}
                  aria-pressed={outcome === option}
                  onClick={() => selectOutcome(option)}
                >{t(`forwarding.filter.${option}`)}</button>
              ))}
            </div>
            <form className="records-search" role="search" onSubmit={applySearch}>
              <Search aria-hidden="true" />
              <input
                value={searchDraft}
                maxLength={100}
                aria-label={t("forwarding.search")}
                placeholder={t("forwarding.searchPlaceholder")}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
              <Button type="submit" className="button-small">{t("common.search")}</Button>
            </form>
          </div>
          <div className="records-visibility-bar">
            <label className="records-model-filter">
              <input
                type="checkbox"
                checked={showModelRequests}
                onChange={(event) => toggleModelRequests(event.target.checked)}
              />
              <span>{t("forwarding.showModelRequests")}</span>
            </label>
          </div>
          {error ? <div className="records-state"><ErrorNotice error={error} t={t} /></div> : null}
          {!error && !loading && records.length === 0 ? (
            <div className="records-state">
              <EmptyState
                icon={<FileClock aria-hidden="true" />}
                title={t(data?.storageState === "missing" ? "forwarding.noDatabase" : "forwarding.empty")}
                description={t(captureSelection ? "forwarding.emptyHelp" : "forwarding.enableHelp")}
              />
            </div>
          ) : null}
          {!error && (loading || records.length > 0) ? (
            <div className="records-table-wrap table-scroll" aria-busy={loading || undefined}>
              <table className="records-table">
                <thead>
                  <tr>
                    <th>{t("forwarding.time")}</th>
                    <th>{t("forwarding.request")}</th>
                    <th>{t("forwarding.model")}</th>
                    <th>{t("forwarding.provider")}</th>
                    <th>{t("forwarding.result")}</th>
                    <th>{t("forwarding.duration")}</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => {
                    const models = modelValues(record);
                    const startedAt = recordTimeParts(locale, record.startedAt);
                    return (
                    <tr key={record.id} className={record.id === selectedId ? "selected" : undefined}>
                      <td>
                        <time className="record-time" dateTime={record.startedAt ?? undefined}>
                          <span>{startedAt.date}</span>
                          <strong>{startedAt.time}</strong>
                        </time>
                      </td>
                      <td>
                        <button
                          className="record-open"
                          type="button"
                          aria-label={t("forwarding.openRecord", { value: record.id })}
                          onClick={() => setSelectedId(record.id)}
                        >
                          <strong>{record.method ?? "-"}</strong>
                          <code>{displayPath(record)}</code>
                        </button>
                      </td>
                      <td>
                        <span className={cx("record-model", models.transformed && "is-transformed")} title={models.requested === null
                          ? t("forwarding.modelNotRecorded")
                          : models.transformed
                            ? `${models.requested} → ${models.forwarded}`
                            : models.requested}>
                          {models.requested === null ? (
                            <span>{t("forwarding.modelNotRecorded")}</span>
                          ) : (
                            <>
                              <code>{models.requested}</code>
                              {models.transformed ? (
                                <><ArrowRight aria-hidden="true" /><code>{models.forwarded}</code></>
                              ) : null}
                            </>
                          )}
                        </span>
                      </td>
                      <td>
                        <span className="record-provider">
                          <i className={cx("route-dot", `route-dot-${record.route}`)} aria-hidden="true" />
                          {record.providerName ?? t("common.unknown")}
                        </span>
                      </td>
                      <td>
                        <span className="record-result">
                          <StatusBadge tone={outcomeTone(record.outcome)}>{t(`forwarding.outcome.${record.outcome}`)}</StatusBadge>
                          <code>{record.responseStatus ?? "-"}</code>
                        </span>
                      </td>
                      <td><span className="record-duration"><Clock3 aria-hidden="true" />{formatDuration(locale, record.durationMs)}</span></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              {loading && records.length === 0 ? <div className="table-loading">{t("common.loading")}</div> : null}
            </div>
          ) : null}
          <div className="records-pagination">
            <span>{history.length === 0 ? t("forwarding.latest") : t("forwarding.page", { value: history.length + 1 })}</span>
            <div>
              <Button className="button-small" disabled={history.length === 0 || loading} onClick={previousPage}>
                <ArrowLeft className="icon" aria-hidden="true" />{t("common.previous")}
              </Button>
              <Button className="button-small" disabled={data?.page.nextBefore === null || loading} onClick={nextPage}>
                {t("common.next")}<ArrowRight className="icon" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </Panel>
        {selected ? (
          <RecordDetails record={selected} locale={locale} t={t} onClose={() => setSelectedId(null)} />
        ) : (
          <aside className="record-detail record-detail-empty" aria-label={t("forwarding.details")}>
            <FileClock aria-hidden="true" />
            <strong>{t("forwarding.selectRecord")}</strong>
            <span>{t("forwarding.metadataOnly")}</span>
          </aside>
        )}
      </div>
    </div>
  );
}
