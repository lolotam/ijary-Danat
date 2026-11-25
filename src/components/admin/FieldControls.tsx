import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";

/** حقل نموذج: تسمية، علامة إلزامية اختيارية، ورسالة خطأ. */
export function Field({
  label,
  error,
  required,
  children,
}: {
  label: string;
  error?: string;
  /** Renders the red asterisk. `FilterSelect` below deliberately has no such
   *  prop — the filter bar is not a form. */
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label required={required}>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * قائمة تصفية بخيار «الكل» قيمته "all".
 *
 * Distinct from `FilterSelect` in `components/admin/FilterSelect.tsx`, which
 * uses "" for "any" and needs an `id`. The expenses and deposits screens
 * filter on "all"; moving them onto that one would change their filter values,
 * so this pair keeps its own vocabulary in one place instead of two (audit M15).
 */
export function AllFilterSelect({
  value,
  label,
  options,
  onChange,
}: {
  value: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("common.all")}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
