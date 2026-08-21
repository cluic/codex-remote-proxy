import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleOff,
  CircleUserRound,
  RefreshCw,
  TrendingUp
} from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError } from "../api";
import { TrendExplorer } from "../components/Charts";
import {
  Button,
  EmptyState,
  IconButton,
  Modal,
  Notice,
  Panel,
  StatusBadge,
  cx
} from "../components/Primitives";
import {
  formatCompactNumber,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  type Translator
} from "../i18n";
import type {
  AccountQuotaWindow,
  LatencySummary,
  Locale,
  MetricsOverview,
  MetricsWindow,
  Provider,
  Route,
  Settings,
  StatusResponse
} from "../types";

type OverviewProps = {
  locale: Locale;
  t: Translator;
  status: StatusResponse;
  settings: Settings;
  providers: Provider[];
  metrics: MetricsOverview | null;
  metricsError: ApiError | null;
  metricsWindow: MetricsWindow;
  readOnly: boolean;
  pending: string | null;
  onNavigate: (route: Route) => void;
  onMetricsWindow: (window: MetricsWindow) => void;
  onStart: () => void;
  onRestart: () => void;
  onPrepareCodex: () => void;
  onRefreshAccount: () => void;
  onRoutingModeChange: (mode: Settings["routingMode"]) => void;
};

function MetricCard({
  label,
  value,
  detail,
  positive = false
}: {
  label: string;
  value: string;
  detail: string;
  positive?: boolean;
}) {
  return (
    <article className="metric-card">
      <div className="metric-card-heading">
        <span>{label}</span>
        {positive ? <TrendingUp aria-hidden="true" /> : null}
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function formatLatency(locale: Locale, latency: LatencySummary): string {
  if (latency.p95UpperBoundMs !== null) return formatDuration(locale, latency.p95UpperBoundMs);
  if (latency.overflowRequests > 0) return `> ${formatDuration(locale, 300_000)}`;
  return "-";
}

function quotaWindowLabel(window: AccountQuotaWindow, t: Translator): string {
  if (window.windowDurationMins === 300) return t("system.quota5h");
  if (window.windowDurationMins === 10_080) return t("system.quota7d");
  return window.kind === "primary" ? t("system.quotaPrimary") : t("system.quotaSecondary");
}

export function OverviewPage({
  locale,
  t,
  status,
  settings,
  providers,
  metrics,
  metricsError,
  metricsWindow,
  readOnly,
  pending,
  onNavigate,
  onMetricsWindow,
  onStart,
  onRestart,
  onPrepareCodex,
  onRefreshAccount,
  onRoutingModeChange
}: OverviewProps) {
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [routingSelection, setRoutingSelection] = useState(settings.routingMode);
  const [modelsExpanded, setModelsExpanded] = useState(false);
  useEffect(() => {
    if (pending !== "routing-mode") setRoutingSelection(settings.routingMode);
  }, [pending, settings.routingMode]);

  const active = status.activeProvider;
  const account = status.account;
  const workerRunning = status.worker?.phase === "running" && status.worker.state?.listening === true;
  const workerFailed = status.worker?.phase === "failed" || status.worker?.error !== null && status.worker?.error !== undefined;
  const providerEligible = active?.lastTestStatus === "passed" && active.credentialConfigured;
  const ready = Boolean(providerEligible && status.codex.configured && workerRunning && !status.codex.historyRepairPending);
  const accountFirst = routingSelection === "account_first";
  const accountLabel = account.authenticated === true
    ? t("system.accountSignedIn")
    : account.authenticated === false
      ? t("system.accountApiKey")
      : t("system.accountUnknown");

  let actionHelp = t("overview.noProvider");
  let actionLabel = t("overview.addProvider");
  let action = () => onNavigate("setup");
  if (!active && providers.length > 0) {
    actionHelp = t("overview.continueSetupHelp");
    actionLabel = t("overview.continueSetup");
  } else if (active && !providerEligible) {
    actionHelp = t("overview.providerNeedsTest");
    actionLabel = t("overview.reviewProvider");
    action = () => onNavigate("providers");
  } else if ((active && !status.codex.configured) || status.codex.historyRepairPending) {
    actionHelp = t("overview.codexNeedsSetup");
    actionLabel = t("overview.prepareCodex");
    action = () => setPrepareOpen(true);
  } else if (active && providerEligible && !workerRunning) {
    actionHelp = workerFailed ? t("overview.workerFailed") : t("overview.workerNeedsStart");
    actionLabel = workerFailed ? t("overview.restartWorker") : t("overview.startProxy");
    action = workerFailed ? onRestart : onStart;
  }

  const requests = metrics?.summary.requests ?? 0;
  const successful = metrics?.summary.results.success ?? 0;
  const clientAborts = metrics?.summary.results.clientAbort ?? 0;
  const reliabilityRequests = Math.max(0, requests - clientAborts);
  const coverage = metrics && successful > 0
    ? Math.min(1, Math.max(0, metrics.summary.tokens.observedRequests / successful))
    : 0;
  const tokensObserved = metrics?.summary.tokens.observedRequests
    ? metrics.summary.tokens.input + metrics.summary.tokens.output
    : null;
  const providerNames = new Map([
    ...providers.map((provider) => [provider.id, provider.name] as const),
    ["crp-chatgpt-account", t("overview.chatgptAccount")] as const
  ]);
  const droppedObservations = metrics?.dataQuality.droppedObservations ?? 0;
  const successRateComplete = droppedObservations === 0;
  const successRateUnavailable = t("overview.successRateUnavailable", {
    count: formatNumber(locale, droppedObservations)
  });
  const dataQualitySignals = metrics ? [
    { label: t("overview.unknownModelRequests"), value: metrics.dataQuality.unknownModelRequests },
    { label: t("overview.modelOverflowRequests"), value: metrics.dataQuality.modelOverflowRequests },
    { label: t("overview.providerOverflowRequests"), value: metrics.dataQuality.providerOverflowRequests },
    { label: t("overview.droppedObservations"), value: droppedObservations }
  ].filter((signal) => signal.value > 0) : [];
  const metricsUnavailable = metricsError !== null
    || metrics === null
    || metrics.storageState === "unavailable";
  const modelRows = metrics ? [
    ...metrics.models.map((model) => ({
      id: model.model,
      label: model.model,
      requests: model.requests,
      tokens: model.tokens.input + model.tokens.output,
      kind: "model" as const
    })),
    ...(metrics.dataQuality.unknownModelRequests > 0 ? [{
      id: "unknown-model",
      label: t("overview.unknownModel"),
      requests: metrics.dataQuality.unknownModelRequests,
      tokens: 0,
      kind: "unknown" as const
    }] : []),
    ...(Math.max(0, metrics.modelOtherRequests - metrics.dataQuality.unknownModelRequests) > 0 ? [{
      id: "grouped-models",
      label: t("overview.groupedModels"),
      requests: Math.max(0, metrics.modelOtherRequests - metrics.dataQuality.unknownModelRequests),
      tokens: 0,
      kind: "grouped" as const
    }] : [])
  ] : [];
  const aggregateModelRows = modelRows.filter(({ kind }) => kind !== "model");
  const displayedModels = modelsExpanded
    ? modelRows
    : [
        ...modelRows.filter(({ kind }) => kind === "model")
          .slice(0, Math.max(0, 5 - aggregateModelRows.length)),
        ...aggregateModelRows
      ];
  const maximumModelRequests = Math.max(1, ...modelRows.map(({ requests: count }) => count));

  return (
    <div className="page-stack overview-page" data-testid="page-overview">
      {!ready ? (
        <section className="overview-action-strip" aria-labelledby="overview-action-title">
          <div className="overview-action-copy">
            <StatusBadge tone="warning">{t("overview.actionTitle")}</StatusBadge>
            <div>
              <h2 id="overview-action-title">{t("overview.actionTitle")}</h2>
              <p>{actionHelp}</p>
            </div>
          </div>
          <Button variant="primary" disabled={readOnly || pending !== null} onClick={action}>
            {actionLabel}<ArrowRight className="icon" aria-hidden="true" />
          </Button>
        </section>
      ) : null}

      <section className="overview-command-bar" aria-label={t("system.accountTitle")}>
        <div className="overview-account-segment">
          <span className={cx("overview-account-icon", account.authenticated === true && "is-authenticated")}>
            <CircleUserRound aria-hidden="true" />
          </span>
          <div className="overview-account-copy">
            <div>
              <strong>{accountLabel}</strong>
              {account.planType ? <span className="overview-account-plan">{account.planType}</span> : null}
            </div>
            <small>{account.updatedAt
              ? t("overview.accountChecked", { value: formatDate(locale, account.updatedAt, true) })
              : t("overview.accountSession")}</small>
          </div>
        </div>

        <label className="overview-routing-segment">
          <input
            type="checkbox"
            checked={accountFirst}
            disabled={readOnly || pending !== null}
            onChange={(event) => {
              const mode = event.target.checked ? "account_first" : "custom_only";
              setRoutingSelection(mode);
              onRoutingModeChange(mode);
            }}
          />
          <span className="switch-track" aria-hidden="true"><span /></span>
          <span className="overview-routing-copy">
            <strong>{t("system.accountFirst")}</strong>
            <small>{accountFirst
              ? t("overview.accountFirstFallback", { provider: active?.name ?? t("common.none") })
              : t("overview.customOnlyRoute", { provider: active?.name ?? t("common.none") })}</small>
          </span>
        </label>

        <div className="overview-quota-segment">
          {account.quota?.windows.length ? (
            <div className="overview-quota-windows">
              {account.quota.windows.map((window, index) => {
                const label = quotaWindowLabel(window, t);
                const resetAt = window.resetsAt === null
                  ? null
                  : new Date(window.resetsAt * 1_000).toISOString();
                return (
                  <div className="overview-quota-window" key={`${window.kind}-${window.windowDurationMins ?? "unknown"}-${index}`}>
                    <div className="overview-quota-heading">
                      <span>{label}</span>
                      <strong>{t("system.quotaRemaining", { value: window.remainingPercent })}</strong>
                    </div>
                    <progress
                      max={100}
                      value={window.remainingPercent}
                      aria-label={`${label}: ${t("system.quotaRemaining", { value: window.remainingPercent })}`}
                    />
                    <small>{resetAt
                      ? t("system.quotaResets", { value: formatDate(locale, resetAt, true) })
                      : t("system.quotaResetUnknown")}</small>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="overview-quota-empty">
              <strong>{t("system.quotaStatus")}</strong>
              <small>{account.quotaSupported === false
                ? t("system.quotaUnsupported")
                : t("overview.quotaUnavailable")}</small>
            </div>
          )}
          <IconButton
            className="overview-account-refresh"
            label={t("system.refreshAccount")}
            disabled={readOnly || pending !== null}
            onClick={onRefreshAccount}
          >
            <RefreshCw className={pending === "account-refresh" ? "spin" : undefined} aria-hidden="true" />
          </IconButton>
        </div>
      </section>

      <section className="metrics-section overview-metrics" aria-labelledby="metrics-heading">
        <header className="overview-metrics-toolbar">
          <div>
            <h2 id="metrics-heading">{t("overview.metricsTitle")}</h2>
            <span>{t(metricsWindow === "24h" ? "overview.window24Detail" : "overview.window7Detail")}</span>
          </div>
          <div className="segmented-control" aria-label={t("overview.metricsTitle")}>
            <button
              type="button"
              aria-pressed={metricsWindow === "24h"}
              onClick={() => onMetricsWindow("24h")}
            >{t("overview.window24")}</button>
            <button
              type="button"
              aria-pressed={metricsWindow === "7d"}
              onClick={() => onMetricsWindow("7d")}
            >{t("overview.window7")}</button>
          </div>
        </header>

        {metricsUnavailable ? (
          <Notice title={t("overview.metricsUnavailable")} tone="warning">
            <p>{t("overview.metricsUnavailableHelp")}</p>
            {metricsError ? <p><code>{metricsError.code}</code></p> : null}
          </Notice>
        ) : (
          <>
            {metrics.storageState === "degraded" ? (
              <Notice title={t("common.degraded")} tone="warning">
                <p>{t("overview.metricsDegraded")}</p>
              </Notice>
            ) : null}

            <div className="metric-grid">
              <MetricCard
                label={t("overview.requestVolume")}
                value={formatCompactNumber(locale, requests)}
                detail={metricsWindow === "24h" ? t("overview.window24") : t("overview.window7")}
              />
              <MetricCard
                label={t("overview.successRate")}
                value={reliabilityRequests > 0 && successRateComplete
                  ? formatPercent(locale, successful / reliabilityRequests)
                  : "-"}
                detail={successRateComplete
                  ? t("overview.reliabilityDetail", {
                      successful: formatNumber(locale, successful),
                      aborted: formatNumber(locale, clientAborts)
                    })
                  : successRateUnavailable}
                positive={successRateComplete && successful > 0}
              />
              <MetricCard
                label={t("overview.observedTokens")}
                value={tokensObserved === null ? "-" : formatCompactNumber(locale, tokensObserved)}
                detail={t("overview.tokenCoverage", { value: Math.round(coverage * 100) })}
              />
              <MetricCard
                label={t("overview.responseStart")}
                value={formatLatency(locale, metrics.summary.responseStart)}
                detail={t("overview.latencyBound")}
              />
            </div>

            {metrics.summary.requests === 0 ? (
              <div data-testid="metrics-empty">
                <EmptyState
                  icon={<CircleOff />}
                  title={t("overview.noTraffic")}
                  description={t("overview.noTrafficHelp")}
                />
              </div>
            ) : (
              <div className="overview-dashboard" data-testid="metrics-loaded">
                <Panel className="overview-trend-panel">
                  <header className="overview-panel-header">
                    <div>
                      <h2>{t("overview.trendExplorer")}</h2>
                      <p>{t("overview.trendExplorerHelp")}</p>
                    </div>
                  </header>
                  <div className="panel-content overview-trend-content">
                    <TrendExplorer series={metrics.series} locale={locale} t={t} />
                  </div>
                </Panel>

                <div className="overview-summary-grid">
                  <Panel className="overview-summary-panel overview-model-summary">
                    <header className="overview-summary-heading">
                      <div><h2>{t("overview.modelDistribution")}</h2><span>{t("overview.modelDistributionHelp")}</span></div>
                      <strong>{formatNumber(locale, modelRows.length)}</strong>
                    </header>
                    {displayedModels.length > 0 ? (
                      <ol className="overview-model-list">
                        {displayedModels.map((model, index) => (
                          <li key={model.id}>
                            <span className="overview-model-rank">{model.kind === "model"
                              ? index + 1
                              : model.kind === "unknown" ? "?" : "Σ"}</span>
                            <div className="overview-model-details">
                              <div><code title={model.label}>{model.label}</code><strong>{formatNumber(locale, model.requests)}</strong></div>
                              <span className="overview-model-bar"><i style={{ width: `${model.requests / maximumModelRequests * 100}%` }} /></span>
                              <small>{t("overview.modelRowDetail", {
                                share: requests > 0 ? Math.round(model.requests / requests * 100) : 0,
                                tokens: model.tokens > 0 ? formatCompactNumber(locale, model.tokens) : "-"
                              })}</small>
                            </div>
                          </li>
                        ))}
                      </ol>
                    ) : <p className="overview-summary-empty">{t("overview.noModelData")}</p>}
                    {modelRows.length > 5 ? (
                      <Button className="button-small overview-expand-button" variant="ghost" onClick={() => setModelsExpanded((value) => !value)}>
                        {modelsExpanded ? t("overview.showLess") : t("overview.showAll", { count: modelRows.length })}
                        {modelsExpanded ? <ChevronUp className="icon" aria-hidden="true" /> : <ChevronDown className="icon" aria-hidden="true" />}
                      </Button>
                    ) : null}
                  </Panel>

                  <Panel className="overview-summary-panel overview-provider-summary">
                    <header className="overview-summary-heading">
                      <div><h2>{t("overview.providerPerformance")}</h2><span>{t("overview.providerPerformanceHelp")}</span></div>
                      <strong>{formatNumber(locale, metrics.providers.length)}</strong>
                    </header>
                    {metrics.providers.length > 0 || metrics.providerOtherRequests > 0 ? (
                      <div className="overview-provider-table-wrap">
                        <table className="overview-provider-table">
                          <thead><tr>
                            <th>{t("forwarding.provider")}</th>
                            <th>{t("overview.requestVolume")}</th>
                            <th>{t("overview.successful")}</th>
                            <th>{t("overview.tokenCoverageShort")}</th>
                            <th>{t("overview.p95Latency")}</th>
                          </tr></thead>
                          <tbody>
                            {metrics.providers.map((provider) => (
                              <tr key={provider.providerId}>
                                <th title={providerNames.get(provider.providerId) ?? provider.providerId}>
                                  {providerNames.get(provider.providerId) ?? provider.providerId}
                                </th>
                                <td data-label={t("overview.requestVolume")}>{formatNumber(locale, provider.requests)}</td>
                                <td data-label={t("overview.successful")}>{successRateComplete ? formatNumber(locale, provider.successfulRequests) : "-"}</td>
                                <td data-label={t("overview.tokenCoverageShort")}>{provider.successfulRequests > 0
                                  ? formatPercent(locale, provider.tokens.observedRequests / provider.successfulRequests)
                                  : "-"}</td>
                                <td data-label={t("overview.p95Latency")}>{formatLatency(locale, provider.latency)}</td>
                              </tr>
                            ))}
                            {metrics.providerOtherRequests > 0 ? (
                              <tr><th>{t("overview.otherProviders")}</th>
                                <td data-label={t("overview.requestVolume")}>{formatNumber(locale, metrics.providerOtherRequests)}</td>
                                <td data-label={t("overview.successful")}>-</td>
                                <td data-label={t("overview.tokenCoverageShort")}>-</td>
                                <td data-label={t("overview.p95Latency")}>-</td>
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>
                    ) : <p className="overview-summary-empty">{t("overview.noProviderData")}</p>}
                  </Panel>
                </div>
              </div>
            )}

            {dataQualitySignals.length > 0 ? (
              <aside className="data-quality-note" aria-label={t("overview.dataQuality")}>
                <p><strong>{t("overview.dataQuality")}</strong> · {t("overview.dataQualityHelp")}</p>
                <dl>{dataQualitySignals.map((signal) => (
                  <div key={signal.label}>
                    <dt>{signal.label}</dt>
                    <dd>{formatNumber(locale, signal.value)}</dd>
                  </div>
                ))}</dl>
              </aside>
            ) : null}
          </>
        )}
      </section>

      <Modal
        open={prepareOpen}
        title={t("system.prepareTitle")}
        description={t("system.prepareHelp")}
        onClose={() => setPrepareOpen(false)}
        t={t}
        size="small"
        footer={(
          <>
            <Button onClick={() => setPrepareOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={() => { setPrepareOpen(false); onPrepareCodex(); }}>
              {t("system.prepare")}
            </Button>
          </>
        )}
      ><Notice title="OpenAI · 127.0.0.1:15100" tone="info"><p>{t("system.prepareHelp")}</p></Notice></Modal>
    </div>
  );
}
