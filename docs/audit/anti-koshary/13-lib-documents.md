# S13 — `src/lib`: documents & rendering (email, PDF, print HTML, contract builder)

**Lines read:** ~5,500 · **Files:** 20 · **Date:** 2026-09-22

`emailTemplates.ts` (677) · `closeoutStatement.ts` (584) · `printDocument.ts` (536) ·
`paymentReceiptPdf.ts` (444) · `companyInfoDocument.ts` (374) · `paymentReceiptHtml.ts` (317) ·
`printedDocument.ts` (299) · `signatureHtml.ts` (235) · `companyInfoPdf.ts` (214) ·
`serverPdf.ts` (210) · `reportPdfAttachment.ts` (164) · `invoicePrintHtml.ts` (153) ·
`companyInfoMessage.ts` (144) · `paymentPrintDocument.ts` (122) · `invoiceDocument.ts` ·
`paymentDocument.ts` · `templateRender.ts` · `xlsx.ts` · `error-page.ts` ·
`contractBuilder/` (5 files, 1454).

**Overall:** this is the most duplication-prone corner of the codebase — five independent
renderers (email client, browser print, html2canvas raster, headless Chromium, XLS) all
producing HTML for an Arabic RTL product. Two rules that must hold identically across all of
them are each written out several times, and one of them is the XSS boundary.

---

## Findings

### 1 · High — `escapeHtml` is implemented six times, and three of them are weaker than the other three

**Where:**

| Implementation | `&` `<` `>` `"` | `'` |
| --- | --- | --- |
| `emailTemplates.ts:203` — **exported** | ✓ | **✓** |
| `signatureHtml.ts:36` | ✓ | **✓** |
| `templateRender.ts:70` (`escapeHtmlValue`) | ✓ | **✓** |
| `printDocument.ts:139` | ✓ | **✗** |
| `companyInfoMessage.ts:138` | ✓ | **✗** |
| `xlsx.ts:3` | ✓ | **✗** |

Five are named `escapeHtml`; three of those are module-private, so nothing at a call site
tells you which variant you are using.

**Not exploitable today — verified, not assumed.** `grep "='\${"` across `src/lib` returns
**zero** single-quoted interpolated attributes, and every call site inspected
(`companyInfoMessage.ts:72,73,85,133`, `printDocument.ts:182,184,198`, `xlsx.ts:25,27`)
writes into text content or a double-quoted attribute, where escaping `"` is sufficient.

**Which means:** this is the drift that has already happened, waiting on one more edit to
become a bug. These functions escape admin-authored notification template bodies and
tenant-supplied data on its way into emails, printed receipts and exported spreadsheets —
the XSS boundary of the product. The moment anyone writes `style='...${escapeHtml(x)}...'`
in `printDocument`, `companyInfoMessage` or `xlsx`, the escape is silently insufficient and
there is nothing at the call site to warn them, because the identically-named function two
files over *would* have handled it.

**Fix:** one `escapeHtml` in `src/lib/html.ts` with the five-character set, imported by all
six. `emailTemplates.ts:203` is already exported and already the strong version — promote
it. Delete the other five. ~30 lines removed; the only behaviour change is that apostrophes
start being escaped in three more places, which is correct and invisible.

---

### 2 · Medium — five renderers, five different answers to "what font renders Arabic"

**Where:**

| Renderer | Font stack | Arabic face |
| --- | --- | --- |
| `serverPdf.ts:36` (`PDF_FONT_STACK`) | `"Noto Naskh Arabic", "Noto Sans", "DejaVu Sans"` | **Noto Naskh Arabic** |
| `printDocument.ts:81` (browser print / html2canvas) | `"Segoe UI", Tahoma, Arial, "Noto Sans Arabic"` | **Noto *Sans* Arabic** |
| `companyInfoDocument.ts:50` | `"Segoe UI", Tahoma, Arial, "Noto Sans Arabic"` | Noto Sans Arabic |
| `emailTemplates.ts:73` (email body) | `'Segoe UI', Tahoma, Arial, sans-serif` | **none** |
| `companyInfoMessage.ts:71` (email message) | `Segoe UI, Arial, sans-serif` | **none** |
| `signatureHtml.ts:130` (email signature) | `Arial, sans-serif` | **none** |

Only `serverPdf.ts` names its stack in a constant; the other five inline a string literal.

**Which means:** the same Arabic content renders in **Noto Naskh Arabic** as a server PDF,
in **Noto Sans Arabic** when printed from the browser, and in whatever the mail client
happens to pick in an email — because three of the six stacks name no Arabic face at all.
For a product whose primary language is Arabic and whose users compare a printed receipt
against the emailed one, that is a visible inconsistency, not a theoretical one. Changing
the brand typeface means finding six string literals, three of which are in files nobody
associates with typography.

**Fix:** one exported `ARABIC_FONT_STACK` (and, if the PDF genuinely needs Naskh over Sans,
a documented `PDF_FONT_STACK` that says why it differs) in `src/lib/`. Six imports. Decide
deliberately whether the email stacks should gain an Arabic face — they probably should, but
email clients are conservative about webfonts and that is a judgement the user should make.
**Flagged, not chosen.**

---

### 3 · Medium — the load-bearing Arabic glyph-joining fix is stated three times, and two other files work against it

**Where:** `printDocument.ts:57-58` (`PDF_CAPTURE_CSS`) · `serverPdf.ts:45` ·
referenced again in `closeoutStatement.ts:8`

```css
* { letter-spacing: normal !important; }
```

`printDocument.ts:36-53` explains it: html2canvas 1.4.1 draws a text run one grapheme at a
time whenever computed `letter-spacing` is non-zero, which breaks Arabic glyph joining.
`serverPdf.ts:39-42` repeats the rule and the reasoning for Chromium, explicitly noting
*"same rule and reason as PDF_CAPTURE_CSS in printDocument.ts"*.

Meanwhile `companyInfoDocument.ts:119,172` and `printedDocument.ts:187` **set non-zero
letter-spacing** (`0.5px`, `1px`) on document elements — which is exactly what the reset
exists to defeat.

**Which means:** Arabic renders correctly in the two paths that remember to inject one of the
two resets, and the document builders are actively setting the property that breaks it. A
sixth renderer, or a path that skips `PDF_CAPTURE_CSS`, produces disjointed Arabic — and the
repo has already spent a session diagnosing exactly that class of bug, which is why the
comments are so detailed. The knowledge is captured; the *enforcement* is copy-pasted.

**Fix:** one exported `ARABIC_SAFE_CSS` constant containing the reset and its comment,
imported by both renderers. Separately, decide whether `companyInfoDocument` and
`printedDocument` should stop setting `letter-spacing` at all — the reset makes those
declarations dead anywhere they are honoured, so they are either useless or a latent bug.

---

## Not reported, and why

- **The three full HTML document shells** — `emailTemplates.ts:58` (email),
  `printDocument.ts:192` (browser print), `serverPdf.ts:86` (`wrapHtmlForPdf`). These look
  like the obvious merge target and **are not one**: an email shell needs inline CSS and
  table layout for Outlook, a print shell needs `@page`, a Chromium shell needs the font
  stack and viewport. Three renderers with three sets of constraints and every reason to
  diverge. Merging them would need a mode flag per caller — the reference's explicit sign
  that an extraction will make things worse. **Leave them.** Findings 1–3 extract the
  *rules* they share, which is the part that is genuinely coupled.
- **`error-page.ts` and `xlsx.ts` building their own HTML** — an error page must not depend
  on the document machinery, and `xlsx.ts` emits an HTML table that Excel parses, not a
  document. Both correctly separate.
- **`contractBuilder/` (5 files, 1454 lines)** — `schema`, `html`, `clauses.ar`,
  `clauses.en`, `numberToWords`. The Arabic and English clause sets are two files that look
  parallel and must stay parallel-but-separate: they are legal text, not translations of one
  string table. Correct.
- **`closeoutStatement.ts` (584) and `paymentReceiptPdf.ts` (444)** — over the ceiling, each
  one document with its own data assembly. Length without the symptoms.

## Test coverage of this scope

Reasonable: `templateRender`, `csv`, `xlsx`, `contractBuilder/clauses`, `money` and
`emailTemplates` all have suites. **None of the three findings is covered**, and two of them
could not easily be: a test that Arabic glyphs joined correctly needs rasterisation, which is
precisely why the repo's own note says to verify PDF output by rasterising rather than by
unit test. `serverPdf`'s test spawns real Chromium and is known to flake under full-suite
load — check that before blaming a change here.

**Consequence for Pass 2:** finding 1 is safe and typecheck-verified — one import swap per
file, and the only behavioural delta (apostrophes escaped in three more places) is correct
by definition. Findings 2 and 3 change rendered output and **must be verified by looking at a
generated PDF and a received email**, not by a green suite.

## Ledger entries added

See `LEDGER.md` — the six `escapeHtml`s, the six font stacks, the three letter-spacing
resets, the three document shells (recorded as *do not merge*).
