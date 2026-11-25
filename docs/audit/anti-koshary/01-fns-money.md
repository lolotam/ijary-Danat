# S01 — `src/fns`: money & contract lifecycle

**Lines read:** ~2,960 · **Files:** 23 · **Date:** 2026-09-22

Files: `myfatoorahWebhook.ts` (972), `createPayment.ts` (586), `confirmGatewayPayment.ts` (373),
`setInvoicePaid.ts` (124), `paymentReconcileJob.ts` (115), `closeOutContract.ts` (93),
`regenerateContractInvoices.ts` (92), `myfatoorahGateway.ts` (69), `setInvoiceDispute.ts` (60),
`restoreContract.ts` (58), `writeOffInvoice.ts` (51), `applyAllocation.ts` (47),
`evaluateOverdue.ts` (46), `reversePayment.ts` (44), `salariesJob.ts` (43),
`backfillContractInvoices.ts` (42), `syncContractSchedule.ts` (39), `generateInvoices.ts` (38),
`generateElectricityCharges.ts` (31), `previewContractCloseout.ts` (30), `voidRefund.ts` (28),
`reverseRefund.ts` (28), `cancelContractCloseout.ts` (28).

**Overall:** this is the best-documented code in the repo — Arabic doc comments, *why*
rather than *what*, incidents named in the prose. The findings below are almost all
**drift**: a rule this codebase already identified, fixed in one place, and left standing
in others. That is the koshary shape here, not sloppiness.

---

## Findings

### 1 · High — a failed gateway settlement shows the tenant a blank confirmation page

**Where:** `src/fns/confirmGatewayPayment.ts:151,254,274,286,316,361` → `src/routes/portal_.payments.callback.tsx:117-128,178`

`confirmGatewayPayment` throws `new Response(...)` on **every** failure path: 502 gateway
lookup, 403 not-your-tenant, 404 no matching request, 400 missing reference, and — the one
that matters — 500 when `settleGatewayPayment` throws after the tenant's card has already
been charged.

This codebase has documented three times (`deleteAppUser.ts:13-19`, `setInvoicePaid.ts:57-63`,
`resendMailboxSend.ts:131-133`) that TanStack Start marks a thrown `Response` `x-tss-raw`
and the client **resolves** it. So the chain is:

```
settle throws  ->  throw new Response(500)  ->  mutation RESOLVES
-> onSuccess(result)  ->  setState(result.status)   // result.status === 500, a number
-> CallbackState is "checking"|"paid"|"pending"|"failed"|"missing"|"signin"|"error"
-> 500 matches no branch  ->  onError never runs
```

**Which means:** the tenant lands on a card showing only the page title and two navigation
buttons — no icon, no message, not even the "unknown" fallback (that needs
`state === "error"`). Their money is gone, the invoice is unpaid, and the screen says
nothing at all. `paymentReconcileJob` will correct the ledger within a day, but the tenant
sees a blank page in the meantime and has no reason to believe anything failed.

**Fix:** `throw new Error(message)` on every path in this handler, as `createPayment.ts`
and `closeOutContract.ts` already do. Optionally guard `setState` so a non-union value
falls back to `"error"` — defence in depth for the next one.

---

### 2 · High — eight money server fns still report a permission denial as success

**Where:** `applyAllocation.ts:34` · `reversePayment.ts:29` · `evaluateOverdue.ts:39` ·
`generateInvoices.ts:30` · `backfillContractInvoices.ts:35` · `regenerateContractInvoices.ts:85` ·
`generateElectricityCharges.ts:22` · `confirmGatewayPayment.ts:254` · (also
`myfatoorahGateway.ts:13`, reached from `createPayment`)

Same `x-tss-raw` mechanism as finding 1. `src/routes/admin.payments.tsx:419-428` is the
clearest case: `await reversePayment.mutateAsync(...)` resolves,
`toast.success("payments.reversed")` fires, caches are invalidated — and nothing was
reversed.

**Which means:** an operator whose permission was revoked mid-session, or whose client-side
permission cache is stale, sees "Payment reversed" / "Invoices generated" and a refreshed
table still showing the old state. They will conclude the UI is broken, not that they were
refused.

*Honest mitigation:* the hooks carry a client-side `permissions.can(...)` pre-check
(`useReversePayment.ts:13`, `useContractCloseouts.ts:287`), so this only fires when client
and server disagree. It does not fire for `myfatoorahGateway.ts:13` — an unset
`MYFATOORAH_API_KEY` resolves as success and the portal redirects to `undefined`.

**Fix:** `throw new Error(...)` in all nine, matching the six files already converted.
**Repo-wide this pattern is in 33 files** — the rest are counted in S18; do not fix them
piecemeal from this report.

---

### 3 · High — every write-off and dispute writes two audit rows, under two different names

**Where:** `src/hooks/useContractCloseouts.ts:291-297,314-322` vs
`db/migrations/86_invoice_dispute_and_write_off.sql:88,155,215`

Migration 86 already calls `write_audit` inside `write_off_invoice`, `set_invoice_dispute`
and `clear_invoice_dispute`. The hook then calls `logAuditForCurrentSession` from the
browser for the same action.

| Event | SQL writes | Browser also writes |
| --- | --- | --- |
| Write-off | `invoice.write_off` | `invoice.write_off` |
| Dispute | `invoice.dispute` | `invoice.dispute` |
| Clear dispute | `invoice.dispute_clear` | **`invoice.clear_dispute`** |

**Which means:** two things at once. Every UI write-off appears twice in the audit trail,
and a clear-dispute appears under two *different* action names — so any report or filter
keyed on one name silently misses half the events. The browser-written row is also
forgeable and absent when the server fn is called directly, which is exactly the reasoning
`useReversePayment.ts:14-18` gives for having removed the identical client-side write in
PR #206. That fix was applied to reversal and not to these two.

**Fix:** delete the `logAuditForCurrentSession` calls from `useWriteOffInvoice` and
`useSetInvoiceDispute`. The SQL rows are already richer — they carry the full before-row.

---

### 4 · Medium — the fils rounding rule lives in eight places under four names

**Where:** `myfatoorahWebhook.ts:427` (`asMoney`) · `lib/invoiceSettlement.ts:19` (`roundMoney`) ·
`lib/extraChargeWaiver.ts:57` (`round3`) · `createPayment.ts:301,344` (inline) ·
`lib/invoiceExtraCharges.ts:123` · `lib/portalPaymentContracts.ts:64` ·
`lib/portalPaymentFold.ts:112` — all `Math.round(v * 1000) / 1000`.

One rule: *match `numeric(14,3)`, because KWD has three decimals and the screen and the
database must agree on whether a balance is settled* — stated well in
`extraChargeWaiver.ts:50-56`. `src/lib/money.ts` exists but is **explicitly the display
boundary only** (truncation to whole KWD) and exports no rounding helper, so the rule had
nowhere to live and got re-derived at each site.

**Which means:** if the rounding ever has to change — a different precision, or a half-even
fix to match Postgres exactly — it is eight edits across `fns`, `lib` and the portal fold,
and the one that gets missed produces a balance the UI calls settled and the database does
not.

**Fix:** export `roundToFils` from a new `src/lib/fils.ts` — not `money.ts`, whose docblock
draws the display/precision line deliberately — and have all eight call it. Keep `asMoney`'s
extra `Number.isFinite` guard as a separate PostgREST-coercion wrapper over it.

---

### 5 · Medium — `myfatoorahWebhook.ts` is five modules in one file (972 lines)

**Where:** `src/fns/myfatoorahWebhook.ts`

Five responsibilities, each with its own reason to change:

1. **Payload normalization** — `eventDetails`, `nestedString`, `normalizeMethod` (v2/v3 shapes)
2. **Signature verification** — `SIGNATURE_FIELDS_BY_EVENT`, `canonicalSignatureString`, `verifySignature`
3. **Idempotency / `webhook_events`** — `claimWebhookEvent`, `markEvent`
4. **The settlement engine** — `settleGatewayPayment` plus ~10 helpers (~400 lines)
5. **HTTP transport** — `respondToMyFatoorahWebhook`

**Which means:** the settlement engine is the app's only path from "the gateway took money"
to "the invoice is paid", and it is reachable only by importing an HTTP webhook module.
`paymentReconcileJob.ts:3` (a cron job) and `confirmGatewayPayment.ts:15` (the portal
callback) both do exactly that, pulling in signature verification and `Response`-building
they have no use for. It also breaches the repo's own 500–600 line ceiling by 60%.

**Fix:** split into `src/fns/gatewaySettlement.ts` (responsibility 4 — the part two other
callers actually want), `src/lib/myfatoorahSignature.ts` (2, already pure), leaving 1+3+5
in the webhook module. Mechanical: no call-site changes beyond imports. `valueAtPath` and
`nestedString` must **not** be merged — the file already explains why at lines 164-172 —
and the signature module must own `valueAtPath`.

---

### 6 · Medium — the permission preamble is copy-pasted 48 times in three incompatible variants

**Where:** `rpc("has_permission")` appears in **48** files under `src/fns`; only **9** call
`recordPermissionDenied`.

Three variants, all visible inside this scope alone:

| Variant | Example | Records the denial? | Reports correctly? |
| --- | --- | --- | --- |
| `Response(403)` + `recordPermissionDenied` | `applyAllocation.ts:20-35` | yes | **no** (finding 2) |
| `Response(403)`, no audit | `generateElectricityCharges.ts:18-22` | no | **no** |
| `throw new Error("Forbidden")`, no audit | `closeOutContract.ts:26-31`, `writeOffInvoice.ts:27` | no | yes |

**Which means:** the two corrections this codebase has already decided on — report denials
as `Error`, and record them in `permission_denials` — each landed in a different subset of
the 48, and no file has both. Any fix to this block costs 48 edits, which is precisely why
neither correction is finished.

**Fix:** one `requirePermission(context, code, attempted, entity?)` helper that runs the
RPC, records the denial, and throws an `Error`. Same three arguments everywhere, so this is
not a premature abstraction — it is an existing rule written once. Do `src/fns` in a single
pass, not per-file. Exact per-file variant counts belong to S18.

---

### 7 · Medium — "which notification skip is benign" is written out five times, and a sixth list disagrees

**Where:** `closeOutContract.ts:64-67,76-79` · `restoreContract.ts:43-46` ·
`setInvoiceDispute.ts:45-48` · `writeOffInvoice.ts:36-39` — each repeating

```ts
notifyResult.skipped &&
  notifyResult.reason !== "Already notified." &&
  notifyResult.reason !== "Workflow is paused."
```

…against string literals produced by the five senders, while
`src/components/admin/WorkflowTable.tsx:45-47` documents a **different** benign set
(`"Already notified."`, `"No confirmed payments."`).

All five senders currently emit exactly three reasons, so nothing is broken *today* — this
is the bug that has not happened yet. **Which means:** a sender gaining a fourth benign
reason needs five caller edits plus the table, and the one that gets missed raises a warning
toast on a perfectly normal outcome.

**Fix:** have the senders return `benign: boolean` — they know why they skipped — and let
callers test that, instead of five string comparisons against literals they do not own.

---

### 8 · Medium — `notificationWarning` is computed carefully and then thrown away

**Where:** `writeOffInvoice.ts:50` and `setInvoiceDispute.ts:59` return it; **nothing reads
it.** `closeOutContract.ts` and `restoreContract.ts` return it and the two callers that do
read it (`admin.contracts_.$id.closeout.tsx:374`, `admin.contracts.tsx:231`) test only
truthiness and show a fixed translated string.

**Which means:** the diagnostic that distinguishes "no admin recipients are configured" from
"the mail provider failed" is built on every close-out, sent over the wire, and discarded.
An operator seeing the generic warning cannot tell a misconfiguration they can fix from an
outage they cannot. This is the repo's recurring written-but-never-read shape.

**Fix:** either surface it — a translated map keyed on a returned reason *code*, never the
English string — or drop the computation from the two fns that have no reader. Not both
halves in different files.

---

## Not reported, and why

- **`createPayment.ts` at 586 lines** — over the soft ceiling, but every function has one
  job and the file reads top-to-bottom as a single pipeline. Splitting it would scatter one
  transaction across files for no gain.
- **`orderedRequestInvoices` / `existingPaymentsByReference` / `paymentIsAllocated` each
  running their own query** — not an N+1; they are bulk `.in(...)` reads. The per-invoice
  re-read inside `settleGatewayPayment`'s loop *is* per-row, but deliberately so (concurrent
  settlement safety), and is bounded by the months in one payment request.
- **`isRecord` defined in both `myfatoorahWebhook.ts` and `resendWebhook.ts`** — four lines,
  two unrelated webhook parsers. Coincidental; merging would couple them.
- **The two-encoding HMAC fallback** (`verifySignature`) — looks like duplication, is a
  documented deliberate probe with a stated plan to narrow it.

## Test coverage of this scope

Good, with one structural hole. `myfatoorahWebhook.test.ts`, `settleGatewayPaymentAdoption.test.ts`,
`confirmGatewayPayment.test.ts`, `paymentReconcileJob.test.ts` and `createPayment.test.ts` all
exist and exercise the real settlement paths.

**The hole:** the shared `createServerFn` mock never runs `.validator()`, so no Zod schema in
this scope executes under test. The code knows it — `setInvoicePaid.ts:8-13`,
`createPayment.ts:26-29` and `createPayment.ts:207-217` each export their schema or rule
specifically so it can be asserted directly. `applyAllocation`, `reversePayment`,
`evaluateOverdue`, `generateInvoices`, `backfillContractInvoices`, `regenerateContractInvoices`,
`syncContractSchedule` and `generateElectricityCharges` keep their schemas **unexported**, so
their input validation is asserted by nothing.

**Consequence for Pass 2:** findings 1, 2 and 3 change observable behaviour on paths the tests
do not cover — the client-side resolve is a runtime TanStack behaviour the `createServerFn`
mock does not reproduce. Do not call those changes "safe" on a green suite; they need a manual
check in the running app, or a test at the `useServerFn` boundary.

## Ledger entries added

See `LEDGER.md` — fils rounding, the permission preamble, the benign-skip list, the
`Response`-on-denial pattern, `logAuditForCurrentSession`, `notificationWarning`.
