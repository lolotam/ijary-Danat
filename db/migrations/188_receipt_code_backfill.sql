-- 188_receipt_code_backfill.sql
--
-- Migration 187 changed the *default* for `receipts.code` to
--   REC-YYYY-FullMonth-DD-MM-YYYY-15RANDOM
-- which only ever reaches rows inserted after it was applied. Every receipt
-- already on record kept its sequential `REC-0000001` code, so the PDF a tenant
-- downloads for an existing payment still arrives under the old numbering. This
-- migration renumbers those rows into the requested format.
--
-- Two deliberate differences from `next_receipt_code`:
--
--  * The date comes from each receipt's own `issue_date`, not from `now()`. A
--    receipt issued in August must not be renamed as though it were issued on
--    the day the migration ran.
--  * The date is rendered in Asia/Kuwait, not in the server's UTC. The company
--    is in Kuwait and the name states the day the receipt was issued; between
--    21:00 and 23:59 UTC that is already the next day in Kuwait, and a UTC
--    rendering would date the receipt a day early. `next_receipt_code` is
--    re-issued below with the same correction so new codes and backfilled ones
--    read alike.
--
-- Scope guard: only rows whose code still matches `^REC-\d+$` are touched, so
-- re-applying this migration is a no-op and a code already in the new format is
-- never rewritten.

/**
 * يولّد رمز إيصال جديد بالصيغة REC-YYYY-Month-DD-MM-YYYY-15RANDOM
 * ويعيد المحاولة إذا تصادف وجود الرمز نفسه في `receipts.code`.
 *
 * يُستخدم كقيمة افتراضية لعمود `receipts.code`، لذا يجب أن يعمل بلا استثناء
 * من أي مسار إدراج (المشغّل `tg_sync_payment_receipt` وغيره).
 *
 * `search_path` includes `extensions` because that is where Supabase installs
 * pgcrypto in production (`gen_random_bytes` lives in `extensions`, not
 * `public`), while the SQL test image installs it in `public`. Listing both
 * schemas resolves the function in either environment; a schema missing from
 * the path is ignored by Postgres. Hard-qualifying `extensions.` would break
 * the local suite, and `public` alone broke every receipt insert on the live
 * server (Codex P1 on PR #178). `extensions` grants anon/authenticated only
 * USAGE, so nothing untrusted can shadow a name there under `security definer`.
 *
 * The timestamp is rendered in Asia/Kuwait: the database runs in UTC, and a
 * receipt issued just after midnight Kuwait time would otherwise be named with
 * the previous day.
 */
create or replace function public.next_receipt_code()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code text;
  v_random text;
  v_local timestamp;
begin
  v_local := now() at time zone 'Asia/Kuwait';
  loop
    v_random := upper(substr(translate(encode(gen_random_bytes(11), 'base64'), '/+=', ''), 1, 15));
    -- Fallback when base64 stripped leaves <15 chars (rare: '/' '+' '=' removed)
    while length(v_random) < 15 loop
      v_random := v_random || upper(substr(translate(encode(gen_random_bytes(4), 'base64'), '/+=', ''), 1, 15 - length(v_random)));
    end loop;

    v_code := 'REC-'
      || to_char(v_local, 'YYYY') || '-'
      || trim(to_char(v_local, 'FMMonth')) || '-'
      || to_char(v_local, 'DD-MM-YYYY') || '-'
      || v_random;

    perform 1 from public.receipts where code = v_code;
    if not found then
      return v_code;
    end if;
    -- collision -> loop and regenerate random segment
  end loop;
end;
$$;

revoke all on function public.next_receipt_code() from public;
grant execute on function public.next_receipt_code() to authenticated, service_role;

/**
 * يعيد ترقيم الإيصالات القديمة ذات الصيغة التسلسلية إلى الصيغة المطلوبة،
 * مع الاحتفاظ بتاريخ إصدار كل إيصال كما هو.
 *
 * Row by row rather than one `update … set code = …`: the random segment has to
 * be redrawn on a collision, and a set-based statement that hits the unique
 * index aborts the whole backfill instead of retrying the one row. At a few
 * thousand receipts the loop costs nothing.
 */
do $backfill$
declare
  v_row record;
  v_code text;
  v_random text;
  v_local timestamp;
  v_attempts int;
begin
  for v_row in
    select id, issue_date from public.receipts where code ~ '^REC-[0-9]+$' order by issue_date
  loop
    v_local := v_row.issue_date at time zone 'Asia/Kuwait';
    v_attempts := 0;
    loop
      v_attempts := v_attempts + 1;
      v_random := upper(substr(translate(encode(gen_random_bytes(11), 'base64'), '/+=', ''), 1, 15));
      while length(v_random) < 15 loop
        v_random := v_random || upper(substr(translate(encode(gen_random_bytes(4), 'base64'), '/+=', ''), 1, 15 - length(v_random)));
      end loop;

      v_code := 'REC-'
        || to_char(v_local, 'YYYY') || '-'
        || trim(to_char(v_local, 'FMMonth')) || '-'
        || to_char(v_local, 'DD-MM-YYYY') || '-'
        || v_random;

      perform 1 from public.receipts where code = v_code;
      exit when not found;

      -- 62^15 combinations; a second draw colliding means something is wrong
      -- with the random source, and looping forever would hang the migration.
      if v_attempts >= 10 then
        raise exception 'next receipt code kept colliding for receipt %', v_row.id;
      end if;
    end loop;

    update public.receipts set code = v_code where id = v_row.id;
  end loop;
end;
$backfill$;
