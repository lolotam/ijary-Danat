# Compose RTL, Gmail Compose, and Manual-Message Templating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the portal contract dropdown's left-anchored render in Arabic, give the Gmail compose dialog tenant recipients / rich text / signatures, and make the manual-message dialog hide template internals, allow one-off edits, and offer selectable variables with live values.

**Architecture:** Three independent slices. The RTL fix is one prop on a Radix `Select`. The manual-message work is mostly UI plus one server branch in `buildFinalMessage`. The Gmail work adds a TipTap editor, a signature table, and an HTML leg to `gmailSend`, and splits the 342-line dialog into a `compose/` directory.

**Tech Stack:** TanStack Start (React 19) + Nitro, Vitest (node environment), Tailwind 4 + shadcn/Radix, self-hosted Supabase, Bun.

Spec: `docs/superpowers/specs/2026-08-12-compose-rtl-and-messaging-design.md`

## Global Constraints

- **Tests run in `environment: "node"`.** No jsdom, no happy-dom, no @testing-library are installed. Component tests use `renderToStaticMarkup` from `react-dom/server` plus `readFileSync` source assertions. Follow `src/components/portal/ContractSwitcher.test.tsx`.
- **Anything needing a DOM must not run at module scope or during SSR.** TipTap is constructed with `immediatelyRender: false`; DOMPurify is created lazily inside a function, never at import time.
- **Every function gets a doc comment above it, leading with an Arabic description.** English follows only for the *why*. See `CLAUDE.md`.
- **Every new dictionary key needs both `ar` and `en`.** `src/i18n/dictionary.test.ts` fails `bun run test` on a key present in one locale only, and also checks every `t("literal")` in the source resolves.
- **File ceiling is 500–600 lines.** Split by responsibility.
- **`src/database.types.ts` is hand-maintained.** Never run `bun run gen:types` over it.
- **Migrations are manual SQL** in `db/migrations/`, numeric order. Next free number is **123**.
- **Never force-push, rebase, amend, or squash.** The repo is Lovable-connected.
- **Re-check the current branch immediately before every commit** — this repo is worked concurrently.
- TipTap version is **3.30.0** (React 19 is outside v2's peer range).
- **Gates and guards run before *every* commit, not once at the end.** `CLAUDE.md:32` requires lint + typecheck + test before presenting or committing, and `CLAUDE.md:69` requires the matching guard skill "before presenting, committing or merging". So each task's commit step means: `bun run lint && bun run typecheck && bun run test`, then `clean-code-guard` on production code touched, `test-guard` on tests touched, `docs-guard` on any docstring or doc changed. A task is not done until those pass.
- **Never `git add -A` or `git add .`.** The worktree carries unrelated untracked work (`security-skills-claude-code/` today, something else tomorrow). Stage explicit paths, then run `git status --short` and `git diff --cached --stat` and read them before committing.

Work happens on branch `feat/compose-rtl-and-messaging`, already created.

## The commit ritual

**Every step labelled "Commit" below means all six of these, in order.** It is written once here rather than repeated eleven times; a step that shows only a `git commit` line still means this.

```bash
bun run lint && bun run typecheck && bun run test   # 1. gates — all three, all green
```

2. `clean-code-guard` on the production files the task touched.
3. `test-guard` on the test files the task added or changed.
4. `docs-guard` if the task changed a docstring, README, or this plan.
5. `git branch --show-current` → must read `feat/compose-rtl-and-messaging`. This repo is worked concurrently; the branch can move under you.
6. `git add <explicit paths>`, then **read** `git status --short` and `git diff --cached --stat` before `git commit`.

Guards run before the commit, not after the branch is finished. `CLAUDE.md:69` is explicit: "before presenting, committing or merging". A guard run after eleven commits can only produce a twelfth commit apologising for the first eleven.

---

### Task 0: The Bcc header is never sent — fix the pre-existing bug first

**Files:**
- Modify: `src/fns/gmailSend.ts:73-80` (`buildMime`)
- Test: `src/fns/gmailSend.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: a `buildMime` that emits a `Bcc` header. Task 5 extends the same function; Task 10's select-all depends on this working.

**This is not part of the feature.** It is a live defect found while planning it, and it is fixed first so the repair is reviewable on its own rather than buried in a feature diff.

**The defect.** `nodemailer/lib/mime-node/index.js:581-586`:

```js
                case 'Bcc':
                    if (!this.keepBcc) {
                        // skip BCC values
                        return;
                    }
```

`MailComposer` never sets `keepBcc`, so the `Bcc` header is dropped from the built MIME. `gmailSend` passes that MIME to Gmail's `messages/send`, which takes **no separate recipient list** — delivery is driven entirely by the message headers. So every Bcc address an admin has ever typed into the compose dialog was silently discarded. No error, no bounce, no delivery.

- [ ] **Step 1: Write the failing test**

Create `src/fns/gmailSend.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildMime } from "@/fns/gmailSend";

describe("buildMime", () => {
  it("emits a Bcc header", async () => {
    // nodemailer drops Bcc from generated MIME unless keepBcc is set, and Gmail's
    // messages/send delivers from the MIME headers alone — so without this the
    // recipient simply never receives the message.
    const mime = (await buildMime({
      from: "office@example.com",
      to: ["a@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Notice",
      text: "Body",
    })).toString();

    expect(mime).toMatch(/^Bcc: hidden@example\.com$/m);
  });

  it("keeps To and Bcc as separate headers", async () => {
    const mime = (await buildMime({
      from: "office@example.com",
      to: ["a@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Notice",
      text: "Body",
    })).toString();

    expect(mime).not.toMatch(/^To:.*hidden@example\.com/m);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- gmailSend`

Expected: FAIL on the first test — no `Bcc:` line in the output. Print the generated MIME and read it; this is the evidence that the production bug is real.

- [ ] **Step 3: Fix `buildMime`**

Export it and set `keepBcc` on the compiled node. `keepBcc` is a `MimeNode` option, so it is set on the compiled result rather than passed into `MailComposer`:

```ts
/**
 * يبني رسالة MIME كاملة من خيارات nodemailer.
 *
 * `keepBcc` is set explicitly. MailComposer defaults it off — a sensible default
 * for SMTP, where the transport is told the envelope recipients separately and
 * the header would leak them. Gmail's messages/send takes no envelope: it
 * delivers from the headers in the raw MIME alone. So with the default, every
 * Bcc address was dropped and those recipients silently received nothing.
 */
export function buildMime(
  options: ConstructorParameters<typeof MailComposer>[0],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const compiled = new MailComposer(options).compile();
    compiled.keepBcc = true;
    compiled.build((error, message) => {
      if (error) reject(error);
      else resolve(message);
    });
  });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run test -- gmailSend`

Expected: PASS, both tests.

- [ ] **Step 5: Verify against a real mailbox**

The test proves a header is present in a buffer. It does not prove Gmail delivers. `bun run dev` → compose → put a second address of yours in Bcc → send → confirm **that mailbox actually receives it**, and that the To recipient's copy does not list it.

This step is the whole point of the task. Do not skip it because the unit test is green.

- [ ] **Step 6: Gates, guards, and commit**

```bash
bun run lint && bun run typecheck && bun run test
```

Then `clean-code-guard` on `gmailSend.ts` and `test-guard` on the new test.

```bash
git branch --show-current
git add src/fns/gmailSend.ts src/fns/gmailSend.test.ts
git status --short && git diff --cached --stat
git commit -m "fix(inbox): send the Bcc header — nodemailer drops it unless keepBcc is set"
```

---

### Task 1: Portal contract dropdown renders RTL

**Files:**
- Modify: `src/components/portal/ContractSwitcher.tsx:54`
- Test: `src/components/portal/ContractSwitcher.test.tsx:18-23, 63-116`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks rely on. Fully independent — can ship alone.

**Background.** `@radix-ui/react-select` stamps `dir: context.dir` onto the trigger button (`node_modules/@radix-ui/react-select/dist/index.mjs:178`). `context.dir` comes from `useDirection(dir)` at line 61, which returns the literal `"ltr"` when the component receives no `dir` prop and no `DirectionProvider` is mounted. An explicit `dir="ltr"` attribute beats the `rtl` inherited from `<html>`, so the trigger lays out left-to-right. `src/components/ui/tabs.tsx:7-17` documents the identical defect for tabs.

- [ ] **Step 1: Add `dir` to the test's i18n mock**

The existing mock at `ContractSwitcher.test.tsx:18-23` returns only `locale` and `t`. Reading `dir` from it would yield `undefined`, which silently renders no attribute and makes the next step's test pass for the wrong reason.

```tsx
vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({
    locale: "en" as const,
    dir: "rtl" as const,
    t: (key: string) => key,
  }),
}));
```

- [ ] **Step 2: Write the failing test**

Add to the `describe("ContractSwitcher")` block in `src/components/portal/ContractSwitcher.test.tsx`:

```tsx
it("stamps the locale direction onto the trigger", () => {
  // Radix's useDirection falls back to the literal "ltr" without a dir prop and
  // writes it onto the trigger button, where it beats the rtl inherited from
  // <html> and lays the label out left-first. Same defect tabs.tsx documents.
  mockContracts(twoContracts);

  expect(renderToStaticMarkup(<ContractSwitcher tenantId="t1" />)).toContain('dir="rtl"');
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `bun run test -- ContractSwitcher`

Expected: FAIL — the rendered markup contains `dir="ltr"`, so `toContain('dir="rtl"')` does not match.

Confirm the failure output actually shows `dir="ltr"` in the received markup. If it shows no `dir` at all, Step 1 was not applied.

- [ ] **Step 4: Pass `dir` to the Select**

In `src/components/portal/ContractSwitcher.tsx`, read `dir` from the hook at line 32:

```tsx
const { t, dir } = useI18n();
```

and pass it at line 54:

```tsx
<Select value={contractId ?? undefined} onValueChange={setContractId} dir={dir}>
```

Extend the component's existing doc comment (lines 14-24) with the reason:

```
 * `dir` is passed explicitly because Radix resolves direction through
 * `useDirection(dir)`, which falls back to the literal "ltr" with no prop and no
 * DirectionProvider, then stamps it onto the trigger — beating the rtl inherited
 * from <html> and putting the label leftmost on an Arabic page. Root threads the
 * value into context, so this one prop also fixes the panel's alignment and the
 * arrow-key order. Same fix, same reason, as components/ui/tabs.tsx.
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `bun run test -- ContractSwitcher`

Expected: PASS, all six tests. The five pre-existing tests must still pass — they assert label text that is direction-independent.

- [ ] **Step 6: Verify visually — this is required, not optional**

The test proves an attribute is present. It cannot prove the label moved, because `renderToStaticMarkup` output is byte-identical under both directions.

Run `bun run dev`, open the portal in Arabic, and confirm:

1. `العقد:` sits on the **right**, the code and status to its left.
2. The parentheses around the status are **not** mirrored or orphaned. `portalContractLabel` returns `1-CON-000005 (نشط)` — an LTR run, neutral parentheses, an RTL run — and bidi resolution here is an assumption this step exists to check.

If (1) is wrong, stop and re-read the Radix version's trigger render. If (2) is wrong, **do not** apply bidi isolation reflexively — the two fixes differ in cost: `LtrText` changes `portalContractLabel`'s return type from `string` to `ReactNode` (three call sites plus `portalContractLabel.test.ts`), while U+2068/U+2069 keeps it a `string` but breaks the `toContain("1-CON-00005 (portal.contract.status.active)")` assertion at `ContractSwitcher.test.tsx:69`. Report both options and pick deliberately.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must be feat/compose-rtl-and-messaging
git add src/components/portal/ContractSwitcher.tsx src/components/portal/ContractSwitcher.test.tsx
git commit -m "fix(portal): render the contract dropdown right-to-left in Arabic"
```

---

### Task 2: Free-text sends resolve live variables

**Files:**
- Modify: `src/fns/resolveTemplateVariables.ts:413-437` (add branch), `:484-490` (call site)
- Modify: `src/lib/templateVariables.ts` (add free-text catalogue)
- Test: `src/fns/resolveTemplateVariables.test.ts`, `src/lib/templateVariables.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `resolveFreeTextVariables(tenantId: string, locale: LocaleCode, contractId: string | null | undefined, asOf: string): Promise<Record<string, string>>` — exported from `src/fns/resolveTemplateVariables.ts`.
  - `FREE_TEXT_VARIABLES: TemplateVariableSpec[]` — exported from `src/lib/templateVariables.ts`. Task 4 renders it.

**Background.** With free text, `templateCode` is null, so `template?.type` is `undefined` and `resolveTypeVariables` returns `{}` at `resolveTemplateVariables.ts:420`. Free text therefore resolves exactly two variables — `tenant_name` and `company_name` (set in the base map at `:493-498`). Everything else renders as a literal `{{key}}` in a tenant's inbox.

- [ ] **Step 1: Write the failing catalogue test**

Create or extend `src/lib/templateVariables.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FREE_TEXT_VARIABLES } from "@/lib/templateVariables";

describe("FREE_TEXT_VARIABLES", () => {
  it("disambiguates the two different amounts", () => {
    // `amount` is the invoice balance in resolveDueReminderVariables and the
    // payment amount in resolveReceiptVariables. Merged under one key, one wins
    // silently and the admin cannot tell which value they inserted.
    const keys = FREE_TEXT_VARIABLES.map((spec) => spec.key);
    expect(keys).toContain("invoice_amount");
    expect(keys).toContain("payment_amount");
    expect(keys).not.toContain("amount");
  });

  it("gives every entry both labels and a sample", () => {
    for (const spec of FREE_TEXT_VARIABLES) {
      expect(spec.labelAr.trim()).not.toBe("");
      expect(spec.labelEn.trim()).not.toBe("");
      expect(spec.sample.trim()).not.toBe("");
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- templateVariables`

Expected: FAIL — `FREE_TEXT_VARIABLES` is not exported.

- [ ] **Step 3: Add the catalogue**

Append to `src/lib/templateVariables.ts`:

```ts
/**
 * المتغيّرات المتاحة للنص الحر — اتحاد كل المُحلّلات الحيّة، بمفاتيح غير متضاربة.
 *
 * Free text has no template row and therefore no type to select a variable set
 * from, so this is the union of every resolver in resolveTemplateVariables.
 *
 * `amount` is deliberately absent. It means the invoice balance in the
 * due-reminder resolver and the payment amount in the receipt resolver; merged
 * under one key one of them wins invisibly. Templates keep `{{amount}}`, where
 * the template's own type makes it unambiguous.
 *
 * Samples are invented, never real records — this renders on an admin screen.
 */
export const FREE_TEXT_VARIABLES: TemplateVariableSpec[] = [
  v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
  v("company_name", "اسم الشركة", "Company name", "دانة المستقبل العقارية"),
  v("invoice_amount", "مبلغ الفاتورة", "Invoice amount", "250.000 KWD"),
  v("due_date", "تاريخ الاستحقاق", "Due date", "2026-08-10"),
  v("outstanding", "المبلغ المستحق", "Outstanding", "500.000 KWD"),
  v("days_overdue", "أيام التأخير", "Days overdue", "12"),
  v("payment_amount", "مبلغ الدفعة", "Payment amount", "250.000 KWD"),
  v("payment_date", "تاريخ الدفع", "Payment date", "2026-08-01"),
  v("reference", "المرجع", "Reference", "PAY-2026-0042"),
  v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
  v("end_date", "تاريخ انتهاء العقد", "Contract end date", "2026-12-31"),
  v("unit", "الوحدة", "Unit", "A-12 — شقة بغرفتين"),
  v("days_until", "الأيام المتبقية", "Days remaining", "9"),
  v("pay_now_url", "رابط الدفع", "Payment link", "https://danat-future.com/portal/invoices"),
];
```

- [ ] **Step 4: Run the catalogue test and confirm it passes**

Run: `bun run test -- templateVariables`

Expected: PASS.

- [ ] **Step 5: Write the failing resolver test**

Add to `src/fns/resolveTemplateVariables.test.ts`. Follow the mocking style already used in that file for `supabaseAdmin`; assert on the merge and the renaming, which is the part that can silently go wrong:

```ts
it("renames the two colliding amounts for free text", async () => {
  // resolveDueReminderVariables and resolveReceiptVariables both return a key
  // called `amount` with different meanings. The free-text union must expose
  // both values under distinct keys rather than let one overwrite the other.
  const variables = await resolveFreeTextVariables("t1", "ar", null, "2026-08-12");

  expect(variables.invoice_amount).toBe("250.000 KWD");
  expect(variables.payment_amount).toBe("100.000 KWD");
  expect(variables).not.toHaveProperty("amount");
});
```

Seed the mocked `invoices` row with `balance: 250` and the mocked `payments` row with `amount: 100` so the two values are distinguishable — identical values would let a merge bug pass.

- [ ] **Step 6: Run it and confirm it fails**

Run: `bun run test -- resolveTemplateVariables`

Expected: FAIL — `resolveFreeTextVariables` is not exported.

- [ ] **Step 7: Add the resolver**

In `src/fns/resolveTemplateVariables.ts`, after `resolveTypeVariables` (line 437):

```ts
/** Which resolver family can supply each free-text key. */
const FREE_TEXT_SOURCES = {
  overdue: ["outstanding", "days_overdue", "pay_now_url"],
  due: ["invoice_amount", "due_date"],
  receipt: ["payment_amount", "payment_date", "reference"],
  expiry: ["contract_code", "end_date", "unit", "days_until"],
} as const;

/**
 * يحلّ فقط المتغيّرات التي يستخدمها النص فعلًا — وضع النص الحر.
 *
 * `resolveTypeVariables` branches on the template's type. Free text has no
 * template, so it returned {} and a free-text body could only ever bind
 * tenant_name and company_name; every other placeholder reached the tenant's
 * inbox as literal braces.
 *
 * Resolution is driven by the placeholders actually present rather than run
 * eagerly. These are not four queries — they are four resolver *families*, and
 * between them they read invoices, contracts, payments, payment_allocations,
 * contract_units and units, up to roughly eight round trips, plus two per
 * candidate payment when a contract is pinned. Running all of that for a body
 * with no placeholders would make every free-text send — including each
 * recipient of a bulk run, which awaits buildFinalMessage sequentially — depend
 * on datasets it does not use, and turn one unrelated query error into a
 * half-queued batch.
 *
 * `amount` is renamed on the way out — see FREE_TEXT_VARIABLES for why.
 */
export async function resolveFreeTextVariables(
  tenantId: string,
  locale: LocaleCode,
  contractId: string | null | undefined,
  asOf: string,
  requestedKeys: string[],
): Promise<Record<string, string>> {
  const wanted = new Set(requestedKeys);
  const needs = (family: keyof typeof FREE_TEXT_SOURCES) =>
    FREE_TEXT_SOURCES[family].some((key) => wanted.has(key));

  const [overdue, due, receipt, expiry] = await Promise.all([
    needs("overdue") ? resolveOverdueVariables(tenantId, contractId, asOf) : {},
    needs("due") ? resolveDueReminderVariables(tenantId, contractId) : {},
    needs("receipt") ? resolveReceiptVariables(tenantId, contractId) : {},
    needs("expiry")
      ? resolveContractExpiryVariables(tenantId, locale, contractId, asOf)
      : {},
  ]);

  return {
    ...("outstanding" in overdue
      ? {
          outstanding: overdue.outstanding,
          days_overdue: overdue.days_overdue,
          pay_now_url: overdue.pay_now_url,
        }
      : {}),
    ...("amount" in due ? { invoice_amount: due.amount, due_date: due.due_date } : {}),
    ...("amount" in receipt
      ? {
          payment_amount: receipt.amount,
          payment_date: receipt.payment_date,
          reference: receipt.reference,
        }
      : {}),
    ...("unit" in expiry
      ? {
          contract_code: expiry.contract_code,
          end_date: expiry.end_date,
          unit: expiry.unit,
          days_until: expiry.days_until,
        }
      : {}),
  };
}
```

- [ ] **Step 8: Wire it into `buildFinalMessage`**

The requested keys come from the source text, which `buildFinalMessage` already has to hand. Note the ordering constraint: `subjectSource` and `bodySource` are computed at lines 501-503, *after* the current `resolveTypeVariables` call at 484. The free-text branch must move below them, or read the same two expressions.

Replace lines 484-490 of `src/fns/resolveTemplateVariables.ts` — relocating the call so it sits after `bodySource` is known:

```ts
  // No template means free text, which has no type to select a variable set
  // from. Resolving the placeholders the body actually uses is what makes
  // {{outstanding}} and friends usable in a hand-written message instead of
  // reaching the tenant as literals — without making a body that uses none of
  // them query invoices, payments, contracts and units for nothing.
  const requestedKeys = collectPlaceholders(`${subjectSource} ${bodySource}`);
  const typeVariables = template
    ? await resolveTypeVariables(template.type, tenant.id, locale, input.contractId, asOf)
    : await resolveFreeTextVariables(tenant.id, locale, input.contractId, asOf, requestedKeys);
```

`collectPlaceholders` is already exported from this file (line 70) and already shares its regex with `renderTemplate`, so the keys resolved and the keys substituted cannot disagree.

- [ ] **Step 8b: Write the integration test that actually protects the change**

Testing `resolveFreeTextVariables` directly does not prove `buildFinalMessage` selects it when the template is null, and both send tests mock `buildFinalMessage` wholesale. Assert on `buildFinalMessage` itself:

```ts
it("resolves the free-text union but leaves the ambiguous {{amount}} missing", async () => {
  // `amount` is deliberately absent from the free-text catalogue: it means the
  // invoice balance in one resolver and the payment amount in another. It must
  // stay unresolved rather than silently pick one.
  const final = await buildFinalMessage({
    tenantId: "t1",
    templateCode: null,
    locale: "ar",
    body: "{{invoice_amount}} {{payment_amount}} {{unit}} {{amount}}",
    asOf: "2026-08-12",
  });

  expect(final.variables.invoice_amount).toBe("250.000 KWD");
  expect(final.variables.payment_amount).toBe("100.000 KWD");
  expect(final.variables.unit).not.toBe("");
  expect(final.missing).toContain("amount");
});

it("queries nothing extra for a body with no placeholders", async () => {
  // The bulk path awaits this once per recipient. A plain message must not pull
  // in invoices, payments, contracts and units.
  await buildFinalMessage({
    tenantId: "t1",
    templateCode: null,
    locale: "ar",
    body: "شكراً لتعاملكم معنا",
    asOf: "2026-08-12",
  });

  expect(fromMock).not.toHaveBeenCalledWith("payments");
  expect(fromMock).not.toHaveBeenCalledWith("payment_allocations");
});
```

Seed the mocked invoice with `balance: 250` and the payment with `amount: 100` — identical values would let a merge bug pass.

- [ ] **Step 9: Run the full suite, and understand what it does *not* cover**

Run: `bun run test`

Expected: PASS, with nothing in the send paths even exercised. `sendNotification.test.ts:41-42` and `sendBulkNotification.test.ts:29` both `vi.mock` `buildFinalMessage` wholesale, so this change is invisible to them. The one real `missing[]` assertion — `resolveTemplateVariables.test.ts:273-275`, which expects `amount` and `unit` to be missing — is on the *overdue template* path and is unaffected, because this branch only fires when `template` is null.

**Record the semantic shift, because no test will catch it.** This changes behaviour for *existing* free-text sends, not only for the new chip flow. A free-text body already containing `{{unit}}` or `{{due_date}}` lands in `missing[]` today and reaches the tenant as literal braces; after this it silently resolves to a real value. That is the intended improvement, and it is retroactive — it applies to `sendBulkNotification` and to every saved free-text path, with no test asserting either the old or the new behaviour. Say so in the commit message.

- [ ] **Step 10: Commit**

```bash
git branch --show-current
git add src/fns/resolveTemplateVariables.ts src/fns/resolveTemplateVariables.test.ts src/lib/templateVariables.ts src/lib/templateVariables.test.ts
git commit -m "feat(notifications): resolve live variables for free-text messages"
```

---

### Task 3: Manual dialog hides template fields and allows a one-off edit

**Files:**
- Modify: `src/components/admin/SendManualMessageDialog.tsx`
- Modify: `src/i18n/dictionary.ts`
- Test: `src/components/admin/SendManualMessageDialog.test.tsx` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks rely on.

**Background.** No server change is needed. `buildFinalMessage` already resolves `input.subject ?? template.subject_ar` (`resolveTemplateVariables.ts:501-503`) and never writes the template row; `sendNotification` passes the same overrides through. The capability exists and has never been exposed. Today the boxes are visible but empty for every non-`company_info` selection, so typing in them silently overrides the template with no indication.

- [ ] **Step 1: Add the dictionary keys**

In `src/i18n/dictionary.ts`, add to the **Arabic** block near the other `notifications.*` keys:

```ts
    "notifications.editTemplateOnce": "تعديل هذه الرسالة فقط",
    "notifications.editTemplateOnceHelp":
      "التعديل يسري على هذه الرسالة وحدها ولا يُحفظ في القالب.",
    "notifications.editTemplateLocalePinned":
      "اللغة مثبّتة أثناء التعديل: النص المعدّل حقل واحد، والقالب يحمل نسختين.",
```

and the matching **English** keys in the `en` block:

```ts
    "notifications.editTemplateOnce": "Edit for this message only",
    "notifications.editTemplateOnceHelp":
      "The change applies to this message alone and is not saved to the template.",
    "notifications.editTemplateLocalePinned":
      "Language is pinned while editing: the edited text is one field, the template has two.",
```

Delete the now-false `notifications.placeholders` key from **both** blocks. It advertises `{{months_until_expiry}}`, which migration 58 removed as a defect, and `{{period}}`, which no manual-send type resolves. Task 4 replaces it with resolved chips.

- [ ] **Step 2: Write the failing test**

Create `src/components/admin/SendManualMessageDialog.test.tsx`. Source assertions, in the style of `src/routes/admin.inbox.test.ts` — a full render needs a QueryClient and a DOM, neither of which this suite has:

```tsx
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/admin/SendManualMessageDialog.tsx"),
  "utf8",
);

describe("SendManualMessageDialog", () => {
  it("shows the manual fields only for free text or an explicit one-off edit", () => {
    // Before this, the boxes rendered for every non-company_info selection and
    // sat empty under a template — typing in them silently overrode the template
    // with nothing on screen saying so.
    expect(SOURCE).toMatch(/showManualFields\s*=\s*isFreeText\s*\|\|\s*templateEditMode/);
  });

  it("pins the locale when a one-off edit starts", () => {
    // subject/body are single fields in the payload but a template carries both
    // subject_ar/body_ar and subject_en/body_en. On "auto" an Arabic edit would
    // also be sent as the English body.
    expect(SOURCE).toMatch(/setManualLocale\(effectiveManualLocale\)/);
  });

  it("no longer advertises placeholders that nothing resolves", () => {
    // {{months_until_expiry}} was removed by migration 58; {{period}} is not
    // resolved for any manual-send type. Both reached tenants as literals.
    expect(SOURCE).not.toMatch(/notifications\.placeholders/);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun run test -- SendManualMessageDialog`

Expected: FAIL on all three — none of those strings exist yet.

- [ ] **Step 4: Add the state and the derived flag**

In `src/components/admin/SendManualMessageDialog.tsx`, after line 85:

```tsx
  // A template's copy, pulled into the editable fields for this send only.
  const [templateEditMode, setTemplateEditMode] = useState(false);
```

After the existing `isFreeText` at line 133:

```tsx
  const showManualFields = isFreeText || templateEditMode;
```

Change `showPreview` at line 134 so the preview stays visible while editing — it is the only feedback that the override took effect:

```tsx
  const showPreview = !isCompanyInfoMode && !isFreeText && Boolean(effectiveTenantId);
```

(unchanged — recorded here so the implementer does not "fix" it.)

- [ ] **Step 5: Add the toggle handlers**

Above the `return`:

```tsx
  /**
   * ينسخ نص القالب إلى الحقول لتعديله في هذه الرسالة وحدها.
   *
   * The locale is pinned on the way in. `subject` and `body` are single fields
   * in the send payload, but a template row carries subject_ar/body_ar *and*
   * subject_en/body_en — so on "auto" an Arabic edit would also be rendered as
   * the English body for a tenant whose language is English.
   */
  const startTemplateEdit = () => {
    const template = selectedTemplateObj;
    if (!template) return;
    setManualLocale(effectiveManualLocale);
    setManualSubject(
      (effectiveManualLocale === "ar" ? template.subject_ar : template.subject_en) ?? "",
    );
    setManualBody((effectiveManualLocale === "ar" ? template.body_ar : template.body_en) ?? "");
    setTemplateEditMode(true);
  };

  /**
   * يلغي التعديل المؤقّت ويعيد الرسالة إلى نص القالب المحفوظ.
   */
  const cancelTemplateEdit = () => {
    setTemplateEditMode(false);
    setManualSubject("");
    setManualBody("");
  };
```

- [ ] **Step 6: Reset the mode when the template *or the tenant* changes**

A stale edit carried onto a different template would send one template's text under another's name. Change the template `Select` at line 295:

```tsx
            <Select
              value={manualTemplate}
              onValueChange={(value) => {
                setManualTemplate(value);
                cancelTemplateEdit();
              }}
            >
```

The tenant select needs the same treatment, and this is the subtler half. `effectiveManualLocale` falls back to `selectedTenant?.preferred_language` (line 104). Pinning the locale on `startTemplateEdit` freezes it at whatever the *then-current* tenant implied — so switching tenant mid-edit leaves Arabic template text pinned to `ar` while the newly chosen tenant reads English. Apply the same reset at line 218:

```tsx
              <Select
                value={manualTenant}
                onValueChange={(value) => {
                  setManualTenant(value);
                  cancelTemplateEdit();
                }}
              >
```

Cancelling rather than disabling the tenant select, because changing recipient is a normal thing to do and losing an unsaved one-off edit is a smaller cost than silently sending the wrong language.

Also add `setTemplateEditMode(false);` to `handleClose` (line 141).

- [ ] **Step 7: Render the toggle and gate the fields**

Replace the `isCompanyInfoMode ? ... : <>...</>` block at lines 319-342:

```tsx
          {isCompanyInfoMode ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              {t("notifications.companyInfoMode")}
            </div>
          ) : (
            <>
              {!isFreeText && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={templateEditMode ? "secondary" : "outline"}
                    onClick={templateEditMode ? cancelTemplateEdit : startTemplateEdit}
                  >
                    {t("notifications.editTemplateOnce")}
                  </Button>
                  {templateEditMode && (
                    <p className="text-xs text-muted-foreground">
                      {t("notifications.editTemplateOnceHelp")}{" "}
                      {t("notifications.editTemplateLocalePinned")}
                    </p>
                  )}
                </div>
              )}
              {showManualFields && (
                <>
                  <div className="space-y-2">
                    <Label>{t("notifications.subject")}</Label>
                    <Input
                      value={manualSubject}
                      onChange={(event) => setManualSubject(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t("notifications.body")}</Label>
                    <Textarea
                      rows={6}
                      value={manualBody}
                      onChange={(event) => setManualBody(event.target.value)}
                    />
                  </div>
                </>
              )}
            </>
          )}
```

- [ ] **Step 8: Disable the locale select while editing**

At line 276, add `disabled={templateEditMode}` to the locale `Select` so the pin cannot be undone mid-edit while the override still holds one language's text.

- [ ] **Step 8b: Stop the edit leaking into the other language's preview**

Pinning protects the **send**, which carries one locale. It does not protect the **preview**, which does not. `MessagePreviewPanel` fires two independent queries — `payloadFor("ar")` and `payloadFor("en")` (`MessagePreviewPanel.tsx:190-228`) — and hands the *same* `subject` and `body` overrides to both. So an Arabic one-off edit renders as the English preview body too, showing the admin a message that will never be sent.

Give the panel the locale the overrides belong to, and let it fall back to stored copy for the other tab. In `MessagePreviewPanel`, add an optional prop:

```tsx
  /**
   * اللغة التي تخصّها التجاوزات — التبويب الآخر يعرض نص القالب المحفوظ.
   *
   * subject/body are single fields but this panel renders two locales. Without
   * this, a one-off Arabic edit is shown as the English body as well.
   */
  overrideLocale?: LocaleCode;
```

and scope the overrides inside `payloadFor`:

```tsx
  const payloadFor = (locale: LocaleCode) => {
    const applies = !props.overrideLocale || props.overrideLocale === locale;
    return {
      tenantId: props.tenantId,
      templateCode: props.templateCode,
      locale,
      contractId: props.contractId,
      subject: applies ? (props.subject ?? null) : null,
      body: applies ? (props.body ?? null) : null,
      variables: props.variables,
    };
  };
```

Pass `overrideLocale={templateEditMode ? effectiveManualLocale : undefined}` from the dialog.

Test this behaviourally against `payloadFor`, not with a source regex — the bug is in which payload gets which fields:

```tsx
it("applies a one-off edit to the edited locale only", () => {
  // The panel renders ar and en from one pair of override fields. Handing the
  // Arabic edit to both tabs previews a message that will never be sent.
  const ar = payloadFor("ar");
  const en = payloadFor("en");

  expect(ar.body).toBe("نص معدّل");
  expect(en.body).toBeNull();
});
```

Export `payloadFor` (or the pure function behind it) so the assertion can reach it — the suite has no DOM and cannot mount the panel.

- [ ] **Step 9: Run the tests**

Run: `bun run test -- SendManualMessageDialog dictionary`

Expected: PASS. `dictionary.test.ts` must pass too — it fails on a key added to one locale, and on a `t("literal")` in source with no matching key.

- [ ] **Step 10: Verify by hand**

`bun run dev` → admin → send a manual message.

1. Free text → subject and body visible. Unchanged.
2. Pick a template → both boxes disappear, the resolved preview remains.
3. Click **Edit for this message only** → boxes appear pre-filled with that template's raw text including `{{placeholders}}`; the language select is disabled; editing updates the preview live.
4. Send, then open Settings → Notifications and confirm **the template row still holds its original text**. This is the property the whole task turns on.

- [ ] **Step 11: Commit**

```bash
git branch --show-current
git add src/components/admin/SendManualMessageDialog.tsx src/components/admin/SendManualMessageDialog.test.tsx src/i18n/dictionary.ts
git commit -m "feat(notifications): hide template fields behind an explicit one-off edit"
```

---

### Task 4: Selectable variable chips for free text

**Files:**
- Create: `src/hooks/useMessageVariables.ts`
- Create: `src/components/admin/VariableChips.tsx`
- Create: `src/components/admin/VariableChips.test.tsx`
- Modify: `src/components/admin/SendManualMessageDialog.tsx`
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: `FREE_TEXT_VARIABLES` and `resolveFreeTextVariables` from Task 2; `showManualFields` / `templateEditMode` from Task 3.
- Produces:
  - `useMessageVariables(input: { tenantId: string; contractId: string | null; locale: LocaleCode }): { values: Record<string, string>; isLoading: boolean }`
  - `insertAtCursor(value: string, token: string, selectionStart: number, selectionEnd: number): { text: string; caret: number }` — pure, exported from `VariableChips.tsx`, tested directly.
  - `<VariableChips values onInsert />`

- [ ] **Step 1: Add the dictionary keys**

Arabic:

```ts
    "notifications.variables": "المتغيّرات",
    "notifications.variablesHelp": "اختر متغيّرًا لإدراجه في نص الرسالة.",
    "notifications.variableEmpty": "لا توجد قيمة لهذا المستأجر",
```

English:

```ts
    "notifications.variables": "Variables",
    "notifications.variablesHelp": "Pick a variable to insert it into the message body.",
    "notifications.variableEmpty": "No value for this tenant",
```

- [ ] **Step 2: Write the failing test for the pure insertion helper**

Create `src/components/admin/VariableChips.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import { insertAtCursor } from "@/components/admin/VariableChips";

describe("insertAtCursor", () => {
  it("inserts at the caret rather than appending", () => {
    const result = insertAtCursor("Dear , welcome", "{{tenant_name}}", 5, 5);

    expect(result.text).toBe("Dear {{tenant_name}}, welcome");
    expect(result.caret).toBe(20);
  });

  it("replaces the selected range", () => {
    const result = insertAtCursor("Dear NAME here", "{{tenant_name}}", 5, 9);

    expect(result.text).toBe("Dear {{tenant_name}} here");
  });

  it("appends when the caret is at the end", () => {
    const result = insertAtCursor("Total: ", "{{outstanding}}", 7, 7);

    expect(result.text).toBe("Total: {{outstanding}}");
    expect(result.caret).toBe(22);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun run test -- VariableChips`

Expected: FAIL — module not found.

- [ ] **Step 4: Write the component and the helper**

Create `src/components/admin/VariableChips.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { FREE_TEXT_VARIABLES } from "@/lib/templateVariables";

/**
 * يُدرج نصًا عند موضع المؤشّر ويعيد النص الجديد وموضع المؤشّر بعده.
 *
 * Pure and exported so the caret arithmetic is tested directly. The suite runs
 * in a node environment with no DOM, so a textarea cannot be driven in a test.
 */
export function insertAtCursor(
  value: string,
  token: string,
  selectionStart: number,
  selectionEnd: number,
): { text: string; caret: number } {
  const text = value.slice(0, selectionStart) + token + value.slice(selectionEnd);
  return { text, caret: selectionStart + token.length };
}

/**
 * صفّ أزرار المتغيّرات المتاحة، كل زر يعرض قيمته الحقيقية لهذا المستأجر.
 *
 * Values come from the same server function the preview and the send use, so
 * this row cannot drift from what is actually substituted. It replaces a
 * hand-written hint string that had drifted: it advertised
 * {{months_until_expiry}}, removed as a defect by migration 58, and {{period}},
 * which no manual-send type resolves. Both reached tenants as literal braces.
 *
 * A variable with no value is disabled rather than hidden — an admin who
 * expects a balance needs to see that this tenant has none, not to wonder where
 * the button went.
 */
export function VariableChips({
  values,
  onInsert,
}: {
  values: Record<string, string>;
  onInsert: (token: string) => void;
}) {
  const { t, locale } = useI18n();

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{t("notifications.variablesHelp")}</p>
      <div className="flex flex-wrap gap-1.5">
        {FREE_TEXT_VARIABLES.map((spec) => {
          const value = values[spec.key] ?? "";
          const label = locale === "ar" ? spec.labelAr : spec.labelEn;
          return (
            <Button
              key={spec.key}
              type="button"
              size="sm"
              variant="outline"
              disabled={!value}
              title={value || t("notifications.variableEmpty")}
              className="h-7 gap-1.5 text-xs font-normal"
              onClick={() => onInsert(`{{${spec.key}}}`)}
            >
              <span>{label}</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {value || "∅"}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the helper tests and confirm they pass**

Run: `bun run test -- VariableChips`

Expected: PASS, three tests.

- [ ] **Step 6: Write the values hook**

Create `src/hooks/useMessageVariables.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { resolveTemplateVariables, type FinalMessage } from "@/fns/resolveTemplateVariables";
import type { LocaleCode } from "@/integrations/supabase/database.types";

/**
 * يجلب القيم الحيّة للمتغيّرات المتاحة لمستأجر وعقد محدّدين.
 *
 * Calls the same server function the preview panel calls, with templateCode
 * null so buildFinalMessage takes its free-text branch. Sharing the resolver
 * rather than re-deriving values is what keeps the chips honest: a chip can
 * never advertise a value the send would not substitute.
 */
export function useMessageVariables(input: {
  tenantId: string;
  contractId: string | null;
  locale: LocaleCode;
  enabled: boolean;
}) {
  const resolveFn = useServerFn(resolveTemplateVariables);

  const query = useQuery({
    queryKey: ["messageVariables", input.tenantId, input.contractId, input.locale],
    enabled: input.enabled && Boolean(input.tenantId),
    queryFn: () =>
      resolveFn({
        data: {
          tenantId: input.tenantId,
          templateCode: null,
          locale: input.locale,
          contractId: input.contractId,
        },
      }),
  });

  return {
    values: ((query.data as FinalMessage | undefined)?.variables ?? {}) as Record<string, string>,
    isLoading: query.isLoading,
  };
}
```

- [ ] **Step 7: Wire the chips into the dialog**

In `src/components/admin/SendManualMessageDialog.tsx`, add a ref and the hook:

```tsx
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const messageVariables = useMessageVariables({
    tenantId: effectiveTenantId,
    contractId: manualContractId,
    locale: effectiveManualLocale,
    // Free text ONLY — never during a template edit. The hook resolves with
    // templateCode null, so in template-edit mode it would advertise the
    // free-text union while the send supplies a template code and resolves only
    // that template's type. An inserted {{invoice_amount}} would then reach the
    // tenant as literal braces.
    enabled: open && isFreeText,
  });
```

Add the insert handler above the `return`:

```tsx
  /**
   * يُدرج متغيّرًا في نص الرسالة عند موضع المؤشّر ويعيد التركيز إليه.
   */
  const insertVariable = (token: string) => {
    const field = bodyRef.current;
    const start = field?.selectionStart ?? manualBody.length;
    const end = field?.selectionEnd ?? manualBody.length;
    const { text, caret } = insertAtCursor(manualBody, token, start, end);
    setManualBody(text);
    // Restore the caret after React commits the new value, or it jumps to the end.
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(caret, caret);
    });
  };
```

Attach `ref={bodyRef}` to the body `Textarea` from Task 3, and render the chips beneath it **only for free text**, matching the hook's guard:

```tsx
                    {isFreeText && (
                      <VariableChips
                        values={messageVariables.values}
                        onInsert={insertVariable}
                      />
                    )}
```

Add the imports: `useRef` from react, `VariableChips` and `insertAtCursor` from `@/components/admin/VariableChips`, `useMessageVariables` from `@/hooks/useMessageVariables`.

- [ ] **Step 8: Show the resolved preview for free text**

The spec promises this (section C.3: "`MessagePreviewPanel`'s `enabled` guard is relaxed so free text resolves too") and it is the payoff for the whole task: an admin who inserts `{{outstanding}}` needs to see `500.000 KWD` before sending, not their own raw braces echoed back.

Two changes:

1. In `MessagePreviewPanel.tsx`, the guard at line 185 currently requires a template code. Free text has none but does have a body, and `buildFinalMessage` handles `templateCode: null` perfectly well:

```tsx
  const enabled = Boolean(props.tenantId && (props.templateCode || props.body));
```

   The `empty` prop at line 244 needs the same treatment, or the panel renders its "nothing to preview" state over resolved content:

```tsx
      empty={!props.templateCode && !props.body}
```

2. In the dialog, drop `!isFreeText` from `showPreview` (line 134):

```tsx
  const showPreview = !isCompanyInfoMode && Boolean(effectiveTenantId);
```

Add a test for the guard, since it is the line that decides whether the admin sees anything:

```tsx
it("previews free text once a body exists", () => {
  // Free text has no template code but does have a body, and buildFinalMessage
  // resolves that fine. Requiring a template code left the admin looking at
  // their own {{braces}} with no way to check what would actually be sent.
  expect(previewEnabled({ tenantId: "t1", templateCode: null, body: "{{outstanding}}" })).toBe(true);
  expect(previewEnabled({ tenantId: "t1", templateCode: null, body: "" })).toBe(false);
});
```

Extract the guard as a small exported `previewEnabled` so it is reachable without a DOM.

- [ ] **Step 9: Run the suite and the gates**

Run: `bun run test && bun run typecheck && bun run lint`

Expected: all PASS.

- [ ] **Step 10: Verify by hand**

`bun run dev` → manual message → free text. Confirm each chip shows a real value for the selected tenant, that clicking inserts at the caret rather than at the end, and that a variable with no data is disabled with a tooltip rather than missing.

- [ ] **Step 11: Commit**

```bash
git branch --show-current
git add src/hooks/useMessageVariables.ts src/components/admin/VariableChips.tsx src/components/admin/VariableChips.test.tsx src/components/admin/SendManualMessageDialog.tsx src/i18n/dictionary.ts
git commit -m "feat(notifications): insert variables into free-text messages by value"
```

---

### Task 5: `gmailSend` sends an HTML alternative

**Files:**
- Modify: `src/fns/gmailSend.ts:44-64` (schema), `:120-137` (MIME), `:198-245` (local row)
- Test: `src/fns/gmailSend.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `gmailSendSchema` exported from `src/fns/gmailSend.ts`; the `html?: string` field on `GmailSendInput`. Task 11 sends it.

**Background.** `gmailSend` passes `text: data.body` to MailComposer (`:129`) and nothing else. `recordLocalSentMessage` writes `input.body` into `body_text` and `snippet` (`:221`, `:236-237`), so HTML would render raw tags in the Sent list.

- [ ] **Step 1: Write the failing schema test**

Per `server-fn-validators-are-untested`, the `createServerFn` test mock skips `.validator()`, so a schema exercised only through the server function never runs. Assert it directly, the way `resolveVariablesSchema` is. Create `src/fns/gmailSend.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { gmailSendSchema, plainTextFrom } from "@/fns/gmailSend";

describe("gmailSendSchema", () => {
  it("accepts an html alternative alongside the text body", () => {
    const parsed = gmailSendSchema.parse({
      to: ["tenant@example.com"],
      subject: "Rent",
      body: "Plain",
      html: "<p>Rich</p>",
    });

    expect(parsed.html).toBe("<p>Rich</p>");
  });

  it("accepts a message whose only content is html", () => {
    // The original refine required subject-or-body. A rich-text-only send has an
    // empty `body` and would have been rejected as empty.
    expect(() =>
      gmailSendSchema.parse({ to: ["tenant@example.com"], subject: "", body: "", html: "<p>Hi</p>" }),
    ).not.toThrow();
  });

  it("still rejects a message with no subject and no content at all", () => {
    expect(() => gmailSendSchema.parse({ to: ["tenant@example.com"] })).toThrow();
  });
});

describe("plainTextFrom", () => {
  it("strips markup so the Sent list does not show tags", () => {
    expect(plainTextFrom("<p>Hello <strong>there</strong></p>")).toBe("Hello there");
  });

  it("keeps a plain body untouched", () => {
    expect(plainTextFrom("Hello there")).toBe("Hello there");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- gmailSend`

Expected: FAIL — neither export exists.

- [ ] **Step 3: Export and extend the schema**

In `src/fns/gmailSend.ts`, rename the local `schema` (line 44) to an exported `gmailSendSchema`, add the field, and widen the refine:

Note `to` loses its `.min(1)`. A Bcc-only message — which is exactly what select-all produces — is a legitimate send, and `min(1)` on `to` would reject it. The requirement is *at least one recipient somewhere*, which moves into the refine:

```ts
export const gmailSendSchema = z
  .object({
    to: z.array(z.string().trim().email()).default([]),
    cc: z.array(z.string().trim().email()).default([]),
    bcc: z.array(z.string().trim().email()).default([]),
    subject: z.string().max(998).default(""),
    body: z.string().default(""),
    /**
     * Rich-text alternative. Sent alongside `body`, never instead of it — a
     * multipart/alternative message is what every mail client expects, and a
     * text-only client shown nothing is a message that arrives blank.
     */
    html: z.string().optional(),
    attachments: z.array(attachmentSchema).default([]),
    replyToMessageId: z.string().uuid().optional(),
    thread: z.boolean().default(true),
  })
  .refine((value) => value.to.length || value.cc.length || value.bcc.length, {
    message: "A message needs at least one recipient.",
    path: ["to"],
  })
  .refine((value) => value.subject.trim() || value.body.trim() || value.html?.trim(), {
    message: "A message needs either a subject or a body.",
    path: ["subject"],
  });

export type GmailSendInput = z.infer<typeof gmailSendSchema>;
```

Update the `.inputValidator` at line 84 to reference `gmailSendSchema`. Also update the client-side guard at `GmailComposeDialog.tsx:135-139`, which currently rejects on `!to.length` and would block a Bcc-only send before the server ever sees it.

Add the matching test:

```ts
  it("accepts a bcc-only message", () => {
    // Select-all addresses every tenant via Bcc so none of them sees the others.
    expect(() =>
      gmailSendSchema.parse({ bcc: ["a@x.com"], subject: "Notice", body: "Hi" }),
    ).not.toThrow();
  });

  it("still rejects a message with no recipient at all", () => {
    expect(() => gmailSendSchema.parse({ subject: "Notice", body: "Hi" })).toThrow();
  });
```

- [ ] **Step 4: Add the strip helper**

```ts
/**
 * يحوّل نص HTML إلى نص عادي للعرض في قائمة المُرسَل.
 *
 * The Sent row stores what a human reads in a list, not what a mail client
 * renders. Storing markup there put literal <p> tags in the inbox table.
 */
export function plainTextFrom(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

- [ ] **Step 5: Send both parts**

At `buildMime` (line 120), add the html leg beside `text`:

```ts
      text: data.body || plainTextFrom(data.html ?? ""),
      ...(data.html ? { html: data.html } : {}),
```

- [ ] **Step 6: Store readable text on the local Sent row**

`recordLocalSentMessage` takes `body: string`. At its two call sites within the handler, pass the readable text:

```ts
          body: data.body || plainTextFrom(data.html ?? ""),
```

Extend that function's doc comment:

```
 * `body` is always plain text — callers strip markup before calling. `body_text`
 * and `snippet` are read straight into the inbox list, where markup renders as
 * literal tags.
```

- [ ] **Step 7: Run the tests and gates**

Run: `bun run test -- gmailSend && bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add src/fns/gmailSend.ts src/fns/gmailSend.test.ts
git commit -m "feat(inbox): send a rich-text alternative from the compose dialog"
```

---

### Task 6: Migration 123 — `email_signatures`

**Files:**
- Create: `db/migrations/123_email_signatures.sql`
- Modify: `src/integrations/supabase/database.types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `email_signatures` table and its `Tables<"email_signatures">` alias. Task 9 reads and writes it.

- [ ] **Step 1: Write the migration**

Create `db/migrations/123_email_signatures.sql`:

```sql
-- 123: Email signatures for the Gmail compose dialog.
--
-- Signatures are per-admin, not per-company: two staff sending from the same
-- shared mailbox still sign as themselves.
--
-- `details` holds the structured fields the builder renders from. The rendered
-- HTML is stored beside it rather than derived on read so a sent message and a
-- later preview cannot disagree — but `details` is the source of truth for
-- editing. The alternative, regex-parsing the HTML back into fields, returns
-- confidently wrong data the moment the stored markup stops matching the
-- template it was generated from.

create table if not exists public.email_signatures (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  content_html text not null default '',
  details jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_signatures_admin_idx
  on public.email_signatures (admin_id);

-- One default per admin, enforced in the database. Enforcing it only in the
-- client leaves two defaults the first time two tabs save at once, and the
-- compose dialog would then auto-append whichever row sorted first.
create unique index if not exists email_signatures_one_default_per_admin
  on public.email_signatures (admin_id)
  where is_default;

alter table public.email_signatures enable row level security;

-- Supabase grants ALL on new public tables to anon and authenticated by
-- default, and `revoke ... from public` does not touch grants those roles hold
-- in their own right. Revoke explicitly before granting.
revoke all on public.email_signatures from anon, authenticated;
grant select, insert, update, delete on public.email_signatures to authenticated;

drop policy if exists email_signatures_owner_read on public.email_signatures;
create policy email_signatures_owner_read on public.email_signatures
  for select to authenticated using (admin_id = auth.uid());

drop policy if exists email_signatures_owner_write on public.email_signatures;
create policy email_signatures_owner_write on public.email_signatures
  for all to authenticated
  using (admin_id = auth.uid())
  with check (admin_id = auth.uid());

-- Setting a default is two writes — clear the old one, set the new one — and two
-- client mutations are not atomic. If the second fails the admin is left with no
-- default at all, and two tabs saving at once can both clear and then race, with
-- one hitting the unique index above. One function, one transaction.
create or replace function public.set_default_email_signature(_signature_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- security invoker plus RLS means a caller can only ever reach their own rows;
  -- the admin_id filter is belt-and-braces, not the boundary.
  update public.email_signatures
     set is_default = false, updated_at = now()
   where admin_id = auth.uid() and is_default;

  update public.email_signatures
     set is_default = true, updated_at = now()
   where id = _signature_id and admin_id = auth.uid();

  if not found then
    raise exception 'Signature % not found for the current user', _signature_id;
  end if;
end;
$$;

-- New functions are executable by anon and authenticated by default, and
-- `revoke from public` does not touch grants those roles hold in their own
-- right (57 SECURITY DEFINER functions in this database are anon-executable for
-- exactly that reason). This one is security invoker, so RLS still contains it —
-- but anon has no business calling it.
revoke all on function public.set_default_email_signature(uuid) from public, anon;
grant execute on function public.set_default_email_signature(uuid) to authenticated;

-- Signature logos reuse the existing public `branding` bucket (migration 21)
-- under a signatures/ prefix. A logo is an <img src> in a message that lands in
-- an unauthenticated inbox, so it must be public-read; `branding` already is,
-- and already has an admin-write policy. A new bucket would need both policies
-- restated and would add another directory to the xattr-preserving backup
-- burden that broke every image in the July 2026 server move.
```

- [ ] **Step 2: Verify against a clean database**

Run: `bun run test:db && bun run test:sql`

Expected: PASS. This builds a database from scratch and is the only check that the whole migration set still applies in order.

- [ ] **Step 3: Hand-edit `database.types.ts`**

Add an `email_signatures` entry to the `Tables` block, following the file's existing `TableDefinition` shape — `Row`, `Insert`, `Update`, `Relationships`. Copy the shape from a neighbouring simple table.

Do **not** run `bun run gen:types` over this file. It writes a *reference* file and would clobber the 73 hand-written aliases that ~70 files import.

- [ ] **Step 4: Confirm types compile**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add db/migrations/123_email_signatures.sql src/integrations/supabase/database.types.ts
git commit -m "feat(db): add email_signatures for compose signatures (migration 123)"
```

---

### Task 7: The signature HTML builder

**Files:**
- Create: `src/lib/signatureHtml.ts`
- Create: `src/lib/signatureHtml.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SignatureDetails { logoUrl: string; fullName: string; title: string; company: string; phone: string; email: string; website: string }`
  - `EMPTY_SIGNATURE_DETAILS: SignatureDetails`
  - `buildSignatureHtml(details: SignatureDetails): string`
  - `wrapSignature(html: string): string` — the bordered block appended to a message body.

  Tasks 9 and 11 import all four.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/signatureHtml.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildSignatureHtml,
  EMPTY_SIGNATURE_DETAILS,
  type SignatureDetails,
} from "@/lib/signatureHtml";

const details = (overrides: Partial<SignatureDetails> = {}): SignatureDetails => ({
  ...EMPTY_SIGNATURE_DETAILS,
  fullName: "Waleed Mohamed",
  ...overrides,
});

describe("buildSignatureHtml", () => {
  it("omits every field that was left blank", () => {
    const html = buildSignatureHtml(details());

    expect(html).toContain("Waleed Mohamed");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("|");
  });

  it("joins phone and email with a separator only when both are present", () => {
    expect(buildSignatureHtml(details({ phone: "+965 5000 0000" }))).not.toContain("|");
    expect(
      buildSignatureHtml(details({ phone: "+965 5000 0000", email: "w@example.com" })),
    ).toContain("+965 5000 0000 | w@example.com");
  });

  it("escapes field values so a name cannot inject markup", () => {
    // Signature HTML is stored and later rendered in another admin's browser.
    const html = buildSignatureHtml(details({ fullName: '<script>alert(1)</script>' }));

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the logo URL so it cannot break out of the src attribute", () => {
    const html = buildSignatureHtml(details({ logoUrl: '" onerror="alert(1)' }));

    expect(html).not.toContain('onerror="alert(1)"');
  });

  it("renders nothing at all for wholly empty details", () => {
    expect(buildSignatureHtml(EMPTY_SIGNATURE_DETAILS)).toBe("");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun run test -- signatureHtml`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the builder**

Create `src/lib/signatureHtml.ts`:

```ts
/**
 * الحقول المنظّمة التي يُبنى منها التوقيع.
 *
 * Stored alongside the rendered HTML rather than parsed back out of it. The
 * reference implementation this is modelled on regex-parsed its own output to
 * repopulate the edit form, which returns confidently wrong data as soon as the
 * stored markup stops matching the template that produced it.
 */
export interface SignatureDetails {
  logoUrl: string;
  fullName: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
}

export const EMPTY_SIGNATURE_DETAILS: SignatureDetails = {
  logoUrl: "",
  fullName: "",
  title: "",
  company: "",
  phone: "",
  email: "",
  website: "",
};

/**
 * يهرّب المحارف الخاصة قبل إدراج قيمة داخل HTML.
 *
 * Escaping happens at build time, not at render time: the stored HTML is what
 * gets emailed and what another admin's browser previews, so an unescaped value
 * is stored XSS rather than a display bug.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * يبني HTML التوقيع من الحقول، ويتجاهل كل حقل فارغ.
 *
 * Table layout with inline styles rather than a flex div with classes: mail
 * clients strip <style> blocks and most still do not lay out flexbox. This is
 * the same shape every email-signature generator emits, for that reason.
 */
export function buildSignatureHtml(details: SignatureDetails): string {
  const lines: string[] = [];
  if (details.fullName) {
    lines.push(
      `<strong style="font-size:14px;color:#333;">${escapeHtml(details.fullName)}</strong>`,
    );
  }
  if (details.title) {
    lines.push(`<span style="color:#666;font-size:12px;">${escapeHtml(details.title)}</span>`);
  }
  if (details.company) {
    lines.push(`<span style="color:#666;font-size:12px;">${escapeHtml(details.company)}</span>`);
  }

  const contact = [details.phone, details.email].filter(Boolean).map(escapeHtml);
  if (contact.length) {
    lines.push(`<span style="font-size:12px;color:#333;">${contact.join(" | ")}</span>`);
  }
  if (details.website) {
    const href = escapeHtml(details.website);
    lines.push(
      `<a href="${href}" style="font-size:12px;color:#0066cc;text-decoration:none;">${href}</a>`,
    );
  }

  if (!lines.length && !details.logoUrl) return "";

  const logoCell = details.logoUrl
    ? `<td style="padding-inline-end:15px;vertical-align:top;"><img src="${escapeHtml(details.logoUrl)}" alt="" width="80" style="border-radius:4px;display:block;" /></td>`
    : "";
  const divider = details.logoUrl ? "border-inline-start:2px solid #0066cc;padding-inline-start:15px;" : "";

  return `<table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;"><tr>${logoCell}<td style="vertical-align:top;${divider}">${lines.join("<br/>")}</td></tr></table>`;
}

/**
 * يغلّف التوقيع بفاصل علوي قبل إلحاقه بنص الرسالة.
 */
export function wrapSignature(html: string): string {
  if (!html) return "";
  return `<div style="margin-top:20px;padding-top:10px;border-top:1px solid #e5e5e5;color:#666;font-size:14px">${html}</div>`;
}
```

- [ ] **Step 4: Run and confirm the tests pass**

Run: `bun run test -- signatureHtml`

Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/lib/signatureHtml.ts src/lib/signatureHtml.test.ts
git commit -m "feat(inbox): build signature HTML from structured fields"
```

---

### Task 8: TipTap rich-text editor

**Files:**
- Modify: `package.json`
- Create: `src/components/admin/compose/RichTextEditor.tsx`
- Create: `src/components/admin/compose/textDirection.ts`
- Create: `src/components/admin/compose/RichTextEditor.test.tsx`
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `<RichTextEditor value={string} onChange={(html: string) => void} placeholder?={string} />` and `RichTextEditorHandle` with `insertHtml(html: string): void`, exposed via `ref`. Tasks 9 and 11 use both.

- [ ] **Step 1: Add the dependencies**

```bash
bun add @tiptap/react@3.30.0 @tiptap/starter-kit@3.30.0 @tiptap/extension-text-style@3.30.0 @tiptap/extension-text-align@3.30.0 @tiptap/extension-table@3.30.0 @tiptap/extension-image@3.30.0
```

Six, not the eight originally estimated: TipTap v3's `starter-kit` already bundles bold, italic, strike, underline, link and both list types, and `extension-text-style` ships a `TextStyleKit` covering colour, font family, font size and background colour.

**Table and image are not optional here.** ProseMirror silently discards nodes its schema does not know. `buildSignatureHtml` (Task 7) emits `<table><tr><td>` with an `<img>` logo — insert that into an editor registered with StarterKit alone and it comes back as a flat run of text with no logo. Registering `TableKit` and `Image` is what makes the signature survive a round trip through the editor.

Verify the subexports before writing the toolbar:

```bash
node -e "console.log(Object.keys(require('./node_modules/@tiptap/extension-text-style/package.json').exports).join(' '))"
node -e "console.log(Object.keys(require('./node_modules/@tiptap/extension-table/package.json').exports).join(' '))"
```

Expected: `./text-style-kit` in the first, `./kit` in the second.

- [ ] **Step 2: Write the direction extension**

TipTap has no official direction extension, and this product is Arabic-first. Create `src/components/admin/compose/textDirection.ts`:

```ts
import { Extension } from "@tiptap/core";

/**
 * يضيف خاصية الاتجاه (rtl/ltr) لكل فقرة وعنوان في المحرّر.
 *
 * TipTap ships no direction extension, and a bilingual mailbox needs per-block
 * direction rather than one setting for the whole message: a reply quoting an
 * English thread under an Arabic note is the normal case here, not the corner
 * case. The attribute is rendered onto the element so it survives into the sent
 * HTML, where the recipient's mail client is the one doing the layout.
 */
export const TextDirection = Extension.create({
  name: "textDirection",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          dir: {
            default: null,
            parseHTML: (element) => element.getAttribute("dir"),
            renderHTML: (attributes) => (attributes.dir ? { dir: attributes.dir } : {}),
          },
        },
      },
    ];
  },
});
```

- [ ] **Step 3: Write the failing test**

The suite has no DOM, so TipTap cannot be mounted. Assert the properties that a missing DOM makes *most* likely to break — SSR safety — via source inspection, the same technique `admin.inbox.test.ts` uses. Create `src/components/admin/compose/RichTextEditor.test.tsx`:

```tsx
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/admin/compose/RichTextEditor.tsx"),
  "utf8",
);

describe("RichTextEditor", () => {
  it("does not build a ProseMirror view during SSR", () => {
    // TanStack Start renders this on the server. TipTap v3 builds its view
    // immediately by default, which needs a document that does not exist there,
    // and the mismatch surfaces as a hydration error rather than a clear crash.
    expect(SOURCE).toMatch(/immediatelyRender:\s*false/);
  });

  it("registers the direction extension", () => {
    // The product is Arabic-first; an editor that cannot set direction per block
    // can only write one language per message.
    expect(SOURCE).toMatch(/TextDirection/);
  });

  it("keeps table and image in the schema", () => {
    // ProseMirror discards nodes its schema does not know. The signature is a
    // <table> with an <img> logo; without these it round-trips to flat text.
    expect(SOURCE).toMatch(/TableKit/);
    expect(SOURCE).toMatch(/\bImage\b/);
  });
});
```

- [ ] **Step 4b: Prove the signature survives the editor**

The source assertion above proves the extensions are registered, not that a signature round-trips. That needs a DOM, so put it in a jsdom-environment file — the same per-file opt-in Task 9 uses for the sanitizer:

```tsx
/**
 * @vitest-environment jsdom
 */
```

Build an `Editor` headlessly with the same extension list, `setContent(buildSignatureHtml(details))`, and assert `editor.getHTML()` still contains `<table` and `<img`. This is the assertion that would have caught the flattening, and it is worth the jsdom cost.

- [ ] **Step 4: Run and confirm it fails**

Run: `bun run test -- RichTextEditor`

Expected: FAIL — file not found.

- [ ] **Step 5: Write the editor**

Create `src/components/admin/compose/RichTextEditor.tsx`. Keep it under the 500-line ceiling; if the toolbar pushes past it, extract `RichTextToolbar.tsx` beside it.

Requirements the implementer must satisfy:

- `useEditor({ extensions: [StarterKit, TextStyleKit, TextAlign.configure({ types: ["heading", "paragraph"] }), TableKit, Image, TextDirection], content: value, immediatelyRender: false, onUpdate: ({ editor }) => onChange(editor.getHTML()) })`.

  `TableKit` and `Image` are registered for the signature's sake, not to give the admin table-authoring tools — no table buttons go in the toolbar. Their job is to keep `<table>`, `<td>` and `<img>` in the schema so an inserted signature is not flattened.
- A `useEffect` that calls `editor.commands.setContent(value, { emitUpdate: false })` when `value` changes *and* differs from `editor.getHTML()`. Without the inequality check every keystroke resets the caret to position 0.
- `useImperativeHandle` exposing `insertHtml(html)` → `editor?.chain().focus().insertContent(html).run()`.
- Toolbar, in this order: undo · redo · font family · font size · bold · italic · underline · strikethrough · text colour · highlight · align left/centre/right/justify · bullet list · numbered list · link · clear formatting · direction RTL/LTR.
- Direction buttons run `editor.chain().focus().updateAttributes("paragraph", { dir: "rtl" }).run()` (and `"ltr"`).
- Every toolbar control carries `title` and `aria-label` from `t(...)` — new dictionary keys in both locales.
- The link button must **not** use `prompt()`. `native-confirm-freezes-browser-automation` records that native dialogs hard-freeze this project's browser automation. Use a `Popover` with an `Input`, as the colour pickers do.

- [ ] **Step 6: Add the toolbar dictionary keys**

Add `inbox.editor.*` keys for every control to **both** locale blocks. `dictionary.test.ts` fails on any `t("literal")` that does not resolve.

- [ ] **Step 7: Run the tests and gates**

Run: `bun run test -- RichTextEditor dictionary && bun run typecheck && bun run lint`

Expected: PASS.

- [ ] **Step 8: Verify SSR by hand**

`bun run dev`, open the inbox compose dialog, and check the **server-rendered** HTML (view-source, not devtools) contains no ProseMirror markup and the browser console shows no hydration warning. This is the failure mode `immediatelyRender: false` exists to prevent and the one the test can only approximate.

- [ ] **Step 9: Commit**

```bash
git branch --show-current
git add package.json bun.lock src/components/admin/compose src/i18n/dictionary.ts
git commit -m "feat(inbox): add a TipTap rich-text editor with per-block direction"
```

---

### Task 9: Signature manager

**Files:**
- Create: `src/components/admin/compose/SignatureManager.tsx`
- Create: `src/hooks/useEmailSignatures.ts`
- Create: `src/lib/sanitizeHtml.ts`
- Create: `src/lib/sanitizeHtml.test.ts`
- Modify: `package.json`, `vitest.config.ts`
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: `buildSignatureHtml`, `EMPTY_SIGNATURE_DETAILS`, `SignatureDetails`, `wrapSignature` (Task 7); `Tables<"email_signatures">` (Task 6).
- Produces:
  - `useEmailSignatures()`, `useDefaultSignature()`, `useSaveSignature()`, `useDeleteSignature()` from `src/hooks/useEmailSignatures.ts`.
  - `sanitizeSignatureHtml(html: string): string` from `src/lib/sanitizeHtml.ts`.
  - `<SignatureManager selectedId onSelect onInsert />`.

- [ ] **Step 1: Add DOMPurify and a jsdom test environment**

```bash
bun add dompurify@3.4.13
bun add -d jsdom
```

`jsdom` is a **dev** dependency only. `isomorphic-dompurify` would pull jsdom into the production bundle; the app never renders outbound HTML server-side, so the browser build is all that is needed. jsdom exists solely so the sanitizer can be tested — `vitest.config.ts` sets `environment: "node"` and DOMPurify needs a `window`.

Leave `vitest.config.ts` global environment as `node`. Opt in per file with a docblock.

- [ ] **Step 2: Write the failing sanitizer test**

Create `src/lib/sanitizeHtml.test.ts`:

```ts
/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import { sanitizeSignatureHtml } from "@/lib/sanitizeHtml";

describe("sanitizeSignatureHtml", () => {
  it("removes script elements", () => {
    expect(sanitizeSignatureHtml('<p>Hi</p><script>alert(1)</script>')).toBe("<p>Hi</p>");
  });

  it("removes inline event handlers", () => {
    const clean = sanitizeSignatureHtml('<img src="x" onerror="alert(1)" />');

    expect(clean).not.toContain("onerror");
  });

  it("removes javascript: URLs", () => {
    expect(sanitizeSignatureHtml('<a href="javascript:alert(1)">x</a>')).not.toContain(
      "javascript:",
    );
  });

  it("keeps the inline styles a signature depends on", () => {
    // Mail clients strip <style> blocks, so a signature is inline styles or it
    // is nothing. Stripping them here would silently flatten every signature.
    const clean = sanitizeSignatureHtml(
      '<table><tr><td style="vertical-align:top;">x</td></tr></table>',
    );

    expect(clean).toContain("vertical-align:top");
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `bun run test -- sanitizeHtml`

Expected: FAIL — module not found.

- [ ] **Step 4: Write the sanitizer**

Create `src/lib/sanitizeHtml.ts`:

```ts
import DOMPurify from "dompurify";

/**
 * ينقّي HTML التوقيع قبل حفظه أو عرضه.
 *
 * Signature HTML is stored in the database and later rendered into a privileged
 * admin session with dangerouslySetInnerHTML, which makes an unsanitized value
 * stored XSS rather than a rendering bug. Sanitizing on both write and render
 * means a row written before this existed cannot execute either.
 *
 * Browser only, by design. The app never renders outbound HTML server-side, and
 * isomorphic-dompurify would pull jsdom into the production bundle to guard a
 * surface that does not exist. Called lazily rather than at module scope
 * because this file is imported into components that server-render.
 *
 * Inline styles are deliberately allowed: mail clients strip <style> blocks, so
 * a signature is inline styles or it is unstyled text.
 */
export function sanitizeSignatureHtml(html: string): string {
  if (typeof window === "undefined") return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "table", "tbody", "tr", "td", "img", "a", "span", "strong", "em", "b", "i",
      "u", "br", "p", "div", "small",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "width", "height", "style", "target", "rel", "dir"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,)/i,
  });
}
```

Note the SSR guard returns `""`, not the input. Returning unsanitized HTML on the server would defeat the function in exactly the environment where the caller cannot tell.

- [ ] **Step 5: Run and confirm the tests pass**

Run: `bun run test -- sanitizeHtml`

Expected: PASS, four tests.

- [ ] **Step 6: Write the data hooks**

Create `src/hooks/useEmailSignatures.ts` following `src/hooks/useTenants.ts` conventions — `useQuery` / `useMutation`, `queryKey: ["email-signatures"]`, `invalidateQueries` on success, Arabic doc comment on each export.

Two rules the hooks must follow:

**Default switching goes through the RPC, never two client mutations.** Call `supabase.rpc("set_default_email_signature", { _signature_id: id })` from Task 6. Clearing the old default and setting the new one from the client is two round trips with no transaction: a failure between them leaves the admin with no default, and two tabs can both clear and then race into the unique index. Insert or update the row first, then call the RPC if the row is meant to be default.

**`content_html` is sanitized immediately before every insert and update**, not only when previewed:

```ts
      content_html: sanitizeSignatureHtml(buildSignatureHtml(details)),
```

Sanitizing only at render time leaves the unsafe value in the database, where the next reader — a future export, a report, a different component — has no idea it needs sanitizing. Sanitize on write *and* on render; a row written before this existed is then still safe to display.

- [ ] **Step 7: Write the manager component**

Create `src/components/admin/compose/SignatureManager.tsx`:

- A `Select` listing the admin's signatures plus a "no signature" entry, and a gear button opening a management `Dialog`.
- The dialog holds a list (edit / delete per row) and a create-or-edit form over `SignatureDetails`.
- Logo upload: reuse the pattern at `src/routes/admin.settings.index.tsx:214-243` — 5 MB ceiling, `file.type.startsWith("image/")`, `supabase.storage.from("branding").upload(...)` with path `signatures/${crypto.randomUUID()}.${extension}`, then `getPublicUrl`. Add drag-and-drop with the native `onDragOver` / `onDrop` handlers rather than adding `react-dropzone` for one drop target.
- Live preview renders `sanitizeSignatureHtml(buildSignatureHtml(details))` through `dangerouslySetInnerHTML`.

Add an explanatory comment on that one `dangerouslySetInnerHTML`. `src/components/admin/MessagePreviewPanel.test.tsx:101` asserts that component has none — it renders untrusted template markup into a sandboxed iframe instead — and a reader who knows that test deserves to know why this case differs: the content is first-party, generated by `buildSignatureHtml` from escaped fields, and sanitized again on the way in and out.

- [ ] **Step 8: Add dictionary keys and run the gates**

Add `inbox.signature.*` keys in both locales.

Run: `bun run test && bun run typecheck && bun run lint`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git branch --show-current
git add package.json bun.lock src/lib/sanitizeHtml.ts src/lib/sanitizeHtml.test.ts src/hooks/useEmailSignatures.ts src/components/admin/compose/SignatureManager.tsx src/i18n/dictionary.ts
git commit -m "feat(inbox): manage email signatures with logo upload and preview"
```

---

### Task 10: Tenant recipients with select-all

**Files:**
- Create: `src/components/admin/compose/ComposeRecipients.tsx`
- Create: `src/components/admin/compose/ComposeRecipients.test.tsx`
- Create: `src/lib/addressList.ts`
- Create: `src/lib/addressList.test.ts`
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: `useTenants` from `src/hooks/useTenants.ts`.
- Produces:
  - `parseAddresses(value: string): string[]`, `appendAddresses(current: string, additions: string[]): string` from `src/lib/addressList.ts`.
  - `<ComposeRecipients to bcc onChange />` where `onChange: (next: { to: string; bcc: string }) => void`.

- [ ] **Step 1: Write the failing helper tests**

Create `src/lib/addressList.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { appendAddresses, parseAddresses } from "@/lib/addressList";

describe("parseAddresses", () => {
  it("splits on commas and semicolons and trims", () => {
    expect(parseAddresses("a@x.com, b@x.com; c@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });

  it("drops empty fragments left by a trailing separator", () => {
    expect(parseAddresses("a@x.com, ")).toEqual(["a@x.com"]);
  });
});

describe("appendAddresses", () => {
  it("does not duplicate an address that is already present", () => {
    expect(appendAddresses("a@x.com", ["a@x.com", "b@x.com"])).toBe("a@x.com, b@x.com");
  });

  it("compares case-insensitively", () => {
    expect(appendAddresses("A@X.com", ["a@x.com"])).toBe("A@X.com");
  });

  it("keeps hand-typed text that is not an address", () => {
    // The field is the single source of truth and the admin may be mid-type.
    // Rewriting what they typed is how "I deleted an address and it came back"
    // happens.
    expect(appendAddresses("draft-note", ["a@x.com"])).toBe("draft-note, a@x.com");
  });

  it("returns the additions alone when the field is empty", () => {
    expect(appendAddresses("", ["a@x.com"])).toBe("a@x.com");
  });

  it("does not double the separator when the field ends in one", () => {
    // The admin is mid-type as often as not, and this helper is the single
    // source of truth for the field — a stray ", ," is a value the send path
    // then has to cope with.
    expect(appendAddresses("a@x.com, ", ["b@x.com"])).toBe("a@x.com, b@x.com");
    expect(appendAddresses("a@x.com;", ["b@x.com"])).toBe("a@x.com, b@x.com");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun run test -- addressList`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the helpers**

Create `src/lib/addressList.ts`. `parseAddresses` replaces the private `splitAddresses` at `GmailComposeDialog.tsx:62`; delete that copy in Task 11 rather than leaving two.

```ts
/**
 * يفصل قائمة عناوين مكتوبة يدويًا إلى عناوين مفردة.
 */
export function parseAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean);
}

/**
 * يضيف عناوين إلى الحقل النصّي دون تكرار ودون إعادة كتابة ما كتبه المستخدم.
 *
 * The text field stays the one source of truth: the tenant picker appends into
 * it and never replaces it. Holding a parallel array of selected tenants beside
 * the text is what produces "I deleted an address and it came back", because
 * the next render re-derives the field from the array.
 */
export function appendAddresses(current: string, additions: string[]): string {
  const existing = parseAddresses(current);
  const seen = new Set(existing.map((address) => address.toLowerCase()));
  const fresh = additions.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!fresh.length) return current;
  return existing.length ? `${current.replace(/[,;\s]*$/, "")}, ${fresh.join(", ")}` : fresh.join(", ");
}
```

- [ ] **Step 4: Run and confirm the tests pass**

Run: `bun run test -- addressList`

Expected: PASS, six tests.

- [ ] **Step 5: Write the component**

Create `src/components/admin/compose/ComposeRecipients.tsx`: a `Popover` beside the To field containing a search `Input`, a scrollable checkbox list of tenants (shape borrowed from `src/components/admin/TenantMultiSelect.tsx`), an **Add selected** button and a **Select all** button.

Four behaviours are load-bearing:

1. **Any addition of two or more tenants goes to Bcc — not only literal select-all.** The rule is about how many addresses land in one header, not which button was pressed: ticking three tenants and clicking *Add selected* discloses those three to each other exactly as select-all would. Only a single-tenant addition targets `To:`.

   Test both paths — two tenants and all tenants — because the naive implementation special-cases the select-all button and leaves the subset leaking:

```tsx
it("routes any multi-tenant addition to bcc, not just select-all", () => {
  expect(routeAddition(["a@x.com", "b@x.com"])).toEqual({ field: "bcc" });
  expect(routeAddition(["a@x.com"])).toEqual({ field: "to" });
});
```

   Extract `routeAddition` as a pure exported function so this is testable without a DOM.

2. **The query must actually fetch every tenant.** `useTenants` defaults to `pageSize = 10` (`src/hooks/useTenants.ts:259`). Calling it bare would make *Select all* mean "select the first ten" while the button says otherwise — and the `N of M` count would be wrong in the same direction, so nothing on screen would reveal it. Pass `{ pageSize: 1000 }`, which is what `TenantMultiSelect.tsx:41` already does for this exact reason. Assert `data.total` against the number of rows rendered so a future page-size change fails a test rather than silently truncating a send.

3. **Tenants with no email address are listed but disabled**, and the header shows `N of M` with an email address. Silently dropping them is the defect shape `written-but-never-read-columns` records.

4. **Both fields are appended to via `appendAddresses`.** Nothing in this component holds address state.

- [ ] **Step 6: Write the component test**

Source assertions in `ComposeRecipients.test.tsx`, following `admin.inbox.test.ts`:

```tsx
it("routes select-all into bcc so tenants cannot see each other", () => {
  expect(SOURCE).toMatch(/selectAll[\s\S]{0,400}bcc:/);
  expect(SOURCE).not.toMatch(/selectAll[\s\S]{0,200}to: appendAddresses/);
});

it("never holds its own copy of the address list", () => {
  // The text field is the single source of truth; a parallel array here is what
  // makes a deleted address reappear on the next render.
  expect(SOURCE).not.toMatch(/useState<string\[\]>\(\s*\[\s*\]\s*\)/);
});
```

- [ ] **Step 7: Add dictionary keys and run the gates**

`inbox.recipients.*` in both locales.

Run: `bun run test && bun run typecheck && bun run lint`

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add src/lib/addressList.ts src/lib/addressList.test.ts src/components/admin/compose/ComposeRecipients.tsx src/components/admin/compose/ComposeRecipients.test.tsx src/i18n/dictionary.ts
git commit -m "feat(inbox): pick tenant recipients, with select-all routed to bcc"
```

---

### Task 11: Assemble the compose dialog

**Files:**
- Create: `src/components/admin/compose/GmailComposeDialog.tsx` (moved)
- Delete: `src/components/admin/GmailComposeDialog.tsx`
- Modify: `src/routes/admin.inbox.tsx:7-10`
- Modify: `src/components/admin/GmailMessageSheet.tsx:7, 133-155`
- Test: `src/components/admin/compose/GmailComposeDialog.test.tsx` (create)

**Interfaces:**
- Consumes: everything produced by Tasks 5, 7, 8, 9, 10.
- Produces: `GmailComposeDialog`, `emptyCompose`, `ComposeSeed` re-exported from the new path. `ComposeSeed` gains `html: string`.

- [ ] **Step 1: Move the file and update *both* importers**

```bash
git mv src/components/admin/GmailComposeDialog.tsx src/components/admin/compose/GmailComposeDialog.tsx
```

There are two importers, not one. `src/routes/admin.inbox.tsx:7-10` and **`src/components/admin/GmailMessageSheet.tsx:7**, which imports `type { ComposeSeed }` from the old path. Missing the second breaks the build immediately.

```bash
grep -rn "admin/GmailComposeDialog" src   # must return nothing when done
```

Run `bun run typecheck` — it must pass before any behaviour changes. A move and an edit in one commit is a diff nobody can review.

- [ ] **Step 2: Commit the move on its own**

```bash
git add src/components/admin/compose/GmailComposeDialog.tsx src/routes/admin.inbox.tsx src/components/admin/GmailMessageSheet.tsx
git status --short && git diff --cached --stat
git commit -m "refactor(inbox): move the compose dialog into components/admin/compose"
```

Explicit paths, never `git add -A` — the worktree carries unrelated untracked directories.

- [ ] **Step 2b: Convert the reply and forward seeds to HTML**

`GmailMessageSheet` builds seeds with a plain-text `body` and no `html` (`:141` `quoteForReply(...)`, `:153` `forwardPreamble(...) + parsed.text`). Once the editor is bound to `draft.html`, a reply seeded only with `body` opens **empty** — the quoted message the admin is replying to silently vanishes.

Make `html` **required** on `ComposeSeed` so the compiler finds every seed site rather than letting one default to `""` at runtime, and convert at the seam:

```ts
/**
 * يحوّل نصًا عاديًا إلى HTML آمن مع الحفاظ على فواصل الأسطر.
 *
 * Reply and forward seeds are built from the parent's plain text. Handing that
 * straight to the editor would both lose every line break and let a crafted
 * message body inject markup into the admin's compose window.
 */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split(/\r?\n/)
    .map((line) => `<p>${line || "<br>"}</p>`)
    .join("");
}
```

Test both seeds:

```tsx
it("carries the quoted message into the reply's html", () => {
  const seed = replySeed(parsed);

  expect(seed.html).toContain("&gt; original line");
  expect(seed.html).not.toContain("<script>");
});
```

- [ ] **Step 3: Wire the parts in**

In the moved file:

- Add `html: string` to `ComposeSeed` and `emptyCompose()`.
- Delete the private `splitAddresses` (old line 62) and import `parseAddresses` from `@/lib/addressList`.
- Replace the body `Textarea` (old lines 271-276) with `<RichTextEditor ref={editorRef} value={draft.html} onChange={(html) => setDraft({ ...draft, html })} />`.
- Render `<ComposeRecipients to={draft.to} bcc={draft.bcc} onChange={(next) => setDraft({ ...draft, ...next })} />` beside the To field, and auto-reveal Cc/Bcc when `next.bcc` becomes non-empty.
- Render `<SignatureManager ... />` in the footer row.
- In `submit()`, append the default signature when one is selected and was not already inserted, then send both parts:

```ts
      const signature = signatureInserted ? "" : wrapSignature(selectedSignature?.content_html ?? "");
      const html = `${draft.html}${signature}`;
      await send({
        data: {
          to: parseAddresses(draft.to),
          cc: parseAddresses(draft.cc),
          bcc: parseAddresses(draft.bcc),
          subject: draft.subject,
          body: plainTextFrom(html),
          html,
          attachments: attachments.map(({ filename, mimeType, content }) => ({
            filename,
            mimeType,
            content,
          })),
          replyToMessageId: draft.replyToMessageId,
          thread: draft.thread,
        },
      });
```

- Update the send guard (old lines 140-143) to check `draft.subject.trim() || plainTextFrom(draft.html).trim()`. Checking `draft.html` alone would treat TipTap's empty document, `<p></p>`, as content and send a blank message.

- [ ] **Step 4: Write the test**

`src/components/admin/compose/GmailComposeDialog.test.tsx`:

```tsx
it("treats TipTap's empty document as empty", () => {
  // An empty TipTap editor returns "<p></p>", which is truthy. Guarding on the
  // raw HTML would let the Send button enable on a blank message.
  expect(SOURCE).toMatch(/plainTextFrom\(draft\.html\)/);
});

it("sends both a text and an html part", () => {
  // A text-only client shown nothing receives a blank message.
  expect(SOURCE).toMatch(/body: plainTextFrom\(html\)/);
  expect(SOURCE).toMatch(/\bhtml,/);
});

it("keeps one address parser", () => {
  expect(SOURCE).not.toMatch(/function splitAddresses/);
});
```

- [ ] **Step 5: Run the gates**

Run: `bun run test && bun run typecheck && bun run lint`

Expected: PASS. `admin.inbox.test.ts` counts table columns in the route file and must still pass.

- [ ] **Step 6: Verify by hand — send a real message**

`bun run dev` → inbox → Compose. Confirm:

1. Formatting (bold, colour, alignment, direction) survives into a real received email.
2. Arabic text renders right-to-left in the recipient's client.
3. The signature appears once, not twice.
4. Select-all populates **Bcc**, and the received message's headers show no other recipient.
5. The Sent list shows readable text, **not** `<p>` tags. This is the `recordLocalSentMessage` change from Task 5 and only shows up here.

- [ ] **Step 7: Gates, guards, and commit**

```bash
bun run lint && bun run typecheck && bun run test
```

Then `clean-code-guard` on the compose components and `test-guard` on the new tests.

```bash
git branch --show-current
git add src/components/admin/compose src/components/admin/GmailMessageSheet.tsx src/routes/admin.inbox.tsx
git status --short && git diff --cached --stat
git commit -m "feat(inbox): compose with rich text, tenant recipients and signatures"
```

---

### Task 12: Guards, migration, and delivery

**Files:** none created.

- [ ] **Step 1: Whole-branch guard sweep**

Guards and gates already ran before each task's commit — that is the per-commit requirement in Global Constraints, and it is not optional (`CLAUDE.md:32`, `:69`). This step is the different, coarser check: the branch as a whole.

- `clean-code-guard` over the **full branch diff** (`git diff main...HEAD`), which catches duplication and inconsistency *between* tasks that a per-task pass cannot see — two sanitizer call sites that disagree, an address helper reimplemented in a second file.
- `test-guard` over every test file the branch adds.
- `docs-guard` over the spec, this plan, and **every new docstring** — this branch adds a great many Arabic-first doc comments, and the guard's job is verifying their claims against the source.

Fix what they find. A passing suite says nothing about a test that asserts nothing.

- [ ] **Step 2: Run the full gates one final time**

```bash
bun run lint && bun run typecheck && bun run test
```

All three must pass on the merged branch state, not just per-task. Paste the real output; do not summarise it.

- [ ] **Step 3: Back up production, then apply migration 123**

Schema changes are not reversible. Dump **onto the host**, not into the container's `/tmp` — a backup that lives only inside the thing you are about to change is not a backup:

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 \
  pg_dump -U supabase_admin -d postgres -Fc -f /tmp/pre-123.dump
docker cp danatfuture-supabase-ozoxsa-db-1:/tmp/pre-123.dump /root/pre-123.dump
ls -l /root/pre-123.dump          # non-zero, and note the size
```

Run the dump under `nohup` with a status file — the MCP bridge returns `No response from server` on long commands while they keep running.

Then apply. Migration 123 must land **before** the merge: Dokploy auto-deploys on push to `main`, so merging first would run the new bundle against the old schema.

Apply **the file you transferred** — `/root/123.sql` from Step 3's chunked copy. The Dokploy checkout does not contain migration 123 and cannot until after the deploy this migration must precede; reading from it would apply nothing, or worse, apply an older file of the same name:

```bash
md5sum /root/123.sql          # must equal the local file's md5 from Step 3
docker exec -i danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < /root/123.sql
docker exec danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -Atc "notify pgrst, 'reload schema'"
```

The checksum is the only proof production ran the bytes the SQL suite validated. `notify pgrst` is required — without it PostgREST keeps a stale signature cache and both the new table and `set_default_email_signature` 404 despite existing.

**The checkout trick does not work here, and the alternative has a size cap.** `CLAUDE.md`'s runbook says to concatenate migrations from Dokploy's clone of `main` — but that clone only gains the file *after* a deploy of `main`, and this migration must land *before* the merge that would deploy it. So the file has to be transferred directly, and the MCP `exec` bridge caps a command at roughly a kilobyte, which is why the checkout trick exists in the first place.

Migration 123 is a few kilobytes, so transfer it in chunks and verify:

```bash
# locally: split base64 into <800-byte chunks
base64 -w0 db/migrations/123_email_signatures.sql | fold -w 800 > /tmp/123.b64.chunks
md5sum db/migrations/123_email_signatures.sql
```

Then, per chunk, `printf '%s' '<chunk>' >> /root/123.b64` over `ssh-danatfuture-mcp`, and finally:

```bash
base64 -d /root/123.b64 > /root/123.sql
md5sum /root/123.sql          # MUST equal the local md5 above
```

Do not run `psql` until the two checksums match. A truncated chunk produces valid-looking SQL that applies a partial schema.

- [ ] **Step 4: Confirm the table and its policies exist**

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -Atc \
  "select count(*) from pg_policies where tablename='email_signatures';"
```

Expected: `2`. `storage-rls-policies-lost-in-server-move` records what a missing policy check costs.

- [ ] **Step 5: Push and open the PR**

```bash
git branch --show-current      # feat/compose-rtl-and-messaging
git push -u origin feat/compose-rtl-and-messaging
gh pr create --title "feat: compose RTL fix, Gmail compose, manual-message templating" --body "..."
```

Pushing a feature branch does **not** deploy. Only `main` does.

- [ ] **Step 6: Wait for the Codex bot scan, then merge**

Do **not** use `gh pr merge --auto`. It merges the moment checks go green, which is before the bot scan reports — the exact failure `pr-merge-workflow-gotchas` records. Wait for the scan, address its findings, then merge manually.

- [ ] **Step 7: Confirm the deploy**

After merge, confirm the container rebuilt and the app is up:

```bash
docker ps --filter name=danatfuture-danatfuture-vk5hnn
```

Then send one real message from production compose and check the Sent list renders text rather than markup.

---

## Self-Review

**Spec coverage.** A → Task 1. B.1 → Task 10. B.2 → Task 8. B.3 → Tasks 7, 9. B.4 → Tasks 0, 5. B.5 → Task 9. B.6 → Task 6. B.7 → Tasks 8-11. C.1 and C.2 → Task 3. C.3 → Tasks 2, 4. C.4 (bulk dialog excluded) → no task, by design. Testing and delivery → Task 12.

Task 0 is not in the spec. It is a pre-existing production defect found while planning Task 10 and fixed first, on its own.

**Type consistency.** `buildMime` (Task 0) is extended by Task 5. `SignatureDetails` / `EMPTY_SIGNATURE_DETAILS` / `buildSignatureHtml` / `wrapSignature` (Task 7) are consumed under those exact names in Tasks 9 and 11. `parseAddresses` / `appendAddresses` / `routeAddition` (Task 10) in Task 11. `plainTextFrom` and `gmailSendSchema` (Task 5) in Task 11. `plainTextToHtml` (Task 11) is used only within its own task. `FREE_TEXT_VARIABLES` (Task 2) in Task 4. `resolveFreeTextVariables` takes five parameters including `requestedKeys` — Task 2 Step 8 is the only caller. `set_default_email_signature` (Task 6) is called by Task 9.

**Ordering.** Task 0 first — it is independent and it is a live bugfix. Tasks 1-4 are independent of 5-11. Task 6 (migration, including the RPC) must precede Task 9. Task 11 depends on 0, 5, 7, 8, 9, 10.

**Corrections applied after the Codex plan review.** Recorded so a reader knows these were reasoned about, not overlooked: Bcc was silently dropped by nodemailer (Task 0, new); `to` could not be empty so a Bcc-only send failed validation (Task 5); `GmailMessageSheet` was a second importer of the moved file and its reply/forward seeds carried no HTML (Task 11); StarterKit has no table or image node so signatures would have been flattened (Task 8); `useTenants` defaults to ten rows so "select all" meant ten (Task 10); a two-tenant subset still leaked addresses in `To` (Task 10); the free-text union was eager and cost up to eight round trips per recipient of a bulk send (Task 2); chips rendered during template-edit mode advertised variables that send would not resolve (Task 4); the one-off edit leaked into the other locale's preview (Task 3); default-signature switching was two non-atomic client writes (Tasks 6, 9); signature HTML was sanitized on render but not on write (Task 9); the migration was transferred to one path and applied from another (Task 12); `git add -A` would have staged unrelated untracked work (throughout); and guards ran after eleven commits instead of before each (Global Constraints).

**Known risk carried deliberately.** Task 8 specifies the editor's behaviour rather than giving its full source. The toolbar is mechanical, but the four non-obvious properties — `immediatelyRender: false`, the `setContent` inequality guard, no `prompt()` for the link dialog, and table/image in the schema — are each called out with the failure they prevent, and three are asserted by tests.
