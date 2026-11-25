# Waleed Security Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, evaluate, and globally install one portable `waleed-security-reviewer` skill for evidence-based end-to-end codebase, database, RLS, dependency, infrastructure, and high-impact bug reviews.

**Architecture:** Keep one canonical Agent Skills package under `C:\Users\HP\.agents\skills\waleed-security-reviewer`. OpenCode, Grok, Gemini CLI, and Pi discover that package directly; Claude Code and Antigravity use live directory links so every client reads the same files. The skill routes reviewers through staged discovery, validation, and reporting, while focused reference files hold domain checklists.

**Tech Stack:** Agent Skills `SKILL.md`, Markdown references, JSON evaluations, Python skill-creator validation/viewer scripts, Windows directory junctions, and the installed OpenCode, Grok, Gemini, Pi, and Claude CLIs.

---

## File Map

**Canonical package**

- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\SKILL.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\LICENSE.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\references\application-security.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\references\database-rls.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\references\supply-chain.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\references\infrastructure.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\references\validation-reporting.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\references\sources.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer\evals\evals.json`

**Evaluation workspace**

- Create directory: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\benchmark.json`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\review.html`

**Client links**

- Create link: `C:\Users\HP\.claude\skills\waleed-security-reviewer`
- Create link: `C:\Users\HP\.gemini\antigravity-ide\skills\waleed-security-reviewer`

OpenCode, Grok, Gemini CLI, and Pi require no extra link because they scan
`C:\Users\HP\.agents\skills`.

### Task 1: Establish RED Baseline Evaluations

**Files:**

- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\eval-supabase-rls\without_skill\outputs\review.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\eval-api-supply-chain\without_skill\outputs\review.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\eval-context-false-positive\without_skill\outputs\review.md`

- [ ] **Step 1: Verify the workspace parent and create evaluation directories**

Run `Test-Path -LiteralPath "C:\Users\HP\.agents\skills"` and stop if it is
false. Create only the `waleed-security-reviewer-workspace\iteration-1`
subdirectories. Do not create the skill package yet; the baseline must run
without it.

- [ ] **Step 2: Run the Supabase/RLS baseline**

Dispatch a fresh general-purpose agent without the new skill. Give it a small
multi-tenant fixture containing:

```sql
create table public.invoices (
  id uuid primary key,
  tenant_id uuid not null,
  amount numeric not null
);
alter table public.invoices enable row level security;
create policy invoice_read on public.invoices
for select using (tenant_id = auth.uid());

create function public.mark_invoice_paid(invoice_id uuid)
returns void language sql security definer as $$
  update public.invoices set amount = 0 where id = invoice_id;
$$;
grant execute on function public.mark_invoice_paid(uuid) to authenticated;
```

Also include browser configuration containing
`VITE_SUPABASE_SERVICE_ROLE_KEY`. Ask for an end-to-end review with evidence,
severity, confidence, RLS role analysis, and regression tests. Save the complete
response to the specified `review.md`.

- [ ] **Step 3: Run the API/supply-chain baseline**

Dispatch a second agent without the new skill. Include a Node route that uses
authentication but performs no object-level authorization, interpolates a path
parameter into SQL, and returns raw exception messages:

```typescript
app.get("/api/orders/:id", requireAuth, async (req, res) => {
  try {
    const order = await db.query(`select * from orders where id = '${req.params.id}'`);
    res.json(order.rows[0]);
  } catch (error) {
    res.status(500).json({ error: (error as Error).stack });
  }
});
```

Use a lockfile containing `lodash@4.17.20`, which is affected by
`CVE-2021-23337`, to test version and reachability validation. Require any
advisory claim to include an affected-version check, primary source, and
research date.

- [ ] **Step 4: Run the contextual false-positive baseline**

Dispatch a third agent without the new skill. Include a parameterized query, a
table identifier selected from a hardcoded allowlist, a tenant-membership RLS
policy, and a `SECURITY DEFINER` function with fixed `search_path`, explicit
authorization, and restricted execute grants. Ask the reviewer to report only
evidence-backed vulnerabilities and residual risks.

- [ ] **Step 5: Record baseline failures**

For each output, record which required behaviors were missed: complete attack
surface inventory, RLS bypass analysis, current advisory provenance, confidence
labels, reproducible evidence, authorization boundaries, false-positive
challenge, and report-first behavior. These observed failures define the
minimal skill content.

### Task 2: Write the Minimal Portable Skill

**Files:**

- Create all canonical package files listed in the File Map.

- [ ] **Step 1: Write `SKILL.md` frontmatter and trigger contract**

Use lowercase `name: waleed-security-reviewer`. Start the description with
`Use when` and cover end-to-end codebase security audits, database and RLS
reviews, dependency/CVE reviews, tenant-isolation checks, and pre-release
AppSec reviews. Keep the description focused on triggering conditions rather
than summarizing the workflow.

- [ ] **Step 2: Write the review workflow**

Require this order:

1. Confirm authorized scope and read-only status.
2. Read repository rules and map architecture before broad search.
3. Inventory trust boundaries and privileged data paths.
4. Load only the relevant reference files.
5. Trace each candidate from source to security or correctness impact.
6. Run safe project checks and ecosystem audits when available.
7. Verify findings and challenge false positives.
8. Report first and request approval before remediation.

Make tool instructions capability-based so every target CLI can apply them.

- [ ] **Step 3: Write focused reference files**

Keep the main skill under 500 lines. Put application/API checks in
`application-security.md`; database, PostgreSQL, Supabase, grants, functions,
and tenant isolation in `database-rls.md`; version reachability and primary
advisory sources in `supply-chain.md`; CI/CD, container, cloud, and IaC checks
in `infrastructure.md`; and evidence, severity, confidence, deduplication, and
the exact report format in `validation-reporting.md`.

- [ ] **Step 4: Add safety and honesty rules**

Forbid unauthorized external testing, destructive database operations, secret
exfiltration, production changes during review, unsupported zero-day claims,
and promotion of scanner matches to confirmed findings without validation.

- [ ] **Step 5: Add licensing and attribution**

Use Creative Commons Attribution-ShareAlike 4.0 for adapted material. Attribute
OWASP WSTG, state that the skill is modified and unofficial, and link to the
versioned WSTG material and license in `LICENSE.md` and `references/sources.md`.

- [ ] **Step 6: Add evaluation definitions**

Create `evals/evals.json` with the three baseline prompts, expected behavior,
and objective assertions covering the failures observed in Task 1.

- [ ] **Step 7: Validate package structure**

Run:

```powershell
python "C:\Users\HP\.config\opencode\skills\skill-creator\scripts\quick_validate.py" "C:\Users\HP\.agents\skills\waleed-security-reviewer"
```

Expected: successful validation with no malformed frontmatter, missing
`SKILL.md`, or invalid skill name.

### Task 3: Run GREEN Evaluations and Refine

**Files:**

- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\eval-*\with_skill\outputs\review.md`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\eval-*\{with_skill,without_skill}\grading.json`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\benchmark.json`
- Create: `C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\review.html`

- [ ] **Step 1: Run all three prompts with the skill**

Dispatch fresh agents with the canonical skill path and the same prompts used
for the baselines. Save complete outputs. Do not alter prompts between baseline
and skill runs.

- [ ] **Step 2: Grade behavior, not prose style**

Grade each pair against these assertions:

1. Maps the relevant attack surface before findings.
2. Detects the confirmed auth, SQL, secret, and RLS defects.
3. Explains RLS bypass paths and missing policy semantics.
4. Dates and sources current advisory research or states it could not run.
5. Uses confidence labels and does not overstate pattern matches.
6. Gives file/policy evidence, realistic impact, and a regression test.
7. Avoids confirmed findings in the safe contextual fixture.
8. Reports before proposing edits and respects authorization boundaries.

Save grading entries using `text`, `passed`, and `evidence` fields.

- [ ] **Step 3: Aggregate benchmark results**

Run the skill-creator benchmark aggregation script from its package directory,
pointing it at the iteration workspace and skill name. Confirm that
`benchmark.json` and `benchmark.md` are produced.

- [ ] **Step 4: Refine only material gaps**

If a with-skill run misses an assertion, update the smallest applicable skill
or reference section, rerun the affected evaluation, and regrade it. Do not add
instructions that merely make output longer.

- [ ] **Step 5: Generate the review viewer**

Run:

```powershell
python "C:\Users\HP\.config\opencode\skills\skill-creator\eval-viewer\generate_review.py" "C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1" --skill-name "waleed-security-reviewer" --benchmark "C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\benchmark.json" --static "C:\Users\HP\.agents\skills\waleed-security-reviewer-workspace\iteration-1\review.html"
```

Expected: a standalone `review.html` containing outputs and benchmark results.

### Task 4: Install One Canonical Skill Across Clients

**Files:**

- Create the two client links listed in the File Map.

- [ ] **Step 1: Protect existing installations**

For each destination, run `Test-Path -LiteralPath`. If a destination already
exists, inspect whether it resolves to the canonical package. Stop and report
any unrelated existing destination instead of deleting or overwriting it.

- [ ] **Step 2: Link Claude Code**

Create a Windows directory junction from
`C:\Users\HP\.claude\skills\waleed-security-reviewer` to the canonical
package.

- [ ] **Step 3: Verify Gemini CLI native discovery**

Run:

```powershell
gemini skills list --all
```

Confirm Gemini reports `waleed-security-reviewer` at the canonical `.agents`
path. Do not create a duplicate link under `.gemini\skills`.

- [ ] **Step 4: Link Antigravity**

Create a directory junction in
`C:\Users\HP\.gemini\antigravity-ide\skills` targeting the canonical package.

- [ ] **Step 5: Leave OpenCode, Grok, Gemini, and Pi on native discovery**

Do not create duplicate copies under `.config\opencode\skills` or
`.grok\skills`, `.gemini\skills`, or `.pi\agent\skills`; all four clients
already scan `.agents\skills`.

### Task 5: Final Verification

**Files:**

- Verify all package and link paths from the File Map.
- Update: `graphify-out/` for the project specification and plan documents.

- [ ] **Step 1: Re-run package validation**

Run `quick_validate.py` again after refinements. Expected: success.

- [ ] **Step 2: Verify client discovery**

Run `gemini skills list --all` and `grok inspect`, confirming
`waleed-security-reviewer` resolves to the canonical package. Verify the
Claude and Antigravity junction targets with filesystem metadata, and verify Pi
native discovery against its installed skill documentation. Start a new
OpenCode process or restart OpenCode because its skill configuration is loaded
at startup.

- [ ] **Step 3: Run guard passes**

Review the skill and references for unsupported security claims, unsafe
instructions, duplicated guidance, stale upstream paraphrases, malformed
frontmatter, test bloat, and missing attribution. Fix every material issue.

- [ ] **Step 4: Update the project graph**

Run:

```powershell
graphify update .
```

Expected: the specification and implementation plan are included without graph
integrity errors.

- [ ] **Step 5: Report actual results**

List the canonical path, client discovery results, evaluation pass rates,
viewer path, checks that could not run, and any residual risks. Do not claim
that the skill finds all vulnerabilities or unknown zero-days.
