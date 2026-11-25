import type {
  UnitStatus,
  UnitType,
  TenantLifecycle,
  TenantCategory,
  ContractState,
  ElectricityMeterOwnership,
  InvoiceState,
  LocaleCode,
  ReportFrequency,
} from "@/integrations/supabase/database.types";

export type BadgeTone =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info"
  | "violet"
  | "indigo"
  | "pink"
  | "teal"
  | "orange"
  | "neutral";

/**
 * تنسيق شارة "متأخر" المشتركة بين جدول المستأجرين وجدول العقود.
 *
 * Both tables answer the same question — is this lease in arrears — and the
 * badge has to look identical on each or an operator reads them as two
 * different states. Kept here, beside the tones, rather than exported from one
 * table's cells file into the other's.
 */
export const OVERDUE_BADGE_CLASS = "animate-pulse ring-2 ring-red-400/60";

export function unitStatusTone(status: UnitStatus): BadgeTone {
  switch (status) {
    case "available":
      return "success";
    case "occupied":
      return "info";
    case "reserved":
      return "warning";
    case "under_maintenance":
      return "orange";
    case "vacant":
    case "archived":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * ألوان شارات أنواع الوحدات المضافة من الإعدادات.
 *
 * Unit type is free text after migration 103, so no switch can enumerate the
 * values. Hashing the value keeps the promise the seeds make — a type is a
 * category, and each category is its own colour — and keeps that colour stable
 * across renders and reloads, which a random pick would not.
 */
const FREE_TEXT_UNIT_TYPE_TONES: readonly BadgeTone[] = [
  "info",
  "violet",
  "indigo",
  "teal",
  "orange",
  "pink",
  "success",
  "warning",
];

/**
 * يختار لوناً ثابتاً لأي قيمة نصية اعتماداً على محتواها.
 *
 * djb2 rather than a sum of char codes. A sum ignores position, so short
 * catalogue values collide easily — "kiosk" and "mezzanine" landed on the same
 * colour, which is the one thing this function exists to avoid.
 *
 * Two details here were each found by a failing test, not by reasoning:
 *
 * - `Math.imul`, because plain `hash * 33` leaves float64 integer range after a
 *   few characters and the low bits turn to noise.
 * - `>>> 8`, because djb2's low bits barely mix. Multiplying by 33 leaves the
 *   bottom three bits of the previous hash untouched, so `% 8` was reading
 *   little more than an XOR of the input's low bits — and put every free-text
 *   value on one colour, which is worse than the grey it replaced. The middle
 *   bits are well mixed; across a sample of twelve plausible type names they
 *   use all eight tones.
 *
 * With eight tones, nine distinct types must collide somewhere; this only
 * spreads the realistic handful well, it does not promise uniqueness.
 */
function toneFromValue(value: string): BadgeTone {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 33) ^ value.charCodeAt(index)) >>> 0;
  }
  return FREE_TEXT_UNIT_TYPE_TONES[(hash >>> 8) % FREE_TEXT_UNIT_TYPE_TONES.length];
}

/**
 * ألوان المدد غير المعتادة: سبعة ألوان، وسبعة عدد أوّلي لا يقاسم الاثني عشر.
 *
 * Seven, and prime, on purpose. `toneFromValue`'s djb2 is built for words and
 * collapses on two-character numeric strings — it put 1, 2, 3, 4, 6 and 9 on
 * one colour and 12, 18, 24, 30 and 36 on another, which is the clustering this
 * whole feature exists to remove. A duration is already a number, so the number
 * itself is the index.
 *
 * The length has to be coprime with 12: lease terms are overwhelmingly multiples
 * of a year, and any palette sharing a factor with 12 folds them onto a handful
 * of colours — over eight tones every multiple of 12 landed on just two.
 */
const UNUSUAL_DURATION_TONES: readonly BadgeTone[] = [
  "success",
  "warning",
  "info",
  "violet",
  "indigo",
  "pink",
  "teal",
];

/** لون ثابت لأي عدد أشهر خارج المدد المعدودة. */
function toneFromDuration(months: number): BadgeTone {
  // A negative or fractional count is not a lease term this app writes, but `%`
  // on a negative is negative in JS and would index past the end of the array.
  const index = Math.abs(Math.trunc(months)) % UNUSUAL_DURATION_TONES.length;
  return UNUSUAL_DURATION_TONES[index];
}

/**
 * ألوان مدد العقود الشائعة: كل مدة فئة قائمة بذاتها، لا نقطة على مقياس.
 *
 * A lease term is read as a category, not a magnitude — an operator scanning
 * the contracts table is looking for "the five-year ones", not for longer
 * versus shorter. So the common terms are enumerated rather than bucketed, and
 * each gets a colour of its own that stays the same on every screen.
 *
 * The listed terms are distinct by construction, which is the part that
 * matters. An unusual duration falls back to `toneFromDuration` and may land on
 * a listed term's colour: seven tones cannot colour every integer apart, and
 * pretending otherwise would mean inventing colours nobody can tell apart.
 *
 * `neutral` is deliberately unused here: it is this codebase's "no value"
 * colour, and a contract with a real term is never that.
 */
export function contractDurationTone(months: number): BadgeTone {
  switch (months) {
    case 6:
      return "success";
    case 12:
      return "info";
    case 24:
      return "violet";
    case 36:
      return "indigo";
    case 60:
      return "teal";
    case 120:
      return "orange";
    case 180:
      return "pink";
    default:
      return toneFromDuration(months);
  }
}

/**
 * Unit types are categories, not a scale — every type gets its own colour.
 *
 * The seven seeds keep the colours operators already recognise; anything the
 * owner adds in Settings → Lists gets a stable colour of its own rather than
 * the grey every unknown value used to share.
 */
export function unitTypeTone(type: UnitType | string): BadgeTone {
  switch (type) {
    case "apartment":
      return "info";
    case "shop":
      return "violet";
    case "office":
      return "indigo";
    case "commercial":
      return "teal";
    case "warehouse":
      return "orange";
    case "villa":
      return "pink";
    case "other":
      return "neutral";
    default:
      return toneFromValue(type);
  }
}

export function tenantLifecycleTone(lifecycle: TenantLifecycle): BadgeTone {
  switch (lifecycle) {
    case "active":
      return "success";
    case "inactive":
      return "neutral";
    case "contract_ended":
      return "warning";
    case "blocked":
      return "destructive";
    default:
      return "neutral";
  }
}

/**
 * Icon colour for the block/unblock control, describing the tenant's CURRENT
 * state rather than what clicking will do: red while blocked, green while not.
 *
 * Class strings rather than a `BadgeTone` because the control is an icon, not a
 * badge, and a keyed record rather than a function of a boolean so the call
 * sites read `…blocked` instead of `…(true)`. It lives here so the tenants
 * table and the tenant detail page cannot drift apart — the same tenant must
 * not read red in one place and green in the other.
 */
export const tenantBlockedIconClass = {
  blocked: "text-destructive",
  unblocked: "text-emerald-600 dark:text-emerald-400",
} as const;

export function tenantCategoryTone(category: TenantCategory): BadgeTone {
  switch (category) {
    case "standard":
      return "neutral";
    case "vip":
      return "warning";
    case "uncommitted":
      return "info";
    case "chronically_distressed":
      return "destructive";
    case "custom":
      return "violet";
    default:
      return "neutral";
  }
}

export function contractStateTone(state: ContractState): BadgeTone {
  switch (state) {
    case "active":
      return "success";
    case "draft":
      return "neutral";
    case "frozen":
      return "info";
    case "suspended":
      return "warning";
    case "expired":
      return "neutral";
    case "renewed":
      return "violet";
    case "terminated":
      return "destructive";
    default:
      return "neutral";
  }
}

/**
 * Colours match `InvoiceStatusBadge` in `components/shared/dashboardCards.tsx`
 * so an invoice reads the same on the dashboard and in the tenant table.
 */
export function invoiceStateTone(state: InvoiceState): BadgeTone {
  switch (state) {
    case "due":
      return "warning";
    case "overdue":
      return "destructive";
    case "paid":
      return "success";
    case "partially_paid":
      return "violet";
    case "cancelled":
      return "neutral";
    case "waived":
      return "neutral";
    default:
      return "neutral";
  }
}

export function paymentStatusTone(
  status: "pending" | "confirmed" | "cancelled" | "reversed",
): BadgeTone {
  switch (status) {
    case "pending":
      return "warning";
    case "confirmed":
      return "success";
    case "cancelled":
    case "reversed":
      return "destructive";
    default:
      return "neutral";
  }
}

export function closeoutStatusTone(status: "draft" | "completed" | "cancelled"): BadgeTone {
  switch (status) {
    case "draft":
      return "warning";
    case "completed":
      return "success";
    case "cancelled":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * Refund lifecycle tones for the close-out / refunds UI.
 *
 * `reversed` is deliberately `neutral`, NOT `destructive` — diverging from
 * `paymentStatusTone`. Destructive is reserved for danger (a reversed payment
 * is a problem); a completed refund reversal is a resolved correction.
 * Do not change paymentStatusTone to match.
 */
export function refundStatusTone(status: "draft" | "posted" | "voided" | "reversed"): BadgeTone {
  switch (status) {
    case "draft":
      return "warning";
    case "posted":
      return "success";
    case "voided":
    case "reversed":
      return "neutral";
    default:
      return "neutral";
  }
}

export function closeoutInvoiceActionTone(
  action: "leave" | "settle_from_deposit" | "write_off" | "cancel" | "mark_disputed",
): BadgeTone {
  switch (action) {
    case "leave":
      return "neutral";
    case "settle_from_deposit":
      return "info";
    case "write_off":
      return "orange";
    case "cancel":
      return "neutral";
    case "mark_disputed":
      return "warning";
    default:
      return "neutral";
  }
}

export function closeoutOutcomeTone(outcome: "keep_terminated" | "freeze" | "archive"): BadgeTone {
  switch (outcome) {
    case "keep_terminated":
      return "neutral";
    case "freeze":
      return "info";
    case "archive":
      return "violet";
    default:
      return "neutral";
  }
}

export function expenseStatusTone(status: "pending" | "approved" | "cancelled"): BadgeTone {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
      return "success";
    case "cancelled":
      return "destructive";
    default:
      return "neutral";
  }
}

export function reportFrequencyTone(frequency: ReportFrequency): BadgeTone {
  switch (frequency) {
    case "daily":
      return "orange";
    case "weekly":
      return "info";
    case "monthly":
      return "violet";
    case "yearly":
      return "teal";
    default:
      return "neutral";
  }
}

export function reportLocaleTone(locale: LocaleCode): BadgeTone {
  switch (locale) {
    case "ar":
      return "teal";
    case "en":
      return "indigo";
    default:
      return "neutral";
  }
}

export function activeTone(active: boolean): BadgeTone {
  return active ? "success" : "neutral";
}

export function meterOwnershipTone(ownership: ElectricityMeterOwnership): BadgeTone {
  switch (ownership) {
    case "company_owned":
      return "info";
    case "tenant_owned":
      return "neutral";
    default:
      return "neutral";
  }
}

const OPTION_TONES: BadgeTone[] = [
  "info",
  "violet",
  "indigo",
  "pink",
  "teal",
  "orange",
  "warning",
  "success",
  "neutral",
];

export function optionItemTone(value: string): BadgeTone {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % OPTION_TONES.length;
  return OPTION_TONES[index];
}
