-- ---------------------------------------------------------------------------
-- 336 - platform email owner lookup requires an explicit platform claim
-- ---------------------------------------------------------------------------
--
-- T201 F4. Migration 332's `platform_email_notification_owner(text)` crossed
-- companies whenever `current_company_id()` was null. That helper returns
-- null for *any* context it refuses: a missing claim, a suspended company, an
-- expired one. So a `company_service` token for a suspended company — or any
-- future caller whose context failed closed — read every company's
-- notification by message id. Failing closed turned into failing open.
--
-- The cross-company branch now needs the caller to say so: `service_role`, or
-- `company_service` whose `company_id` claim is the all-zero UUID that
-- `findPlatformMessageOwner` in `src/fns/resendWebhook.ts` signs for exactly
-- this lookup (no company row ever has that id). Every other caller is held
-- to its own company; a null context now finds nothing.
--
-- Rollback (manual if ever needed): re-run the definition from migration 332.

create or replace function public.platform_email_notification_owner(p_message_id text)
returns table (
  company_id uuid,
  notification_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with ctx as (
    select coalesce(
             nullif(current_setting('request.jwt.claims', true), '')::jsonb,
             '{}'::jsonb
           ) as claims
  ),
  caller as (
    -- Same role resolution order as current_company_id() (migration 254):
    -- the `role` GUC PostgREST sets, then the JWT claim.
    select
      coalesce(
        r.role = 'service_role'
        or (
          r.role = 'company_service'
          and x.claims ->> 'company_id' = '00000000-0000-0000-0000-000000000000'
        ),
        false
      ) as is_platform,
      (select public.current_company_id()) as company_id
      from ctx x
     cross join lateral (
       select coalesce(
                nullif(nullif(current_setting('role', true), 'none'), ''),
                nullif(x.claims ->> 'role', '')
              ) as role
     ) r
  )
  select n.company_id, n.id
    from public.notifications n, caller c
   where n.provider_message_id = p_message_id
     and (c.is_platform or n.company_id = c.company_id)
  union all
  select n.company_id, n.id
    from public.notifications n, caller c
   where n.provider_message_id like '%' || p_message_id || '%'
     and n.provider_message_id <> p_message_id
     and exists (
       select 1
         from unnest(string_to_array(n.provider_message_id, ',')) as part(part)
        where btrim(part.part) = p_message_id
     )
     and (c.is_platform or n.company_id = c.company_id)
   limit 1;
$$;

revoke all on function public.platform_email_notification_owner(text)
  from public, anon, authenticated, company_service, service_role;
grant execute on function public.platform_email_notification_owner(text)
  to company_service, service_role;
