# Payment-Link Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a MyFatoorah payment settle the invoice even when the payer never signs in and never returns to the callback tab, and make settlement reconcile an invoice an admin already marked paid by hand.

**Architecture:** Two independent additions to the existing settlement path. (1) A pure decision function classifies the payments blocking a settlement, letting `settleGatewayPayment` adopt admin placeholder payments instead of throwing. (2) A new cron job polls pending `payment_requests` against the gateway and settles the paid ones, giving the money path a liveness guarantee it currently lacks. The webhook stays fail-closed and unchanged apart from one diagnostic log line.

**Tech Stack:** TanStack Start server functions (Bun runtime), Vitest, self-hosted Supabase (Postgres 17) with hand-written SQL migrations.

Spec: `docs/superpowers/specs/2026-08-07-payment-link-settlement-design.md`

## Global Constraints

- Package manager is **Bun**. `bun run lint`, `bun run typecheck`, `bun run test` must all pass before any commit.
- **Never run `bun run gen:types`.** `src/integrations/supabase/database.types.ts` is hand-maintained despite looking generated; the generator clobbers 73 hand-written aliases. This plan adds no columns, so that file needs no change at all.
- Migrations are **manual SQL** in `db/migrations/`, ordered by leading number. The next free number is **107** — verify with `ls db/migrations | sort -V | tail -3` before creating it, because migration numbers are being added concurrently by the repo owner.
- Never edit an already-applied migration in place; re-issuing a function requires a **new** numbered migration.
- Money-path failures throw `Error`, never `Response`. A thrown `Response` in a TanStack Start server fn *resolves* the caller's `await` and fires its success toast while nothing happened.
- `src/routeTree.gen.ts` is generated — never edit.
- Baseline before this work: lint 0 errors / 17 warnings, typecheck clean, tests **1073 pass / 1 pre-existing fail** (`src/lib/serverPdf.test.ts` "returns a Buffer starting with %PDF-" times out on Windows — unrelated to this plan, do not attempt to fix it here).

---

### Task 1: Pure reconciliation decision

The rule that decides whether a blocked settlement may adopt existing payments. Extracted as a pure function so it is testable without mocking Supabase — the same idiom the repo already uses for `validateOptionListItemValue` in `src/lib/enumBackedOptionLists.ts`.

**Files:**
- Create: `src/lib/gatewayReconciliation.ts`
- Test: `src/lib/gatewayReconciliation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `manualPlaceholderReference(invoiceCode: string): string`, `classifyBlockingPayments(payments: BlockingPayment[]): ReconciliationDecision`, and the types `BlockingPayment` and `ReconciliationDecision`. Task 2 consumes all of these.

- [ ] **Step 1: Write the failing test**

Create `src/lib/gatewayReconciliation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  classifyBlockingPayments,
  manualPlaceholderReference,
  type BlockingPayment,
} from "./gatewayReconciliation";

function placeholder(invoiceCode: string, id = `id-${invoiceCode}`): BlockingPayment {
  return {
    id,
    code: `PAY-${invoiceCode}`,
    invoiceCode,
    reference: manualPlaceholderReference(invoiceCode),
  };
}

describe("manualPlaceholderReference", () => {
  it("matches the reference set_invoice_paid writes in migration 23", () => {
    expect(manualPlaceholderReference("INV-0000006")).toBe("AUTO-INV:INV-0000006");
  });
});

describe("classifyBlockingPayments", () => {
  it("returns none when nothing is blocking", () => {
    expect(classifyBlockingPayments([])).toEqual({ kind: "none" });
  });

  it("adopts when every blocking payment is an admin placeholder", () => {
    const payments = [placeholder("INV-0000006"), placeholder("INV-0000007")];
    expect(classifyBlockingPayments(payments)).toEqual({ kind: "adopt", payments });
  });

  it("refuses to adopt when any payment is a real staff-recorded payment", () => {
    const real: BlockingPayment = {
      id: "id-real",
      code: "PAY-0000009",
      invoiceCode: "INV-0000007",
      reference: "Cheque 4471",
    };
    const decision = classifyBlockingPayments([placeholder("INV-0000006"), real]);
    expect(decision).toEqual({ kind: "conflict", conflicting: real });
  });

  it("treats a null reference as a conflict, never as a placeholder", () => {
    const unreferenced: BlockingPayment = {
      id: "id-null",
      code: "PAY-0000010",
      invoiceCode: "INV-0000008",
      reference: null,
    };
    expect(classifyBlockingPayments([unreferenced])).toEqual({
      kind: "conflict",
      conflicting: unreferenced,
    });
  });

  it("does not adopt a placeholder that names a different invoice", () => {
    const crossed: BlockingPayment = {
      id: "id-crossed",
      code: "PAY-0000011",
      invoiceCode: "INV-0000008",
      reference: manualPlaceholderReference("INV-0000006"),
    };
    expect(classifyBlockingPayments([crossed])).toEqual({
      kind: "conflict",
      conflicting: crossed,
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun run test src/lib/gatewayReconciliation.test.ts`
Expected: FAIL — cannot resolve `./gatewayReconciliation`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/gatewayReconciliation.ts`:

```ts
/**
 * Deciding whether a blocked gateway settlement may adopt the payments that are
 * blocking it.
 *
 * `set_invoice_paid` (migration 23) is the ONLY writer of the reference
 * `AUTO-INV:<invoice code>`. A cash, cheque or transfer payment recorded by
 * staff goes through `createPayment` with an operator-entered reference and can
 * never carry that prefix. So the prefix means precisely "this row is a
 * placeholder created by the mark-paid checkbox, not evidence that money was
 * received here" — the same invariant that lets the un-mark path safely delete
 * these rows.
 *
 * That makes adoption safe and narrow: relabelling a placeholder to the real
 * gateway method corrects a record that was always a stand-in. Relabelling a
 * genuine second payment would instead hide a double payment, so anything that
 * is not exactly a placeholder for its own invoice is a conflict a human must
 * resolve.
 *
 * Pure by design — no Supabase, no IO — so the rule can be tested directly
 * rather than through the settlement path's mocks.
 */

export type BlockingPayment = {
  /** payments.id */
  id: string;
  /** payments.code, for operator-facing log lines. */
  code: string;
  /** Code of the invoice this payment is allocated to. */
  invoiceCode: string;
  /** payments.reference — nullable in the schema. */
  reference: string | null;
};

export type ReconciliationDecision =
  | { kind: "adopt"; payments: BlockingPayment[] }
  | { kind: "conflict"; conflicting: BlockingPayment }
  | { kind: "none" };

/** The reference `set_invoice_paid` stamps on the payment it creates. */
export function manualPlaceholderReference(invoiceCode: string): string {
  return `AUTO-INV:${invoiceCode}`;
}

/**
 * Classify the confirmed payments already allocated to a settlement's invoices.
 *
 * Every payment must be a placeholder *for its own invoice*: a placeholder
 * naming a different invoice is a sign the allocation was hand-edited, which is
 * exactly the situation not to guess about.
 */
export function classifyBlockingPayments(payments: BlockingPayment[]): ReconciliationDecision {
  if (payments.length === 0) return { kind: "none" };
  const conflicting = payments.find(
    (payment) => payment.reference !== manualPlaceholderReference(payment.invoiceCode),
  );
  if (conflicting) return { kind: "conflict", conflicting };
  return { kind: "adopt", payments };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run test src/lib/gatewayReconciliation.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gatewayReconciliation.ts src/lib/gatewayReconciliation.test.ts
git commit -m "feat(payments): pure rule for adopting admin placeholder payments"
```

---

### Task 2: Adopt placeholders in `settleGatewayPayment`

Replace the unconditional throw in the `work.length === 0` branch with the Task 1 decision.

**Files:**
- Modify: `src/fns/myfatoorahWebhook.ts` — the `work.length === 0` block inside `settleGatewayPayment` (currently around lines 440–460), plus two new helpers above it.
- Test: `src/fns/myfatoorahWebhook.test.ts`

**Interfaces:**
- Consumes: `classifyBlockingPayments` and the type `BlockingPayment` from Task 1 (`manualPlaceholderReference` is used only inside that module and by its tests — do not import it here). Existing module-local helpers `finalizePaymentRequest`, `invoicePaymentReference`, `orderedRequestInvoices`, and the imported `notifyPaymentSuccess`.
- Produces: no new exports. Task 3 relies only on `settleGatewayPayment` keeping its current signature `(details: EventDetails, payload: Json) => Promise<boolean>`.

- [ ] **Step 1: Add the two helpers**

Insert above `settleGatewayPayment` in `src/fns/myfatoorahWebhook.ts`:

```ts
/** Confirmed payments already allocated to these invoices, for the adoption rule. */
async function blockingPaymentsForInvoices(
  invoices: Tables<"invoices">[],
): Promise<BlockingPayment[]> {
  const invoiceCodeById = new Map(invoices.map((invoice) => [invoice.id, invoice.code]));
  const allocationQuery = await supabaseAdmin
    .from("payment_allocations")
    .select("invoice_id, payment_id, payments(id, code, reference, status)")
    .in(
      "invoice_id",
      invoices.map((invoice) => invoice.id),
    );
  if (allocationQuery.error) throw new Error(allocationQuery.error.message);

  const blocking: BlockingPayment[] = [];
  for (const allocation of allocationQuery.data ?? []) {
    const payment = allocation.payments as unknown as {
      id: string;
      code: string;
      reference: string | null;
      status: string;
    } | null;
    // A reversed payment is not holding the balance down and must not be adopted.
    if (!payment || payment.status !== "confirmed") continue;
    const invoiceCode = invoiceCodeById.get(allocation.invoice_id);
    if (!invoiceCode) continue;
    blocking.push({
      id: payment.id,
      code: payment.code,
      invoiceCode,
      reference: payment.reference,
    });
  }
  return blocking;
}

/**
 * Relabel admin placeholder payments as the gateway payments they always stood
 * in for. Amount, allocation and invoice state are untouched — no money moves,
 * this only corrects `method` and `reference` — and every relabel is audited.
 */
async function adoptPlaceholderPayments(
  payments: BlockingPayment[],
  method: PaymentMethod,
  referencePrefix: string,
): Promise<string[]> {
  const adopted: string[] = [];
  for (const payment of payments) {
    const nextReference = invoicePaymentReference(referencePrefix, payment.invoiceCode);
    const update = await supabaseAdmin
      .from("payments")
      .update({ method, reference: nextReference })
      .eq("id", payment.id);
    if (update.error) throw new Error(update.error.message);

    const audit = await supabaseAdmin.rpc("write_audit", {
      p_action: "payment.gateway_reconciled",
      p_entity_type: "payment",
      p_entity_id: payment.id,
      p_before: { method: "cash", reference: payment.reference },
      p_after: { method, reference: nextReference },
      p_result: "success",
      p_error_code: null,
    });
    if (audit.error) throw new Error(`Audit log write failed: ${audit.error.message}`);
    adopted.push(payment.id);
  }
  return adopted;
}
```

Add to the imports at the top of the file:

```ts
import {
  classifyBlockingPayments,
  type BlockingPayment,
} from "@/lib/gatewayReconciliation";
```

- [ ] **Step 2: Replace the throwing branch**

Find this block in `settleGatewayPayment`:

```ts
  if (work.length === 0) {
    // Every requested month is already paid (e.g. a newer PREQ settled one of
    // them). Mark this request completed so the callback stops erroring.
    const anyPayment = [...existingPayments.values()][0] ?? paymentRequest.resulting_payment_id;
    if (!anyPayment) {
      throw new Error(
        `Payment request ${paymentRequest.code} has nothing left to settle and no payment to attach.`,
      );
    }
    await finalizePaymentRequest({
      details: settledDetails,
      paymentId: anyPayment,
      paymentRequest,
      payload,
    });
    return false;
  }
```

Replace it with:

```ts
  if (work.length === 0) {
    // Every requested month is already paid. Two ways that happens: a newer PREQ
    // settled it (there is a gateway payment to attach), or an admin ticked
    // "mark as paid" while waiting for a settlement that never arrived (there is
    // a placeholder to adopt). Only the second needs the gateway's own method
    // written back over the placeholder's 'cash'.
    let anyPayment = [...existingPayments.values()][0] ?? paymentRequest.resulting_payment_id;
    let adoptedIds: string[] = [];

    if (!anyPayment) {
      const decision = classifyBlockingPayments(await blockingPaymentsForInvoices(invoices));
      if (decision.kind === "none") {
        throw new Error(
          `Payment request ${paymentRequest.code} has nothing left to settle and no payment to attach.`,
        );
      }
      if (decision.kind === "conflict") {
        // A real payment already covers this invoice AND the gateway charged the
        // tenant. That is a double payment, and choosing which one to refund is
        // a human decision — complete the request so the callback stops erroring,
        // but change nothing about the payment itself.
        console.error(
          "[settleGatewayPayment] gateway charge collides with an existing payment",
          JSON.stringify({
            paymentRequest: paymentRequest.code,
            conflictingPayment: decision.conflicting.code,
            conflictingReference: decision.conflicting.reference,
            invoice: decision.conflicting.invoiceCode,
          }),
        );
        anyPayment = decision.conflicting.id;
      } else {
        adoptedIds = await adoptPlaceholderPayments(
          decision.payments,
          settledDetails.method ?? "card",
          referencePrefix,
        );
        anyPayment = adoptedIds[0];
      }
    }

    await finalizePaymentRequest({
      details: settledDetails,
      paymentId: anyPayment,
      paymentRequest,
      payload,
    });

    // Adoption is the first moment this settlement is recorded as a gateway
    // payment, so it is also the first moment a receipt is owed.
    if (adoptedIds.length) {
      await makeReceiptsVisibleToTenant(adoptedIds);
      const notifyResult = await notifyPaymentSuccess(adoptedIds);
      if (!notifyResult.ok) {
        console.error("Payment notifications failed:", notifyResult.error);
      }
    }
    return false;
  }
```

- [ ] **Step 3: Write the tests**

Append to `src/fns/myfatoorahWebhook.test.ts`. The existing chainable `supabaseAdmin` mock at the top of that file cannot express these multi-table reads; add a separate describe block with its own `vi.mock` scope by creating the tests in a **new** file instead:

Create `src/fns/settleGatewayPaymentAdoption.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
const rpc = vi.fn();
const notifyPaymentSuccess = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => from(table),
    rpc: (name: string, args: unknown) => rpc(name, args),
  },
}));
vi.mock("@/fns/notifyPaymentSuccess", () => ({
  notifyPaymentSuccess: (ids: string[]) => notifyPaymentSuccess(ids),
}));

const { settleGatewayPayment } = await import("./myfatoorahWebhook");

const PREQ = {
  id: "preq-1",
  code: "PREQ-0000001",
  status: "pending",
  amount: "450.000",
  tenant_id: "tenant-1",
  requested_invoice_ids: ["inv-1"],
  provider_invoice_id: "7050025",
  provider_payment_id: null,
  resulting_payment_id: null,
  gateway_response: null,
};

const INVOICE = {
  id: "inv-1",
  code: "INV-0000006",
  balance: "0.000",
  total: "450.000",
  tenant_id: "tenant-1",
  unit_id: "unit-1",
};

/**
 * Minimal PostgREST-shaped stub. Each table returns a thenable whose resolved
 * value is supplied per test, which is enough for the read-only paths the
 * adoption branch takes.
 */
function stubTables(overrides: Record<string, unknown>) {
  from.mockImplementation((table: string) => {
    const result = overrides[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "update", "eq", "in", "order", "limit"]) {
      chain[method] = () => chain;
    }
    chain.single = async () => result;
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  notifyPaymentSuccess.mockResolvedValue({ ok: true });
});

describe("settleGatewayPayment adoption branch", () => {
  it("adopts an AUTO-INV placeholder, relabels it knet, and notifies", async () => {
    stubTables({
      payment_requests: { data: PREQ, error: null },
      invoices: { data: [INVOICE], error: null },
      payments: { data: [], error: null },
      payment_allocations: {
        data: [
          {
            invoice_id: "inv-1",
            payment_id: "pay-1",
            payments: {
              id: "pay-1",
              code: "PAY-0000006",
              reference: "AUTO-INV:INV-0000006",
              status: "confirmed",
            },
          },
        ],
        error: null,
      },
      receipts: { data: { id: "rcpt-1" }, error: null },
    });

    await settleGatewayPayment(
      {
        eventType: "cron.reconcile",
        invoiceId: "7050025",
        method: "knet",
        paymentId: "100621810000012471",
        providerEventId: "reconcile:PREQ-0000001",
        status: "Paid",
      },
      {},
    );

    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({ p_action: "payment.gateway_reconciled" }),
    );
    expect(notifyPaymentSuccess).toHaveBeenCalledWith(["pay-1"]);
  });

  it("does not adopt or notify when a real payment collides", async () => {
    stubTables({
      payment_requests: { data: PREQ, error: null },
      invoices: { data: [INVOICE], error: null },
      payments: { data: [], error: null },
      payment_allocations: {
        data: [
          {
            invoice_id: "inv-1",
            payment_id: "pay-9",
            payments: {
              id: "pay-9",
              code: "PAY-0000009",
              reference: "Cheque 4471",
              status: "confirmed",
            },
          },
        ],
        error: null,
      },
      receipts: { data: { id: "rcpt-9" }, error: null },
    });

    await settleGatewayPayment(
      {
        eventType: "cron.reconcile",
        invoiceId: "7050025",
        method: "knet",
        paymentId: "1006218",
        providerEventId: "reconcile:PREQ-0000001",
        status: "Paid",
      },
      {},
    );

    expect(rpc).not.toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({ p_action: "payment.gateway_reconciled" }),
    );
    expect(notifyPaymentSuccess).not.toHaveBeenCalled();
  });

  it("still throws when nothing at all is allocated", async () => {
    stubTables({
      payment_requests: { data: PREQ, error: null },
      invoices: { data: [INVOICE], error: null },
      payments: { data: [], error: null },
      payment_allocations: { data: [], error: null },
    });

    await expect(
      settleGatewayPayment(
        {
          eventType: "cron.reconcile",
          invoiceId: "7050025",
          method: "knet",
          paymentId: "1006218",
          providerEventId: "reconcile:PREQ-0000001",
          status: "Paid",
        },
        {},
      ),
    ).rejects.toThrow(/nothing left to settle/);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `bun run test src/fns/settleGatewayPaymentAdoption.test.ts src/fns/myfatoorahWebhook.test.ts`
Expected: PASS. If the stub shape does not satisfy the real query chain, adjust `stubTables` — do **not** change production code to suit the mock.

- [ ] **Step 5: Full gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/fns/myfatoorahWebhook.ts src/fns/settleGatewayPaymentAdoption.test.ts
git commit -m "fix(payments): adopt admin placeholder payments instead of failing settlement"
```

---

### Task 3: Reconciliation job

**Files:**
- Modify: `src/fns/confirmGatewayPayment.ts` — export `paymentOutcome` (currently module-private at line 127).
- Create: `src/fns/paymentReconcileJob.ts`
- Test: `src/fns/paymentReconcileJob.test.ts`

**Interfaces:**
- Consumes: `fetchGatewayPaymentStatus` and the newly exported `paymentOutcome` from `src/fns/confirmGatewayPayment.ts`; `gatewayConfigFromEnv` from `src/fns/myfatoorahGateway.ts`; `settleGatewayPayment` from `src/fns/myfatoorahWebhook.ts`.
- Produces: `runPaymentReconcileJob(asOf?: string | null): Promise<{ count: number; settled: number; failed: number; errors: string[] }>`. Task 4 registers this exact function in the `JOBS` map.

- [ ] **Step 1: Export `paymentOutcome`**

In `src/fns/confirmGatewayPayment.ts` change:

```ts
function paymentOutcome(invoiceStatus: string | null, transactionStatus: string | null) {
```

to:

```ts
/**
 * Exported so the reconciliation job classifies gateway status with the same
 * vocabulary the callback uses. Two copies of this list would drift, and the
 * drift would show up as "the portal says paid, the job says pending".
 */
export function paymentOutcome(invoiceStatus: string | null, transactionStatus: string | null) {
```

- [ ] **Step 2: Write the failing test**

Create `src/fns/paymentReconcileJob.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const pendingRequests = vi.fn();
const updateRequest = vi.fn();
const rpc = vi.fn();
const fetchGatewayPaymentStatus = vi.fn();
const settleGatewayPayment = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          not: () => ({
            gt: () => ({ order: () => pendingRequests() }),
          }),
        }),
      }),
      update: (values: unknown) => ({ eq: (_c: string, id: string) => updateRequest(values, id) }),
    }),
    rpc: (name: string, args: unknown) => rpc(name, args),
  },
}));
vi.mock("@/fns/myfatoorahGateway", () => ({
  gatewayConfigFromEnv: () => ({ apiKey: "k", baseUrl: "https://apitest.myfatoorah.com" }),
}));
vi.mock("@/fns/confirmGatewayPayment", async () => {
  const actual = await vi.importActual<typeof import("./confirmGatewayPayment")>(
    "./confirmGatewayPayment",
  );
  return {
    paymentOutcome: actual.paymentOutcome,
    fetchGatewayPaymentStatus: (...a: unknown[]) => fetchGatewayPaymentStatus(...a),
  };
});
// normalizeMethod must come from the real module: the job imports it from here
// too, and a mock that omits it would make the job import `undefined` and throw
// at call time rather than at import time — a failure that looks like a logic bug.
vi.mock("@/fns/myfatoorahWebhook", async () => {
  const actual = await vi.importActual<typeof import("./myfatoorahWebhook")>("./myfatoorahWebhook");
  return {
    normalizeMethod: actual.normalizeMethod,
    settleGatewayPayment: (...a: unknown[]) => settleGatewayPayment(...a),
  };
});

const { runPaymentReconcileJob } = await import("./paymentReconcileJob");

function request(code: string, providerInvoiceId: string) {
  return { id: `id-${code}`, code, provider_invoice_id: providerInvoiceId };
}

function gatewayStatus(invoiceStatus: string, transactionStatus: string) {
  return {
    error: null,
    invoiceId: "7050025",
    invoiceStatus,
    methodRaw: "KNET",
    providerPaymentId: "100621810000012471",
    raw: {},
    transactionStatus,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  updateRequest.mockResolvedValue({ error: null });
  settleGatewayPayment.mockResolvedValue(false);
});

describe("runPaymentReconcileJob", () => {
  it("settles a pending request the gateway reports paid", async () => {
    pendingRequests.mockResolvedValue({ data: [request("PREQ-0000001", "7050025")], error: null });
    fetchGatewayPaymentStatus.mockResolvedValue(gatewayStatus("Paid", "Success"));

    const result = await runPaymentReconcileJob();

    expect(result).toMatchObject({ count: 1, settled: 1, failed: 0 });
    expect(settleGatewayPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cron.reconcile",
        method: "knet",
        providerEventId: "reconcile:PREQ-0000001",
      }),
      expect.anything(),
    );
  });

  it("marks a failed charge failed so it stops being polled", async () => {
    pendingRequests.mockResolvedValue({ data: [request("PREQ-0000002", "7050057")], error: null });
    fetchGatewayPaymentStatus.mockResolvedValue(gatewayStatus("Pending", "Failed"));

    const result = await runPaymentReconcileJob();

    expect(result).toMatchObject({ count: 1, settled: 0, failed: 1 });
    expect(updateRequest).toHaveBeenCalledWith({ status: "failed" }, "id-PREQ-0000002");
    expect(settleGatewayPayment).not.toHaveBeenCalled();
  });

  it("leaves a still-pending charge untouched", async () => {
    pendingRequests.mockResolvedValue({ data: [request("PREQ-0000003", "7050059")], error: null });
    fetchGatewayPaymentStatus.mockResolvedValue(gatewayStatus("Pending", "Pending"));

    const result = await runPaymentReconcileJob();

    expect(result).toMatchObject({ count: 1, settled: 0, failed: 0 });
    expect(updateRequest).not.toHaveBeenCalled();
    expect(settleGatewayPayment).not.toHaveBeenCalled();
  });

  it("keeps going when one request throws", async () => {
    pendingRequests.mockResolvedValue({
      data: [request("PREQ-0000001", "7050025"), request("PREQ-0000002", "7050057")],
      error: null,
    });
    fetchGatewayPaymentStatus
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce(gatewayStatus("Paid", "Success"));

    const result = await runPaymentReconcileJob();

    expect(result.settled).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("PREQ-0000001");
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun run test src/fns/paymentReconcileJob.test.ts`
Expected: FAIL — cannot resolve `./paymentReconcileJob`.

- [ ] **Step 4: Write the implementation**

Create `src/fns/paymentReconcileJob.ts`:

```ts
import { fetchGatewayPaymentStatus, paymentOutcome } from "@/fns/confirmGatewayPayment";
import { gatewayConfigFromEnv } from "@/fns/myfatoorahGateway";
import { normalizeMethod, settleGatewayPayment } from "@/fns/myfatoorahWebhook";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Reconcile payment requests the gateway settled but the app never heard about.
 *
 * Settlement is otherwise reachable only from `confirmGatewayPayment`, which
 * needs an authenticated browser sitting on the portal callback page. A tenant
 * who pays a link without signing in — or who simply closes the tab — leaves the
 * money taken and the invoice unpaid, with no path that ever corrects it. The
 * webhook was meant to be that path and has never fired once in production.
 *
 * So this job is the liveness guarantee for the whole gateway money path, not a
 * convenience. It is idempotent: `settleGatewayPayment` returns immediately for
 * a request already marked completed.
 */
const RECONCILE_WINDOW_DAYS = 7;

export async function runPaymentReconcileJob(_asOf: string | null = null) {
  const config = gatewayConfigFromEnv();
  const since = new Date(Date.now() - RECONCILE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Bounded window: an abandoned link should not cost a gateway round-trip on
  // every tick for the rest of time.
  const pending = await supabaseAdmin
    .from("payment_requests")
    .select("id, code, provider_invoice_id")
    .eq("status", "pending")
    .not("provider_invoice_id", "is", null)
    .gt("created_at", since)
    .order("created_at");
  if (pending.error) throw new Error(pending.error.message);

  const requests = pending.data ?? [];
  const errors: string[] = [];
  let settled = 0;
  let failed = 0;

  for (const request of requests) {
    try {
      const status = await fetchGatewayPaymentStatus(config, request.provider_invoice_id as string);
      const outcome = paymentOutcome(status.invoiceStatus, status.transactionStatus);

      if (outcome === "paid") {
        await settleGatewayPayment(
          {
            eventType: "cron.reconcile",
            invoiceId: status.invoiceId,
            method: normalizeMethod(status.methodRaw) ?? "card",
            paymentId: status.providerPaymentId,
            providerEventId: `reconcile:${request.code}`,
            status: status.invoiceStatus ?? status.transactionStatus ?? "PAID",
          },
          status.raw,
        );
        settled += 1;
        continue;
      }

      if (outcome === "failed") {
        const update = await supabaseAdmin
          .from("payment_requests")
          .update({ status: "failed" })
          .eq("id", request.id);
        if (update.error) throw new Error(update.error.message);
        failed += 1;
      }
      // "pending" means the tenant may still be mid-payment — leave it alone.
    } catch (error) {
      // One unreachable request must not stop the rest: a gateway blip would
      // otherwise strand every later request until the next tick.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${request.code}: ${message}`);
      console.error("[paymentReconcileJob] request failed", request.code, message);
    }
  }

  await supabaseAdmin.rpc("write_audit", {
    p_action: "job.payment_reconcile",
    p_entity_type: "payment_request",
    p_entity_id: null,
    p_before: null,
    p_after: { count: requests.length, settled, failed, errors: errors.length },
    p_result: errors.length ? "failure" : "success",
    p_error_code: errors.length ? "RECONCILE_PARTIAL_FAILURE" : null,
  });

  return { count: requests.length, settled, failed, errors };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun run test src/fns/paymentReconcileJob.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
bun run lint && bun run typecheck
git add src/fns/paymentReconcileJob.ts src/fns/paymentReconcileJob.test.ts src/fns/confirmGatewayPayment.ts
git commit -m "feat(payments): reconciliation job settles payment requests without a browser"
```

---

### Task 4: Register the job

**Files:**
- Modify: `src/fns/cronJobs.ts` — the `JOBS` map and the doc comment above it.
- Test: `src/fns/cronJobs.test.ts`

**Interfaces:**
- Consumes: `runPaymentReconcileJob` from Task 3.
- Produces: the cron job name `payment-reconcile`, used by Task 5's migration and crontab line.

- [ ] **Step 1: Write the failing test**

Add to `src/fns/cronJobs.test.ts` — first add the mock alongside the existing ones near the top:

```ts
const reconcile = vi.fn();
vi.mock("@/fns/paymentReconcileJob", () => ({
  runPaymentReconcileJob: (...a: unknown[]) => reconcile(...a),
}));
```

then append this describe block:

```ts
describe("payment-reconcile job", () => {
  it("is routable from the cron endpoint", async () => {
    reconcile.mockResolvedValue({ count: 1, settled: 1, failed: 0, errors: [] });

    const response = await respondToCronRequest(cronRequest("payment-reconcile"));

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/fns/cronJobs.test.ts`
Expected: FAIL with 400 and "Unknown job".

- [ ] **Step 3: Register the job**

In `src/fns/cronJobs.ts` add the import:

```ts
import { runPaymentReconcileJob } from "@/fns/paymentReconcileJob";
```

add to the `JOBS` map:

```ts
  // The liveness guarantee for gateway payments: settlement is otherwise only
  // reachable from an authenticated browser on the portal callback page.
  // Idempotent — settleGatewayPayment returns early for a completed request.
  "payment-reconcile": runPaymentReconcileJob,
```

and add this bullet to the idempotency list in the doc comment above `JOBS`:

```
 * - payment-reconcile: settleGatewayPayment returns early for a payment request
 *   already marked completed, so a repeated tick cannot double-settle.
```

- [ ] **Step 4: Run the tests**

Run: `bun run test src/fns/cronJobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fns/cronJobs.ts src/fns/cronJobs.test.ts
git commit -m "feat(cron): register payment-reconcile job"
```

---

### Task 5: Migration and runbook

**Files:**
- Create: `db/migrations/107_payment_reconcile_job.sql` (confirm 107 is still free first)
- Modify: `deploy/README.md` — the crontab block around lines 114–120

**Interfaces:**
- Consumes: the job key `payment-reconcile` from Task 4.
- Produces: a `cron_jobs` row giving the job a pause switch in Settings → Cron.

- [ ] **Step 1: Confirm the migration number is free**

Run: `ls db/migrations | sort -V | tail -3`
If 107 is taken, use the next free number and rename consistently in this task.

- [ ] **Step 2: Write the migration**

Create `db/migrations/107_payment_reconcile_job.sql`:

```sql
-- ---------------------------------------------------------------------------
-- 107 - payment reconciliation job
-- ---------------------------------------------------------------------------
--
-- Registers the `payment-reconcile` scheduled job so it appears in
-- Settings > Cron with a pause switch, the same as every other cron entry.
--
-- Why this job exists: settleGatewayPayment is otherwise reachable only from
-- confirmGatewayPayment, which requires an authenticated browser sitting on
-- /portal/payments/callback. A tenant who pays a payment link without signing
-- in, or who closes the tab, leaves money taken and the invoice unpaid with no
-- path that ever corrects it. The MyFatoorah webhook was meant to be that path
-- and had not fired once in production as of 2026-08-06 (webhook_events was
-- empty). This job is the backstop that does not depend on either.
--
-- `do update` deliberately does NOT touch is_active: replaying this migration
-- must never silently re-enable a job an admin switched off.

insert into public.cron_jobs (
  key, kind, name_ar, name_en, description_ar, description_en
)
values
  (
    'payment-reconcile', 'scheduled',
    'تسوية مدفوعات البوابة',
    'Payment reconciliation',
    'يتحقق من طلبات الدفع المعلقة لدى ماي فاتورة ويسوّي المدفوعة منها.',
    'Polls pending payment requests against MyFatoorah and settles the paid ones.'
  )
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;
```

- [ ] **Step 3: Verify the migration against a clean database**

Run: `bun run test:sql`
Expected: PASS. This builds a database from scratch and applies every migration in order, so it catches both a bad number and bad SQL.

- [ ] **Step 4: Add the crontab line**

In `deploy/README.md`, add below the `salaries` line in the crontab block:

```
5-59/10 * * * * curl -fsS -X POST https://danat-future.com/api/public/cron -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" -d '{"job":"payment-reconcile"}'
```

Add a sentence above the block noting the offset: `payment-reconcile` runs every 10 minutes at :05, :15, :25… deliberately staggered off `gmail-sync`, which runs at :00, :10, :20. A tenant paying a link should not wait an hour for the invoice to update.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/107_payment_reconcile_job.sql deploy/README.md
git commit -m "feat(db): register payment-reconcile in cron_jobs and the runbook"
```

---

### Task 6: Diagnose an unconfigured webhook

**Files:**
- Modify: `src/fns/myfatoorahWebhook.ts` — the 503 branch of `respondToMyFatoorahWebhook`
- Test: `src/fns/myfatoorahWebhook.test.ts` — the existing "returns 503" test

**Interfaces:**
- Consumes: nothing. Produces: nothing. Behaviour-preserving except for the log line.

- [ ] **Step 1: Extend the existing 503 test**

In `src/fns/myfatoorahWebhook.test.ts`, replace the body of the existing test `"returns 503 if MYFATOORAH_WEBHOOK_SECRET is not configured"` with:

```ts
    delete process.env.MYFATOORAH_WEBHOOK_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const request = new Request("https://example.com/api/myfatoorah-webhook", {
      method: "POST",
      body: JSON.stringify({ Data: { PaymentId: "123" } }),
    });

    const response = await respondToMyFatoorahWebhook(request);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("webhook secret is not configured");
    // A silent 503 is how this stayed broken: the gateway retries, gives up,
    // and nothing in the logs says the endpoint was ever reached.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MYFATOORAH_WEBHOOK_SECRET"));

    warn.mockRestore();
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/fns/myfatoorahWebhook.test.ts`
Expected: FAIL — `console.warn` was not called.

- [ ] **Step 3: Add the warning**

In `respondToMyFatoorahWebhook`, change:

```ts
  const webhookSecret = process.env.MYFATOORAH_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return Response.json(
      { error: "MyFatoorah webhook secret is not configured." },
      { status: 503 },
    );
  }
```

to:

```ts
  const webhookSecret = process.env.MYFATOORAH_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Fail closed — this endpoint settles money and must never run unverified.
    // But say so out loud: MyFatoorah retries a 503 a few times and then stops,
    // so an unconfigured webhook is otherwise indistinguishable from one that
    // was never called, which is exactly how this went unnoticed in production.
    console.warn(
      "[myfatoorahWebhook] rejected a webhook because MYFATOORAH_WEBHOOK_SECRET is not set",
    );
    return Response.json(
      { error: "MyFatoorah webhook secret is not configured." },
      { status: 503 },
    );
  }
```

- [ ] **Step 4: Run the tests**

Run: `bun run test src/fns/myfatoorahWebhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/fns/myfatoorahWebhook.ts src/fns/myfatoorahWebhook.test.ts
git commit -m "fix(payments): log when the webhook is rejected as unconfigured"
```

Expected final test count: baseline 1073 passing plus 13 new, with the one
pre-existing `serverPdf.test.ts` failure still present and untouched.

---

## Deployment order

The repo auto-deploys on push to `main`, and the app would then be running
against a database that has not seen migration 107. So:

1. Apply `db/migrations/107_payment_reconcile_job.sql` to the live Supabase
   container (`danatfuture-supabase-ozoxsa-db-1`) **first**.
2. Notify PostgREST to reload its schema cache.
3. Then push / merge.
4. Add the crontab line to `/etc/cron.d/danat-ermp` on the production host.
5. Run the job once by hand and confirm `PREQ-0000001/2/3` reach a terminal
   status, that `INV-0000006`'s payment reads method `knet` with an `MF:`
   reference, and that `notifications` rows exist for admin, company and tenant.

Note that SSH exec caps at ~1000 characters, so transfer the migration in
chunked base64 with an md5 check rather than a single heredoc.

## Not in this plan

- Setting `MYFATOORAH_WEBHOOK_SECRET` and registering the webhook URL in the
  MyFatoorah dashboard — operator actions, not code.
- Task 6 of the overall request (manual payment reason, Method of Payment
  column). It depends on this landing first because it must write
  `payment_method` from the gateway path as well as the manual path.
- Resolving a genuine double payment. This plan detects and logs it; deciding
  what to refund is a human call.
