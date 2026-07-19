import {
  ArrowRight,
  CircleOff
} from "lucide-react";
import { useState } from "react";

import { ApiError } from "../api";
import { DistributionChart, ResultsChart, TokenChart } from "../components/Charts";
import {
  Button,
  EmptyState,
  Modal,
  Notice,
  PageHeader,
  Panel,
  PanelHeader,
  StatusBadge,
  cx
} from "../components/Primitives";
import {
  formatCompactNumber,
  formatDuration,
  formatNumber,
  formatPercent,
  type Translator
} from "../i18n";
import type {
  LatencySummary,
  Locale,
  MetricsOverview,
  MetricsWindow,
  Provider,
  Route,
  StatusResponse
} from "../types";

type OverviewProps = {
  locale: Locale;
  t: Translator;
  status: StatusResponse;
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
};

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
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

export function OverviewPage({
  locale,
  t,
  status,
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
  onPrepareCodex
}: OverviewProps) {
  const [prepareOpen, setPrepareOpen] = useState(false);
  const active = status.activeProvider;
  const workerRunning = status.worker?.phase === "running" && status.worker.state?.listening === true;
  const workerFailed = status.worker?.phase === "failed" || status.worker?.error !== null && status.worker?.error !== undefined;
  const providerEligible = active?.lastTestStatus === "passed" && active.credentialConfigured;
  const ready = Boolean(providerEligible && status.codex.configured && workerRunning && !status.codex.historyRepairPending);

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
  const coverage = metrics && successful > 0
    ? Math.min(1, Math.max(0, metrics.summary.tokens.observedRequests / successful))
    : 0;
  const tokensObserved = metrics?.summary.tokens.observedRequests
    ? metrics.summary.tokens.input + metrics.summary.tokens.output
    : null;
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
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
  const visibleModels = metrics?.models.slice(0, 7) ?? [];
  const otherModelRequests = (metrics?.modelOtherRequests ?? 0)
    + (metrics?.models.slice(7).reduce((sum, model) => sum + model.requests, 0) ?? 0);

  return (
    <div className="page-stack" data-testid="page-overview">
      <PageHeader title={t("overview.title")} subtitle={t("overview.subtitle")} />

      <section className={cx("readiness-band", ready ? "readiness-ready" : "readiness-action")}>
        <div className="readiness-copy">
          <StatusBadge tone={ready ? "success" : "warning"}>
            {ready ? t("common.ready") : t("overview.actionTitle")}
          </StatusBadge>
          <div>
            <h2>{ready ? t("overview.readyTitle") : t("overview.actionTitle")}</h2>
            <p>{ready
              ? t("overview.readyHelp", { provider: active?.name ?? t("common.none") })
              : actionHelp}</p>
          </div>
        </div>
        {!ready ? (
          <Button variant="primary" disabled={readOnly || pending !== null} onClick={action}>
            {actionLabel}<ArrowRight className="icon" aria-hidden="true" />
          </Button>
        ) : null}
      </section>

      <section className="runtime-facts" aria-label={t("overview.title")}>
        <article>
          <span>{t("overview.management")}</span>
          <strong>{t("common.connected")}</strong>
          <small>PID {status.supervisor.pid ?? "-"}</small>
        </article>
        <article>
          <span>{t("overview.worker")}</span>
          <strong>{workerRunning ? t("common.running") : t("common.stopped")}</strong>
          <small>{t("overview.generation", { value: status.worker?.generation ?? status.generation })}</small>
        </article>
        <article>
          <span>{t("overview.activeProvider")}</span>
          <strong>{active?.name ?? t("common.none")}</strong>
          <small>{active?.lastTestStatus === "passed" ? t("common.passed") : t("common.untested")}</small>
        </article>
        <article>
          <span>{t("overview.codex")}</span>
          <strong>{status.codex.configured ? t("common.configured") : t("common.notConfigured")}</strong>
          <small>{status.codex.modelProvider ?? "OpenAI"}</small>
        </article>
      </section>

      <section className="metrics-section" aria-labelledby="metrics-heading">
        <header className="section-heading">
          <div>
            <h2 id="metrics-heading">{t("overview.metricsTitle")}</h2>
            <p>{t("overview.metricsHelp")} {t(metricsWindow === "24h"
              ? "overview.window24Detail"
              : "overview.window7Detail")}</p>
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
                value={requests > 0 && successRateComplete ? formatPercent(locale, successful / requests) : "-"}
                detail={successRateComplete
                  ? `${formatNumber(locale, successful)} ${t("overview.successful").toLowerCase()}`
                  : successRateUnavailable}
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
              <div className="metrics-dashboard" data-testid="metrics-loaded">
                <Panel>
                  <PanelHeader title={t("overview.requestTrend")} description={t("overview.requestTrendHelp")} />
                  <div className="panel-content chart-content"><ResultsChart series={metrics.series} locale={locale} t={t} /></div>
                </Panel>
                <Panel>
                  <PanelHeader title={t("overview.tokenTrend")} description={t("overview.tokenTrendHelp")} />
                  <div className="panel-content chart-content"><TokenChart series={metrics.series} locale={locale} t={t} /></div>
                </Panel>
                <Panel>
                  <PanelHeader title={t("overview.modelDistribution")} description={t("overview.modelDistributionHelp")} />
                  <div className="panel-content chart-content">
                    {visibleModels.length > 0 || otherModelRequests > 0 ? (
                      <DistributionChart
                        items={[
                          ...visibleModels.map((model) => ({ label: model.model, value: model.requests })),
                          ...(otherModelRequests > 0
                            ? [{ label: t("overview.otherModels"), value: otherModelRequests }]
                            : [])
                        ]}
                        locale={locale}
                        title={t("overview.modelDistribution")}
                        t={t}
                      />
                    ) : <p className="chart-empty">{t("overview.noModelData")}</p>}
                  </div>
                </Panel>
                <Panel>
                  <PanelHeader title={t("overview.providerPerformance")} description={t("overview.providerPerformanceHelp")} />
                  <div className="table-scroll">
                    <table className="data-table provider-performance-table">
                      <thead><tr>
                        <th>{t("common.provider")}</th>
                        <th>{t("overview.requestVolume")}</th>
                        <th>{t("overview.successRate")}</th>
                        <th>{t("overview.p95Latency")}</th>
                      </tr></thead>
                      <tbody>
                        {metrics.providers.map((provider) => (
                          <tr key={provider.providerId}>
                            <th title={providerNames.get(provider.providerId) ?? provider.providerId}>
                              {providerNames.get(provider.providerId) ?? provider.providerId}
                            </th>
                            <td>{formatNumber(locale, provider.requests)}</td>
                            <td title={successRateComplete ? undefined : successRateUnavailable}>
                              {successRateComplete && provider.requests > 0
                              ? formatPercent(locale, provider.successfulRequests / provider.requests)
                              : successRateComplete ? "-" : t("common.notAvailable")}
                            </td>
                            <td>{formatLatency(locale, provider.latency)}</td>
                          </tr>
                        ))}
                        {metrics.providerOtherRequests > 0 ? (
                          <tr>
                            <th>{t("overview.other")}</th>
                            <td>{formatNumber(locale, metrics.providerOtherRequests)}</td>
                            <td>-</td>
                            <td>-</td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </Panel>
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
