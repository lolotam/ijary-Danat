# RLS policy conventions

All app tables live in the `public` schema and follow this structure.

## Order of statements per table

```sql
create table if not exists public.<name>(...);

-- Explicit privilege grants (PostgREST does NOT default-grant on public).
grant select, insert, update, delete on public.<name> to authenticated;
grant all on public.<name> to service_role;
-- add: grant select on public.<name> to anon;  -- ONLY when a policy allows anon reads

alter table public.<name> enable row level security;

drop policy if exists <name>_select_... on public.<name>;
create policy <name>_select_... on public.<name>
  for select to authenticated using (...);
-- ... one policy per (verb, audience)
```

## Role checks

- Never check `auth.jwt()` role claims or a `role` column on profiles.
- Always call `public.has_role(auth.uid(), 'admin')` (etc.) or
  `public.is_staff(auth.uid())`.
- These functions are SECURITY DEFINER with `set search_path = public` to
  avoid recursion against `user_roles` policies.

## Audience matrix used across the app

| Audience   | Applies to                                | Typical check                                    |
| ---------- | ----------------------------------------- | ------------------------------------------------ |
| Admin      | Settings, roles, financial reversal       | `public.has_role(auth.uid(), 'admin')`           |
| Accountant | Payments, deposits, receipts, expenses    | `public.has_role(auth.uid(), 'accountant')`      |
| Collector  | Overdue follow-up                         | `public.has_role(auth.uid(), 'collector')`       |
| Read-only  | Reports viewer                            | `public.has_role(auth.uid(), 'readonly')`        |
| Staff      | Any of the above                          | `public.is_staff(auth.uid())`                    |
| Tenant     | Only own lease/invoices/payments/receipts | `exists (... where tenant_id = <row.tenant_id>)` |

## Tenant-scoped tables (added in Phase 2+)

For every tenant-facing table, the SELECT policy must join back to the
profile's `tenant_id`:

```sql
create policy invoices_select_own_tenant on public.invoices
  for select to authenticated
  using (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.tenant_id = invoices.tenant_id
    )
  );
```

Never rely on a client-provided tenant id — RLS is the source of truth.
