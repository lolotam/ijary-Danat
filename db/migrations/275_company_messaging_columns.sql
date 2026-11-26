-- 275_company_messaging_columns.sql
-- T031 (part 1): Company isolation columns, composite FKs, per-company uniques,
-- and company-led indexes for the messaging table group (`gmail_connections`,
-- `gmail_messages`, `email_signatures`, `evolution_connections`, `whatsapp_chats`,
-- `whatsapp_contacts`, `whatsapp_messages`, `whatsapp_contact_contracts`,
-- `tenant_messages`, `contact_inquiries`).
-- Idempotent.

------------------------------------------------------------
-- 1. gmail_connections
------------------------------------------------------------

alter table public.gmail_connections
  drop constraint if exists gmail_connections_company_id_fkey;

alter table public.gmail_connections
  add constraint gmail_connections_company_id_fkey
  foreign key (company_id) references public.companies(id);

alter table public.gmail_connections
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gmail_connections_company_id_id_key'
       and conrelid = 'public.gmail_connections'::regclass
  ) then
    alter table public.gmail_connections
      add constraint gmail_connections_company_id_id_key unique (company_id, id);
  end if;
end $$;

------------------------------------------------------------
-- 2. gmail_messages
------------------------------------------------------------

alter table public.gmail_messages
  drop constraint if exists gmail_messages_company_id_fkey;

alter table public.gmail_messages
  add constraint gmail_messages_company_id_fkey
  foreign key (company_id) references public.companies(id);

alter table public.gmail_messages
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gmail_messages_company_id_id_key'
       and conrelid = 'public.gmail_messages'::regclass
  ) then
    alter table public.gmail_messages
      add constraint gmail_messages_company_id_id_key unique (company_id, id);
  end if;
end $$;

------------------------------------------------------------
-- 3. email_signatures
------------------------------------------------------------

alter table public.email_signatures
  add column if not exists company_id uuid references public.companies(id);

update public.email_signatures es
   set company_id = p.company_id
  from public.profiles p
 where p.id = es.admin_id
   and es.company_id is null
   and p.company_id is not null;

update public.email_signatures
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.email_signatures
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'email_signatures_company_id_id_key'
       and conrelid = 'public.email_signatures'::regclass
  ) then
    alter table public.email_signatures
      add constraint email_signatures_company_id_id_key unique (company_id, id);
  end if;
end $$;

drop index if exists public.email_signatures_admin_idx;
drop index if exists public.email_signatures_one_default_per_admin;

create index if not exists email_signatures_company_admin_idx
  on public.email_signatures (company_id, admin_id);
create unique index if not exists email_signatures_one_default_per_admin
  on public.email_signatures (company_id, admin_id)
  where is_default;

------------------------------------------------------------
-- 4. evolution_connections
------------------------------------------------------------

alter table public.evolution_connections
  add column if not exists company_id uuid references public.companies(id);

update public.evolution_connections
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.evolution_connections
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'evolution_connections_company_id_id_key'
       and conrelid = 'public.evolution_connections'::regclass
  ) then
    alter table public.evolution_connections
      add constraint evolution_connections_company_id_id_key unique (company_id, id);
  end if;
end $$;

------------------------------------------------------------
-- 5. whatsapp_chats
------------------------------------------------------------

alter table public.whatsapp_chats
  add column if not exists company_id uuid references public.companies(id);

update public.whatsapp_chats
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.whatsapp_chats
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if exists (
    select 1
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
     where cl.relname = 'whatsapp_chats'
       and con.conname = 'whatsapp_chats_pkey'
       and pg_get_constraintdef(con.oid) = 'PRIMARY KEY (chat_number)'
  ) then
    alter table public.whatsapp_chats drop constraint whatsapp_chats_pkey;
    alter table public.whatsapp_chats add primary key (company_id, chat_number);
  end if;
end $$;

create index if not exists whatsapp_chats_company_last_msg_idx
  on public.whatsapp_chats (company_id, last_message_at desc);

------------------------------------------------------------
-- 6. whatsapp_contacts
------------------------------------------------------------

alter table public.whatsapp_contacts
  add column if not exists company_id uuid references public.companies(id);

update public.whatsapp_contacts wc
   set company_id = t.company_id
  from public.tenants t
 where t.id = wc.tenant_id
   and wc.company_id is null;

update public.whatsapp_contacts
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.whatsapp_contacts
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'whatsapp_contacts_company_id_id_key'
       and conrelid = 'public.whatsapp_contacts'::regclass
  ) then
    alter table public.whatsapp_contacts
      add constraint whatsapp_contacts_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.whatsapp_contacts
  drop constraint if exists whatsapp_contacts_phone_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'whatsapp_contacts_company_phone_key'
       and conrelid = 'public.whatsapp_contacts'::regclass
  ) then
    alter table public.whatsapp_contacts
      add constraint whatsapp_contacts_company_phone_key unique (company_id, phone);
  end if;
end $$;

alter table public.whatsapp_contacts
  drop constraint if exists whatsapp_contacts_tenant_id_fkey,
  drop constraint if exists whatsapp_contacts_company_tenant_fkey;

alter table public.whatsapp_contacts
  add constraint whatsapp_contacts_company_tenant_fkey
  foreign key (company_id, tenant_id)
  references public.tenants(company_id, id)
  on delete set null (tenant_id);

create index if not exists whatsapp_contacts_company_tenant_idx
  on public.whatsapp_contacts (company_id, tenant_id);

------------------------------------------------------------
-- 7. whatsapp_messages
------------------------------------------------------------

alter table public.whatsapp_messages
  add column if not exists company_id uuid references public.companies(id);

update public.whatsapp_messages wm
   set company_id = wc.company_id
  from public.whatsapp_chats wc
 where wc.chat_number = wm.chat_number
   and wm.company_id is null;

update public.whatsapp_messages
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.whatsapp_messages
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'whatsapp_messages_company_id_id_key'
       and conrelid = 'public.whatsapp_messages'::regclass
  ) then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.whatsapp_messages
  drop constraint if exists whatsapp_messages_message_id_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'whatsapp_messages_company_message_id_key'
       and conrelid = 'public.whatsapp_messages'::regclass
  ) then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_company_message_id_key unique (company_id, message_id);
  end if;
end $$;

drop index if exists public.whatsapp_messages_chat_sent_idx;
create index if not exists whatsapp_messages_company_chat_sent_idx
  on public.whatsapp_messages (company_id, chat_number, sent_at desc, id desc);

------------------------------------------------------------
-- 8. whatsapp_contact_contracts
------------------------------------------------------------

alter table public.whatsapp_contact_contracts
  add column if not exists company_id uuid references public.companies(id);

update public.whatsapp_contact_contracts wcc
   set company_id = wc.company_id
  from public.whatsapp_contacts wc
 where wc.id = wcc.contact_id
   and wcc.company_id is null;

update public.whatsapp_contact_contracts wcc
   set company_id = c.company_id
  from public.contracts c
 where c.id = wcc.contract_id
   and wcc.company_id is null;

update public.whatsapp_contact_contracts
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.whatsapp_contact_contracts
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

alter table public.whatsapp_contact_contracts
  drop constraint if exists whatsapp_contact_contracts_contact_id_fkey,
  drop constraint if exists whatsapp_contact_contracts_company_contact_fkey,
  drop constraint if exists whatsapp_contact_contracts_contract_id_fkey,
  drop constraint if exists whatsapp_contact_contracts_company_contract_fkey;

alter table public.whatsapp_contact_contracts
  add constraint whatsapp_contact_contracts_company_contact_fkey
    foreign key (company_id, contact_id)
    references public.whatsapp_contacts(company_id, id)
    on delete cascade,
  add constraint whatsapp_contact_contracts_company_contract_fkey
    foreign key (company_id, contract_id)
    references public.contracts(company_id, id)
    on delete cascade;

create index if not exists whatsapp_contact_contracts_company_contract_idx
  on public.whatsapp_contact_contracts (company_id, contract_id);

/**
 * يستمد `company_id` لربط جهة اتصال واتساب بالعقد من جهة الاتصال الأب عند الإدراج إن غاب.
 */
create or replace function public.tg_whatsapp_contact_contracts_inherit_company()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.company_id is null and new.contact_id is not null then
    select wc.company_id into new.company_id
      from public.whatsapp_contacts wc
     where wc.id = new.contact_id;
  end if;
  return new;
end;
$$;

drop trigger if exists whatsapp_contact_contracts_inherit_company on public.whatsapp_contact_contracts;
create trigger whatsapp_contact_contracts_inherit_company
  before insert on public.whatsapp_contact_contracts
  for each row execute function public.tg_whatsapp_contact_contracts_inherit_company();

------------------------------------------------------------
-- 9. tenant_messages
------------------------------------------------------------

alter table public.tenant_messages
  add column if not exists company_id uuid references public.companies(id);

update public.tenant_messages tm
   set company_id = t.company_id
  from public.tenants t
 where t.id = tm.tenant_id
   and tm.company_id is null;

update public.tenant_messages
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.tenant_messages
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'tenant_messages_company_id_id_key'
       and conrelid = 'public.tenant_messages'::regclass
  ) then
    alter table public.tenant_messages
      add constraint tenant_messages_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.tenant_messages
  drop constraint if exists tenant_messages_tenant_id_fkey,
  drop constraint if exists tenant_messages_company_tenant_fkey,
  drop constraint if exists tenant_messages_sender_profile_id_fkey,
  drop constraint if exists tenant_messages_company_sender_profile_fkey;

alter table public.tenant_messages
  add constraint tenant_messages_company_tenant_fkey
    foreign key (company_id, tenant_id)
    references public.tenants(company_id, id)
    on delete cascade,
  add constraint tenant_messages_company_sender_profile_fkey
    foreign key (company_id, sender_profile_id)
    references public.profiles(company_id, id)
    on delete set null (sender_profile_id);

drop index if exists public.tenant_messages_status_idx;
drop index if exists public.tenant_messages_tenant_idx;
create index if not exists tenant_messages_company_status_idx
  on public.tenant_messages (company_id, status);
create index if not exists tenant_messages_company_tenant_idx
  on public.tenant_messages (company_id, tenant_id);

/**
 * يستمد `company_id` لرسالة المستأجر من سجل المستأجر الأب عند الإدراج إن غاب.
 */
create or replace function public.tg_tenant_messages_inherit_company()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.company_id is null and new.tenant_id is not null then
    select t.company_id into new.company_id
      from public.tenants t
     where t.id = new.tenant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_messages_inherit_company on public.tenant_messages;
create trigger tenant_messages_inherit_company
  before insert on public.tenant_messages
  for each row execute function public.tg_tenant_messages_inherit_company();

------------------------------------------------------------
-- 10. contact_inquiries
------------------------------------------------------------

alter table public.contact_inquiries
  add column if not exists company_id uuid references public.companies(id);

update public.contact_inquiries
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.contact_inquiries
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'contact_inquiries_company_id_id_key'
       and conrelid = 'public.contact_inquiries'::regclass
  ) then
    alter table public.contact_inquiries
      add constraint contact_inquiries_company_id_id_key unique (company_id, id);
  end if;
end $$;

drop index if exists public.contact_inquiries_status_idx;
create index if not exists contact_inquiries_company_status_idx
  on public.contact_inquiries (company_id, status);
