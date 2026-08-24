import { Activity, ChevronDown } from "lucide-react";

import { Button, EmptyState, PageHeader, StatusBadge } from "../components/Primitives";
import { formatDate, type Translator, type TranslationKey } from "../i18n";
import type { ActivityPageData, Locale, Provider } from "../types";

type ActivityProps = {
  locale: Locale;
  t: Translator;
  data: ActivityPageData;
  providers: Provider[];
  loading: boolean;
  onPage: (offset: number) => void;
};

function actionKey(action: string | null): TranslationKey | null {
  const keys: Record<string, TranslationKey> = {
    create: "activity.create",
    update: "activity.update",
    delete: "activity.delete",
    test: "activity.test",
    models: "activity.models",
    weight: "activity.weight",
    activate: "activity.activate",
    start: "activity.start",
    stop: "activity.stop",
    restart: "activity.restart",
    capture: "activity.capture",
    autostart: "activity.autostart",
    "legacy-config": "activity.legacy-config",
    "routing-mode": "activity.routing-mode",
    "provider-registry-schema-3": "activity.provider-registry-schema-3",
    "provider-registry-schema-4": "activity.provider-registry-schema-4",
    "provider-registry-schema-5": "activity.provider-registry-schema-5",
    "provider-registry-schema-6": "activity.provider-registry-schema-6",
    "provider-registry-schema-7": "activity.provider-registry-schema-7",
    "model-mapping-create": "activity.model-mapping-create",
    "model-mapping-update": "activity.model-mapping-update",
    "model-mapping-delete": "activity.model-mapping-delete",
    "models-update": "activity.models-update",
    "routing-rule-create": "activity.routing-rule-create",
    "routing-rule-update": "activity.routing-rule-update",
    "routing-rule-delete": "activity.routing-rule-delete",
    "routing-rule-activate": "activity.routing-rule-activate"
  };
  return action ? keys[action] ?? null : null;
}

function eventTone(result: string | null): "success" | "danger" | "warning" | "neutral" {
  if (result === "success") return "success";
  if (result === "degraded") return "warning";
  if (result === "failed" || result === "failure") return "danger";
  return "neutral";
}

function resultLabel(result: string | null, t: Translator): string {
  if (result === "success") return t("common.complete");
  if (result === "degraded") return t("common.degraded");
  if (result === "failed" || result === "failure") return t("common.failed");
  return t("common.unknown");
}

function categoryLabel(category: string | null, t: Translator): string {
  if (category === "provider") return t("activity.categoryProvider");
  if (category === "proxy") return t("activity.categoryProxy");
  if (category === "migration") return t("activity.categoryMigration");
  if (category === "settings") return t("activity.categorySettings");
  return category ?? t("common.unknown");
}

function safeDetail(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[filtered]";
}

export function ActivityPage({ locale, t, data, providers, loading, onPage }: ActivityProps) {
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  return (
    <div className="page-stack" data-testid="page-activity">
      <PageHeader title={t("activity.title")} subtitle={t("activity.subtitle")} />
      {data.events.length === 0 ? (
        <EmptyState
          icon={<Activity />}
          title={t("activity.emptyTitle")}
          description={t("activity.emptyHelp")}
        />
      ) : (
        <section className="activity-panel" aria-label={t("activity.title")}>
          <div className="activity-table-heading" aria-hidden="true">
            <span>{t("common.time")}</span>
            <span>{t("activity.action")}</span>
            <span>{t("activity.category")}</span>
            <span>{t("activity.result")}</span>
          </div>
          <div className="activity-list">
            {data.events.map((event, index) => {
              const key = actionKey(event.action);
              const action = key ? t(key) : event.action ?? t("common.unknown");
              const provider = event.providerId ? providerNames.get(event.providerId) : null;
              return (
                <details className="activity-event" key={`${event.timestamp ?? "event"}-${index}`}>
                  <summary>
                    <time dateTime={event.timestamp ?? undefined}>{formatDate(locale, event.timestamp, true)}</time>
                    <span className="activity-action">
                      <strong>{action}</strong>
                      {provider ? <small>{provider}</small> : null}
                    </span>
                    <span className="activity-category">{categoryLabel(event.category, t)}</span>
                    <StatusBadge tone={eventTone(event.result)}>{resultLabel(event.result, t)}</StatusBadge>
                    <ChevronDown className="activity-chevron" aria-hidden="true" />
                  </summary>
                  <div className="activity-detail">
                    {event.providerId ? <p><code>{t("activity.providerId", { value: event.providerId })}</code></p> : null}
                    {event.errorCode ? <p><code>{t("activity.errorCode", { value: event.errorCode })}</code></p> : null}
                    {event.result === "degraded" || event.details.rollbackDegraded === true ? (
                      <p className="activity-repair">{t("activity.repair")}</p>
                    ) : null}
                    {Object.keys(event.details).length > 0 ? (
                      <dl className="activity-detail-list">
                        {Object.entries(event.details).map(([name, value]) => (
                          <div key={name}><dt>{name}</dt><dd><code>{safeDetail(value)}</code></dd></div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      )}
      {data.events.length > 0 ? (
        <nav className="pagination" aria-label={t("activity.title")}>
          <Button
            disabled={loading || data.page.offset === 0}
            onClick={() => onPage(Math.max(0, data.page.offset - data.page.limit))}
          >{t("common.previous")}</Button>
          <span>{data.page.offset + 1}-{data.page.offset + data.events.length}</span>
          <Button
            disabled={loading || data.page.nextOffset === null}
            onClick={() => { if (data.page.nextOffset !== null) onPage(data.page.nextOffset); }}
          >{t("common.next")}</Button>
        </nav>
      ) : null}
    </div>
  );
}
