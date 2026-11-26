-- 305: drop legacy single-column foreign keys that a composite company FK duplicates.
--
-- Migrations 263-273 added `(company_id, <col>) → parent(company_id, id)` keys but,
-- unlike 255-261, kept the old `<col> → parent(id)` key beside them. Two
-- relationships between the same pair of tables make PostgREST refuse every embed
-- between them with PGRST201 (HTTP 300); the renter dashboard's
-- `invoices → contracts!inner` was the first page seen failing (2026-11-26).
--
-- The composite key enforces strictly more than the legacy one: `company_id` is
-- NOT NULL on every affected table, so MATCH SIMPLE never skips the check when
-- `<col>` is set. A legacy key is dropped only when its twin is validated and
-- has the same ON DELETE and ON UPDATE actions, so no cascade behaviour changes.
--
-- Guarded by src/db/isolation/duplicateForeignKeys.sqltest.ts.

do $$
declare
  legacy record;
  remaining integer;
begin
  for legacy in
    select o.conrelid::regclass as tbl, o.conname
      from pg_constraint o
      join pg_namespace s on s.oid = o.connamespace
      join pg_constraint n
        on n.conrelid = o.conrelid
       and n.confrelid = o.confrelid
       and n.contype = 'f'
       and array_length(n.conkey, 1) = 2
       and o.conkey[1] = any (n.conkey)
       and o.confkey[1] = any (n.confkey)
       and n.convalidated
       and n.confdeltype = o.confdeltype
       and n.confupdtype = o.confupdtype
      join pg_attribute a
        on a.attrelid = o.conrelid and a.attname = 'company_id' and a.attnotnull
     where o.contype = 'f'
       and s.nspname = 'public'
       and array_length(o.conkey, 1) = 1
  loop
    execute format('alter table %s drop constraint %I', legacy.tbl, legacy.conname);
  end loop;

  -- Any pair left over differs in actions or validity and needs a hand-written fix.
  select count(*) into remaining
    from pg_constraint o
    join pg_namespace s on s.oid = o.connamespace
    join pg_constraint n
      on n.conrelid = o.conrelid
     and n.confrelid = o.confrelid
     and n.contype = 'f'
     and array_length(n.conkey, 1) = 2
     and o.conkey[1] = any (n.conkey)
     and o.confkey[1] = any (n.confkey)
   where o.contype = 'f'
     and s.nspname = 'public'
     and array_length(o.conkey, 1) = 1;
  if remaining > 0 then
    raise exception 'DUPLICATE_FK_REMAINS: % legacy foreign key(s) still duplicate a composite key', remaining;
  end if;
end;
$$;

notify pgrst, 'reload schema';
