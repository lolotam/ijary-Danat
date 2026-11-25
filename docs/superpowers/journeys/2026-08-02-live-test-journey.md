# Live test journey — templates and event workflows

**Target:** https://danat-future.com — **production**
**Covers:** Piece 1 (Workflows tab), Piece 2 (authoritative templates + editor),
Piece 3 (five new event workflows), and the three defect fixes.
**Sign in as:** an admin (the Workflows and Providers tabs are admin-only).

---

## Read this first

**Part B sends real email.** The five new workflows email whoever is configured
under admin notification recipients. Nothing here is a dry run.

The journey is ordered so that **Part A changes nothing** — do all of it first
and you will already know whether the deploy is healthy. Part B uses each
workflow's own pause switch as the safety control: switch it **off**, fire the
event, confirm the row records a skip, then switch it **on** and fire again.
That exercises the switch and the sender in one pass, and the "off" run tells
you the trigger is wired before any mail leaves the building.

WhatsApp is not enabled in production (only SMTP is), so every check below is an
email check. Where a step mentions the WhatsApp leg, you are confirming the row
in the Notification Log, not a delivered message.

All paths below are under **Settings → Notifications**
(`/admin/settings/notifications`), which has four tabs:
**Notification pool · Templates · Providers · Workflows**.

---

## Part A — no side effects

### A1. The Workflows tab is correct (Pieces 1 and 3)

Open **Workflows**. It has two sub-tabs.

- [ ] **Scheduled jobs** lists **7**: contract-expiry, gmail-sync,
      notification-drain, overdue, overdue-reminders, salaries, scheduled-reports.
- [ ] **Action trigger workflows** lists **9**: contact inquiry received,
      contract created, contract ended, deposit confirmed, maintenance request
      created, payment succeeded, refund recorded, and the two credentials rows.
- [ ] The amber "these run on a server schedule" banner appears on the
      **Scheduled** sub-tab only, not on the event one.
- [ ] The five new rows read **"Not triggered yet"** — nothing has fired them yet.
- [ ] The four older event rows may already show a last-run time. That is
      expected; they have been live since migration 69.
- [ ] Switch the language to Arabic. Every label renders in Arabic and RTL, and
      **no cell shows a raw key** like `workflows.eventTab` or
      `notificationType.contract_created`.

> If you see raw `notificationType.*` keys, the deploy has not finished. Those
> five labels only exist in this release; migration 72 seeded the rows earlier.

### A2. The template editor (Piece 2)

Open **Templates**. It should list **26** templates.

Edit **`receipt-ar`**:

- [ ] Both body fields show **monospace HTML source**, not a rich-text box.
- [ ] Each body field has its own **HTML / Preview** toggle.
- [ ] Switch a body to **Preview**: it renders inside the branded shell — dark
      green header, company name, footer note — with the sample values filled in
      (`أحمد المطيري`, `250.000 KWD`, …).
- [ ] The Arabic preview is **RTL**; the English preview is **LTR**.
- [ ] The preview note says the data is sample data, not a real tenant's.
- [ ] The placeholder chips above match the selected type. For `receipt`:
      `{{tenant_name}} {{amount}} {{payment_date}} {{reference}}`.
- [ ] Clicking a chip inserts it into the body.

Now the two behaviours that are easy to get wrong:

- [ ] **Full-document opt-out.** Paste
      `<!doctype html><html dir="rtl"><body><p>mine</p></body></html>` into a
      body and switch to Preview. It renders **without** the brand shell — no
      green header. Undo it.
- [ ] **The sandbox holds.** Paste `<script>document.title='HACKED'</script>`
      into a body and switch to Preview. The **browser tab title must not
      change**. The preview iframe has an empty `sandbox`, so the script cannot
      run. Undo it.

- [ ] **Save and reopen.** Make a small visible edit, save, close, reopen —
      the saved HTML is there.

### A3. Contract expiry kept its placeholders (defect 3)

Still in **Templates**, open **`contract-expiry-en`**:

- [ ] The body contains all six placeholders: `{{tenant_name}}`,
      `{{contract_code}}`, `{{unit}}`, `{{days_until}}`, `{{end_date}}`,
      `{{company_name}}`.
- [ ] Same for `contract-expiry-ar`.

> This is what migration 73 restored. Migration 70 had dropped `{{unit}}`,
> `{{days_until}}` and `{{company_name}}` — the three that make an expiry
> reminder useful, and the three the WhatsApp mapping binds.

### A4. Editing a template actually changes the mail (the point of Piece 2)

This is the one check that proves templates are authoritative rather than
decorative. It uses the **manual send** path, so you choose the recipient.

1. Edit **`receipt-en`** — add a sentence like `TEMPLATE PROOF 2026-08-02` to
   the English body. Save.
2. Go to **Notification pool → Send manual message**, pick type **receipt**,
   locale **English**, and address it **to yourself**.

- [ ] The email you receive contains `TEMPLATE PROOF 2026-08-02`.

3. Remove the sentence and save again.

---

## Part B — these send real email

Do these one at a time. Each follows the same three beats.

### The pattern

1. **Pause** the workflow on the Workflows tab (toggle off).
2. **Fire** the trigger.
3. Reload Workflows — the row shows a run with status **Skipped** and the
   reason **"Workflow is paused."** No mail was sent.
4. **Un-pause**, fire the trigger again on a _new_ record.
5. The row shows **Success**, a duration, and a last-triggered time. A row
   appears in the **Notification pool**, and the mail arrives.

> Step 4 needs a **new** record. Every one of these workflows is idempotent —
> firing twice for the same inquiry, request, refund or contract records
> **Skipped — "Already notified."** rather than sending twice. That is correct
> behaviour, not a failure; it is also worth confirming once deliberately.

### B1. Contact inquiry received

- Trigger: submit the **public contact form** on the site's landing page
  (`https://danat-future.com/`) — no login needed, open it in a private window.
- [ ] Paused run records **Skipped**.
- [ ] Live run records **Success** and the admin recipients get the mail listing
      name, email, phone and message.
- [ ] **The form still succeeds either way.** The visitor sees the normal
      thank-you message even with the workflow paused. A notification problem
      must never turn a stored inquiry into a failed submission.

**Subject-line check (defect 1) — do this one deliberately:**

- [ ] Submit the form with the name **`O'Brien & Sons`**.
- [ ] In the received email, the **subject line reads
      `New contact inquiry - O'Brien & Sons`** — not `O&#39;Brien &amp; Sons`.
- [ ] The green branded header line shows the same clean text, not `&amp;amp;`.

> Before this release the subject was HTML-escaped twice. It is invisible in the
> admin UI and only shows up in a real inbox, which is why it survived both
> implementations.

### B2. Maintenance request created

- Trigger: **Maintenance → new request** on any unit.
- [ ] Paused → **Skipped**. Live → **Success**, mail lists request code, title,
      unit and priority.
- [ ] Create one with an ampersand in the title, e.g. `Tap & drain leak`, and
      confirm the received **subject** shows `Tap & drain leak` cleanly.

### B3. Refund recorded

- Trigger: **Payments → apply a refund** against an existing payment.
- [ ] Paused → **Skipped**. Live → **Success**, mail lists tenant, amount,
      reason and the refund reference.
- [ ] Apply a **second, different** refund and confirm it sends its own mail —
      the idempotency guard is per refund, not per tenant.

### B4. Contract created

- Trigger: **Contracts → create a contract** (a `draft` is enough).
- [ ] Paused → **Skipped**. Live → **Success**, mail lists tenant, contract
      code, unit, start and end dates.

### B5. Contract ended

- Trigger: edit a contract whose state is `draft`, `active`, `frozen` or
  `suspended` and move it to `expired`, `renewed` or `terminated`.
- [ ] Paused → **Skipped**. Live → **Success**.
- [ ] **Edit the same contract again** while it is still ended — change a note,
      save. **No second notification.** Only the transition _into_ an ended
      state fires this, not every later edit.

### B6. The two are independently switchable

The reason these are two rows rather than one:

- [ ] Pause **Contract created**, leave **Contract ended** live.
- [ ] Create a contract → no mail, row records Skipped.
- [ ] End a different contract → mail arrives, row records Success.
- [ ] Restore both to the state you want them in.

---

## Part C — leave production tidy

- [ ] Every workflow you paused is switched **back on** (or deliberately left
      off — write down which).
- [ ] Any template you edited in A4 is restored.
- [ ] Test contracts, maintenance requests and refunds you created are removed
      or clearly marked as test data.
- [ ] The **Notification pool** shows your test sends with state `sent`, not
      `failed`. A `failed` row means SMTP, not this release — check
      **Providers**.

---

## If something is wrong

| Symptom                                                           | Most likely cause                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Raw `notificationType.*` or `workflows.*` keys on screen          | Deploy has not finished; migrations landed before the app code                                                                        |
| Event row stays "Not triggered yet" after firing                  | The trigger did not reach the sender — check the browser console on the action                                                        |
| Row records **Skipped — "No admin email recipients configured."** | Settings → Notifications → recipients is empty. Not a bug in this release                                                             |
| Row records **Skipped — "Already notified."**                     | Correct. Use a new record                                                                                                             |
| Mail arrives with `&amp;` in the subject                          | The escaping fix did not deploy; confirm the container is running this build                                                          |
| Mail arrives with a literal `{{token}}` in it                     | A template uses a placeholder its sender does not fill. Note which token and which template                                           |
| Preview pane is blank                                             | The body is a full document (`<!doctype`/`<html`) with a rendering error inside it — the sandbox contains it, so only the pane breaks |
