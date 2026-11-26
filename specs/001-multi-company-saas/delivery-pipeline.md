# Delivery pipeline for tasks.md

The owner set this cycle on 2026-11-27. Claude (Opus 5.5) is the project manager and reviewer of record. It writes briefs, watches the delegated sessions and checks their reports. It does not write production code itself unless the owner says so.

## The cycle

Run it for each batch of tasks from `tasks.md`, in task order.

1. **Pick the batch.** Take the next open tasks and split them into two independent slices that touch different files.
2. **Implement, two models in parallel.** Each slice goes to one model from this pool, and two always run at the same time:
   - Antigravity `agy`, model Hydrogen 4, medium effort.
   - opencode, model `minimax-coding-plan/MiniMax-M3.1-Flash`. The owner asked for the high variant, but the provider has none, so it runs on the default.
   - opencode, Kimi 3.1 Pro. Not yet configured in opencode (`opencode models` lists no Kimi provider).
   - opencode, GLM "3.1 fast". No such model exists; the closest is `zai-coding-plan/glm-5.3-flash`. The zai account currently returns "Insufficient balance".

   Each brief tells the model to work through `/speckit-implement` for its tasks only. It applies `/clean-code-guard:clean-code-guard` to its production code and `/test-guard:test-guard` to its tests before reporting.
3. **Review.** `/waleed_general_reviewer` runs on the combined diff:
   - first choice: opencode, model `zai-coding-plan/glm-5.4`, high variant, read-only (`--agent plan`);
   - fallback: a Claude Opus 5.5 subagent at medium effort, if opencode fails or returns nothing usable.

   Claude checks every Blocker against the cited file and line. Fixes go back to the slice's implementer, followed by a re-review. Security findings need the owner's approval before anyone fixes them.
4. **Gates.** Claude runs `bun run typecheck`, `bun run test`, `bun run test:sql` and `bun run test:db` (when SQL changed), plus `bun run lint` (the repo-wide count must not grow; changed files must be clean).
5. **Commit and push** to `001-multi-company-saas`. Do not open a PR to `main` (Lovable-connected) until the owner asks. Never stage `supabase/.temp/`.
6. **Repeat** with the next batch.

## What every implementation brief must contain

- The task IDs and their exact text from `tasks.md`, plus the contract sections they implement (file paths and section numbers).
- The files to create or edit, and the files the slice must not touch (the other slice's files).
- The existing helpers to reuse, with paths, such as `companyClient`, `CompanyContextError` and `src/jobs/catalog.ts`.
- These project rules, copied from `CLAUDE.md`:
  - Arabic doc comment above every function.
  - Files under 500–600 lines.
  - Never call a company "tenant".
  - `database.types.ts` is edited by hand.
  - `platformClient` only in allow-listed files.
  - RLS policies use hoisted `(select …)` sub-selects.
  - No secrets in code or `VITE_` variables.
- Hard limits:
  - no commit, push, deploy or server access;
  - nothing touches Danat production (`ssh-danatfuture-mcp`, `danatfuture-*`);
  - never weaken, skip or delete a test.
- The done check: the task's tests pass, typecheck is clean and lint on the changed files is clean.
- The report format: files changed, tests added, commands run with their results, and open questions.

## Known blocker

`agy` runs headless only with `--dangerously-skip-permissions`, and this session's permission classifier refuses that flag. Claude does not work around it. The owner either allows that command or runs the printed `agy` command themself. Until then, Claude tells the owner and does not pass the agy slice to another model without asking.
