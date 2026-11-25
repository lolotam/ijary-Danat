import type { ContractExtraChargesFieldLabels } from "@/components/admin/contracts/ContractExtraChargesField";
import type { ContractUnitsFieldLabels } from "@/components/admin/ContractUnitsField";
import type { ContractIncreaseSectionLabels } from "@/components/admin/contracts/ContractIncreaseSection";

/** دالة الترجمة كما يمرّرها `useI18n`. */
type Translate = (key: string) => string;

/**
 * نصوص حقول الوحدات في نموذج العقد.
 *
 * The three field components below each take a `labels` object, and assembling
 * them inline cost `ContractFormDialog` about forty lines of `t()` calls in the
 * middle of its JSX — enough to push it past this repository's 500-600 line
 * ceiling on its own. Gathering them here also puts every key the form needs in
 * one place, which is where a missing translation is visible.
 */
export function contractUnitsLabels(t: Translate): ContractUnitsFieldLabels {
  return {
    properties: t("contracts.properties"),
    units: t("contracts.units"),
    noProperties: t("contracts.noProperties"),
    noUnits: t("contracts.noUnitsForProperties"),
    selectPropertiesFirst: t("contracts.selectPropertiesFirst"),
    amount: t("contracts.monthlyAmount"),
    occupied: t("contracts.unitOccupied"),
  };
}

/** نصوص حقل المصروفات الشهرية الإضافية. */
export function contractExtraChargesLabels(t: Translate): ContractExtraChargesFieldLabels {
  return {
    heading: t("contracts.extraCharges"),
    description: t("contracts.extraChargesHint"),
    category: t("expenses.category"),
    amount: t("common.amount"),
    add: t("contracts.addExtraCharge"),
    remove: t("common.delete"),
    noCategories: t("contracts.noExpenseCategories"),
    selectCategory: t("contracts.selectExpenseCategory"),
  };
}

/** نصوص ملخّص إجمالي الفاتورة الشهرية في نهاية النموذج. */
export function contractMonthlyTotalLabels(t: Translate) {
  return {
    heading: t("contracts.monthlyInvoiceTotal"),
    rent: t("contracts.rentSubtotal"),
    total: t("common.total"),
  };
}

/**
 * نصوص قسم زيادة الإيجار.
 *
 * `percentCap` is not here: the dialog translates the Zod message key itself.
 */
export function contractIncreaseLabels(t: Translate): ContractIncreaseSectionLabels {
  return {
    title: t("contracts.increase.title"),
    enable: t("contracts.increase.enable"),
    afterYears: t("contracts.increase.afterYears"),
    type: t("contracts.increase.type"),
    percent: t("contracts.increase.percent"),
    fixed: t("contracts.increase.fixed"),
    value: t("contracts.increase.value"),
    locked: t("contracts.increase.locked"),
    effectiveFrom: t("contracts.increase.effectiveFrom"),
  };
}
