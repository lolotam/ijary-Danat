# User journeys — how to test the August 2026 admin batch

Ten changes, twelve journeys. Run them on https://danat-future.com after the
merge deploys, signed in as an admin holding the invoice, payment, insurance,
contract, tenant and unit permissions.

Each journey names what to do, what you should see, and — where it matters —
**what would mean it is broken**, because several of these fail in ways that
look like success.

---

## J1 · The unit type dropdown stops inventing an option

**Fixes T1.**

1. Go to **Settings → Lists → Unit types**. Count the rows. There should be four:
   Shop G Floor, Commercial Unit 1st Floor, Commercial Unit Basment, Roof
   Apartment.
2. Go to **Units → Add unit**. Open the **Type** dropdown.

**Expect:** exactly the same four, in the same order. Nothing called
"apartment". The field starts **empty**, showing its placeholder.

**Broken if:** a fifth option appears, or Type is pre-filled before you touch it.
The pre-fill was the more damaging half — it meant an admin who never opened the
dropdown still saved a type that is not in the catalogue.

3. Try to save with Type empty. It should refuse. That refusal is new and
   correct: previously it silently saved `apartment`.

### The edit path still has to work

4. Open an existing unit whose type is *not* in the catalogue (if you have one).

**Expect:** its own type is still shown and still selectable. Editing a unit must
never quietly rewrite a field you did not touch.

---

## J2 · Floor decides the type

**Fixes T5.**

1. **Units → Add unit.** Note that **Floor now sits above Type**.
2. Pick each floor in turn and watch Type:

| Choose floor | Type becomes | Type control |
| --- | --- | --- |
| Ground floor | Shop G Floor | locked |
| First floor | Commercial Unit 1st Floor | locked |
| Basement | Commercial Unit Basment | locked |
| Roof | Roof Apartment | locked |
| *(none)* | unchanged | editable |

3. Save one. Reopen it.

**Expect:** the type that was locked in is the type that was saved.

**Broken if:** the type displays correctly but saves as something else, or saves
empty. A disabled control does not submit its value — the fix writes it into form
state instead, and this step is what proves it.

### Opening an existing unit re-applies the rule

4. Find a unit whose floor is Roof but whose type is something other than Roof
   Apartment. Open it for edit.

**Expect:** Type is corrected to Roof Apartment and locked.

**Broken if:** Type shows the old value *and* is greyed out. That is the binding
appearing to work while changing nothing — the exact failure this was designed
around.

### The graceful-degradation case

5. In **Settings → Lists → Unit types**, deactivate "Roof Apartment". Go back to
   Add unit and choose the Roof floor.

**Expect:** Type is **editable**, not locked-and-empty. A locked select pointing
at a deleted option would be a dead end.

6. Re-activate it afterwards.

---

## J3 · The tenant form's new identity fields

**Fixes T2.**

1. **Tenants → Add tenant.**

**Expect:**
- **رقم مدني للمالك / Owner Civil ID** directly under the Arabic and English name
  fields.
- **رقم مدني للمفوض / Auth. Manager Civil ID** beside the existing *Authorized
  manager* field, which is still there.
- **العنوان التجاري / Commercial Address** where the old "Alternate contacts
  (JSON Array)" box was — and it is now **plain text**.
- No "اسم المالك / Owner name" field at all.

2. Type an ordinary address into Commercial Address — `شارع الخليج، قطعة ٣`.

**Expect:** it saves. **Broken if:** you get a validation error asking for a JSON
array. That field used to demand `["…"]`, which is why it was replaced rather
than relabelled.

3. Open the tenant's detail page.

**Expect:** the two civil IDs and the address are shown. No "Owner name" row.

### The CSV has to agree with the form

4. **Tenants → Export CSV.** Open it.

**Expect:** columns for the two civil IDs and the commercial address; no
`owner_name`, no `alternate_contacts`.

5. **Tenants → Import**, using the downloaded template, with all three columns
   filled. Import, then open the imported tenant.

**Expect:** all three values are there.

**Broken if:** the import reports success and the three fields are empty. The
import RPC names its columns explicitly, so a missed update fails exactly this
way — silently, looking like a clean import.

---

## J4 · Marking many invoices paid, asking once

**Fixes T3.** This is the journey most worth doing slowly.

1. **Invoices**, pick a month with several unpaid invoices —
   `/admin/invoices?year=2026&month=1`.
2. Tick three of them. Note that **paid, cancelled and written-off rows have no
   checkbox at all.**

**Broken if:** a cancelled invoice can be selected. Marking one paid would
resurrect it and book a real payment against it.

3. Tick the header checkbox.

**Expect:** every *settleable* row selects; the box shows a partial state when
only some are ticked.

4. Click **Mark selected paid**.

**Expect:** the reason dialog opens **once**, saying how many invoices it covers
— not once per invoice.

5. Choose a reason and confirm.

**Expect:** all three become Paid, and **Payments** shows three new payments.

### The failure that must not be silent

6. Deliberately select **only a later month's** invoice on a contract that still
   has an earlier unpaid one, and mark it paid.

**Expect:** a clear failure naming the invoice **code** that was refused.

**Broken if:** it reports success, or reports a bare count with no codes. The
database refuses to settle an invoice while an earlier *period* on the same
contract is still owed; the bulk loop sorts by period to avoid causing this, but
when it does happen you must be told which one and why.

7. Repeat the whole journey on **Tenant detail → a contract → Invoices**. Same
   behaviour, same dialog.

---

## J5 · Row numbers on the tenant tables

**Fixes T4.**

1. Open a tenant detail page → a contract → **Invoices**.

**Expect:** a leading `#` column numbering the rows from 1.

2. Click a column header to re-sort.

**Expect:** the numbers **renumber** — `#1` is always the top row. They are
positions, not identifiers.

3. Check the **Payments** tab on the same contract: same `#` column.

---

## J6 · The oldest invoice leads

**Fixes T10.**

1. Open a tenant detail page → a contract → **Invoices**, without touching any
   header.

**Expect:** sorted by **Due date, oldest first**, and the arrow on the Due date
header shows ascending.

2. Combined with J5: the oldest invoice is `#1` on arrival.

---

## J7 · A contract cannot be saved at zero rent

**Fixes T6.**

1. **Contracts → New contract.** Fill it in, but leave a unit's **Monthly amount
   (KWD)** at `0`.

**Expect:** it refuses, with the message shown **under that unit's own input** —
not a generic banner and not silence.

**Broken if:** the form just does nothing when you press Save. The per-unit
inputs previously rendered no error at all, so a validation failure there was
invisible.

2. Enter `0.001`. It should accept. Enter a negative. It should refuse.
3. The **deposit** field still accepts `0` — that is deliberate, and J8 needs it.

---

## J8 · Zeroing insurance removes the record

**Fixes T7.**

1. **Contracts → New contract**, insurance (التأمين) = `3500`. Save.
2. **Payments → Insurance.**

**Expect:** a row for 3500 against that contract.

3. Edit the contract, insurance `3500 → 4000`. Save. Check the Insurance tab.

**Expect:** the same row, now 4000. One row, not two.

4. Edit the contract again, insurance `4000 → 0`. Save.

**Expect:** a toast saying the insurance record was deleted, and the row is
**gone** from Payments → Insurance.

5. Check **Audit**.

**Expect:** an `insurance_payments.delete` entry naming you and the contract.

**Broken if:** the row disappears with no audit entry. The delete and its audit
row are written in one database transaction precisely so this cannot happen.

### The unrelated-save case

6. On a contract whose insurance is **already 0**, add a row by hand in
   **Payments → Insurance**. Then open that contract and press Save without
   changing anything.

**Expect:** the hand-entered row **survives**.

**Broken if:** it vanishes. The delete fires on a *change* from positive to zero,
not on the field merely reading zero — otherwise an unrelated save would destroy
a record nobody asked it to touch.

> **Worth knowing:** the insurance total for the month a deleted holding was
> collected in is recalculated from the records that exist *now*. Deleting one
> lowers that month's figure retroactively, and a report you already printed for
> that month will no longer match. That is the accepted cost of this feature; the
> audit entry is how you trace it.

---

## J9 · Partial payments point at an invoice

**Fixes T8.**

1. **Payments → Partial → Add.** Choose a contract.

**Expect:** an **Invoice** dropdown appears, listing only that contract's
**unpaid** invoices. Paid and written-off ones are absent.

2. Change the contract.

**Expect:** the invoice selection **clears** — it belonged to the other contract.

3. Select an invoice.

**Expect:** the **Status** control becomes **disabled**, showing Incomplete.

**Broken if:** you can still choose "Complete" here. That would close the record
against an invoice that is still owed — and closed records are locked, so it
could never be reopened.

4. Save. In the table:

**Expect:** an **Invoice** column showing the invoice code as a **link**. Click
it — it should open that invoice's month. And a **Status** column reading
Incomplete.

### The status follows the invoice by itself

5. Go and mark that invoice paid (any route: J4's bulk action, the single-row
   action, or a real gateway payment). Return to **Payments → Partial**.

**Expect:** the row now reads **Complete**, is visibly **faded**, and its Edit
and Delete buttons are **disabled**.

6. Now un-mark that invoice as paid. Return again.

**Expect:** the row reads **Incomplete** again and is editable again.

**Broken if:** it stays Complete and locked. That would be a state the system can
enter and never leave.

### The unlinked note stays yours

7. Add a partial payment with **no** invoice selected, and set Status =
   Complete.

**Expect:** it saves as Complete and **stays editable**. Nothing overruled you
there, so nothing should lock it.

---

## J10 · Partial payments on the tenant page

**Fixes T9.**

1. Open a tenant detail page → a contract.

**Expect:** a **Partial payments** tab alongside Invoices / Payments / Contract /
Documents.

2. Open it.

**Expect:** the same columns as Payments → Partial, the same Add / Edit / Delete
actions, the same locking rules, plus the `#` numbering column — showing only
**this contract's** rows.

3. Add one from here.

**Expect:** the contract is pre-filled. The new row appears both here **and** in
Payments → Partial.

4. If the tenant has an **archived** contract, confirm it still has a tab and its
   partial payments are reachable.

**Broken if:** archived contracts have no tab. Their records would be invisible
from the tenant page entirely.

---

## J11 · Nothing else moved

Regression sweep. These share code with the changes above.

1. **Payments → Refunds** — unchanged: no Invoice column, no Status column, no
   numbering, and every row still editable.
2. **Payments → Insurance** — unchanged apart from J8.
3. **Budget / dashboard KPIs** — the Partial total still reports its own figure
   and **partial payments still contribute nothing to the budget**. They are an
   inert ledger; the new status column must not have changed that.
4. Mark a single invoice paid the old way, from one row's action. The reason
   dialog should still name **that invoice's code**, not a count.
5. **Properties → a property → Units → Add unit** — the same J1 and J2 behaviour
   as the standalone Units page. One dialog serves both.

---

## J12 · Both languages

1. Switch the interface to **English**, then back to **العربية**.

**Expect:** every new label reads correctly in both — the two civil IDs,
Commercial Address, the bulk mark-paid button and its dialog, the partial-payment
Invoice and Status columns and their two values, the Partial payments tab title,
and the insurance-deleted toast.

**Broken if:** any of them shows a raw key such as `contracts.insurance.deleted`
or `partialPaymentStatus.complete`. The test suite blocks a key that exists in
only one language, but a key nobody references at all can still slip through to a
screen.

---

## If something fails

Note the journey number and what you saw instead. The specification behind each
change, including why it was built this way, is in
`spec/2026-08-19-admin-ux-batch.md`.
