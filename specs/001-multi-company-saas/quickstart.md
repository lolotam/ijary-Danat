# Quickstart: Validating the Multi-Company Conversion

How to prove each phase works. This is a run-and-check guide; implementation detail belongs in `tasks.md`. References: [spec.md](./spec.md), [data-model.md](./data-model.md), [contracts/](./contracts/).

Commands marked *(new)* do not exist yet; they are added by the phase that needs them.

## Prerequisites

- Bun, Docker Desktop, and the repository's existing setup (`bun install`).
- A local Postgres for SQL tests, provisioned by the existing script.
- Redis for the worker *(new)*: a `redis` service added to `docker-compose.yml`.
- Local hosts that resolve without editing the hosts file: `acme.localhost`, `beta.localhost`, `admin.localhost` (browsers resolve `*.localhost` to the loopback address).
- Sandbox credentials for MyFatoorah. Tap and UPayments sandboxes when the owner provides them.

## Gates run on every change

```bash
bun run lint
```

```bash
bun run typecheck
```

```bash
bun run test
```

```bash
bun run test:sql
```

`bun run lint` must fail on any import of `client.server.ts` outside the allow-list ([contracts/company-context.md](./contracts/company-context.md) section 3).

## Phase 1a — Isolation

**Build a clean database with all migrations**

```bash
bun run test:db
```

Expected: completes with no `ERROR` line.

**Run the isolation suite** *(new)*

```bash
bun run test:sql src/db/isolation
```

Expected, all passing:

| Test | Proves |
|---|---|
| Structure: every `public` table off the allow-list has `company_id`, forced RLS and a policy naming `current_company_id` | FR-001, FR-003 |
| Structure: every `security definer` function names `current_company_id` or is allow-listed | FR-003, FR-004 |
| Structure: no `from companies … limit 1` in SQL or source | "oldest company" removed |
| Behaviour, per table: as a user of A, select, update and delete of B's rows affect 0 rows; insert with B's `company_id` is rejected | FR-002 |
| Behaviour: inserting a child row of A that references a parent of B fails | FR-005 |
| Behaviour: the same username, invoice code and template code can exist in A and B | FR-006 |
| Behaviour: first invoice of A and of B both get number 1 of their own sequence | FR-007 |
| Behaviour: `company_service` token for A reads none of B; a token with no `company_id` reads nothing | FR-004 |
| Behaviour: storage object under `companies/<B>/…` cannot be read or written by A | FR-009 |
| Behaviour: with A suspended, A's user reads 0 rows from every table | FR-045 |

Pass condition for SC-001: 100% of these pass. No second company is created in any shared environment before that.

> **SC-001 verification (2026-11-26, branch `001-multi-company-saas`)**: PASS, re-run after the T052f–T052m fixes — `bash scripts/test-db.sh --fresh` applied all 299 migrations with zero errors; `bun run test:sql` passed 110/110 files (874/874 tests, including the isolation/RLS files, the review-fix guards in `platformGuards.sqltest.ts`, and the anon storage listing check in `storagePaths.sqltest.ts`); `bun run test` passed 442/442 files (4033 passed, 6 skipped, including `noOldestCompany.structure.test.ts`); `bun run typecheck` passed with 0 errors; `eslint` against `eslint.platform-allowlist.js` (`src/platform/**`, `src/company/hostCompany.server.ts`, `src/worker/relay.ts`, `src/worker/scheduler.ts`) passed with 0 `client.server` violations and 0 lint errors across `src/` and `server/`.

## Phase 1b — Background worker

**Start the pieces**

```bash
docker compose up -d redis
```

```bash
bun run dev
```

```bash
bun run worker
```
*(new)*

**Check 1 — deferred send (SC-003)**: In the panel at `acme.localhost`, send an invoice by email and WhatsApp with the provider stub set to a 10-second delay. Expected: the screen confirms in under 2 seconds; the notification log shows `queued`, then `sent`.

**Check 2 — worker down**: Stop the worker, send another invoice. Expected: the screen still confirms; a `job_requests` row is `pending`. Start the worker. Expected: the row becomes `succeeded` and the message is sent once.

**Check 3 — money outbox (SC-005)** *(new)*

```bash
bun run test:sql src/db/outbox
```

Expected: a payment that commits has exactly one `payment.succeeded` job; a payment in a rolled-back transaction has none; running the handler twice sends one message.

**Check 4 — fairness (SC-006)**: Start a 10,000-row import for `acme`; trigger a notification for `beta`. Expected: `beta`'s message is sent within 1 minute.

**Check 5 — notice (SC-004)**: Generate a year of invoices. Expected: immediate confirmation; later an in-panel notice with created, skipped and failed counts.

## Phase 2 — Addresses, sign-in, super admin

1. Open `admin.localhost`, sign in as a super admin without a second factor. Expected: forced to enrol before anything else is shown.
2. Create company `acme` with a first admin. Expected: a temporary password shown once; total time under 5 minutes (SC-002).
3. Open `acme.localhost`. Expected: sign-in page with the company's name and logo. Sign in; expected: forced password change, then an empty working panel.
4. Create company `beta` with a user that has the same username as one in `acme`. Expected: accepted.
5. Use the `acme` account at `beta.localhost`. Expected: the same message as a wrong password.
6. Open `nothing.localhost`. Expected: "not found" page.
7. Switch the electricity section off for `acme`. Expected within 1 minute: gone from navigation; its direct link and its data requests are refused; still present for `beta` (SC-007).
8. Set `acme`'s unit limit to its current count; try to add a unit and to import units. Expected: both refused with the limit named. Raise the limit; expected: both succeed (SC-009).
9. Record a subscription for `acme` renewing in 14 days and run the `subscription.remind` job. Expected: a warning in the super admin panel and a banner for `acme`'s admin (SC-010).
10. Suspend `acme`. Expected within 1 minute: staff and renters see the suspended page (SC-008). Reactivate; expected: access returns, data intact.
11. Confirm each of steps 2, 7, 8, 9 and 10 has an entry in the platform audit log with no secret values (SC-015).

## Phase 3 — Payment gateways

Run once per gateway, in the gateway's sandbox.

1. As `acme`'s admin, save sandbox credentials. Expected: secrets show only their last characters afterwards.
2. Try to activate before testing. Expected: refused (`TEST_REQUIRED`). Test the connection, then activate.
3. As a renter of `acme`, pay an invoice. Record the outcome through each path in turn — webhook only, return page only, reconciliation only — by disabling the other two. Expected: the payment is recorded once each time.
4. Repeat for a failed, a cancelled, an expired and a duplicated payment. Expected: each recorded correctly, never twice (SC-012).
5. Send a webhook with a wrong signature. Expected: stored with `signature_valid = false`; nothing else changes.
6. Start a payment, switch `acme`'s active gateway, then complete the payment. Expected: it settles on the gateway it started on.
7. Open `beta`'s portal with no gateway. Expected: no online payment option.
8. Suspend `acme` after a renter opened a payment page, then pay. Expected: recorded. Try to create a new payment link. Expected: refused.

Pass condition for SC-011: an admin unfamiliar with the screen completes steps 1 to 3 in under 10 minutes.

## Phase 4 — WhatsApp and email

1. Connect a number to `acme` by QR. Expected: connected in under 3 minutes (SC-013).
2. Connect a different number to `beta`. Send from each; reply to each. Expected: each reply appears only in the owning company's inbox.
3. Try to connect `acme`'s number to `beta`. Expected: refused.
4. Disconnect `acme`'s phone. Expected: `acme`'s admin is alerted; `beta` is unaffected.
5. Complete the official sign-up (coexistence) for a test business. Expected: connected with no secret typed; a notification needing an approved template with none linked is refused with a clear reason.
6. Set `acme`'s monthly WhatsApp limit to its current count and trigger a notification on both channels. Expected: WhatsApp `skipped` with `limit_reached`; email sent.
7. With no email sender configured for `beta`, trigger a notification. Expected: received from the platform sender, showing `beta`'s name and reply address (SC-014).

## Phase 5 — Support access and overview

1. Start a support session without a reason. Expected: refused.
2. Start one with a reason. Expected: `acme`'s panel opens with a red banner on every page.
3. Change a record. Expected: both audit logs name the super admin.
4. Try to change a user's password and to view a gateway secret. Expected: both refused.
5. End the session, or wait 60 minutes. Expected: the next request is refused.
6. Open the overview with `acme` healthy and `beta` having a dropped WhatsApp connection and a failed job. Expected: totals shown; `beta` flagged with both items.

## Last phase — Custom domain and landing pages

1. Attach a test domain to `acme`. Expected after the ownership check: `acme` opens on it with a valid certificate; `acme.ijary.app` still works.
2. Switch the landing page section on for `acme`. Expected: visitors see `acme`'s landing content only; `beta`'s address still goes to sign-in.

## Danat safety check (SC-016)

Before any deployment step, confirm the target is the IJARY stack on the Contabo server and not Danat's. No command in this feature runs against `ssh-danatfuture-mcp` or the `danatfuture-*` containers.
