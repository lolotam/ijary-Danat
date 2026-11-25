-- 187_receipt_code_random_format.sql
--
-- Receipt code was `REC-0000001` (sequential). Requested format:
--   REC-(year-month)-(day generated)-15RANDOM
--   e.g. REC-2026-August-15-08-2026-B65EC44D58163RD
--   = REC-YYYY-FullMonth-DD-MM-YYYY-15UPPERALNUM
--
-- Full English month name: trim(to_char(now(),'FMMonth')).
-- Random segment: 11 bytes -> base64 -> strip /+= -> upper -> 15 chars
-- (~77 bits entropy, ~62^15 combos). The loop regenerates when the code is
-- already present in `receipts`; two concurrent inserts drawing the same
-- 15-char segment in the same instant would still hit `receipts.code unique`,
-- but at ~62^15 combinations that is not a case worth an exception handler.

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
begin
  loop
    v_random := upper(substr(translate(encode(gen_random_bytes(11), 'base64'), '/+=', ''), 1, 15));
    -- Fallback when base64 stripped leaves <15 chars (rare: '/' '+' '=' removed)
    while length(v_random) < 15 loop
      v_random := v_random || upper(substr(translate(encode(gen_random_bytes(4), 'base64'), '/+=', ''), 1, 15 - length(v_random)));
    end loop;

    v_code := 'REC-'
      || to_char(now(), 'YYYY') || '-'
      || trim(to_char(now(), 'FMMonth')) || '-'
      || to_char(now(), 'DD-MM-YYYY') || '-'
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
