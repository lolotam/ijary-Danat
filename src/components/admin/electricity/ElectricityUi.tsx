import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { meterOwnershipTone, activeTone } from "@/lib/statusTone";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import type {
  ElectricityChargeStatus,
  ElectricityMeterOwnership,
} from "@/integrations/supabase/database.types";

export function ElectricityField({
  label,
  error,
  required,
  children,
}: {
  label: string;
  error?: string;
  /** Renders the red asterisk. Note the sibling `ElectricityFilter` has no such
   *  prop on purpose — an asterisk on a filter claims a search box is
   *  mandatory. */
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label required={required}>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function ElectricityFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
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

export function OwnershipBadge({ ownership }: { ownership: ElectricityMeterOwnership }) {
  const { t } = useI18n();
  return (
    <Badge variant={meterOwnershipTone(ownership)}>{t(`electricity.ownership.${ownership}`)}</Badge>
  );
}

export function ChargeStatusBadge({ status }: { status: ElectricityChargeStatus }) {
  const { t } = useI18n();
  const variant =
    status === "cancelled"
      ? "destructive"
      : status === "draft"
        ? "secondary"
        : status === "paid"
          ? "default"
          : "outline";
  return <Badge variant={variant}>{t(`electricity.status.${status}`)}</Badge>;
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useI18n();
  return (
    <Badge variant={activeTone(active)}>
      {active ? t("electricity.active") : t("electricity.inactive")}
    </Badge>
  );
}
