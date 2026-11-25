-- 64_contact_inquiries_status.sql
--
-- Visitor messages never reached the header bell.
--
-- The bell consolidates unread across tenant messages, leasing leads and Gmail,
-- and its own comment explains the omission: "Contact inquiries are never marked
-- unread, so they do not contribute." That was accurate — `contact_inquiries`
-- had no status column at all, so there was nothing to be unread. A visitor
-- submitting the landing form produced a row an admin only saw by opening the
-- Inbox and looking.
--
-- Leasing leads notified because `leasing_inquiries` has a `status` column the
-- bell filters on. This gives contact inquiries the same thing, deliberately
-- copying `tenant_messages.status` (22_batch_features.sql:51) rather than
-- inventing a shape: the bell already filters `status = 'new'` for that source,
-- so matching it keeps the bell a three-line addition instead of a special case.
--
-- 'archived' is carried across too. Nothing sets it today, but keeping the
-- vocabulary identical to tenant_messages means the two sources cannot drift
-- into needing different handling later.
--
-- Existing rows default to 'new'. That is correct rather than merely convenient
-- — nobody has ever marked one read, because there was no way to. Checked the
-- blast radius before relying on it: production holds exactly one row.

alter table public.contact_inquiries
  add column if not exists status text not null default 'new';

do $$
begin
  alter table public.contact_inquiries
    add constraint contact_inquiries_status_check
    check (status in ('new', 'read', 'archived'));
exception
  when duplicate_object then null;
end;
$$;

-- Mirrors tenant_messages_status_idx; the bell and the tab badge both count
-- unread rows on every load.
create index if not exists contact_inquiries_status_idx
  on public.contact_inquiries (status);

-- Marking read is a write, and staff previously had select/insert/delete only —
-- no UPDATE policy and no UPDATE grant existed on this table. Without both, the
-- mark-read button would fail silently: RLS refuses by matching zero rows rather
-- than raising, so the button would appear to work and change nothing.
--
-- Staff-level, matching the select policy above it and mark-read on
-- tenant_messages. Gating this on admin alone would make the button dead for
-- accountants and collectors, who are exactly the people working the inbox.
drop policy if exists "Allow staff to update contact inquiries" on public.contact_inquiries;
create policy "Allow staff to update contact inquiries"
  on public.contact_inquiries
  for update
  to authenticated
  using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

grant update on public.contact_inquiries to authenticated;
