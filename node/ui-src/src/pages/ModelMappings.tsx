import {
  ArrowRight,
  Braces,
  Check,
  GitFork,
  Pencil,
  Plus,
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
  StatusBadge,
  cx
} from "../components/Primitives";
import { formatDate, formatNumber, type Translator } from "../i18n";
import type {
  Locale,
  ModelMappingGroup,
  ModelMappingGroupInput,
  ModelMappingRule,
  Provider
} from "../types";

type ModelMappingsProps = {
  locale: Locale;
  t: Translator;
  groups: ModelMappingGroup[];
  providers: Provider[];
  readOnly: boolean;
  workerRunning: boolean;
  pending: string | null;
  onCreate: (input: ModelMappingGroupInput) => Promise<ModelMappingGroup | null>;
  onUpdate: (id: string, input: ModelMappingGroupInput) => Promise<ModelMappingGroup | null>;
  onDelete: (id: string) => Promise<boolean>;
};

type DialogMode = "create" | "edit" | "delete" | null;

type DraftRule = ModelMappingRule & { key: string };

let nextDraftRuleKey = 0;

function draftRule(rule?: ModelMappingRule): DraftRule {
  nextDraftRuleKey += 1;
  return {
    key: `mapping-rule-${nextDraftRuleKey}`,
    sourceModel: rule?.sourceModel ?? "",
    targetModel: rule?.targetModel ?? ""
  };
}

function MappingForm({
  formId,
  group,
  t,
  onSubmit
}: {
  formId: string;
  group?: ModelMappingGroup;
  t: Translator;
  onSubmit: (input: ModelMappingGroupInput) => Promise<boolean>;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [rules, setRules] = useState<DraftRule[]>(
    () => group?.rules.map((rule) => draftRule(rule)) ?? [draftRule()]
  );
  const [error, setError] = useState<string | null>(null);

  const updateRule = (index: number, field: keyof ModelMappingRule, value: string) => {
    setRules((current) => current.map((rule, ruleIndex) => (
      ruleIndex === index ? { ...rule, [field]: value } : rule
    )));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedRules = rules.map((rule) => ({
      sourceModel: rule.sourceModel.trim(),
      targetModel: rule.targetModel.trim()
    }));
    const sources = normalizedRules.map((rule) => rule.sourceModel);
    if (!name.trim()
      || normalizedRules.some((rule) => !rule.sourceModel || !rule.targetModel)
      || new Set(sources).size !== sources.length) {
      setError(t("modelMappings.invalidForm"));
      return;
    }
    setError(null);
    if (!await onSubmit({ name: name.trim(), rules: normalizedRules })) {
      setError(t("modelMappings.invalidForm"));
    }
  };

  return (
    <form id={formId} className="mapping-form" onSubmit={submit} noValidate>
      {error ? <FormError>{error}</FormError> : null}
      <Field
        id="mapping-group-name"
        name="name"
        label={t("modelMappings.name")}
        help={t("modelMappings.nameHelp")}
        value={name}
        maxLength={100}
        autoComplete="off"
        autoFocus
        required
        onChange={(event) => setName(event.target.value)}
      />
      <div className="mapping-rule-editor">
        <div className="mapping-rule-heading">
          <div>
            <h3>{t("modelMappings.rules")}</h3>
            <p>{t("modelMappings.rulesHelp")}</p>
          </div>
          <span>{t("modelMappings.ruleCount", { count: rules.length })}</span>
        </div>
        <div className="mapping-rule-labels" aria-hidden="true">
          <span>{t("modelMappings.sourceModel")}</span>
          <span>{t("modelMappings.targetModel")}</span>
          <span />
        </div>
        <div className="mapping-rule-list">
          {rules.map((rule, index) => (
            <div className="mapping-rule-row" key={rule.key}>
              <label>
                <span className="visually-hidden">{t("modelMappings.sourceModelNumber", { value: index + 1 })}</span>
                <input
                  value={rule.sourceModel}
                  maxLength={256}
                  spellCheck={false}
                  placeholder="gpt-5"
                  required
                  onChange={(event) => updateRule(index, "sourceModel", event.target.value)}
                />
              </label>
              <ArrowRight aria-hidden="true" />
              <label>
                <span className="visually-hidden">{t("modelMappings.targetModelNumber", { value: index + 1 })}</span>
                <input
                  value={rule.targetModel}
                  maxLength={256}
                  spellCheck={false}
                  placeholder="openai/gpt-5"
                  required
                  onChange={(event) => updateRule(index, "targetModel", event.target.value)}
                />
              </label>
              <IconButton
                label={t("modelMappings.removeRuleNumber", { value: index + 1 })}
                disabled={rules.length === 1}
                onClick={() => setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))}
              ><X aria-hidden="true" /></IconButton>
            </div>
          ))}
        </div>
        <Button
          className="mapping-add-rule"
          disabled={rules.length >= 50}
          onClick={() => setRules((current) => [...current, draftRule()])}
        ><Plus className="icon" aria-hidden="true" />{t("modelMappings.addRule")}</Button>
      </div>
    </form>
  );
}

export function ModelMappingsPage({
  locale,
  t,
  groups,
  providers,
  readOnly,
  workerRunning,
  pending,
  onCreate,
  onUpdate,
  onDelete
}: ModelMappingsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(groups[0]?.id ?? null);
  const [mode, setMode] = useState<DialogMode>(null);
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0] ?? null;
  const assignedProviders = selected
    ? providers.filter((provider) => provider.modelMappingGroupId === selected.id)
    : [];
  const runningPoolLocked = workerRunning && assignedProviders.some(
    (provider) => provider.lastTestStatus === "passed"
  );

  useEffect(() => {
    if (groups.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!groups.some((group) => group.id === selectedId)) setSelectedId(groups[0]!.id);
  }, [groups, selectedId]);

  const close = () => setMode(null);

  return (
    <div className="page-stack mapping-page" data-testid="page-model-mappings">
      <PageHeader
        title={t("modelMappings.title")}
        subtitle={t("modelMappings.subtitle")}
        action={(
          <Button
            variant="primary"
            disabled={readOnly || pending !== null}
            onClick={() => setMode("create")}
          ><Plus className="icon" aria-hidden="true" />{t("modelMappings.addGroup")}</Button>
        )}
      />

      {groups.length === 0 ? (
        <EmptyState
          icon={<GitFork />}
          title={t("modelMappings.emptyTitle")}
          description={t("modelMappings.emptyHelp")}
          action={(
            <Button
              variant="primary"
              disabled={readOnly || pending !== null}
              onClick={() => setMode("create")}
            >
              <Plus className="icon" aria-hidden="true" />{t("modelMappings.addGroup")}
            </Button>
          )}
        />
      ) : (
        <div className="mapping-workspace">
          <section className="mapping-group-list" aria-label={t("modelMappings.groups")}>
            <div className="mapping-group-list-heading">
              <span>{t("modelMappings.groups")}</span>
              <strong>{formatNumber(locale, groups.length)}</strong>
            </div>
            {groups.map((group) => {
              const active = group.id === selected?.id;
              return (
                <button
                  key={group.id}
                  className={cx("mapping-group-item", active && "mapping-group-item-active")}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedId(group.id)}
                >
                  <span className="mapping-group-icon"><Braces aria-hidden="true" /></span>
                  <span>
                    <strong>{group.name}</strong>
                    <small>{t("modelMappings.groupSummary", {
                      rules: group.rules.length,
                      providers: group.providerIds.length
                    })}</small>
                  </span>
                  {active ? <Check aria-hidden="true" /> : null}
                </button>
              );
            })}
          </section>

          {selected ? (
            <section className="mapping-detail" aria-labelledby="mapping-detail-title">
              <header className="mapping-detail-header">
                <div>
                  <span>{t("modelMappings.exactMatch")}</span>
                  <h2 id="mapping-detail-title">{selected.name}</h2>
                  <p>{t("modelMappings.updatedAt", { value: formatDate(locale, selected.updatedAt) })}</p>
                </div>
                <div className="mapping-detail-actions">
                  <Button
                    disabled={readOnly || pending !== null}
                    onClick={() => setMode("edit")}
                  ><Pencil className="icon" aria-hidden="true" />{t("common.edit")}</Button>
                  <Button
                    variant="danger"
                    disabled={readOnly || pending !== null || assignedProviders.length > 0}
                    onClick={() => setMode("delete")}
                  ><Trash2 className="icon" aria-hidden="true" />{t("common.delete")}</Button>
                </div>
              </header>
              {runningPoolLocked ? (
                <Notice title={t("modelMappings.runningTitle")} tone="info">
                  <p>{t("modelMappings.runningHelp")}</p>
                </Notice>
              ) : null}
              <div className="mapping-assignment-strip">
                <div>
                  <span>{t("modelMappings.assignedProviders")}</span>
                  <strong>{formatNumber(locale, assignedProviders.length)}</strong>
                </div>
                <div className="mapping-provider-tags">
                  {assignedProviders.length > 0
                    ? assignedProviders.map((provider) => (
                        <StatusBadge key={provider.id} tone="neutral">{provider.name}</StatusBadge>
                      ))
                    : <span>{t("modelMappings.unassigned")}</span>}
                </div>
                <p>{t("modelMappings.unmatchedPassthrough")}</p>
              </div>
              <div className="mapping-rules-table-wrap table-scroll">
                <table className="mapping-rules-table">
                  <thead>
                    <tr>
                      <th>{t("modelMappings.sourceModel")}</th>
                      <th aria-label={t("modelMappings.direction")} />
                      <th>{t("modelMappings.targetModel")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.rules.map((rule) => (
                      <tr key={rule.sourceModel}>
                        <td><code>{rule.sourceModel}</code></td>
                        <td><ArrowRight aria-hidden="true" /></td>
                        <td><code>{rule.targetModel}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      )}

      <Modal
        open={mode === "create"}
        title={t("modelMappings.createTitle")}
        description={t("modelMappings.formHelp")}
        onClose={close}
        t={t}
        size="large"
        footer={(
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" form="model-mapping-create-form" busy={pending === "model-mapping-create"}>
              {t("modelMappings.saveCreate")}
            </Button>
          </>
        )}
      >
        {mode === "create" ? (
          <MappingForm
            formId="model-mapping-create-form"
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
        title={t("modelMappings.editTitle")}
        description={selected?.name}
        onClose={close}
        t={t}
        size="large"
        footer={(
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" form="model-mapping-edit-form" busy={pending === `model-mapping-update-${selected?.id ?? ""}`}>
              {t("common.save")}
            </Button>
          </>
        )}
      >
        {mode === "edit" && selected ? (
          <MappingForm
            formId="model-mapping-edit-form"
            group={selected}
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
        title={t("modelMappings.deleteTitle")}
        description={selected?.name}
        onClose={close}
        t={t}
        size="small"
        footer={(
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              busy={pending === `model-mapping-delete-${selected?.id ?? ""}`}
              onClick={async () => {
                if (selected && await onDelete(selected.id)) close();
              }}
            >{t("common.delete")}</Button>
          </>
        )}
      >
        <Notice title={selected?.name ?? t("modelMappings.deleteTitle")} tone="warning">
          <p>{t("modelMappings.deleteHelp")}</p>
        </Notice>
      </Modal>
    </div>
  );
}
