-- 326_gateway_live_guard_provider.sql (security fix for T151)
--
-- يسدّ ثغرة في بوابة إطلاق الوضع الفعلي: الحارس في 324 كان يفحص الصف فقط
-- عند إدراجه أو عند تغيير `mode`، فكان يمكن لاتصال فعلي على مزوّد مسموح
-- (مثلاً tap) أن يُغيَّر مزوّده إلى مزوّد غير مسموح (upayments) وهو ما يزال
-- `live`، دون أن يُعاد الفحص.
--
-- `company_service` holds UPDATE on every column of `gateway_connections`
-- (migration 319), so the provider column is writable. The guard now re-checks
-- whenever the effective (provider, mode) pair changes. The owner's decision
-- stands: turning a provider's flag off leaves existing live connections
-- untouched, so updates that keep the same provider and mode still pass.
--
-- Rollback: re-run section 3 of migration 324.

create or replace function public.tg_gateway_connections_guard_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.mode = 'live'
     and (
       tg_op = 'INSERT'
       or new.mode is distinct from old.mode
       or new.provider is distinct from old.provider
     ) then
    if not exists (
      select 1
        from public.platform_gateway_launch p
       where p.provider = new.provider
         and p.live_allowed = true
    ) then
      raise exception 'GATEWAY_LIVE_NOT_ALLOWED';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists gateway_connections_guard_live on public.gateway_connections;
create trigger gateway_connections_guard_live
  before insert or update of mode, provider on public.gateway_connections
  for each row execute function public.tg_gateway_connections_guard_live();

-- A trigger function is never called directly: no API role may execute it.
revoke all on function public.tg_gateway_connections_guard_live() from public, anon, authenticated;
