#!/usr/bin/env bash
# Seed the LOCAL dev stack with two demo companies and one account per role.
#   alpha → http://alpha.localhost:8080    beta → http://beta.localhost:8080
# Usernames: admin, accountant, collector, readonly, tenant (same in both
# companies — usernames are unique per company only). Password: see README.md.
# Re-runnable: existing accounts are skipped. LOCAL ONLY.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$HERE/.env"; set +a
API="http://localhost:54321"
PASSWORD="${SEED_PASSWORD:-Ijary-Local-2026!}"
ROLES=(admin accountant collector readonly tenant)

sql() {
  docker compose -f "$HERE/docker-compose.yml" exec -T db \
    psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq "$@" </dev/null
}

# The legacy migrations leave exactly one company behind; it becomes "alpha".
# Its slug is immutable (SLUG_IMMUTABLE), so it is reached by host instead.
ALPHA_ID="$(sql -c "select id from public.companies where slug <> 'beta' order by created_at limit 1")"
sql -c "
  update public.companies set name_ar = 'شركة ألفا العقارية', name_en = 'Alpha Real Estate'
   where id = '$ALPHA_ID';
  insert into public.companies (slug, name_ar, name_en, status)
  values ('beta', 'شركة بيتا العقارية', 'Beta Real Estate', 'active')
  on conflict (slug) do nothing;
  insert into public.company_domains (company_id, host, kind, is_primary, verification_status)
  values ('$ALPHA_ID', 'alpha.localhost', 'subdomain', true, 'verified'),
         ((select id from public.companies where slug = 'beta'), 'beta.localhost', 'subdomain', true, 'verified')
  on conflict do nothing;"

# New companies get no role permissions until seed_company_defaults() (T093)
# exists; copy alpha's defaults so beta's staff and renters can work.
sql -c "
  insert into public.role_permissions (role, permission_code, company_id)
  select rp.role, rp.permission_code, b.id
    from public.role_permissions rp
    cross join (select id from public.companies where slug = 'beta') b
   where rp.company_id = '$ALPHA_ID'
     and not exists (select 1 from public.role_permissions x
                      where x.company_id = b.id and x.role = rp.role
                        and x.permission_code = rp.permission_code);"

for slug in alpha beta; do
  if [[ "$slug" == alpha ]]; then cid="$ALPHA_ID"
  else cid="$(sql -c "select id from public.companies where slug = 'beta'")"; fi
  for role in "${ROLES[@]}"; do
    email="$slug.$role@auth.ijary.invalid"
    exists="$(sql -c "select 1 from auth.users where email = '$email'")"
    if [[ -n "$exists" ]]; then echo "= $slug/$role exists"; continue; fi

    uid="$(curl -sf "$API/auth/v1/admin/users" \
      -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"email_confirm\":true,
           \"user_metadata\":{\"company_id\":\"$cid\",\"username\":\"$role\",\"display_name\":\"$slug $role\"}}" \
      | sed -E 's/.*"id":"([0-9a-f-]{36})".*/\1/')"

    sql -c "insert into public.user_roles (user_id, role) values ('$uid', '$role'::public.app_role);"
    if [[ "$role" == "tenant" ]]; then
      sql -c "
        with t as (
          insert into public.tenants (code, company_id, name, lifecycle, tenant_portal_enabled)
          values ('T-$slug-001', '$cid', 'مستأجر تجريبي $slug', 'active', true)
          returning id)
        update public.profiles set tenant_id = (select id from t) where id = '$uid';"
    fi
    echo "+ $slug/$role"
  done
done
