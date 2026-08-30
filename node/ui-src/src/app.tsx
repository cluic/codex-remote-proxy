import { Power, TerminalSquare } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { ApiError, CrpApi, asApiError, readAndClearControlToken } from "./api";
import { Shell } from "./components/Shell";
import { Button, ErrorNotice, Notice, StatusBadge } from "./components/Primitives";
import {
  createTranslator,
  persistLocale,
  readInitialLocale,
  type TranslationKey
} from "./i18n";
import { ActivityPage } from "./pages/Activity";
import { ForwardingRecordsPage } from "./pages/ForwardingRecords";
import { ModelMappingsPage } from "./pages/ModelMappings";
import { OverviewPage } from "./pages/Overview";
import { ProvidersPage } from "./pages/Providers";
import { RoutingRulesPage } from "./pages/RoutingRules";
import { SetupPage } from "./pages/Setup";
import { SystemPage } from "./pages/System";
import type {
  AccessKeyInput,
  AccessKeyPatch,
  AccessMode,
  ActivityPageData,
  BootstrapResult,
  DiagnosticResult,
  ForwardingRecordsPageData,
  ForwardingRecordDetail,
  ForwardingRecordsQuery,
  Locale,
  MetricsOverview,
  MetricsWindow,
  ModelCatalog,
  ModelMappingGroup,
  ModelMappingGroupInput,
  Provider,
  ProviderInput,
  Route,
  RouteOperation,
  RouteRequestFormat,
  RoutePreview,
  RoutingRuleGroup,
  RoutingRuleGroupInput,
  SupervisorIdentity,
  TokenHeatmapOverview,
  WorkspaceData
} from "./types";

const emptyActivity: ActivityPageData = {
  events: [],
  page: { limit: 50, offset: 0, nextOffset: null }
};

function routeFromPath(pathname: string): Route {
  if (pathname === "/providers") return "providers";
  if (pathname === "/model-mappings") return "model-mappings";
  if (pathname === "/routing-rules") return "routing-rules";
  if (pathname === "/forwarding") return "forwarding";
  if (pathname === "/activity") return "activity";
  if (pathname === "/system") return "system";
  if (pathname === "/setup") return "setup";
  return "overview";
}

function routePath(route: Route): string {
  return route === "overview" ? "/overview" : `/${route}`;
}

type NoticeState = { key: TranslationKey; variables?: Record<string, string | number> };
const TOKEN_UNREAD = Symbol("token-unread");

export function App() {
  const [locale, setLocale] = useState<Locale>(() => readInitialLocale());
  const [accessMode, setAccessMode] = useState<AccessMode>("initializing");
  const [route, setRoute] = useState<Route>(() => routeFromPath(location.pathname));
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [activity, setActivity] = useState<ActivityPageData>(emptyActivity);
  const [metrics, setMetrics] = useState<MetricsOverview | null>(null);
  const [metricsError, setMetricsError] = useState<ApiError | null>(null);
  const [heatmap, setHeatmap] = useState<TokenHeatmapOverview | null>(null);
  const [heatmapError, setHeatmapError] = useState<ApiError | null>(null);
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>("24h");
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [terminalError, setTerminalError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const initializedRef = useRef(false);
  const launchTokenRef = useRef<string | null | typeof TOKEN_UNREAD>(TOKEN_UNREAD);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadSequenceRef = useRef(0);
  const metricsSequenceRef = useRef(0);
  const heatmapSequenceRef = useRef(0);
  const activitySequenceRef = useRef(0);
  const pendingRef = useRef(false);
  const activityLoadingRef = useRef(false);
  const metricsWindowRef = useRef<MetricsWindow>(metricsWindow);
  const routeFocusSourceRef = useRef<Element | null>(null);
  const routeFocusFrameRef = useRef<number | null>(null);

  const api = useMemo(() => new CrpApi((error) => {
    pendingRef.current = false;
    setPending(null);
    setTerminalError(error);
    setAccessMode("terminal");
    setWorkspace(null);
    setActionError(null);
    setLoadError(null);
  }), []);
  const t = useMemo(() => createTranslator(locale), [locale]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    metricsWindowRef.current = metricsWindow;
  }, [metricsWindow]);

  useEffect(() => {
    document.documentElement.lang = locale;
    const titleKey = accessMode === "stopped"
      ? "session.stoppedTitle"
      : route === "setup"
        ? "setup.title"
        : `nav.${route}` as TranslationKey;
    document.title = `${t(titleKey)} | CRP`;
  }, [accessMode, locale, route, t]);

  const loadHeatmap = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const sequence = ++heatmapSequenceRef.current;
    setHeatmapError(null);
    try {
      const nextHeatmap = await api.getTokenHeatmap("12w", signal);
      if (sequence === heatmapSequenceRef.current && !signal?.aborted) setHeatmap(nextHeatmap);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")
        && sequence === heatmapSequenceRef.current) {
        setHeatmapError(asApiError(error));
      }
    }
  }, [api]);

  const loadWorkspace = useCallback(async (window: MetricsWindow): Promise<WorkspaceData | null> => {
    const sequence = ++loadSequenceRef.current;
    const metricsSequence = ++metricsSequenceRef.current;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    void loadHeatmap(controller.signal);
    try {
      const [
        status,
        providers,
        providerPresets,
        modelMappingGroups,
        routingRuleGroups,
        accessKeys,
        settings,
        nextActivity
      ] = await Promise.all([
        api.getStatus(controller.signal),
        api.listProviders(controller.signal),
        api.listProviderPresets(controller.signal),
        api.listModelMappingGroups(controller.signal),
        api.listRoutingRuleGroups(controller.signal),
        api.listAccessKeys(controller.signal),
        api.getSettings(controller.signal),
        api.getActivity(0, controller.signal)
      ]);
      if (controller.signal.aborted || sequence !== loadSequenceRef.current) return null;
      const nextWorkspace = {
        status,
        providers,
        providerPresets,
        modelMappingGroups,
        routingRuleGroups,
        accessKeys,
        settings
      };
      setWorkspace(nextWorkspace);
      setActivity(nextActivity);
      setLoadError(null);
      try {
        const nextMetrics = await api.getMetrics(window, controller.signal);
        if (!controller.signal.aborted
          && sequence === loadSequenceRef.current
          && metricsSequence === metricsSequenceRef.current) {
          setMetrics(nextMetrics);
          setMetricsError(null);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")
          && sequence === loadSequenceRef.current
          && metricsSequence === metricsSequenceRef.current) {
          setMetrics(null);
          setMetricsError(asApiError(error));
        }
      }
      return nextWorkspace;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      const failure = asApiError(error);
      setLoadError(failure);
      return null;
    } finally {
      if (sequence === loadSequenceRef.current) loadControllerRef.current = null;
    }
  }, [api, loadHeatmap]);

  useEffect(() => {
    if (initializedRef.current) return undefined;
    initializedRef.current = true;
    let cancelled = false;
    const initialize = async () => {
      const launchToken = launchTokenRef.current === TOKEN_UNREAD
        ? readAndClearControlToken()
        : launchTokenRef.current;
      launchTokenRef.current = null;
      try {
        if (launchToken !== null) {
          await api.exchangeSession(launchToken);
          if (!cancelled) setAccessMode("writable");
        } else {
          api.enterReadOnly();
          if (!cancelled) setAccessMode("read-only");
        }
      } catch {
        // ApiClient already moved this tab into the terminal state.
        if (!cancelled) {
          setReady(true);
          document.documentElement.setAttribute("aria-busy", "false");
        }
        return;
      }
      if (cancelled) return;
      const loaded = await loadWorkspace("24h");
      if (cancelled) return;
      if (loaded && loaded.status.activeProviderId === null) {
        history.replaceState(null, "", "/setup");
        setRoute("setup");
      }
      setReady(true);
      document.documentElement.setAttribute("aria-busy", "false");
    };
    void initialize();
    return () => {
      cancelled = true;
      loadControllerRef.current?.abort();
    };
  }, [api, loadWorkspace]);

  useEffect(() => {
    const onPopState = () => {
      routeFocusSourceRef.current = document.activeElement;
      setRoute(routeFromPath(location.pathname));
    };
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!ready || accessMode === "terminal") return undefined;
    if (routeFocusFrameRef.current !== null) cancelAnimationFrame(routeFocusFrameRef.current);
    const source = routeFocusSourceRef.current;
    routeFocusFrameRef.current = requestAnimationFrame(() => {
      routeFocusFrameRef.current = null;
      const active = document.activeElement;
      if (active === source || active === document.body || active === null) {
        document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true });
      }
      routeFocusSourceRef.current = null;
    });
    return () => {
      if (routeFocusFrameRef.current !== null) cancelAnimationFrame(routeFocusFrameRef.current);
    };
  }, [accessMode, ready, route]);

  const changeLocale = useCallback((next: Locale) => {
    persistLocale(next);
    setLocale(next);
  }, []);

  const navigate = useCallback((next: Route) => {
    routeFocusSourceRef.current = document.activeElement;
    history.pushState(null, "", routePath(next));
    setActionError(null);
    setNotice(null);
    setRoute(next);
  }, []);

  const refresh = useCallback(async () => {
    setActionError(null);
    setNotice(null);
    const loaded = await loadWorkspace(metricsWindowRef.current);
    if (loaded) setNotice({ key: "notice.refreshed" });
  }, [loadWorkspace]);

  const resumeManagement = useCallback(async () => {
    if (pendingRef.current || api.mutationAllowed) return;
    pendingRef.current = true;
    setPending("session-resume");
    setActionError(null);
    setNotice(null);
    try {
      await api.resumeSession();
      setAccessMode("writable");
      await loadWorkspace(metricsWindowRef.current);
      setNotice({ key: "notice.managementResumed" });
    } catch (error) {
      setActionError(asApiError(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }, [api, loadWorkspace]);

  const executeMutation = useCallback(async <T,>(
    key: string,
    operation: () => Promise<T>,
    successKey: TranslationKey
  ): Promise<T | null> => {
    if (pendingRef.current || !api.mutationAllowed) return null;
    pendingRef.current = true;
    setPending(key);
    setActionError(null);
    setNotice(null);
    let value: T | null = null;
    let failure: ApiError | null = null;
    try {
      value = await operation();
    } catch (error) {
      failure = asApiError(error);
    }
    if (api.mutationAllowed) await loadWorkspace(metricsWindowRef.current);
    if (failure) setActionError(failure);
    else setNotice({ key: successKey });
    pendingRef.current = false;
    setPending(null);
    return failure ? null : value;
  }, [api, loadWorkspace]);

  const createProvider = useCallback(async (input: ProviderInput, credential: string) => (
    await executeMutation("provider-create", () => api.createProvider(input, credential), "notice.providerCreated")
  ), [api, executeMutation]);

  const updateProvider = useCallback(async (id: string, input: ProviderInput, replacement?: string) => (
    await executeMutation(
      `provider-update-${id}`,
      () => api.updateProvider(id, input, replacement),
      "notice.providerUpdated"
    )
  ), [api, executeMutation]);

  const updateProviderWeight = useCallback(async (id: string, weight: number): Promise<boolean> => (
    await executeMutation(
      `provider-weight-${id}`,
      () => api.updateProviderWeight(id, weight),
      "notice.providerWeightUpdated"
    ) !== null
  ), [api, executeMutation]);

  const testProvider = useCallback(async (
    id: string,
    model: string,
    switchAfter: boolean,
    activateIfNone = false
  ): Promise<boolean> => {
    const result = await executeMutation(
      switchAfter ? `provider-switch-${id}` : `provider-test-${id}`,
      async () => {
        const test = await api.testProvider(id, model, activateIfNone);
        if (!test.ok) throw ApiError.fromTestResult(test);
        if (switchAfter && !activateIfNone) await api.activateProvider(id);
        return true;
      },
      activateIfNone
        ? "notice.providerTested"
        : switchAfter ? "notice.providerSwitched" : "notice.providerTested"
    );
    return result === true;
  }, [api, executeMutation]);

  const activateProvider = useCallback(async (id: string): Promise<boolean> => (
    await executeMutation(
      `provider-switch-${id}`,
      async () => { await api.activateProvider(id); return true; },
      "notice.providerSwitched"
    ) === true
  ), [api, executeMutation]);

  const deleteProvider = useCallback(async (id: string): Promise<boolean> => (
    await executeMutation(
      `provider-delete-${id}`,
      async () => { await api.deleteProvider(id); return true; },
      "notice.providerDeleted"
    ) === true
  ), [api, executeMutation]);

  const createModelMappingGroup = useCallback(async (
    input: ModelMappingGroupInput
  ): Promise<ModelMappingGroup | null> => (
    await executeMutation(
      "model-mapping-create",
      () => api.createModelMappingGroup(input),
      "notice.modelMappingCreated"
    )
  ), [api, executeMutation]);

  const updateModelMappingGroup = useCallback(async (
    id: string,
    input: ModelMappingGroupInput
  ): Promise<ModelMappingGroup | null> => (
    await executeMutation(
      `model-mapping-update-${id}`,
      () => api.updateModelMappingGroup(id, input),
      "notice.modelMappingUpdated"
    )
  ), [api, executeMutation]);

  const deleteModelMappingGroup = useCallback(async (id: string): Promise<boolean> => (
    await executeMutation(
      `model-mapping-delete-${id}`,
      async () => { await api.deleteModelMappingGroup(id); return true; },
      "notice.modelMappingDeleted"
    ) === true
  ), [api, executeMutation]);

  const createRoutingRuleGroup = useCallback(async (
    input: RoutingRuleGroupInput
  ): Promise<RoutingRuleGroup | null> => (
    await executeMutation(
      "routing-rule-create",
      () => api.createRoutingRuleGroup(input),
      "notice.routingRuleCreated"
    )
  ), [api, executeMutation]);

  const updateRoutingRuleGroup = useCallback(async (
    id: string,
    input: RoutingRuleGroupInput
  ): Promise<RoutingRuleGroup | null> => (
    await executeMutation(
      `routing-rule-update-${id}`,
      () => api.updateRoutingRuleGroup(id, input),
      "notice.routingRuleUpdated"
    )
  ), [api, executeMutation]);

  const deleteRoutingRuleGroup = useCallback(async (id: string): Promise<boolean> => (
    await executeMutation(
      `routing-rule-delete-${id}`,
      async () => { await api.deleteRoutingRuleGroup(id); return true; },
      "notice.routingRuleDeleted"
    ) === true
  ), [api, executeMutation]);

  const activateRoutingRuleGroup = useCallback(async (id: string | null): Promise<boolean> => (
    await executeMutation(
      "routing-rule-activate",
      async () => { await api.setActiveRoutingRuleGroup(id); return true; },
      id === null ? "notice.routingRuleDeactivated" : "notice.routingRuleActivated"
    ) === true
  ), [api, executeMutation]);

  const getProviderModels = useCallback(async (id: string, signal?: AbortSignal): Promise<ModelCatalog> => (
    await api.getProviderModels(id, signal)
  ), [api]);

  const refreshProviderModels = useCallback(async (id: string): Promise<ModelCatalog | null> => (
    await executeMutation(
      `provider-models-${id}`,
      () => api.refreshProviderModels(id),
      "notice.modelsRefreshed"
    )
  ), [api, executeMutation]);

  const updateProviderModels = useCallback(async (
    id: string,
    input: {
      modelsPath: string;
      defaultEnabled: boolean;
      customModels: string[];
      overrides: string[];
    }
  ): Promise<ModelCatalog | null> => (
    await executeMutation(
      `provider-models-update-${id}`,
      () => api.updateProviderModels(id, input),
      "notice.providerModelsUpdated"
    )
  ), [api, executeMutation]);

  const startProxy = useCallback(() => {
    void executeMutation("proxy-start", () => api.startProxy(), "notice.workerStarted");
  }, [api, executeMutation]);

  const stopProxy = useCallback(() => {
    void executeMutation("proxy-stop", () => api.stopProxy(), "notice.workerStopped");
  }, [api, executeMutation]);

  const restartProxy = useCallback(() => {
    void executeMutation("proxy-restart", () => api.restartProxy(), "notice.workerRestarted");
  }, [api, executeMutation]);

  const shutdownSupervisor = useCallback(async (): Promise<boolean> => {
    if (pendingRef.current || !api.mutationAllowed) return false;
    const supervisor = workspace?.status.supervisor;
    if (!Number.isSafeInteger(supervisor?.pid) || supervisor?.pid === null
      || typeof supervisor?.startedAt !== "string") {
      setActionError(new ApiError("SUPERVISOR_IDENTITY_CHANGED", 409));
      return false;
    }
    const identity: SupervisorIdentity = {
      pid: supervisor.pid,
      startedAt: supervisor.startedAt
    };
    pendingRef.current = true;
    setPending("supervisor-shutdown");
    setActionError(null);
    setLoadError(null);
    setNotice(null);
    try {
      await api.shutdownSupervisor(identity);
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      loadSequenceRef.current += 1;
      metricsSequenceRef.current += 1;
      activitySequenceRef.current += 1;
      activityLoadingRef.current = false;
      setActivityLoading(false);
      setWorkspace(null);
      setActivity(emptyActivity);
      setMetrics(null);
      setMetricsError(null);
      heatmapSequenceRef.current += 1;
      setHeatmap(null);
      setHeatmapError(null);
      setTerminalError(null);
      setAccessMode("stopped");
      return true;
    } catch (error) {
      setActionError(asApiError(error));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }, [api, workspace]);

  const prepareCodex = useCallback(async (): Promise<BootstrapResult | null> => (
    await executeMutation("codex-bootstrap", () => api.bootstrapCodex(), "notice.codexPrepared")
  ), [api, executeMutation]);

  const generateDiagnostics = useCallback(async (): Promise<DiagnosticResult | null> => (
    await executeMutation("diagnostics", () => api.generateDiagnostics(), "notice.diagnosticsReady")
  ), [api, executeMutation]);

  const refreshAccount = useCallback(() => {
    void executeMutation(
      "account-refresh",
      () => api.refreshAccount(),
      "notice.accountRefreshed"
    );
  }, [api, executeMutation]);

  const updateRoutingMode = useCallback((routingMode: "custom_only" | "account_first") => {
    void executeMutation(
      "routing-mode",
      () => api.updateRoutingMode(routingMode),
      "notice.routingUpdated"
    );
  }, [api, executeMutation]);

  const updateCaptureEnabled = useCallback(async (captureEnabled: boolean): Promise<boolean> => (
    await executeMutation(
      "capture-setting",
      () => api.updateCaptureEnabled(captureEnabled),
      captureEnabled ? "notice.captureEnabled" : "notice.captureDisabled"
    ) !== null
  ), [api, executeMutation]);

  const updateCaptureDetailsEnabled = useCallback(async (captureDetailsEnabled: boolean): Promise<boolean> => (
    await executeMutation(
      "capture-details-setting",
      () => api.updateCaptureDetailsEnabled(captureDetailsEnabled),
      captureDetailsEnabled ? "notice.captureDetailsEnabled" : "notice.captureDetailsDisabled"
    ) !== null
  ), [api, executeMutation]);

  const updateAutoStartEnabled = useCallback((autoStartEnabled: boolean) => {
    void executeMutation(
      "autostart-setting",
      () => api.updateAutoStartEnabled(autoStartEnabled),
      autoStartEnabled ? "notice.autoStartEnabled" : "notice.autoStartDisabled"
    );
  }, [api, executeMutation]);

  const updateApiKeyAuthEnabled = useCallback((apiKeyAuthEnabled: boolean) => {
    void executeMutation(
      "api-key-auth-setting",
      () => api.updateApiKeyAuthEnabled(apiKeyAuthEnabled),
      apiKeyAuthEnabled ? "notice.apiKeyAuthEnabled" : "notice.apiKeyAuthDisabled"
    );
  }, [api, executeMutation]);

  const updateProxyHost = useCallback((proxyHost: "127.0.0.1" | "0.0.0.0") => {
    void executeMutation(
      "proxy-host-setting",
      () => api.updateProxyHost(proxyHost),
      "notice.proxyHostUpdated"
    );
  }, [api, executeMutation]);

  const createAccessKey = useCallback(async (input: AccessKeyInput): Promise<boolean> => (
    await executeMutation(
      "access-key-create",
      () => api.createAccessKey(input),
      "notice.accessKeyCreated"
    ) !== null
  ), [api, executeMutation]);

  const updateAccessKey = useCallback(async (
    id: string,
    patch: AccessKeyPatch
  ): Promise<boolean> => (
    await executeMutation(
      `access-key-update-${id}`,
      () => api.updateAccessKey(id, patch),
      "notice.accessKeyUpdated"
    ) !== null
  ), [api, executeMutation]);

  const deleteAccessKey = useCallback(async (id: string): Promise<boolean> => (
    await executeMutation(
      `access-key-delete-${id}`,
      () => api.deleteAccessKey(id),
      "notice.accessKeyDeleted"
    ) !== null
  ), [api, executeMutation]);

  const loadForwardingRecords = useCallback(async (
    query: ForwardingRecordsQuery,
    signal?: AbortSignal
  ): Promise<ForwardingRecordsPageData> => (
    await api.getForwardingRecords(query, signal)
  ), [api]);

  const loadForwardingRecordDetail = useCallback(async (
    id: number,
    signal?: AbortSignal
  ): Promise<ForwardingRecordDetail> => api.getForwardingRecordDetail(id, signal), [api]);

  const changeMetricsWindow = useCallback((next: MetricsWindow) => {
    metricsWindowRef.current = next;
    setMetricsWindow(next);
    const sequence = ++metricsSequenceRef.current;
    setMetricsError(null);
    void api.getMetrics(next).then((nextMetrics) => {
      if (sequence === metricsSequenceRef.current) setMetrics(nextMetrics);
    }).catch((error) => {
      if (sequence === metricsSequenceRef.current) {
        setMetrics(null);
        setMetricsError(asApiError(error));
      }
    });
  }, [api]);

  const previewRoute = useCallback((
    model: string,
    operation: RouteOperation,
    requestFormat: RouteRequestFormat,
    signal: AbortSignal
  ): Promise<RoutePreview> => (
    api.getRoutePreview(model, operation, requestFormat, signal)
  ), [api]);

  useEffect(() => {
    if (route !== "overview" || accessMode === "initializing"
      || accessMode === "terminal" || accessMode === "stopped") return undefined;
    let controller: AbortController | null = null;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      const sequence = ++metricsSequenceRef.current;
      void api.getMetrics(metricsWindowRef.current, controller.signal).then((nextMetrics) => {
        if (sequence !== metricsSequenceRef.current) return;
        setMetrics(nextMetrics);
        setMetricsError(null);
      }).catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          // Keep the last valid chart during a transient background refresh failure.
        }
      });
      void loadHeatmap(controller.signal);
    };
    const interval = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
      controller?.abort();
    };
  }, [accessMode, api, loadHeatmap, route]);

  const loadActivityPage = useCallback((offset: number) => {
    if (activityLoadingRef.current) return;
    activityLoadingRef.current = true;
    const sequence = ++activitySequenceRef.current;
    setActivityLoading(true);
    setActionError(null);
    void api.getActivity(offset).then((next) => {
      if (sequence === activitySequenceRef.current) setActivity(next);
    }).catch((error) => {
      if (sequence === activitySequenceRef.current) setActionError(asApiError(error));
    }).finally(() => {
      if (sequence === activitySequenceRef.current) {
        activityLoadingRef.current = false;
        setActivityLoading(false);
      }
    });
  }, [api]);

  if (accessMode === "terminal") {
    return (
      <div id="session-root" className="terminal-root">
        <main className="session-terminal" aria-labelledby="terminal-title">
          <div className="brand-symbol" aria-hidden="true"><TerminalSquare /></div>
          <p className="terminal-eyebrow">{t("session.terminalEyebrow")}</p>
          <h1 id="terminal-title">{t("session.terminalTitle")}</h1>
          <p>{t("session.terminalHelp")}</p>
          <p>{t("session.reopen")}</p>
          <code>crp ui</code>
          <label className="terminal-locale">
            <span className="visually-hidden">{t("locale.label")}</span>
            <select value={locale} onChange={(event) => changeLocale(event.target.value as Locale)}>
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          {terminalError ? <span className="visually-hidden">{terminalError.code}</span> : null}
        </main>
      </div>
    );
  }

  if (accessMode === "stopped") {
    return (
      <div id="supervisor-stopped-root" className="terminal-root" data-testid="supervisor-stopped">
        <main className="session-terminal" aria-labelledby="stopped-title">
          <div className="brand-symbol terminal-stopped-symbol" aria-hidden="true"><Power /></div>
          <p className="terminal-eyebrow">{t("session.stoppedEyebrow")}</p>
          <h1 id="stopped-title">{t("session.stoppedTitle")}</h1>
          <p>{t("session.stoppedHelp")}</p>
          <p><strong>{t("session.stoppedClose")}</strong></p>
          <p>{t("session.stoppedRestart")}</p>
          <code>crp ui</code>
          <label className="terminal-locale">
            <span className="visually-hidden">{t("locale.label")}</span>
            <select value={locale} onChange={(event) => changeLocale(event.target.value as Locale)}>
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
        </main>
      </div>
    );
  }

  if (accessMode === "initializing" || !ready) {
    return (
      <main className="standalone-state" aria-labelledby="initializing-title">
        <div className="standalone-card">
          <div className="brand-symbol" aria-hidden="true"><TerminalSquare /></div>
          <StatusBadge tone="info">CRP</StatusBadge>
          <h1 id="initializing-title">{t("session.initializing")}</h1>
          <p>{t("session.initializingHelp")}</p>
          <span className="standalone-loader" aria-hidden="true" />
        </div>
      </main>
    );
  }

  if (!workspace) {
    return (
      <main className="standalone-state">
        <div className="standalone-card standalone-error">
          {loadError ? <ErrorNotice error={loadError} t={t} /> : null}
          <Button onClick={() => void refresh()}>{t("common.refresh")}</Button>
        </div>
      </main>
    );
  }

  const readOnly = accessMode !== "writable";
  const message = actionError
    ? <ErrorNotice error={actionError} t={t} />
    : loadError
      ? <ErrorNotice error={loadError} t={t} />
      : notice
        ? <Notice title={t(notice.key, notice.variables)} tone="success" role="status"><span /></Notice>
        : undefined;
  const dismissMessage = () => {
    setActionError(null);
    setLoadError(null);
    setNotice(null);
  };
  const sharedProviderProps = {
    t,
    providers: workspace.providers,
    activeProviderId: workspace.status.activeProviderId,
    readOnly,
    pending,
    onCreate: createProvider,
    onTest: testProvider,
    onActivate: activateProvider,
    onGetModels: getProviderModels,
    onRefreshModels: refreshProviderModels
  };

  return (
    <Shell
      accessMode={accessMode}
      locale={locale}
      t={t}
      route={route}
      status={workspace.status}
      providers={workspace.providers}
      pending={pending}
      message={message}
      onLocaleChange={changeLocale}
      onNavigate={navigate}
      onRefresh={() => void refresh()}
      onDismissMessage={dismissMessage}
      onResume={() => void resumeManagement()}
      onActivate={activateProvider}
      onStart={startProxy}
      onStop={stopProxy}
      onRestart={restartProxy}
      onShutdown={shutdownSupervisor}
    >
      {route === "overview" ? (
        <OverviewPage
          locale={locale}
          t={t}
          status={workspace.status}
          settings={workspace.settings}
          providers={workspace.providers}
          modelMappingGroups={workspace.modelMappingGroups}
          routingRuleGroups={workspace.routingRuleGroups}
          metrics={metrics}
          metricsError={metricsError}
          heatmap={heatmap}
          heatmapError={heatmapError}
          metricsWindow={metricsWindow}
          readOnly={readOnly}
          pending={pending}
          onNavigate={navigate}
          onMetricsWindow={changeMetricsWindow}
          onRoutePreview={previewRoute}
          onStart={startProxy}
          onRestart={restartProxy}
          onPrepareCodex={() => void prepareCodex()}
          onRefreshAccount={refreshAccount}
          onRoutingModeChange={updateRoutingMode}
        />
      ) : null}
      {route === "providers" ? (
        <ProvidersPage
          locale={locale}
          {...sharedProviderProps}
          providerPresets={workspace.providerPresets}
          modelMappingGroups={workspace.modelMappingGroups}
          workerRunning={workspace.status.worker?.phase === "running"
            && workspace.status.worker.state?.listening === true}
          onUpdate={updateProvider}
          onWeight={updateProviderWeight}
          onDelete={deleteProvider}
          onUpdateModels={updateProviderModels}
        />
      ) : null}
      {route === "model-mappings" ? (
        <ModelMappingsPage
          locale={locale}
          t={t}
          groups={workspace.modelMappingGroups}
          providers={workspace.providers}
          readOnly={readOnly}
          workerRunning={workspace.status.worker?.phase === "running"
            && workspace.status.worker.state?.listening === true}
          pending={pending}
          onCreate={createModelMappingGroup}
          onUpdate={updateModelMappingGroup}
          onDelete={deleteModelMappingGroup}
        />
      ) : null}
      {route === "routing-rules" ? (
        <RoutingRulesPage
          locale={locale}
          t={t}
          groups={workspace.routingRuleGroups}
          providers={workspace.providers}
          readOnly={readOnly}
          pending={pending}
          onCreate={createRoutingRuleGroup}
          onUpdate={updateRoutingRuleGroup}
          onDelete={deleteRoutingRuleGroup}
          onActivate={activateRoutingRuleGroup}
        />
      ) : null}
      {route === "forwarding" ? (
        <ForwardingRecordsPage
          locale={locale}
          t={t}
          captureEnabled={workspace.settings.captureEnabled}
          captureDetailsEnabled={workspace.settings.captureDetailsEnabled}
          captureStatus={workspace.status.capture}
          readOnly={accessMode !== "writable"}
          pending={pending}
          onLoad={loadForwardingRecords}
          onLoadDetail={loadForwardingRecordDetail}
          onCaptureChange={updateCaptureEnabled}
          onCaptureDetailsChange={updateCaptureDetailsEnabled}
        />
      ) : null}
      {route === "activity" ? (
        <ActivityPage
          locale={locale}
          t={t}
          data={activity}
          providers={workspace.providers}
          loading={activityLoading}
          onPage={loadActivityPage}
        />
      ) : null}
      {route === "system" ? (
        <SystemPage
          locale={locale}
          t={t}
          status={workspace.status}
          settings={workspace.settings}
          accessKeys={workspace.accessKeys}
          activeProvider={workspace.status.activeProvider}
          metrics={metrics}
          readOnly={readOnly}
          pending={pending}
          onPrepareCodex={prepareCodex}
          onGenerateDiagnostics={generateDiagnostics}
          onRefreshAccount={refreshAccount}
          onRoutingModeChange={updateRoutingMode}
          onAutoStartChange={updateAutoStartEnabled}
          onApiKeyAuthChange={updateApiKeyAuthEnabled}
          onProxyHostChange={updateProxyHost}
          onCreateAccessKey={createAccessKey}
          onUpdateAccessKey={updateAccessKey}
          onDeleteAccessKey={deleteAccessKey}
        />
      ) : null}
      {route === "setup" ? (
        <SetupPage
          {...sharedProviderProps}
          status={workspace.status}
          onPrepareCodex={prepareCodex}
          onStart={startProxy}
          onComplete={() => navigate("overview")}
        />
      ) : null}
    </Shell>
  );
}
