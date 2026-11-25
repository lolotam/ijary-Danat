import type { FieldPath, UseFormReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { FIELD_MAX_LENGTH, type ContractBuilderValues } from "@/lib/contractBuilder/schema";

export type BuilderFormProps = {
  form: UseFormReturn<ContractBuilderValues>;
  t: (key: string) => string;
};

/** يعرض أخطاء الحقول بجوار مدخلاتها حتى يمكن تصحيح المسودة قبل التنزيل. */
export function BuilderField({
  form,
  t,
  name,
  label,
  numeric = false,
  maxLength,
  type,
  inputMode,
}: BuilderFormProps & {
  name: FieldPath<ContractBuilderValues>;
  label: string;
  numeric?: boolean;
  maxLength?: number;
  type?: string;
  inputMode?: "tel" | "email" | "numeric";
}) {
  const error = form.getFieldState(name, form.formState).error;
  return (
    <label className="grid gap-1 text-sm" htmlFor={name}>
      {t(`contractBuilder.field.${label}`)}
      <Input
        id={name}
        type={type ?? (numeric ? "number" : "text")}
        step={numeric ? "any" : undefined}
        inputMode={inputMode}
        maxLength={
          numeric
            ? undefined
            : (maxLength ?? FIELD_MAX_LENGTH[label as keyof typeof FIELD_MAX_LENGTH])
        }
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${name}-error` : undefined}
        {...form.register(name, numeric ? { valueAsNumber: true } : {})}
      />
      {error && (
        <span id={`${name}-error`} className="text-destructive">
          {t("contractBuilder.invalidField")}
        </span>
      )}
    </label>
  );
}
