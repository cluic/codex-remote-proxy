import { useState } from "react";

import type { Translator } from "../i18n";
import { Field, SelectField } from "./Primitives";

const MANUAL_VALUE = "__crp_manual_model__";

type ModelPickerProps = {
  id: string;
  model: string;
  models: string[];
  disabled?: boolean;
  autoFocus?: boolean;
  t: Translator;
  onChange: (model: string) => void;
};

export function ModelPicker({
  id,
  model,
  models,
  disabled = false,
  autoFocus = false,
  t,
  onChange
}: ModelPickerProps) {
  const [manualRequested, setManualRequested] = useState(false);
  const manual = models.length === 0
    || manualRequested
    || model !== "" && !models.includes(model);

  if (models.length === 0) {
    return (
      <Field
        className="min-w-0"
        id={id}
        name="testModel"
        label={t("providers.testModel")}
        help={t("providers.manualModel")}
        value={model}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        spellCheck={false}
      />
    );
  }

  return (
    <div className="model-picker grid min-w-0 gap-3">
      <SelectField
        className="min-w-0"
        id={id}
        name="testModelCatalog"
        label={t("providers.testModel")}
        help={t("providers.catalogCount", { count: models.length })}
        value={manual ? MANUAL_VALUE : model}
        onChange={(event) => {
          if (event.target.value === MANUAL_VALUE) {
            setManualRequested(true);
            onChange("");
            return;
          }
          setManualRequested(false);
          onChange(event.target.value);
        }}
        disabled={disabled}
        autoFocus={autoFocus && !manual}
      >
        {models.map((item) => <option key={item} value={item}>{item}</option>)}
        <option value={MANUAL_VALUE}>{t("providers.manualModel")}</option>
      </SelectField>
      {manual ? (
        <Field
          className="min-w-0"
          id={`${id}-manual`}
          name="testModel"
          label={t("providers.manualModel")}
          value={model}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoFocus={autoFocus}
          spellCheck={false}
        />
      ) : null}
    </div>
  );
}
