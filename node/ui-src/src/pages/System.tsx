import { FileJson, LockKeyhole, RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Button,
  DefinitionList,
  IconButton,
  Modal,
  Notice,
  PageHeader,
  Panel,
  PanelHeader,
  StatusBadge
} from "../components/Primitives";
import { formatDate, type Translator } from "../i18n";
import type {
  BootstrapResult,
  DiagnosticResult,
  Locale,
  MetricsOverview,
  Provider,
  Settings,
  StatusResponse
} from "../types";

type SystemProps = {
  locale: Locale;
  t: Translator;
  status: StatusResponse;
  settings: Settings;
  activeProvider: Provider | null;
  metrics: MetricsOverview | null;
  readOnly: boolean;
  pending: string | null;
  onPrepareCodex: () => Promise<BootstrapResult | null>;
  onGenerateDiagnostics: () => Promise<DiagnosticResult | null>;
  onRefreshAccount: () => void;
  onRoutingModeChange: (mode: "custom_only" | "account_first") => void;
};

function storageLabel(state: MetricsOverview["storageState"] | null, t: Translator): string {
  if (state === null || state === "unavailable") return t("common.notAvailable");
  if (state === "ready") return t("common.ready");
  if (state === "degraded") return t("common.degraded");
  return t("common.unknown");
}

function quotaWindowLabel(minutes: number | null, kind: "primary" | "secondary", t: Translator): string {
  if (minutes === 300) return t("system.quota5h");
  if (minutes === 10_080) return t("system.quota7d");
  return kind === "primary" ? t("system.quotaPrimary") : t("system.quotaSecondary");
}

export function SystemPage({
  locale,
  t,
  status,
  settings,
  activeProvider,
  metrics,
  readOnly,
  pending,
  onPrepareCodex,
  onGenerateDiagnostics,
  onRefreshAccount,
  onRoutingModeChange
}: SystemProps) {
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult | null>(null);
  const [routingSelection, setRoutingSelection] = useState(settings.routingMode);
  useEffect(() => {
    if (pending !== "routing-mode") setRoutingSelection(settings.routingMode);
  }, [pending, settings.routingMode]);
  const workerRunning = status.worker?.phase === "running" && status.worker.state?.listening === true;
  const prepare = async () => {
    setPrepareOpen(false);
    const result = await onPrepareCodex();
    if (result) setBootstrapResult(result);
  };
  const generate = async () => {
    const result = await onGenerateDiagnostics();
    if (result) setDiagnostics(result);
  };
  const adminAddress = settings.adminHost && settings.adminPort
    ? `http://${settings.adminHost}:${settings.adminPort}`
    : "http://127.0.0.1:15101";
  const proxyAddress = settings.proxyHost && settings.proxyPort
    ? `http://${settings.proxyHost}:${settings.proxyPort}`
    : "http://127.0.0.1:15100";
  const account = status.account;
  const accountTone = account.authenticated === true
    ? "success"
    : account.authenticated === false
      ? "neutral"
      : account.phase === "unavailable" ? "warning" : "neutral";
  const accountLabel = account.authenticated === true
    ? t("system.accountSignedIn")
    : account.authenticated === false
      ? t("system.accountApiKey")
      : t("system.accountUnknown");
  const accountFirst = routingSelection === "account_first";

  return (
    <div className="page-stack" data-testid="page-system">
      <PageHeader title={t("system.title")} subtitle={t("system.subtitle")} />
      <div className="system-grid">
        <Panel>
          <PanelHeader title={t("system.runtime")} description={t("system.runtimeHelp")} />
          <div className="panel-content">
            <DefinitionList rows={[
              { label: t("system.adminAddress"), value: <code>{adminAddress}</code> },
              { label: t("system.proxyAddress"), value: <code>{proxyAddress}</code> },
              { label: t("system.managementService"), value: <StatusBadge tone="success">{t("common.connected")}</StatusBadge> },
              { label: t("system.proxyWorker"), value: <StatusBadge tone={workerRunning ? "success" : "neutral"}>{workerRunning ? t("common.running") : t("common.stopped")}</StatusBadge> },
              { label: t("system.activeProvider"), value: activeProvider?.name ?? t("common.none") },
              { label: t("system.credentialBackend"), value: settings.credentialBackend === "native" ? t("system.native") : settings.credentialBackend ?? t("common.unknown") },
              {
                label: t("system.metricsStorage"),
                value: (
                  <StatusBadge tone={metrics?.storageState === "ready" ? "success" : metrics ? "warning" : "neutral"}>
                    {storageLabel(metrics?.storageState ?? null, t)}
                  </StatusBadge>
                )
              }
            ]} />
          </div>
        </Panel>
        <div className="system-tools">
          <Panel>
            <PanelHeader
              title={t("system.accountTitle")}
              description={t("system.accountHelp")}
              action={(
                <IconButton
                  label={t("system.refreshAccount")}
                  disabled={readOnly || pending !== null}
                  onClick={onRefreshAccount}
                >
                  <RefreshCw
                    className={pending === "account-refresh" ? "spin" : undefined}
                    aria-hidden="true"
                  />
                </IconButton>
              )}
            />
            <div className="panel-content account-panel-content">
              <div className="account-summary">
                <StatusBadge tone={accountTone}>{accountLabel}</StatusBadge>
                {account.planType ? <span className="account-plan">{account.planType}</span> : null}
              </div>
              <DefinitionList rows={[
                { label: t("system.authMode"), value: account.authMode ?? t("common.unknown") },
                {
                  label: t("system.quotaStatus"),
                  value: account.quota?.status === "available"
                    ? t("system.quotaAvailable")
                    : account.quota?.status === "exhausted"
                      ? t("system.quotaExhausted")
                      : account.quotaSupported === false
                        ? t("system.quotaUnsupported")
                        : t("common.unknown")
                },
                { label: t("system.accountUpdated"), value: formatDate(locale, account.updatedAt, true) }
              ]} />
              {account.quota?.windows.length ? (
                <div className="quota-window-list">
                  {account.quota.windows.map((window) => {
                    const label = quotaWindowLabel(window.windowDurationMins, window.kind, t);
                    const resetAt = window.resetsAt === null
                      ? null
                      : new Date(window.resetsAt * 1_000).toISOString();
                    return (
                      <div className="quota-window" key={`${window.kind}-${window.windowDurationMins ?? "unknown"}`}>
                        <div className="quota-window-heading">
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
              ) : null}
              {account.errorCode ? <code className="account-error-code">{account.errorCode}</code> : null}
              <label className="routing-switch">
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
                <span className="routing-switch-copy">
                  <strong>{t("system.accountFirst")}</strong>
                  <small>{t(accountFirst ? "system.accountFirstOn" : "system.accountFirstOff")}</small>
                </span>
              </label>
            </div>
          </Panel>
          <Panel>
            <PanelHeader
              title={t("system.codexTitle")}
              description={status.codex.configured ? t("system.codexReady") : t("system.codexNotReady")}
            />
            <div className="panel-content system-tool-body">
              <div className="system-tool-status">
                <StatusBadge tone={status.codex.configured ? "success" : "warning"}>
                  <ShieldCheck aria-hidden="true" />
                  {status.codex.configured ? t("common.configured") : t("common.notConfigured")}
                </StatusBadge>
                <code>{status.codex.modelProvider ?? "OpenAI"} · {status.codex.proxyUrl ?? "http://127.0.0.1:15100"}</code>
              </div>
              {bootstrapResult ? (
                <Notice title={t("system.historyRepair")} tone="success">
                  <p>{bootstrapResult.historyRepair.required
                    ? t("system.historyRepairComplete")
                    : t("system.historyRepairNotNeeded")}</p>
                </Notice>
              ) : null}
              <Button
                variant="primary"
                disabled={readOnly || pending !== null}
                busy={pending === "codex-bootstrap"}
                onClick={() => setPrepareOpen(true)}
              ><Settings2 className="icon" aria-hidden="true" />{t("system.prepare")}</Button>
            </div>
          </Panel>
          <Panel>
            <PanelHeader title={t("system.diagnostics")} description={t("system.diagnosticsHelp")} />
            <div className="panel-content system-tool-body">
              {diagnostics ? (
                <div className="diagnostic-result" role="status">
                  <FileJson aria-hidden="true" />
                  <div>
                    <strong>{t("notice.diagnosticsReady")}</strong>
                    <span>{t("system.generatedAt", { value: formatDate(locale, diagnostics.generatedAt, true) })}</span>
                    <span>{t("system.eventCount", { value: diagnostics.eventCount ?? 0 })}</span>
                  </div>
                </div>
              ) : (
                <div className="diagnostic-placeholder">
                  <LockKeyhole aria-hidden="true" />
                  <span>{t("system.diagnosticsHelp")}</span>
                </div>
              )}
              <Button
                disabled={readOnly || pending !== null}
                busy={pending === "diagnostics"}
                onClick={() => void generate()}
              ><FileJson className="icon" aria-hidden="true" />{t("system.generate")}</Button>
            </div>
          </Panel>
        </div>
      </div>
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
            <Button variant="primary" onClick={() => void prepare()}>{t("system.prepare")}</Button>
          </>
        )}
      >
        <Notice title="OpenAI · 127.0.0.1:15100" tone="info"><p>{t("system.prepareHelp")}</p></Notice>
      </Modal>
    </div>
  );
}
