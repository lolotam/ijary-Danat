-- ---------------------------------------------------------------------------
-- 335 - WhatsApp session health and outage episodes read `whatsapp_connections`
-- ---------------------------------------------------------------------------
--
-- Migration 333 moved the QR session into `whatsapp_connections` (one row per
-- company and method), and the app now pairs, sends and records connection
-- updates there. Two database pieces still pointed at the legacy
-- `evolution_connections` singleton, so the admin banner read a row no company
-- writes any more and a heal outside the webhook never re-armed the alert:
--
--   1. `tg_whatsapp_connection_episode()` BEFORE UPDATE trigger on
--      `whatsapp_connections`: entering `connected` arms a new outage episode
--      and clears `disconnected_at`; leaving `connected` stamps
--      `disconnected_at` once without re-arming. Same rule as migration 253,
--      enforced in SQL so every writer (webhook, live-probe heal, disconnect)
--      follows it, not only the webhook.
--   2. `whatsapp_session_health()` reads the caller company's ACTIVE
--      `evolution_qr` connection. The JSON contract is unchanged: `state` keeps
--      Evolution's vocabulary (`open` / `connecting` / `close` / `error`) so
--      the banner state machine in `src/lib/whatsappSessionBanner.ts` needs no
--      change.
--
-- The legacy table and its trigger from 253 are left in place: nothing writes
-- them now, and dropping them is a separate clean-up.
--
-- Rollback (manual if ever needed):
--   drop trigger if exists whatsapp_connections_session_episode on public.whatsapp_connections;
--   drop function if exists public.tg_whatsapp_connection_episode();
--   re-run the `whatsapp_session_health()` definition from migration 298.

-- 1. Outage episode trigger (NOT security definer: runs with the writer's rights).
create or replace function public.tg_whatsapp_connection_episode()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'connected' and old.status is distinct from 'connected' then
    new.disconnect_alert_armed := true;
    new.disconnected_at := null;
  elsif old.status = 'connected' and new.status is distinct from 'connected' then
    new.disconnected_at := coalesce(new.disconnected_at, now());
  end if;
  return new;
end;
$$;

revoke all on function public.tg_whatsapp_connection_episode() from public, anon, authenticated;

drop trigger if exists whatsapp_connections_session_episode on public.whatsapp_connections;
create trigger whatsapp_connections_session_episode
  before update of status on public.whatsapp_connections
  for each row execute function public.tg_whatsapp_connection_episode();

-- 2. Staff-wide session health RPC, scoped to the caller's company.
create or replace function public.whatsapp_session_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_connection record;
begin
  if v_company_id is null then
    return null;
  end if;
  if auth.role() not in ('company_service', 'service_role')
     and not (select public.is_staff((select auth.uid()))) then
    return null;
  end if;

  select wc.status, wc.connected_number, wc.connected_at, wc.disconnected_at
    into v_connection
    from public.whatsapp_connections wc
   where wc.company_id = v_company_id
     and wc.method = 'evolution_qr'
     and wc.is_active;

  return jsonb_build_object(
    'enabled', coalesce(
      (select pc.is_enabled from public.provider_configs pc
        where pc.company_id = v_company_id and pc.provider = 'evolution_api' limit 1), false),
    'paired', coalesce(
      v_connection.connected_number is not null or v_connection.connected_at is not null, false),
    'state', case v_connection.status
               when 'connected' then 'open'
               when 'pairing' then 'connecting'
               when 'disconnected' then 'close'
               when 'error' then 'error'
             end,
    'settling', coalesce(
      v_connection.status = 'pairing'
        and v_connection.disconnected_at > now() - interval '60 seconds', false),
    'disconnected_at', v_connection.disconnected_at,
    'parked_count', (select count(*)::int from public.notifications n
                      where n.company_id = v_company_id
                        and n.error_code in ('session_disconnected', 'instance_missing')
                        and n.state in ('failed', 'needs_review'))
  );
end;
$$;

revoke all on function public.whatsapp_session_health() from public, anon;
grant execute on function public.whatsapp_session_health() to authenticated, company_service, service_role;
