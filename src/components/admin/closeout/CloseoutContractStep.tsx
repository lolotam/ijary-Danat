import type { UseFormReturn } from "react-hook-form";

import { Badge } from "@/components/ui/badge";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { FormattedDate } from "@/components/ui/formatted-date";
import { Input } from "@/components/ui/input";
import { LtrText } from "@/components/ui/ltr-text";
import { useI18n } from "@/i18n/provider";
import type { CloseoutInput } from "@/lib/closeoutSchemas";
import { formatKwd } from "@/lib/money";
import { contractStateTone } from "@/lib/statusTone";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import type { Contract } from "@/hooks/useContracts";
import type { Tenant } from "@/hooks/useTenants";

/**
 * الخطوة 1: بيانات العقد والتأمين المحتجز وتاريخ الإخلاء.
 */
export function CloseoutContractStep({
  contract,
  tenant,
  unitName,
  depositHeld,
  form,
}: {
  contract: Contract;
  tenant: Tenant | undefined;
  unitName: string;
  depositHeld: number | undefined;
  form: UseFormReturn<CloseoutInput>;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("closeout.step.1")}</h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">{t("common.code")}</dt>
          <dd className="font-mono text-sm">
            <LtrText>{contract.code}</LtrText>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{t("contracts.tenant")}</dt>
          <dd>{tenant ? tenantDisplayName(tenant, locale) : "—"}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{t("contracts.unit")}</dt>
          <dd>{unitName}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{t("contracts.state")}</dt>
          <dd>
            <Badge variant={contractStateTone(contract.state)}>
              {t(`contractState.${contract.state}`)}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{t("closeout.depositHeld")}</dt>
          <dd>
            <LtrText>{formatKwd(depositHeld ?? Number(contract.deposit), locale)}</LtrText>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{t("contracts.period")}</dt>
          <dd className="text-sm">
            <FormattedDate value={contract.start_date} /> —{" "}
            <FormattedDate value={contract.end_date} />
          </dd>
        </div>
      </dl>
      <FormField
        control={form.control}
        name="moveOutDate"
        render={({ field }) => (
          <FormItem className="max-w-xs">
            <FormLabel required>{t("closeout.moveOutDate")}</FormLabel>
            <FormControl>
              <Input type="date" {...field} value={field.value ?? ""} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
