import { useEffect } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useListDrivenOptions, useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { useI18n } from "@/i18n/provider";
import type { ContractState } from "@/integrations/supabase/database.types";
import { restoreTargetStatesFor } from "@/lib/contractLifecycle";

/**
 * حوار إعادة عقد مؤرشف إلى القوائم التشغيلية، مع اختيار الحالة التي يعود إليها.
 *
 * The target state is a field rather than a hidden copy of the contract's own
 * state, which is what it used to be. Since migration 211 an `expired` or
 * `terminated` contract counts as archived on its state alone, so passing that
 * state back cleared `archived_at`, left the row in the Archived tab, and still
 * toasted success — Codex round 8 on PR #209. `RESTORE_TARGET_STATES` is
 * therefore the ended states removed, and the operator says where the lease
 * lands.
 */
export function ContractRestoreDialog({
  contractEndDate,
  open,
  pending,
  reason,
  targetState,
  onOpenChange,
  onReasonChange,
  onTargetStateChange,
  onConfirm,
}: {
  /** The contract's end date, which decides whether `active` may be offered. */
  contractEndDate: string | null;
  open: boolean;
  pending: boolean;
  reason: string;
  targetState: ContractState;
  onOpenChange: (open: boolean) => void;
  onReasonChange: (reason: string) => void;
  onTargetStateChange: (state: ContractState) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  // The same catalogue the contracts form reads, narrowed to the states a
  // restore may land on, so an office rename of a state label shows here too.
  const targetStateOptions = useListDrivenOptions(
    "contract_states",
    restoreTargetStatesFor(contractEndDate),
    "contractState",
  );
  /**
   * `useListDrivenOptions` drops any state the office deactivated in
   * Settings > Lists, and the default is a constant that knows nothing about
   * that list. Deactivating `suspended` therefore left the trigger showing no
   * label while `confirmRestore` still submitted `suspended` — a restore to a
   * state the administrator had switched off, from a dialog that never showed
   * it. Codex round 2 on PR #210.
   *
   * The catalogue's own status has to be read as well, because
   * `useListDrivenOptions` deliberately falls back to every enum value while
   * the query is loading OR has failed — so the list would answer "yes, that
   * state is offered" for a state it has never actually seen, and the check
   * above would pass vacuously in exactly the two cases it exists for. Fail
   * closed: no confirmation until a catalogue has genuinely loaded. Codex
   * round 3 on PR #210.
   *
   * And loaded is not the same as current: `useOptionListItemsByCode` pins
   * `staleTime: 5 * 60 * 1000`, so a catalogue fetched before another
   * administrator deactivated the state stays `isSuccess` — and still lists it
   * — for five minutes. This dialog is mounted for the life of the page, so
   * opening it does not remount the hook and nothing would refetch. Asking on
   * open is what makes the answer about now rather than about whenever the page
   * was first painted. Codex round 4 on PR #210.
   */
  const catalogue = useOptionListItemsByCode("contract_states");
  const refetchCatalogue = catalogue.refetch;
  useEffect(() => {
    if (open) void refetchCatalogue();
  }, [open, refetchCatalogue]);
  const targetStateIsOffered =
    catalogue.isSuccess &&
    !catalogue.isFetching &&
    targetStateOptions.some((option) => option.value === targetState);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("archive.restoreTitle")}</DialogTitle>
          <DialogDescription>{t("archive.restoreDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label required htmlFor="restore-target-state">
            {t("archive.restoreTargetState")}
          </Label>
          <Select value={targetState} onValueChange={onTargetStateChange}>
            <SelectTrigger id="restore-target-state">
              <SelectValue placeholder={t("common.select")} />
            </SelectTrigger>
            <SelectContent>
              {targetStateOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {catalogue.isSuccess && !catalogue.isFetching
              ? t("archive.restoreTargetStateHint")
              : t("archive.restoreStatesUnavailable")}
          </p>
        </div>
        <div className="space-y-2">
          <Label required htmlFor="restore-reason">
            {t("archive.restoreReason")}
          </Label>
          <Textarea
            id="restore-reason"
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!reason.trim() || !targetStateIsOffered || pending}
            onClick={onConfirm}
          >
            {t("archive.restoreConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
