import { useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";

import {
  resolveContractFormValues,
  type ContractExtraChargeValue,
  type ContractFormValues,
} from "@/lib/contractForm";

/** ما تعرفه الشاشة عن مصروفات العقد وقت فتح النموذج. */
export interface ExtraChargesQueryState {
  data: ContractExtraChargeValue[] | undefined;
  isSuccess: boolean;
  isError: boolean;
}

export interface ContractFormPrefillOptions {
  open: boolean;
  editing: Parameters<typeof resolveContractFormValues>[0];
  /** معرّف العقد قيد التعديل، أو null عند الإنشاء. */
  editingId: string | null;
  form: UseFormReturn<ContractFormValues>;
  extraCharges: ExtraChargesQueryState;
  onPrefilled: (values: ContractFormValues) => void;
}

/**
 * يملأ نموذج العقد عند فتحه، ويقول هل كانت مصروفاته معروفة حينها.
 *
 * Two failure modes this exists to close, both silent and both destructive
 * because `save_contract_with_units` reads an ABSENT `extra_charges` key as
 * "leave them alone" and an EMPTY array as "delete them all" (migration 166):
 *
 *   1. Prefilling before the charges arrive shows an empty list, and saving
 *      from there submits `[]`. Waiting on `isLoading` is not enough — when the
 *      query exhausts its retries, loading goes false while data stays
 *      undefined, which is the same empty form by another route.
 *   2. Prefilling on a genuine failure and then reading the query again at SAVE
 *      time. The retry may have succeeded in between, so a save-time check
 *      passes while the form still holds the `[]` it was filled with. What
 *      matters is what the form was filled FROM, which is why the answer is
 *      captured here and returned rather than re-derived later.
 *
 * The dialog still opens on a failed read; the payload simply omits the key.
 */
/** ما يقرّره الفحص قبل تعبئة النموذج. */
export interface PrefillDecision {
  /** هل تُملأ الحقول الآن. */
  prefill: boolean;
  /** هل كانت مصروفات العقد معروفة وقت التعبئة. */
  chargesAreKnown: boolean;
}

/**
 * يقرّر متى يُملأ النموذج وما إذا كانت مصروفات العقد معروفة حينها.
 *
 * Pure, and separate from the effect, because the two bugs it closes are both
 * about WHEN a value is read rather than what it is — and both are silent.
 * Extracted rather than rendered in a test for the same reason the rest of this
 * codebase extracts its hook logic: the decision is the thing worth pinning.
 */
export function prefillDecision(state: {
  open: boolean;
  isEditing: boolean;
  chargesLoaded: boolean;
  chargesFailed: boolean;
  /** المفتاح الذي مُلئ به النموذج سابقاً، أو null. */
  prefilledFor: string | null;
  key: string;
}): PrefillDecision {
  // A closed dialog decides nothing; the caller clears its marker instead.
  if (!state.open) return { prefill: false, chargesAreKnown: true };
  // Neither settled yet. Filling now would show an empty charge list that a
  // save then submits as `[]` — "delete them all" to migration 166.
  if (state.isEditing && !state.chargesLoaded && !state.chargesFailed) {
    return { prefill: false, chargesAreKnown: false };
  }
  // Already filled for this contract. Re-running on a refetch would discard
  // whatever has been typed since.
  if (state.prefilledFor === state.key) return { prefill: false, chargesAreKnown: true };
  // Captured NOW, not read again at save time: the query may retry and succeed
  // while this form still holds the empty list it was filled with.
  return { prefill: true, chargesAreKnown: !state.isEditing || state.chargesLoaded };
}

export function useContractFormPrefill({
  open,
  editing,
  editingId,
  form,
  extraCharges,
  onPrefilled,
}: ContractFormPrefillOptions): { chargesAreKnown: boolean } {
  // Which contract has already been prefilled. Without it, every refetch of the
  // charges query would reset the form and discard whatever has been typed.
  const prefilledForRef = useRef<string | null>(null);
  const [chargesAreKnown, setChargesAreKnown] = useState(true);

  useEffect(() => {
    if (!open) {
      prefilledForRef.current = null;
      return;
    }
    const key = editingId ?? "__new__";
    const decision = prefillDecision({
      open,
      isEditing: Boolean(editing),
      chargesLoaded: extraCharges.isSuccess,
      chargesFailed: extraCharges.isError,
      prefilledFor: prefilledForRef.current,
      key,
    });
    if (!decision.prefill) return;
    prefilledForRef.current = key;
    setChargesAreKnown(decision.chargesAreKnown);
    const values = resolveContractFormValues(editing, extraCharges.data ?? []);
    form.reset(values);
    onPrefilled(values);
  }, [
    open,
    editing,
    editingId,
    form,
    extraCharges.isSuccess,
    extraCharges.isError,
    extraCharges.data,
    onPrefilled,
  ]);

  return { chargesAreKnown };
}
