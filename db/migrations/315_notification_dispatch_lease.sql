-- 315_notification_dispatch_lease.sql
--
-- يضيف حجز إرسال الإشعارات: عمود `dispatch_claimed_at` يعلن أن صفّاً واحداً
-- يُرسَل الآن، فلا يُرسَل مرتين مهما تزامنت مسارات التصريف.
--
-- GR-001: a row could still be dispatched twice after it was claimed by the
-- retry compare-and-swap (migration-era GR-010). The CAS moved a `failed` row
-- to `queued` and dispatched it inline, while `runNotificationDrainJob` (its
-- `queued, failed` scan and its queued branch) or the `notification.dispatch`
-- worker could read the very same row as `queued` and dispatch it again — the
-- provider then received the message twice. The same race existed between the
-- drain and the worker on any queued row.
--
-- The fix is review option (b): a lease column and no new enum state. The
-- claim is one atomic conditional update in
-- `src/fns/dispatchNotification.ts`:
--
--   update public.notifications
--      set dispatch_claimed_at = <now>
--    where id = <id>
--      and company_id = <company>
--      and state in ('queued', 'failed')
--      and (dispatch_claimed_at is null
--           or dispatch_claimed_at < now() - interval '10 minutes')
--  returning *;
--
-- Of two concurrent callers Postgres lets exactly one update the row; the
-- loser matches no row, sends nothing, and returns the row as it is now. The
-- ten-minute lease (DISPATCH_LEASE_MS) is an order of magnitude longer than
-- the longest realistic dispatch — two channels, attachment downloads and
-- provider round-trips finish in seconds — so a sender still working cannot
-- lose its claim mid-send, while a sender that crashed mid-send leaves a row
-- the next drain reclaims instead of one stuck until the 72-hour stale
-- window cancels it.
--
-- Every terminal write (sent, failed, needs_review, skipped, cancelled)
-- clears the lease. The dispatch module clears the column explicitly on its
-- own writes; the trigger below is the database-level half of the same rule
-- for every other writer — the Resend webhook, the Notification Log's
-- client-side cancel, plain SQL. It fires only when the STATE CHANGES to a
-- terminal state, so the claim's own write — which stamps the lease while
-- leaving a `failed` row `failed` — is untouched.
--
-- No index: the claim updates by primary key (`id`), the drain scans by
-- `state` (notifications_state_idx, migration 07), and nothing filters on
-- `dispatch_claimed_at` in SQL — a partial index would be write cost with no
-- reader.
--
-- Rollback:
--   drop trigger if exists notifications_dispatch_lease_clear on public.notifications;
--   drop function if exists public.notifications_clear_dispatch_claim();
--   alter table public.notifications drop column if exists dispatch_claimed_at;

alter table public.notifications
  add column if not exists dispatch_claimed_at timestamptz null;

create or replace function public.notifications_clear_dispatch_claim()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.dispatch_claimed_at := null;
  return new;
end;
$$;

drop trigger if exists notifications_dispatch_lease_clear on public.notifications;
create trigger notifications_dispatch_lease_clear
  before update of state on public.notifications
  for each row
  when (old.state is distinct from new.state
        and new.state in ('sent', 'failed', 'needs_review', 'skipped', 'cancelled'))
  execute function public.notifications_clear_dispatch_claim();
