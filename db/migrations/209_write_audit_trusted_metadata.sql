-- ============================================================================
-- 209 — write_audit لا يثق بترويسات التطبيق إلا من service_role، ويقبل الفاعل
-- كوسيط صريح بدل استنتاجه من الرمز.
--
-- Migration 207 taught `write_audit` to prefer `x-danat-client-ip` and
-- `x-danat-request-path`, because the three proxies in front of PostgREST
-- rewrite the `x-forwarded-*` family. Review finding on PR #206: that was a
-- spoofing surface. `write_audit` is granted to `authenticated`, PostgREST
-- exposes it at /rpc/write_audit, and those header names survive the proxy
-- chain intact by design — so any signed-in user could attach a false address
-- and path to an audit row. 207's own comment claimed a visitor could not do
-- that. It was wrong.
--
-- The headers are now honoured only when the caller is `service_role`, which
-- no browser holds.
--
-- That gate would otherwise cost the login audit its actor: a successful login
-- was attributed by sending the visitor's own JWT, which makes the caller
-- `authenticated`. So `p_actor_id` is added, honoured on the same service_role
-- condition. The login path can now write as service_role — trusted metadata —
-- and still name the person who signed in. It is also strictly safer: no
-- server-side client has to hold a user's session at all, which is the shape
-- that once got browser session families revoked as refresh-token reuse.
--
-- `p_actor_id` is ignored for any other caller, so an `authenticated` client
-- cannot use it to attribute an action to someone else.
--
-- The parameter list changes, so the old function is dropped rather than
-- replaced: two overloads would leave PostgREST unable to choose between them.
-- The default means every existing seven-argument caller — write_off_invoice,
-- close_out_contract, void_refund, reverse_refund, set_invoice_dispute,
-- restore_contract, cancel_contract_closeout, and the client `logAudit` path —
-- resolves to this one unchanged. Wrapped in a transaction so no window exists
-- in which the function is absent.
-- ============================================================================

begin;

drop function if exists public.write_audit(text, text, uuid, jsonb, jsonb, text, text);

create function public.write_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_result text default 'success',
  p_error_code text default null,
  p_actor_id uuid default null
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
  -- Only service_role may state the request metadata or the actor. A browser
  -- never holds that key, so neither is forgeable from the client.
  v_trusted boolean := coalesce(v_claims ->> 'role', '') = 'service_role';
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

  if v_trusted and p_actor_id is not null then
    v_actor_id := p_actor_id;
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
  -- An explicit actor names a person, so the caller's own service_role is not
  -- what the row should record as their role.
  v_role := coalesce(
    v_role,
    case when v_trusted and p_actor_id is not null then null else v_claims ->> 'role' end,
    case when v_actor_id is null then 'system' end
  );

  insert into public.audit_logs (
    actor_id, actor_label, role, action, entity_type, entity_id,
    method, path, ip, user_agent, correlation_id,
    before, after, result, error_code
  ) values (
    v_actor_id,
    v_actor_label,
    v_role,
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(v_headers ->> 'x-http-method', v_headers ->> 'x-forwarded-method'),
    coalesce(
      case when v_trusted then nullif(trim(v_headers ->> 'x-danat-request-path'), '') end,
      v_headers ->> 'x-forwarded-uri',
      v_headers ->> 'x-original-url'
    ),
    coalesce(
      case when v_trusted then nullif(trim(v_headers ->> 'x-danat-client-ip'), '') end,
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

-- Re-issued explicitly: a dropped function takes its grants with it, and
-- migration 142 is the precedent for what a silently missing grant costs.
-- `anon` stays absent — migration 96 revoked it.
revoke all on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text, uuid)
  from public, anon;
grant execute on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text, uuid)
  to authenticated, service_role;

commit;
