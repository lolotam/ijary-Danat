import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ANY_VALUE, fromAnyValue } from "@/lib/selectSentinel";

/**
 * قائمة تصفية واحدة: عنوان، خيار "الكل"، ثم الخيارات المتاحة.
 *
 * `value` is the filter's own vocabulary — "" for no filter — and the sentinel
 * swap happens here, so a bar never has to remember that Radix rejects an empty
 * item value. `id` is required rather than derived: a bar renders several of
 * these and every label needs a `htmlFor` that points at its own trigger.
 *
 * `icon` switches to the inline toolbar form: no visible label above the
 * trigger, the icon inside it, and the label kept as `aria-label`. A stacked
 * label in a toolbar of label-less controls (the invoices year select and theme
 * switcher) pushes the trigger half a row lower than its neighbours.
 */
export function FilterSelect({
  id,
  label,
  anyLabel,
  value,
  options,
  onChange,
  className = "w-[12rem]",
  icon,
}: {
  id: string;
  label: string;
  anyLabel: string;
  value: string;
  options: Array<{ value: string; label: ReactNode }>;
  onChange: (value: string) => void;
  className?: string;
  icon?: ReactNode;
}) {
  const select = (
    <Select value={value || ANY_VALUE} onValueChange={(next) => onChange(fromAnyValue(next))}>
      <SelectTrigger
        id={id}
        className={className}
        aria-label={icon ? label : undefined}
        title={icon ? label : undefined}
      >
        {icon ? (
          <div className="flex min-w-0 items-center gap-1.5 [&>span]:truncate">
            {icon}
            <SelectValue />
          </div>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY_VALUE}>{anyLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (icon) return select;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {select}
    </div>
  );
}
