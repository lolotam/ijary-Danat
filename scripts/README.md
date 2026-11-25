# Scripts

## `gen-types.sh` — regenerate Supabase types

Regenerates `src/integrations/supabase/database.types.ts` from the SQL
migrations in `db/migrations/` (the source of truth), NOT from the deployed
self-hosted Supabase — so the output is deterministic and reproducible.

### Prerequisites

- Docker (running daemon)
- Node.js (`npx` fetches the `supabase` CLI on demand)

### Run

```bash
bun run gen:types
```

The script:

1. Spins up an ephemeral `supabase/postgres:15` container on a random host port.
2. Waits for `pg_isready`.
3. Applies every `db/migrations/*.sql` in numeric order by leading migration number (`sort -V`; lex order breaks at 100 vs 50) with `psql -v ON_ERROR_STOP=1`.
4. Runs `supabase gen types typescript --schema public` against that DB.
5. Writes the result to `src/integrations/supabase/database.types.ts`.
6. Tears the container down (trap EXIT).

### When to re-run

After adding or editing any file under `db/migrations/`. Commit the regenerated
`database.types.ts` alongside the migration change so the client and DB stay
in sync.
