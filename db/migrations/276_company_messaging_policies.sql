-- 276_company_messaging_policies.sql
-- T031 (part 2): Forced RLS and hoisted company-scoped policies for the
-- messaging group, preserving column-level secret protections on
-- `gmail_connections` and `evolution_connections`.
-- Idempotent.

------------------------------------------------------------
-- 1. gmail_connections (authenticated keeps column-level SELECT without refresh_token)
------------------------------------------------------------

grant select, insert, update, delete on public.gmail_connections to company_service;

alter table public.gmail_connections enable row level security;
alter table public.gmail_connections force row level security;

drop policy if exists "Allow admins to view gmail connections" on public.gmail_connections;
drop policy if exists "Allow admins to disconnect gmail" on public.gmail_connections;
drop policy if exists gmail_connections_company_service_all on public.gmail_connections;

create policy "Allow admins to view gmail connections"
  on public.gmail_connections
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.integrations'))
  );

create policy "Allow admins to disconnect gmail"
  on public.gmail_connections
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.integrations'))
  );

create policy gmail_connections_company_service_all on public.gmail_connections
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 2. gmail_messages
------------------------------------------------------------

grant select, insert, update, delete on public.gmail_messages to company_service;

alter table public.gmail_messages enable row level security;
alter table public.gmail_messages force row level security;

drop policy if exists "Allow staff to view gmail messages" on public.gmail_messages;
drop policy if exists "Allow staff to update gmail messages" on public.gmail_messages;
drop policy if exists "Allow admins to delete gmail messages" on public.gmail_messages;
drop policy if exists gmail_messages_company_service_all on public.gmail_messages;

create policy "Allow staff to view gmail messages"
  on public.gmail_messages
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy "Allow staff to update gmail messages"
  on public.gmail_messages
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy "Allow admins to delete gmail messages"
  on public.gmail_messages
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'inbox.manage'))
  );

create policy gmail_messages_company_service_all on public.gmail_messages
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 3. email_signatures
------------------------------------------------------------

grant select, insert, update, delete on public.email_signatures to company_service;

alter table public.email_signatures enable row level security;
alter table public.email_signatures force row level security;

drop policy if exists email_signatures_owner_read on public.email_signatures;
drop policy if exists email_signatures_owner_write on public.email_signatures;
drop policy if exists email_signatures_company_service_all on public.email_signatures;

create policy email_signatures_owner_read on public.email_signatures
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and admin_id = (select auth.uid())
  );

create policy email_signatures_owner_write on public.email_signatures
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and admin_id = (select auth.uid())
  )
  with check (
    company_id = (select public.current_company_id())
    and admin_id = (select auth.uid())
  );

create policy email_signatures_company_service_all on public.email_signatures
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 4. evolution_connections (authenticated keeps column-level SELECT without secrets/QR)
------------------------------------------------------------

grant select, insert, update, delete on public.evolution_connections to company_service;

alter table public.evolution_connections enable row level security;
alter table public.evolution_connections force row level security;

drop policy if exists "Allow admins to view evolution connection" on public.evolution_connections;
drop policy if exists evolution_connections_company_service_all on public.evolution_connections;

create policy "Allow admins to view evolution connection"
  on public.evolution_connections
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.integrations'))
  );

create policy evolution_connections_company_service_all on public.evolution_connections
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 5. whatsapp_chats
------------------------------------------------------------

grant select, insert, update, delete on public.whatsapp_chats to company_service;

alter table public.whatsapp_chats enable row level security;
alter table public.whatsapp_chats force row level security;

drop policy if exists "Allow notification staff to read whatsapp chats" on public.whatsapp_chats;
drop policy if exists whatsapp_chats_company_service_all on public.whatsapp_chats;

create policy "Allow notification staff to read whatsapp chats"
  on public.whatsapp_chats
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'notifications.read'))
  );

create policy whatsapp_chats_company_service_all on public.whatsapp_chats
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 6. whatsapp_contacts
------------------------------------------------------------

grant select, insert, update, delete on public.whatsapp_contacts to company_service;

alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_contacts force row level security;

drop policy if exists "Allow notification staff to read whatsapp contacts" on public.whatsapp_contacts;
drop policy if exists whatsapp_contacts_company_service_all on public.whatsapp_contacts;

create policy "Allow notification staff to read whatsapp contacts"
  on public.whatsapp_contacts
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'notifications.read'))
  );

create policy whatsapp_contacts_company_service_all on public.whatsapp_contacts
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 7. whatsapp_messages
------------------------------------------------------------

grant select, insert, update, delete on public.whatsapp_messages to company_service;

alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_messages force row level security;

drop policy if exists "Allow notification staff to read whatsapp messages" on public.whatsapp_messages;
drop policy if exists whatsapp_messages_company_service_all on public.whatsapp_messages;

create policy "Allow notification staff to read whatsapp messages"
  on public.whatsapp_messages
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'notifications.read'))
  );

create policy whatsapp_messages_company_service_all on public.whatsapp_messages
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 8. whatsapp_contact_contracts
------------------------------------------------------------

grant select, insert, update, delete on public.whatsapp_contact_contracts to company_service;

alter table public.whatsapp_contact_contracts enable row level security;
alter table public.whatsapp_contact_contracts force row level security;

drop policy if exists "Allow notification staff to read whatsapp contact contracts" on public.whatsapp_contact_contracts;
drop policy if exists whatsapp_contact_contracts_company_service_all on public.whatsapp_contact_contracts;

create policy "Allow notification staff to read whatsapp contact contracts"
  on public.whatsapp_contact_contracts
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'notifications.read'))
  );

create policy whatsapp_contact_contracts_company_service_all on public.whatsapp_contact_contracts
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 9. tenant_messages
------------------------------------------------------------

grant select, insert, update, delete on public.tenant_messages to company_service;

alter table public.tenant_messages enable row level security;
alter table public.tenant_messages force row level security;

drop policy if exists tenant_messages_staff_select on public.tenant_messages;
drop policy if exists tenant_messages_staff_update on public.tenant_messages;
drop policy if exists tenant_messages_staff_delete on public.tenant_messages;
drop policy if exists tenant_messages_insert_staff on public.tenant_messages;
drop policy if exists tenant_messages_tenant_select on public.tenant_messages;
drop policy if exists tenant_messages_tenant_insert on public.tenant_messages;
drop policy if exists tenant_messages_company_service_all on public.tenant_messages;

create policy tenant_messages_staff_select on public.tenant_messages
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy tenant_messages_staff_update on public.tenant_messages
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy tenant_messages_staff_delete on public.tenant_messages
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy tenant_messages_insert_staff on public.tenant_messages
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and sender_profile_id = (select auth.uid())
    and (select public.is_staff((select auth.uid())))
  );

create policy tenant_messages_tenant_select on public.tenant_messages
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and exists (
      select 1
        from public.profiles p
       where p.id = (select auth.uid())
         and p.company_id = (select public.current_company_id())
         and p.tenant_id = tenant_messages.tenant_id
    )
  );

create policy tenant_messages_tenant_insert on public.tenant_messages
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and exists (
      select 1
        from public.profiles p
       where p.id = (select auth.uid())
         and p.company_id = (select public.current_company_id())
         and p.tenant_id = tenant_messages.tenant_id
    )
  );

create policy tenant_messages_company_service_all on public.tenant_messages
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 10. contact_inquiries
------------------------------------------------------------

revoke all on public.contact_inquiries from anon;
grant select, insert, update, delete on public.contact_inquiries to company_service;

alter table public.contact_inquiries enable row level security;
alter table public.contact_inquiries force row level security;

drop policy if exists "Allow public insertion of contact inquiries" on public.contact_inquiries;
drop policy if exists "Allow staff to view contact inquiries" on public.contact_inquiries;
drop policy if exists "Allow staff to update contact inquiries" on public.contact_inquiries;
drop policy if exists "Allow admins to delete contact inquiries" on public.contact_inquiries;
drop policy if exists contact_inquiries_company_service_all on public.contact_inquiries;

create policy "Allow staff to view contact inquiries"
  on public.contact_inquiries
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.has_role((select auth.uid()), 'admin'::public.app_role))
      or (select public.has_role((select auth.uid()), 'accountant'::public.app_role))
      or (select public.has_role((select auth.uid()), 'collector'::public.app_role))
    )
  );

create policy "Allow staff to update contact inquiries"
  on public.contact_inquiries
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy "Allow admins to delete contact inquiries"
  on public.contact_inquiries
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy contact_inquiries_company_service_all on public.contact_inquiries
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
