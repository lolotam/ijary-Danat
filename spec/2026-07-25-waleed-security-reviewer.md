# Waleed Security Reviewer Skill Specification

## Status

Approved for implementation on 2026-07-25.

## Purpose

Create a portable Agent Skills-compatible skill named
`waleed-security-reviewer` for evidence-based, end-to-end security and
high-impact correctness reviews of authorized codebases.

The skill must cover application code, APIs, authentication, authorization,
multi-tenant isolation, databases, PostgreSQL and Supabase row-level security
(RLS), dependencies, CI/CD, infrastructure configuration, secrets, and current
published vulnerability advisories.

## Core Principles

1. Review the complete attack surface, not only changed files or scanner output.
2. Report findings before changing code, policies, schema, or infrastructure.
3. Separate confirmed findings from likely issues and items that still require
   validation.
4. Prefer reproducible evidence and traced execution paths over pattern-only
   claims.
5. Use multiple review techniques because no scanner or checklist provides
   complete coverage.
6. Never claim to find every vulnerability, unknown zero-day, or runtime issue.
7. Perform active testing only against systems the user explicitly authorizes.

## Scope

### Repository and Architecture Discovery

The reviewer will:

1. Read repository instructions before inspection.
2. Use an existing code knowledge graph when available, then verify conclusions
   against source files.
3. Identify languages, frameworks, entry points, trust boundaries, data stores,
   authentication providers, deployment targets, and package managers.
4. Build an inventory of routes, jobs, webhooks, queue consumers, privileged
   functions, database access paths, migrations, and infrastructure manifests.
5. State uninspected or unavailable areas as residual risk.

### Application Security

The review will cover:

1. Authentication, sessions, tokens, account recovery, and credential handling.
2. Authorization, RBAC/ABAC, object-level authorization, IDOR/BOLA, and tenant
   boundaries.
3. Input validation, injection, output encoding, XSS, CSRF, SSRF, path
   traversal, unsafe redirects, file handling, and deserialization.
4. Business-logic abuse, replay, idempotency, race conditions, rate limits,
   resource exhaustion, and fail-open behavior.
5. Cryptography, key management, randomness, signature verification, and
   sensitive-data handling.
6. Logging, monitoring, error disclosure, privacy, and auditability.
7. Browser and API configuration, including CORS, CSP, cookies, and security
   headers.

### Database and RLS Security

The review will inspect schema, migrations, queries, stored functions, grants,
and application data-access code. PostgreSQL and Supabase reviews will include:

1. RLS enablement and `FORCE ROW LEVEL SECURITY` where ownership bypass matters.
2. Policy coverage for `SELECT`, `INSERT`, `UPDATE`, and `DELETE`.
3. Correct use of `USING` and `WITH CHECK`.
4. Isolation across anonymous, authenticated, staff, service, and tenant roles.
5. Table-owner, service-role, view, function, and privileged RPC bypass paths.
6. `SECURITY DEFINER`, immutable `search_path`, function execution grants, and
   privilege escalation risks.
7. Unsafe grants, public schema exposure, storage policies, raw SQL, dynamic
   SQL, and injection.
8. Cross-tenant foreign-key and indirect-reference paths.
9. Transaction boundaries, lost updates, duplicate processing, and partial
   writes.
10. Real isolation tests using at least two tenants when the project test stack
    supports a database fixture.

### Supply Chain and Current Advisories

The reviewer will:

1. Identify direct and transitive dependencies from manifests and lockfiles.
2. Use installed ecosystem audit tools when available.
3. When network research is available, check current primary sources such as
   vendor advisories, OSV, GitHub Security Advisories, CISA KEV, and NVD.
4. Record the advisory source and search date.
5. Confirm that the installed version and reachable code path are affected
   before classifying a dependency finding as confirmed.
6. Inspect unpinned dependencies, unknown registries, install scripts,
   generated artifacts, and secret exposure in build pipelines.

### Infrastructure and Delivery

The review will cover CI/CD workflows, containers, IaC, cloud permissions,
network exposure, TLS, environment separation, production debug settings,
artifact integrity, and secret injection. It will not access production or
change infrastructure without explicit authorization.

### High-Impact Correctness Bugs

The skill will include correctness defects that can cause security, financial,
availability, privacy, or data-integrity impact. Examples include broken state
transitions, non-idempotent retries, race conditions, swallowed failures,
incorrect transaction handling, and destructive edge cases.

Formatting preferences, minor maintainability observations, and speculative
style concerns are outside the findings report unless they create a concrete
risk.

## Review Workflow

1. Confirm the authorized scope and whether the review is read-only.
2. Read project rules and map the repository before broad searching.
3. Inventory attack surfaces, data flows, trust boundaries, and privileged
   operations.
4. Select applicable language, framework, database, cloud, and dependency
   checks.
5. Trace candidate findings from untrusted input or privilege boundary to an
   observable impact.
6. Run safe static checks, dependency audits, and project tests when available.
7. Validate database and tenant-isolation assumptions against migrations,
   policies, application queries, and tests.
8. Research current advisories only through available, attributable sources.
9. De-duplicate findings and challenge false positives.
10. Produce the report and request approval before applying any remediation.
11. If approved, implement fixes with regression tests and rerun the affected
    review areas.

## Finding Model

Each finding must include:

- Identifier and concise title.
- Severity: `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`.
- Confidence: `CONFIRMED`, `LIKELY`, or `NEEDS VALIDATION`.
- Affected file and line, component, migration, policy, or dependency.
- Evidence and the traced execution or data path.
- Preconditions and realistic impact.
- CWE and applicable OWASP ASVS, WSTG, or Top 10 references.
- Minimal remediation guidance.
- A regression or verification test.

The report must lead with findings ordered by severity. If no confirmed
findings exist, it must say so and list residual risks, unavailable evidence,
and checks that could not be run.

## Safety Boundaries

The skill must not:

1. Perform unauthorized testing or scan unrelated external systems.
2. Exploit a vulnerability beyond the minimum safe evidence needed to validate
   it.
3. Extract, display, or transmit real secrets or sensitive records.
4. Modify production data, RLS policies, IAM, firewall rules, or deployments
   during the review phase.
5. Use destructive database commands or persistence mechanisms.
6. Present pattern matches, scanner output, or model guesses as confirmed facts.

## Skill Structure

The canonical package will live at:

`~/.agents/skills/waleed-security-reviewer/`

It will contain:

- `SKILL.md`: routing, review workflow, safety rules, and report contract.
- `references/application-security.md`: application and API review checks.
- `references/database-rls.md`: database, PostgreSQL, and Supabase checks.
- `references/supply-chain.md`: dependency and current-advisory workflow.
- `references/infrastructure.md`: CI/CD, container, IaC, and cloud checks.
- `references/validation-reporting.md`: evidence, severity, confidence, and
  reporting rules.
- `evals/evals.json`: realistic behavior evaluations for the skill.

The main skill will use capability-based instructions rather than vendor tool
names so it can operate across different CLI toolsets.

## Cross-CLI Installation

Use one canonical package and expose it to each installed client:

| Client          | Discovery strategy                                       |
| --------------- | -------------------------------------------------------- |
| OpenCode        | Auto-discovers `~/.agents/skills/`                       |
| Grok CLI        | Auto-discovers `~/.agents/skills/`                       |
| Claude Code     | Directory link under `~/.claude/skills/`                 |
| Gemini CLI      | Auto-discovers `~/.agents/skills/`                       |
| Pi agent        | Auto-discovers `~/.agents/skills/`                       |
| Antigravity IDE | Directory link under `~/.gemini/antigravity-ide/skills/` |

Links must point to the canonical package so every client sees the same version.
The installer must not overwrite an unrelated existing skill with the same
name.

## Evaluation Plan

Before writing the skill, run baseline reviews without it against at least:

1. A multi-tenant Supabase fixture with incomplete RLS and a server secret
   exposed to browser code.
2. An API fixture with object-level authorization failure, unsafe SQL, and an
   affected dependency.
3. A safe fixture containing suspicious patterns that require context to avoid
   false positives.

Evaluate whether the reviewer inventories the full system, covers database and
RLS behavior, checks current advisories with dates and sources, distinguishes
confidence, provides reproducible evidence, respects authorization boundaries,
and avoids unsupported claims.

Run the same evaluations with the skill, grade both configurations, review the
delta, and close material gaps before global installation.

## Acceptance Criteria

1. Every named CLI discovers the same canonical skill or a live link to it.
2. The skill triggers for end-to-end security reviews, database/RLS audits,
   dependency vulnerability reviews, and pre-release AppSec checks.
3. Reviews cover code, data, dependencies, infrastructure, and high-impact
   correctness rather than only running a scanner.
4. Findings are severity-ranked, evidence-backed, confidence-labelled, and
   reproducible.
5. Current-vulnerability claims include a source, affected version analysis,
   and research date.
6. The skill reports before editing and requires approval for remediation.
7. The skill passes the defined evaluations without creating materially more
   false positives than the baseline.
8. The package attributes OWASP WSTG and compatible adapted material under
   Creative Commons Attribution-ShareAlike 4.0.

## Sources and Attribution

This design is informed by the OWASP Web Security Testing Guide, OWASP ASVS,
OWASP Top 10, CWE, CISA KEV, OSV, GitHub Security Advisories, NVD, and vendor
security advisories.

OWASP WSTG content is licensed under Creative Commons Attribution-ShareAlike
4.0. Adapted WSTG-derived material in the skill will preserve attribution,
identify modifications, and use a compatible license. OWASP does not endorse
this skill.
