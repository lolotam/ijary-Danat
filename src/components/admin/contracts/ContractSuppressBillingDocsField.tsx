import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/provider";

/**
 * يعرض مفتاح إيقاف إرسال مستندات الفوترة للمستأجر على هذا العقد.
 */
export function ContractSuppressBillingDocsField({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="sm:col-span-2 lg:col-span-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-3">
      <div className="space-y-1">
        <Label
          htmlFor="contract-suppress-billing-docs"
          className="cursor-pointer text-sm font-medium"
        >
          {t("contracts.suppressBillingDocs")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("contracts.suppressBillingDocsHint")}</p>
      </div>
      <Switch
        id="contract-suppress-billing-docs"
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
