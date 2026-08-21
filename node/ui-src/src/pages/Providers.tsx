import {
  ArrowRightLeft,
  Boxes,
  Check,
  ChevronRight,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  TestTube2,
  Trash2
} from "lucide-react";
import {
  type FormEvent,
  type MutableRefObject,
  useEffect,
  useRef,
  useState
} from "react";

import { ApiError, asApiError } from "../api";
import { ModelPicker } from "../components/ModelPicker";
import {
  Button,
  DefinitionList,
  EmptyState,
  ErrorNotice,
  Field,
  FormError,
  IconButton,
  Modal,
  Notice,
  PageHeader,
  SelectField,
  StatusBadge,
  TextareaField
} from "../components/Primitives";
import { formatDate, formatNumber, type Translator } from "../i18n";
import type { Locale, ModelCatalog, Provider, ProviderInput } from "../types";

type ProvidersProps = {
  locale: Locale;
  t: Translator;
  providers: Provider[];
  activeProviderId: string | null;
  workerRunning: boolean;
  readOnly: boolean;
  pending: string | null;
  onCreate: (input: ProviderInput, credential: string) => Promise<Provider | null>;
  onUpdate: (id: string, input: ProviderInput, replacement?: string) => Promise<Provider | null>;
  onWeight: (id: string, weight: number) => Promise<boolean>;
  onTest: (id: string, model: string, switchAfter: boolean, activateIfNone?: boolean) => Promise<boolean>;
  onActivate: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onGetModels: (id: string, signal?: AbortSignal) => Promise<ModelCatalog>;
  onRefreshModels: (id: string) => Promise<ModelCatalog | null>;
};

type DialogMode = "create" | "duplicate" | "detail" | "edit" | "test" | "delete" | null;
type FormPurpose = "create" | "duplicate" | "edit";

function testTone(status: Provider["lastTestStatus"]): "success" | "warning" | "danger" {
  if (status === "passed") return "success";
  if (status === "failed") return "danger";
  return "warning";
}

function testLabel(provider: Provider, t: Translator): string {
  if (provider.lastTestStatus === "passed") return t("common.passed");
  if (provider.lastTestStatus === "failed") return t("common.failed");
  return t("common.untested");
}

function modelPolicy(provider: Provider, t: Translator): string {
  return provider.modelMode === "override"
    ? t("providers.modelModeOverride", { model: provider.modelOverride ?? "-" })
    : t("providers.modelModePassthrough");
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function validateProviderInput(
  values: Omit<ProviderInput, "extraHeaders"> & { extraHeadersText: string },
  t: Translator
): { input?: ProviderInput; error?: string } {
  if (values.name.trim().length === 0) return { error: t("providers.invalidForm") };
  if (!Number.isInteger(values.weight) || values.weight < 1 || values.weight > 1_000) {
    return { error: t("providers.invalidWeight") };
  }
  let parsed: URL;
  try {
    parsed = new URL(values.baseUrl);
  } catch {
    return { error: t("providers.invalidUrl") };
  }
  if (parsed.username || parsed.password || parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    return { error: t("providers.invalidUrl") };
  }
  if (values.modelMode === "override" && !values.modelOverride?.trim()) {
    return { error: t("providers.invalidForm") };
  }
  let extraHeaders: Record<string, string>;
  try {
    const candidate: unknown = JSON.parse(values.extraHeadersText || "{}");
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.values(candidate).some((value) => typeof value !== "string")) {
      return { error: t("providers.invalidHeaders") };
    }
    extraHeaders = candidate as Record<string, string>;
  } catch {
    return { error: t("providers.invalidHeaders") };
  }
  return {
    input: {
      name: values.name.trim(),
      baseUrl: parsed.toString().replace(/\/$/, ""),
      authHeader: values.authHeader.trim() || "authorization",
      authScheme: values.authScheme.trim(),
      extraHeaders,
      weight: values.weight,
      modelMode: values.modelMode,
      modelOverride: values.modelMode === "override" ? values.modelOverride?.trim() || null : null
    }
  };
}

function clearSecret(
  inputRef: MutableRefObject<HTMLInputElement | null>,
  value: string,
  setValue: (value: string) => void
): string {
  const secret = inputRef.current?.value ?? value;
  setValue("");
  if (inputRef.current) inputRef.current.value = "";
  return secret;
}

function ProviderForm({
  provider,
  purpose,
  initialName,
  pending,
  t,
  onSubmit
}: {
  provider?: Provider;
  purpose: FormPurpose;
  initialName?: string;
  pending: boolean;
  t: Translator;
  onSubmit: (input: ProviderInput, secret?: string) => Promise<boolean>;
}) {
  const editing = purpose === "edit";
  const [name, setName] = useState(initialName ?? provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "https://");
  const [credential, setCredential] = useState("");
  const [weight, setWeight] = useState(provider?.weight ?? 100);
  const [advanced, setAdvanced] = useState(false);
  const [authHeader, setAuthHeader] = useState(provider?.authHeader ?? "authorization");
  const [authScheme, setAuthScheme] = useState(provider?.authScheme ?? "Bearer");
  const [extraHeadersText, setExtraHeadersText] = useState(JSON.stringify(provider?.extraHeaders ?? {}, null, 2));
  const [modelMode, setModelMode] = useState<"passthrough" | "override">(provider?.modelMode ?? "passthrough");
  const [modelOverride, setModelOverride] = useState(provider?.modelOverride ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const credentialRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const secret = clearSecret(credentialRef, credential, setCredential);
    setFormError(null);
    const validation = validateProviderInput({
      name,
      baseUrl,
      authHeader,
      authScheme,
      extraHeadersText,
      weight,
      modelMode,
      modelOverride
    }, t);
    if (!validation.input || !editing && secret.length === 0) {
      setFormError(validation.error ?? t("providers.invalidForm"));
      return;
    }
    const complete = await onSubmit(validation.input, secret || undefined);
    if (!complete) setFormError(t("providers.invalidForm"));
  };

  return (
    <form id="provider-form" className="provider-form" onSubmit={submit} noValidate>
      {formError ? <FormError>{formError}</FormError> : null}
      <div className="form-grid">
        <Field
          id="provider-name"
          name="name"
          label={t("providers.name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          required
          autoFocus
        />
        <Field
          id="provider-base-url"
          name="baseUrl"
          label={t("providers.url")}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          inputMode="url"
          spellCheck={false}
          required
        />
        <Field
          id="provider-weight"
          name="weight"
          label={t("providers.weight")}
          help={t(editing ? "providers.weightEditHelp" : "providers.weightHelp")}
          value={weight}
          onChange={(event) => setWeight(Number(event.target.value))}
          type="number"
          min={1}
          max={1_000}
          step={1}
          disabled={editing}
          required
        />
        <Field
          ref={credentialRef}
          className="form-field-wide"
          id="provider-credential"
          name="credential"
          label={editing ? t("providers.replacementKey") : t("providers.apiKey")}
          help={t("providers.secretHelp")}
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          type="password"
          autoComplete="new-password"
          required={!editing}
        />
      </div>
      <label className="checkbox-field">
        <input type="checkbox" checked={advanced} onChange={(event) => setAdvanced(event.target.checked)} />
        <span>{t("providers.advanced")}</span>
      </label>
      {advanced ? (
        <div className="form-grid advanced-fields">
          <Field
            id="provider-auth-header"
            name="authHeader"
            label={t("providers.authHeader")}
            value={authHeader}
            onChange={(event) => setAuthHeader(event.target.value)}
            spellCheck={false}
          />
          <Field
            id="provider-auth-scheme"
            name="authScheme"
            label={t("providers.authScheme")}
            value={authScheme}
            onChange={(event) => setAuthScheme(event.target.value)}
            spellCheck={false}
          />
          <TextareaField
            className="form-field-wide"
            id="provider-extra-headers"
            name="extraHeaders"
            label={t("providers.extraHeaders")}
            value={extraHeadersText}
            onChange={(event) => setExtraHeadersText(event.target.value)}
            rows={4}
            spellCheck={false}
          />
          <SelectField
            id="provider-model-mode"
            name="modelMode"
            label={t("providers.modelMode")}
            value={modelMode}
            onChange={(event) => setModelMode(event.target.value as "passthrough" | "override")}
          >
            <option value="passthrough">{t("providers.passthrough")}</option>
            <option value="override">{t("providers.override")}</option>
          </SelectField>
          {modelMode === "override" ? (
            <Field
              id="provider-model-override"
              name="modelOverride"
              label={t("providers.overrideModel")}
              value={modelOverride}
              onChange={(event) => setModelOverride(event.target.value)}
              spellCheck={false}
              required
            />
          ) : null}
        </div>
      ) : null}
      <button className="visually-hidden" type="submit" disabled={pending}>{t("common.save")}</button>
    </form>
  );
}

export function ProvidersPage({
  locale,
  t,
  providers,
  activeProviderId,
  workerRunning,
  readOnly,
  pending,
  onCreate,
  onUpdate,
  onWeight,
  onTest,
  onActivate,
  onDelete,
  onGetModels,
  onRefreshModels
}: ProvidersProps) {
  const [mode, setMode] = useState<DialogMode>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [switchAfterTest, setSwitchAfterTest] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<ApiError | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [model, setModel] = useState("");
  const selected = providers.find((provider) => provider.id === selectedId);
  const selectedPoolLocked = workerRunning && selected?.lastTestStatus === "passed";

  const duplicateName = (provider: Provider): string => {
    const occupied = new Set(providers.map((item) => item.name.toLocaleLowerCase()));
    const base = t("providers.copyName", { name: provider.name });
    if (!occupied.has(base.toLocaleLowerCase())) return base;
    let index = 2;
    while (occupied.has(t("providers.copyNameNumber", { name: provider.name, index }).toLocaleLowerCase())) {
      index += 1;
    }
    return t("providers.copyNameNumber", { name: provider.name, index });
  };

  useEffect(() => {
    if (!selectedId || mode !== "detail" && mode !== "test") return undefined;
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(null);
    void onGetModels(selectedId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setCatalog(next);
        setModel((current) => current || next.models[0] || "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCatalogError(asApiError(error));
      })
      .finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [mode, onGetModels, selectedId]);

  const open = (nextMode: DialogMode, provider?: Provider, testAndSwitch = false) => {
    setSelectedId(provider?.id ?? null);
    setMode(nextMode);
    setSwitchAfterTest(testAndSwitch);
    setCatalog(null);
    setCatalogError(null);
    setModel(provider?.modelOverride ?? "");
  };

  const close = () => {
    setMode(null);
    setSelectedId(null);
    setSwitchAfterTest(false);
    setCatalog(null);
    setCatalogError(null);
    setModel("");
  };

  const refreshCatalog = async () => {
    if (!selected) return;
    const next = await onRefreshModels(selected.id);
    if (next) {
      setCatalog(next);
      setModel((current) => current || next.models[0] || "");
    }
  };

  const runTest = async () => {
    if (!selected || !model.trim()) return;
    const complete = await onTest(
      selected.id,
      model.trim(),
      switchAfterTest,
      activeProviderId === null
    );
    if (complete) close();
  };

  return (
    <div className="page-stack" data-testid="page-providers">
      <PageHeader
        title={t("providers.title")}
        subtitle={t("providers.subtitle")}
        action={(
          <Button variant="primary" disabled={readOnly || pending !== null} onClick={() => open("create")}>
            <Plus className="icon" aria-hidden="true" />{t("providers.add")}
          </Button>
        )}
      />

      {providers.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title={t("providers.emptyTitle")}
          description={t("providers.emptyHelp")}
          action={(
            <Button variant="primary" disabled={readOnly} onClick={() => open("create")}>
              <Plus className="icon" aria-hidden="true" />{t("providers.add")}
            </Button>
          )}
        />
      ) : (
        <section className="provider-grid" aria-label={t("providers.title")}>
          {providers.map((provider) => {
            const active = provider.id === activeProviderId;
            const eligible = provider.lastTestStatus === "passed" && provider.credentialConfigured;
            const poolLocked = workerRunning && provider.lastTestStatus === "passed";
            return (
              <article
                key={provider.id}
                className={active ? "provider-card provider-card-active" : "provider-card"}
                data-testid={`provider-card-${provider.id}`}
              >
                <header className="provider-card-header">
                  <div className="provider-avatar" aria-hidden="true">{provider.name.slice(0, 1).toUpperCase()}</div>
                  <div className="provider-card-title">
                    <h2>{provider.name}</h2>
                    <code>{provider.baseUrl}</code>
                  </div>
                  {active ? <StatusBadge tone="success"><Check aria-hidden="true" />{t("providers.preferred")}</StatusBadge> : null}
                </header>
                <dl className="provider-card-facts">
                  <div><dt>{t("providers.testStatus")}</dt><dd><StatusBadge tone={testTone(provider.lastTestStatus)}>{testLabel(provider, t)}</StatusBadge></dd></div>
                  <div><dt>{t("providers.lastTest")}</dt><dd>{provider.lastTestAt ? formatDate(locale, provider.lastTestAt) : t("common.none")}</dd></div>
                  <div><dt>{t("providers.modelPolicy")}</dt><dd>{modelPolicy(provider, t)}</dd></div>
                  <div><dt>{t("providers.credential")}</dt><dd>{provider.credentialConfigured ? t("common.configured") : t("common.notConfigured")}</dd></div>
                  <div className="provider-weight-fact">
                    <dt>{t("providers.weight")}</dt>
                    <dd>
                      <form
                        className="provider-weight-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const field = event.currentTarget.elements.namedItem("weight") as HTMLInputElement;
                          const weight = Number(field.value);
                          if (Number.isInteger(weight) && weight >= 1 && weight <= 1_000) {
                            void onWeight(provider.id, weight);
                          }
                        }}
                      >
                        <input
                          key={`${provider.id}-${provider.weight}`}
                          name="weight"
                          type="number"
                          min={1}
                          max={1_000}
                          step={1}
                          defaultValue={provider.weight}
                          aria-label={t("providers.weightNamed", { name: provider.name })}
                          disabled={readOnly || pending !== null}
                        />
                        <Button
                          className="button-small"
                          type="submit"
                          busy={pending === `provider-weight-${provider.id}`}
                          disabled={readOnly || pending !== null}
                        >{t("providers.applyWeight")}</Button>
                      </form>
                    </dd>
                  </div>
                </dl>
                {!active && !eligible ? (
                  <p className="provider-card-reason">
                    {provider.credentialConfigured ? testLabel(provider, t) : t("providers.credentialRequired")}
                  </p>
                ) : null}
                <footer className="provider-card-actions">
                  <Button variant="ghost" onClick={() => open("detail", provider)} aria-label={t("providers.detailsNamed", { name: provider.name })}>
                    {t("common.details")}<ChevronRight className="icon" aria-hidden="true" />
                  </Button>
                  <IconButton
                    className="provider-copy-action"
                    label={t("providers.copyNamed", { name: provider.name })}
                    disabled={readOnly || pending !== null}
                    onClick={() => open("duplicate", provider)}
                  ><Copy aria-hidden="true" /></IconButton>
                  {active ? (
                    <Button
                      disabled={readOnly || pending !== null || !provider.credentialConfigured}
                      onClick={() => open("test", provider)}
                      aria-label={t("providers.testNamed", { name: provider.name })}
                    ><TestTube2 className="icon" aria-hidden="true" />{t("providers.test")}</Button>
                  ) : (
                    <Button
                      variant="primary"
                      busy={pending === `provider-switch-${provider.id}`}
                      disabled={readOnly || pending !== null || !provider.credentialConfigured}
                      onClick={() => eligible && activeProviderId !== null
                        ? void onActivate(provider.id)
                        : open("test", provider, true)}
                    >
                      <ArrowRightLeft className="icon" aria-hidden="true" />
                      {activeProviderId === null
                        ? t("providers.runTestAndSelect")
                        : eligible
                          ? t(workerRunning ? "providers.switch" : "providers.switchAndStart")
                          : t(workerRunning ? "providers.testAndSwitch" : "providers.testSwitchAndStart")}
                    </Button>
                  )}
                </footer>
              </article>
            );
          })}
        </section>
      )}

      <Modal
        open={mode === "create"}
        title={t("providers.createTitle")}
        description={t("providers.formHelp")}
        onClose={close}
        t={t}
        size="large"
        footer={(
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" form="provider-form" busy={pending === "provider-create"}>
              {t("providers.saveCreate")}
            </Button>
          </>
        )}
      >
        {mode === "create" ? (
          <ProviderForm
            purpose="create"
            pending={pending !== null}
            t={t}
            onSubmit={async (input, secret) => {
              if (!secret) return false;
              const created = await onCreate(input, secret);
              if (created) close();
              return created !== null;
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={mode === "duplicate"}
        title={t("providers.copyTitle")}
        description={selected ? t("providers.copyHelp", { name: selected.name }) : undefined}
        onClose={close}
        t={t}
        size="large"
        footer={(
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" form="provider-form" busy={pending === "provider-create"}>
              {t("providers.saveCopy")}
            </Button>
          </>
        )}
      >
        {mode === "duplicate" && selected ? (
          <ProviderForm
            provider={selected}
            purpose="duplicate"
            initialName={duplicateName(selected)}
            pending={pending !== null}
            t={t}
            onSubmit={async (input, secret) => {
              if (!secret) return false;
              const created = await onCreate(input, secret);
              if (created) close();
              return created !== null;
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={mode === "edit"}
        title={t("providers.editTitle")}
        description={t("providers.formHelp")}
        onClose={close}
        t={t}
        size="large"
        footer={(
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" form="provider-form" busy={pending === `provider-update-${selected?.id ?? ""}`}>
              {t("providers.saveEdit")}
            </Button>
          </>
        )}
      >
        {mode === "edit" && selected ? (
          <ProviderForm
            provider={selected}
            purpose="edit"
            pending={pending !== null}
            t={t}
            onSubmit={async (input, secret) => {
              const updated = await onUpdate(selected.id, input, secret);
              if (updated) close();
              return updated !== null;
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={mode === "detail"}
        title={selected?.name ?? t("providers.detailTitle")}
        description={selected?.baseUrl}
        onClose={close}
        t={t}
        size="large"
        footer={selected ? (
          <>
            <Button
              variant="danger"
              disabled={readOnly || selected.id === activeProviderId || pending !== null || selectedPoolLocked}
              onClick={() => setMode("delete")}
              aria-label={t("providers.deleteNamed", { name: selected.name })}
            ><Trash2 className="icon" aria-hidden="true" />{t("providers.delete")}</Button>
            <span className="modal-footer-spacer" />
            <Button
              disabled={readOnly || selected.id === activeProviderId || pending !== null || selectedPoolLocked}
              onClick={() => setMode("edit")}
              aria-label={t("providers.editNamed", { name: selected.name })}
            ><Pencil className="icon" aria-hidden="true" />{t("providers.editTitle")}</Button>
            {activeProviderId !== null ? (
              <Button disabled={readOnly || pending !== null || !selected.credentialConfigured} onClick={() => setMode("test")}>
                <TestTube2 className="icon" aria-hidden="true" />{t("providers.test")}
              </Button>
            ) : null}
            {selected.id !== activeProviderId ? (
              <Button
                variant="primary"
                disabled={readOnly || pending !== null || !selected.credentialConfigured
                  || activeProviderId !== null && selected.lastTestStatus !== "passed"}
                onClick={async () => {
                  if (activeProviderId === null) {
                    setSwitchAfterTest(true);
                    setMode("test");
                  } else if (await onActivate(selected.id)) close();
                }}
              ><ArrowRightLeft className="icon" aria-hidden="true" />
                {t(activeProviderId === null
                  ? "providers.runTestAndSelect"
                  : workerRunning ? "providers.activate" : "providers.activateAndStart")}
              </Button>
            ) : null}
          </>
        ) : undefined}
      >
        {selected ? (
          <div className="provider-detail-grid">
            {selected.id === activeProviderId ? (
              <Notice title={t("providers.preferred")} tone="info"><p>{t("providers.activeReason")}</p></Notice>
            ) : null}
            {selectedPoolLocked ? (
              <Notice title={t("providers.poolLockedTitle")} tone="info"><p>{t("providers.poolLockedHelp")}</p></Notice>
            ) : null}
            <DefinitionList rows={[
              { label: t("providers.testStatus"), value: <StatusBadge tone={testTone(selected.lastTestStatus)}>{testLabel(selected, t)}</StatusBadge> },
              { label: t("providers.modelPolicy"), value: modelPolicy(selected, t) },
              { label: t("providers.credential"), value: selected.credentialConfigured ? t("common.configured") : t("common.notConfigured") },
              { label: t("providers.authMethod"), value: <code>{selected.authScheme ? `${selected.authScheme} / ${selected.authHeader}` : selected.authHeader}</code> },
              { label: t("providers.extraHeaderCount"), value: formatNumber(locale, Object.keys(selected.extraHeaders).length) },
              { label: t("providers.providerId"), value: <code>{selected.id}</code> }
            ]} />
            <section className="catalog-section">
              <div className="catalog-heading">
                <div>
                  <h3>{t("providers.modelCatalog")}</h3>
                  <p>{catalogLoading
                    ? t("common.loading")
                    : catalog
                      ? `${t(catalog.state === "fresh"
                        ? "providers.catalogFresh"
                        : catalog.state === "stale"
                          ? "providers.catalogStale"
                          : "providers.catalogMissing")} · ${t("providers.catalogCount", { count: catalog.models.length })}`
                      : t("providers.catalogMissing")}</p>
                </div>
                <Button
                  disabled={readOnly || pending !== null || !selected.credentialConfigured}
                  busy={pending === `provider-models-${selected.id}`}
                  onClick={() => void refreshCatalog()}
                ><RefreshCw className="icon" aria-hidden="true" />{t("providers.refreshModels")}</Button>
              </div>
              {catalogError ? <ErrorNotice error={catalogError} t={t} /> : null}
              {catalog?.models.length ? (
                <ul className="model-list">{catalog.models.slice(0, 12).map((item) => <li key={item}><code title={item}>{item}</code></li>)}</ul>
              ) : <p className="catalog-empty">{t("providers.catalogMissing")}</p>}
            </section>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={mode === "test"}
        title={t("providers.testTitle")}
        description={selected?.name}
        onClose={close}
        t={t}
        footer={(
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              busy={pending === `provider-test-${selected?.id ?? ""}` || pending === `provider-switch-${selected?.id ?? ""}`}
              disabled={readOnly || pending !== null || !model.trim()}
              onClick={() => void runTest()}
            >{switchAfterTest
                ? t(activeProviderId === null
                  ? "providers.runTestAndSelect"
                  : workerRunning ? "providers.runTestAndSwitch" : "providers.runTestSwitchAndStart")
                : t("providers.runTest")}</Button>
          </>
        )}
      >
        {selected ? (
          <div className="test-provider-form">
            <ModelPicker
              key={selected.id}
              id="test-model"
              model={model}
              models={catalog?.models ?? []}
              autoFocus
              t={t}
              onChange={setModel}
            />
            <Button
              disabled={readOnly || pending !== null || !selected.credentialConfigured}
              busy={pending === `provider-models-${selected.id}`}
              onClick={() => void refreshCatalog()}
            ><RefreshCw className="icon" aria-hidden="true" />{t("providers.refreshModels")}</Button>
            {catalogError ? <ErrorNotice error={catalogError} t={t} /> : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={mode === "delete"}
        title={t("providers.deleteTitle")}
        description={selected ? t("providers.deleteHelp", { name: selected.name }) : undefined}
        onClose={close}
        t={t}
        size="small"
        footer={(
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              busy={pending === `provider-delete-${selected?.id ?? ""}`}
              onClick={async () => { if (selected && await onDelete(selected.id)) close(); }}
            >{t("providers.delete")}</Button>
          </>
        )}
      >
        <Notice title={selected?.name ?? t("providers.deleteTitle")} tone="warning">
          <p>{t("providers.deleteHelp", { name: selected?.name ?? "" })}</p>
        </Notice>
      </Modal>
    </div>
  );
}
