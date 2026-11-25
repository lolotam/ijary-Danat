# Portal RTL dropdown, Gmail compose, and manual-message templating

Date: 2026-08-12

Three independent changes, shipped together because two of them touch message
composition and the third is a one-line RTL fix the user reported alongside them.

- **A.** Portal contract dropdown renders left-anchored on the Arabic page.
- **B.** Gmail compose gains tenant recipients, rich text, and signatures.
- **C.** The manual-message dialog hides template internals, allows one-off
  edits, and offers real selectable variables.

---

## A. Portal contract dropdown reads left-to-right in Arabic

### The defect

On `https://danat-future.com/portal` in Arabic, the contract switcher renders

```
العقد:  1-CON-000005 (نشط)          ← label leftmost, wrong
```

when it should render, in an RTL column,

```
          (نشط) 1-CON-000005  :العقد  ← label rightmost
```

### Root cause

`@radix-ui/react-select` stamps a literal `dir` attribute onto the trigger
button (`dist/index.mjs:178`, `dir: context.dir`). `context.dir` comes from
`useDirection(dir)` at line 61, which falls back to the string `"ltr"` when the
component gets no `dir` prop and no `DirectionProvider` is mounted. An explicit
`dir="ltr"` attribute beats the `rtl` inherited from `<html>`, so the trigger's
flex row lays out left-to-right and the label lands first-on-the-left.

This is the same defect the repo already fixed once for tabs — see the comment
in `src/components/ui/tabs.tsx:7-17`, which describes the identical mechanism.

### The fix

`src/components/portal/ContractSwitcher.tsx`: pass `dir={dir}` from `useI18n()`
to `<Select>`. Radix Root threads it through context (line 61 → 94 → 178), so a
single prop fixes both the trigger's flex order and `SelectContent`'s alignment
and arrow-key direction.

Scoped to this one control by decision. The same latent bug affects **every**
`Select` in the app; fixing it centrally in `src/components/ui/select.tsx` (the
way `Tabs` and `Table` already do) would flip the label/chevron sides of every
dropdown in the Arabic admin at once and needs its own visual pass. Recorded as
a follow-up, not bundled here.

### Inner label order

`portalContractLabel` returns `1-CON-000005 (نشط)` — an LTR run, neutral
parentheses, then an RTL run. Under an RTL base direction the Unicode
bidirectional algorithm should place the code on the right and the status on its
left, which is what the user asked for, without further intervention.

This is an assumption about bidi resolution, not a verified fact, and it must be
confirmed **visually** — specifically whether the parentheses render mirrored or
orphaned. If they do misrender, the fix is isolation, and the two options differ
in cost: wrapping part of the label in `LtrText` changes `portalContractLabel`'s
return type from `string` to `ReactNode` (it has three call sites and a test);
embedding U+2068/U+2069 keeps it a `string` but breaks the existing
`toContain("1-CON-00005 (portal.contract.status.active)")` assertion in
`ContractSwitcher.test.tsx:69`. Choose deliberately if it comes to that; do not
apply isolation pre-emptively.

### Verification

`ContractSwitcher.test.tsx` cannot see visual order — its existing assertions
are byte-identical under LTR and RTL. So:

- **Test:** assert `dir="rtl"` appears in the rendered markup, exactly as
  `tabs.test.tsx:27` does.
- **Screenshot:** the live Arabic portal. The visual claim needs visual proof.

---

## B. Gmail compose dialog

`src/components/admin/GmailComposeDialog.tsx` (342 lines) gains three features
and is split in the process.

### B.1 Tenant recipients with select-all

New `ComposeRecipients` component beside the To field: a searchable tenant list
in a popover, plus **Select all**.

**The text input remains the single source of truth.** Picking tenants
*appends* into the existing `draft.to` / `draft.bcc` strings. There is no
parallel `string[]` state. Free typing, deleting an address, and pasting a
non-tenant address all keep working. Two sources of truth is what produces "I
deleted an address and it came back."

**Select all writes into Bcc, not To.** Every tenant in `To:` would disclose
every tenant's email address to every other tenant. Bcc is one Gmail send, one
thread, no disclosure. Selecting a *single* tenant still targets `To:`.

**Tenants without an email are surfaced, not dropped.** The picker shows
`N of M tenants have an email address`. Silently dropping records is the
recurring defect shape in this repo (see `written-but-never-read-columns`);
a count the admin can read is the cheap defence.

Production today: 2 tenants, both with an email address.

### B.2 Rich text (TipTap v3)

New `src/components/admin/compose/RichTextEditor.tsx`.

TipTap **v3** specifically: `react@^19.2.0` is outside TipTap v2's peer range.

Toolbar, a closed list — undo/redo · font family · font size · bold · italic ·
underline · strikethrough · text colour · highlight · align
left/centre/right/justify · bullet list · numbered list · link · clear
formatting · **paragraph direction toggle (RTL/LTR)**.

The direction toggle is not in the original request and is added deliberately:
Gmail's Arabic compose has it, and without it an Arabic-first product can only
write one direction per message.

### B.3 Signatures

New `SignatureManager` + `signatureHtml.ts`, modelled on
`F:\Prolifepharma\prolifepharma-lovable\src\components\admin\inbox\EmailSignatureManager.tsx`
with two deliberate departures.

**Structured fields are stored, not re-parsed.** Prolifepharma's
`parseSignatureHtml` regex-parses rendered HTML back into form fields on edit,
and returns confidently wrong data whenever the stored HTML does not match its
exact template. Here the structured fields are persisted as `jsonb` alongside
the rendered HTML, so editing reads real data. `signatureHtml.ts` holds the pure
fields→HTML builder and is where the unit tests point.

**Logos upload to `branding/signatures/`, not a new bucket.** A signature logo
is an `<img src>` in a message that lands in an unauthenticated inbox, so it
must be public-read. `branding` (migration 21) is already exactly that
(`branding_public_read ... for select to public`) and already has an admin-write
policy. A new bucket would need new RLS policies and would add another directory
to the xattr-preserving backup burden that broke images in the July 2026 server
move (see `db/migrations/74_restore_storage_policies.sql`).

Migration 49 is the mirror-image precedent: a company-document upload was moved
*off* `branding` because public read was wrong there. Here public read is the
requirement.

Upload follows `BrandingAssetField` in `src/routes/admin.settings.index.tsx:214`
— same 5 MB / image-only guard, same `getPublicUrl` write-back — with
drag-and-drop on top.

A default signature auto-appends on send unless one was already inserted
manually into the body.

### B.4 Server: `gmailSend` learns HTML

`src/fns/gmailSend.ts` today passes `text: data.body` to MailComposer and
nothing else. Changes:

1. Schema gains optional `html`. Both `text` and `html` are sent — every mail
   client wants the multipart alternative.
2. `recordLocalSentMessage` must store **stripped** text in `body_text` and
   `snippet`. It currently stores `input.body` verbatim, which under HTML would
   render raw `<p>` tags in the Sent list.
3. The `.refine()` that requires subject-or-body must account for `html`.

Per `server-fn-validators-are-untested`: the `createServerFn` test mock skips
`.validator()`, so the schema is exported and asserted directly, following
`resolveVariablesSchema` in `resolveTemplateVariables.ts:21`.

### B.5 Sanitization boundary

`dompurify` (browser) sanitizes signature HTML **on write and on render**.
Stored signature HTML previewed by a second admin is a genuine stored-XSS
surface.

Server-side sanitization is deliberately **not** added: the app never renders
outbound HTML in its own DOM, and `isomorphic-dompurify` would pull in jsdom.
This boundary is documented in the code, because
`MessagePreviewPanel.test.tsx:101` asserts the codebase has no
`dangerouslySetInnerHTML` in that component and a reader deserves to know why a
new component has one. Note the existing pattern for untrusted markup elsewhere:
`MessagePreviewPanel` renders template HTML into `<iframe sandbox srcDoc>`.

### B.6 Migration 123

`email_signatures`: `id`, `admin_id`, `name`, `content_html`, `details jsonb`,
`is_default`, timestamps. RLS scoped to the owning admin. One default per admin.

`REVOKE` before `GRANT` — new public tables arrive with `ALL` granted to `anon`
and `authenticated` (see `supabase-default-privileges-defeat-column-grants` and
`revoke-from-public-misses-anon`).

`database.types.ts` is **hand-edited**, never regenerated (`gen:types` writes a
reference file only).

Applied to live Supabase over `ssh-danatfuture-mcp` **before** the merge to
`main`, followed by `notify pgrst, 'reload schema'`. Dokploy auto-deploys on
merge, so schema must lead code (`push-to-main-deploys-before-migration`).

### B.7 File split

`src/components/admin/compose/`:

| File | Job |
| --- | --- |
| `GmailComposeDialog.tsx` | dialog shell, draft state, submit |
| `RichTextEditor.tsx` | TipTap instance + toolbar |
| `ComposeRecipients.tsx` | tenant picker → address strings |
| `SignatureManager.tsx` | CRUD, upload, preview |
| `signatureHtml.ts` | pure fields→HTML builder |

Driven by the 500–600 line ceiling: the current file is 342 lines and this work
roughly triples it.

---

## C. Manual-message dialog

`src/components/admin/SendManualMessageDialog.tsx`.

### C.1 Hide manual fields behind a template (request 1)

Today the subject and body boxes are visible and editable for **every**
selection except `company_info`. When a template is selected they sit empty, and
typing in them silently overrides the template with no indication.

New behaviour:

- **Free text** — boxes always visible. Unchanged.
- **A template** — boxes hidden. The existing `MessagePreviewPanel` already
  renders the resolved message and already shows for this case
  (`showPreview = !isCompanyInfoMode && !isFreeText && Boolean(effectiveTenantId)`).
- **`company_info`** — unchanged; server generates subject and body.

### C.2 One-off template editing (request 2)

**No server change is required.** `buildFinalMessage` already resolves
`input.subject ?? template.subject_ar` (`resolveTemplateVariables.ts:501-503`)
and never writes the template row. `sendNotification` passes the same overrides
through. The capability exists; the UI has never exposed it.

An **"Edit for this message only"** toggle appears when a template is selected.
Turning it on:

1. Reveals the subject and body fields **pre-filled with that template's raw
   source** for the effective locale, `{{placeholders}}` intact.
2. Feeds the existing override path, so `MessagePreviewPanel` re-renders live as
   the admin types — preview and send share one builder.
3. Shows a caption stating the change is not saved to the template.

Turning it off clears the overrides and returns to the stored template.

**Locale is pinned while editing.** `subject` and `body` are single fields in
the payload, but a template carries both `subject_ar`/`body_ar` and
`subject_en`/`body_en`. With locale on `auto`, an Arabic edit would also be
rendered as the English body. So enabling the toggle sets the locale select to
the effective locale and disables `auto`, with a one-line explanation. This
removes an option the admin can currently pick and is called out as a
deliberate trade rather than an oversight.

### C.3 Selectable variables for free text (request 3)

**The defect.** With free text, `templateCode` is null, so `template?.type` is
undefined and `resolveTypeVariables` returns `{}`
(`resolveTemplateVariables.ts:420`). Free text resolves exactly two variables:
`tenant_name` and `company_name`.

**The stale hint.** `notifications.placeholders` advertises
`{{months_until_expiry}}` — which migration 58 removed as a defect ("migration
07 seeded the bodies with `{{months_until_expiry}}`, but the payload carried
`months_until`") — and `{{period}}`, which no manual-send type resolves. Both
render as literal `{{...}}` in a tenant's inbox. The string is deleted.

**The change.** `resolveTypeVariables` gains a free-text branch: with no
template, run all four live resolvers (`overdue`, `due_reminder`, `receipt`,
`contract_expiry`) for the tenant and pinned contract and merge the results.

**The collision this creates, and how it is resolved.** `amount` is the invoice
balance in `resolveDueReminderVariables` and the payment amount in
`resolveReceiptVariables`. Merged naively, one wins silently and the admin
cannot tell which. So the free-text union exposes **distinct keys** —
`invoice_amount` and `payment_amount` — rather than an invisible precedence
rule. `{{amount}}` is untouched inside templates, where the template's type
makes it unambiguous.

**The UI.** A chip row above the body field. Each chip shows its label and its
**live resolved value** (`المبلغ المستحق · 500.000 KWD`) and inserts `{{key}}`
at the cursor on click. Chips with no value render greyed and disabled with the
reason, so an admin cannot insert a variable that will render blank.

Values come from `resolveTemplateVariables`, which means the chip row cannot
drift from what send produces — unlike the hand-written string it replaces.
`MessagePreviewPanel`'s `enabled` guard is relaxed so free text resolves too.

### C.4 Not in scope

`SendBulkMessageDialog.tsx` has the same shape and the same stale hint. It is
**not** changed here — bulk send resolves variables against a sample tenant, so
a chip row showing one tenant's live balance would be actively misleading for a
send to everyone. Recorded as a follow-up needing its own design.

---

## Testing

| Area | Test |
| --- | --- |
| A | `dir="rtl"` present in `ContractSwitcher` markup; screenshot of live Arabic portal |
| B.1 | Tenant selection appends to the address string; deleting an address is not undone; select-all targets Bcc; without-email count is rendered |
| B.3 | `signatureHtml.ts` builder — pure, per-field, including empty-field omission |
| B.4 | `gmailSendSchema` asserted directly (mock skips `.validator()`); `recordLocalSentMessage` stores stripped text |
| B.5 | Sanitizer strips `<script>` and `on*` handlers from stored signature HTML |
| C.1 | Fields hidden with a template, shown for free text and when the toggle is on |
| C.2 | Toggle pre-fills raw template source; overrides reach the payload; template row unchanged after send; locale pinned |
| C.3 | Free-text branch resolves the union; `invoice_amount` and `payment_amount` are distinct and correct; chip insertion at cursor |
| i18n | `dictionary.test.ts` enforces both locales for every new key |

Guards are not optional (`CLAUDE.md`): `clean-code-guard` on production code,
`test-guard` on tests, `docs-guard` on this document. Then `bun run lint`,
`bun run typecheck`, `bun run test`.

Every new function gets an Arabic-first doc comment. The Prolifepharma code
being borrowed has none, so it cannot be copied verbatim.

## Delivery

Spec → Codex-delegate reviews this plan → implement → Claude-delegate reviews
the diff → guard skills → gates green → migration 123 applied to live Supabase
→ feature branch → PR → Codex bot scan → merge.

Merge is **not** `--auto`: it lands the moment checks go green, which is before
the bot scan finishes (`pr-merge-workflow-gotchas`). Re-check the branch
immediately before each commit — this repo is worked concurrently
(`user-works-concurrently-in-same-repo`).

## Revisions after the plan review (2026-08-13)

Three decisions changed after an adversarial review of the implementation plan
found defects in the design as written. Recorded here rather than edited
silently into the sections above, so the reasoning stays visible.

**1. A pre-existing bug now leads the work.** `nodemailer` drops the `Bcc`
header from generated MIME unless `keepBcc` is set
(`lib/mime-node/index.js:581-586`), and `MailComposer` never sets it. Gmail's
`messages/send` takes no envelope — it delivers from the MIME headers alone. So
every Bcc address the compose dialog has ever accepted was silently discarded.
This predates all of this work and only surfaced because B.1 leans on Bcc. It is
fixed first, as its own commit.

Two consequences for B.4: `to` loses its `min(1)` so a Bcc-only send validates,
and the client-side guard is widened to match.

**2. The editor registers table and image extensions.** B.3's signature is a
`<table>` with an `<img>` logo. ProseMirror discards nodes its schema does not
know, and TipTap's `starter-kit` contains neither — so a signature inserted into
the editor would have come back as flat text with no logo. `TableKit` and
`Image` are registered to keep those nodes in the schema. They add no toolbar
buttons; the editor does not become a table editor. Package count for B.2 goes
from four to six.

**3. Free-text variables resolve lazily.** C.3 originally ran all four resolver
families for every free-text send. They are four resolver *families*, not four
queries — between them they read invoices, contracts, payments,
payment_allocations, contract_units and units, up to roughly eight round trips,
plus two per candidate payment when a contract is pinned. `sendBulkNotification`
awaits `buildFinalMessage` once per recipient, so a plain thank-you note to
every tenant would have queried all of it, and one unrelated error could abort a
half-queued batch. Resolution is now driven by the placeholders the body
actually contains: a body with no variables costs nothing.

## Follow-ups (not in this change)

1. Default `dir` from i18n inside `src/components/ui/select.tsx` for every
   dropdown, as `Tabs` and `Table` already do. Needs a visual pass over the
   Arabic admin.
2. Variable chips for `SendBulkMessageDialog`, with sample rather than live
   values.
