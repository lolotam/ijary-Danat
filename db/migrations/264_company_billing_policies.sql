-- 264_company_billing_policies.sql
-- T025 (Billing group): enable + force RLS and rewrite policies to hoisted
-- `(select public.current_company_id())` for authenticated and company_service.
-- Idempotent.

do $$
declare
  v_table text;
  v_pol text;
begin
  foreach v_table in array array[
    'invoices',
    'invoice_items',
    'payments',
    'payment_allocations',
    'receipts',
    'payment_requests',
    'webhook_events',
    'email_webhook_events'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);

    for v_pol in
      select p.polname
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = v_table
         and not (
           cardinality(p.polroles) = 1
           and p.polroles[1] = 'service_role'::regrole::oid
         )
    loop
      execute format('drop policy if exists %I on public.%I', v_pol, v_table);
    end loop;
  end loop;
end $$;

-- Webhook event tables need insert/update for company_service (webhook handlers),
-- while `authenticated` stays read-only.
grant select, insert, update on public.email_webhook_events to company_service;

------------------------------------------------------------
-- invoices
------------------------------------------------------------

create policy invoices_select_allowed on public.invoices
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or (
        is_visible_to_tenant
        and exists (
          select 1
            from public.profiles p
           where p.id = (select auth.uid())
             and p.tenant_id = invoices.tenant_id
        )
        and exists (
          select 1
            from public.contracts c
           where c.id = invoices.contract_id
        )
      )
    )
  );

create policy invoices_write_staff on public.invoices
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy invoices_company_service_all on public.invoices
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- invoice_items
------------------------------------------------------------

create policy invoice_items_select_allowed on public.invoice_items
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and exists (
      select 1
        from public.invoices i
       where i.id = invoice_items.invoice_id
         and (
           (select public.is_staff((select auth.uid())))
           or (
             i.is_visible_to_tenant
             and exists (
               select 1
                 from public.profiles p
                where p.id = (select auth.uid())
                  and p.tenant_id = i.tenant_id
             )
           )
         )
    )
  );

create policy invoice_items_write_staff on public.invoice_items
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy invoice_items_company_service_all on public.invoice_items
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- payments
------------------------------------------------------------

create policy payments_select_allowed on public.payments
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or (
        status = any (array['confirmed'::text, 'reversed'::text])
        and exists (
          select 1
            from public.profiles p
           where p.id = (select auth.uid())
             and p.tenant_id = payments.tenant_id
        )
      )
    )
  );

create policy payments_insert_staff on public.payments
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy payments_update_staff on public.payments
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy payments_company_service_all on public.payments
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- payment_allocations
------------------------------------------------------------

create policy payment_allocations_select_allowed on public.payment_allocations
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and exists (
      select 1
        from public.payments p
       where p.id = payment_allocations.payment_id
         and (
           (select public.is_staff((select auth.uid())))
           or exists (
             select 1
               from public.profiles pr
              where pr.id = (select auth.uid())
                and pr.tenant_id = p.tenant_id
           )
         )
    )
  );

create policy payment_allocations_write_staff on public.payment_allocations
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy payment_allocations_company_service_all on public.payment_allocations
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- receipts
------------------------------------------------------------

create policy receipts_select_allowed on public.receipts
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or (
        visible_to_tenant
        and exists (
          select 1
            from public.profiles p
           where p.id = (select auth.uid())
             and p.tenant_id = receipts.tenant_id
        )
      )
    )
  );

create policy receipts_write_staff on public.receipts
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy receipts_company_service_all on public.receipts
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- payment_requests
------------------------------------------------------------

create policy payment_requests_select_allowed on public.payment_requests
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or exists (
        select 1
          from public.profiles p
         where p.id = (select auth.uid())
           and p.tenant_id = payment_requests.tenant_id
      )
    )
  );

create policy payment_requests_insert_own_tenant on public.payment_requests
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and created_by = (select auth.uid())
    and exists (
      select 1
        from public.profiles p
        join public.tenants t on t.id = p.tenant_id
       where p.id = (select auth.uid())
         and p.tenant_id = payment_requests.tenant_id
         and t.tenant_portal_enabled
         and (select public.has_role((select auth.uid()), 'tenant'::public.app_role))
    )
  );

create policy payment_requests_company_service_all on public.payment_requests
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- webhook_events
------------------------------------------------------------

create policy webhook_events_select_staff on public.webhook_events
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy webhook_events_company_service_all on public.webhook_events
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- email_webhook_events
------------------------------------------------------------

create policy email_webhook_events_select_admin on public.email_webhook_events
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'notifications.read'::text))
  );

create policy email_webhook_events_company_service_all on public.email_webhook_events
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
