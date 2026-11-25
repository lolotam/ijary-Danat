-- 189: switch generated property codes to the three-digit form.
--
-- The ten Jahra properties were renumbered by hand to PROP-001 … PROP-010 on
-- 2026-09-03, but next_property_code() still emitted the five-digit
-- 'PROP-' || lpad(nextval, 5, '0') form, so the next property created would have
-- been PROP-00011 sitting among PROP-001…PROP-010.
--
-- Two changes are needed, not one. Padding alone is not enough: the sequence sat
-- at 9, so the very next value would have rendered as PROP-010 — a duplicate of
-- an existing code, and properties.code is UNIQUE. The insert would have failed
-- outright. So the sequence is also advanced past the highest number already in
-- use.

/**
 * يولّد كود عقار جديد بصيغة من ثلاثة أرقام (PROP-011 وما بعده).
 *
 * Was lpad(…, 5, '0'). Kept as a SQL function with the same signature so the
 * column default on public.properties needs no change.
 */
create or replace function public.next_property_code()
returns text language sql security definer set search_path = public
as $$ select 'PROP-' || lpad(nextval('public.property_code_seq')::text, 3, '0') $$;

revoke all on function public.next_property_code() from public, anon;
grant execute on function public.next_property_code() to authenticated, service_role;

-- Advance the sequence past every numeric code already taken, so the next
-- generated code is free. Derived from the data rather than hardcoded, which
-- makes this safe to re-run and correct on any database whatever its history.
-- PROP-JAHRA and other non-numeric legacy codes simply do not match.
select setval(
  'public.property_code_seq',
  greatest(
    (
      select coalesce(max(substring(code from '^PROP-(\d+)$')::int), 0)
      from public.properties
    ),
    (select last_value from public.property_code_seq)
  ),
  true
);
