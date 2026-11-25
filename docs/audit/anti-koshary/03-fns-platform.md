# S03 — `src/fns`: messaging, jobs, users, backup, public surface

**Lines read:** ~9,200 · **Files:** 42 · **Date:** 2026-09-22

Files include: `gmailSend.ts` (360), `contractExpiryJob.ts` (354), `whatsappChat.ts` (335),
`bulkImport.ts` (330), `evolutionAvatars.ts` (324), `evolutionWebhook.ts` (323),
`gmailSyncJob.ts` (282), `whatsappMedia.ts` (279), `evolutionHistorySync.ts` (267),
`restoreBackup.ts` (266), `evolutionSession.ts` (263), `backupCore.ts` (253),
`createAppUser.ts` (249), `signInWithIdentifier.ts` (221), `loginAudit.ts` (214),
`updateAppUser.ts` (202), `manageWorkflow.ts` (170), `gmailTrashMessages.ts` (161),
`resolveMapEmbed.ts` (155), `runReportSchedule.ts` (153), `backup.ts` (147),
`workflowRegistry.ts` (140), `setUserActive.ts` (137), `gmailAttachment.ts` (137),
`cronJobs.ts` (136), `revokeUserRole.ts` (112), `backupJob.ts` (110),
`permissionAudit.ts` (104), `runWorkflowNow.ts` (101), `gmailOAuth.ts` (93),
`submitLeasingInquiry.ts` (88), `submitContactInquiry.ts` (84), `deleteAppUser.ts` (82),
`publicBranding.ts` (64), `scheduledReportsJob.ts` (54), `audit.ts` (49),
`eraseAllData.ts` (26), `publicRuntimeConfig.ts` (24).

**Overall:** the orchestration layer is the strongest part of the codebase —
`workflowRegistry.ts` and `cronJobs.ts` are small, argue their fail-open/fail-closed
choices, and deliberately share one `JOBS` map so cron and the UI cannot diverge. Which
makes finding 1 the sharpest thing in this audit: the one guard they *didn't* share is the
one an incident had just been written to add.

---

## Findings

### 1 · High — the admin "Run now" button bypasses the double-fire lock that an incident added

**Where:** `src/fns/cronJobs.ts:73` (`const runningJobs = new Set<CronJobName>()`, module-private,
not exported) vs `src/fns/runWorkflowNow.ts:86-99`

`cronJobs.ts:63-72` records the incident in full: on 2026-09-01 and 09-02 the three
tenant-facing jobs each ran twice within the same second, *"both saw 'no reminder yet this
month' and both enqueued, doubling the WhatsApp burst that preceded the device being
unlinked."* The fix was `runningJobs` — an in-process set that answers 409 to a second
concurrent run of the same job.

`runWorkflowNow.ts` is the admin's "Run now". Its own docblock says it *"Mirrors the pause /
time / record sequence in respondToCronRequest"* — and it does mirror the pause check, the
timing, the `recordWorkflowRun` calls and the try/catch. **It does not take the lock**,
because the lock lives in a module-private `Set` that was never exported.

**Which means:** an admin pressing "Run now" on `overdue-reminders` or `contract-expiry`
while the nightly tick is in flight reproduces the exact condition of the September
incident — two concurrent runs racing each other's idempotency read, two reminder sets
enqueued, a doubled WhatsApp burst at the provider. The lock protects cron-against-cron and
leaves UI-against-cron wide open, which is the more likely collision now that cron is
staggered and an operator can click at any moment.

**Fix:** export `runningJobs` (or better, a `withJobLock(job, fn)` from `cronJobs.ts`) and
wrap `runWorkflowNow`'s dispatch in it, returning the same "already running" refusal. The
two handlers are 40 lines of the same sequence twice — extracting `runScheduledJob(key,
asOf)` and having both call it removes the class of bug, not just this instance.

---

### 2 · High — the Users screen offers three buttons the server refuses

**Where:** `src/routes/admin.settings.users.tsx:103-106` vs `createAppUser.ts:121-126`,
`updateAppUser.ts:41-46`, `deleteAppUser.ts:31-36`

The screen gates its controls on the permission catalogue:

```ts
const canGrant  = permissions.canAny([PERMISSIONS.USERS_CREATE, PERMISSIONS.USERS_UPDATE]);
const canRevoke = permissions.can(PERMISSIONS.USERS_DELETE);
const canToggleActive = permissions.can(PERMISSIONS.USERS_UPDATE);
const canCreate = permissions.can(PERMISSIONS.USERS_CREATE);
```

The server functions behind three of those four check something else entirely:

| Action | UI requires | Server requires |
| --- | --- | --- |
| Create user | `users.create` | `has_role('admin')` |
| Edit user | `users.update` | `has_role('admin')` |
| Delete user | `users.delete` | `has_role('admin')` |
| Toggle active | `users.update` | **`has_permission('users.update')`** ✓ |
| Revoke role | — | `has_permission(...)` ✓ |

**Which means:** `users.create`, `users.update` and `users.delete` are grantable in the
roles screen, are rendered as enabled buttons to whoever holds them, and then fail at the
server with *"Only an admin may create a user account."* One screen, two authorization
models, and the Active toggle sitting next to the Edit button honours the permission the
Edit button ignores. An operator granted "user management" can flip accounts on and off but
not create or edit one, with no way to discover that from the UI.

This is the layer-collapse shape stated in reverse: the authorization rule lives in the UI
*and* in the server fn, they disagree, and the UI is the more permissive of the two. (Safe
direction — nothing unauthorized happens — but it makes the RBAC screen lie.)

**Fix:** decide which model governs account management and apply it in one place. If
admin-only is the intent, remove `USERS_CREATE`/`USERS_UPDATE`/`USERS_DELETE` from the
catalogue and gate the screen on `has_role('admin')`; if the permissions are the intent,
switch the three server fns to `has_permission`. **This is a business decision — flagged,
not chosen.**

---

### 3 · High — the two public rate limits are trivially bypassable, and the repo already knows the right header

**Where:** `submitContactInquiry.ts:50-53` and `submitLeasingInquiry.ts:46-49` vs
`loginAudit.ts:61-73`

Both public endpoints key their rate limiter on:

```ts
request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")
```

`loginAudit.ts:61-67` spells out why that is the wrong choice here, in this deployment:

> *Behind Cloudflare `cf-connecting-ip` is the address Cloudflare itself observed and the
> one worth keeping; `x-forwarded-for` is appended to by every hop, so only its first
> element is the client.*

Appended to. Cloudflare and Traefik **append** the observed address to any `X-Forwarded-For`
the client already sent — they do not replace it. So the first element is whatever the
*client* put there.

**Which means:** a script posting to the public contact form with a random
`X-Forwarded-For: 10.0.0.<n>` on each request gets a fresh bucket every time and the
5-per-hour limit never fires. Each accepted submission inserts a `contact_inquiries` row and
calls `notifyContactInquiryRecord`, which mails the admin — so the bypass is an
email-amplification vector aimed at the company inbox, not just table spam. The honeypot
field is the only remaining control, and it stops naive bots, not a deliberate one.

Two smaller notes on the same limiter: each file has its **own** `submissionsByIp` Map, so
the quota is 5 contact **plus** 5 leasing per hour rather than 5 overall; and the window is
in-process, so it resets on every Dokploy deploy (documented, and correct for one container).

**Fix:** export `clientAddress()` from `loginAudit.ts` into `src/lib/clientAddress.ts` — it
already prefers `cf-connecting-ip` and is already the audited-correct implementation — and
use it in both endpoints. One shared `submissionsByIp` keyed `"<endpoint>:<ip>"` if the
per-endpoint quota is deliberate, or one bucket if it is not.

---

### 4 · High — "which company are we" is answered 23 times, in two incompatible ways

**Where:** 24 files read `companies`. Cross-references S02 finding 2 and supersedes its count.

| Shape | Count | Files |
| --- | --- | --- |
| `.order("created_at").limit(1)` | **15** | the 9 `notify*` senders, `enqueueNotification.ts`, `contractExpiryJob.ts`, `sendCompanyInfo.ts`, `sendInvoiceToTenant.ts`, `resolveTemplateVariables.ts`, `lib/invoiceDocumentPdf.ts` |
| `.limit(1)` with **no `ORDER BY`** | **8** | `bulkImport.ts:71`, `submitLeasingInquiry.ts:56-60`, `gmailSend.ts:286`, `gmailSyncJob.ts:230`, `publicBranding.ts`, `backupJob.ts`, `lib/paymentReceiptPdf.ts:276`, `lib/recordSentResendMessage.ts:35` |
| `.eq("id", company_id)` — the correct read | 2 | `createPayment.ts:355`, `resolveTemplateVariables.ts:491` |

An unordered `LIMIT 1` in Postgres returns **an undefined row** — the planner is free to
return a different one between two executions of the same query. So this is not one rule
written 23 times; it is *two different rules* written 23 times, and eight of them are
non-deterministic.

**Which means:** today `companies` has one row, so nothing is wrong and nothing will show up
in a test. The cost is already paid, though: the rule cannot be corrected in fewer than 23
edits, and the codebase has already drifted into two versions of it without anyone noticing
— which is the definition of the failure this audit looks for. The day a second company row
exists, `paymentReceiptPdf.ts:276` (which selects `*` to print the company header **on a
receipt**) and `recordSentResendMessage.ts` may each pick a different company from the
15 ordered readers, and may pick differently on consecutive calls.

**Fix:** one `resolveCompany(companyId: string | null)` in `src/lib` that reads by id when
one is available — most callers hold a tenant, invoice or contract row that carries
`company_id` — and falls back to `order("created_at").limit(1)` when it is not. Replacing
the 8 unordered reads with the ordered form is a five-minute change that removes the
non-determinism on its own, and is worth doing even if the larger consolidation is declined.

---

### 5 · Medium — `submitContactInquiry` and `submitLeasingInquiry` are the same endpoint twice

**Where:** `src/fns/submitContactInquiry.ts:26-43` and `src/fns/submitLeasingInquiry.ts:24-40`

Byte-identical: `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_PER_WINDOW`, `submissionsByIp`,
`isRateLimited()` — 16 lines — plus the 4-line IP extraction, the honeypot field, and the
"insert, then notify best-effort, then return `{ success: true }`" shape. The contact
version's comment even says *"Mirrors submitLeasingInquiry:19"*.

**Which means:** finding 3 is a two-file fix instead of a one-file fix, and so is every
future change to the public-form defences — a captcha, a shared store when the app scales
past one container (which the comment already anticipates), a stricter window. The two
schemas and the two tables genuinely differ and should stay apart; the defences do not.

**Fix:** `src/lib/publicFormGuard.ts` exporting `isRateLimited(bucket, ip)` and the honeypot
field, leaving each endpoint its own schema and insert.

---

### 6 · Medium — thirteen `as any` casts on RPCs that are fully typed

**Where:** `backup.ts` (4× `has_role`), `restoreBackup.ts` (2× `has_role`),
`updateAppUser.ts` (`has_role`, `write_audit`), `setUserActive.ts` (`has_permission`,
`write_audit`), `revokeUserRole.ts` (`has_permission`, `write_audit`),
`sendTenantCredentials.ts` (`has_role`), `gmailTrashMessages.ts` (`has_role`),
`createAppUser.ts`, `deleteAppUser.ts`

All three functions **are** declared in `src/integrations/supabase/database.types.ts` —
`has_permission` at line 2103, `has_role` at 2332. The casts are leftovers from before the
hand-maintained types caught up, and they are now the only thing standing between these call
sites and type-checking.

**Which means:** `database.types.ts` is hand-maintained (per `CLAUDE.md`), so a parameter
rename in a migration has to be hand-copied across — and at these thirteen sites, if it is
missed, nothing fails to compile. `rpc("has_permission" as any, { _code, _user_id })` would
accept `{ _codes, _uid }` and fail at runtime as a denied permission, which is the quietest
possible failure for an authorization check.

**Fix:** delete the `as any` from all thirteen and run `bun run typecheck`. If any of them
genuinely does not typecheck, that is a real types-drift finding to report rather than
suppress. Baseline for comparison: typecheck is currently **clean**.

---

## Not reported, and why

- **`workflowRegistry.ts`, `cronJobs.ts`, `loginAudit.ts`** — nothing to report. Fail-open
  and fail-closed choices are each stated with their reasoning, the `JOBS` map is shared
  deliberately, and `forwardedRequestHeaders()` is backed by a described measurement.
- **`publicRuntimeConfig.ts` serving Supabase config unauthenticated** — correct by design;
  it serves only the publishable anon key, and the file says so. Not a secret exposure.
- **Six copies of the admin-check block across `backup.ts` / `restoreBackup.ts`** — the same
  duplication as S01 finding 6, not a separate finding. Added to the ledger.
- **`} catch {}` in `confirmGatewayPayment`, `myfatoorahGateway`, `resolveMapEmbed`,
  `evolutionSession`, `publicBranding`, `workflowRegistry`** — every one is a documented
  fallthrough to a next attempt or a stated fail-open, not a swallowed error. Checked
  individually.
- **`bulkImport.ts` at 330 lines** — over the ceiling but cleanly layered: pure resolvers,
  then one handler. Its `throw new Response(403)` is counted in the S01 finding-2 tally.
- **`evolution*` (1,177 lines across five files)** — provider-specific session, webhook,
  history and media handling. Read for layering; each file owns one provider concern and
  none reaches into the others. No finding.

## Test coverage of this scope

- `cronJobs.test.ts` covers the 409 lock path **for the cron endpoint only** — there is no
  test that "Run now" and a cron tick cannot overlap, which is exactly finding 1. A test
  here is cheap and should land before the fix.
- `deleteAppUser.test.ts`, `createAppUser.test.ts`, `updateAppUser.test.ts` cover the
  `has_role` refusal. **No test asserts the UI/server permission agreement** in finding 2 —
  it spans a route file and a server fn and nothing joins them.
- The rate limiters (finding 3) are untested in both files. The honeypot rule *is* tested
  directly, via the exported schema, because the authors knew `.validator()` never runs
  under the mock — the same workaround noted in S01.
- `backup.test.ts` / `restoreBackup.test.ts` exist and cover the admin gate.

**Consequence for Pass 2:** finding 6 is the only change here a green suite would validate
(it is a type-level change, and typecheck is the gate). Findings 1, 3 and 5 are
behaviour-preserving but uncovered — write the concurrency test and a rate-limiter test
first. Finding 2 changes who can do what and must not be touched without the user's decision.

## Ledger entries added

See `LEDGER.md` — the company-row read (both shapes), the public-form rate limiter,
`clientAddress`, the `as any` RPC casts, the job dispatch sequence, the admin-check block.
