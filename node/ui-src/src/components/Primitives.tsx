"use client";

import {
  AlertCircle,
  CheckCircle2,
  Info,
  LoaderCircle,
  TriangleAlert,
  X
} from "lucide-react";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useRef
} from "react";

import { ApiError } from "../api";
import type { Translator, TranslationKey } from "../i18n";
import { Button as BaseButton } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", busy = false, className, children, disabled, type = "button", ...props },
  ref
) {
  return (
    <BaseButton
      ref={ref}
      type={type}
      variant={variant === "primary"
        ? "default"
        : variant === "danger"
          ? "destructive"
          : variant}
      className={cx("button", `button-${variant}`, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <LoaderCircle className="icon spin" aria-hidden="true" /> : null}
      {children}
    </BaseButton>
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, className, type = "button", ...props },
  ref
) {
  return (
    <BaseButton
      ref={ref}
      type={type}
      variant="outline"
      size="icon-sm"
      className={cx("icon-button", className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </BaseButton>
  );
});

export function Panel({ children, className }: PropsWithChildren<{ className?: string }>) {
  return <section className={cx("panel", className)}>{children}</section>;
}

export function PanelHeader({
  title,
  description,
  action
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="panel-header">
      <div className="panel-heading-copy">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="panel-header-action">{action}</div> : null}
    </header>
  );
}

export function PageHeader({
  title,
  subtitle,
  action
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action ? <div className="page-header-actions">{action}</div> : null}
    </header>
  );
}

export function StatusBadge({
  children,
  tone = "neutral",
  icon = true
}: PropsWithChildren<{
  tone?: "success" | "warning" | "danger" | "neutral" | "info";
  icon?: boolean;
}>) {
  return (
    <span className={cx("status-badge", `status-${tone}`)}>
      {icon ? <span className="status-marker" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Notice({
  title,
  children,
  tone = "info",
  role
}: PropsWithChildren<{
  title: string;
  tone?: "info" | "success" | "warning" | "danger";
  role?: "alert" | "status";
}>) {
  const Icon = tone === "success"
    ? CheckCircle2
    : tone === "warning"
      ? TriangleAlert
      : tone === "danger"
        ? AlertCircle
        : Info;
  return (
    <section className={cx("notice", `notice-${tone}`)} role={role}>
      <Icon className="notice-icon" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <div className="notice-body">{children}</div>
      </div>
    </section>
  );
}

function errorCopy(error: ApiError): [TranslationKey, TranslationKey] {
  const code = error.code.toUpperCase();
  if (code.includes("AUTH") && code.startsWith("PROVIDER")) {
    return ["error.authTitle", "error.authAction"];
  }
  if (code.includes("TIMEOUT")) return ["error.timeoutTitle", "error.timeoutAction"];
  if (code === "PROVIDER_NOT_READY") return ["error.notReadyTitle", "error.notReadyAction"];
  if (code === "PROVIDER_ACTIVE") return ["error.activeTitle", "error.activeAction"];
  if (code.startsWith("CODEX_") || code.startsWith("MIGRATION_")) {
    return error.details.degraded === true || code.includes("DEGRADED")
      ? ["error.degradedTitle", "error.degradedAction"]
      : ["error.codexTitle", "error.codexAction"];
  }
  if (code.includes("INPUT") || code.includes("BODY_INVALID") || code.includes("VALIDATION")) {
    return ["error.inputTitle", "error.inputAction"];
  }
  if (code.startsWith("AUTH_")) return ["error.sessionTitle", "error.sessionAction"];
  if (error.details.degraded === true || error.details.committed === true || code.includes("DEGRADED")) {
    return ["error.degradedTitle", "error.degradedAction"];
  }
  return ["error.genericTitle", "error.genericAction"];
}

export function ErrorNotice({ error, t }: { error: ApiError; t: Translator }) {
  const [titleKey, actionKey] = errorCopy(error);
  const details = Object.entries(error.details);
  return (
    <Notice title={t(titleKey)} tone="danger" role="alert">
      <p>{t(actionKey)}</p>
      <details className="technical-details">
        <summary>{t("error.technical")}</summary>
        <dl>
          <div><dt>{t("error.code")}</dt><dd><code>{error.code}</code></dd></div>
          {error.requestId ? (
            <div><dt>{t("error.requestId")}</dt><dd><code>{error.requestId}</code></dd></div>
          ) : null}
          {details.map(([key, value]) => (
            <div key={key}><dt>{key}</dt><dd><code>{String(value)}</code></dd></div>
          ))}
        </dl>
      </details>
    </Notice>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  help?: string;
  error?: string;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, help, error, id, className, ...props },
  ref
) {
  const fieldId = id ?? props.name;
  const helpId = help && fieldId ? `${fieldId}-help` : undefined;
  const errorId = error && fieldId ? `${fieldId}-error` : undefined;
  return (
    <label className={cx("form-field", className)} htmlFor={fieldId}>
      <span className="field-label">{label}</span>
      <input
        ref={ref}
        id={fieldId}
        aria-describedby={[helpId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        {...props}
      />
      {help ? <span className="field-help" id={helpId}>{help}</span> : null}
      {error ? <span className="field-error" id={errorId}>{error}</span> : null}
    </label>
  );
});

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  help?: string;
};

export function SelectField({ label, help, id, children, className, ...props }: PropsWithChildren<SelectFieldProps>) {
  const fieldId = id ?? props.name;
  const helpId = help && fieldId ? `${fieldId}-help` : undefined;
  return (
    <label className={cx("form-field", className)} htmlFor={fieldId}>
      <span className="field-label">{label}</span>
      <select id={fieldId} aria-describedby={helpId} {...props}>{children}</select>
      {help ? <span className="field-help" id={helpId}>{help}</span> : null}
    </label>
  );
}

type TextareaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  help?: string;
  error?: string;
};

export function TextareaField({ label, help, error, id, className, ...props }: TextareaFieldProps) {
  const fieldId = id ?? props.name;
  const helpId = help && fieldId ? `${fieldId}-help` : undefined;
  const errorId = error && fieldId ? `${fieldId}-error` : undefined;
  return (
    <label className={cx("form-field", className)} htmlFor={fieldId}>
      <span className="field-label">{label}</span>
      <textarea
        id={fieldId}
        aria-describedby={[helpId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        {...props}
      />
      {help ? <span className="field-help" id={helpId}>{help}</span> : null}
      {error ? <span className="field-error" id={errorId}>{error}</span> : null}
    </label>
  );
}

export function FormError({ children }: PropsWithChildren) {
  return <p className="form-error" role="alert">{children}</p>;
}

type ModalProps = PropsWithChildren<{
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  size?: "small" | "medium" | "large";
  t: Translator;
}>;

export function Modal({
  open,
  title,
  description,
  onClose,
  footer,
  size = "medium",
  t,
  children
}: ModalProps) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
        else returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }}
    >
      <DialogContent
        className={cx("modal", `modal-${size}`)}
        initialFocus={() => document.querySelector<HTMLElement>("[data-slot='dialog-content'] [autofocus]")
          ?? document.querySelector<HTMLElement>("[data-slot='dialog-content'] input, [data-slot='dialog-content'] select, [data-slot='dialog-content'] textarea, [data-slot='dialog-content'] button")}
        finalFocus={() => returnFocusRef.current}
      >
      <div className="modal-frame">
        <header className="modal-header">
          <div>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </div>
          <DialogClose render={<IconButton label={t("a11y.closeDialog")}><X aria-hidden="true" /></IconButton>} />
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
      </DialogContent>
    </Dialog>
  );
}

export function DefinitionList({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="definition-list">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
