-- ============================================================================
-- 207 — write_audit يقرأ عنوان الزائر ومساره من ترويسات يضبطها التطبيق نفسه.
--
-- `write_audit` derives `ip` and `path` from PostgREST's `request.headers`,
-- reading `x-forwarded-for` / `cf-connecting-ip` and `x-forwarded-uri`. Those
-- are proxy headers, and this deployment has three proxies in front of
-- PostgREST: the app container resolves `supabase.danat-future.com` to
-- Cloudflare, which reaches Traefik, which reaches Kong. Each rewrites the
-- `x-forwarded-*` family, because that is what those headers are for.
--
-- Measured from inside the app container on 2026-09-14, sending
-- `x-forwarded-for: 203.0.113.55` and `x-forwarded-uri: /_probe/realpath`:
--
--   ip   -> 172.68.234.123   (a Cloudflare edge address, not the value sent)
--   path -> ''               (stripped entirely)
--
-- The same probe proved that headers *outside* that family survive the whole
-- chain untouched: `x-request-id: corr-abc-123` arrived intact as
-- `correlation_id`, as did `user-agent`. So the fix is a header name no proxy
-- claims ownership of.
--
-- Both new names are consulted *first* and fall back to the old ones, so every
-- existing caller keeps its current behaviour and a deployment whose app talks
-- to Kong directly is unaffected.
--
-- Trust note: these headers are only ever set by our own server code on a
-- service-role call. They are not forwarded from the browser, so a visitor
-- cannot spoof the address recorded against them — the value comes from
-- Cloudflare's own `cf-connecting-ip` on the inbound request, read server-side.
-- ============================================================================

create or replace function public.write_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_result text default 'success',
  p_error_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $fn$
declare
  v_claims jsonb := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_headers jsonb := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );
  v_actor_id uuid := auth.uid();
  v_actor_label text;
  v_role text;
  v_id uuid;
begin
  if v_actor_id is null
     and coalesce(v_claims ->> 'sub', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    v_actor_id := (v_claims ->> 'sub')::uuid;
  end if;

  if v_actor_id is not null then
    select coalesce(p.username::text, p.display_name, p.email::text)
      into v_actor_label
      from public.profiles p
     where p.id = v_actor_id;

    select string_agg(ur.role::text, ',' order by ur.role::text)
      into v_role
      from public.user_roles ur
     where ur.user_id = v_actor_id;
  end if;

  v_actor_label := coalesce(
    v_actor_label,
    v_claims -> 'user_metadata' ->> 'username',
    v_claims ->> 'email',
    case when v_actor_id is null then 'system' end
  );
  v_role := coalesce(v_role, v_claims ->> 'role', case when v_actor_id is null then 'system' end);

  insert into public.audit_logs (
    actor_id,
    actor_label,
    role,
    action,
    entity_type,
    entity_id,
    method,
    path,
    ip,
    user_agent,
    correlation_id,
    before,
    after,
    result,
    error_code
  ) values (
    v_actor_id,
    v_actor_label,
    v_role,
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(v_headers ->> 'x-http-method', v_headers ->> 'x-forwarded-method'),
    -- App-set name first; the x-forwarded-* fallbacks are what a direct-to-Kong
    -- deployment still uses.
    coalesce(
      nullif(trim(v_headers ->> 'x-danat-request-path'), ''),
      v_headers ->> 'x-forwarded-uri',
      v_headers ->> 'x-original-url'
    ),
    coalesce(
      nullif(trim(v_headers ->> 'x-danat-client-ip'), ''),
      nullif(trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', v_headers ->> 'cf-connecting-ip', ''), ',', 1)), '')
    ),
    v_headers ->> 'user-agent',
    coalesce(v_headers ->> 'x-request-id', v_headers ->> 'x-correlation-id'),
    p_before,
    p_after,
    p_result,
    p_error_code
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

-- Re-issued explicitly rather than relying on CREATE OR REPLACE preserving the
-- ACL. Migration 142 re-issued three RLS helpers and silently dropped a grant
-- they depended on; the cost of repeating two statements is nothing next to
-- that. `anon` is deliberately absent — migration 96 revoked it, and every
-- caller here is `authenticated` or `service_role`.
revoke all on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text)
  from public, anon;
grant execute on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text)
  to authenticated, service_role;
