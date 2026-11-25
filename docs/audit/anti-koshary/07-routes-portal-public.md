# S07 — `src/routes`: portal, public landing page, API routes

**Lines read:** ~4,270 · **Files:** 15 · **Date:** 2026-09-22

`index.tsx` (2136) · `portal.tsx` (390) · `portal.invoices.tsx` (373) · `portal.payments.tsx` (268) ·
`portal_.auth.tsx` (250) · `portal_.payments.callback.tsx` (217) · `portal.lease.tsx` (214) ·
`portal.profile.tsx` (183) · `portal.index.tsx` (177) · `portal.shop.tsx` (17) ·
`portal_.payments.callback_.$preq.tsx` (13) · `api/public/{cron,myfatoorah-webhook,resend-webhook}.ts` (11 each) ·
`api/public/evolution-webhook.ts` (7).

**Overall:** a sharp split. The **portal** and the **API routes** are the best-layered code in
the application — the four public API routes are 7–11 lines of pure delegation, and the
portal files are careful about tenant scoping, chunked fetches and documented error
swallows. The **public landing page** is a single 1,922-line component.

---

## Findings

### 1 · Medium — `LandingPage` is 1,922 lines in one component, the largest in the repo

**Where:** `src/routes/index.tsx:214-2136`

One function body containing:

- **12 page sections** — hero/carousel (`:698`), stats band (`:774`), about (`:831`),
  purpose (`:890`), brands strip (`:950`), shops (`:992`), a CTA band (`:1114`),
  facilities (`:1191`), gallery (`:1343`), location + map (`:1386`), leasing (`:1504`),
  contact form (`:1548-2050`)
- **14 `useState`, 7 `useEffect`, 4 `useMemo`**
- Four direct DOM side-effects, each its own effect: a scroll listener (`:302`), an
  `IntersectionObserver` (`:315`), a `document.body.style.overflow` lock (`:330`), a
  `matchMedia` listener (`:341`), and a pointer-drag carousel (`:457`)
- Five landing queries, a leasing/contact form with `react-hook-form` + zod, and
  **53 of the 306 inline bilingual ternaries from S06 #1**

**Which means:** this is the repo's worst file by every measure the audit uses at once —
largest component, fourth-highest churn (39 changes in 12 months), 3.5× the `CLAUDE.md`
ceiling, and the public face of the business. A change to the contact form requires scrolling
past the carousel's pointer handlers; a change to the carousel requires being sure you have
not disturbed the body-scroll lock two effects above it. There is no test.

It is ranked **Medium** rather than High deliberately: it is a marketing page, so a mistake
here costs presentation, not money or data. But it is the single largest maintainability
liability in the codebase.

**Fix:** each `<section>` is already a clean seam. Extract to
`src/components/landing/` — which exists and currently holds 120 lines — one component per
section, taking the settings/sections/brands/slides data as props. The `LandingPage` shell
keeps the nav, the effects and the data fetching. Do S06 #1's 53 strings during the same
pass rather than touching the file twice. Roughly 1,400 lines move; no behaviour changes.

---

### 2 · Medium — one public form, three schemas, none of them authoritative

**Where:** `routes/index.tsx:197-210` (`leasingFormSchema`) vs
`fns/submitLeasingInquiry.ts:7-20` (`leasingSchema`) vs `fns/submitContactInquiry.ts:11-21`
(`contactSchema`)

The landing page has **one** form that routes by `request_type` (`index.tsx:474`):
`"general"` → `submitContactInquiry`, otherwise → `submitLeasingInquiry`. Three schemas
describe it, and they disagree:

| Field | Client `leasingFormSchema` | Server `leasingSchema` | Server `contactSchema` |
| --- | --- | --- | --- |
| `name` | `min(1)`, **no max** | `min(1).max(200)` | `min(1).max(200)` |
| `phone` | `min(8)`, **no max** | `min(8).max(24)` | `max(24)` optional |
| `email` | `.email()`, **no max** | `.email().max(320)` | `.email().max(320)` |
| `message` | optional, **no max** | optional, `max(2000)` | **required**, `min(1).max(2000)` |
| `website` (honeypot) | `optional()`, **no `.max(0)`** | `max(0)` | `max(0)` |
| `request_type` | **client only** | — | — |
| `consent` | **client only**, required | — | — |
| `locale` | — | **required** `enum(["ar","en"])` | — |
| `subject` | — | — | optional |

**Which means two concrete failures.** (a) A visitor who types a 2,500-character message
passes client validation and is rejected by the server — and because the server fn throws a
raw zod error, what reaches the page is a parse message, not a field-level error on the
textarea. The client schema has no max to tell them before they submit. (b) The `"general"`
branch validates against `leasingFormSchema` and posts to `contactSchema`, where `message`
is **required** and `subject` exists — so the form validating the request is not the schema
receiving it.

Neither is caught by tests: the client schema has no test, and the server schemas are
exported specifically because the `createServerFn` mock never runs `.validator()`
(`submitContactInquiry.ts:8-10` says so).

**Fix:** export the two server schemas (they already are) and derive the client form from
them — `contactSchema.extend({ consent: … })` and
`leasingSchema.omit({ locale: true }).extend({ request_type: …, consent: … })`. One source
of truth for the shared fields; the client keeps only what is genuinely client-side. This is
the same problem as S04 #5, with the drift already visible.

---

## Not reported, and why

Recorded as **correct** so Pass 2 does not disturb them, and because they are the standard
the rest of the app should be measured against:

- **The four public API routes** — `api/public/cron.ts` (11 lines),
  `myfatoorah-webhook.ts` (11), `resend-webhook.ts` (11), `evolution-webhook.ts` (7). Each is
  `createFileRoute` + one delegation to a `respondTo…(request)` function in `src/fns`.
  Zero logic in the transport layer. **This is the correct shape**, and it is why S01 #5's
  criticism of `myfatoorahWebhook.ts` is about the *fns* file, not the route.
- **`portal.invoices.tsx:118-120`** — chunked `in()` via `fetchInChunks`, with the swallow
  documented and justified (it only labels a column that already falls back to "—").
  Contrast S05 #1: the portal got this right and the dashboard did not.
- **`portal.tsx:41-46, 83-95`** — the `?tenant=` admin-preview mechanism, including an
  explicit note that `shop_details_for_tenant` resolves ownership from the *signed-in*
  profile rather than the previewed tenant, so the shop tab is hidden during a preview
  instead of showing the wrong data. Careful and correct.
- **`portal_.payments.callback_.$preq.tsx` (13 lines)** — a route shell that re-uses
  `PaymentCallbackPage`. Correct. (The bug in that page is H1, and it lives in the server fn.)
- **`portal.shop.tsx` (17 lines)** — thin shell over a component.

## Test coverage of this scope

None at the route level for any of the 15 files, including the 1,922-line landing page and
the payment callback where **H1** surfaces. `submitContactInquiry`'s honeypot rule is tested
directly via the exported schema; `submitLeasingInquiry`'s is not.

**Consequence for Pass 2:** finding 1 is a large, entirely uncovered refactor of the public
marketing page — do it section by section, one commit each, and look at the page in a browser
after every commit. There is no substitute here; nothing asserts this page renders. Finding 2
is small and typecheck-verifiable, and it should land **before** H1's fix touches the callback
page, since both change what the client sees on failure.

## Ledger entries added

See `LEDGER.md` — `LandingPage`, the three public-form schemas, the API route shells
(recorded as correct).
