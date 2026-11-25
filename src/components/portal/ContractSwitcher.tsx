import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePortalContractSelection } from "@/hooks/usePortalContractSelection";
import { usePortalContracts, type PortalContractOption } from "@/hooks/usePortalData";
import { useI18n } from "@/i18n/provider";
import { portalContractLabel, portalContractStatusKey } from "@/lib/portalContractLabel";
import { cn } from "@/lib/utils";

/**
 * قائمة اختيار العقد في بوابة المستأجر.
 *
 * Renders nothing while loading or when the tenant has zero contracts — a blank
 * control is worse than no control. A single contract still shows: the tenant
 * should see which lease they are looking at, not a mystery page.
 *
 * There is no "all contracts" entry. One contract is always selected, so every
 * page below reads as one lease rather than as a merged view the tenant has to
 * take apart themselves.
 *
 * `dir` is passed explicitly. Radix resolves direction through
 * `useDirection(dir)`, which falls back to the literal `"ltr"` when there is no
 * prop and no `DirectionProvider`, then stamps it onto the trigger — and an
 * explicit `dir="ltr"` attribute beats the `rtl` inherited from `<html>`, so
 * the label sat leftmost on an Arabic page. Root threads the value through
 * context, so this one prop also fixes the panel's alignment and the arrow-key
 * order. Same fix, same reason, as `components/ui/tabs.tsx`.
 */
export function ContractSwitcher({
  tenantId,
  className,
}: {
  tenantId: string | null;
  className?: string;
}) {
  const { t, dir } = useI18n();
  const contracts = usePortalContracts(tenantId);
  const { contractId, setContractId } = usePortalContractSelection(tenantId);

  if (contracts.isLoading || !contracts.data?.length) return null;

  /**
   * يبني عنوان الخيار من موضعه في القائمة المعروضة.
   *
   * The number is positional and display-only — it is never a key and never
   * reaches the URL, so re-ordering the list can never change what a link means.
   */
  const optionLabel = (contract: PortalContractOption, index: number) =>
    portalContractLabel(contract, index + 1, t(portalContractStatusKey(contract.state)));

  // A miss is rare but real: a background refetch that errors leaves the stale
  // list rendered while the selection hook sees a non-success query and holds
  // the raw `?contract=` value, which may not be in it.
  const selectedIndex = contracts.data.findIndex((contract) => contract.id === contractId);

  return (
    <div className={cn("min-w-0 max-w-full", className)}>
      <Select value={contractId ?? undefined} onValueChange={setContractId} dir={dir}>
        <SelectTrigger
          aria-label={t("portal.contract.select")}
          className="h-11 min-h-11 w-full min-w-0 max-w-full gap-2 border-[#d4af37]/40 bg-background font-semibold shadow-sm sm:w-auto sm:max-w-md"
        >
          <span className="shrink-0 text-muted-foreground">{t("portal.contract.label")}:</span>
          <SelectValue className="min-w-0 truncate">
            <span className="block min-w-0 truncate">
              {selectedIndex >= 0 ? optionLabel(contracts.data[selectedIndex], selectedIndex) : ""}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-w-[min(100vw-2rem,24rem)]">
          {contracts.data.map((contract, index) => (
            <SelectItem key={contract.id} value={contract.id} className="max-w-full">
              <span className="block truncate">{optionLabel(contract, index)}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
