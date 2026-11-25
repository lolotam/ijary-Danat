-- 144_repair_infinite_ban.sql
--
-- يُصلح قيمة `banned_until = 'infinity'` التي كتبها الجزء ٣ من الترحيل 142،
-- لأن GoTrue لا يستطيع قراءتها أصلاً، فيرفض تحميل الحساب كله.
--
-- Migration 142 part ٣ back-filled `auth.users.banned_until = 'infinity'` for
-- accounts deactivated before the ban was enforced at the issuer. Postgres
-- accepts `infinity` for a timestamptz, but GoTrue's Go driver cannot scan it
-- into a `time.Time`, so every request that loads such a row fails with
-- `500: Database error loading user` — admin password/email updates, the
-- password grant, the unban itself. The Users screen surfaced that as a red
-- `{}` toast (auth-js stringifies the raw Response for 5xx), and a
-- reactivation attempt got as far as `profiles.is_active = true` before the
-- unban failed, leaving the profile saying "active" while GoTrue refused the
-- login and refused to be told otherwise.
--
-- Repair rule: `profiles.is_active` is the state the admin can see and toggle,
-- so it wins. Active → lift the ban. Inactive → keep the ban but make it a
-- finite far-future instant, the same shape `setUserActive` writes through
-- the Admin API (`ban_duration: "876000h"`), so GoTrue can read it and the
-- admin can lift it later from the switch. `now()` is evaluated once per
-- statement, so both rows of a batch land on the same instant.
--
-- Idempotent: only `infinity` rows match, and there are none after the first
-- run. 142's own back-fill is amended alongside this so a fresh database
-- never writes the value in the first place.
-- ---------------------------------------------------------------------------

update auth.users u
   set banned_until = null
 where u.banned_until = timestamptz 'infinity'
   and exists (
     select 1 from public.profiles p
      where p.id = u.id and p.is_active);

update auth.users u
   set banned_until = now() + interval '876000 hours'
 where u.banned_until = timestamptz 'infinity'
   and not exists (
     select 1 from public.profiles p
      where p.id = u.id and p.is_active);
