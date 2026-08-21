import {
  Database,
  FileJson,
  GitFork,
  KeyRound,
  LockKeyhole,
  Network,
  Power,
  RefreshCw,
  Route,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert
} from "lucide-react";
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
  onAutoStartChange: (enabled: boolean) => void;
};

function storageLabel(state: MetricsOverview["storageState"] | null, t: Translator): string {
  if (state === null || state === "unavailable") return t("common.notAvailable");
  if (state === "ready") return t("common.ready");
  if (state === "degraded") return t("common.degraded");
  return t("common.unknown");
}

function platformLabel(platform: string | null, t: Translator): string {
  if (platform === "darwin") return t("system.platformDarwin");
  if (platform === "linux") return t("system.platformLinux");
  if (platform === "win32") return t("system.platformWin32");
  return platform ?? t("common.unknown");
}

function captureLabel(status: StatusResponse["capture"], t: Translator): string {
  if (!status.configured) return t("system.captureOff");
  if (status.active) return t("system.captureActive");
  if (status.state === "stopped") return t("system.captureWaiting");
  return t("system.captureAttention");
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
  onRoutingModeChange,
  onAutoStartChange
}: SystemProps) {
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult | null>(null);
  const [routingSelection, setRoutingSelection] = useState(settings.routingMode);
  const [autoStartSelection, setAutoStartSelection] = useState(settings.autoStartEnabled);
  useEffect(() => {
    if (pending !== "routing-mode") setRoutingSelection(settings.routingMode);
  }, [pending, settings.routingMode]);
  useEffect(() => {
    if (pending !== "autostart-setting") setAutoStartSelection(settings.autoStartEnabled);
  }, [pending, settings.autoStartEnabled]);

  const workerRunning = status.worker?.phase === "running" && status.worker.state?.listening === true;
  const mutationsDisabled = readOnly || pending !== null;
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
  const autoStartDescription = !settings.autoStartSupported
    ? t("system.autoStartUnavailable")
    : settings.autoStartState === "conflict"
      ? t("system.autoStartConflict")
      : settings.autoStartState === "stale"
        ? t("system.autoStartStale")
        : autoStartSelection
          ? t("system.autoStartOn")
          : t("system.autoStartOff");

  return (
    <div className="page-stack system-page" data-testid="page-system">
      <PageHeader title={t("system.title")} subtitle={t("system.subtitle")} />

      <section className="system-health-grid" aria-label={t("system.health")}>
        <article className="system-health-fact">
          <span className="system-health-icon"><Network aria-hidden="true" /></span>
          <div><span>{t("system.managementService")}</span><StatusBadge tone="success">{t("common.connected")}</StatusBadge></div>
        </article>
        <article className="system-health-fact">
          <span className="system-health-icon"><Server aria-hidden="true" /></span>
          <div><span>{t("system.proxyWorker")}</span><StatusBadge tone={workerRunning ? "success" : "neutral"}>{workerRunning ? t("common.running") : t("common.stopped")}</StatusBadge></div>
        </article>
        <article className="system-health-fact">
          <span className="system-health-icon"><Route aria-hidden="true" /></span>
          <div><span>{t("system.activeProvider")}</span><strong>{activeProvider?.name ?? t("common.none")}</strong></div>
        </article>
        <article className="system-health-fact">
          <span className="system-health-icon"><ShieldCheck aria-hidden="true" /></span>
          <div><span>{t("system.codexTitle")}</span><StatusBadge tone={status.codex.configured ? "success" : "warning"}>{status.codex.configured ? t("common.configured") : t("common.notConfigured")}</StatusBadge></div>
        </article>
      </section>

      <div className="system-workspace">
        <div className="system-main-column">
          <Panel>
            <PanelHeader title={t("system.preferences")} description={t("system.preferencesHelp")} />
            <div className="system-settings-list">
              <div className="system-setting-row">
                <span className="system-setting-icon"><Power aria-hidden="true" /></span>
                <span className="system-setting-copy">
                  <strong>{t("system.autoStart")}</strong>
                  <small>{autoStartDescription}</small>
                  {settings.autoStartSupported ? (
                    <small className="system-setting-meta">{t("system.autoStartPlatform", {
                      platform: platformLabel(settings.autoStartPlatform, t)
                    })}</small>
                  ) : null}
                </span>
                <label className="system-switch-control">
                  <span className="visually-hidden">{t("system.autoStart")}</span>
                  <input
                    type="checkbox"
                    checked={autoStartSelection}
                    disabled={mutationsDisabled || !settings.autoStartSupported
                      || settings.autoStartState === "conflict"}
                    onChange={(event) => {
                      setAutoStartSelection(event.target.checked);
                      onAutoStartChange(event.target.checked);
                    }}
                  />
                  <span className="switch-track" aria-hidden="true"><span /></span>
                </label>
              </div>
              {settings.autoStartState === "stale" ? (
                <div className="system-setting-warning" role="status">
                  <TriangleAlert aria-hidden="true" />
                  <span>{t("system.autoStartStale")}</span>
                  <div>
                    <Button
                      variant="primary"
                      disabled={mutationsDisabled}
                      onClick={() => {
                        setAutoStartSelection(true);
                        onAutoStartChange(true);
                      }}
                    >{t("system.autoStartRepair")}</Button>
                    <Button
                      variant="ghost"
                      disabled={mutationsDisabled}
                      onClick={() => {
                        setAutoStartSelection(false);
                        onAutoStartChange(false);
                      }}
                    >{t("system.autoStartRemove")}</Button>
                  </div>
                </div>
              ) : null}
              {settings.autoStartState === "conflict" ? (
                <div className="system-setting-warning" role="status">
                  <TriangleAlert aria-hidden="true" />
                  <span>{t("system.autoStartConflict")}</span>
                </div>
              ) : null}
              <div className="system-setting-row">
                <span className="system-setting-icon"><Sparkles aria-hidden="true" /></span>
                <span className="system-setting-copy">
                  <strong>{t("system.accountFirst")}</strong>
                  <small>{t(accountFirst ? "system.accountFirstOn" : "system.accountFirstOff")}</small>
                </span>
                <label className="system-switch-control">
                  <span className="visually-hidden">{t("system.accountFirst")}</span>
                  <input
                    type="checkbox"
                    checked={accountFirst}
                    disabled={mutationsDisabled}
                    onChange={(event) => {
                      const mode = event.target.checked ? "account_first" : "custom_only";
                      setRoutingSelection(mode);
                      onRoutingModeChange(mode);
                    }}
                  />
                  <span className="switch-track" aria-hidden="true"><span /></span>
                </label>
              </div>
              <div className="system-account-row">
                <span className="system-setting-icon"><KeyRound aria-hidden="true" /></span>
                <div>
                  <span className="system-account-heading">
                    <StatusBadge tone={accountTone}>{accountLabel}</StatusBadge>
                    {account.planType ? <strong>{account.planType}</strong> : null}
                  </span>
                  <small>{t("system.accountUpdated")}: {formatDate(locale, account.updatedAt, true)}</small>
                  {account.errorCode ? <code>{account.errorCode}</code> : null}
                </div>
                <IconButton
                  label={t("system.refreshAccount")}
                  disabled={mutationsDisabled}
                  onClick={onRefreshAccount}
                >
                  <RefreshCw className={pending === "account-refresh" ? "spin" : undefined} aria-hidden="true" />
                </IconButton>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title={t("system.codexTitle")}
              description={status.codex.configured ? t("system.codexReady") : t("system.codexNotReady")}
            />
            <div className="panel-content system-codex-body">
              <div className="system-tool-status">
                <StatusBadge tone={status.codex.configured ? "success" : "warning"}>
                  {status.codex.configured ? t("common.configured") : t("common.notConfigured")}
                </StatusBadge>
                <code>{status.codex.modelProvider ?? "OpenAI"} · {status.codex.proxyUrl ?? "http://127.0.0.1:15100"}</code>
              </div>
              <Button
                variant="primary"
                disabled={mutationsDisabled}
                busy={pending === "codex-bootstrap"}
                onClick={() => setPrepareOpen(true)}
              ><Settings2 className="icon" aria-hidden="true" />{t("system.prepare")}</Button>
              {bootstrapResult ? (
                <Notice title={t("system.historyRepair")} tone="success">
                  <p>{bootstrapResult.historyRepair.required
                    ? t("system.historyRepairComplete")
                    : t("system.historyRepairNotNeeded")}</p>
                </Notice>
              ) : null}
            </div>
          </Panel>
        </div>

        <div className="system-side-column">
          <Panel>
            <PanelHeader title={t("system.runtime")} description={t("system.runtimeHelp")} />
            <div className="panel-content">
              <DefinitionList rows={[
                { label: t("system.adminAddress"), value: <code>{adminAddress}</code> },
                { label: t("system.proxyAddress"), value: <code>{proxyAddress}</code> },
                { label: t("system.credentialBackend"), value: settings.credentialBackend === "native" ? t("system.native") : settings.credentialBackend ?? t("common.unknown") },
                {
                  label: t("system.metricsStorage"),
                  value: (
                    <StatusBadge tone={metrics?.storageState === "ready" ? "success" : metrics ? "warning" : "neutral"}>
                      {storageLabel(metrics?.storageState ?? null, t)}
                    </StatusBadge>
                  )
                },
                {
                  label: t("system.forwardingCapture"),
                  value: (
                    <StatusBadge tone={status.capture.active
                      ? "success"
                      : status.capture.configured && status.capture.state !== "stopped"
                        ? "warning"
                        : "neutral"}>
                      {captureLabel(status.capture, t)}
                    </StatusBadge>
                  )
                }
              ]} />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title={t("system.about")} description={t("system.aboutHelp")} />
            <div className="panel-content system-about-body">
              <div>
                <span>{t("system.version")}</span>
                <strong>CRP v{status.build.version}</strong>
              </div>
              {status.build.repositoryUrl ? (
                <a href={status.build.repositoryUrl} target="_blank" rel="noreferrer">
                  <GitFork aria-hidden="true" />{t("system.openGithub")}
                </a>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title={t("system.diagnostics")} description={t("system.diagnosticsHelp")} />
            <div className="panel-content system-diagnostics-body">
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
                disabled={mutationsDisabled}
                busy={pending === "diagnostics"}
                onClick={() => void generate()}
              ><Database className="icon" aria-hidden="true" />{t("system.generate")}</Button>
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
