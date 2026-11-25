# Spec: Fix Missing i18n Keys Across Admin Routes

**Status:** Approved · **Implemented in:** this commit
**Scope:** `src/i18n/dictionary.ts` + 6 admin route files + 1 component

## Problem

`src/i18n/dictionary.ts` defines `t()` as:

```ts
export function t(locale: Locale, key: string): string {
  return dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
}
```

When a key is missing from both the active locale and the default (`ar`) dictionary, `t()` returns the **raw key string**. End users therefore see literal strings like `invoices.total`, `common.state`, `contracts.startDate` in production UI.

A second compounding bug exists across the admin routes: the defensive pattern `t("some.key") ?? "fallback"` is **dead code**. Because `t()` always returns a `string` (never `null` or `undefined`), the `??` operator never fires — the developer's intended English fallback never reaches the user. As a result, even lines that _looked_ safe were silently rendering raw keys.

A third, unrelated bug was found on the tenant detail page: payment `method` and `status` enum values were rendered as raw strings (`bank_transfer`, `confirmed`) instead of being translated via the existing `paymentMethod.*` / `paymentStatus.*` keys.

## Scope (files touched)

- `src/i18n/dictionary.ts` — add 24 missing keys × 2 locales
- `src/routes/admin.tenants.$id.tsx` — reuse existing date keys, strip dead `??`, fix raw enum rendering
- `src/routes/admin.properties.$id.tsx` — strip dead `??` fallbacks
- `src/routes/admin.units.$id.tsx` — strip dead `??` fallbacks
- `src/routes/admin.settings.users.tsx` — strip dead `??` fallbacks
- `src/routes/admin.settings.notifications.tsx` — strip dead `??` fallbacks
- `src/components/admin/BulkDeleteBar.tsx` — strip dead `??` fallback

## Design Decisions

1. **`contracts.startDate` / `contracts.endDate` are NOT added as new keys.** Near-duplicate keys already exist: `contracts.start` (= "تاريخ البداية" / "Start date") and `contracts.end` (= "تاريخ النهاية" / "End date"). The tenant detail page JSX switches to the existing keys instead. This avoids dictionary bloat.
2. **`units.type` is NOT added.** `common.type` already exists with the same meaning ("النوع" / "Type"). The unit detail page JSX switches to `common.type`.
3. **All `t(key) ?? "fallback"` dead-code patterns are removed.** Once the underlying key exists, the fallback is unreachable and misleading. Removing it makes the code honest and surfaces future missing-key bugs visually.
4. **No change to the `t()` function signature or return type.** Returning the raw key on miss is the intended loud failure mode for untranslatATED keys; we fix the data, not the signal.

## Inventory — 24 Keys Added

| #   | Key                      | AR                   | EN                 |
| --- | ------------------------ | -------------------- | ------------------ |
| 1   | `common.notFound`        | غير موجود            | Not found          |
| 2   | `common.back`            | رجوع                 | Back               |
| 3   | `common.print`           | طباعة                | Print              |
| 4   | `common.location`        | الموقع               | Location           |
| 5   | `common.summary`         | ملخص                 | Summary            |
| 6   | `common.state`           | الحالة               | State              |
| 7   | `units.occupied`         | مؤجر                 | Occupied           |
| 8   | `units.vacant`           | شاغر                 | Vacant             |
| 9   | `units.totalRent`        | إجمالي الإيجار (د.ك) | Total rent (KWD)   |
| 10  | `units.rent`             | الإيجار              | Rent               |
| 11  | `units.noActiveContract` | لا يوجد عقد نشط      | No active contract |
| 12  | `contracts.active`       | العقد النشط          | Active contract    |
| 13  | `contracts.period`       | المدة                | Period             |
| 14  | `contracts.monthly`      | القيمة الشهرية       | Monthly            |
| 15  | `contracts.state`        | حالة العقد           | Contract state     |
| 16  | `contracts.rent`         | الإيجار الشهري       | Monthly rent       |
| 17  | `tenants.outstanding`    | المبلغ المستحق       | Outstanding        |
| 18  | `tenants.paidTotal`      | إجمالي المدفوع       | Total paid         |
| 19  | `tenants.currentLease`   | العقد الحالي         | Current lease      |
| 20  | `tenants.noLease`        | لا يوجد عقد نشط.     | No active lease.   |
| 21  | `invoices.period`        | الفترة               | Period             |
| 22  | `invoices.total`         | الإجمالي             | Total              |
| 23  | `payments.amount`        | المبلغ               | Amount             |
| 24  | `notifications.send`     | إرسال رسالة          | Send message       |

## Code Changes Beyond the Dictionary

### `admin.tenants.$id.tsx`

- Lines 201, 307: `t("contracts.startDate")` → `t("contracts.start")`
- Lines 202, 308: `t("contracts.endDate")` → `t("contracts.end")`
- Lines 61, 80, 89, 94, 115, 125, 159, 170, 186, 210, 218–220, 234, 235, 237, 238, 272–274: strip `?? "..."` dead fallbacks
- Line 283: `{p.method}` → `{t(\`paymentMethod.${p.method}\`)}`
- Line 286: `{p.status}` → `{t(\`paymentStatus.${p.status}\`)}`

### `admin.properties.$id.tsx`

- Lines 50, 64, 72, 103, 111, 114–118, 127, 138–143: strip `?? "..."` dead fallbacks
- Where `units.type` was used: switch to `common.type`

### `admin.units.$id.tsx`

- Lines 60, 76, 84, 99, 103, 117, 130, 137, 152, 158, 164, 172–174, 186–191, 221–225, 256–260: strip `?? "..."` dead fallbacks
- Where `units.type` was used: switch to `common.type`

### `admin.settings.users.tsx`

- Lines 487, 491, 507, 524, 597, 600, 627, 668: strip `?? "..."` dead fallbacks

### `admin.settings.notifications.tsx`

- Lines 645, 668: strip `?? "..."` dead fallbacks

### `components/admin/BulkDeleteBar.tsx`

- Line 87: strip `?? "..."` dead fallback

## Verification

- `bun run typecheck`
- `bun run lint`
- Manual: load `/admin/tenants/$id`, `/admin/properties/$id`, `/admin/units/$id` in AR and EN — confirm no raw keys
- Manual: payment method/status badges on tenant detail render translated
- Grep confirms zero remaining `t("...") ??` patterns in `src/routes/` and `src/components/`

## Out of Scope

- The earlier plan to also filter the `/admin/contracts` tenant dropdown by `lifecycle = active` is a **separate change** tracked independently. This spec covers i18n only.
