import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Play,
  RefreshCw,
  ShieldCheck,
  TestTube2
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { asApiError } from "../api";
import { ModelPicker } from "../components/ModelPicker";
import {
  Button,
  ErrorNotice,
  Field,
  FormError,
  Modal,
  Notice,
  PageHeader,
  SelectField,
  TextareaField,
  cx
} from "../components/Primitives";
import type { Translator } from "../i18n";
import type {
  BootstrapResult,
  ModelCatalog,
  Provider,
  ProviderInput,
  StatusResponse
} from "../types";

type SetupProps = {
  t: Translator;
  providers: Provider[];
  status: StatusResponse;
  readOnly: boolean;
  pending: string | null;
  onCreate: (input: ProviderInput, credential: string) => Promise<Provider | null>;
  onTest: (id: string, model: string, switchAfter: boolean, activateIfNone?: boolean) => Promise<boolean>;
  onPrepareCodex: () => Promise<BootstrapResult | null>;
  onStart: () => void;
  onGetModels: (id: string, signal?: AbortSignal) => Promise<ModelCatalog>;
  onRefreshModels: (id: string) => Promise<ModelCatalog | null>;
  onComplete: () => void;
};

type SetupPhase = "provider" | "test" | "activate" | "codex" | "worker" | "complete";

function loopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

export function SetupPage({
  t,
  providers,
  status,
  readOnly,
  pending,
  onCreate,
  onTest,
  onPrepareCodex,
  onStart,
  onGetModels,
  onRefreshModels,
  onComplete
}: SetupProps) {
  const [selectedId, setSelectedId] = useState(status.activeProviderId ?? providers[0]?.id ?? "");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://");
  const [credential, setCredential] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [authHeader, setAuthHeader] = useState("authorization");
  const [authScheme, setAuthScheme] = useState("Bearer");
  const [extraHeadersText, setExtraHeadersText] = useState("{}");
  const [modelMode, setModelMode] = useState<"passthrough" | "override">("passthrough");
  const [modelOverride, setModelOverride] = useState("");
  const [model, setModel] = useState("");
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<ReturnType<typeof asApiError> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [prepareOpen, setPrepareOpen] = useState(false);
  const credentialRef = useRef<HTMLInputElement>(null);
  const writeDisabled = readOnly || pending !== null;

  useEffect(() => {
    if (!providers.some((provider) => provider.id === selectedId)) {
      setSelectedId(status.activeProviderId ?? providers[0]?.id ?? "");
    }
  }, [providers, selectedId, status.activeProviderId]);

  const selected = providers.find((provider) => provider.id === selectedId) ?? null;
  const selectedModelOverride = selected?.modelOverride ?? "";
  const workerRunning = status.worker?.phase === "running" && status.worker.state?.listening === true;
  let phase: SetupPhase = "provider";
  if (providers.length > 0) {
    if (!status.activeProviderId) phase = selected?.lastTestStatus === "passed" ? "activate" : "test";
    else if (status.activeProvider?.lastTestStatus !== "passed") phase = "test";
    else if (!status.codex.configured) phase = "codex";
    else phase = workerRunning ? "complete" : "worker";
  }

  useEffect(() => {
    if (phase !== "test" || !selectedId) return undefined;
    const controller = new AbortController();
    setCatalog(null);
    setCatalogError(null);
    void onGetModels(selectedId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setCatalog(next);
        setModel((current) => current || next.models[0] || selectedModelOverride);
      })
      .catch((error) => { if (!controller.signal.aborted) setCatalogError(asApiError(error)); });
    return () => controller.abort();
  }, [onGetModels, phase, selectedId, selectedModelOverride]);

  const createProvider = async (event: FormEvent) => {
    event.preventDefault();
    const secret = credentialRef.current?.value ?? credential;
    setCredential("");
    if (credentialRef.current) credentialRef.current.value = "";
    setFormError(null);
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      setFormError(t("providers.invalidUrl"));
      return;
    }
    if (name.trim().length === 0 || secret.length === 0
      || parsed.username || parsed.password
      || parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback(parsed.hostname))
      || modelMode === "override" && modelOverride.trim().length === 0) {
      setFormError(t("providers.invalidForm"));
      return;
    }
    let extraHeaders: Record<string, string>;
    try {
      const value: unknown = JSON.parse(extraHeadersText || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.values(value).some((header) => typeof header !== "string")) throw new Error("invalid");
      extraHeaders = value as Record<string, string>;
    } catch {
      setFormError(t("providers.invalidHeaders"));
      return;
    }
    const created = await onCreate({
      name: name.trim(),
      baseUrl: parsed.toString().replace(/\/$/, ""),
      authHeader: authHeader.trim() || "authorization",
      authScheme: authScheme.trim(),
      extraHeaders,
      modelMode,
      modelOverride: modelMode === "override" ? modelOverride.trim() : null
    }, secret);
    if (created) setSelectedId(created.id);
  };

  const refreshCatalog = async () => {
    if (!selected) return;
    const next = await onRefreshModels(selected.id);
    if (next) {
      setCatalog(next);
      setModel((current) => current || next.models[0] || "");
    }
  };

  const steps = [
    { key: "provider" as const, label: t("setup.stepProvider"), complete: providers.length > 0 },
    { key: "test" as const, label: t("setup.stepTest"), complete: selected?.lastTestStatus === "passed" || status.activeProvider?.lastTestStatus === "passed" },
    { key: "activate" as const, label: t("setup.stepActivate"), complete: status.activeProviderId !== null },
    { key: "codex" as const, label: t("setup.stepCodex"), complete: status.codex.configured },
    { key: "worker" as const, label: t("setup.stepWorker"), complete: workerRunning }
  ];

  return (
    <div className="page-stack setup-page" data-testid="page-setup">
      <PageHeader title={t("setup.title")} subtitle={t("setup.subtitle")} />
      <div className="setup-layout">
        <aside className="setup-progress" aria-label={t("setup.progress")}>
          <span className="setup-eyebrow">{t("setup.firstRun")}</span>
          <h2>{t("setup.progress")}</h2>
          <ol>
            {steps.map((step, index) => (
              <li key={step.key} className={cx(step.complete && "step-complete", phase === step.key && "step-current")}>
                <span className="step-icon" aria-hidden="true">
                  {step.complete ? <CheckCircle2 /> : <Circle />}
                </span>
                <div><small>0{index + 1}</small><strong>{step.label}</strong></div>
              </li>
            ))}
          </ol>
        </aside>
        <section className="setup-stage">
          {phase === "provider" ? (
            <form onSubmit={createProvider} noValidate>
              <header className="setup-stage-header">
                <h2>{t("setup.providerTitle")}</h2>
                <p>{t("setup.providerHelp")}</p>
              </header>
              {formError ? <FormError>{formError}</FormError> : null}
              <div className="form-grid">
                <Field id="setup-provider-name" label={t("providers.name")} value={name} onChange={(event) => setName(event.target.value)} disabled={writeDisabled} autoFocus required />
                <Field id="setup-provider-url" label={t("providers.url")} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={writeDisabled} required spellCheck={false} />
                <Field
                  ref={credentialRef}
                  className="form-field-wide"
                  id="setup-provider-credential"
                  label={t("providers.apiKey")}
                  help={t("providers.secretHelp")}
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  disabled={writeDisabled}
                  required
                />
              </div>
              <label className="checkbox-field">
                <input type="checkbox" checked={advanced} onChange={(event) => setAdvanced(event.target.checked)} disabled={writeDisabled} />
                <span>{t("providers.advanced")}</span>
              </label>
              {advanced ? (
                <div className="form-grid advanced-fields">
                  <Field id="setup-auth-header" label={t("providers.authHeader")} value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} disabled={writeDisabled} />
                  <Field id="setup-auth-scheme" label={t("providers.authScheme")} value={authScheme} onChange={(event) => setAuthScheme(event.target.value)} disabled={writeDisabled} />
                  <TextareaField className="form-field-wide" id="setup-extra-headers" label={t("providers.extraHeaders")} value={extraHeadersText} onChange={(event) => setExtraHeadersText(event.target.value)} disabled={writeDisabled} rows={4} />
                  <SelectField id="setup-model-mode" label={t("providers.modelMode")} value={modelMode} onChange={(event) => setModelMode(event.target.value as "passthrough" | "override")} disabled={writeDisabled}>
                    <option value="passthrough">{t("providers.passthrough")}</option>
                    <option value="override">{t("providers.override")}</option>
                  </SelectField>
                  {modelMode === "override" ? <Field id="setup-model-override" label={t("providers.overrideModel")} value={modelOverride} onChange={(event) => setModelOverride(event.target.value)} disabled={writeDisabled} /> : null}
                </div>
              ) : null}
              <div className="setup-stage-actions">
                <Button variant="primary" type="submit" busy={pending === "provider-create"} disabled={readOnly || pending !== null}>
                  {t("providers.saveCreate")}<ArrowRight className="icon" aria-hidden="true" />
                </Button>
              </div>
            </form>
          ) : null}

          {phase === "test" || phase === "activate" ? (
            <div>
              <header className="setup-stage-header">
                <h2>{t(phase === "activate" ? "setup.activateTitle" : "setup.testTitle")}</h2>
                <p>{t(phase === "activate" ? "setup.activateHelp" : "setup.testHelp")}</p>
              </header>
              {providers.length > 1 ? (
                <SelectField id="setup-provider-select" label={t("setup.chooseProvider")} value={selectedId} onChange={(event) => {
                  setSelectedId(event.target.value);
                  setCatalog(null);
                  setCatalogError(null);
                  setModel("");
                }} disabled={writeDisabled}>
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </SelectField>
              ) : null}
              <div className="setup-test-controls">
                <ModelPicker
                  key={selectedId}
                  id="setup-test-model"
                  model={model}
                  models={catalog?.models ?? []}
                  disabled={writeDisabled}
                  autoFocus
                  t={t}
                  onChange={setModel}
                />
                <Button disabled={readOnly || pending !== null || !selected?.credentialConfigured} onClick={() => void refreshCatalog()}>
                  <RefreshCw className="icon" aria-hidden="true" />{t("providers.refreshModels")}
                </Button>
              </div>
              {catalogError ? <ErrorNotice error={catalogError} t={t} /> : null}
              <div className="setup-stage-actions">
                <Button
                  variant="primary"
                  busy={pending === `provider-test-${selected?.id ?? ""}`}
                  disabled={readOnly || pending !== null || !selected || !model.trim()}
                  onClick={() => { if (selected) void onTest(selected.id, model.trim(), false, true); }}
                ><TestTube2 className="icon" aria-hidden="true" />
                  {t(phase === "activate" ? "providers.runTestAndSelect" : "providers.runTest")}
                </Button>
              </div>
            </div>
          ) : null}

          {phase === "codex" ? (
            <div>
              <header className="setup-stage-header"><h2>{t("setup.codexTitle")}</h2><p>{t("setup.codexHelp")}</p></header>
              <Notice title="OpenAI" tone="info"><p><code>http://127.0.0.1:15100</code></p></Notice>
              <div className="setup-stage-actions">
                <Button variant="primary" disabled={readOnly || pending !== null} onClick={() => setPrepareOpen(true)}>
                  <ShieldCheck className="icon" aria-hidden="true" />{t("system.prepare")}
                </Button>
              </div>
            </div>
          ) : null}

          {phase === "worker" ? (
            <div>
              <header className="setup-stage-header"><h2>{t("setup.workerTitle")}</h2><p>{t("setup.workerHelp")}</p></header>
              <Notice title={status.activeProvider?.name ?? t("common.current")} tone="success"><p><code>127.0.0.1:15100</code></p></Notice>
              <div className="setup-stage-actions">
                <Button variant="primary" busy={pending === "proxy-start"} disabled={readOnly || pending !== null} onClick={onStart}>
                  <Play className="icon" aria-hidden="true" />{t("overview.startProxy")}
                </Button>
              </div>
            </div>
          ) : null}

          {phase === "complete" ? (
            <div className="setup-complete">
              <CheckCircle2 aria-hidden="true" />
              <h2>{t("setup.completeTitle")}</h2>
              <p>{t("setup.completeHelp")}</p>
              <Button variant="primary" onClick={onComplete}>{t("setup.openOverview")}<ArrowRight className="icon" aria-hidden="true" /></Button>
            </div>
          ) : null}
        </section>
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
            <Button
              variant="primary"
              disabled={writeDisabled}
              onClick={async () => {
                setPrepareOpen(false);
                await onPrepareCodex();
              }}
            >{t("system.prepare")}</Button>
          </>
        )}
      ><Notice title="OpenAI · 127.0.0.1:15100" tone="info"><p>{t("system.prepareHelp")}</p></Notice></Modal>
    </div>
  );
}
