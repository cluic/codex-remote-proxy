import {
  KeyRound,
  Pencil,
  Plus,
  Power,
  Trash2
} from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useRef,
  useState
} from "react";

import { formatDate, type Translator } from "../i18n";
import type {
  AccessKey,
  AccessKeyInput,
  AccessKeyPatch,
  Locale
} from "../types";
import {
  Button,
  Field,
  FormError,
  IconButton,
  Modal,
  Panel,
  PanelHeader,
  StatusBadge
} from "./Primitives";

type AccessKeysPanelProps = {
  locale: Locale;
  t: Translator;
  accessKeys: AccessKey[];
  readOnly: boolean;
  pending: string | null;
  onCreate: (input: AccessKeyInput) => Promise<boolean>;
  onUpdate: (id: string, patch: AccessKeyPatch) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
};

function clearSecret(
  inputRef: RefObject<HTMLInputElement | null>,
  value: string,
  setValue: (value: string) => void
): string {
  const secret = inputRef.current?.value ?? value;
  setValue("");
  if (inputRef.current) inputRef.current.value = "";
  return secret;
}

function generatedSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `crp_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

function localDateTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function keyStatus(key: AccessKey): "active" | "disabled" | "expired" | "exhausted" {
  if (!key.enabled) return "disabled";
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return "expired";
  if (key.requestLimit !== null && key.requestCount >= key.requestLimit) return "exhausted";
  return "active";
}

function AccessKeyEditor({
  accessKey,
  t,
  busy,
  onClose,
  onCreate,
  onUpdate
}: {
  accessKey: AccessKey | null;
  t: Translator;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: AccessKeyInput) => Promise<boolean>;
  onUpdate: (id: string, patch: AccessKeyPatch) => Promise<boolean>;
}) {
  const editing = accessKey !== null;
  const initialExpiresAt = localDateTime(accessKey?.expiresAt ?? null);
  const initialRequestLimit = accessKey?.requestLimit === null || accessKey === null
    ? ""
    : String(accessKey.requestLimit);
  const [name, setName] = useState(accessKey?.name ?? "");
  const [secret, setSecret] = useState("");
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const [requestLimit, setRequestLimit] = useState(initialRequestLimit);
  const [error, setError] = useState<string | null>(null);
  const secretRef = useRef<HTMLInputElement>(null);

  const close = () => {
    clearSecret(secretRef, secret, setSecret);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const submittedSecret = clearSecret(secretRef, secret, setSecret);
    setError(null);
    const normalizedName = name.trim();
    const submittedSecretBytes = new TextEncoder().encode(submittedSecret).length;
    const parsedLimit = requestLimit.trim() === "" ? null : Number(requestLimit);
    let normalizedExpiry: string | null = null;
    if (expiresAt) {
      const timestamp = Date.parse(expiresAt);
      const expiryChanged = !editing || expiresAt !== initialExpiresAt;
      if (!Number.isFinite(timestamp) || (expiryChanged && timestamp <= Date.now())) {
        setError(t("accessKeys.expiryInvalid"));
        return;
      }
      normalizedExpiry = expiryChanged
        ? new Date(timestamp).toISOString()
        : accessKey?.expiresAt ?? null;
    }
    if (normalizedName !== name || name.length === 0 || [...name].length > 100
      || (parsedLimit !== null
        && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1_000_000_000_000))
      || (!editing && (submittedSecretBytes < 16 || submittedSecretBytes > 512
        || !/^[\x21-\x7e]+$/.test(submittedSecret)))) {
      setError(t("accessKeys.formInvalid"));
      return;
    }
    let complete;
    if (accessKey !== null) {
      const patch: AccessKeyPatch = {};
      if (name !== accessKey.name) patch.name = name;
      if (expiresAt !== initialExpiresAt) patch.expiresAt = normalizedExpiry;
      if (requestLimit !== initialRequestLimit) patch.requestLimit = parsedLimit;
      if (Object.keys(patch).length === 0) {
        close();
        return;
      }
      complete = await onUpdate(accessKey.id, patch);
    } else {
      complete = await onCreate({
        name,
        secret: submittedSecret,
        expiresAt: normalizedExpiry,
        requestLimit: parsedLimit
      });
    }
    if (complete) close();
    else setError(t("accessKeys.saveFailed"));
  };

  return (
    <Modal
      open
      title={t(editing ? "accessKeys.editTitle" : "accessKeys.createTitle")}
      description={t(editing ? "accessKeys.editDescription" : "accessKeys.createDescription")}
      onClose={close}
      t={t}
      size="small"
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>{t("common.cancel")}</Button>
          <span className="modal-footer-spacer" />
          <Button variant="primary" busy={busy} form="access-key-form" type="submit">
            {t(editing ? "common.save" : "accessKeys.add")}
          </Button>
        </>
      )}
    >
      <form id="access-key-form" className="access-key-form" onSubmit={submit} noValidate>
        {error ? <FormError>{error}</FormError> : null}
        <Field
          autoFocus
          id="access-key-name"
          name="name"
          label={t("accessKeys.name")}
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          required
        />
        {!editing ? (
          <div className="access-key-secret-row">
            <Field
              ref={secretRef}
              id="access-key-secret"
              name="secret"
              label={t("accessKeys.value")}
              help={t("accessKeys.valueHelp")}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              required
            />
            <div className="access-key-generate-slot">
              <span className="field-label" aria-hidden="true">&nbsp;</span>
              <Button
                className="access-key-generate"
                onClick={() => {
                  const next = generatedSecret();
                  setSecret(next);
                  if (secretRef.current) secretRef.current.value = next;
                }}
              >{t("accessKeys.generate")}</Button>
            </div>
          </div>
        ) : null}
        <div className="access-key-constraints">
          <Field
            id="access-key-expires"
            name="expiresAt"
            label={t("accessKeys.expiresAt")}
            help={t("accessKeys.optional")}
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
          <Field
            id="access-key-limit"
            name="requestLimit"
            label={t("accessKeys.requestLimit")}
            help={t("accessKeys.optional")}
            type="number"
            min={1}
            max={1_000_000_000_000}
            step={1}
            value={requestLimit}
            onChange={(event) => setRequestLimit(event.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}

export function AccessKeysPanel({
  locale,
  t,
  accessKeys,
  readOnly,
  pending,
  onCreate,
  onUpdate,
  onDelete
}: AccessKeysPanelProps) {
  const [editor, setEditor] = useState<AccessKey | "create" | null>(null);
  const [deleting, setDeleting] = useState<AccessKey | null>(null);
  const busy = pending !== null;

  return (
    <>
      <Panel className="access-keys-panel">
        <PanelHeader
          title={t("accessKeys.title")}
          description={t("accessKeys.description")}
          action={(
            <Button
              variant="primary"
              disabled={readOnly || busy}
              onClick={() => setEditor("create")}
            >
              <Plus aria-hidden="true" />
              {t("accessKeys.add")}
            </Button>
          )}
        />
        {accessKeys.length === 0 ? (
          <div className="access-key-empty">
            <KeyRound aria-hidden="true" />
            <div>
              <strong>{t("accessKeys.empty")}</strong>
              <span>{t("accessKeys.emptyHelp")}</span>
            </div>
          </div>
        ) : (
          <div className="access-key-table-wrap">
            <table className="access-key-table">
              <caption className="visually-hidden">{t("accessKeys.title")}</caption>
              <thead>
                <tr>
                  <th>{t("accessKeys.key")}</th>
                  <th>{t("accessKeys.status")}</th>
                  <th>{t("accessKeys.usage")}</th>
                  <th>{t("accessKeys.expiresAt")}</th>
                  <th>{t("accessKeys.lastUsed")}</th>
                  <th><span className="visually-hidden">{t("common.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {accessKeys.map((accessKey) => {
                  const status = keyStatus(accessKey);
                  const tone = status === "active" ? "success"
                    : status === "disabled" ? "neutral" : "warning";
                  return (
                    <tr key={accessKey.id}>
                      <th scope="row">
                        <strong>{accessKey.name}</strong>
                        <code>{accessKey.keyHint}</code>
                      </th>
                      <td><StatusBadge tone={tone}>{t(`accessKeys.status.${status}`)}</StatusBadge></td>
                      <td>{accessKey.requestCount.toLocaleString(locale)} / {accessKey.requestLimit === null
                        ? t("accessKeys.unlimited")
                        : accessKey.requestLimit.toLocaleString(locale)}</td>
                      <td>{formatDate(locale, accessKey.expiresAt, true)}</td>
                      <td>{formatDate(locale, accessKey.lastUsedAt, true)}</td>
                      <td>
                        <div className="access-key-actions">
                          <IconButton
                            label={t(accessKey.enabled ? "accessKeys.disable" : "accessKeys.enable")}
                            disabled={readOnly || busy}
                            onClick={() => void onUpdate(accessKey.id, { enabled: !accessKey.enabled })}
                          ><Power aria-hidden="true" /></IconButton>
                          <IconButton
                            label={t("common.edit")}
                            disabled={readOnly || busy}
                            onClick={() => setEditor(accessKey)}
                          ><Pencil aria-hidden="true" /></IconButton>
                          <IconButton
                            label={t("common.delete")}
                            disabled={readOnly || busy}
                            onClick={() => setDeleting(accessKey)}
                          ><Trash2 aria-hidden="true" /></IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {editor !== null ? (
        <AccessKeyEditor
          key={editor === "create" ? "create" : editor.id}
          accessKey={editor === "create" ? null : editor}
          t={t}
          busy={busy}
          onClose={() => setEditor(null)}
          onCreate={onCreate}
          onUpdate={onUpdate}
        />
      ) : null}

      <Modal
        open={deleting !== null}
        title={t("accessKeys.deleteTitle")}
        description={deleting ? t("accessKeys.deleteDescription", { name: deleting.name }) : undefined}
        onClose={() => setDeleting(null)}
        t={t}
        size="small"
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </Button>
            <span className="modal-footer-spacer" />
            <Button
              variant="danger"
              busy={busy}
              onClick={() => {
                if (!deleting) return;
                void onDelete(deleting.id).then((complete) => {
                  if (complete) setDeleting(null);
                });
              }}
            >{t("common.delete")}</Button>
          </>
        )}
      >
        <p>{t("accessKeys.deleteWarning")}</p>
      </Modal>
    </>
  );
}
