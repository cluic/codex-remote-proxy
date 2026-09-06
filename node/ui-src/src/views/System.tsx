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

import { AccessKeysPanel } from "../components/AccessKeysPanel";
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
  AccessKey,
  AccessKeyInput,
  AccessKeyPatch,
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
  accessKeys: AccessKey[];
  activeProvider: Provider | null;
  metrics: MetricsOverview | null;
  readOnly: boolean;
  pending: string | null;
  onPrepareCodex: () => Promise<BootstrapResult | null>;
  onGenerateDiagnostics: () => Promise<DiagnosticResult | null>;
  onRefreshAccount: () => void;
  onRoutingModeChange: (mode: "custom_only" | "account_first") => void;
  onAutoStartChange: (enabled: boolean) => void;
  onApiKeyAuthChange: (enabled: boolean) => void;
  onProxyHostChange: (host: "127.0.0.1" | "0.0.0.0") => void;
  onCreateAccessKey: (input: AccessKeyInput) => Promise<boolean>;
  onUpdateAccessKey: (id: string, patch: AccessKeyPatch) => Promise<boolean>;
  onDeleteAccessKey: (id: string) => Promise<boolean>;
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

function accountErrorHelp(errorCode: string | null, t: Translator): string | null {
  if (errorCode === "CODEX_MODEL_CATALOG_INVALID") {
    return t("system.accountModelCatalogInvalid");
  }
  if (errorCode === "CODEX_CONFIG_INVALID") return t("system.accountConfigInvalid");
  if (errorCode === "CODEX_COMMAND_UNAVAILABLE") {
    return t("system.accountCommandUnavailable");
  }
  if (errorCode === "ACCOUNT_MONITOR_UNAVAILABLE") {
    return t("system.accountMonitorUnavailable");
  }
  return null;
}

export function SystemPage({
  locale,
  t,
  status,
  settings,
  accessKeys,
  activeProvider,
  metrics,
  readOnly,
  pending,
  onPrepareCodex,
  onGenerateDiagnostics,
  onRefreshAccount,
  onRoutingModeChange,
  onAutoStartChange,
  onApiKeyAuthChange,
  onProxyHostChange,
  onCreateAccessKey,
  onUpdateAccessKey,
  onDeleteAccessKey
}: SystemProps) {
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult | null>(null);
  const [routingSelection, setRoutingSelection] = useState(settings.routingMode);
  const [autoStartSelection, setAutoStartSelection] = useState(settings.autoStartEnabled);
  const [proxyHostSelection, setProxyHostSelection] = useState(settings.proxyHost ?? "127.0.0.1");
  const [apiKeyAuthSelection, setApiKeyAuthSelection] = useState(settings.apiKeyAuthEnabled);
  useEffect(() => {
    if (pending !== "routing-mode") setRoutingSelection(settings.routingMode);
  }, [pending, settings.routingMode]);
  useEffect(() => {
    if (pending !== "autostart-setting") setAutoStartSelection(settings.autoStartEnabled);
  }, [pending, settings.autoStartEnabled]);
  useEffect(() => {
    if (pending !== "proxy-host-setting") {
      setProxyHostSelection(settings.proxyHost ?? "127.0.0.1");
    }
  }, [pending, settings.proxyHost]);
  useEffect(() => {
    if (pending !== "api-key-auth-setting") {
      setApiKeyAuthSelection(settings.apiKeyAuthEnabled);
    }
  }, [pending, settings.apiKeyAuthEnabled]);

  const workerRunning = status.worker?.phase === "running" && status.worker.state?.listening === true;
  const workerStopped = status.worker?.phase === "stopped";
  const workerConfigurable = workerStopped || status.worker?.phase === "running";
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
  const accountErrorDescription = accountErrorHelp(account.errorCode, t);
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
    <div className="page-stack system-page space-y-5" data-testid="page-system">
      <PageHeader title={t("system.title")} subtitle={t("system.subtitle")} />

      <section className="system-health-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t("system.health")}>
        <article className="system-health-fact flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
          <span className="system-health-icon grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-primary"><Network aria-hidden="true" /></span>
          <div><span>{t("system.managementService")}</span><StatusBadge tone="success">{t("common.connected")}</StatusBadge></div>
        </article>
        <article className="system-health-fact flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
          <span className="system-health-icon grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-primary"><Server aria-hidden="true" /></span>
          <div><span>{t("system.proxyWorker")}</span><StatusBadge tone={workerRunning ? "success" : "neutral"}>{workerRunning ? t("common.running") : t("common.stopped")}</StatusBadge></div>
        </article>
        <article className="system-health-fact flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
          <span className="system-health-icon grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-primary"><Route aria-hidden="true" /></span>
          <div><span>{t("system.activeProvider")}</span><strong>{activeProvider?.name ?? t("common.none")}</strong></div>
        </article>
        <article className="system-health-fact flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
          <span className="system-health-icon grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-primary"><ShieldCheck aria-hidden="true" /></span>
          <div><span>{t("system.codexTitle")}</span><StatusBadge tone={status.codex.configured ? "success" : "warning"}>{status.codex.configured ? t("common.configured") : t("common.notConfigured")}</StatusBadge></div>
        </article>
      </section>

      <div className="system-workspace grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,.75fr)]">
        <div className="system-main-column grid min-w-0 gap-4">
          <Panel>
            <PanelHeader title={t("system.preferences")} description={t("system.preferencesHelp")} />
            <div className="system-settings-list divide-y divide-border">
              <div className="system-setting-row grid min-w-0 items-center gap-3 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className="system-setting-icon grid size-8 place-items-center rounded-lg bg-muted text-primary"><Network aria-hidden="true" /></span>
                <span className="system-setting-copy">
                  <strong>{t("system.proxyListenAddress")}</strong>
                  <small>{t(!workerStopped
                    ? "system.proxyListenStopHelp"
                    : proxyHostSelection === "0.0.0.0"
                      ? "system.proxyListenPublicHelp"
                      : "system.proxyListenLocalHelp")}</small>
                </span>
                <select
                  className="system-inline-select"
                  aria-label={t("system.proxyListenAddress")}
                  value={proxyHostSelection}
                  disabled={mutationsDisabled || !workerStopped}
                  onChange={(event) => {
                    const host = event.target.value as "127.0.0.1" | "0.0.0.0";
                    setProxyHostSelection(host);
                    if (host === "0.0.0.0") setApiKeyAuthSelection(true);
                    onProxyHostChange(host);
                  }}
                >
                  <option value="127.0.0.1">127.0.0.1</option>
                  <option value="0.0.0.0">0.0.0.0</option>
                </select>
              </div>
              <div className="system-setting-row grid min-w-0 items-center gap-3 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className="system-setting-icon grid size-8 place-items-center rounded-lg bg-muted text-primary"><LockKeyhole aria-hidden="true" /></span>
                <span className="system-setting-copy">
                  <strong>{t("system.apiKeyAuth")}</strong>
                  <small>{t(settings.apiKeyAuthRequired
                    ? "system.apiKeyAuthRequired"
                    : !workerConfigurable
                      ? "system.apiKeyAuthPhaseHelp"
                      : apiKeyAuthSelection
                        ? "system.apiKeyAuthOn"
                        : "system.apiKeyAuthOff")}</small>
                </span>
                <label className="system-switch-control">
                  <span className="visually-hidden">{t("system.apiKeyAuth")}</span>
                  <input
                    type="checkbox"
                    checked={apiKeyAuthSelection}
                    disabled={mutationsDisabled || !workerConfigurable || settings.apiKeyAuthRequired}
                    onChange={(event) => {
                      setApiKeyAuthSelection(event.target.checked);
                      onApiKeyAuthChange(event.target.checked);
                    }}
                  />
                  <span className="switch-track" aria-hidden="true"><span /></span>
                </label>
              </div>
              <div className="system-setting-row grid min-w-0 items-center gap-3 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className="system-setting-icon grid size-8 place-items-center rounded-lg bg-muted text-primary"><Power aria-hidden="true" /></span>
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
                <div className="system-setting-warning flex flex-wrap items-center gap-3 border-t border-border bg-muted/35 px-4 py-3" role="status">
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
                <div className="system-setting-warning flex items-center gap-3 border-t border-border bg-muted/35 px-4 py-3" role="status">
                  <TriangleAlert aria-hidden="true" />
                  <span>{t("system.autoStartConflict")}</span>
                </div>
              ) : null}
              <div className="system-setting-row grid min-w-0 items-center gap-3 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className="system-setting-icon grid size-8 place-items-center rounded-lg bg-muted text-primary"><Sparkles aria-hidden="true" /></span>
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
              <div className="system-account-row grid min-w-0 items-center gap-3 border-t border-border bg-muted/20 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className="system-setting-icon grid size-8 place-items-center rounded-lg bg-muted text-primary"><KeyRound aria-hidden="true" /></span>
                <div>
                  <span className="system-account-heading">
                    <StatusBadge tone={accountTone}>{accountLabel}</StatusBadge>
                    {account.planType ? <strong>{account.planType}</strong> : null}
                  </span>
                  <small>{t("system.accountUpdated")}: {formatDate(locale, account.updatedAt, true)}</small>
                  {account.errorCode ? <code>{account.errorCode}</code> : null}
                  {accountErrorDescription ? (
                    <small className="system-account-error-help">
                      {accountErrorDescription}
                    </small>
                  ) : null}
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

          <AccessKeysPanel
            locale={locale}
            t={t}
            accessKeys={accessKeys}
            readOnly={readOnly}
            pending={pending}
            onCreate={onCreateAccessKey}
            onUpdate={onUpdateAccessKey}
            onDelete={onDeleteAccessKey}
          />

          <Panel>
            <PanelHeader
              title={t("system.codexTitle")}
              description={status.codex.configured ? t("system.codexReady") : t("system.codexNotReady")}
            />
            <div className="panel-content system-codex-body grid gap-4 p-4">
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

        <div className="system-side-column grid min-w-0 gap-4">
          <Panel>
            <PanelHeader title={t("system.runtime")} description={t("system.runtimeHelp")} />
            <div className="panel-content p-4">
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
            <div className="panel-content system-about-body grid gap-3 p-4">
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
            <div className="panel-content system-diagnostics-body grid gap-4 p-4">
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
