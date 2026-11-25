# Danat Al Mustaqbal ERMP — End-to-End Admin Test Journeys

**Purpose:** Manual, day-one testing of every admin feature on a **clean / empty**
database, as a first-day admin. Journeys are ordered by **dependency** (what must
exist before the next step works).

**How we work together**

1. You run **only the journey marked `▶ CURRENT`**.
2. Reply with findings: pass / fail, screenshots notes, errors, unexpected UI.
3. I mark that journey **done** (or **blocked**), write a short **review**, and
   unlock the next journey.
4. Do not skip ahead unless a journey is marked optional or you already have the
   required data.

**Legend**

| Status      | Meaning                                    |
| ----------- | ------------------------------------------ |
| `pending`   | Not started                                |
| `▶ CURRENT` | Do this one now                            |
| `pass`      | Completed; no blocking issues              |
| `fail`      | Completed with bugs (listed in Review)     |
| `blocked`   | Cannot finish (env, data, missing feature) |
| `skipped`   | Intentionally not run (note why)           |

**Environment**

| Item          | Value (fill in)                         |
| ------------- | --------------------------------------- |
| App URL       | `https://danat-future.com` or local dev |
| Admin login   | `/auth`                                 |
| Tenant portal | `/portal` (later journeys)              |
| Empty DB?     | Yes — treat as first day                |
| Date started  | _YYYY-MM-DD_                            |
| Tester        | _your name_                             |

---

## Progress overview

| #   | Journey                                             | Status      | Date | Notes |
| --- | --------------------------------------------------- | ----------- | ---- | ----- |
| J0  | Bootstrap first admin (outside UI)                  | `▶ CURRENT` |      |       |
| J1  | Login, shell, language, empty dashboard             | `pending`   |      |       |
| J2  | Company settings                                    | `pending`   |      |       |
| J3  | Option lists                                        | `pending`   |      |       |
| J4  | Staff users & roles                                 | `pending`   |      |       |
| J5  | Notification providers & templates                  | `pending`   |      |       |
| J6  | Landing page CMS                                    | `pending`   |      |       |
| J7  | Properties (create / edit / media)                  | `pending`   |      |       |
| J8  | Units                                               | `pending`   |      |       |
| J9  | Tenants + documents                                 | `pending`   |      |       |
| J10 | Contracts (+ concessions)                           | `pending`   |      |       |
| J11 | Invoices (generate, overdue, print, paid)           | `pending`   |      |       |
| J12 | Payments (manual, allocate, reverse)                | `pending`   |      |       |
| J13 | Bank deposits                                       | `pending`   |      |       |
| J14 | Expenses + categories + budget                      | `pending`   |      |       |
| J15 | Electricity (tariffs → meters → readings → charges) | `pending`   |      |       |
| J16 | Inbox                                               | `pending`   |      |       |
| J17 | Reports                                             | `pending`   |      |       |
| J18 | Audit log                                           | `pending`   |      |       |
| J19 | Link tenant portal user + smoke portal              | `pending`   |      |       |
| J20 | Full money-path recap (happy path)                  | `pending`   |      |       |

---

## Dependency map (why this order)

```text
J0 Bootstrap admin
 └─ J1 Login / shell
     └─ J2 Company settings ─┬─ J3 Lists
                             ├─ J4 Users/roles
                             ├─ J5 Notifications
                             └─ J6 Landing page
     └─ J7 Properties ─ J8 Units
     └─ J9 Tenants (+ docs)
            └─ J10 Contracts (needs tenant + unit)
                   ├─ J11 Invoices
                   │      └─ J12 Payments
                   ├─ J13 Deposits (bank deposits; independent but useful after money)
                   ├─ J14 Expenses
                   ├─ J15 Electricity (needs units)
                   └─ J19 Portal user + portal smoke
     └─ J16 Inbox (needs messages or is empty OK)
     └─ J17 Reports
     └─ J18 Audit (verify trail after earlier writes)
     └─ J20 Full recap
```

---

# J0 — Bootstrap first admin (outside the app)

**Status:** `▶ CURRENT`  
**Route:** Supabase Studio + SQL (not in app UI)  
**Why:** On a truly empty stack, no staff user exists. Signup in `/auth` is for
**login only** (managerial). First admin is created once manually.

### Preconditions

- [ ] Migrations applied (`db/migrations/` in order; see `db/README.md`)
- [ ] Company seed exists (migration `02_auth_seed.sql` inserts Danat company)
- [ ] You can open Supabase Studio (or `psql` / Docker exec on Musalam-2)

### Steps

1. Open **Supabase Studio → Authentication → Users → Add user**
   - Email + password (or phone if you use that)
   - Prefer **auto-confirm** so you can log in immediately
2. Copy the new user’s **UUID**
3. Run SQL (from `db/migrations/02_auth_seed.sql`):

```sql
insert into public.user_roles (user_id, role)
values ('<paste-uuid-here>', 'admin');

update public.profiles
set company_id = (select id from public.companies limit 1)
where id = '<paste-uuid-here>';
```

4. Confirm:

```sql
select p.email, p.username, p.company_id, ur.role
from public.profiles p
join public.user_roles ur on ur.user_id = p.id
where p.id = '<paste-uuid-here>';
```

### Expected

- [ ] One `admin` role row
- [ ] Profile has `company_id` set
- [ ] You can attempt login in J1 with this email/password

### Pass criteria

- SQL returns your user with role `admin` and non-null `company_id`

### Your findings (paste when done)

```
Date:
Result: pass / fail / blocked
Notes:
```

### Review (filled by guide after your reply)

_Pending your report._

---

# J1 — Login, shell, language, empty dashboard

**Status:** `pending`  
**Route:** `/auth` → `/admin`  
**Depends on:** J0

### Steps

1. Open `/auth` (Admin Management Portal — not `/portal`)
2. Log in with the admin from J0
3. Confirm redirect to `/admin`
4. Check **sidebar** items load (Dashboard, Invoices, Tenants, Properties, Units,
   Contracts, Payments, Deposits, Expenses, Electricity, Inbox, Reports, Audit, Settings)
5. Toggle **language** (AR/EN) and confirm layout **RTL/LTR** flips
6. Toggle **theme** (light/dark if present)
7. Open **Inbox bell** in header (may be empty)
8. **Sign out** → lands on `/auth`; sign in again
9. On empty data: dashboard KPIs should be **zeros / empty** (no crash)

### Expected

- [ ] Staff session enters admin; tenant-only credentials would be rejected
- [ ] No blank white errors on empty tables
- [ ] Welcome line shows username/email

### Pass criteria

- Login works; shell usable; empty dashboard stable

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J2 — Company settings

**Status:** `pending`  
**Route:** `/admin/settings`  
**Depends on:** J1  
**Permission:** company/settings write (admin has all)

### Steps

1. Open **Settings** (company tab)
2. Update core identity:
   - Name AR / EN (if editable)
   - Email, phone, WhatsApp
   - Address AR / EN
   - Currency **KWD**, timezone **Asia/Kuwait**
   - Bank name, IBAN (dummy test values OK)
3. Upload or set **logo** / brand colours if fields exist
4. Set invoice footer AR/EN
5. Set `max_visible_unpaid_invoices` (e.g. leave default 6)
6. **Save** — toast success; reload page — values persist
7. (Optional / careful) Note presence of **Erase all data** control — **do not run**
   unless you intentionally want a wipe

### Expected

- [ ] Form validates email/URLs
- [ ] Saved values survive refresh
- [ ] Brand logo appears in sidebar/header if set

### Pass criteria

- Company profile saved and visible across admin chrome

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J3 — Option lists

**Status:** `pending`  
**Route:** `/admin/settings/lists`  
**Depends on:** J1

### Steps

1. Open **Settings → Lists**
2. Review seeded list types (property types, unit types, nationalities, banks, etc.)
3. Add **one custom option** to a list you understand
4. Edit label (AR/EN if available)
5. Disable or reorder if UI allows
6. Confirm the new option appears later when creating Property/Unit/Tenant (note for J7–J9)

### Expected

- [ ] Lists load without error
- [ ] New option persists

### Pass criteria

- At least one list item created/edited successfully

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J4 — Staff users & roles

**Status:** `pending`  
**Route:** `/admin/settings/users`, `/admin/settings/roles`  
**Depends on:** J1

### Steps — Users

1. Open **Settings → Users**
2. Confirm **you** appear with role `admin`
3. **Create** a second staff user (e.g. accountant):
   - Email, password, display name
   - Grant role: `accountant` (or `collector` / `readonly`)
4. Edit user (name / active flag)
5. Do **not** delete yourself
6. Optional: open tenant-linking tab if present (full portal link is J19)

### Steps — Roles

1. Open **Settings → Roles**
2. Inspect default roles: admin, accountant, collector, readonly, tenant
3. If custom roles exist: create a test custom role with limited permissions
4. Confirm permission matrix UI loads

### Expected

- [ ] Create user succeeds
- [ ] Role grant shows on the user row
- [ ] New user can log in at `/auth` and sees restricted menus (optional second browser)

### Pass criteria

- Second staff user exists with a non-admin role

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J5 — Notification providers & templates

**Status:** `pending`  
**Route:** `/admin/settings/notifications`  
**Depends on:** J2 (company email helpful)

### Steps

1. Open **Settings → Notifications**
2. Review **providers** (Resend/SMTP, WhatsApp Cloud, Twilio if listed)
3. If secrets are configured in env: enable one email provider; save
4. If **not** configured: document that enable may save but send will fail — still
   verify UI loads and toggles work
5. Open templates list; open one template; confirm edit/preview if available
6. Check notification log / retry UI if present on this page or linked

### Expected

- [ ] Page loads; providers visible
- [ ] Save does not crash
- [ ] Clear messaging when provider misconfigured (if any)

### Pass criteria

- UI usable; config can be saved; known env gaps noted as blocked-for-send only

### Your findings

```
Date:
Result:
Notes: (providers configured? yes/no)
```

### Review

_Pending._

---

# J6 — Landing page CMS

**Status:** `pending`  
**Route:** `/admin/settings/landing-page` then public `/`  
**Depends on:** J1

### Steps

1. Open **Settings → Landing page**
2. Edit hero title/subtitle (AR/EN), colours, media if available
3. Add/edit a gallery or feature section if UI provides
4. Save
5. Open public site `/` in a new tab (logged out or private window)
6. Confirm published content appears
7. Note: **contact form may be disabled / “coming soon”** (known gap in TODO) —
   record actual behaviour

### Expected

- [ ] Admin save works
- [ ] Public page reflects changes (or documents cache delay)
- [ ] Contact form state is honest (disabled or works)

### Pass criteria

- At least one visible public change from admin CMS

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J7 — Properties

**Status:** `pending`  
**Route:** `/admin/properties`  
**Depends on:** J1 (lists optional)

### Steps

1. Open **Properties**
2. Confirm empty state is friendly
3. **Create property**:
   - Name AR required; name EN optional
   - Type: e.g. `building_complex` or `compound`
   - Address, status `active`
   - Optional image
4. Save → appears in table
5. Open property detail (`/admin/properties/:id`)
6. Edit property; save
7. Try **export** / **CSV import** if time (optional): download template only is enough first pass
8. Do not bulk-delete everything after create — keep seed property for later journeys

### Suggested test data

| Field   | Value              |
| ------- | ------------------ |
| Name AR | مجمع اختبار دانة   |
| Name EN | Danat Test Complex |
| Type    | building_complex   |
| Status  | active             |

### Expected

- [ ] Create / edit / list work
- [ ] Code auto-generated if shown
- [ ] Detail page opens

### Pass criteria

- ≥1 active property exists for J8

### Your findings

```
Date:
Result:
Property id/name:
Notes:
```

### Review

_Pending._

---

# J8 — Units

**Status:** `pending`  
**Route:** `/admin/units`  
**Depends on:** J7

### Steps

1. Open **Units**
2. **Create unit** linked to property from J7:
   - Name e.g. `A-101`
   - Type `apartment`
   - Status `available`
   - Default rent e.g. `250` KWD
   - Electricity meter ownership `company_owned`
3. Create a **second unit** `A-102` (for later flexibility)
4. Edit one unit; change status filters
5. Open unit detail if linked
6. Keep units; do not delete both

### Expected

- [ ] Unit requires property
- [ ] List filters work
- [ ] Status `available` ready for contract

### Pass criteria

- ≥1 available unit with default rent

### Your findings

```
Date:
Result:
Unit names:
Notes:
```

### Review

_Pending._

---

# J9 — Tenants + documents

**Status:** `pending`  
**Route:** `/admin/tenants`, detail documents  
**Depends on:** J1

### Steps

1. Open **Tenants**
2. **Create tenant**:
   - Name, mobile (+965…), email
   - Category `standard`, lifecycle `active`
   - Language AR or EN
   - Enable `tenant_portal_enabled` = true (needed later for J19)
   - Reminders enabled = true
3. Open tenant detail
4. Upload **document** (civil ID / contract PDF/image) if storage works
5. Preview / share document if UI offers
6. Edit tenant notes; save
7. Optional: create a second tenant for multi-contract tests later

### Suggested test data

| Field  | Value               |
| ------ | ------------------- |
| Name   | Test Tenant One     |
| Mobile | +96550000001        |
| Email  | tenant1@example.com |
| Portal | enabled             |

### Expected

- [ ] Tenant code generated
- [ ] List + detail work
- [ ] Document upload succeeds **or** clear storage error (note for review)

### Pass criteria

- ≥1 active tenant exists

### Your findings

```
Date:
Result:
Tenant name/code:
Documents: ok / fail
Notes:
```

### Review

_Pending._

---

# J10 — Contracts (+ concessions)

**Status:** `pending`  
**Route:** `/admin/contracts`  
**Depends on:** J8 + J9

### Steps

1. Open **Contracts**
2. **Create contract** (draft first recommended):
   - Property + unit + tenant
   - Type `lease` or `investment`
   - State `draft`
   - Start date today (or 1st of month)
   - Duration 12 months; due day e.g. `1`; grace days `0` or `5`
   - Monthly amount match unit rent (e.g. 250)
   - Deposit amount e.g. 250
3. Save draft; reopen and **edit** to state `active`
4. Confirm unit status may become occupied (if app does that)
5. Add a **concession** (discount) if UI available — small amount or months free
6. Note any **backfill invoices** action if shown after activate — can run in J11

### Expected

- [ ] Cannot create without tenant/unit
- [ ] Active contract appears in list
- [ ] One active contract per unit rule enforced (try second active on same unit → should fail)

### Pass criteria

- One **active** contract with monthly amount and due day set

### Your findings

```
Date:
Result:
Contract code:
State:
Notes:
```

### Review

_Pending._

---

# J11 — Invoices

**Status:** `pending`  
**Route:** `/admin/invoices`  
**Depends on:** J10 active contract

### Steps

1. Open **Invoices**
2. Select current year/month
3. Run **Generate invoices** for the period covering the contract
4. Confirm invoice rows: amount, tenant, unit, state `due`
5. Open **detail** dialog; check lines/allocations empty
6. **Print** / preview invoice
7. Toggle **visibility to tenant** if switch present
8. Run **Evaluate overdue** (may no-op if not past due+grace)
9. Optional: **Mark paid** only if you want to skip gateway — prefer J12 for real payment path
10. Re-run generate for same period → must **not** double-bill (idempotency)

### Expected

- [ ] Generate creates invoices for active contracts
- [ ] Second generate is safe
- [ ] Filters by state work

### Pass criteria

- ≥1 invoice in `due` (or `partially_paid` if you partially paid)

### Your findings

```
Date:
Result:
Invoice count:
Idempotent re-generate: yes/no
Notes:
```

### Review

_Pending._

---

# J12 — Payments

**Status:** `pending`  
**Route:** `/admin/payments`  
**Depends on:** J11 open invoice

### Steps

1. Open **Payments**
2. **Create manual payment**:
   - Select tenant
   - Amount = full invoice total (or partial)
   - Method cash/transfer/etc.
   - Date today
3. Confirm status and allocation to invoice(s)
4. Open invoice again — state `paid` or `partially_paid`, balance updated
5. If UI offers **allocate** confirmation, complete it
6. **Reverse payment** with a reason (creates reversal trail)
7. Confirm invoice returns to unpaid/partial as designed
8. Create a second payment to leave data in a sensible final state (paid invoice recommended for dashboard)

### Expected

- [ ] Manual payment works without MyFatoorah
- [ ] Allocation maths sensible
- [ ] Reverse requires reason and is auditable

### Pass criteria

- At least one successful manual payment + optional reverse verified

### Your findings

```
Date:
Result:
Payment refs:
Reverse tested: yes/no
Notes:
```

### Review

_Pending._

---

# J13 — Bank deposits

**Status:** `pending`  
**Route:** `/admin/deposits`  
**Depends on:** J1 (independent of contracts; do after money flow for realism)

### Steps

1. Open **Deposits**
2. Create deposit: date, bank name, amount, currency KWD, status `pending` then `confirmed`
3. Attach file if field exists
4. Edit note; filter by status
5. Export CSV/XLS if buttons present
6. Optional CSV import

### Expected

- [ ] Create/edit/list/totals work
- [ ] Attachment optional success or clear error

### Pass criteria

- ≥1 confirmed bank deposit row

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J14 — Expenses + categories + budget

**Status:** `pending`  
**Route:** `/admin/expenses`  
**Depends on:** J7 optional (property-linked expenses)

### Steps

1. Open **Expenses**
2. Create **expense category** if none
3. Create expense: amount, category, date, optional property/unit
4. Edit; filter; export/import optional
5. Open **budget** section/dashboard if on same page or linked
6. Enter a simple budget figure if UI allows; verify display

### Expected

- [ ] Category + expense CRUD
- [ ] Totals/filters sensible

### Pass criteria

- ≥1 expense recorded

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J15 — Electricity

**Status:** `pending`  
**Route:** `/admin/electricity`  
**Depends on:** J8 units

### Steps (order matters)

1. **Tariffs** tab: create a tariff with tiers (e.g. 0–1000 kWh @ rate)
2. **Meters** tab: create meter linked to unit; assign tariff
3. **Readings** tab: enter previous + current reading (consumption ≥ 0)
4. **Charges** tab: generate charge for period
5. Confirm charge amount matches tier maths roughly
6. Edit/delete cautiously; keep one good chain of data

### Expected

- [ ] Cannot generate charge without meter/reading
- [ ] Negative consumption rejected
- [ ] Generated charges listed

### Pass criteria

- Full chain tariff → meter → reading → charge once

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J16 — Inbox

**Status:** `pending`  
**Route:** `/admin/inbox`  
**Depends on:** tenant messages (may be empty until portal J19)

### Steps

1. Open **Inbox**
2. If empty: confirm empty state (pass empty)
3. If messages exist: open thread, mark read, reply if available
4. Use header **Inbox bell** — badge matches unread
5. After J19 portal message: return here and complete reply path

### Expected

- [ ] No crash on empty
- [ ] Read/delete actions work when data exists

### Pass criteria

- Page stable; document empty or handled message

### Your findings

```
Date:
Result:
Empty?: yes/no
Notes:
```

### Review

_Pending._

---

# J17 — Reports

**Status:** `pending`  
**Route:** `/admin/reports`  
**Depends on:** some data from J7–J15 helpful

### Steps

1. Open **Reports**
2. Run/view available report widgets (occupancy, collections, arrears, etc.)
3. Change date range if present
4. Configure **scheduled reports** recipients if section exists (use your email)
5. Export if buttons exist
6. Note any blank charts as data-related vs broken

### Expected

- [ ] Page loads
- [ ] Numbers roughly match dashboard / invoices you created
- [ ] Schedule save works even if cron not configured (send may be blocked)

### Pass criteria

- Reports page usable; anomalies noted

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J18 — Audit log

**Status:** `pending`  
**Route:** `/admin/audit`  
**Depends on:** prior write actions (J2–J15)

### Steps

1. Open **Audit**
2. Confirm recent actions appear (create contract, payment, settings, etc.)
3. Filter by module/user/date if available
4. Confirm entries are **append-only** (no edit/delete of log rows)
5. Open one entry detail if present

### Expected

- [ ] Sensitive money/auth actions leave a trail
- [ ] Read-only for normal admin UX

### Pass criteria

- At least some of your J10–J12 actions visible

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

# J19 — Tenant portal user + smoke

**Status:** `pending`  
**Routes:** `/admin/settings/users` (or tenant link), `/portal`  
**Depends on:** J9 tenant + J10–J12 preferred

### Steps (admin side)

1. Create or link **auth user** with role `tenant` to the tenant record
2. Send credentials if button exists (`sendTenantCredentials`)
3. Ensure tenant has `tenant_portal_enabled`

### Steps (portal side — private window)

1. Open `/portal` auth
2. Log in as tenant
3. Dashboard: lease info, invoices list
4. Open invoices; confirm visibility rules
5. Attempt **Pay** only if MyFatoorah configured; otherwise note 503/disabled
6. Profile; receipts if any
7. Send a **message** to admin → verify in J16 Inbox

### Expected

- [ ] Tenant cannot access `/admin`
- [ ] Admin cannot use portal as tenant without tenant role (by design)
- [ ] Invoice order / pay rules enforced

### Pass criteria

- Portal login + see lease/invoices; message to inbox if implemented

### Your findings

```
Date:
Result:
Portal pay tested: yes/no
Notes:
```

### Review

_Pending._

---

# J20 — Full money-path recap (happy path)

**Status:** `pending`  
**Depends on:** J7–J12 ideally clean data

### Single narrative checklist

1. Property + unit available
2. Tenant active
3. Contract active with rent + due day
4. Generate invoices for period
5. Manual payment full amount
6. Invoice → `paid`
7. Dashboard KPIs update (paid this month, outstanding down)
8. Audit shows contract + payment
9. (Optional) reverse + re-pay once

### Pass criteria

- Entire chain works without SQL hacks after J0

### Your findings

```
Date:
Result:
Notes:
```

### Review

_Pending._

---

## Known gaps (do not file as “app broken” without context)

From `TODO.md` / product notes:

- Production secrets (MyFatoorah, SMTP/Resend, WhatsApp) may be missing → pay/notify fail
- Cron jobs need `CRON_SECRET` + host crontab — overdue/expiry automation may not fire
- Landing **contact form** may be intentionally disabled
- **Maintenance** module exists in code but is **hidden** from sidebar
- Phase 8 Dana-bot out of MVP

---

## Finding reply template (copy each time)

```text
Journey: J#
Result: pass | fail | blocked
Environment: production | local
What I did:
What I expected:
What happened:
Error text / screenshot notes:
Blockers:
Ready for next: yes/no
```

---

## Change log (guide updates)

| Date       | Change                                  |
| ---------- | --------------------------------------- |
| 2026-07-22 | Initial admin E2E journeys file created |
