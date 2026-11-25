# Production migration apply tooling

Scripts that turn “paste SQL into a runbook” into a **reviewable, repeatable**
pack → transfer → md5 → apply → verify loop. The orchestrator runs the remote
steps through the production MCP shell; these files never open a network path.

| File                    | Role                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `pack-migration.sh`     | gzip + base64 + chunk a migration for the 1000-char command channel |
| `verify-migrations.sql` | Read-only PASS/FAIL checks after apply                              |
| This README             | Operator contract                                                   |

## Hard limits and rules

### 1000-character command channel

Each remote shell command is capped at **1000 characters**. That is why
`pack-migration.sh` emits chunks of **≤900** characters: room for the wrapper
that writes each chunk to `/tmp/p_NN`.

### md5 before apply

1. Pack locally; note the printed **md5**.
2. Transfer every `chunk_NN` to the host as `/tmp/p_NN`.
3. Run the printed **reassemble** command on the host.
4. Confirm the remote `md5sum` matches the printed md5 **exactly**.
5. Only then pipe the reassembled file into `psql`.

Never apply a file whose remote md5 does not match.

### Enum migrations alone

**`alter type … add value` migrations MUST be applied alone, in their own
transaction, BEFORE any migration that uses the new value.**

Postgres rejects using a new enum value in the same transaction that added it
(`unsafe use of new value of enum type`) and rolls the whole file back.
Migrations **88**, **92** (and earlier **71**) exist for exactly that reason —
see their file headers and `db/migrations/71_new_workflow_notification_types.sql`
lines 1–15.

Apply order example:

```text
88_closeout_notification_types.sql     ← enum only, commit
89_closeout_workflows_and_templates.sql ← uses those values
…
92_invoice_event_notification_types.sql ← enum only, commit
93_invoice_event_workflows.sql          ← uses those values
```

Do **not** concatenate an enum migration with its consumer into one
`--single-transaction` run.

### Reload PostgREST after schema/signature changes

After any change to **tables** or **function signatures**:

```sql
notify pgrst, 'reload schema';
```

Body-only function replacements usually do not need this; new tables, columns,
or arity changes do.

## Apply recipe (one migration file)

Locally:

```bash
bash scripts/pack-migration.sh db/migrations/93_invoice_event_workflows.sql /tmp/packtest
```

Stdout shows `md5`, `bytes`, `chunks`, and a one-line **reassemble** command.

On the host (orchestrator), after writing each chunk to `/tmp/p_00`, `/tmp/p_01`, …:

```bash
# use the exact reassemble line printed by pack-migration.sh, then:
docker exec -i danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 --single-transaction \
  < /tmp/93.sql
```

## Verify after apply

Pack and transfer `scripts/verify-migrations.sql` the same way, or pipe it in
if the channel allows. Then:

```bash
docker exec -i danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 \
  < /tmp/verify-migrations.sql
```

Every check row must be `PASS`, including `*** OVERALL ***`. The script is
**read-only**: it never inserts, updates, deletes, or alters.

## Transfer note (no git on the host)

The host checkout’s GitHub App token is expired; **do not depend on
`git fetch` / `git pull`** for migration delivery. Always pack → chunk-transfer
→ reassemble → md5 → apply.

## What these scripts never contain

- Credentials, tokens, or private keys
- Hostnames beyond the documented container name used in run commands
- Production contract codes, tenant names, or other live data
