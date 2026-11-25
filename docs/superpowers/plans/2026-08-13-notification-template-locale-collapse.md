# Notification Template Locale Collapse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the 34 AR/EN `notification_templates` rows into 17 bilingual
rows, and offer in the manual/bulk message dialogs only templates a tenant may
receive *and* the generic sender can render.

**Architecture:** Two gates decide eligibility — audience (dynamic, from live
`cron_jobs.recipient_targets`) and renderability (static, the four types
`resolveTypeVariables` actually resolves). Both are pure functions in `src/lib/`,
so the dialogs filter with them and the two manual server functions *enforce*
with them. The schema change ships as two migrations across two PRs so no running
bundle ever names a template code that does not exist.

**Tech Stack:** TanStack Start (React 19), Bun, Vitest, self-hosted Supabase
(Postgres 17), Tailwind 4 + shadcn/ui, hand-written SQL migrations.

**Spec:** `docs/superpowers/specs/2026-08-13-notification-template-locale-collapse-design.md`.
Where this plan and the spec disagree, **the plan wins** — it is the later
document. The spec records reasoning; the plan records what to do.

## Global Constraints

- **Every task ends with `bun run lint && bun run typecheck && bun run test`
  passing**, not just a filtered test run. Baseline before this work: 178 files,
  1466 tests, all green. A task is not done if that number regresses
  unexplainably.
- **File ceiling 500–600 lines.** `admin.settings.notifications.tsx` is ~700 and
  shrinks here; do not grow it.
- **Every function gets a doc comment above it, leading with Arabic.** English
  may follow for the *why*. Comments explain why, never restate the next line.
- **`src/integrations/supabase/database.types.ts` is hand-maintained.** Never run
  `gen:types` over it. It currently has **no imports at all** — keep it that way
  (see Task 2).
- **`src/routeTree.gen.ts` is generated.** Never edit.
- **Both migrations are wrapped in explicit `begin`/`commit`.** Neither the
  runbook nor `scripts/test-db.sh` passes `--single-transaction`.
- **Never operate on a `-ar`/`-en` regex** in migrations or UI filters. The schema
  has never reserved those suffixes; an admin-created `lease-renewal-ar` is
  legitimate. Use the explicit list of 34.
- **Never force-push, rebase, amend, or squash** commits already on `main`.
- **`bun run format` rewrites all markdown** — revert `AGENTS.md`, `CLAUDE.md`
  and `docs/**` before staging.
- **The offered set is exactly four types:** `due_reminder`, `overdue_reminder`,
  `receipt`, `contract_expiry`. Changing it is a spec change, not a judgement
  call.

## Out of scope — do not fix

Four pre-existing defects are recorded in the spec and deliberately excluded.
Touching them fails review: `sendCompanyInfo`'s hardcoded nonexistent
`template_code`; `resolveReceiptVariables` keeping an unrelated payment on a
pinned-contract miss; `resolveContractExpiryVariables` falling back to an ended
contract; `missing` placeholders never blocking a send.

## The 17 legacy stems

Every one has an `-ar` and an `-en` row; 34 codes total.

```
due-reminder, overdue-reminder, receipt, contract-expiry, invoice-document,
deposit-confirmation, user-credentials, payment-admin-alert, contact-inquiry,
maintenance-request, refund-recorded, contract-created, contract-ended,
contract-closeout, contract-restored, invoice-written-off, invoice-disputed
```

---

# PR 1 — migration only

Branch from `main`. Contains migration 124 and nothing else.

### Task 1: Migration 124 — additive unsuffixed codes

**Files:**
- Create: `db/migrations/124_template_unsuffixed_codes.sql`

**Interfaces:**
- Produces: for each of the 17 stems, a row whose `code` is the stem, carrying
  the `-ar` row's content verbatim. `locale` gains default `'ar'`.

**There is no SQL test for this task.** `scripts/test-db.sh` applies every
migration in numeric order before any test runs, so once 125 exists the
intermediate state is unobservable. Do not fake it by emulating migrations in
test code. Phase 1 is verified against production in the release sequence.

- [ ] **Step 1: Write the migration**

```sql
-- ---------------------------------------------------------------------------
-- 124 — unsuffixed template codes (phase 1 of 2)
-- ---------------------------------------------------------------------------
--
-- Additive only. Afterwards BOTH `receipt-ar` and `receipt` resolve, so the
-- running (old) bundle and the incoming (new) bundle are simultaneously correct.
--
-- Why two phases: every sender also writes `notifications.template_code`, an FK
-- onto this table. Renaming in one step would make the old bundle's INSERT fail
-- for the minutes before the container swaps, silently dropping notifications —
-- receipts included.
--
-- Everything below is keyed on an EXPLICIT stem list, never a '-(ar|en)$' regex:
-- the schema has never reserved those suffixes, so an admin-created
-- `lease-renewal-ar` is legitimate and must not be touched.

begin;

create temporary table legacy_stem(stem text primary key) on commit drop;
insert into legacy_stem(stem) values
  ('due-reminder'), ('overdue-reminder'), ('receipt'), ('contract-expiry'),
  ('invoice-document'), ('deposit-confirmation'), ('user-credentials'),
  ('payment-admin-alert'), ('contact-inquiry'), ('maintenance-request'),
  ('refund-recorded'), ('contract-created'), ('contract-ended'),
  ('contract-closeout'), ('contract-restored'), ('invoice-written-off'),
  ('invoice-disputed');

do $$
declare
  problem text;
begin
  -- Both siblings must exist. An inner join would pass vacuously on a missing
  -- one, and phase 2 would then delete a row whose alias was never created.
  select string_agg(s.stem, ', ') into problem
    from legacy_stem s
   where (select count(*) from public.notification_templates t
           where t.code in (s.stem || '-ar', s.stem || '-en')) <> 2;
  if problem is not null then
    raise exception 'Incomplete AR/EN pair for: %', problem;
  end if;

  -- Every field that survives the merge must already agree, or the collapse
  -- picks a silent winner. The four content columns are included because they
  -- are what is actually collapsed.
  select string_agg(s.stem, ', ') into problem
    from legacy_stem s
    join public.notification_templates a on a.code = s.stem || '-ar'
    join public.notification_templates b on b.code = s.stem || '-en'
   where a.type is distinct from b.type
      or a.channel is distinct from b.channel
      or a.is_active is distinct from b.is_active
      or a.allow_freeform is distinct from b.allow_freeform
      or a.subject_ar is distinct from b.subject_ar
      or a.subject_en is distinct from b.subject_en
      or a.body_ar is distinct from b.body_ar
      or a.body_en is distinct from b.body_en
      or a.provider_template_name is distinct from b.provider_template_name
      or a.provider_language_code is distinct from b.provider_language_code
      or a.provider_param_keys is distinct from b.provider_param_keys
      or a.twilio_content_sid is distinct from b.twilio_content_sid
      or a.twilio_variable_keys is distinct from b.twilio_variable_keys;
  if problem is not null then
    raise exception 'AR/EN pair disagrees on a retained field for: %', problem;
  end if;

  -- A pre-existing row already holding the target code is preserved by
  -- `on conflict do nothing`, so it must be identical on EVERY retained field —
  -- not just type/channel/body. Otherwise the new app silently loads a row with
  -- different subjects, is_active, or provider binding.
  select string_agg(s.stem, ', ') into problem
    from legacy_stem s
    join public.notification_templates x on x.code = s.stem
    join public.notification_templates a on a.code = s.stem || '-ar'
   where x.type is distinct from a.type
      or x.channel is distinct from a.channel
      or x.is_active is distinct from a.is_active
      or x.allow_freeform is distinct from a.allow_freeform
      or x.subject_ar is distinct from a.subject_ar
      or x.subject_en is distinct from a.subject_en
      or x.body_ar is distinct from a.body_ar
      or x.body_en is distinct from a.body_en
      or x.provider_template_name is distinct from a.provider_template_name
      or x.provider_language_code is distinct from a.provider_language_code
      or x.provider_param_keys is distinct from a.provider_param_keys
      or x.twilio_content_sid is distinct from a.twilio_content_sid
      or x.twilio_variable_keys is distinct from a.twilio_variable_keys;
  if problem is not null then
    raise exception 'Target code already exists with different content for: %', problem;
  end if;
end $$;

-- Two rows per type become one, so uniqueness can no longer include locale.
alter table public.notification_templates
  drop constraint if exists notification_templates_type_channel_locale_key;

-- `locale` is NOT NULL with no default. The new bundle stops sending it and
-- could not CREATE a template between its deploy and migration 125.
alter table public.notification_templates
  alter column locale set default 'ar';

insert into public.notification_templates (
  code, type, channel, locale, is_active, allow_freeform,
  subject_ar, subject_en, body_ar, body_en,
  provider_template_name, provider_language_code, provider_param_keys,
  twilio_content_sid, twilio_variable_keys
)
select
  s.stem, a.type, a.channel, a.locale, a.is_active, a.allow_freeform,
  a.subject_ar, a.subject_en, a.body_ar, a.body_en,
  a.provider_template_name, a.provider_language_code, a.provider_param_keys,
  a.twilio_content_sid, a.twilio_variable_keys
  from legacy_stem s
  join public.notification_templates a on a.code = s.stem || '-ar'
on conflict (code) do nothing;

commit;
```

The insert copies the provider columns deliberately: **migration 58 seeds
`provider_template_name = 'contract_expiry_notice'` and `provider_param_keys` on
both contract-expiry rows**, so these are not always null and must survive.

- [ ] **Step 2: Verify against a clean database**

```bash
bun run test:db && bun run test:sql
```

Expected: PASS with **no test file changes**. Every existing sqltest still
asserts suffixed codes, which still exist after 124. If any fails, 124 is wrong.

- [ ] **Step 3: Prove all three guards fire**

Run each against the test database, then restore. Use a transaction you roll
back, or rebuild with `bun run test:db` afterwards.

```sql
-- (a) pair mismatch
begin;
  update notification_templates set is_active = false where code = 'receipt-ar';
  -- re-apply 124 → 'AR/EN pair disagrees on a retained field for: receipt'
rollback;

-- (b) missing sibling
begin;
  delete from notification_templates where code = 'receipt-en';
  -- re-apply 124 → 'Incomplete AR/EN pair for: receipt'
rollback;

-- (c) target collision — the case the earlier draft never exercised
begin;
  insert into notification_templates (code, type, channel, locale, subject_ar)
    values ('receipt', 'receipt', 'email', 'ar', 'different subject');
  -- re-apply 124 → 'Target code already exists with different content for: receipt'
rollback;
```

- [ ] **Step 4: Full gates, then commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run test:sql
git add db/migrations/124_template_unsuffixed_codes.sql
git commit -m "feat(db): add unsuffixed template codes alongside the AR/EN pair"
```

---

# PR 2 — application changes + cleanup migration

**Branch from `main` after PR 1 has merged**, so migration 124 is present and
`bun run test:db` builds a database where the unsuffixed codes exist.

### Task 2: Runtime notification-type tuple

**Files:**
- Modify: `src/integrations/supabase/database.types.ts:107-127`
- Create: `src/lib/notificationTypes.test.ts`

**Interfaces:**
- Produces: `NOTIFICATION_TYPES: readonly NotificationType[]`, exported from
  `database.types.ts`, iterable at runtime. `NotificationType` keeps its name.

**Put the tuple in `database.types.ts` itself.** That file currently has **zero
imports** and is consumed as a types-only module by ~70 files. Making it import
from `src/lib/` would introduce the first runtime import into a module that is
otherwise erasable, risking a cycle and changing its emit.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/notificationTypes.test.ts
import { describe, expect, test } from "vitest";

import { NOTIFICATION_TYPES } from "@/integrations/supabase/database.types";

describe("NOTIFICATION_TYPES", () => {
  // Exact set, not a length check: swapping one valid member for another
  // preserves the length and would slip through.
  test("is exactly the twenty product types", () => {
    expect([...NOTIFICATION_TYPES].sort()).toEqual(
      [
        "company_info", "contact_inquiry", "contract_closeout", "contract_created",
        "contract_ended", "contract_expiry", "contract_restored", "deposit_confirmation",
        "document_send", "due_reminder", "invoice_disputed", "invoice_written_off",
        "maintenance_request", "manual_message", "overdue_reminder",
        "payment_admin_alert", "receipt", "refund_recorded", "scheduled_report",
        "user_credentials",
      ].sort(),
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test -- notificationTypes
```
Expected: FAIL — `NOTIFICATION_TYPES` is not exported.

- [ ] **Step 3: Replace the union with a tuple in `database.types.ts`**

```ts
/**
 * أنواع الإشعارات المتاحة، كمصفوفة قابلة للتكرار وقت التشغيل.
 *
 * The union is derived from this tuple rather than written twice. The template
 * editor could not iterate an erased union, so it kept a hand-written list that
 * had drifted to 11 of the 20 types — rendering a blank dropdown for the rest.
 */
export const NOTIFICATION_TYPES = [
  "due_reminder", "overdue_reminder", "receipt", "contract_expiry",
  "scheduled_report", "document_send", "manual_message", "deposit_confirmation",
  "user_credentials", "payment_admin_alert", "company_info", "contact_inquiry",
  "maintenance_request", "refund_recorded", "contract_created", "contract_ended",
  "contract_closeout", "contract_restored", "invoice_written_off",
  "invoice_disputed",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
```

- [ ] **Step 4: Full gates, then commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/integrations/supabase/database.types.ts src/lib/notificationTypes.test.ts
git commit -m "refactor(types): derive NotificationType from a runtime tuple"
```

`typecheck` is the real gate here — it must stay clean across all ~70 importers.

---

### Task 3: The legacy-code list

**Files:**
- Create: `src/lib/legacyTemplateCodes.ts`, `src/lib/legacyTemplateCodes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/legacyTemplateCodes.test.ts
import { describe, expect, test } from "vitest";

import { LEGACY_TEMPLATE_CODES, LEGACY_TEMPLATE_STEMS } from "@/lib/legacyTemplateCodes";

describe("legacy template codes", () => {
  test("derives both suffixed codes from every stem", () => {
    expect(LEGACY_TEMPLATE_STEMS).toContain("receipt");
    expect(LEGACY_TEMPLATE_CODES).toContain("receipt-ar");
    expect(LEGACY_TEMPLATE_CODES).toContain("receipt-en");
    expect(LEGACY_TEMPLATE_CODES).toHaveLength(LEGACY_TEMPLATE_STEMS.length * 2);
  });

  // The list must not accidentally cover an admin-created code.
  test("does not include an arbitrary -ar code", () => {
    expect(LEGACY_TEMPLATE_CODES).not.toContain("lease-renewal-ar");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
bun run test -- legacyTemplateCodes
```

- [ ] **Step 3: Implement**

```ts
/**
 * رموز القوالب القديمة ذات اللاحقة اللغوية، التي تحذفها الترحيلة 125.
 *
 * Used to hide these rows in the window between migrations 124 and 125, when the
 * table briefly holds all three variants of every template.
 *
 * An explicit list, deliberately not a `-ar`/`-en` pattern: the schema has never
 * reserved those suffixes, so an admin-created `lease-renewal-ar` is legitimate
 * and must survive both the filter and the migrations.
 */
export const LEGACY_TEMPLATE_STEMS = [
  "due-reminder", "overdue-reminder", "receipt", "contract-expiry",
  "invoice-document", "deposit-confirmation", "user-credentials",
  "payment-admin-alert", "contact-inquiry", "maintenance-request",
  "refund-recorded", "contract-created", "contract-ended", "contract-closeout",
  "contract-restored", "invoice-written-off", "invoice-disputed",
] as const;

export const LEGACY_TEMPLATE_CODES: readonly string[] = LEGACY_TEMPLATE_STEMS.flatMap(
  (stem) => [`${stem}-ar`, `${stem}-en`],
);
```

- [ ] **Step 4: Full gates, then commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/lib/legacyTemplateCodes.ts src/lib/legacyTemplateCodes.test.ts
git commit -m "feat(notifications): name the legacy template codes explicitly"
```

---

### Task 4: The two eligibility gates

**Files:**
- Create: `src/lib/templateEligibility.ts`, `src/lib/templateEligibility.test.ts`

**Interfaces:**
- Produces:
  - `TEMPLATE_TENANT_ELIGIBILITY: Record<NotificationType, TenantEligibility>`
  - `MANUALLY_RENDERABLE_TYPES: ReadonlySet<NotificationType>`
  - `isTemplateOfferable(type, workflows): boolean` where
    `workflows: ReadonlyArray<{ key: string; recipient_targets: string[] | null }>`
    — compatible with `useCronJobs`'s `Tables<"cron_jobs">[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/templateEligibility.test.ts
import { describe, expect, test } from "vitest";

import { NOTIFICATION_TYPES } from "@/integrations/supabase/database.types";
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";
import {
  MANUALLY_RENDERABLE_TYPES,
  TEMPLATE_TENANT_ELIGIBILITY,
  isTemplateOfferable,
} from "@/lib/templateEligibility";

const workflows = [
  { key: "overdue-reminders", recipient_targets: ["tenant"] },
  { key: "payment-succeeded", recipient_targets: ["admin", "company", "tenant"] },
  { key: "manual-payment-invoice", recipient_targets: ["admin", "company", "tenant"] },
  { key: "contract-expiry", recipient_targets: ["admin", "company", "tenant"] },
  { key: "deposit-confirmed", recipient_targets: ["admin", "company"] },
  { key: "user-credentials-tenant", recipient_targets: ["company", "tenant"] },
];

describe("TEMPLATE_TENANT_ELIGIBILITY", () => {
  // The whole map, not a sample. Asserting four entries lets sixteen wrong
  // mappings through, and a wrong mapping exposes a staff template to tenants.
  test("matches the spec exactly, for all twenty types", () => {
    expect(TEMPLATE_TENANT_ELIGIBILITY).toEqual({
      due_reminder: { mode: "always" },
      manual_message: { mode: "always" },
      company_info: { mode: "always" },
      document_send: { mode: "always" },
      payment_admin_alert: { mode: "never" },
      scheduled_report: { mode: "never" },
      overdue_reminder: { mode: "viaWorkflows", keys: ["overdue-reminders"] },
      receipt: { mode: "viaWorkflows", keys: ["payment-succeeded", "manual-payment-invoice"] },
      contract_expiry: { mode: "viaWorkflows", keys: ["contract-expiry"] },
      user_credentials: {
        mode: "viaWorkflows",
        keys: ["user-credentials-tenant", "user-credentials-managerial"],
      },
      deposit_confirmation: { mode: "viaWorkflows", keys: ["deposit-confirmed"] },
      contact_inquiry: { mode: "viaWorkflows", keys: ["contact-inquiry-received"] },
      maintenance_request: { mode: "viaWorkflows", keys: ["maintenance-request-created"] },
      refund_recorded: { mode: "viaWorkflows", keys: ["refund-recorded"] },
      contract_created: { mode: "viaWorkflows", keys: ["contract-created"] },
      contract_ended: { mode: "viaWorkflows", keys: ["contract-ended"] },
      contract_closeout: { mode: "viaWorkflows", keys: ["contract-closeout-completed"] },
      contract_restored: { mode: "viaWorkflows", keys: ["contract-restored"] },
      invoice_written_off: { mode: "viaWorkflows", keys: ["invoice-written-off"] },
      invoice_disputed: { mode: "viaWorkflows", keys: ["invoice-disputed"] },
    });
  });

  test("is total over NOTIFICATION_TYPES", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(TEMPLATE_TENANT_ELIGIBILITY[type]).toBeDefined();
    }
  });

  test("every viaWorkflows key exists in WORKFLOW_CATALOG", () => {
    for (const entry of Object.values(TEMPLATE_TENANT_ELIGIBILITY)) {
      if (entry.mode !== "viaWorkflows") continue;
      for (const key of entry.keys) expect(WORKFLOW_CATALOG[key]).toBeDefined();
    }
  });
});

describe("MANUALLY_RENDERABLE_TYPES", () => {
  test("holds exactly the four resolver-backed types", () => {
    expect([...MANUALLY_RENDERABLE_TYPES].sort()).toEqual(
      ["contract_expiry", "due_reminder", "overdue_reminder", "receipt"].sort(),
    );
  });
});

describe("isTemplateOfferable", () => {
  test("offers exactly the four types", () => {
    const offered = NOTIFICATION_TYPES.filter((t) => isTemplateOfferable(t, workflows));
    expect([...offered].sort()).toEqual(
      ["contract_expiry", "due_reminder", "overdue_reminder", "receipt"].sort(),
    );
  });

  // payment-succeeded carries `tenant` for its sibling receipt template.
  test("payment_admin_alert stays out despite its workflow's tenant pill", () => {
    expect(isTemplateOfferable("payment_admin_alert", workflows)).toBe(false);
  });

  test("document_send and user_credentials fail gate 2 despite passing gate 1", () => {
    expect(TEMPLATE_TENANT_ELIGIBILITY.document_send.mode).toBe("always");
    expect(isTemplateOfferable("document_send", workflows)).toBe(false);
    expect(isTemplateOfferable("user_credentials", workflows)).toBe(false);
  });

  test("unticking the tenant pill removes the template", () => {
    const without = workflows.map((w) =>
      w.key === "contract-expiry" ? { ...w, recipient_targets: ["admin"] } : w,
    );
    expect(isTemplateOfferable("contract_expiry", workflows)).toBe(true);
    expect(isTemplateOfferable("contract_expiry", without)).toBe(false);
  });

  test("always types are offered with no cron_jobs rows at all", () => {
    expect(isTemplateOfferable("due_reminder", [])).toBe(true);
  });

  test("an unknown workflow key is ignored, not treated as eligible", () => {
    expect(
      isTemplateOfferable("receipt", [{ key: "not-a-workflow", recipient_targets: ["tenant"] }]),
    ).toBe(false);
  });
});
```

**Do not write a test that greps `resolveTemplateVariables.ts` for
`type === "…"`.** An earlier draft did; it tests formatting and private
structure, breaks on a rename or a switch statement with no behaviour change,
and `Bun.file` is not typed in this project (`tsconfig.json` includes only
`vite/client`), so it would fail `bun run typecheck`. The behavioural parity
check belongs in Task 5 instead, where `resolveTypeVariables` is already under
test.

- [ ] **Step 2: Run and watch it fail**

```bash
bun run test -- templateEligibility
```

- [ ] **Step 3: Implement**

```ts
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";
import type { NotificationType } from "@/integrations/supabase/database.types";

export type TenantEligibility =
  | { mode: "always" }
  | { mode: "never" }
  | { mode: "viaWorkflows"; keys: string[] };

/**
 * البوابة الأولى: هل يجوز أن يصل هذا النوع إلى المستأجر أصلًا؟
 *
 * `never` is not the same as an empty key list. `payment-succeeded` carries the
 * `tenant` pill on behalf of its sibling `receipt` template, so deriving
 * payment_admin_alert's audience from its workflow would leak a staff-only alert
 * into the tenant dropdown. `manual-payment-invoice` splits the same way.
 */
export const TEMPLATE_TENANT_ELIGIBILITY: Record<NotificationType, TenantEligibility> = {
  due_reminder: { mode: "always" },
  manual_message: { mode: "always" },
  company_info: { mode: "always" },
  document_send: { mode: "always" },
  payment_admin_alert: { mode: "never" },
  scheduled_report: { mode: "never" },
  overdue_reminder: { mode: "viaWorkflows", keys: ["overdue-reminders"] },
  receipt: { mode: "viaWorkflows", keys: ["payment-succeeded", "manual-payment-invoice"] },
  contract_expiry: { mode: "viaWorkflows", keys: ["contract-expiry"] },
  user_credentials: {
    mode: "viaWorkflows",
    keys: ["user-credentials-tenant", "user-credentials-managerial"],
  },
  deposit_confirmation: { mode: "viaWorkflows", keys: ["deposit-confirmed"] },
  contact_inquiry: { mode: "viaWorkflows", keys: ["contact-inquiry-received"] },
  maintenance_request: { mode: "viaWorkflows", keys: ["maintenance-request-created"] },
  refund_recorded: { mode: "viaWorkflows", keys: ["refund-recorded"] },
  contract_created: { mode: "viaWorkflows", keys: ["contract-created"] },
  contract_ended: { mode: "viaWorkflows", keys: ["contract-ended"] },
  contract_closeout: { mode: "viaWorkflows", keys: ["contract-closeout-completed"] },
  contract_restored: { mode: "viaWorkflows", keys: ["contract-restored"] },
  invoice_written_off: { mode: "viaWorkflows", keys: ["invoice-written-off"] },
  invoice_disputed: { mode: "viaWorkflows", keys: ["invoice-disputed"] },
};

/**
 * البوابة الثانية: هل يستطيع مسار الإرسال اليدوي العام تكوين هذه الرسالة فعلًا؟
 *
 * Exactly the types `resolveTypeVariables` resolves — nothing else has a
 * resolver, so every other type renders its placeholders empty.
 *
 * `manual_message` is NOT here: free text is the `templateCode === null` branch,
 * which picks resolvers from the placeholders present. A stored manual_message
 * row takes the template branch and gets `{}`. Free text is unaffected — both
 * dialogs keep their separate "free" option.
 *
 * `company_info` is NOT here either: it is a dedicated single-recipient action
 * with its own server fn, and the bulk dialog has no special case for it, so a
 * shared set would make it bulk-selectable and send stored copy with neither the
 * generated body nor the PDF.
 */
export const MANUALLY_RENDERABLE_TYPES: ReadonlySet<NotificationType> = new Set([
  "overdue_reminder",
  "due_reminder",
  "receipt",
  "contract_expiry",
]);

/**
 * يقرّر ما إذا كان القالب معروضًا للإرسال اليدوي، بتطبيق البوابتين معًا.
 *
 * Shared by the dialogs and by sendNotification/sendBulkNotification. A filtered
 * dropdown is presentation; the server functions are the control.
 */
export function isTemplateOfferable(
  type: NotificationType,
  workflows: ReadonlyArray<{ key: string; recipient_targets: string[] | null }>,
): boolean {
  if (!MANUALLY_RENDERABLE_TYPES.has(type)) return false;
  const audience = TEMPLATE_TENANT_ELIGIBILITY[type];
  if (audience.mode === "never") return false;
  if (audience.mode === "always") return true;
  return audience.keys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(WORKFLOW_CATALOG, key)) return false;
    const row = workflows.find((w) => w.key === key);
    return (row?.recipient_targets ?? []).includes("tenant");
  });
}
```

- [ ] **Step 4: Full gates, then commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/lib/templateEligibility.ts src/lib/templateEligibility.test.ts
git commit -m "feat(notifications): add the two template eligibility gates"
```

---

### Task 5: Retire the locale machinery

**This task comes before the UI work on purpose.** Every unsuffixed alias created
by 124 carries `locale = 'ar'`, so while the old guard
(`template.locale !== resolvedLocale`) is still in place, an English send of an
alias is rejected by `sendNotification` and silently skipped by
`sendBulkNotification`. Wiring the dropdowns first would produce a visibly broken
intermediate state.

**Files:**
- Modify: `src/fns/resolveTemplateVariables.ts:126-129, 170-226`
- Modify: `src/fns/sendNotification.ts:76`, `src/fns/sendBulkNotification.ts:168`
- Modify: the 15 production files in Step 4

- [ ] **Step 1: Write the failing tests**

Add to `src/fns/resolveTemplateVariables.test.ts`, which already declares
`TENANT_ID` — use it; do **not** introduce a bare `tenantId`.

```ts
test("a missing code still yields unavailableReason", async () => {
  const result = await buildFinalMessage({ tenantId: TENANT_ID, templateCode: "no-such-code" });
  expect(result.unavailableReason).toMatch(/no active/i);
  expect(result.templateCode).toBeNull();
});

test("an inactive code still yields unavailableReason", async () => {
  // Fixture must return is_active: false for this code.
  const result = await buildFinalMessage({ tenantId: TENANT_ID, templateCode: "inactive-code" });
  expect(result.unavailableReason).toMatch(/no active/i);
});
```

**The builder alone is not enough.** `unavailableReason` is a contract between
`buildFinalMessage` and three consumers, and a consumer can discard it while the
two tests above stay green. Add one observable assertion per consumer:

```ts
// 1. Preview — src/components/admin/MessagePreviewPanel.test.tsx
// The panel must render its "unavailable" warning, NOT an empty message body.
test("renders the unavailable warning when the template is gone", async () => {
  // buildFinalMessage mocked to return unavailableReason set, subject/body empty.
  render(<MessagePreviewPanel {...props} templateCode="no-such-code" />);
  expect(await screen.findByText(/unavailable|غير متاح/i)).toBeInTheDocument();
});

// 2. Single send — src/fns/sendNotification.test.ts
// Must refuse, and must not enqueue anything.
test("refuses to send when the template is unavailable", async () => {
  await expect(
    callSend({
      tenantId: TENANT_ID, type: "manual_message", channel: "email",
      templateCode: "no-such-code", locale: null,
      subject: null, body: null, contractId: null,
    }),
  ).rejects.toThrow();
  expect(lastInsert).toBeNull();
});

// 3. Bulk send — src/fns/sendBulkNotification.test.ts
// Must skip the affected tenant with a reason, not queue an empty message.
test("skips a tenant whose template is unavailable, with a reason", async () => {
  const result = await callSendBulk({ /* two tenants, unavailable template */ });
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0].reason).toMatch(/unavailable|no active/i);
});
```

Match the bulk result shape to whatever `sendBulkNotification` actually returns —
read it first. If it has no `skipped` channel today, assert instead that no
notification row was inserted for that tenant. Do not invent a return shape.

Finally, the gate-2 parity check, also in `resolveTemplateVariables.test.ts`:

```ts
// Behavioural parity with MANUALLY_RENDERABLE_TYPES — replaces the source-grep
// test an earlier draft proposed. Asserted through the PUBLIC buildFinalMessage,
// so no production symbol is exported purely for testability and the test
// survives any refactor of resolveTypeVariables' internals.
test("a gate-2 type resolves its variables; a non-gate-2 type does not", async () => {
  // receipt is in MANUALLY_RENDERABLE_TYPES: its placeholders resolve.
  const good = await buildFinalMessage({ tenantId: TENANT_ID, templateCode: "receipt" });
  expect(good.missing).not.toContain("payment_date");

  // deposit_confirmation is not: every type-specific placeholder lands in missing.
  const bad = await buildFinalMessage({
    tenantId: TENANT_ID,
    templateCode: "deposit-confirmation",
  });
  expect(bad.missing).toContain("bank_name");
});
```

`resolveTypeVariables` is module-private and **stays** private — assert through
`buildFinalMessage`, never by exporting internals or reading source text.

The fixtures must return a `receipt` template whose body binds `{{payment_date}}`
and a `deposit-confirmation` template whose body binds `{{bank_name}}`, or both
assertions pass vacuously.

- [ ] **Step 2: Run and note the tests you expect to delete**

```bash
bun run test -- resolveTemplateVariables
```

The locale-counterpart fallback tests are removed **by design**. Record that, so
the coverage drop is not read as a regression when `test-guard` runs.

- [ ] **Step 3: Simplify the lookup and drop both guards**

Reduce `loadTemplateForLocale` to a by-code lookup returning the row, or
`{ template: null, unavailableReason: 'No active template for <code>.' }`.
Delete `swapLocaleSuffix` and the by-type tier. Delete the
`template.locale !== resolvedLocale` rejection in **both** senders.

- [ ] **Step 4: Remove every suffixed code — including the dynamic one**

Fifteen production files. Literal ternaries
(`locale === "ar" ? "x-ar" : "x-en"` → `"x"`):

`notifyDepositConfirmed.ts:67`, `notifyContactInquiry.ts:56`,
`notifyRefundRecorded.ts:62`, `notifyMaintenanceRequest.ts`,
`notifyContractCloseout.ts`, `notifyContractRestored.ts`,
`notifyInvoiceDisputed.ts`, `notifyInvoiceWrittenOff.ts`,
`notifyUserCredentials.ts` (6 sites), `notifyPaymentSuccess.ts`
(`adminCode`, `receiptCode`), `contractExpiryJob.ts:117` **and its admin alert
at `:265`**, `overdueRemindersJob.ts:114`, `sendInvoiceToTenant.ts:151`,
`sendTenantCredentials.ts`.

**And one that builds the code dynamically** — `notifyContractLifecycle.ts:82`:

```ts
// BEFORE
function templateCode(event: ContractEvent, locale: EmailLocale): string {
  return `contract-${event}-${locale}`;
}

// AFTER — the locale parameter goes away entirely
function templateCode(event: ContractEvent): string {
  return `contract-${event}`;
}
```

Update both call sites to drop the `locale` argument.

- [ ] **Step 5: Verify nothing suffixed remains**

A literal `grep '\-ar"'` is **not sufficient** — it misses the template-literal
above. Check for both shapes:

```bash
grep -rn '"-ar"\|-ar"\|-en"' src/fns/ | grep -v '\.test\.'
grep -rn '\${locale}\|\${.*locale.*}`' src/fns/ | grep -v '\.test\.'
```

Then assert behaviourally: add a test to `notifyContractLifecycle.test.ts`
that the enqueued `templateCode` is `contract-created`, with no suffix.

- [ ] **Step 6: Full gates, then commit**

```bash
bun run lint && bun run typecheck && bun run test
git add -A src/fns
git commit -m "refactor(notifications): drop the locale fallback ladder and code suffixes"
```

---

### Task 6: The hook and the dropdown label

**Files:**
- Create: `src/hooks/useTenantEligibleTemplates.ts` + `.test.ts`
- Create: `src/components/admin/TemplateOptionLabel.tsx`
- Modify: `src/hooks/useNotificationTemplates.ts:9-23`

**Interfaces:**
- Produces:
  - `selectEligibleTemplates(templates, workflows, channel): NotificationTemplateRow[]`
    — a **pure** function, which is what the unit tests target.
  - `useTenantEligibleTemplates(channel): { data: NotificationTemplateRow[]; isLoading: boolean }`
    — thin composition of `useNotificationTemplates` + `useCronJobs` + the
    selector.
  - `<TemplateOptionLabel code type locale />`

Extract the selector rather than testing the hook through rendered components.
`SendManualMessageDialog.test.tsx` reads and regexes component **source**; do not
copy that style — it produces implementation tests.

- [ ] **Step 1: Hide the legacy codes in the shared query**

In `useNotificationTemplates.ts`: remove `.order("locale")` and add

```ts
.notIn("code", LEGACY_TEMPLATE_CODES)
```

Use `.notIn(column, values)` — the installed `@supabase/postgrest-js` exposes it
and handles quoting. Do **not** hand-build `.not("code", "in", "(…)")`; passing
an array there produces invalid raw PostgREST syntax.

This covers the window between 124 and 125, when the table holds 51 rows. It
lives **here only** — do not duplicate it into the dialogs. After 125 no legacy
code exists and the filter is inert.

- [ ] **Step 2: Write the failing selector test**

```ts
// src/hooks/useTenantEligibleTemplates.test.ts
import { describe, expect, test } from "vitest";

import { selectEligibleTemplates } from "@/hooks/useTenantEligibleTemplates";

const workflows = [
  { key: "contract-expiry", recipient_targets: ["admin", "company", "tenant"] },
  { key: "payment-succeeded", recipient_targets: ["admin", "company", "tenant"] },
];

const row = (over: Partial<Record<string, unknown>>) => ({
  id: "x", code: "receipt", type: "receipt", channel: "email",
  is_active: true, ...over,
}) as never;

describe("selectEligibleTemplates", () => {
  test("keeps an offerable template", () => {
    expect(selectEligibleTemplates([row({})], workflows, "email")).toHaveLength(1);
  });

  test("drops an inactive template", () => {
    expect(selectEligibleTemplates([row({ is_active: false })], workflows, "email")).toHaveLength(0);
  });

  test("drops a staff-only type", () => {
    const staff = row({ code: "payment-admin-alert", type: "payment_admin_alert" });
    expect(selectEligibleTemplates([staff], workflows, "email")).toHaveLength(0);
  });

  // Direction matters both ways.
  test("a 'both' template matches a specific channel", () => {
    expect(selectEligibleTemplates([row({ channel: "both" })], workflows, "email")).toHaveLength(1);
  });

  test("an email-only template does NOT match a requested 'both'", () => {
    expect(selectEligibleTemplates([row({ channel: "email" })], workflows, "both")).toHaveLength(0);
  });

  test("drops the template once the tenant pill is removed", () => {
    const expiry = row({ code: "contract-expiry", type: "contract_expiry" });
    const without = [{ key: "contract-expiry", recipient_targets: ["admin"] }];
    expect(selectEligibleTemplates([expiry], workflows, "email")).toHaveLength(1);
    expect(selectEligibleTemplates([expiry], without, "email")).toHaveLength(0);
  });
});
```

The exact predicate is
`template.channel === "both" || template.channel === requestedChannel`.

- [ ] **Step 3: Run and watch it fail**

```bash
bun run test -- useTenantEligibleTemplates
```

- [ ] **Step 4: Implement the selector, the hook, and the label**

```tsx
// src/components/admin/TemplateOptionLabel.tsx
import { t as translate } from "@/i18n/dictionary";
import type { LocaleCode, NotificationType } from "@/integrations/supabase/database.types";

/**
 * يعرض رمز القالب ونوعه بلغة الرسالة المختارة، مع عزل اتجاه النص.
 *
 * `useI18n().t` is bound to the ADMIN UI locale, but the admin is choosing what
 * the TENANT receives — so the type name follows the dialog's language selector
 * via the locale-explicit translator instead.
 *
 * `<bdi>` because a Latin hyphenated code followed by Arabic text in parentheses
 * reorders visually inside the RTL dialog.
 */
export function TemplateOptionLabel({
  code,
  type,
  locale,
}: {
  code: string;
  type: NotificationType;
  locale: LocaleCode;
}) {
  return (
    <span>
      <bdi dir="ltr">{code}</bdi> (<bdi>{translate(locale, `notificationType.${type}`)}</bdi>)
    </span>
  );
}
```

- [ ] **Step 5: Full gates, then commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/hooks/useTenantEligibleTemplates.ts src/hooks/useTenantEligibleTemplates.test.ts src/hooks/useNotificationTemplates.ts src/components/admin/TemplateOptionLabel.tsx
git commit -m "feat(notifications): add the eligibility selector, hook and label"
```

---

### Task 7: Wire both dialogs and enforce server-side

Dialogs and enforcement land together: the server fixtures must change for both,
and splitting them leaves the suite red in between.

**Files:**
- Modify: `src/components/admin/SendManualMessageDialog.tsx:109-114, 376-399`
- Modify: `src/components/admin/SendBulkMessageDialog.tsx:83`
- Modify: `src/fns/sendNotification.ts`, `src/fns/sendBulkNotification.ts`
- Modify: `src/fns/sendNotification.test.ts`, `src/fns/sendBulkNotification.test.ts`
- Create: `src/components/admin/SendBulkMessageDialog.test.tsx` — **does not exist
  today**; the earlier draft told you to edit "both dialog test files".

**The two dialogs are not symmetric.** `SendManualMessageDialog` has edit-once
state (`templateEditMode`, `cancelTemplateEdit`). `SendBulkMessageDialog` has
**none of those concepts** — only `templateCode`, `subject`, `body`. Do not
invent them there.

- [ ] **Step 1: Fix the server test fixtures first**

Two existing problems make any new test meaningless:

1. The `notification_templates` mock returns `overdue-reminder-ar` /
   `overdue_reminder` **whatever code was requested**, so a test asking for
   `payment-admin-alert` would be judged on the wrong type.
2. Adding a `cron_jobs` query makes every existing test hit the table
   dispatcher's fallthrough.

Change the fixture to return a row matching the requested code, and add a
`cron_jobs` branch returning the workflow rows. Re-run the existing suite and
confirm it is still green **before** adding behaviour.

- [ ] **Step 2: Write the failing tests**

Use the file's existing `TENANT_ID` and `callSend` helper — `callSend` supplies
the `context` the server fn requires.

```ts
test("rejects a template the tenant may not receive", async () => {
  await expect(
    callSend({
      tenantId: TENANT_ID, type: "manual_message", channel: "email",
      templateCode: "payment-admin-alert", locale: null,
      subject: null, body: null, contractId: null,
    }),
  ).rejects.toThrow(/not available for manual sending/i);
  expect(lastInsert).toBeNull();   // nothing was enqueued
});

test("accepts an eligible template", async () => { /* receipt → resolves, lastInsert set */ });
test("accepts free text with no template code", async () => { /* templateCode: null */ });
```

Throw an `Error`, never `new Response(...)` — a thrown `Response` resolves
client-side as success via `x-tss-raw`.

Assert `lastInsert` is null on rejection. A test that only checks the throw
cannot tell rejection from "threw after enqueuing".

- [ ] **Step 3: Write the non-regression tests that cannot be mocked away**

The risk is that a future change moves the gate into `enqueueNotification` and
breaks every automatic sender. A test that mocks `enqueueNotification` would
still pass. So assert at the boundary the gate would have to cross:

```ts
// src/lib/templateEligibility.test.ts — an architectural assertion, not a mock.
test("the gate is imported only by the two manual server functions", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["src/fns/enqueueNotification.ts", "src/fns/dispatchNotification.ts",
                      "src/fns/notificationDrainJob.ts"]) {
    expect(readFileSync(file, "utf8")).not.toContain("isTemplateOfferable");
  }
});
```

Use `node:fs`, matching `ComposeRecipients.test.tsx` — **not `Bun.file`**, which
is untyped here and fails `bun run typecheck`.

Additionally assert behaviourally that `sendInvoiceToTenant` still enqueues a
`document_send` notification and `notifyDepositConfirmed` still enqueues its
staff alert, exercising the real `enqueueNotification` and mocking only the
Supabase boundary.

- [ ] **Step 4: Implement enforcement**

In both server fns, after loading the template row: load `cron_jobs` (`key`,
`recipient_targets`) via `supabaseAdmin`, call
`isTemplateOfferable(template.type, jobs)`, throw when false. **Skip the check
entirely when `templateCode` is null** — that is free text and has no type.

- [ ] **Step 5: Wire the manual dialog**

Replace the `eligibleTemplates` filter that keys off `template.locale` with
`useTenantEligibleTemplates(manualChannel)`. Render options with
`<TemplateOptionLabel … locale={effectiveManualLocale} />`. Add:

```tsx
// Resetting the code alone is not enough: an "edit once" copy left in
// templateEditMode/subject/body would then be sent as free text under no
// template at all.
useEffect(() => {
  if (manualTemplate === "free") return;
  if (eligible.data.some((template) => template.code === manualTemplate)) return;
  setManualTemplate("free");
  cancelTemplateEdit();
}, [eligible.data, manualTemplate]);
```

Note `eligible.data` — the hook returns `{ data, isLoading }`, not an array.

- [ ] **Step 6: Wire the bulk dialog**

Same hook and same label. Its reset clears **only the selected template code** —
it has no edit-once state. Leave any free-text subject/body the admin typed
alone; they belong to the free-text mode, not to the template.

- [ ] **Step 7: Full gates, then commit**

```bash
bun run lint && bun run typecheck && bun run test
git add -A src/components/admin src/fns
git commit -m "feat(notifications): filter and enforce template eligibility"
```

---

### Task 8: Editor, table, types, migration 125

These land together because they are mutually dependent: dropping `locale` from
the editor payload while it is still a required insert key in
`database.types.ts` fails `typecheck`, and dropping it from the type before
migration 125 exists fails `test:sql`.

**Files:**
- Modify: `src/components/admin/TemplateEditorDialog.tsx:39-51, 166-183, 206-217, 275-373`
- Modify: `src/routes/admin.settings.notifications.tsx:146-147, 188, 494-557`
- Modify: `src/integrations/supabase/database.types.ts:705-724, 1481-1484`
- Create: `db/migrations/125_drop_template_locale.sql`
- Create: `src/db/templateLocaleCollapse.sqltest.ts`
- Create: `src/components/admin/TemplateEditorDialog.test.tsx` if absent
- Modify: **four** existing sqltests — `templateBodies`, `expiryBuckets`,
  `closeoutNotifications`, `newEventWorkflows`
- Modify: `docs/NOTIFICATION_PROVIDER_SETUP.md`

- [ ] **Step 1: Write migration 125**

```sql
-- 125 — drop the template locale split (phase 2 of 2)
--
-- Run ONLY after the new container is confirmed serving. Between 124 and this
-- migration both codes resolve, which is what makes the container swap safe.
--
-- Keyed on the explicit legacy list, never a regex: an admin-created
-- `lease-renewal-ar` is legitimate and must survive.

begin;

create temporary table legacy_stem(stem text primary key) on commit drop;
insert into legacy_stem(stem) values
  ('due-reminder'), ('overdue-reminder'), ('receipt'), ('contract-expiry'),
  ('invoice-document'), ('deposit-confirmation'), ('user-credentials'),
  ('payment-admin-alert'), ('contact-inquiry'), ('maintenance-request'),
  ('refund-recorded'), ('contract-created'), ('contract-ended'),
  ('contract-closeout'), ('contract-restored'), ('invoice-written-off'),
  ('invoice-disputed');

-- The FK only protects legacy codes that notifications actually reference. A
-- stem with no history would otherwise be deleted even if 124 never created its
-- alias — and every future automatic send under that stem would fail its FK.
do $$
declare
  missing text;
begin
  select string_agg(s.stem, ', ') into missing
    from legacy_stem s
   where not exists (
     select 1 from public.notification_templates t where t.code = s.stem
   );
  if missing is not null then
    raise exception 'Migration 124 did not create aliases for: %', missing;
  end if;
end $$;

update public.notifications n
   set template_code = s.stem
  from legacy_stem s
 where n.template_code in (s.stem || '-ar', s.stem || '-en');

delete from public.notification_templates t
 using legacy_stem s
 where t.code in (s.stem || '-ar', s.stem || '-en');

alter table public.notification_templates drop column if exists locale;

commit;
```

- [ ] **Step 2: Write the final-state sqltest**

There is **no `query()` helper**. The house pattern is `withRollback`, handing
you a `pg` `PoolClient` inside an always-rolled-back transaction.

```ts
// src/db/templateLocaleCollapse.sqltest.ts
import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";
import { LEGACY_TEMPLATE_CODES, LEGACY_TEMPLATE_STEMS } from "@/lib/legacyTemplateCodes";

afterAll(closePool);

describe("migration 125 — template locale collapse", () => {
  test("no legacy code survives", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates where code = any($1::text[])`,
        [LEGACY_TEMPLATE_CODES],
      );
      expect(rows).toEqual([]);
    });
  });

  test("every stem exists exactly once", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates
          where code = any($1::text[]) order by code`,
        [[...LEGACY_TEMPLATE_STEMS]],
      );
      expect(rows.map((r) => r.code)).toEqual([...LEGACY_TEMPLATE_STEMS].sort());
    });
  });

  test("the locale column is gone", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `select 1 from information_schema.columns
          where table_name = 'notification_templates' and column_name = 'locale'`,
      );
      expect(rows).toEqual([]);
    });
  });

  // Seed the history this migration is supposed to rewrite. Querying the clean
  // database instead would pass even if the rewrite were deleted entirely — the
  // fixtures contain no notification rows.
  test("history pointing at a legacy code is re-pointed, not orphaned", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ ok: boolean }>(
        `select exists(
           select 1 from public.notification_templates where code = 'receipt'
         ) as ok`,
      );
      expect(rows[0]?.ok).toBe(true);
      // Inserting with a legacy code must now fail the FK, proving the rows are
      // gone and that any old-bundle write would have been caught.
      await expect(
        client.query(
          `insert into public.notifications (audience, type, channel, locale, template_code, state)
             values ('tenant','receipt','email','ar','receipt-ar','queued')`,
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  // Migration 58 seeds this on a clean database; the merge must carry it over.
  test("the contract-expiry provider mapping survives the merge", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ provider_template_name: string | null }>(
        `select provider_template_name from public.notification_templates
          where code = 'contract-expiry'`,
      );
      expect(rows[0]?.provider_template_name).toBe("contract_expiry_notice");
    });
  });
});
```

- [ ] **Step 3: Update all FOUR existing sqltests**

Each hardcodes suffixed codes and expects **two** rows per stem. Halve the
expected cardinality — a mechanical string replace produces duplicate expected
values and fails.

| File | Change |
|---|---|
| `src/db/templateBodies.sqltest.ts:7` | `CODES` list → 17 stems, not 34 |
| `src/db/expiryBuckets.sqltest.ts:127` | provider-mapping assertion → `contract-expiry` |
| `src/db/closeoutNotifications.sqltest.ts:11` | closeout/restored codes → stems |
| `src/db/newEventWorkflows.sqltest.ts:16` | contact/created/ended/maintenance/refund → stems |

- [ ] **Step 4: Rework the editor and strip the pagination**

Editor: replace the hand-written `notificationTypes` array with
`NOTIFICATION_TYPES`; replace the two stacked `BodyField`s with a single pane
plus an `editLang` **view-state** select rendered first under the title; drop
`locale` from `TemplateDraft` and from the save payload.

Table: delete `templatePage`, the `Pager`, `setTemplatePage(1)` in the search
handler, and the language `<TableHead>`/`<TableCell>`. Row number becomes
`index + 1`; render `filteredTemplates` directly.

Name the test file explicitly and assert: the type dropdown offers all 20 types;
switching the language select swaps the edited pair; the save payload has no
`locale` key; the route renders every row with no pager and no language column.

If the dialog passes ~500 lines, split the body/preview pane into its own file.

- [ ] **Step 5: Hand-edit `database.types.ts`**

Remove `locale` from `NotificationTemplateRow` and from the required insert keys
(`"code" | "type" | "channel" | "locale"` → `"code" | "type" | "channel"`).

- [ ] **Step 6: Correct the provider doc**

`docs/NOTIFICATION_PROVIDER_SETUP.md:185` names suffixed codes. Update, then run
`docs-guard` to verify every code it cites exists.

- [ ] **Step 7: Full gates, then commit**

```bash
bun run test:db && bun run lint && bun run typecheck && bun run test && bun run test:sql
git add -A
git commit -m "feat(db): collapse the template locale split"
```

---

## Guard pass and landing

- [ ] `clean-code-guard` over the full PR 2 diff.
- [ ] `test-guard` over every new and modified test. State explicitly that the
      deleted locale-fallback tests were removed by design.
- [ ] `docs-guard` over the spec, this plan, and the provider doc.
- [ ] `bun run format`, then **revert** `AGENTS.md`, `CLAUDE.md` and `docs/**`.
- [ ] Re-run all four gates; compare against the 1466-test baseline.
- [ ] Open PR 2, wait for the Codex bot — never `--auto`, which merges instantly
      and can land before the bot reports.

## Release sequence

1. `pg_dump` first — the phase-2 column drop is not reversible.
2. **Announce the template-editing freeze now, before applying 124.** The unsafe
   window opens the moment 124 lands, not after verification.
3. Merge **PR 1** (migration 124 only).
4. Apply 124 from the new `main` checkout under
   `/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code/db/migrations`,
   checksum against the local file, then `notify pgrst, 'reload schema'`.
5. Verify phase 1 on production: 51 rows; **all 17** unsuffixed aliases present
   (not just `receipt`); `locale` default is `'ar'`.
6. Merge **PR 2**; Dokploy auto-deploys.
7. Confirm the new container is serving — `docker ps`, then send one manual
   message end to end.
8. Apply 125, then `notify pgrst, 'reload schema'` again.
9. Verify post-125: 17 rows, zero legacy codes, `contract-expiry` still carries
   its provider mapping, and no `notifications.template_code` is dangling. Lift
   the editing freeze.
