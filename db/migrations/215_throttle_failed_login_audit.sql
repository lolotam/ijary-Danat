-- 215_throttle_failed_login_audit.sql
--
-- يُخفّض ضجيج سجل التدقيق عن محاولات الدخول الفاشلة: العدّاد هنا، والسجل للشواهد فقط.
--
-- Codex P2 on PR #206. `signInWithIdentifier` is a public, unauthenticated
-- server function, and every failed login calls `recordLoginAttempt`, which
-- performs a service_role `write_audit` INSERT into `audit_logs`. No per-IP or
-- per-account limit exists, and even a GoTrue rate-limit response still enters
-- the failure branch. `audit_logs` is append-only and deliberately preserved by
-- the reset and backup paths, so an attacker submitting bad credentials in a
-- loop grows the table without bound and buries the forensic events it exists
-- to hold.
--
-- The limit lives here, not in TypeScript: that process is stateless, restarts
-- reset it, and concurrent requests race past it.
--
-- `failed_login_attempts` is a counter, not an audit record — it may be
-- updated and deleted, which is exactly why the counting must not happen
-- inside `audit_logs`.
--
-- TWO budgets, not one. Review round 1 on PR #211: keying only on
-- (identifier, IP) is defeated by the normal shape of password spraying — a
-- campaign that varies the submitted username gets `attempts = 1` every time
-- and writes a row every time, which is the unbounded growth this migration
-- exists to stop. So the same table also holds a per-IP aggregate under its own
-- `scope`, counted first, and once an IP passes its budget the identifier is
-- not counted at all — not merely un-audited, since a row per username would
-- recreate the same growth in the counter table.
--
-- The ladder is 1, 5, then 25 and five-fold from there: 125, 625, 3125, …
-- Attempts past 25 used to write nothing at all, which made the trail read the
-- same whether an attack stopped at 26 or reached a million while the only
-- accurate count was pruned at 24 hours. Escalating by a factor of five keeps
-- the magnitude in the durable log and still bounds a billion attempts to
-- roughly a dozen rows.

begin;

create table public.failed_login_attempts (
  -- Two kinds of row live here and must never share a key. Review round 2 on
  -- PR #211: a sentinel identifier (`*`) is submittable — the validator accepts
  -- it and the legacy mapping tries `*@users.local` — so a caller sending it
  -- would have had its identifier row and the IP aggregate collide, double
  -- incrementing one row, keeping the count permanently even, and therefore
  -- never reaching the odd ladder milestones 25, 125, 625. The continuation
  -- summaries would have silently disappeared for exactly the caller who chose
  -- that username.
  scope text not null check (scope in ('identifier', 'client_ip')),
  -- Empty string on a `client_ip` row: it is in the primary key and cannot be
  -- null, and the scope column is what distinguishes the two.
  identifier_key text not null,
  client_ip text not null,
  window_start timestamptz not null,
  attempts integer not null default 0,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (scope, identifier_key, client_ip, window_start)
);

-- The retention delete below runs on every call and filters on window_start
-- alone, which the primary key (identifier_key, client_ip, …) cannot serve. A
-- spray that varies the identifier grows this table fast, and without this
-- index each request would scan more of it than the last — turning the
-- unauthenticated login path into increasingly expensive database work.
create index if not exists failed_login_attempts_window_start_idx
  on public.failed_login_attempts (window_start);

comment on table public.failed_login_attempts is
  'يُحصي محاولات الدخول الفاشلة لكل معرّف وعنوان ونافذة زمنية، ليُخفّض ما يُكتب في سجل التدقيق. A counter, not an audit record: rows are updated in place and pruned after 24 hours, which is exactly what audit_logs must never do.';

alter table public.failed_login_attempts enable row level security;

-- No policies for `anon` or `authenticated`: only the definer function below
-- touches this table, and it runs as its owner.
revoke all on public.failed_login_attempts from public, anon, authenticated;
grant all on public.failed_login_attempts to service_role;

-- هل هذا العدد موضعُ تسجيل على السلّم: 1 ثم 5 ثم 25 وما يليه بخمسة أضعاف؟
--
-- A plain `in (1, 5, 25)` cannot express "and every fifth multiple after that",
-- and a log-based test invites float rounding to decide whether an audit row is
-- written. Counting up is exact. `v_step` is bigint because the next ×5 step
-- after 1_220_703_125 does not fit in integer: that product is not a legal
-- `integer` argument, but any legal input above 1_220_703_125 still takes
-- that multiply while walking toward the count.
create or replace function public.failed_login_is_milestone(p_count integer)
returns boolean
language plpgsql
immutable
parallel safe
as $ladder$
declare
  v_step bigint := 25;
begin
  if p_count = 1 or p_count = 5 then
    return true;
  end if;
  if p_count < 25 then
    return false;
  end if;
  while v_step < p_count loop
    v_step := v_step * 5;
  end loop;
  return v_step = p_count;
end;
$ladder$;

comment on function public.failed_login_is_milestone(integer) is
  'يُحدّد ما إذا كان عدد المحاولات الفاشلة موضعَ تسجيل: 1 ثم 5 ثم 25 وما بعده بخمسة أضعاف. True at 1, 5, 25, 125, 625 and so on, so a sustained attack keeps its magnitude in audit_logs while the row count stays logarithmic.';

revoke all on function public.failed_login_is_milestone(integer) from public, anon, authenticated;

-- يُسجّل محاولة دخول فاشلة ويُقرّر وحده ما يستحق الكتابة في سجل التدقيق.
--
-- Counts the IP aggregate first, then the identifier only while that IP is
-- still at or below 25. Identifier-scoped writes are therefore 1, 5 and 25
-- only — 125 and beyond are unreachable per identifier because the IP budget
-- has already taken over. Past 25 the IP-scoped ×5 ladder carries the
-- magnitude, because a spray that varies the username is otherwise a fresh
-- `attempts = 1` and a fresh audit row every single request. Prunes counter
-- rows older than 24 hours on every call, or this table becomes the unbounded
-- table it was added to prevent.
create function public.record_failed_login(
  p_identifier text,
  p_account_id uuid,
  p_error_code text
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- Same header `write_audit` reads (migration 209): the app sets
  -- `x-danat-client-ip` on its own service_role call, so the value comes from
  -- Cloudflare server-side, not from the visitor. Empty when unknown — never
  -- null, it is part of the primary key.
  v_client_ip text := coalesce(current_setting('request.headers', true)::jsonb ->> 'x-danat-client-ip', '');
  -- Clock-aligned quarter hours (:00/:15/:30/:45), not a sliding 15 minutes
  -- from the first attempt. 10:14 truncates to 10:00 and 10:16 to 10:15, so
  -- those bursts have separate windows and each gets its own budget.
  v_window timestamptz := date_trunc('hour', now()) + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_identifier_key text := lower(trim(p_identifier));
  v_count integer;
  v_ip_count integer;
begin
  -- The IP aggregate is counted FIRST and the identifier row is skipped once its
  -- budget is spent. Review round 2 on PR #211: incrementing the identifier
  -- counter before reading the IP count meant a million-username spray still
  -- inserted a million counter rows and held them for 24 hours — the same
  -- unbounded growth this migration exists to stop, moved one table across.
  --
  -- The cost is that a legitimate user sharing a flooding IP loses their own
  -- per-identifier rows for the rest of the window. The IP ladder still records
  -- that the address is flooding, which is the fact worth keeping, and the
  -- alternative is a table anyone can grow at will from an unauthenticated
  -- endpoint.
  insert into public.failed_login_attempts (scope, identifier_key, client_ip, window_start, attempts, first_at, last_at)
  values ('client_ip', '', v_client_ip, v_window, 1, now(), now())
  on conflict (scope, identifier_key, client_ip, window_start)
  do update set attempts = failed_login_attempts.attempts + 1, last_at = now()
  returning attempts into v_ip_count;

  if v_ip_count > 25 then
    -- Past the budget the identifier is not counted at all, and the IP's own
    -- ladder carries the magnitude. It names no identifier because by this
    -- point there is no single one to name.
    if public.failed_login_is_milestone(v_ip_count) then
      perform public.write_audit(
        p_action := 'auth.login.throttled',
        p_entity_type := 'user',
        p_entity_id := null,
        p_before := null,
        p_after := jsonb_build_object(
          'scope', 'client_ip',
          'attempts', v_ip_count,
          'window_start', v_window
        ),
        p_result := 'failure',
        p_error_code := p_error_code
      );
    end if;
  else
    insert into public.failed_login_attempts (scope, identifier_key, client_ip, window_start, attempts, first_at, last_at)
    values ('identifier', v_identifier_key, v_client_ip, v_window, 1, now(), now())
    on conflict (scope, identifier_key, client_ip, window_start)
    do update set attempts = failed_login_attempts.attempts + 1, last_at = now()
    returning attempts into v_count;

    if v_count = 1 or v_count = 5 then
      perform public.write_audit(
        p_action := 'auth.login',
        p_entity_type := 'user',
        p_entity_id := p_account_id,
        p_before := null,
        p_after := jsonb_build_object('identifier', p_identifier),
        p_result := 'failure',
        p_error_code := p_error_code
      );
    elsif public.failed_login_is_milestone(v_count) then
      perform public.write_audit(
        p_action := 'auth.login.throttled',
        p_entity_type := 'user',
        p_entity_id := p_account_id,
        p_before := null,
        p_after := jsonb_build_object(
          'scope', 'identifier',
          'identifier', p_identifier,
          'attempts', v_count,
          'window_start', v_window
        ),
        p_result := 'failure',
        p_error_code := p_error_code
      );
    end if;
  end if;

  -- Retention rides along on every call rather than on a schedule: there is no
  -- cron aimed at this table, and a counter nobody prunes re-creates the
  -- unbounded growth this migration exists to stop.
  delete from public.failed_login_attempts where window_start < now() - interval '24 hours';

  -- The count that governed the decision: identifier-scoped normally, and
  -- IP-scoped once the IP budget has taken over the counting.
  return coalesce(v_count, v_ip_count);
end;
$fn$;

comment on function public.record_failed_login(text, uuid, text) is
  'يُسجّل محاولة دخول فاشلة ويُقرّر وحده ما يستحق الكتابة في سجل التدقيق. Counts the IP aggregate first and the identifier only while that IP is at or below 25, so identifier-scoped writes are 1, 5 and 25 only; past the budget the IP-scoped 125, 625, ... ladder continues - varying the submitted username no longer buys an audit row per request.';

revoke all on function public.record_failed_login(text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_failed_login(text, uuid, text) to service_role;

notify pgrst, 'reload schema';

commit;
