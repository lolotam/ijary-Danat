-- ---------------------------------------------------------------------------
-- 253 - WhatsApp QR session episode tracking, health RPC, and disconnect alert
-- ---------------------------------------------------------------------------
--
-- Depends on migration 252 having COMMITTED: seeds notification_templates with
-- type = 'whatsapp_session_alert'.
--
-- Adds:
--   1. `disconnect_alert_armed` and `disconnected_at` on `evolution_connections`
--      (kept outside the `authenticated` column grant intentionally).
--   2. `tg_evolution_session_episode()` BEFORE UPDATE trigger so every transition
--      into `open` arms a new outage episode and clears `disconnected_at`, and
--      every exit from `open` stamps `disconnected_at` once without re-arming.
--   3. `whatsapp_session_health()` SECURITY DEFINER RPC returning non-sensitive
--      session health + parked notification count for all active staff.
--   4. `whatsapp-session-disconnected` event workflow in `cron_jobs` and its
--      email-only template row in `notification_templates`.
--
-- Rollback (manual if ever needed; enum value in 252 remains harmless):
--   drop trigger if exists evolution_connections_session_episode on public.evolution_connections;
--   drop function if exists public.tg_evolution_session_episode();
--   drop function if exists public.whatsapp_session_health();
--   delete from public.cron_jobs where key = 'whatsapp-session-disconnected';
--   delete from public.notification_templates where code = 'whatsapp-session-disconnected';
--   alter table public.evolution_connections
--     drop column if exists disconnect_alert_armed,
--     drop column if exists disconnected_at;

-- 1. Episode state columns + one-time seed (idempotent: never re-arms on replay).
do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'evolution_connections'
       and column_name = 'disconnect_alert_armed'
  ) then
    alter table public.evolution_connections
      add column disconnect_alert_armed boolean not null default false,
      add column disconnected_at timestamptz;

    update public.evolution_connections
       set disconnect_alert_armed = coalesce(last_connection_state = 'open', false);
  end if;
end $$;

comment on column public.evolution_connections.disconnect_alert_armed is
  'True once the QR session reaches open, cleared atomically by the disconnect alert claim or admin logout.';
comment on column public.evolution_connections.disconnected_at is
  'Server timestamp when last_connection_state last left open; null while open or never opened.';

-- 2. Episode transition trigger (NOT security definer).
create or replace function public.tg_evolution_session_episode()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.last_connection_state = 'open' and old.last_connection_state is distinct from 'open' then
    new.disconnect_alert_armed := true;
    new.disconnected_at := null;
  elsif old.last_connection_state = 'open' and new.last_connection_state is distinct from 'open' then
    new.disconnected_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists evolution_connections_session_episode on public.evolution_connections;
create trigger evolution_connections_session_episode
  before update on public.evolution_connections
  for each row execute function public.tg_evolution_session_episode();

-- 3. Staff-wide session health RPC (returns null for non-staff).
-- Allows accountants/collectors/readonly staff to see the disconnect banner
-- without broadening the `settings.integrations` RLS or column grants.
create or replace function public.whatsapp_session_health()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when (select public.is_staff((select auth.uid()))) then
      jsonb_build_object(
        'enabled', coalesce(
          (
            select pc.is_enabled
              from public.provider_configs pc
             where pc.provider = 'evolution_api'
             limit 1
          ),
          false
        ),
        'paired', coalesce(
          (
            select ec.connected_number is not null or ec.connected_at is not null
              from public.evolution_connections ec
             where ec.id = 1
          ),
          false
        ),
        'state', (
          select ec.last_connection_state
            from public.evolution_connections ec
           where ec.id = 1
        ),
        'settling', coalesce(
          (
            select ec.last_connection_state = 'connecting'
               and ec.disconnected_at > now() - interval '60 seconds'
              from public.evolution_connections ec
             where ec.id = 1
          ),
          false
        ),
        'disconnected_at', (
          select ec.disconnected_at
            from public.evolution_connections ec
           where ec.id = 1
        ),
        'parked_count', (
          select count(*)::int
            from public.notifications n
           where n.error_code in ('session_disconnected', 'instance_missing')
             and n.state in ('failed', 'needs_review')
        )
      )
    else null
  end;
$$;

revoke all on function public.whatsapp_session_health() from public, anon;
grant execute on function public.whatsapp_session_health() to authenticated, service_role;

-- 4. Event workflow registry entry (never resets `is_active` on replay).
insert into public.cron_jobs (
  key, kind, name_ar, name_en, description_ar, description_en, recipient_targets
) values (
  'whatsapp-session-disconnected',
  'event',
  'انقطاع جلسة واتساب',
  'WhatsApp session disconnected',
  'يرسل بريداً فورياً إلى مستلمي الإدارة عند انقطاع جلسة واتساب QR لإعادة مسح الرمز.',
  'Emails admin recipients immediately when the WhatsApp QR session disconnects.',
  array['admin', 'company']::text[]
)
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en,
      recipient_targets = excluded.recipient_targets;

-- 5. Email-only template seed (preserves admin edits on replay).
insert into public.notification_templates (
  code, type, channel, is_active,
  subject_ar, subject_en, body_ar, body_en
) values (
  'whatsapp-session-disconnected',
  'whatsapp_session_alert',
  'email',
  true,
  'تنبيه: انقطعت جلسة واتساب ({{instance_name}})',
  'Alert: WhatsApp session disconnected ({{instance_name}})',
  $ar$<p>انقطعت جلسة واتساب QR وتوقّف إرسال رسائل واتساب مؤقتاً حتى يُعاد مسح رمز QR.</p>
<ul style="padding-inline-start:20px;line-height:1.9;">
  <li><strong>النسخة:</strong> {{instance_name}}</li>
  <li><strong>الرقم المربوط:</strong> {{connected_number}}</li>
  <li><strong>الحالة المرصودة:</strong> {{state}}</li>
  <li><strong>وقت الانقطاع:</strong> {{disconnected_at}}</li>
  <li><strong>الرسائل المعلّقة:</strong> {{parked_count}}</li>
</ul>
<p><a href="{{settings_url}}">فتح إعدادات التكامل لإعادة الربط</a></p>$ar$,
  $en$<p>The WhatsApp QR session has disconnected and WhatsApp messages will remain held until the QR code is rescanned.</p>
<ul style="padding-inline-start:20px;line-height:1.9;">
  <li><strong>Instance:</strong> {{instance_name}}</li>
  <li><strong>Linked number:</strong> {{connected_number}}</li>
  <li><strong>Observed state:</strong> {{state}}</li>
  <li><strong>Disconnected at:</strong> {{disconnected_at}}</li>
  <li><strong>Held messages:</strong> {{parked_count}}</li>
</ul>
<p><a href="{{settings_url}}">Open integrations settings to reconnect</a></p>$en$
)
on conflict (code) do nothing;
