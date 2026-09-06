"use client";

import {
  Activity,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Ellipsis,
  FileClock,
  GitFork,
  Languages,
  LoaderCircle,
  ListTree,
  Menu,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  ServerCog,
  ShieldCheck,
  Square,
  TerminalSquare,
  X
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Translator, TranslationKey } from "../i18n";
import type { AccessMode, Locale, Provider, Route, StatusResponse } from "../types";
import { Button, IconButton, Modal, Notice, StatusBadge, cx } from "./Primitives";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Sheet, SheetClose, SheetContent } from "./ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const navConfig = [
  { route: "overview" as const, key: "nav.overview" as const, icon: CircleGauge },
  { route: "providers" as const, key: "nav.providers" as const, icon: Boxes },
  { route: "model-mappings" as const, key: "nav.model-mappings" as const, icon: GitFork },
  { route: "routing-rules" as const, key: "nav.routing-rules" as const, icon: ListTree },
  { route: "forwarding" as const, key: "nav.forwarding" as const, icon: FileClock },
  { route: "activity" as const, key: "nav.activity" as const, icon: Activity },
  { route: "system" as const, key: "nav.system" as const, icon: ServerCog }
];

const routeTitleKeys: Record<Route, TranslationKey> = {
  overview: "nav.overview",
  providers: "nav.providers",
  "model-mappings": "nav.model-mappings",
  "routing-rules": "nav.routing-rules",
  forwarding: "nav.forwarding",
  activity: "nav.activity",
  system: "nav.system",
  setup: "setup.title"
};

type ShellProps = {
  accessMode: AccessMode;
  locale: Locale;
  t: Translator;
  route: Route;
  status: StatusResponse;
  providers: Provider[];
  pending: string | null;
  message?: ReactNode;
  onLocaleChange: (locale: Locale) => void;
  onNavigate: (route: Route) => void;
  onRefresh: () => void;
  onDismissMessage: () => void;
  onResume: () => void;
  onActivate: (id: string) => Promise<boolean>;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onShutdown: () => Promise<boolean>;
  children: ReactNode;
};

export function Shell({
  accessMode,
  locale,
  t,
  route,
  status,
  providers,
  pending,
  message,
  onLocaleChange,
  onNavigate,
  onRefresh,
  onDismissMessage,
  onResume,
  onActivate,
  onStart,
  onStop,
  onRestart,
  onShutdown,
  children
}: ShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const restartFrameRef = useRef<number | null>(null);
  const shutdownFrameRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (restartFrameRef.current !== null) cancelAnimationFrame(restartFrameRef.current);
    if (shutdownFrameRef.current !== null) cancelAnimationFrame(shutdownFrameRef.current);
  }, []);

  const navigate = (next: Route) => {
    setMobileOpen(false);
    onNavigate(next);
  };

  const closeMobileNav = () => {
    setMobileOpen(false);
  };

  const runSidebarAction = (action: () => void) => {
    if (mobileOpen) closeMobileNav();
    action();
  };

  const requestSidebarRestart = () => {
    if (inFlight === 0) {
      runSidebarAction(onRestart);
      return;
    }
    if (!mobileOpen) {
      setRestartOpen(true);
      return;
    }
    closeMobileNav();
    if (restartFrameRef.current !== null) cancelAnimationFrame(restartFrameRef.current);
    restartFrameRef.current = requestAnimationFrame(() => {
      restartFrameRef.current = requestAnimationFrame(() => {
        restartFrameRef.current = null;
        setRestartOpen(true);
      });
    });
  };

  const requestSidebarShutdown = () => {
    if (!mobileOpen) {
      setShutdownOpen(true);
      return;
    }
    closeMobileNav();
    if (shutdownFrameRef.current !== null) cancelAnimationFrame(shutdownFrameRef.current);
    shutdownFrameRef.current = requestAnimationFrame(() => {
      shutdownFrameRef.current = requestAnimationFrame(() => {
        shutdownFrameRef.current = null;
        setShutdownOpen(true);
      });
    });
  };

  const activeProvider = status.activeProvider;
  const worker = status.worker;
  const workerRunning = worker?.phase === "running" && worker.state?.listening === true;
  const inFlight = worker?.state?.inFlight ?? 0;
  const providerEligible = activeProvider?.lastTestStatus === "passed" && activeProvider.credentialConfigured;
  const codexReady = status.codex.configured && !status.codex.historyRepairPending;
  const supervisorIdentified = Number.isSafeInteger(status.supervisor.pid)
    && status.supervisor.pid !== null
    && typeof status.supervisor.startedAt === "string";
  const mutationPending = pending !== null;
  let workerLabel = t("common.stopped");
  let workerTone: "success" | "danger" | "info" | "neutral" = "neutral";
  if (workerRunning) {
    workerLabel = t("common.running");
    workerTone = "success";
  } else if (worker?.phase === "failed" || worker?.phase === "crashed") {
    workerLabel = t("common.failed");
    workerTone = "danger";
  } else if (worker?.phase === "starting" || worker?.phase === "backoff") {
    workerLabel = t(worker.phase === "backoff" ? "common.recovering" : "common.starting");
    workerTone = "info";
  } else if (worker?.phase === "stopping" || worker?.phase === "draining") {
    workerLabel = t("common.stopping");
    workerTone = "info";
  }

  return (
    <div id="app-root" className="app-shell" data-testid="app-shell">
      <a className="skip-link" href="#main-content">{t("a11y.skip")}</a>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" finalFocus={menuRef} initialFocus={() => document.querySelector<HTMLElement>(".mobile-sheet-close")} aria-label={t("nav.label")} className="mobile-sheet">
          <div className="sidebar-brand">
            <div className="brand-symbol" aria-hidden="true"><TerminalSquare /></div>
            <div className="brand-copy"><strong>CRP</strong><span>{t("brand.subtitle")}</span></div>
            <SheetClose render={<IconButton className="sidebar-close mobile-sheet-close" label={t("a11y.closeNav")}><X aria-hidden="true" /></IconButton>} />
          </div>
          <nav className="sidebar-nav" aria-label={t("nav.label")}>
            {navConfig.map((item) => {
              const Icon = item.icon;
              return <a key={item.route} className={cx("nav-item", route === item.route && "nav-item-current")} href={`/${item.route}`} onClick={(event) => { event.preventDefault(); navigate(item.route); }}><Icon aria-hidden="true" /><span>{t(item.key)}</span></a>;
            })}
          </nav>
          <div className="sidebar-runtime-controls">
            <label className="sidebar-provider-select" htmlFor="mobile-provider-select">
              <span>{t("overview.route")}</span>
              <select
                id="mobile-provider-select"
                value={status.activeProviderId ?? ""}
                disabled={accessMode !== "writable" || mutationPending || providers.length === 0}
                onChange={(event) => {
                  if (event.target.value && event.target.value !== status.activeProviderId) {
                    void onActivate(event.target.value).then((activated) => {
                      if (activated) setMobileOpen(false);
                    });
                  }
                }}
              >
                {status.activeProviderId === null ? <option value="">{t("common.none")}</option> : null}
                {providers.map((provider) => <option key={provider.id} value={provider.id} disabled={provider.id !== status.activeProviderId && (!provider.credentialConfigured || provider.lastTestStatus !== "passed")}>{provider.name}</option>)}
              </select>
              <ChevronDown aria-hidden="true" />
            </label>
            <div className="sidebar-worker-actions" aria-label={t("overview.proxyControls")}>
              <IconButton label={t("overview.startProxy")} disabled={accessMode !== "writable" || mutationPending || workerRunning || !providerEligible || !codexReady} onClick={onStart}><Play aria-hidden="true" /></IconButton>
              <IconButton label={t("overview.stopProxy")} disabled={accessMode !== "writable" || mutationPending || !workerRunning} onClick={onStop}><Square aria-hidden="true" /></IconButton>
              <IconButton label={t("overview.restartWorker")} disabled={accessMode !== "writable" || mutationPending || !workerRunning || !providerEligible || !codexReady} onClick={requestSidebarRestart}><RotateCw aria-hidden="true" /></IconButton>
            </div>
          </div>
          <IconButton
            className="sidebar-supervisor-exit"
            label={t("supervisor.exit")}
            disabled={accessMode !== "writable" || mutationPending || !supervisorIdentified}
            onClick={requestSidebarShutdown}
          ><Power aria-hidden="true" /></IconButton>
          <label className="sidebar-locale" htmlFor="mobile-locale-select">
            <Languages aria-hidden="true" />
            <span>{t("locale.label")}</span>
            <select id="mobile-locale-select" value={locale} onChange={(event) => onLocaleChange(event.target.value as Locale)}>
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
        </SheetContent>
      </Sheet>
      <aside
        className="sidebar desktop-sidebar"
        aria-label={t("nav.label")}
      >
        <div className="sidebar-brand">
          <div className="brand-symbol" aria-hidden="true"><TerminalSquare /></div>
          <div className="brand-copy">
            <strong>CRP</strong>
            <span>{t("brand.subtitle")}</span>
          </div>
          <IconButton
            className="sidebar-close"
            label={t("a11y.closeNav")}
            onClick={closeMobileNav}
          >
            <X aria-hidden="true" />
          </IconButton>
        </div>
        <nav className="sidebar-nav" aria-label={t("nav.label")}>
          {navConfig.map((item) => {
            const Icon = item.icon;
            const enabledRoute = item.route as Route;
            const selected = route === enabledRoute;
            return (
              <a
                key={enabledRoute}
                className={cx("nav-item", selected && "nav-item-current")}
                href={`/${enabledRoute}`}
                data-testid={enabledRoute === "forwarding" ? "nav-forwarding-records" : undefined}
                aria-current={selected ? "page" : undefined}
                onClick={(event) => { event.preventDefault(); navigate(enabledRoute); }}
              >
                <Icon aria-hidden="true" />
                <span>{t(item.key)}</span>
                {selected ? <ChevronRight className="nav-chevron" aria-hidden="true" /> : null}
              </a>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-runtime">
            <div className="sidebar-runtime-heading">
              <span title={status.codex.proxyUrl ?? "http://127.0.0.1:15100"}>OpenAI · :15100</span>
              <div className="sidebar-runtime-heading-actions">
                <StatusBadge tone={workerTone}>
                  {workerLabel}
                  {inFlight > 0 ? ` · ${inFlight}` : ""}
                </StatusBadge>
                <IconButton
                  className="sidebar-supervisor-exit"
                  label={t("supervisor.exit")}
                  disabled={accessMode !== "writable" || mutationPending || !supervisorIdentified}
                  aria-busy={pending === "supervisor-shutdown" || undefined}
                  onClick={requestSidebarShutdown}
                >{pending === "supervisor-shutdown"
                    ? <LoaderCircle className="spin" aria-hidden="true" />
                    : <Power aria-hidden="true" />}</IconButton>
              </div>
            </div>
            <div className="sidebar-runtime-controls">
              <label className="sidebar-provider-select" htmlFor="sidebar-provider-select">
                <span className="visually-hidden">{t("overview.route")}</span>
                <select
                  id="sidebar-provider-select"
                  value={status.activeProviderId ?? ""}
                  title={activeProvider
                    ? `${activeProvider.name} · ${t(workerRunning ? "overview.routeHelp" : "providers.switchAndStart")}`
                    : t("overview.routeHelp")}
                  disabled={accessMode !== "writable" || mutationPending || providers.length === 0}
                  onChange={(event) => {
                    if (event.target.value && event.target.value !== status.activeProviderId) {
                      const id = event.target.value;
                      runSidebarAction(() => { void onActivate(id); });
                    }
                  }}
                >
                  {status.activeProviderId === null ? <option value="">{t("common.none")}</option> : null}
                  {providers.map((provider) => {
                    const eligible = provider.lastTestStatus === "passed" && provider.credentialConfigured;
                    const unavailable = !provider.credentialConfigured
                      ? t("providers.credentialRequired")
                      : provider.lastTestStatus === "failed"
                        ? t("common.failed")
                        : t("common.untested");
                    return (
                      <option
                        key={provider.id}
                        value={provider.id}
                        disabled={provider.id !== status.activeProviderId && !eligible}
                      >
                        {provider.name}{!eligible ? ` · ${unavailable}` : ""}
                      </option>
                    );
                  })}
                </select>
                <ChevronDown aria-hidden="true" />
              </label>
              <div className="sidebar-worker-actions" aria-label={t("overview.proxyControls")}>
                <IconButton
                  label={t("overview.startProxy")}
                  disabled={accessMode !== "writable" || mutationPending || workerRunning || !providerEligible || !codexReady}
                  aria-busy={pending === "proxy-start" || undefined}
                  onClick={() => runSidebarAction(onStart)}
                ><Play className={pending === "proxy-start" ? "spin" : undefined} aria-hidden="true" /></IconButton>
                <IconButton
                  label={t("overview.stopProxy")}
                  disabled={accessMode !== "writable" || mutationPending || !workerRunning}
                  aria-busy={pending === "proxy-stop" || undefined}
                  onClick={() => runSidebarAction(onStop)}
                ><Square aria-hidden="true" /></IconButton>
                <IconButton
                  label={t("overview.restartWorker")}
                  disabled={accessMode !== "writable" || mutationPending || !workerRunning || !providerEligible || !codexReady}
                  aria-busy={pending === "proxy-restart" || undefined}
                  onClick={requestSidebarRestart}
                ><RotateCw className={pending === "proxy-restart" ? "spin" : undefined} aria-hidden="true" /></IconButton>
              </div>
            </div>
          </div>
          <label className="sidebar-locale" htmlFor="locale-select">
            <Languages aria-hidden="true" />
            <span className="visually-hidden">{t("locale.label")}</span>
            <select
              id="locale-select"
              value={locale}
              onChange={(event) => onLocaleChange(event.target.value as Locale)}
            >
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <div className="sidebar-meta">
            {status.build.repositoryUrl ? (
              <a
                href={status.build.repositoryUrl}
                target="_blank"
                rel="noreferrer"
                title={t("brand.github")}
              ><GitFork aria-hidden="true" /><span>v{status.build.version}</span></a>
            ) : <span>v{status.build.version}</span>}
            <span>{accessMode === "writable" ? t("access.manage") : t("access.readOnly")}</span>
          </div>
        </div>
      </aside>
      <div className="content-shell">
        <header className="topbar">
          <div className="topbar-title">
            <IconButton
              ref={menuRef}
              className="menu-button"
              label={t("a11y.openNav")}
              onClick={() => setMobileOpen(true)}
            >
              <Menu aria-hidden="true" />
            </IconButton>
            <div>
              {route === "overview"
                ? <h1>{t(routeTitleKeys[route])}</h1>
                : <strong>{t(routeTitleKeys[route])}</strong>}
              <span>127.0.0.1:15101 · {t("brand.console")}</span>
            </div>
          </div>
          <div className="topbar-actions">
            <StatusBadge tone={accessMode === "writable" ? "info" : "neutral"}>
              <ShieldCheck aria-hidden="true" />
              {accessMode === "writable" ? t("access.manage") : t("access.readOnly")}
            </StatusBadge>
            <Tooltip>
              <TooltipTrigger render={<IconButton label={t("a11y.refresh")} disabled={mutationPending} onClick={onRefresh}><RefreshCw aria-hidden="true" /></IconButton>} />
              <TooltipContent>{t("a11y.refresh")}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton label="More console actions"><Ellipsis aria-hidden="true" /></IconButton>} />
              <DropdownMenuContent>
                <DropdownMenuItem onClick={onRefresh}>{t("a11y.refresh")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("system")}>{t("nav.system")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {accessMode === "read-only" ? (
          <div className="session-banner" id="session-banner">
            <Notice title={t("session.readOnlyTitle")} tone="warning">
              <p>{t("session.readOnlyHelp")}</p>
              <Button
                variant="primary"
                busy={pending === "session-resume"}
                disabled={mutationPending}
                onClick={onResume}
              >{t("session.resume")}</Button>
            </Notice>
          </div>
        ) : null}
        {message ? (
          <div className="global-message" data-testid="global-message">
            <div className="global-message-content">{message}</div>
            <IconButton className="global-message-close" label={t("common.close")} onClick={onDismissMessage}>
              <X aria-hidden="true" />
            </IconButton>
          </div>
        ) : null}
        <main
          id="main-content"
          className={cx("main-content", route === "overview" && "main-content-overview")}
          tabIndex={-1}
        >
          {children}
        </main>
      </div>
      <Modal
        open={restartOpen}
        title={t("overview.restartTitle")}
        description={t("overview.restartHelp", { count: inFlight })}
        onClose={() => setRestartOpen(false)}
        t={t}
        size="small"
        footer={(
          <>
            <Button onClick={() => setRestartOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => { setRestartOpen(false); onRestart(); }}>
              {t("overview.restartAnyway")}
            </Button>
          </>
        )}
      ><Notice title={t("overview.inFlight", { value: inFlight })} tone="warning"><p>{t("overview.proxyControlsHelp")}</p></Notice></Modal>
      <Modal
        open={shutdownOpen}
        title={t("supervisor.exitTitle")}
        description={t("supervisor.exitHelp")}
        onClose={() => setShutdownOpen(false)}
        t={t}
        size="small"
        footer={(
          <>
            <Button autoFocus onClick={() => setShutdownOpen(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setShutdownOpen(false);
                void onShutdown();
              }}
            >{t("supervisor.exitConfirm")}</Button>
          </>
        )}
      >
        <Notice title={t("supervisor.exitNoticeTitle")} tone="warning">
          <p>{t("supervisor.exitNoticeHelp")}</p>
        </Notice>
      </Modal>
    </div>
  );
}
