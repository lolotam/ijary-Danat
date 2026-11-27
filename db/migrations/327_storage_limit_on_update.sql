-- 327_storage_limit_on_update.sql (security fix for T126)
--
-- يفرض حدّ التخزين عند تعديل كائن موجود أيضاً، لا عند إدراجه فقط.
--
-- Migration 323 checked `max_storage_bytes` only `BEFORE INSERT` on
-- `storage.objects`. Storage's upsert path (`x-upsert: true`) rewrites an
-- existing row, so a small file could be replaced by a large one, or moved
-- into another company prefix, without any limit check while the usage
-- counter still grew. The guard now runs on `UPDATE OF name, metadata` too
-- and checks only the bytes the change adds to the target company:
--   - same company: new size minus old size (a shrink always passes);
--   - different company (or none before): the whole new size.
-- Path ownership (`companies/<current_company_id()>/...`) stays enforced by
-- the storage policies of migration 304.
--
-- Rollback: re-run section 5 of migration 323 (function and insert trigger),
-- then `drop trigger if exists company_storage_limit_update on storage.objects;`.

/**
 * يمنع إدراج أو تعديل كائن تخزين إذا تجاوز ما يضيفه مع الاستخدام الحالي حد التخزين للشركة.
 */
create or replace function public.tg_enforce_storage_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id    uuid := public.storage_company_id(new.name);
  v_max_bytes     bigint;
  v_current_bytes bigint := 0;
  v_added_bytes   bigint := public.storage_object_bytes(new.metadata);
begin
  -- Objects outside `companies/<uuid>/` belong to no company and are not counted.
  if v_company_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and public.storage_company_id(old.name) is not distinct from v_company_id then
    v_added_bytes := v_added_bytes - public.storage_object_bytes(old.metadata);
  end if;

  if v_added_bytes <= 0 then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('company_limits_storage:' || v_company_id::text));

  select cl.max_storage_bytes
    into v_max_bytes
    from public.company_limits cl
   where cl.company_id = v_company_id;

  if v_max_bytes is not null then
    select coalesce(su.bytes, 0)
      into v_current_bytes
      from public.company_storage_usage su
     where su.company_id = v_company_id;

    if (coalesce(v_current_bytes, 0) + v_added_bytes) > v_max_bytes then
      raise exception 'LIMIT_STORAGE' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

-- A trigger function is never called directly: no API role may execute it.
revoke all on function public.tg_enforce_storage_limit() from public, anon, authenticated;

drop trigger if exists company_storage_limit_update on storage.objects;
create trigger company_storage_limit_update
  before update of name, metadata on storage.objects
  for each row execute function public.tg_enforce_storage_limit();
