-- 158_mailbox_provider.sql
--
-- Records which provider a mailbox message travelled through, so the inbox can
-- badge and filter Gmail against Resend, and so a Resend send is not mistaken
-- for a Gmail one.
--
-- WHY THE TABLE KEEPS ITS NAME
-- `gmail_messages` now holds Resend rows too, which makes the name historical.
-- Renaming touches 16 source files plus the hand-maintained
-- `database.types.ts`, for no behavioural gain, so the name stays and this
-- column carries the truth instead.
--
-- WHY `default 'gmail'` IS CORRECT AND NOT A GUESS
-- Every row that exists when this runs arrived through the Gmail sync worker or
-- `gmailSend`; there was no other writer. The default therefore backfills the
-- real provenance rather than inventing one.

alter table public.gmail_messages
  add column if not exists provider text not null default 'gmail';

do $$ begin
  alter table public.gmail_messages
    add constraint gmail_messages_provider_check
    check (provider in ('gmail', 'resend'));
exception when duplicate_object then null; end $$;

create index if not exists gmail_messages_provider_idx
  on public.gmail_messages (company_id, provider, received_at desc);

comment on column public.gmail_messages.provider is
  'Which provider carried this message: gmail or resend. Provenance, not a preference — immutable after insert (see tg_gmail_messages_provider_immutable).';

------------------------------------------------------------
-- Provenance must not be editable by the people who read it
------------------------------------------------------------
--
-- Staff hold an unrestricted row-level UPDATE on this table (migration 50) so
-- that marking a message read works for accountants and collectors, and that
-- policy carries no column list. Without this trigger any staff member could
-- rewrite `provider` straight through PostgREST and a Resend message would
-- claim to be a Gmail one — a badge that lies is worse than no badge.
--
-- A trigger rather than column-level grants: Supabase hands new tables a blanket
-- UPDATE to `authenticated` through default privileges, so a column grant would
-- have to be preceded by a revoke that also re-breaks the existing mark-read
-- path (the rule migration 96 established). The trigger leaves that path alone
-- and refuses exactly one thing.

create or replace function public.tg_gmail_messages_provider_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.provider is distinct from old.provider then
    raise exception 'gmail_messages.provider is immutable (attempted % -> %)', old.provider, new.provider
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.tg_gmail_messages_provider_immutable() from public, anon, authenticated;

drop trigger if exists gmail_messages_provider_immutable on public.gmail_messages;
create trigger gmail_messages_provider_immutable
  before update on public.gmail_messages
  for each row execute function public.tg_gmail_messages_provider_immutable();

------------------------------------------------------------
-- The catalogue of Resend sender addresses
------------------------------------------------------------
--
-- Resend verifies a *domain*, so any address on a verified domain may send.
-- The catalogue exists to offer the admin a fixed set rather than a free-text
-- From box: a typo'd address is rejected by Resend at send time with an error
-- the sender has to interpret, and a dropdown removes that failure entirely.
--
-- The option-list machinery is reused rather than a dedicated table: the
-- vocabulary is small, admin-editable at Settings → Lists without a deploy, and
-- the list's own identity binds the provider — membership of `resend_senders`
-- IS the statement "send this through Resend". A dedicated table would add
-- per-address verification state that Resend already owns and reports.
--
-- Gmail deliberately has no equivalent list: it sends only as the authenticated
-- account, so its single legal sender comes from `gmail_connections`.

insert into public.option_lists (code, name_ar, name_en, description_ar, description_en, is_system)
values (
  'resend_senders',
  'عناوين الإرسال عبر Resend',
  'Resend sender addresses',
  'العناوين التي يمكن الإرسال منها عبر Resend؛ يجب أن تكون على نطاق موثّق',
  'Addresses that may send through Resend. Each must be on a domain verified in Resend.',
  true
)
on conflict (code) do nothing;

insert into public.option_list_items (list_id, value, label_ar, label_en, sort_order, is_system)
select l.id, v.value, v.label_ar, v.label_en, v.sort_order, false
from public.option_lists l
cross join (values
  ('no-reply@danat-future.com', 'بدون رد', 'No-reply', 10),
  ('management@danat-future.com', 'الإدارة', 'Management', 20),
  ('ceo@danat-future.com', 'الرئيس التنفيذي', 'CEO', 30),
  ('ahmed@danat-future.com', 'أحمد', 'Ahmed', 40),
  ('islam@danat-future.com', 'إسلام', 'Islam', 50)
) as v(value, label_ar, label_en, sort_order)
where l.code = 'resend_senders'
on conflict (list_id, value) do nothing;
