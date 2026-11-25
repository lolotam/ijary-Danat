-- 224_profiles_one_account_per_tenant.sql
--
-- يمنع ربط أكثر من حساب بوابة بنفس المستأجر.
--
-- `profiles.tenant_id` is the portal link, and until now only an FK and a plain
-- index (migration 04) sat on it. `createAppUser` checks for an existing link
-- before creating an account, but two admins saving at once both pass that read
-- and both insert. This index is the atomic guard; the app maps its 23505 to a
-- readable message and rolls the new auth user back.
--
-- Partial on `tenant_id is not null`: managerial accounts carry no tenant, and
-- any number of them must stay allowed. Production held 0 tenants with more
-- than one account when this was written (40 linked).
--
-- Idempotent.

create unique index if not exists profiles_tenant_id_unique
  on public.profiles (tenant_id)
  where tenant_id is not null;
