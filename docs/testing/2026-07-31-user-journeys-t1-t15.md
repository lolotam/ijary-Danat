# Manual test journeys — T1 to T15

**Date:** 2026-07-31
**Scope:** the 15 requested modifications, delivered across Batches A–F
**Environment:** https://danat-future.com (production)

---

## Read this first

**Status: executed.** All 15 journeys have now been run against production. See
"Results" below for what each one found. Three small pieces remain and are
listed under "Not yet run" — the portal sign-in (which needs a password), the
refund freeze action, and two minor Arabic surfaces.

Live testing found **ten** defects that the test suite could not see. Four of
them were found on this pass: a draft contract labelled "Contract ended", system
catalogue rows that were deletable despite promising otherwise, archiving that
hid nothing, and phone numbers rendering backwards in Arabic. All are fixed and
merged.

Every batch passed lint, typecheck, 346 unit tests and 108 SQL tests, and the
database behaviour is covered by real integration tests against a real Postgres.
What those do _not_ cover is layout, RTL rendering, whether the Arabic reads
naturally, and whether the flows feel right — which is what this document is
for, and which is exactly where every bug below was found.

**This is production.** There is no staging environment. Several journeys below
change real data or send real email. Each one is marked:

| Mark | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| 🟢   | Read-only. Safe to run any time.                                                         |
| 🟡   | Writes data you can undo yourself.                                                       |
| 🔴   | **Sends email, or changes data that is hard to undo.** Read the warning before starting. |

**Create a disposable tenant for the 🟡 and 🔴 journeys** rather than using a
real one. Journey 8 starts by creating one.

### Current production state (2026-07-31)

Useful as a baseline — if these numbers look wrong before you start, something
else changed.

|                                   |                                                          |
| --------------------------------- | -------------------------------------------------------- |
| Tenants                           | 7 active · 13 inactive · 1 blocked (+1 archived, hidden) |
| Contracts inside an expiry window | 3 (`7d`, `60d`, `180d`)                                  |
| Scheduled jobs                    | 7 installed, running; `gmail-sync` hourly                |
| Gmail inbox                       | **connected** as `danatfuture@gmail.com`                 |
| WhatsApp                          | sends are `skipped` — the Meta template is not approved  |

Updated at the end of the run. The tenant figures moved because contracts were
activated during testing, and one archived test tenant is now hidden from the
list — see "Test fixtures left on production". Gmail was connected during
Journey 15, so **Journey 2 step 4 no longer applies as written**: the Gmail tab
now shows real messages rather than being empty.

---

## Journey 1 — Settings catalogues 🟡

**Covers T1.** _You could not delete an item you had added to a settings list._

1. Sign in as an admin. Go to **Settings → Lists**.
2. Pick any list. Add a new item, e.g. `TEST-DELETE-ME`.
3. Find your new item in the list.
4. Delete it.

**Expected:** the item deletes without error and disappears from the list.

**Also check:** system items (the ones seeded with the app) still show a
lock/system marker and **cannot** be deleted. Deleting those is meant to be
blocked — that is not a bug.

---

## Journey 2 — The unified inbox 🟢

**Covers T2, and repairs made in Batch B2.**

1. Go to **Inbox**. Confirm four tabs: **Tenants · Visitors · Leads · Gmail**.
2. Look at the unread badge on each tab.
   - **Watch for:** each badge must count _only its own tab_. A previous version
     showed the global unread total on the Tenants tab, so the same number
     appeared everywhere. If all four badges show an identical number, that bug
     is back.
3. Open the **Leads** tab. Each lead row should have a **status dropdown**
   (New / Contacted / Accepted / Rejected).
   - Change one lead's status. It should save and persist after a page refresh.
   - **Why this matters:** this control existed, was deleted by accident, and
     left every lead permanently stuck on "new".
4. Open the **Gmail** tab.
   - Gmail **is** connected now (Journey 15), so expect real messages with their
     body text, each row offering **Mark as read / Mark as unread**.
   - _(This step originally read "expect it to be empty". That was written
     before the mailbox was connected.)_
5. Click the **bell icon** in the header.
   - The dropdown must list unread items from **all** sources, not just tenant
     messages. If the badge shows a number but the dropdown is empty, that is
     the bug B4 fixed.
   - Click any entry. It should take you to the right tab **and** highlight the
     right row.

---

## Journey 3 — The public landing form 🔴

**Covers T3, T6.**

> ⚠️ Submitting creates a real lead in your Inbox. Use an obviously fake name
> like `TEST — please ignore` so staff do not chase it.

1. Open https://danat-future.com in a **private/incognito window** (so you are
   signed out).
2. Scroll to the contact/leasing form.
3. Set request type to **Leasing**.
   - Business activity, preferred size and preferred contact method should all
     be visible.
4. Switch request type to **General**.
   - **Watch for:** _business activity_ and _preferred size_ should **disappear**.
     Previously they stayed on screen, the visitor filled them in, the form
     submitted successfully — and those answers were silently thrown away.
5. Fill in the General form and submit.
6. Sign in as admin → **Inbox → Visitors**. Find your submission.
   - Everything you typed must be present, including the preferred contact
     method, folded into the message body.
7. **Header and footer** (T6): check the public page top and bottom render
   cleanly with no leftover placeholder links or duplicated navigation.

---

## Journey 4 — Contract form 🟡

**Covers T7, T15.**

> ⚠️ Step 6 regenerates invoices. Use the disposable tenant from Journey 8.

1. **Contracts → Add contract**.
2. **Watch for:** there must be **no "entry date" field**. It was removed as
   redundant — the contract has start and end dates already.
3. Create a contract **dated entirely in the past**, e.g. 2025-05-01 to
   2025-09-30, monthly amount 500.
4. Save. A toast should report how many back-dated invoices were created.
5. Go to **Invoices** and find them. Every month from May to Sept 2025 should
   exist, unpaid, and anything past its due date should read **overdue**.
6. Go back to **Contracts**, edit that contract, change the monthly amount from
   500 to 750, and save.
7. **Expected:** a toast reporting _"N invoices updated, M added"_.
8. Return to **Invoices**. Every unpaid invoice for that contract should now
   read **750**.
   - **The important check:** open one invoice and note its invoice **code**
     before step 6, then confirm it is _the same invoice_ afterwards — not a
     new one. The old behaviour deleted and recreated invoices, which silently
     orphaned any payment link already sent to a tenant.
9. Now mark one invoice **paid**, then edit the contract amount again to 900.
   - **Expected:** the paid invoice keeps its old total and is reported as
     _skipped_. Only unpaid invoices move. Changing what someone already paid is
     deliberately not automatic.

---

## Journey 5 — Tenant lifecycle 🟡

**Covers T8.** _The biggest visible change in this release._

1. Go to **Tenants**. The lifecycle column now maintains itself:

   | Shows          | Means                            |
   | -------------- | -------------------------------- |
   | Active         | has at least one active contract |
   | Contract ended | has contracts, none active       |
   | Inactive       | has no contracts at all          |
   | Blocked        | an admin blocked them manually   |

2. **Expect roughly 5 active and 14 inactive.** Before this release almost every
   tenant read "active" — 12 of them had no contract at all. The lower number is
   the correction, not a fault.
3. **You can no longer set lifecycle by hand on the tenant form.** That field is
   gone on purpose; it fought the automatic value.
4. Find the **blocked** tenant. Confirm they stay blocked.
5. On any tenant row, use the **Block** action. The lifecycle should become
   _Blocked_ immediately.
6. **Unblock** the same tenant.
   - **Watch for:** they must return to their _true_ state — `Active` if they
     hold an active contract, `Inactive` if they hold none. If unblocking always
     produces "Active", that is wrong.
7. Take the disposable tenant, activate a contract for them, and watch the
   lifecycle flip to **Active** without you touching it. Terminate the contract
   and watch it become **Contract ended**.

---

## Journey 6 — LTR text in Arabic 🟢

**Covers T5.** Switch the app to **Arabic** for this whole journey.

Phone numbers, WhatsApp numbers and email addresses must read left-to-right even
on an Arabic page. A number like `+965 1234 5678` rendered wrongly shows its
groups in the wrong order.

Check each of these:

- **Tenants** list — mobile column (both the table and the mobile card view)
- **Tenant → Documents** — the mobile and email badges
- **Inbox** — the email shown on Visitors and Leads rows
- **Invoices** — the WhatsApp recipient in the send dialog
- **Settings → Users** — the email column
- **Settings → Integrations** — the connected mailbox address

**Then repeat on a phone**, or with the browser window narrowed — the mobile
card layouts are a separate code path from the tables.

---

## Journey 7 — Exports 🟢

**Covers T9.**

1. **Properties → Export CSV.** Confirm a **unit count** column.
2. **Units → Export CSV.** Confirm `name` (Arabic) and `name_en` are **separate
   columns with different values** — where an English name has been entered.
3. **Units → edit any unit.** There is now an **English name** field. Fill one
   in, save, and re-export to confirm the two columns differ.
   - Units with no English name fall back to the Arabic one. That is intended —
     better than an empty column.
4. **Tenants → Export CSV.** Confirm the connected property and unit columns:
   property code, unit code, property name AR/EN, unit name AR/EN.

---

## Journey 8 — Creating a tenant portal login 🔴

**Covers T11. Start here — it creates the disposable tenant the other journeys use.**

> ⚠️ Step 5 emails real credentials to whatever address you enter. Use your own.

1. **Tenants → Add tenant.** Name it `TEST TENANT — 2026-07-31`. Give it _your_
   email address. Save.
2. Confirm it appears with lifecycle **Inactive** — it has no contract yet. This
   is correct.
3. Go to **Settings → Users → Tenants tab → Create tenant user**.
4. **The critical check:** your brand-new tenant **must appear in the picker**,
   even though it is `Inactive`.
   - This is the flow that nearly broke. Admins create the tenant, then the
     login, then activate the contract — so the picker has to show tenants who
     have no contract yet. If your new tenant is missing, that regression is
     back.
5. Create the user. Confirm the credentials email arrives and that the
   **email address is shown** in the confirmation.
6. Sign out and log in to the portal with those credentials to confirm they work.

---

## Journey 9 — Portal payment 🟢

**Covers T12.**

1. Log in to the **tenant portal** as the test tenant (or any tenant with an
   unpaid invoice).
2. Go to **Invoices** and start a payment.
3. **Expected:** the payment page opens in a **new tab** — the portal stays open
   behind it.
4. If your browser blocks the popup, a toast should appear with a **manual
   link** rather than the click silently doing nothing.

---

## Journey 10 — KNET payment link 🔴

**Covers T4.**

> ⚠️ This mints a **real MyFatoorah payment link**. Do not send it to a tenant.
> The gateway is in test mode, but treat the link as live.

1. **Invoices** → find an **unpaid** invoice → click the **KNET link** action.
2. **Expected:** a toast saying the link was copied to your clipboard.
3. Paste it somewhere and open it. The MyFatoorah page must show **KNET only**,
   not the full picker of card / Apple Pay / Google Pay.
4. Now try the same action on an invoice that is **not** the tenant's oldest
   unpaid one.
   - **Expected:** a clear message that an older invoice is still outstanding.
   - This is deliberate. Invoices must be paid oldest-first, so a cheap recent
     month cannot be cleared while an old debt ages. A refusal here is correct
     behaviour, not a bug.
5. Check the action appears in **both** the desktop table and the mobile card
   view.

---

## Journey 11 — Payment and Refund 🔴

**Covers T13.**

> ⚠️ **Archive** hides a tenant and disables their portal login. Use the
> disposable tenant. Nothing financial is deleted, but undoing an archive means
> clearing `archived_at` in the database.

1. Confirm the sidebar entry now reads **Payment and Refund**.
2. Open it. Confirm two top tabs: **Payment** and **Refund**, and that Payment
   has three sections: **Full · Partial · Insurance**.

**Partial payments — verify they do nothing** 3. Note an unpaid invoice's balance, and note the Budget totals. 4. Under **Payment → Partial**, record a partial payment against that contract. 5. **Expected: nothing changes.** The invoice balance is identical and the
Budget is identical. These records are tracking notes only — they do not
settle an invoice. The UI text says so; confirm it does.

**Insurance** 6. Under **Payment → Insurance**, record an insurance amount for a contract. 7. Go to **Budget**. Confirm a **Total insurance paid** card that reflects it. 8. **Watch for:** the existing **Deposits** card must _not_ change. Deposits are
bank deposits; insurance is money held for a tenant. They are separate.

**Refunds** 9. Open the **Refund** tab → add a refund. 10. Confirm the after-action dropdown offers three options, each with a hint
line: **Record only · Freeze the contract · Archive tenant and contract**. 11. Record a refund with **Record only**. Check **Budget**: - `Total refunded` increases. - **`Net` decreases** — refunds are money that left. This is a deliberate
change to what Net means. 12. Record a refund with **Freeze the contract** on the test contract. - The contract stays visible and becomes read-only; no new invoices generate. 13. Record a refund with **Archive tenant and contract** on the test tenant. - The tenant is hidden from normal views and their portal login stops working. - **The critical check:** their **invoices, payments and receipts must still
exist**. Archived never means deleted. Verify in Invoices/Payments. 14. **Failure path:** try recording a refund as an **accountant** (not admin)
with Archive selected. - **Expected:** the refund is _saved_, and a separate message says the
follow-up action failed. The save must not appear to fail. An accountant
may record refunds but may not archive tenants.

---

## Journey 12 — Employees and salaries 🟡

**Covers T14a.**

1. Confirm a new **Employees** entry in the sidebar. Open it — two tabs:
   **Employees** and **Salaries**.
2. Add an employee with a monthly salary. Confirm they appear as **Active**.
3. Add a second employee and mark them **not currently employed**.
4. Go to the **Salaries** tab. Pick the current year and month.
5. Click **Generate this month**.
   - **Expected:** one row per _active_ employee. The inactive one is skipped.
6. **Click Generate again.**
   - **Expected:** no duplicates, and no error. It is safe to press twice — the
     database refuses a second row for the same employee and month. This matters
     because a retried job must never pay anyone twice.
7. Toggle a salary to **Delivered**. Confirm the delivered total updates.
8. Now **raise that employee's salary** and re-check the generated month.
   - **Expected:** the already-generated row keeps the **old** amount. History
     is not rewritten by a later raise.
9. Check the **Dashboard** for the two new cards: **Employees** and
   **Salaries paid**.
   - "Salaries paid" counts only rows marked _delivered_, not merely generated.

> **Not built yet:** employee document upload and avatars. The database table,
> the private storage bucket and the `expiry_date` column all exist, but there
> is no upload control on screen. Do not look for one.

---

## Journey 13 — Scheduled jobs 🟢

**Covers T14b (cron management).**

1. Go to **Settings → Scheduled jobs**.
2. Confirm all **seven** jobs are listed: overdue, overdue-reminders,
   contract-expiry, scheduled-reports, notification-drain, gmail-sync, salaries.
3. **Expected as of today:** six show **Succeeded** with a timestamp from last
   night, and a duration. `salaries` reads **Never run** — it is monthly and
   next fires on the 1st.
4. Confirm each row shows last run, status, duration, and an enable switch.
5. **Pause** one job with the switch. Confirm it saves.
6. Re-enable it.
   - A paused job is skipped by the scheduler rather than reported as a failure.

---

## Journey 14 — Contract expiry notices 🟢

**Covers T14b (thresholds).**

The thresholds were re-cut into eight bands: **180 · 150 · 120 · 90 · 60 · 30 ·
7 · 1 days**.

1. Check the emails that went out overnight (6 contract-expiry emails were sent
   on 07-30 — two contracts point at `lolotam@gmail.com`).
2. **Watch for:** each contract should be announced **once**, with wording that
   matches how far away it actually is.
   - The old behaviour double-fired: a contract expiring in three days produced
     two emails, one of which read _"in 1 month(s)"_. If you see wording like
     that, or two emails for the same contract, the regression is back.
3. WhatsApp sends will show as **skipped** — the Meta template is not yet
   approved. Expected, not a fault.

> **Not built yet:** the daily admin digest (one summary email listing every
> contract crossing a threshold). Per-tenant notices work; the digest was
> specified but not implemented.

---

## Journey 15 — Connect Gmail 🔴

**Covers the inbox's Gmail tab. Blocked until a Google OAuth client exists.**

1. Go to **Settings → Integrations**. Today it will say Gmail is **not connected**.
2. Pressing **Connect** returns _"Gmail OAuth is not configured"_. That is
   correct — the credentials are not set.

**To unblock it, someone with the Google account must:**

- Google Cloud Console → **Create OAuth client** → type **Web application**
- Authorised redirect URI, exactly:
  `https://danat-future.com/api/oauth/google/callback`
- Scopes: `gmail.readonly` and `userinfo.email`
- Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REDIRECT_URI` in
  Dokploy, then redeploy.

Once set, press **Connect**, complete Google consent, and confirm the page shows
the connected mailbox and a last-sync time. Mail should then appear in
**Inbox → Gmail** within the hour.

---

---

## Results

Two testers: a Perplexity browser agent (marked **PA**) and Claude driving Chrome
(marked **CC**). Everything below was executed against production.

### Verified passing

| Journey                    | By     | Evidence                                                                                                                                                                                                                                          |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 — Landing form           | PA, CC | Request type switches correctly; on **General**, business activity and preferred size are removed from the DOM. The B1 data-loss defect is genuinely fixed.                                                                                       |
| 9 — Portal payment         | PA     | Pay Now opens MyFatoorah in a new tab with the correct amount and customer.                                                                                                                                                                       |
| 10 — KNET, portal side     | PA     | Chronological locking works: only the oldest overdue invoice is selectable; each unlocks the next.                                                                                                                                                |
| 10 — KNET, admin side      | CC     | Guard confirmed: three clicks on an out-of-order invoice created **zero** payment requests. T4 itself verified server-side — the generated link's page offers **KNET only** (`paymentGatewayId` pinned), unlike the portal's multi-method picker. |
| 12 — Employees & salaries  | CC     | Created active + inactive employees. Generate → 1 record, inactive skipped. **Generate again → 0 records**, one row, total unchanged. Payroll idempotency proven in the UI.                                                                       |
| 13 — Scheduled jobs        | CC     | All 7 jobs listed with real run data. Error state verified live: a failed `gmail-sync` shows a red **Failed** badge with the error inline. Renders correctly in **both** locales.                                                                 |
| 8/10 — Lifecycle & dates   | PA     | Automatic non-editable lifecycle badge; start/end dates from the active contract; `–` where none.                                                                                                                                                 |
| 13 — Payment & Refund tabs | PA     | Payment / Refund tabs with Full / Partial / Insurance sub-tabs; refund form fields as specified.                                                                                                                                                  |
| Privacy & Terms pages      | CC     | Render correctly; logo reads clearly on the dark header (an `onDark` concern raised during review was unfounded).                                                                                                                                 |

### Defects found by testing, all fixed and merged

| #   | Defect                                                                                                                      | Why nothing caught it                                                                                    | PR  |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --- |
| 1   | English success message said "your **leasing application** was submitted" for a General request                             | The Arabic string was already generic — the same key read correctly in one locale and wrong in the other | #32 |
| 2   | **No `<Toaster />` on the invoices page**, so every toast it ever raised was discarded — mark paid, send, evaluate, KNET    | Nothing renders an error when the error cannot render                                                    | #33 |
| 3   | `navigator.clipboard.writeText()` can **never settle**, skipping `catch` and `finally` — the permanent spinner              | Only reproducible in a real browser under focus loss                                                     | #33 |
| 4   | MyFatoorah `fetch` had **no timeout**                                                                                       | Latent; would hang the server function indefinitely                                                      | #33 |
| 5   | Email inputs were RTL while the phone field beside them was LTR                                                             | The value still _reads_ correctly — purely visual, and only at narrow Arabic viewports                   | #34 |
| 6   | A correct, permanent "pay the older invoice first" refusal was reported as **"Could not load the data. Please try again."** | The 409 never matched: `useServerFn` does not surface the thrown `Response` as `{status}`                | #35 |

Defects 2, 3 and 6 were all found by a single click that produced no visible
result. None was reachable from tests, and #6 in particular presented a
permanent business rule as a transient glitch that invited pointless retries.

### Corrections made to test reports

Both testers, including Claude, produced confident conclusions that were wrong.
Recorded because the pattern matters more than the individual errors:

- **"Admins have override privileges over invoice sequencing"** — false. There
  is no override path in code; `payments.override_chronological_order` is seeded
  but never referenced. The invoice tested simply happened to be the selectable
  one.
- **"The KNET request is failing silently"** — false. It had already succeeded
  and created a real payment link. The failure was entirely client-side, after
  the server returned.
- **"~25 translation keys missing on the Employees screen"** and **"5 keys
  missing from Arabic"** — both false, both artifacts of parsing `dictionary.ts`
  on stale line numbers. Locale parity was already 1188/1188.

The lesson applied: a claim about behaviour is checked against the database or
the code before it is written down.

### Journey 15 — Gmail: PASS

OAuth connected (`danatfuture@gmail.com`), Gmail API enabled, **52 messages
synced** and rendering in Inbox → Gmail with sender, subject, body preview and a
mark-as-read action. The tab badge shows 52.

Four Batch B2 fixes proven at once by that sync:

| Fix                            | Evidence                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| Pagination                     | 52 messages fetched despite a 50-per-page limit — the `pageToken` loop ran                          |
| Multipart body extraction      | **52 of 52** rows have `body_text`; before the fix this was null for essentially all multipart mail |
| `message_id` NOT NULL + de-dup | 52 distinct ids, no nulls                                                                           |
| Idempotency                    | Running the sync a **second** time left the table at exactly 52 rows                                |

### Journey 14 — expiry wording: PASS

Confirmed from actual sent mail now visible in the Gmail tab. Each contract was
announced **once**, with wording matching its real distance:

| Tenant        | Bucket | Wording        |
| ------------- | ------ | -------------- |
| سالم التجريبي | `1d`   | "خلال 1 يوم"   |
| رشدول اسلام   | `60d`  | "in 32 day(s)" |
| أحمد العتيبي  | `180d` | "خلال 154 يوم" |

The defect this replaces produced **two** emails per contract, one reading "in 1
month(s)" for a contract days from expiry.

### Journey 4 — invoice regeneration: PASS

The money-path assertion, run against production through the real UI on
contract `CON-00007`. Monthly amount edited **200 → 275 → 200**, two full round
trips.

| Code        | UUID         | 200 | 275 | back to 200 |
| ----------- | ------------ | --- | --- | ----------- |
| INV-0000232 | `c6940f25-…` | ✓   | ✓   | ✓           |
| INV-0000233 | `8c9deb73-…` | ✓   | ✓   | ✓           |
| INV-0000234 | `1586b0b9-…` | ✓   | ✓   | ✓           |
| INV-0000235 | `054437e6-…` | ✓   | ✓   | ✓           |
| INV-0000236 | `bd5a6445-…` | ✓   | ✓   | ✓           |
| INV-0000237 | `48bf94cd-…` | ✓   | ✓   | ✓           |
| INV-0000238 | `812a264f-…` | ✓   | ✓   | ✓           |

**Every UUID and every invoice code survived both edits.** Totals tracked the
contract each time. No rows created, none destroyed. `invoice_items` were
rewritten rather than accumulated — one line per invoice, matching the new
total, after each edit.

This is the whole reason T15 was built as an UPSERT-diff. The previous
`reapply_contract_invoices` deleted and recreated: seven new UUIDs and seven new
codes from `INV-0000239` up. Because `payment_requests.requested_invoice_ids` is
a `uuid[]` with **no foreign key**, nothing in the database would have objected —
a tenant holding a KNET link would have paid, and the money would have been
allocated against an invoice that no longer existed.

Production was left exactly as found (`monthly_amount` back to 200.000).

**Not covered here:** the paid-invoice skip branch. Marking an invoice paid
creates payment and allocation rows that are awkward to unwind on production,
so that path is left to `invoiceRegeneration.sqltest.ts`, which asserts a paid
invoice keeps its total and is reported as `skipped`.

### Journey 8 — tenant portal login: PASS (steps 1–5); step 6 handed over

Created `TEST TENANT — 2026-07-31` / `DANA-000006`
(`7c0295b6-b321-49f8-816f-d328150bd1e5`).

| Step | Result                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–2  | Created with lifecycle **`inactive`** — the before-insert trigger doing its job on a tenant with no contract.                              |
| 3–4  | **The regression guard holds.** The `inactive` tenant appeared at the top of the create-user picker.                                       |
| 5    | Profile linked to the correct `tenant_id`; `createAppUser` flipped `tenant_portal_enabled` to true; lifecycle correctly stayed `inactive`. |

The credentials email was genuinely **sent** to
`dr.vet.waleedtam+test0731@gmail.com`, and the rendered body opens with
`البريد الإلكتروني:` — the T11 "show email in credentials" requirement verified in
the delivered message rather than in the dictionary. It then reappeared in the
Gmail tab via sync, which independently confirms the whole loop.

**Step 6 (signing into the portal) was not run** — the tester does not enter
passwords to authenticate. This is handed to the user, not counted as a pass.

### Journey 5 — tenant lifecycle: PASS

The four-state rule, exercised on production against the disposable tenant.

| Check                                     | Result                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Lifecycle field gone from the tenant form | Confirmed — the form has no lifecycle control                       |
| Block                                     | → `blocked` immediately                                             |
| **Unblock with _no_ contract**            | → **`inactive`** (not `active`)                                     |
| **Unblock with an _active_ contract**     | → **`active`**                                                      |
| Activate a contract                       | → `active`, with no manual action                                   |
| Terminate it                              | → `contract_ended`, all four invoices preserved                     |
| **`blocked` survives a contract change**  | Contract reactivated while blocked → lifecycle **stayed `blocked`** |

Both unblock branches were run deliberately. Testing only the active case would
pass identically against an implementation that hardcodes `active` — the pair is
what makes the check meaningful.

The last row is the assertion the whole T8 redesign exists for: the withdrawn
migration 51 would have silently overwritten `blocked` to `active` here, erasing
an admin's decision with no audit trail.

**Correction to step 2 of this journey:** it says "expect roughly 5 active and 14
inactive." Production now reads **8 active / 13 inactive / 1 blocked**. The
figure moved because contracts have been activated since the backfill (including
this journey's `CON-00008`), not because the rule drifted.

#### T15's headline requirement, verified live for the first time

Back-dating `CON-00008` to 2026-04-01 (4 months, ending 2026-07-31) generated
every historical month as unpaid:

```
INV-0000253  2026-04  100.000  paid 0.000  overdue
INV-0000254  2026-05  100.000  paid 0.000  overdue
INV-0000255  2026-06  100.000  paid 0.000  overdue
INV-0000256  2026-07  100.000  paid 0.000  overdue
```

This was the original complaint behind T15 — a contract entered for past months
producing no history — and it had never been checked against the real UI. A
draft contract correctly generated **nothing**; invoices appear on activation.

#### Defect found: a draft contract read as "Contract ended"

Fixed in **PR #39** (migration 59). See below.

### Journey 7 — exports: PASS

Captured by intercepting the generated blob in-page, so no file was downloaded.

| Export     | Result                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Properties | `units` count column present and correct (PROP-JAHRA 1, PROP-00008 1, PROP-00009 0 — matching the database). |
| Units      | `name` and `name_en` are separate columns, plus `connected_property_name_ar/_en`.                            |
| Units edit | The **Unit English name** field exists; set `UNIT-00005` → `Apartment T-101`, which persisted.               |
| Tenants    | All six connected columns present: property/unit code, and property/unit name in AR and EN.                  |

The assertion that matters, from the tenants export:

```
DANA-000003 … UNIT-00005 … شقة T-101 , Apartment T-101
```

Two genuinely different values. Before `units.name_en` existed — the one open
decision in the original plan — those columns could only ever have duplicated.
Units with no English name correctly fall back (`G02,G02`).

> Tested in this order deliberately: with every `name_en` still null, the two
> columns would have been identical, which is also exactly what the bug looks
> like. One unit had to be populated first for the check to mean anything.

**Data note, not a defect:** `PROP-00009` holds `name_ar=dana 11` and
`name_en=دانة` — those two values look swapped in the record itself.

### Journey 2 — the unified inbox: PASS

Baseline read from the database first, so the badge check could actually fail:
tenant messages 0, visitor 0, leads 4, Gmail 51.

| Step | Result                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Four tabs present.                                                                                                                                                     |
| 2    | Badges read **0 · 0 · 4 · 53** — four different values. Bug B3 would have shown the global total on every tab.                                                         |
| 3    | **The lead status dropdown is back** (L1). Changed John Doe → Accepted; persisted to the database and survived a reload.                                               |
| 4    | Gmail tab renders real messages with extracted body text, no crash. **Mark as read / unread present** (L2) — unread 53 → 52.                                           |
| 5    | Bell dropdown lists **multiple sources**, each tagged (`GMAIL`, `LEASING LEADS`) — bug B4 fixed. Clicking an entry opened the right tab and highlighted the right row. |

Counts stayed consistent throughout: after the status change, the Leads badge
went 4 → 3 and the bell 57 → 56.

### Journey 1 — settings catalogues: defect found and fixed

**T1 itself works:** a custom item added to _Payment methods_ deletes cleanly.

**The system-item guard did not exist.** The screen draws a "System" badge and
this document promised those rows "cannot be deleted" — but `is_system` was read
in exactly one place, to draw that badge. The delete button rendered identically
for system and custom rows, RLS checked only `has_role(admin)`, and there was no
trigger. One click removed `knet` from every payment-method dropdown.

Blast radius, measured rather than assumed: `payments.method` is the enum
`public.payment_methods`, **not** a foreign key, so no financial record is
corrupted. The damage is forward-looking and silent — staff can no longer record
a KNET payment and nothing explains where the option went.

Fixed in **PR #40** (migration 60). Verified on production:

```
delete … where value='knet'           -> ERROR: Cannot delete a system item
delete … where value='test_delete_me' -> DELETE 1
```

Both directions matter: blocking everything would have reintroduced T1.

> **Testing note.** The delete button calls a native `confirm()`
> (`admin.settings.lists.tsx:193,444`; also `admin.settings.landing-page.tsx`),
> which blocks browser automation entirely — the tab stops responding. A human
> is unaffected: they click OK. Everything above was therefore asserted against
> the database directly, which is the stronger check anyway, since PostgREST is
> reachable with the same admin JWT and a disabled button protects nothing.
> Converting those two files to the shadcn `AlertDialog` used everywhere else in
> the app is a **follow-up**, deliberately not bundled with a real defect.

### Three findings from the synced mailbox

**1. Credential emails contain plaintext passwords.** The `user_credentials`
template sends `Username: … Password: …` in the body — visible in the mailbox,
and now also stored in `gmail_messages.body_text` inside the application
database. One such message carries the password `123456789`. Emailing initial
credentials is a deliberate product decision, but the password now sits in a
second system never designed to hold secrets. Worth deciding whether to send a
one-time reset link instead.

**2. A Google Cloud project was shut down.** A notice dated 30 July reads "Your
Google Cloud project danat-future was shut down". The working OAuth client is in
a different project, so sync is unaffected today — but a deleted project revokes
its credentials, so confirm which project holds the live client.

**3. Cosmetic:** the Gmail panel's subtitle reads "Tenant messages and visitor
enquiries" — the page-level subtitle reused under a "Gmail" heading.

### Journey 11 — Payment and Refund: PASS (steps 1–11, 13); one defect fixed

Run against the disposable tenant, with a real financial fixture built first so
the archive check could not pass vacuously: `INV-0000253` was paid in full
through the UI, producing a payment, an allocation and a receipt.

| Step | Result                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2  | Sidebar reads **Payment and Refund**; Payment/Refund tabs, with Full · Partial · Insurance.                                                                               |
| 3–5  | **Partial payments really are inert.** A 40.000 record was created and every invoice stayed `paid=0.000`; the budget was byte-identical (`net=5980`, `collections=6400`). |
| 6–8  | Insurance of 250.000 → `insurance_collected=250.000`, and **`deposits` stayed 7500.000**.                                                                                 |
| 9–10 | Three post-actions offered, each with a hint line.                                                                                                                        |
| 11   | Record-only refund of 100 → `refunds` 0 → **100.000**, `net` 5980 → **5880**. Tenant untouched.                                                                           |
| 13   | Archive: `archived_at` stamped on tenant and contract, portal disabled, `profiles.is_active=false`.                                                                       |

The insurance result confirms the Batch D decision. Insurance got its own table
and its own `insurance_collected` key rather than reusing `deposits`, so the
already-shipped Deposits KPI card is untouched — exactly the collision that was
designed around.

#### The critical check: archived never means deleted

Captured before archiving and re-read after. **Every id identical:**

| Record                    | After archiving                         |
| ------------------------- | --------------------------------------- |
| `INV-0000253` `f8a497dd…` | survives — still `paid=100.000`, `paid` |
| `INV-0000254/255/256`     | survive, unchanged                      |
| `PAY-0000022` `f31f35e1…` | survives                                |
| allocation `090c7f67…`    | survives, 100.000                       |
| `REC-0000021` `a35fb1f7…` | survives                                |

Asserted by row existence in the database, not by what the UI stops showing —
which matters, because the UI turned out to be the broken half.

Confirmed **in the UI as well**, after PR #42 shipped, because a filter that
hides archived tenants could plausibly have hidden their invoices too:

| Page             | Result                                                                             |
| ---------------- | ---------------------------------------------------------------------------------- |
| Invoices → April | `INV-0000253` listed, tenant column reads **TEST TENANT — 2026-07-31**, state Paid |
| Payments         | `PAY-0000022` listed with the tenant name, Confirmed, Print receipt available      |

`enrichInvoices` resolves tenants by id rather than through `useTenants`, so the
list filter does not reach it. The archive hides the tenant and contract lists
and nothing else.

#### Defect found: archiving hid nothing

The archived tenant went on appearing at **row 1** of the Tenants list.
`archived_at` was written by `useRefunds.ts` and read by **nothing** — the same
shape as the system-item defect: a column carrying a promise nothing enforced.

Fixed in **PR #42** and verified live after deploy: the archived tenant and
`CON-00008` both left their lists, with all financial rows still present.

**Not run:** step 12 (freeze — the contract was already archived by then) and
step 14 (the accountant failure path, which needs a second login).

### Journey 6 — LTR text in Arabic: PASS after a fix

| Surface                           | Result                                       |
| --------------------------------- | -------------------------------------------- |
| Tenants table — mobile column     | correct (`+965 9999 0731`, `+965-5555-0101`) |
| Tenants **card** view             | correct — separate code path, also fine      |
| Inbox — Visitors and Leads phone  | **broken → fixed** (PR #43)                  |
| Inbox — Visitors and Leads email  | correct                                      |
| Settings → Users — email column   | correct                                      |
| Settings → Integrations — mailbox | correct (`danatfuture@gmail.com`)            |

#### Defect found: phone numbers reversed on the Inbox

| Stored          | Rendered in Arabic |
| --------------- | ------------------ |
| `+96512345678`  | `96512345678+`     |
| `+965 51234567` | `51234567 965+`    |

The email in the **same row** was correct, because it went through `LtrText` and
the phone beside it did not. This is the exact mirror of PR #34, where the
tenant form treated `tel` inputs and left `email` untreated — same pair,
opposite half, and invisible to the suite both times.

Fixed in **PR #43**, which also wrapped the two remaining bare phone renders
(the public brand card and its admin preview) and added a guard that reads the
contact tables' source and fails if a phone or email is rendered outside
`LtrText`. The guard is mutation-tested: unwrapping `profile.email` makes it
fail with exactly that value.

Verified live after deploy — every number now sits in a `dir="ltr"` span on an
`html[dir=rtl]` page.

### Not yet run

- **Journey 8 step 6** — signing into the portal with the generated credentials.
  Belongs to the user; the tester does not enter passwords to authenticate.
- **Journey 11 step 12** — the freeze post-action. The contract was already
  archived by the time this came up.
- **Journey 11 step 14** was not run in the browser (it needs a second login),
  but its contract is now covered by `refunds.sqltest.ts`: an accountant's
  refund with `post_action = 'archive'` is **kept** while the archive update
  itself affects zero rows. RLS refuses by updating nothing rather than raising,
  so that test asserts on rows and not on exceptions — a caller checking only
  for a thrown error would conclude the archive had succeeded.
- **Journey 6** — the tenant Documents badges and the Invoices WhatsApp send
  dialog. The new source guard covers the three contact tables, not these.

### Test fixtures left on production

Clean these up when testing finishes:

| Object                                                      | Note                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Tenant `DANA-000006` `7c0295b6-b321-49f8-816f-d328150bd1e5` | **archived** — no longer in the Tenants list            |
| Contract `CON-00008`                                        | **archived**; PROP-M0002-U01, 100.000/mo, Apr–Jul 2026  |
| Invoices `INV-0000253`–`INV-0000256`                        | `…253` paid, the other three unpaid                     |
| `PAY-0000022`, its allocation, `REC-0000021`                | the payment made to prove the archive check             |
| 2 refunds, 1 partial, 1 insurance                           | 100 (record-only) + 50 (archive), 40, 250               |
| Portal user `testtenant0731`                                | `is_active=false` since archiving                       |
| Lead `John Doe`                                             | status changed to `accepted` during Journey 2           |
| Unit `UNIT-00005`                                           | `name_en` set to `Apartment T-101` (harmless, may keep) |

**Leave these if you still want to run Journey 8 step 6** — that portal login
needs the tenant. Archiving disabled it, so clearing `archived_at` and
re-enabling `profiles.is_active` comes first.

The two refunds move the budget: `net` reads 5980 − 150 = **5830** until they
are removed. Insurance (250) is money held for a tenant and does not touch
`net`.

Already cleaned up: the `test_delete_me` payment-method row.

## Both languages

Run at least Journeys 2, 5, 11, 12 and 13 **in Arabic as well as English**.
Every screen in this release is new or heavily changed, and none has been seen
in Arabic.

Specifically watch for:

- Any label showing as a raw key like `common.add` or `refunds.title` instead of
  real words. _(A test now blocks this from shipping, but it cannot check that
  the Arabic reads naturally.)_
- Layout breaking in RTL — buttons or columns in the wrong order.
- Numbers and dates reading correctly in Arabic.

---

## Sign-off

| #   | Journey                      | Tasks   | Result    | Notes                                                               |
| --- | ---------------------------- | ------- | --------- | ------------------------------------------------------------------- |
| 1   | Settings catalogues          | T1      | —         | not run                                                             |
| 2   | Unified inbox                | T2      | —         | not run                                                             |
| 3   | Landing form                 | T3, T6  | ✅ pass   | conditional fields correct; found + fixed the success wording       |
| 4   | Contract form + regeneration | T7, T15 | ✅ pass   | UUIDs and codes survived 200→275→200 — the money-path assertion     |
| 5   | Tenant lifecycle             | T8      | ◐ partial | badge + dates confirmed; block/unblock not run                      |
| 6   | LTR text in Arabic           | T5      | ◐ partial | public pages + employee dialog only; found + fixed email LTR        |
| 7   | Exports                      | T9      | —         | not run                                                             |
| 8   | Tenant portal login          | T11     | —         | not run                                                             |
| 9   | Portal payment               | T12     | ✅ pass   | opens in a new tab, correct amount                                  |
| 10  | KNET link                    | T4      | ✅ pass   | KNET-only page confirmed; guard confirmed; 3 defects fixed          |
| 11  | Payment and Refund           | T13     | ◐ partial | tab structure + refund form verified; archive not run               |
| 12  | Employees and salaries       | T14a    | ✅ pass   | idempotency proven — second generate created 0 rows                 |
| 13  | Scheduled jobs               | T14b    | ✅ pass   | 7 jobs, real run data, error state verified, both locales           |
| 14  | Expiry notices               | T14b    | ✅ pass   | one email per contract, day-accurate wording, verified in sent mail |
| 15  | Connect Gmail                | —       | ✅ pass   | 52 messages synced; pagination, body extraction and de-dup proven   |

### Clean-up after testing

- Delete or archive `TEST TENANT — 2026-07-31` and its contract.
- Delete the test lead from **Inbox → Visitors**.
- Delete the test employees and their generated salary rows.
- Delete any test refund, partial payment and insurance record.
- Re-enable any scheduled job you paused.
