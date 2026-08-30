import {
  ArrowRight,
  Bot,
  ChevronDown,
  CircleAlert,
  GitBranch,
  ListTree,
  RadioTower,
  RefreshCw,
  Search,
  ShieldCheck,
  Shuffle,
  Waypoints
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import { ApiError, asApiError } from "../api";
import { formatDate, type Translator } from "../i18n";
import type {
  Locale,
  MetricsOverview,
  ModelMappingGroup,
  RouteOperation,
  RoutePreview,
  RoutePreviewCandidate,
  RoutingRuleGroup
} from "../types";
import { Button, IconButton, Notice, Panel, StatusBadge, cx } from "./Primitives";

type RoutePreviewBoardProps = {
  locale: Locale;
  t: Translator;
  metrics: MetricsOverview | null;
  modelMappingGroups: ModelMappingGroup[];
  routingRuleGroups: RoutingRuleGroup[];
  routeRevision: string;
  onPreview: (
    model: string,
    operation: RouteOperation,
    signal: AbortSignal
  ) => Promise<RoutePreview>;
};

type PathNodeProps = {
  className?: string;
  icon: ReactNode;
  eyebrow: string;
  title: string;
  detail: string;
  tone?: "active" | "warning" | "neutral" | "danger";
};

const MODEL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const MODEL_TEXT_ENCODER = new TextEncoder();

function isPreviewableModel(value: string): boolean {
  return value.length > 0
    && value.trim() === value
    && [...value].length <= 256
    && MODEL_TEXT_ENCODER.encode(value).byteLength <= 512
    && !MODEL_CONTROL_PATTERN.test(value);
}

function PathNode({ className, icon, eyebrow, title, detail, tone = "neutral" }: PathNodeProps) {
  return (
    <article className={cx("route-path-node", `route-path-node-${tone}`, className)}>
      <span className="route-path-node-icon" aria-hidden="true">{icon}</span>
      <div>
        <small>{eyebrow}</small>
        <strong title={title}>{title}</strong>
        <span title={detail}>{detail}</span>
      </div>
    </article>
  );
}

function PathConnector({ conditional = false }: { conditional?: boolean }) {
  return <span className={cx("route-path-connector", conditional && "is-conditional")} aria-hidden="true" />;
}

function accountReason(reason: RoutePreview["account"]["reason"], t: Translator): string {
  if (reason === "account_eligible") return t("routePreview.accountEligible");
  if (reason === "account_cooldown") return t("routePreview.accountCooldown");
  if (reason === "account_quota_exhausted") return t("routePreview.accountQuotaExhausted");
  if (reason === "unsupported_operation") return t("routePreview.accountOperationUnsupported");
  if (reason === "unsupported_account_model") return t("routePreview.accountModelUnsupported");
  if (reason === "not_chatgpt_auth") return t("routePreview.accountUnavailable");
  return t("routePreview.customOnly");
}

function operationLabel(operation: RouteOperation, t: Translator): string {
  if (operation === "chat/completions") return t("routePreview.operationChatCompletions");
  if (operation === "images/generations") return t("routePreview.operationImageGenerations");
  return t("routePreview.operationResponses");
}

function selectionReason(preview: RoutePreview, t: Translator): string {
  if (preview.customSelectionReason === "model_priority") {
    return t("routePreview.selectionModelPriority");
  }
  if (preview.customSelectionReason === "weight") {
    return t("routePreview.selectionWeight");
  }
  if (preview.customSelectionReason === "runtime_order") {
    return t("routePreview.selectionRuntimeOrder");
  }
  if (preview.customSelectionReason === "cooldown_fallback") {
    return t("routePreview.selectionCooldownFallback");
  }
  return t("routePreview.selectionSoleEligible");
}

function availabilityLabel(
  availability: RoutePreviewCandidate["availability"],
  t: Translator
): string {
  if (availability === "ready") return t("routePreview.ready");
  if (availability === "cooling") return t("routePreview.cooling");
  if (availability === "disabled") return t("routePreview.disabled");
  return t("routePreview.notListed");
}

function availabilityTone(
  availability: RoutePreviewCandidate["availability"]
): "success" | "warning" | "neutral" | "danger" {
  if (availability === "ready") return "success";
  if (availability === "cooling") return "warning";
  if (availability === "not_listed") return "danger";
  return "neutral";
}

function mappingTitle(candidate: RoutePreviewCandidate, t: Translator): string {
  if (candidate.transformation === "mapping") {
    return candidate.mappingGroup?.name ?? t("routePreview.exactMapping");
  }
  if (candidate.transformation === "override") return t("routePreview.providerOverride");
  return t("routePreview.passthrough");
}

function modelRewriteDetail(
  model: string,
  candidate: RoutePreviewCandidate,
  t: Translator
): string {
  if (candidate.targetModel === null) return t("routePreview.modelUnchanged", { model });
  return `${model} → ${candidate.targetModel}`;
}

function ruleTitle(preview: RoutePreview, t: Translator): string {
  return preview.routingRule?.groupName ?? t("routePreview.defaultPriority");
}

function ruleDetail(preview: RoutePreview, t: Translator): string {
  return selectionReason(preview, t);
}

function CustomRouteSteps({
  model,
  preview,
  primary,
  conditional,
  t
}: {
  model: string;
  preview: RoutePreview;
  primary: RoutePreviewCandidate;
  conditional: boolean;
  t: Translator;
}) {
  const targetModel = primary.targetModel ?? model;
  return (
    <>
      <PathNode
        icon={<ListTree />}
        eyebrow={t("routePreview.routingRule")}
        title={ruleTitle(preview, t)}
        detail={ruleDetail(preview, t)}
        tone={preview.routingRule ? "active" : "neutral"}
      />
      <PathConnector conditional={conditional} />
      <PathNode
        icon={<Shuffle />}
        eyebrow={t("routePreview.modelRewrite")}
        title={mappingTitle(primary, t)}
        detail={modelRewriteDetail(model, primary, t)}
        tone={primary.transformation === "passthrough" ? "neutral" : "active"}
      />
      <PathConnector conditional={conditional} />
      <PathNode
        icon={<RadioTower />}
        eyebrow={t("routePreview.predictedOutlet")}
        title={primary.providerName}
        detail={targetModel}
        tone="active"
      />
    </>
  );
}

export function RoutePreviewBoard({
  locale,
  t,
  metrics,
  modelMappingGroups,
  routingRuleGroups,
  routeRevision,
  onPreview
}: RoutePreviewBoardProps) {
  const headingId = useId();
  const listId = useId();
  const fallbackId = useId();
  const suggestedModels = useMemo(() => {
    const models: string[] = [];
    const seen = new Set<string>();
    const add = (model: string) => {
      if (!isPreviewableModel(model) || seen.has(model) || models.length >= 50) return;
      seen.add(model);
      models.push(model);
    };
    metrics?.models.forEach(({ model }) => add(model));
    routingRuleGroups.filter(({ active }) => active)
      .forEach(({ rules }) => rules.forEach(({ models: ruleModels }) => ruleModels.forEach(add)));
    modelMappingGroups.forEach(({ rules }) => rules.forEach(({ sourceModel }) => add(sourceModel)));
    return models;
  }, [metrics, modelMappingGroups, routingRuleGroups]);
  const [model, setModel] = useState(() => suggestedModels[0] ?? "");
  const [operation, setOperation] = useState<RouteOperation>("responses");
  const [result, setResult] = useState<{
    model: string;
    operation: RouteOperation;
    preview: RoutePreview;
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [fallbackExpanded, setFallbackExpanded] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const sequenceRef = useRef(0);
  const userEditedRef = useRef(false);

  useEffect(() => {
    if (!userEditedRef.current && model.length === 0 && suggestedModels[0]) {
      setModel(suggestedModels[0]);
    }
  }, [model, suggestedModels]);

  useEffect(() => {
    setFallbackExpanded(false);
  }, [model, operation, routeRevision]);

  useEffect(() => {
    const sequence = ++sequenceRef.current;
    if (!isPreviewableModel(model)) {
      setLoading(false);
      setError(null);
      return undefined;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setLoading(true);
      void onPreview(model, operation, controller.signal).then((preview) => {
        if (controller.signal.aborted || sequence !== sequenceRef.current) return;
        setResult({ model, operation, preview });
        setError(null);
      }).catch((caught) => {
        if (controller.signal.aborted || sequence !== sequenceRef.current) return;
        setError(asApiError(caught));
      }).finally(() => {
        if (!controller.signal.aborted && sequence === sequenceRef.current) setLoading(false);
      });
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [model, onPreview, operation, refreshGeneration, routeRevision]);

  useEffect(() => {
    if (!isPreviewableModel(model)) return undefined;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        setRefreshGeneration((generation) => generation + 1);
      }
    };
    const interval = window.setInterval(refreshWhenVisible, 5_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [model, operation]);

  const preview = result?.model === model && result.operation === operation
    ? result.preview
    : null;
  const primary = preview?.candidates.find(({ order }) => order === 1) ?? null;
  const modelInvalid = model.length > 0 && !isPreviewableModel(model);
  const visibleCandidates = preview?.candidates.slice(0, 12) ?? [];
  const hiddenCandidateCount = Math.max(0, (preview?.candidates.length ?? 0) - visibleCandidates.length);

  return (
    <Panel className="route-preview-board">
      <header className="route-preview-header">
        <div className="route-preview-heading">
          <span className="route-preview-heading-icon" aria-hidden="true"><Waypoints /></span>
          <div>
            <div className="route-preview-title-line">
              <h2 id={headingId}>{t("routePreview.title")}</h2>
              {preview ? (
                <StatusBadge tone={preview.route === "unavailable" ? "danger" : "info"} icon={false}>
                  {t(preview.route === "account"
                    ? "routePreview.accountRoute"
                    : preview.route === "custom"
                      ? "routePreview.customRoute"
                      : "routePreview.noRoute")}
                </StatusBadge>
              ) : null}
            </div>
            <div className="route-preview-heading-meta">
              <p>{t("routePreview.description")}</p>
              {preview ? (
                <div className="route-preview-source">
                  <StatusBadge tone={preview.source === "live" ? "success" : "neutral"}>
                    {t(preview.source === "live" ? "routePreview.liveRuntime" : "routePreview.configuredSnapshot")}
                  </StatusBadge>
                  <span>{preview.source === "live"
                    ? t("routePreview.generation", { value: preview.generation })
                    : t("routePreview.workerStopped")}</span>
                  {preview.evaluatedAt ? (
                    <time dateTime={preview.evaluatedAt}>{formatDate(locale, preview.evaluatedAt, true)}</time>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="route-preview-controls">
          <label className="route-preview-operation-field">
            <span>{t("routePreview.inspectOperation")}</span>
            <select
              value={operation}
              onChange={(event) => setOperation(event.target.value as RouteOperation)}
            >
              <option value="responses">{t("routePreview.operationResponses")}</option>
              <option value="chat/completions">{t("routePreview.operationChatCompletions")}</option>
              <option value="images/generations">{t("routePreview.operationImageGenerations")}</option>
            </select>
          </label>
          <label className="route-preview-model-field">
            <span>{t("routePreview.inspectModel")}</span>
            <span className="route-preview-input-shell">
              <Search aria-hidden="true" />
              <input
                type="text"
                list={suggestedModels.length > 0 ? listId : undefined}
                value={model}
                maxLength={512}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={modelInvalid || undefined}
                placeholder={t("routePreview.modelPlaceholder")}
                onChange={(event) => {
                  userEditedRef.current = true;
                  setModel(event.target.value);
                }}
              />
            </span>
          </label>
          {suggestedModels.length > 0 ? (
            <datalist id={listId}>
              {suggestedModels.map((suggestion) => <option value={suggestion} key={suggestion} />)}
            </datalist>
          ) : null}
          <IconButton
            className="route-preview-refresh"
            label={t("routePreview.refresh")}
            disabled={!isPreviewableModel(model) || loading}
            onClick={() => setRefreshGeneration((generation) => generation + 1)}
          >
            <RefreshCw className={loading ? "spin" : undefined} aria-hidden="true" />
          </IconButton>
        </div>
      </header>

      <div className="route-preview-body" aria-labelledby={headingId} aria-busy={loading || undefined}>
        {modelInvalid ? (
          <Notice title={t("routePreview.invalidModel")} tone="warning">
            <p>{t("routePreview.invalidModelHelp")}</p>
          </Notice>
        ) : model.length === 0 ? (
          <div className="route-preview-empty">
            <Search aria-hidden="true" />
            <strong>{t("routePreview.emptyTitle")}</strong>
            <p>{t("routePreview.emptyHelp")}</p>
          </div>
        ) : error && preview === null ? (
          <Notice title={t("routePreview.unavailableTitle")} tone="warning" role="alert">
            <p>{t("routePreview.unavailableHelp")}</p>
            <p><code>{error.code}</code></p>
            <Button variant="ghost" onClick={() => setRefreshGeneration((generation) => generation + 1)}>
              <RefreshCw className="icon" aria-hidden="true" />{t("routePreview.tryAgain")}
            </Button>
          </Notice>
        ) : preview === null ? (
          <div className="route-preview-loading" aria-live="polite">
            <RefreshCw className="spin" aria-hidden="true" />
            <span>{t("routePreview.evaluating")}</span>
          </div>
        ) : (
          <>
            {["unsupported_operation", "unsupported_account_model"].includes(
              preview.account.reason
            ) ? (
              <Notice title={t("routePreview.operationUnsupportedTitle")} tone="warning">
                <p>{t(preview.account.reason === "unsupported_account_model"
                  ? "routePreview.accountModelUnsupportedHelp"
                  : "routePreview.operationUnsupportedHelp", {
                    operation: operationLabel(preview.operation, t),
                    model
                  })}</p>
              </Notice>
            ) : null}
            <div className="route-preview-lanes">
              <div className="route-preview-primary-lane">
                <div className="route-preview-lane-label">
                  <span>{t("routePreview.primaryPath")}</span>
                  <small>{preview.route === "custom"
                    ? accountReason(preview.account.reason, t)
                    : t("routePreview.currentDecision")}</small>
                </div>
                <div className={cx(
                  "route-preview-chain",
                  preview.route === "custom" && "route-preview-chain-long"
                )}>
                  <PathNode
                    className="route-path-node-request"
                    icon={<Bot />}
                    eyebrow={t("routePreview.request")}
                    title={model}
                    detail={operationLabel(preview.operation, t)}
                    tone="active"
                  />
                  <PathConnector />
                  <PathNode
                    className="route-path-node-account"
                    icon={<ShieldCheck />}
                    eyebrow={t("routePreview.accountGate")}
                    title={accountReason(preview.account.reason, t)}
                    detail={preview.account.enabled
                      ? t("routePreview.accountPreferenceOn")
                      : t("routePreview.accountPreferenceOff")}
                    tone={preview.account.selected ? "active" : "neutral"}
                  />
                  {preview.route === "account" ? (
                    <>
                      <PathConnector />
                      <PathNode
                        icon={<RadioTower />}
                        eyebrow={t("routePreview.predictedOutlet")}
                        title={t("overview.chatgptAccount")}
                        detail={model}
                        tone="active"
                      />
                    </>
                  ) : preview.route === "unavailable" ? (
                    <>
                      <PathConnector />
                      <PathNode
                        icon={<CircleAlert />}
                        eyebrow={t("routePreview.noRoute")}
                        title={t("routePreview.noEligibleProvider")}
                        detail={t(preview.reason === "provider_pool_unavailable"
                          ? "routePreview.providerPoolUnavailable"
                          : "routePreview.modelUnavailable")}
                        tone="danger"
                      />
                    </>
                  ) : primary ? (
                    <>
                      <PathConnector />
                      <CustomRouteSteps
                        model={model}
                        preview={preview}
                        primary={primary}
                        conditional={false}
                        t={t}
                      />
                    </>
                  ) : null}
                </div>
              </div>

              {preview.route === "account" && preview.account.fallbackAvailable && primary ? (
                <section className={cx(
                  "route-preview-fallback-disclosure",
                  fallbackExpanded && "is-open"
                )} aria-label={t("routePreview.conditionalFallback")}>
                  <button
                    type="button"
                    className="route-preview-fallback-toggle"
                    aria-expanded={fallbackExpanded}
                    aria-controls={fallbackId}
                    aria-describedby={`${fallbackId}-description ${fallbackId}-summary`}
                    aria-label={t(fallbackExpanded
                      ? "routePreview.collapseFallback"
                      : "routePreview.expandFallback")}
                    title={t("routePreview.fallbackCondition")}
                    onClick={() => setFallbackExpanded((expanded) => !expanded)}
                  >
                    <span className="route-preview-fallback-icon" aria-hidden="true"><GitBranch /></span>
                    <strong className="route-preview-fallback-label">
                      <span className="route-preview-fallback-label-full">{t("routePreview.conditionalFallback")}</span>
                      <span className="route-preview-fallback-label-short">{t("routePreview.conditionalFallbackShort")}</span>
                    </strong>
                    <span className="visually-hidden" id={`${fallbackId}-description`}>
                      {t("routePreview.fallbackCondition")}
                    </span>
                    <span className="route-preview-fallback-summary" id={`${fallbackId}-summary`}>
                      <span>{ruleTitle(preview, t)}</span>
                      <ArrowRight />
                      <strong>{primary.providerName}</strong>
                      <code>{primary.targetModel ?? model}</code>
                    </span>
                    <ChevronDown className="route-preview-fallback-chevron" aria-hidden="true" />
                  </button>
                  <div
                    id={fallbackId}
                    className="route-preview-fallback-reveal"
                    aria-hidden={!fallbackExpanded}
                  >
                    <div className="route-preview-fallback-reveal-inner">
                      <p className="route-preview-fallback-condition">{t("routePreview.fallbackCondition")}</p>
                      <div className="route-preview-fallback-lane">
                        <div className="route-preview-chain is-conditional">
                          <CustomRouteSteps
                            model={model}
                            preview={preview}
                            primary={primary}
                            conditional
                            t={t}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>

            {visibleCandidates.length > 0 ? (
              <section className="route-preview-candidates" aria-label={t("routePreview.candidateOrder")}>
                <div className="route-preview-candidates-label">
                  <ListTree aria-hidden="true" />
                  <div>
                    <strong>{t("routePreview.candidateOrder")}</strong>
                    <span>{t("routePreview.providerCount", { count: preview.candidates.length })}</span>
                  </div>
                </div>
                <ol>
                  {visibleCandidates.map((candidate) => (
                    <li className={cx("route-preview-candidate", `is-${candidate.availability}`)} key={candidate.providerId}>
                      <span className="route-preview-candidate-rank">
                        {candidate.order === null ? "—" : `#${candidate.order}`}
                      </span>
                      <span className="route-preview-candidate-copy">
                        <strong>{candidate.providerName}</strong>
                        <small>{candidate.targetModel ?? t("routePreview.modelUnchangedShort")}</small>
                      </span>
                      <StatusBadge tone={availabilityTone(candidate.availability)} icon={false}>
                        {availabilityLabel(candidate.availability, t)}
                      </StatusBadge>
                    </li>
                  ))}
                </ol>
                {hiddenCandidateCount > 0 ? (
                  <span className="route-preview-more">{t("routePreview.moreProviders", { count: hiddenCandidateCount })}</span>
                ) : null}
              </section>
            ) : null}

            <details className="route-preview-details">
              <summary>
                <GitBranch aria-hidden="true" />
                <span>{t("routePreview.decisionDetails")}</span>
                <small>{t("routePreview.decisionDetailsHint")}</small>
              </summary>
              <div>
                <p>{t("routePreview.candidateHelp")}</p>
                <p>{t("routePreview.operationDecisionNote", {
                  operation: operationLabel(preview.operation, t)
                })}</p>
              </div>
            </details>
            {error ? (
              <p className="route-preview-stale" aria-live="polite">
                {t("routePreview.refreshFailed")} <code>{error.code}</code>
              </p>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
