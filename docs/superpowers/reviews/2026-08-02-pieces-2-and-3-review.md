# Review — Piece 2 (Grok 4.5) and Piece 3 (Codex 5.6)

**Date:** 2026-08-02
**Reviewer:** Claude Opus 5, independent verification (gates re-run, production DB queried, defects reproduced)
**Branches:** `feat/authoritative-templates` (Piece 2), `feat/new-event-workflows` (Piece 2 rebased + Piece 3)

> **Status: resolved and merged** — PR #64, `main` at `ac27bdb`, deployed.
> All findings below were fixed, plus a **fourth** that only surfaced once the
> SQL suite was actually run: migration 70 had dropped three contract-expiry
> placeholders that migration 58 deliberately put there for the WhatsApp leg.
> Migration 73 restores them and is applied live. See §6.

---

## 1. What I verified myself, rather than accepting

Both reports claimed passing gates. I re-ran every gate on `feat/new-event-workflows`, which
carries both pieces (Piece 2's tree there is byte-identical to `feat/authoritative-templates`
apart from migration 71).

| Gate                | Claimed   | Verified                                   |
| ------------------- | --------- | ------------------------------------------ |
| `bun run typecheck` | pass      | **pass**                                   |
| `bun run test`      | 542 tests | **pass — 79 files, 542 tests**             |
| `bun run lint`      | 0 errors  | **pass — 0 errors, 17 pre-existing warns** |
| `bun run build`     | pass      | **pass — Nitro output generated**          |
| `bun run test:sql`  | _not run_ | **FAILS — two tests break (§2.1)**         |

Production database, queried live over `ssh-danatfuture-mcp`:

- Migrations 70, 71, 72 are all applied.
- 26 active templates with both bodies (was 16).
- 9 `kind='event'` workflow rows (was 4).

So the honest summary of both reports is: **accurate about what they ran, and both wrong about
what they didn't.**

---

## 2. Defects found

### 2.1 — BLOCKER: Piece 3 breaks two of Piece 2's and Piece 1's SQL tests

`bun run test:sql` fails on the combined branch. Two tests assert exact row lists that migration
72 invalidates:

| Test                                    | Asserts                       | Reality after migration 72 |
| --------------------------------------- | ----------------------------- | -------------------------- |
| `src/db/templateBodies.sqltest.ts:34`   | exactly 16 template codes     | 26                         |
| `src/db/workflowRegistry.sqltest.ts:40` | exactly 4 event workflow keys | 9                          |

Both use `expect(rows.map(...)).toEqual([...])` — an exact-list assertion, not containment.
Migration 72 adds 10 active templates and 5 event rows. Neither test was updated.

**Why it was missed:** Codex's report states the SQL harness "was intentionally not run because
this project requires database verification against the live Supabase PostgreSQL service rather
than a local replacement."

That is a misreading of the constraint. The standing instruction is that **migrations** are
applied to the live container over SSH instead of local Docker. It says nothing about the test
harness. `bun run test:db` builds a throwaway database from `db/migrations/` and is the only
gate that exercises migration files at all — unit tests mock Supabase entirely.

This is the same class of regression Piece 1 hit: adding event rows silently broke
`expiryBuckets.sqltest.ts`'s seed-parity assertion, and **only the SQL suite caught it.** The
lesson was available and was not applied.

**Fix:** update the two constants, or convert both to containment assertions. ~10 lines.

---

### 2.2 — BLOCKER: HTML-escaped values reach the email Subject header

**Neither model caught this. It is a genuine regression introduced by Piece 2 and inherited by
all five of Piece 3's new senders.**

`src/fns/loadTemplateCopy.ts:33-38` builds one escaped variable map and uses it for both the
body and the subject:

```ts
const safe = escapeVariables(variables);
return {
  subject: renderTemplate(locale === "ar" ? row.subject_ar : row.subject_en, safe),
  body: renderTemplate(locale === "ar" ? row.body_ar : row.body_en, safe),
};
```

HTML-escaping is correct for the body and wrong for the subject — an email Subject is a
plain-text header, not markup. Reproduced:

```
SUBJECT >>> Deposit cash &amp; cheque for O&#39;Brien
BODY    >>> <p>cash &amp; cheque</p>
```

The body is right. The subject ships `&amp;` and `&#39;` to the recipient's inbox.

**Blast radius** — every subject containing a free-text or punctuated value:

| Sender                 | Subject placeholder | Realistic breaking input     |
| ---------------------- | ------------------- | ---------------------------- |
| `contact-inquiry-*`    | `{{name}}`          | **public form input**        |
| `refund-recorded-*`    | `{{code}}`          | any `&` in a reference       |
| `deposit-confirmation` | `{{note}}`          | "cash & cheque"              |
| every tenant-facing    | `{{tenant_name}}`   | `O'Brien`, `Al-Sabah & Sons` |

**Why every test missed it:** the fidelity, loader and sender samples are all special-character
free (`أحمد المطيري`, `PAY-2026-0042`, `R-1`), and `loadTemplateCopy.test.ts` asserts escaping on
`out.body` only — never on `out.subject`.

**Why it is a Piece 2 regression, not pre-existing:** the built-in builders interpolate raw, so
`builtIn.subject` was always clean. The escaped subject only wins when a template row exists —
which migration 70 has now guaranteed for all 16 rows.

**Not yet live:** migration 70 is applied but the senders are unmerged, so no mail has gone out
this way. It is catchable before merge, which is the entire value of finding it now.

**Fix:** return the subject rendered from the _raw_ map and the body from the escaped map:

```ts
subject: renderTemplate(subjectTemplate, variables),   // plain-text header
body:    renderTemplate(bodyTemplate,    safe),        // HTML
```

Plus one test asserting `out.subject` contains a literal `&`.

---

### 2.3 — Piece 2 delivered test coverage for 1 of 6 senders

Plan 2, Task 5 Step 5: _"Add the same two tests (template reaches the body; missing row falls
back) to each sender's test file."_

Only `notifyDepositConfirmed.test.ts` got them. The senders with **no assertion that the stored
template reaches the sent body** — the single behaviour Piece 2 exists to deliver:

- `notifyPaymentSuccess.ts` (receipt **and** payment-admin-alert — two template codes)
- `overdueRemindersJob.ts`
- `contractExpiryJob.ts`
- `sendInvoiceToTenant.ts`

The wiring looks correct on inspection, and `templateFidelity.test.ts` proves the _seeded bodies_
are faithful. But nothing proves those five call sites actually _read_ the row. A future refactor
that reverts one to `builtIn.html` ships green.

This is the exact failure the pre-existing defect describes: templates that are tagged on the
notification but never read. Piece 2 fixed it for six senders and pinned it for one.

---

### 2.4 — Deploy-ordering: production shows raw i18n keys today

Migration 72 was applied to production before the app code merged. `main`'s dictionary has **zero**
of the five `notificationType.*` labels, and
`admin.settings.notifications.tsx:689` renders `{t(\`notificationType.${template.type}\`)}`.

So the Templates tab in production is currently rendering ten rows labelled
`notificationType.contact_inquiry`, `notificationType.contract_ended`, and so on.

Cosmetic, and it resolves the moment the branch merges. The branch has all 10 keys (5 × 2
locales), verified. Worth knowing it is visible now.

---

### 2.5 — Merge hazard neither report addresses

- `feat/new-event-workflows` carries **rebased copies** of Piece 2's commits (`9b459ab`/`f84aa09`
  vs `9c644ca`/`3e9b64c`) — identical trees, different SHAs. Merging both branches to `main`
  produces duplicate-content commits.
- `2bafec9` _feat(payments): settle monthly invoices from the Add Payment form_ exists **only** on
  `feat/authoritative-templates`, is outside Plan 2's scope, and is orphaned if you merge the
  other branch.

Recommended path: merge `feat/new-event-workflows` (it contains both pieces), then cherry-pick
`2bafec9` separately — it is unrelated work and deserves its own review.

---

## 3. What each model got right

### Grok 4.5 (Piece 2)

- **Improved on the plan where the plan was wrong.** The plan specified
  `SEEDED_BODIES["receipt-ar"]["ar"]` — a shape that duplicates every body twice. Grok keyed the
  fixture by base code (`SEEDED_BODIES["receipt"]`), matching migration 70's actual structure
  (8 `update … where code in ('receipt-ar','receipt-en')` statements). Cleaner than specified.
- **Took the snapshot before writing** (`/tmp/templates-before-70.csv`), as the plan required.
- **Extended the variable registry beyond the plan** — `document_send` gained `paid`, `total`,
  `footer` that the plan's list omitted, evidently by reading the actual builder.
- **The sandboxed preview is correct**: empty `sandbox=""`, no `allow-scripts`, no
  `allow-same-origin`, previewing through the same `renderEmailDocument` the senders call.

### Codex 5.6 (Piece 3)

- **Got the hardest trap in this codebase right.** `notifyContractLifecycle.ts:163` uses
  `throw new Error("Forbidden")`, not `throw new Response("Forbidden", { status: 403 })`. A thrown
  `Response` resolves as _success_ client-side in this stack — the pre-existing senders
  (`notifyDepositConfirmed`, `notifyPaymentSuccess`) still carry that bug. Codex avoided it in all
  four new server functions without being told.
- **Escaped the fallback body** (`notifyContractLifecycle.ts:87-88`) — the built-in fallback path
  interpolates through `escapeVariables`, closing an injection route the plan did not mention.
- **Wrote template-read tests for two of its four senders** (contact inquiry, contract lifecycle)
  — proportionally better coverage of the same behaviour than Piece 2 achieved.
- **Refactored `useRefunds.ts` to carry the exact inserted row** rather than re-selecting the
  refund, which is correct under concurrency. Larger diff than the plan implied, and justified.
- **Kept `contract-created` and `contract-ended` genuinely independent** — separate keys, types,
  templates, idempotency payloads and permissions, with a real transition guard
  (`nonTerminalStates` → ended) so editing an already-ended contract does not re-notify.

---

## 4. Comparison

A caveat before scoring: **Plan 2 was the more prescriptive document** — 1332 lines and 36 code
blocks across 7 tasks, versus Plan 3's 956 lines and 25 blocks across 6. Tasks 1–3 of Plan 2 were
near-complete source. Grading "fidelity to plan" without saying so flatters Grok. The
genuine-authorship surface is Grok's Tasks 4 and 6 against all six of Codex's.

| Dimension                    | Grok 4.5 (Piece 2)                      | Codex 5.6 (Piece 3)                         |
| ---------------------------- | --------------------------------------- | ------------------------------------------- |
| Gates actually run           | typecheck, test, lint, build            | typecheck, test, lint, build                |
| Gates skipped                | `test:sql`                              | `test:sql` — **and rationalised the skip**  |
| Regressions introduced       | §2.2 subject escaping                   | §2.1 two broken SQL tests (+ inherits §2.2) |
| Specified coverage delivered | **1 of 6 senders**                      | 2 of 4 senders (not specified per-sender)   |
| Improved on the plan         | fixture shape, extra variables          | `throw Error`, escaped fallback, refund row |
| Report honesty               | accurate; flagged manual check as unrun | accurate; **skip justification is wrong**   |

**Verdict: comparable quality, different failure modes. I would not declare a winner.**

The discriminator that matters is _when each failure surfaces_:

- **Codex's defect is loud.** `bun run test:sql` fails the moment anyone runs it. Ten-line fix.
  Its damage is bounded and immediate.
- **Grok's gap is silent.** Five senders can regress to the built-in builder and every gate stays
  green. It surfaces as "I edited the template and the email didn't change" — weeks later, from a
  user, with no failing test to point at. That is precisely the defect Piece 2 was commissioned to
  eliminate, left half-open.

On process discipline Codex is the weaker of the two: it did not merely skip a gate, it wrote a
justification for skipping that misstates a project constraint. A skip acknowledged as a gap is
recoverable; a skip argued as correct suppresses the next person's instinct to run it.

On code judgement Codex is the stronger: it independently avoided a codebase-specific trap that
still exists in code Grok modified and left unchanged, and it hardened a fallback path the plan
never mentioned.

Neither model caught §2.2, the one defect that would have reached real recipients.

---

## 5. Required before merge

1. **Fix §2.2** — subject from raw variables, body from escaped. Add the missing subject test.
2. **Fix §2.1** — update the two SQL test constants; run `bun run test:sql` to confirm.
3. **Fix §2.3** — add the two template-read tests to the remaining five senders.
4. **Decide the merge path** (§2.5) — recommend merging `feat/new-event-workflows`, then handling
   `2bafec9` separately.
5. **Run the two manual browser checks** both reports correctly flagged as outstanding.

---

## 6. Resolution (2026-08-02, PR #64)

| Finding                     | Fix                                                                                                                                   | Commit    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| §2.2 subject double-escaped | Subject renders from raw values, body from escaped                                                                                    | `b34d445` |
| §2.1 two SQL tests broken   | `templateBodies` scoped to its own codes; `workflowRegistry` EVENT_KEYS exhaustive at 9                                               | `25da807` |
| §2.3 five senders uncovered | All six now assert the row is READ and that a missing row falls back                                                                  | `0ff53e2` |
| §2.5 merge hazard           | `2bafec9` cherry-picked onto the combined branch; `feat/authoritative-templates` fully contained in `main` (verified by `git cherry`) | `254ec96` |
| §2.4 raw i18n keys in prod  | Resolved by the merge — the five labels ship with this release                                                                        | —         |

### The fourth defect, found only by running `test:sql`

Migration 58 set the `contract-expiry` bodies deliberately: their text feeds
**both** legs — the email, and the WhatsApp message via `stripMarkup` — carrying
`{{unit}}`, `{{days_until}}` and `{{company_name}}`, with
`provider_param_keys = ['tenant_name','unit','days_until','company_name']` seeded
to match.

Migration 70 ported every body from its email builder and overwrote these two
with the builder's three placeholders, dropping the other three. The body stopped
agreeing with its own param keys, and the WhatsApp reminder lost the unit and the
day count — the whole point of an expiry notice. `contractExpiryJob`'s own comment,
"`days_until` is what the seeded template bodies bind to", had quietly become false.

`expiryBuckets.sqltest.ts:160` asserts `{{days_until}}` survives. **That assertion
had existed since migration 58 and would have failed the moment either model ran
the suite.** Neither did. Migration 73 restores the union of both sets; the sender
supplies the three variables and the editor lists them; `contractExpiryJob.test.ts`
now asserts no `{{token}}` survives into a sent body.

This strengthens rather than changes §4's verdict. Grok's gap was the silent one
and it turned out to be wider than the review found — a dropped placeholder in a
live tenant-facing message, invisible to every gate either model ran. Codex's
skip of `test:sql` is what let it ship; the suite was the one thing that knew.

### Final gates on the merged branch

| Gate                | Result                                                   |
| ------------------- | -------------------------------------------------------- |
| `bun run typecheck` | pass                                                     |
| `bun run test`      | 83 files, 567 tests                                      |
| `bun run test:sql`  | 17 files, 133 tests — 70 migrations applied from scratch |
| `bun run lint`      | 0 errors across every file in the branch                 |
| `bun run build`     | pass                                                     |

Live verification: image rebuilt on merge, container swapped, `https://danat-future.com/`
returns HTTP 200, and the new labels are present in the deployed bundle
(`index-CzgxoiCb.js`).

Manual browser checks remain: `docs/superpowers/journeys/2026-08-02-live-test-journey.md`.
