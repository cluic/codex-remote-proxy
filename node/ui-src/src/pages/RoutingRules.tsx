import {
  ArrowDown,
  ArrowUp,
  Check,
  ListTree,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Trash2,
  X
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import {
  Button,
  EmptyState,
  Field,
  FormError,
  IconButton,
  Modal,
  Notice,
  PageHeader,
  SelectField,
  StatusBadge,
  cx
} from "../components/Primitives";
import { formatDate, formatNumber, type Translator } from "../i18n";
import type {
  Locale,
  Provider,
  RoutingRule,
  RoutingRuleGroup,
  RoutingRuleGroupInput
} from "../types";

type RoutingRulesProps = {
  locale: Locale;
  t: Translator;
  groups: RoutingRuleGroup[];
  providers: Provider[];
  readOnly: boolean;
  pending: string | null;
  onCreate: (input: RoutingRuleGroupInput) => Promise<RoutingRuleGroup | null>;
  onUpdate: (id: string, input: RoutingRuleGroupInput) => Promise<RoutingRuleGroup | null>;
  onDelete: (id: string) => Promise<boolean>;
  onActivate: (id: string | null) => Promise<boolean>;
};

type DialogMode = "create" | "edit" | "delete" | null;
type DraftRule = RoutingRule & { key: string };

let nextRuleKey = 0;

function draftRule(rule?: RoutingRule): DraftRule {
  nextRuleKey += 1;
  return {
    key: `routing-rule-${nextRuleKey}`,
    model: rule?.model ?? "",
    providerIds: [...(rule?.providerIds ?? [])]
  };
}

function RoutingRuleForm({
  formId,
  group,
  providers,
  t,
  onSubmit
}: {
  formId: string;
  group?: RoutingRuleGroup;
  providers: Provider[];
  t: Translator;
  onSubmit: (input: RoutingRuleGroupInput) => Promise<boolean>;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [rules, setRules] = useState<DraftRule[]>(
    () => group?.rules.map((rule) => draftRule(rule)) ?? [draftRule()]
  );
  const [error, setError] = useState<string | null>(null);

  const updateRule = (key: string, update: (rule: DraftRule) => DraftRule) => {
    setRules((current) => current.map((rule) => rule.key === key ? update(rule) : rule));
  };

  const moveProvider = (ruleKey: string, index: number, direction: -1 | 1) => {
    updateRule(ruleKey, (rule) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= rule.providerIds.length) return rule;
      const providerIds = [...rule.providerIds];
      [providerIds[index], providerIds[nextIndex]] = [providerIds[nextIndex]!, providerIds[index]!];
      return { ...rule, providerIds };
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = rules.map((rule) => ({
      model: rule.model.trim(),
      providerIds: [...rule.providerIds]
    }));
    if (!name.trim()
      || normalized.length === 0
      || normalized.some((rule) => !rule.model || rule.providerIds.length === 0)
      || new Set(normalized.map((rule) => rule.model)).size !== normalized.length) {
      setError(t("routingRules.invalidForm"));
      return;
    }
    setError(null);
    if (!await onSubmit({ name: name.trim(), rules: normalized })) {
      setError(t("routingRules.invalidForm"));
    }
  };

  return (
    <form id={formId} className="routing-rule-form" onSubmit={submit} noValidate>
      {error ? <FormError>{error}</FormError> : null}
      <Field
        id={`${formId}-name`}
        name="name"
        label={t("routingRules.name")}
        help={t("routingRules.nameHelp")}
        value={name}
        maxLength={100}
        autoComplete="off"
        autoFocus
        required
        onChange={(event) => setName(event.target.value)}
      />
      <div className="routing-rule-editor">
        <div className="mapping-rule-heading">
          <div>
            <h3>{t("routingRules.rules")}</h3>
            <p>{t("routingRules.rulesHelp")}</p>
          </div>
          <span>{t("routingRules.ruleCount", { count: rules.length })}</span>
        </div>
        <div className="routing-rule-list">
          {rules.map((rule, ruleIndex) => {
            const remaining = providers.filter((provider) => !rule.providerIds.includes(provider.id));
            return (
              <section className="routing-rule-card" key={rule.key}>
                <header>
                  <span>{t("routingRules.ruleNumber", { value: ruleIndex + 1 })}</span>
                  <IconButton
                    label={t("routingRules.removeRuleNumber", { value: ruleIndex + 1 })}
                    disabled={rules.length === 1}
                    onClick={() => setRules((current) => current.filter((item) => item.key !== rule.key))}
                  ><X aria-hidden="true" /></IconButton>
                </header>
                <Field
                  id={`${formId}-model-${rule.key}`}
                  name={`model-${ruleIndex}`}
                  label={t("routingRules.model")}
                  help={t("routingRules.modelHelp")}
                  value={rule.model}
                  maxLength={256}
                  spellCheck={false}
                  required
                  onChange={(event) => updateRule(rule.key, (current) => ({
                    ...current,
                    model: event.target.value
                  }))}
                />
                <div className="routing-priority-editor">
                  <span className="routing-priority-label">{t("routingRules.priority")}</span>
                  {rule.providerIds.length > 0 ? (
                    <ol>
                      {rule.providerIds.map((providerId, index) => {
                        const provider = providers.find((item) => item.id === providerId);
                        return (
                          <li key={providerId}>
                            <span className="routing-rank">{index + 1}</span>
                            <span className="routing-provider-name">
                              <strong>{provider?.name ?? providerId}</strong>
                              <small>{provider?.lastTestStatus === "passed"
                                ? t("common.passed")
                                : t("common.untested")}</small>
                            </span>
                            <IconButton
                              label={t("routingRules.moveUp", { name: provider?.name ?? providerId })}
                              disabled={index === 0}
                              onClick={() => moveProvider(rule.key, index, -1)}
                            ><ArrowUp aria-hidden="true" /></IconButton>
                            <IconButton
                              label={t("routingRules.moveDown", { name: provider?.name ?? providerId })}
                              disabled={index === rule.providerIds.length - 1}
                              onClick={() => moveProvider(rule.key, index, 1)}
                            ><ArrowDown aria-hidden="true" /></IconButton>
                            <IconButton
                              label={t("routingRules.removeProvider", { name: provider?.name ?? providerId })}
                              onClick={() => updateRule(rule.key, (current) => ({
                                ...current,
                                providerIds: current.providerIds.filter((id) => id !== providerId)
                              }))}
                            ><X aria-hidden="true" /></IconButton>
                          </li>
                        );
                      })}
                    </ol>
                  ) : <p className="routing-empty-priority">{t("routingRules.noPriority")}</p>}
                  {remaining.length > 0 ? (
                    <SelectField
                      id={`${formId}-provider-${rule.key}`}
                      name={`provider-${ruleIndex}`}
                      label={t("routingRules.addProvider")}
                      value=""
                      onChange={(event) => {
                        const providerId = event.target.value;
                        if (!providerId) return;
                        updateRule(rule.key, (current) => ({
                          ...current,
                          providerIds: [...current.providerIds, providerId]
                        }));
                      }}
                    >
                      <option value="">{t("routingRules.chooseProvider")}</option>
                      {remaining.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.name}</option>
                      ))}
                    </SelectField>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
        <Button
          className="mapping-add-rule"
          disabled={rules.length >= 100 || providers.length === 0}
          onClick={() => setRules((current) => [...current, draftRule()])}
        ><Plus className="icon" aria-hidden="true" />{t("routingRules.addRule")}</Button>
      </div>
    </form>
  );
}

export function RoutingRulesPage({
  locale,
  t,
  groups,
  providers,
  readOnly,
  pending,
  onCreate,
  onUpdate,
  onDelete,
  onActivate
}: RoutingRulesProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    groups.find((group) => group.active)?.id ?? groups[0]?.id ?? null
  );
  const [mode, setMode] = useState<DialogMode>(null);
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0] ?? null;

  useEffect(() => {
    if (groups.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!groups.some((group) => group.id === selectedId)) {
      setSelectedId(groups.find((group) => group.active)?.id ?? groups[0]!.id);
    }
  }, [groups, selectedId]);

  const close = () => setMode(null);

  return (
    <div className="page-stack mapping-page routing-page" data-testid="page-routing-rules">
      <PageHeader
        title={t("routingRules.title")}
        subtitle={t("routingRules.subtitle")}
        action={(
          <Button
            variant="primary"
            disabled={readOnly || pending !== null || providers.length === 0}
            onClick={() => setMode("create")}
          ><Plus className="icon" aria-hidden="true" />{t("routingRules.addGroup")}</Button>
        )}
      />

      {groups.length === 0 ? (
        <EmptyState
          icon={<ListTree />}
          title={t("routingRules.emptyTitle")}
          description={providers.length === 0
            ? t("routingRules.providersRequired")
            : t("routingRules.emptyHelp")}
          action={providers.length > 0 ? (
            <Button
              variant="primary"
              disabled={readOnly || pending !== null}
              onClick={() => setMode("create")}
            ><Plus className="icon" aria-hidden="true" />{t("routingRules.addGroup")}</Button>
          ) : undefined}
        />
      ) : (
        <div className="mapping-workspace">
          <section className="mapping-group-list" aria-label={t("routingRules.groups")}>
            <div className="mapping-group-list-heading">
              <span>{t("routingRules.groups")}</span>
              <strong>{formatNumber(locale, groups.length)}</strong>
            </div>
            {groups.map((group) => {
              const current = group.id === selected?.id;
              return (
                <button
                  key={group.id}
                  className={cx("mapping-group-item", current && "mapping-group-item-active")}
                  type="button"
                  aria-pressed={current}
                  onClick={() => setSelectedId(group.id)}
                >
                  <span className="mapping-group-icon"><ListTree aria-hidden="true" /></span>
                  <span>
                    <strong>{group.name}</strong>
                    <small>{t("routingRules.groupSummary", { rules: group.rules.length })}</small>
                  </span>
                  {group.active
                    ? <span className="routing-active-dot" title={t("routingRules.active")} />
                    : current ? <Check aria-hidden="true" /> : null}
                </button>
              );
            })}
          </section>

          {selected ? (
            <section className="mapping-detail" aria-labelledby="routing-detail-title">
              <header className="mapping-detail-header">
                <div>
                  <span>{selected.active ? t("routingRules.active") : t("routingRules.inactive")}</span>
                  <h2 id="routing-detail-title">{selected.name}</h2>
                  <p>{t("routingRules.updatedAt", { value: formatDate(locale, selected.updatedAt) })}</p>
                </div>
                <div className="mapping-detail-actions routing-detail-actions">
                  <Button
                    variant={selected.active ? undefined : "primary"}
                    disabled={readOnly || pending !== null}
                    busy={pending === "routing-rule-activate"}
                    onClick={() => void onActivate(selected.active ? null : selected.id)}
                  >{selected.active
                      ? <PowerOff className="icon" aria-hidden="true" />
                      : <Power className="icon" aria-hidden="true" />}
                    {selected.active ? t("routingRules.deactivate") : t("routingRules.activate")}
                  </Button>
                  <Button
                    disabled={readOnly || pending !== null}
                    onClick={() => setMode("edit")}
                  ><Pencil className="icon" aria-hidden="true" />{t("common.edit")}</Button>
                  <Button
                    variant="danger"
                    disabled={readOnly || pending !== null}
                    onClick={() => setMode("delete")}
                  ><Trash2 className="icon" aria-hidden="true" />{t("common.delete")}</Button>
                </div>
              </header>
              {selected.active ? (
                <Notice title={t("routingRules.liveTitle")} tone="success">
                  <p>{t("routingRules.liveHelp")}</p>
                </Notice>
              ) : null}
              <div className="routing-summary-strip">
                <div><span>{t("routingRules.exactRules")}</span><strong>{formatNumber(locale, selected.rules.length)}</strong></div>
                <p>{t("routingRules.fallbackHelp")}</p>
              </div>
              <div className="routing-rules-view">
                {selected.rules.length > 0 ? selected.rules.map((rule) => (
                  <article key={rule.model}>
                    <code>{rule.model}</code>
                    <div className="routing-priority-flow">
                      {rule.providerIds.map((providerId, index) => {
                        const provider = providers.find((item) => item.id === providerId);
                        return (
                          <span key={providerId}>
                            <b>{index + 1}</b>
                            <StatusBadge tone={provider?.lastTestStatus === "passed" ? "success" : "warning"}>
                              {provider?.name ?? providerId}
                            </StatusBadge>
                          </span>
                        );
                      })}
                    </div>
                  </article>
                )) : <p className="routing-empty-group">{t("routingRules.emptyGroup")}</p>}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <Modal
        open={mode === "create"}
        title={t("routingRules.createTitle")}
        description={t("routingRules.formHelp")}
        onClose={close}
        t={t}
        size="large"
        footer={<><Button onClick={close}>{t("common.cancel")}</Button><Button variant="primary" type="submit" form="routing-rule-create-form" busy={pending === "routing-rule-create"}>{t("routingRules.saveCreate")}</Button></>}
      >
        {mode === "create" ? (
          <RoutingRuleForm
            formId="routing-rule-create-form"
            providers={providers}
            t={t}
            onSubmit={async (input) => {
              const created = await onCreate(input);
              if (created) {
                setSelectedId(created.id);
                close();
              }
              return created !== null;
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={mode === "edit"}
        title={t("routingRules.editTitle")}
        description={selected?.name}
        onClose={close}
        t={t}
        size="large"
        footer={<><Button onClick={close}>{t("common.cancel")}</Button><Button variant="primary" type="submit" form="routing-rule-edit-form" busy={pending === `routing-rule-update-${selected?.id ?? ""}`}>{t("common.save")}</Button></>}
      >
        {mode === "edit" && selected ? (
          <RoutingRuleForm
            formId="routing-rule-edit-form"
            group={selected}
            providers={providers}
            t={t}
            onSubmit={async (input) => {
              const updated = await onUpdate(selected.id, input);
              if (updated) close();
              return updated !== null;
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={mode === "delete"}
        title={t("routingRules.deleteTitle")}
        description={selected?.name}
        onClose={close}
        t={t}
        size="small"
        footer={<><Button onClick={close}>{t("common.cancel")}</Button><Button variant="danger" busy={pending === `routing-rule-delete-${selected?.id ?? ""}`} onClick={async () => { if (selected && await onDelete(selected.id)) close(); }}>{t("common.delete")}</Button></>}
      >
        <Notice title={selected?.name ?? t("routingRules.deleteTitle")} tone="warning">
          <p>{selected?.active ? t("routingRules.deleteActiveHelp") : t("routingRules.deleteHelp")}</p>
        </Notice>
      </Modal>
    </div>
  );
}
