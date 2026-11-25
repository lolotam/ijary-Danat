<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

## Writing code in this repo

**Keep every new file under 500–600 lines.** Past that, split by responsibility —
not by technical layer — so each file has one clear job and things that change
together stay together. It keeps the codebase maintainable and scalable, and it
keeps files small enough for an agent to hold in context and edit reliably. If a
file you are already working in has outgrown the ceiling, splitting it is in
scope; do not refactor unrelated large files you merely read.

**Document every function in Arabic, in a comment above it.** Arabic is the
product's primary language and the UI is RTL — the people maintaining this code
read Arabic first. English may follow for terms with no settled Arabic
equivalent, and for the *why*: the reasoning, trade-off or incident behind a
non-obvious choice.

```ts
/**
 * يحسب إجمالي الإيجار الشهري للعقد من إيجارات الوحدات المرتبطة به.
 *
 * Mirrors the database trigger that maintains `contracts.monthly_amount`;
 * the join table is the source of truth, this is the client-side view of it.
 */
```

Comments still explain *why*, never restate *what* the next line does.

## Guard skills — required on every feature

Project gates (`bun run lint`, `typecheck`, `test`, `test:sql`) prove the code
runs. They do not prove it is any good. On **every** feature implementation,
before presenting, committing or merging:

- run **`clean-code-guard`** after any production code is written, edited,
  refactored or fixed;
- run **`test-guard`** after any test is written or edited, and when reviewing
  test files;
- run **`docs-guard`** after any docstring, README, changelog or API-doc change.

This applies to work done by delegated agents too — treat their output as
untrusted until it has been through the matching guard. A green suite is silent
about a test that asserts nothing, a mocked internal helper, or a catch block
that swallows the error; the guards are what catch those.

## Deployment and migrations

**Any push or merge to `main` deploys to production automatically.** Dokploy
watches the branch and rebuilds the app container with no manual step. There is
no staging environment. Pushing a *feature branch* does not deploy, so branches
are safe to push freely.

**Dokploy deploys code, never schema.** Migrations in `db/migrations/` do not
auto-apply — run them yourself over the `ssh-danatfuture-mcp` MCP server against
the `danatfuture-supabase-ozoxsa-db-1` container. Apply them **before** the new
code goes live, or the new bundle runs against the old schema.

The files reach the server for free: Dokploy clones `main` into
`/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code` at the start of
every build, minutes before the container swaps, so concatenate the new
migrations from there instead of transferring anything. Checksum the result
against the local file before applying — that is what proves production ran the
same bytes the test suite validated — then
`notify pgrst, 'reload schema'`, or new RPCs will 404 from a stale cache.

`pg_dump` first. Schema changes are not reversible.

Full runbook, including the MCP call-timeout and command-size workarounds, is in
the "Migrations do not auto-apply" section of `CLAUDE.md`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
