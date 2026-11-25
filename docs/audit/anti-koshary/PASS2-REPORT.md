# Anti-Koshary — Pass 2 Report

**Danat Al Mustaqbal ERMP** · 2026-09-22 → 2026-09-23 · companion to [`FINDINGS.md`](FINDINGS.md)
and [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md).

Every lane of the plan shipped except one optional row (2.4, below). Twelve PRs, one database
migration, all merged to `main` and deployed. Production runs `c1a62fa`.

---

## What shipped

| PR | Merge | Lane | What behaves differently for a user |
| --- | --- | --- | --- |
| #216 | `3d35be8` | — | Audit reports committed (they were untracked). |
| #217 | `dee98e1` | **1** H1 H2 H3 H4 H6 M6 | A failed gateway settlement shows the "could not verify" card instead of a blank page. A refused money action shows a red error instead of a green success toast. One audit row per write-off/dispute, not two. "Run now" refuses while the cron tick runs the same job. The public-form rate limit works. A notification blocked by configuration lands `skipped`, not `failed`. |
| #218 | `372005a` | **2** H10 H11 M19 | Every CSV export returns the whole dataset (six were capped at 500, two at 1,000). Dashboard money KPIs sum every invoice. |
| #219 | `65daa21` | **3** M35 M36 | Docker build fails on a lockfile mismatch instead of silently re-resolving. Dependencies bumped (below). |
| #220 | `f21b5fb` | **7** H8 M22 H7-cheap + 6.5 | Paying a newer month while an older month on the same contract is open is refused server-side. Portal preview refreshes after every money mutation. Company reads are ordered. Payments screen split. |
| #223 | `f0ea1a1` | **7** H8 tail | Migration 217: the same oldest-first rule inside `apply_payment_allocation` for signed-in callers, so a direct PostgREST call cannot skip it. Webhook and reconcile (service_role) exempt. |
| #221 | `59607e1` | **4** M1 M3 M4 M5 M7 M12 M16 M17 M18 M33 H12 L1 + M10 M14 | Every permission refusal is recorded, from every server fn. Emails carry an Arabic font. A manual send with unresolved `{{variables}}` is refused. The expense importer rejects `contractual_monthly`. SMTP plain text has correct line breaks. |
| #222 | `a863235` | **5** H9 + 6.7 6.8 | None visible (strings moved into the dictionary; landing page and its settings split). |
| #225 | `52c022e` | — | The close-out statement's Arabic label on the written-off row now says written-off. |
| #224 | `5e64f5e` | **6** M13 M27–M30 M9 M2 M32 M15 + H5 M10-UI | Users screen: Create/Edit/Delete shown to admins only. Send stays disabled while a preview has unresolved variables. Otherwise none (decomposition). |
| #226 | `de3bc7f` | — | None — `bun run lint` passes again. |
| #227 | `c1a62fa` | — | None — lint follow-up. |
| #228 | `50905f0` | L2 | This report; CLAUDE.md's "known offenders" list regenerated from real line counts. |
| #229 | `7eea37c` | **H13** | A notification provider that stops answering fails the send after 20s (SMTP: 20s connect, 60s idle) instead of stalling the drain batch; the row lands `failed` and is retried. |
| #230 | `9518ec0` | **M23** | A general request whose appended details push the message past 2,000 characters is flagged on the textarea instead of failing on the server with the generic error card. |
| #236 | `2fe37ee` | Phase 2C C | Every server-backed search box (16 more screens, including WhatsApp chats, payments, tenants, reports, electricity) waits for typing to stop before querying, like contracts and invoices already did. Two in-memory filters (roles, notification templates) stay instant on purpose. The migration-reading test helper caches file text, so the structure tests stop timing out under load. |
| #235 | `86eee81` | Phase 2C A | Money a MyFatoorah link captured beyond what settlement booked (a month paid or part-paid elsewhere after the link went out, or a charge on months already paid) is recorded as one confirmed, unallocated `MF:<id>#EXCESS` payment with a `payment.gateway_excess` audit row, for the office to allocate or refund. Months are booked at no more than what was captured; a balance that grew after the link was issued stays partly open. |
| #239 | `74f766f` | Insurance backfill | Migration 222, applied to production 2026-09-24 (backup `/root/danat_pre222_202609240000.dump`, md5 `1370444832534aba7fcaabb2e253eafa`). 14 contracts whose insurance was entered on 2026-09-20, before migration 220's sync existed, showed a deposit of 0. Each was run through `sync_contract_deposit_from_insurance`: 14 synced, 14 `contract.deposit.sync_from_insurance` audit rows (actor `system`), and all 19 insurance rows now equal their contract deposit. |
| #237 | `b50b393` | Phase 2C B | A payment link is reused for at most 24 hours, and only while the amount, method and selection still match. A stale or changed link is no longer reset in place. The old request is marked `superseded` (migration 223, applied before merge, backup `/root/danat_pre223_202609240050.dump`) and keeps its MyFatoorah ids, and a new row carries the new link. A tenant paying an old link is therefore still recorded, as `#EXCESS` when the months were already paid, and the reconcile job polls superseded rows too. The guarantee is now one **pending** request per invoice selection, not one row. An excess payment on a portal-hidden contract stays hidden. This also closes the older orphaned-link case from amount or method changes. |
| #240–#243 | `93dde90` | M13 | None visible. The eight remaining production files over 600 lines are split under 500: settings lists and company settings, the notifications page and `emailTemplates`, `useContracts` and `useLandingSettings`, and the contract form and concessions dialogs. Email output was checked byte-identical, and import paths are unchanged. |
| #245 | `a83e5b3` | Phase 2C follow-up | A charge on a link whose invoices were regenerated after it was sent is recorded: the surviving months are booked, and the deleted months' share, or the whole charge, becomes `#EXCESS` instead of throwing "A requested invoice no longer exists". The reconcile job polls superseded links at any age; pending links keep the 7-day window. |
| #246 | `de49e84` | M8 | None visible. The nine `notify*` senders share `notifyAdminEvent`, `rowOrThrow` and the tenant and contract lookups. Snapshots of every sender's queries and enqueued rows across 15 scenarios, both locales, are byte-identical before and after. |

Each lane was gated at merge on typecheck, the full test suite and a production build, and each
deploy was confirmed on the server (container rebuilt from the merge commit, site answering 200).

### Final gates on `main` (`c1a62fa`)

| Gate | Result |
| --- | --- |
| `bun run typecheck` | 0 errors |
| `bun run lint` (fresh worktree) | 0 errors, 31 warnings — all predate Pass 2 except one noted below |
| `bun run test` (default timeout) | 3,417 passed · 2 skipped · 0 failed (baseline was 3,218) |
| `bun run build` | succeeds |
| `bun install --frozen-lockfile` on the image's bun 1.4.2 | succeeds (verified in the production build log) |
| Production | `c1a62fa`, rebuilt 2026-09-23 13:42 UTC, `/`, `/admin`, `/portal/auth` → 200 |

---

## Decisions you made (Lane 8)

| | Answer | Where it landed |
| --- | --- | --- |
| H5 account management | Admin-only | #224 |
| H7 / M24 company, custom roles | One company, keep roles | 7.3 cheap half in #220; roles screen translated in #222 |
| M10 unresolved variables | Block the send | server #221, UI #224 |
| M14 `contractual_monthly` | Not real — importer rejects it | #221 |
| M17 email fonts | Add an Arabic face | #221 |
| 7.1 merge timing | Merge now | #220 |
| Close the RPC bypass | Yes, with a migration | #223 |
| Migration 218: a part-paid invoice past its due date | Counts as **overdue**, not partially paid. The dashboard's overdue and outstanding totals changed meaning when 218 went live (Phase 2B, #232). Kept: a past-due balance is overdue whether or not part of it was paid | #232 |

## Migration 217

Applied to production 2026-09-23 before its code merged. `pg_dump` first:
`/root/danat_pre217_202609231033.dump` (exit 0, 4.9 MB). Server-side md5
`eb4fb6b3b4823428570a5fb315bfcfad` matched the PR. `psql -v ON_ERROR_STOP=1` exit 0,
`notify pgrst` sent. Verified live: the function carries the 217 block and 213's audit row;
EXECUTE granted to `authenticated` and `service_role` only.

## Dependencies

`bun update` within declared ranges: **64 packages, zero across a major**. Notables:
nodemailer 9.0.3 → 9.1.1, react / react-dom 19.2.5 → 19.3.0, vitest 4.1.10 → 4.1.11,
@tanstack/react-start 1.168.26 → 1.168.57, tailwindcss 4.2.4 → 4.3.3.
Runtime advisories **10 → 6** (js-yaml, nanoid, postcss, @vitest/mocker cleared). The remaining
six are transitive with no in-range fix.

**Still awaiting your decision (L3), deliberately not applied:** `@eslint/js` 9 → 10 (major,
flat-config changes) and `@lovable.dev/vite-tanstack-config` 2.7.6 → 2.23.1 (pinned exactly;
16 minors on the build config, deserves its own PR).

---

## Where the audit itself was wrong

Recorded so nobody re-derives these:

- **H14 did not reproduce.** `nodemailer@9.0.3` is not flagged by `npm audit`; the four
  advisories reported in Pass 1 are not in the database. It was bumped anyway, in range.
- **`warnIfClipped` does not exist.** The helper is `assertNotRowCapped`, it had three call
  sites, and it *throws* — so it cannot be applied to ranged page queries. Corrected in #218.
- **H7's "8 unordered company reads":** three were already fixed; one (the Google OAuth
  callback) was missed. Six were ordered.
- **"Missing recipient → skipped" is not a regression.** A substitute reviewer flagged it; it is
  M6's intended fix from Lane 1.
- **The Pass-2 "verified" frozen-install check in #219 was insufficient at first** — `--dry-run`
  did not exercise the lockfile-metadata check. Codex caught it; the lockfile was regenerated and
  verified with a real install and then in the production build.

## Findings the plan missed

H13, M23, M8 and L2 appear in `FINDINGS.md` but in no lane of `IMPLEMENTATION-PLAN.md`. They
surfaced only when the finding IDs were diffed against this report after the lanes merged.
H13, M23 and L2 are now fixed (table above). M8 is fixed too: `c48dc1c` moved the shared
load → dedupe → recipients → render → enqueue pipeline into `adminEmailNotification.ts`, and
`refactor/m8-notify-sender-runner` added `notifyAdminEvent` plus the shared row, tenant-name and
contract-code loaders, so each sender now holds only its spec and its copy.
`notifyDepositConfirmed` stays outside the shared path on purpose (status pre-check, returned ids).
`#229` merged after `clean-code-guard` but before `test-guard`; `test-guard` was run
afterwards and found nothing blocking. Its one note, a `createTransport` mock never cleared
between tests, is fixed in the M23 PR.

## Not done

**Row 2.4 — replace the dashboard's round trips with one RPC.** Not done. Row 2.2 already fixed
the correctness half (the KPIs page past 1,000 rows), the plan marks 2.4 "optional but better",
and the portfolio is ~70 units. It needs a migration applied to production before deploy; it is
offered as its own PR on request.

## Residuals found during Pass 2 and not fixed

| Item | Why it was left |
| --- | --- |
| `has_role('admin')` / `is_staff` refusals write no audit row | Needs a decision on what "permission" means for a role check |
| `integrations/supabase/auth-middleware.ts` still throws `Response` ×3 on 401/500 | Outside the audited `src/fns` scope; changes the unauthenticated path app-wide |
| Four hand-written gates remain (confirmGatewayPayment, createPayment, notifyDepositConfirmed, notifyRefundRecorded) | Not a single `has_permission` question — ownership fallback or either-of-two codes |
| `erase_all_data` missing from `database.types.ts` | Its `as any` stays, with a comment; add the RPC entry by hand |
| `.from("user_tenants" as any)`, `.from("leasing_inquiries" as any)` | Table casts, not RPC casts; outside M12 |
| Double-encoded Arabic doc comments in `whatsappChat.ts`, `whatsappMedia.ts` | Pre-existing mojibake |
| `SENTRY_AUTH_TOKEN` set via `ENV` in the Dockerfile | Bakes the token into an image layer. Move to a build secret and rotate. Pre-existing |
| Origin reachable without Cloudflare | `cf-connecting-ip` is only trustworthy for traffic through Cloudflare; the durable fix is an origin firewall allowing only Cloudflare ranges |
| `useInvoicePaidToggle.tsx` fast-refresh warning | A hook returning its dialog element — same pattern as pre-existing warnings |
| Remaining inline `locale === "ar"` sites (156) | Data-column pickers and layout values by design, plus strings in `admin.payments.tsx`, `admin.properties.index.tsx` and some `src/lib`/`src/fns` files |
| Gmail API calls still use a bare `fetch` | `gmailSend.ts`, `gmailSyncJob.ts` (×2), `gmailAttachment.ts`, `gmailTrashMessages.ts`. H13 named only the providers and the token refresh, which #229 bounds; these Gmail calls are the same risk and are not bounded |
| Provider timeouts can duplicate a slow send | A provider that accepts a message but acknowledges it after 20s is retried. Postora sends an `Idempotency-Key`; Resend, Twilio, WhatsApp and SMTP do not |
| Code review | Codex ran out of quota mid-run. #222 round 2 and #224 were merged on independent substitute reviews, not Codex |

## Not exercised — needs a person at a browser

The suite cannot reach these. None were run.

- A sandbox payment that fails settlement → "could not verify" card (H1)
- Reverse a payment as a user without `payments.reverse` → red toast (H2)
- Write off an invoice → exactly one `audit_log` row (H3)
- "Run now" a job twice quickly → second refuses (H4)
- POST the contact form six times with a rotating forged `X-Forwarded-For` → sixth refused (H6)
- Disable every email provider, queue a notification → lands `skipped` (M6)
- Export a list larger than its old cap and count the CSV lines (H11)
- Allocate a newer month while an older one is open, from the payments screen → refused (H8)
- A generated PDF and a received email in Arabic (M17)
- A manual send with a missing variable → refused, missing keys named (M10)
- /admin/payments → Insurance tab: the reported "too many fields not integrated" (a UI walk; the data half was fixed by migration 222)
- Landing page → general request with a ~1,990-character message → error under the textarea, no request sent (M23)
- Screens split in Lane 6: Users (also as a non-admin holding `users.*`), Inbox → Gmail tab,
  close-out wizard end to end, Expenses, Maintenance, Properties, Employees, Tenants → details,
  Electricity → Generate charges, Settings → Workflows → report schedules, a tenant's documents tab

## Housekeeping

- The last worktree, `F:\Danat-Mostakbal-mig`: delete its `node_modules` junction, then
  `git worktree remove`. Removing it with the junction in place can delete the shared `node_modules`.
- Your working tree `F:\Danat-Mostakbal` is on `docs/organize-handover-and-insurance-plan`, well
  behind `main`, and its junctioned `node_modules` holds Lane 3's versions. `git pull` / rebase
  before working there.
- Merged `lane/*` and `fix/*` branches remain on origin. Safe to delete; not deleted.
- Codex's GitHub reviewer is tied to the workspace that ran out of quota. Relink it before the
  next PR that needs a bot review.
