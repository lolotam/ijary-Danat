-- 216_portal_reads_its_own_insurance.sql
--
-- يُتيح للمستأجر معرفة إجمالي تأميناته فقط، دون فتح سجل التأمينات الإداري له.
--
-- The portal dashboard shows what the office holds of the tenant's money —
-- تأمين is the deposit, and `insurance_payments` (migration 56, fed from
-- `contracts.deposit` by migration 103) records what was actually COLLECTED
-- rather than what the contract says is owed. The two can disagree, and the
-- tenant is entitled to the former. It had never been shown to the person who
-- paid it.
--
-- An RLS policy on the table was the first attempt and it gave away too much.
-- Review round 1 on PR #212: a SELECT policy authorises every COLUMN of every
-- matching row, so a tenant calling PostgREST directly — not through the
-- dashboard — would read the staff-entered `note`, `created_by`, and the
-- internal unit and building identifiers. The screen needs one number, so one
-- number is what the database hands out.
--
-- Draft leases can already have a collected deposit: `ContractFormDialog`
-- mirrors `contracts.deposit` into `insurance_payments` on save, and the
-- Insurance tab plus the budget `insurance_collected` KPI keep counting that
-- row. The portal still excludes drafts — an unagreed lease is not money the
-- tenant should be told the office is holding for them.
--
-- Generic `public.refunds` are still not netted as a table. That table has no
-- column saying what a refund is for — only `amount`, a free-text `reason`
-- and `post_action` — so an insurance return cannot be told from any other
-- refund without pattern-matching prose. Completed `contract_closeouts` are
-- the classified record of what happened to the deposit (migration 84 / 114):
-- `deductions_total`, `settled_total`, and `refund_total` come out of
-- `deposit_held`. Those are netted. A generic refund is not a substitute.
--
-- `void_refund` / `reverse_refund` (migration 85) flip `refunds.status` and
-- do not touch the completed close-out header. `refund_total` therefore stays
-- even after the money came back. A linked `refund_id` whose status is
-- `voided` or `reversed` is not a live disposal; `posted` still is.

begin;

-- يحفظ معرّف دفعة التسوية كي لا يتوقف تتبّع العكس على مرجع قابل للتعديل.
-- Add the payment identity to the existing idempotent result, preserving the
-- engine's permissions, locking and financial logic without copying its body.
do $patch$
declare
  v_definition text;
  v_marker text := 'v_result := jsonb_build_object(';
begin
  select pg_get_functiondef(
    'public.close_out_contract(uuid,date,text,text,boolean,jsonb,jsonb,numeric,text,text,timestamptz)'::regprocedure
  ) into v_definition;
  if position('''settlement_payment_id'', v_payment_id,' in v_definition) = 0 then
    if (length(v_definition) - length(replace(v_definition, v_marker, '')))
         / length(v_marker) <> 1 then
      raise exception 'Unexpected close_out_contract definition: settlement identity patch refused';
    end if;
    execute replace(v_definition, v_marker,
      v_marker || E'\n    ''settlement_payment_id'', v_payment_id,');
  end if;
end;
$patch$;

-- يربط التسويات السابقة فقط عند تطابق دفعة واحدة مع إغلاق واحد دون تخمين.
-- Old headers lacked an ID. Match the engine's original transaction timestamp,
-- amount, snapshotted reference and invoice action. Ambiguous legacy rows abort
-- below rather than guessing. Preflight on 2026-09-17 found no historic settlements.
with candidates as (
  select distinct co.id as closeout_id, p.id as payment_id
    from public.contract_closeouts co
    join public.contract_closeout_invoice_actions a
      on a.closeout_id = co.id and a.action = 'settle_from_deposit'
    join public.payment_allocations pa
      on pa.invoice_id = a.invoice_id and pa.amount = a.amount
    join public.payments p on p.id = pa.payment_id
   where co.status = 'completed' and co.settled_total > 0
     and co.result ->> 'settlement_payment_id' is null
     and p.reversed_by_payment_id is null
     and p.created_at = co.completed_at
     and p.amount = co.settled_total
     and p.reference = 'CLOSEOUT:' || (co.result ->> 'contract_code')
), unambiguous as (
  select closeout_id, payment_id
    from candidates c
   where (select count(*) from candidates x where x.closeout_id = c.closeout_id) = 1
     and (select count(*) from candidates x where x.payment_id = c.payment_id) = 1
)
update public.contract_closeouts co
   set result = coalesce(co.result, '{}'::jsonb)
       || jsonb_build_object('settlement_payment_id', u.payment_id)
  from unambiguous u
 where co.id = u.closeout_id;

-- يرفض نشر حساب ناقص إذا تعذّر ربط تسوية قديمة بمعرّف موثوق.
do $legacy$
begin
  if exists (
    select 1 from public.contract_closeouts
     where status = 'completed' and settled_total > 0
       and result ->> 'settlement_payment_id' is null
  ) then
    raise exception 'Unlinked legacy close-out settlements: verify payment IDs before applying migration 216';
  end if;
end;
$legacy$;

-- يُرجع صافي التأمين الذي ما زال المكتب يحمله للمستأجر، دون العقود المخفية عن البوابة.
--
-- The hidden-contract test is written in the POSITIVE deliberately. A
-- `not exists (... where c.hide_from_portal)` inside a definer function that
-- then had to respect the caller's view would repeat migration 212's mistake on
-- the invoices policy; here the function is the authority, so it names the
-- condition outright and leaves nothing to a policy evaluated underneath it.
create or replace function public.portal_insurance_total(
  p_tenant_id uuid,
  p_contract_id uuid default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_total numeric(14, 3);
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  -- Auth guard, re-stated from `portal_hidden_payment_ids` (migration 214).
  -- This returns only a number the caller's own money adds up to, but "the
  -- caller's own" is exactly what has to be checked.
  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Ownership comes from the CONTRACT, not from `insurance_payments.tenant_id`.
  -- Migration 190 propagates invoices, payments and receipts when staff
  -- reassign a contract, but not insurance rows, and `syncContractInsurance`
  -- leaves an existing row untouched when the deposit amount has not changed.
  -- Summing on the insurance row's own tenant therefore showed the FORMER
  -- tenant insurance for a lease they no longer hold, while the new tenant saw
  -- none of it. Review round 2 on PR #212.
  --
  -- Remaining held is CURRENT collected minus classified completed disposals,
  -- per contract, floored at zero — not `deposit_held` minus those columns.
  -- `closeout_compute_settlement` snapshots `deposit_held` from a scalar
  -- `insurance_payments.amount` at commit, and `close_out_contract`
  -- (migration 114) then leaves that row in place after keep_terminated,
  -- freeze, or archive. Using the snapshot as the minuend would drop a later
  -- collection that updates the unique insurance row (a fully refunded 1000
  -- then raised to 1300 would still read as 0). Two completed close-outs
  -- would also double-count: each snapshot is the then-current holding, and
  -- summing snapshot-remainders counts the pot twice. Disposals are the
  -- classified outflows (`deductions_total` kept, `settled_total` applied to
  -- invoices while the linked settlement payment is not reversed, and
  -- `refund_total` returned while the linked refund is still live).
  -- The writer persists settlement_payment_id in its idempotent result;
  -- mutable payment references and contract codes are not runtime identities.
  -- `void_refund` and `reverse_refund` leave `refund_total` on the completed
  -- header; they only change `refunds.status`. A `refund_id` pointing at a
  -- `voided` or `reversed` row is therefore not subtracted. A header with no
  -- `refund_id` still nets `refund_total` because the classified header remains the only record of that disposal
  -- when no refund row was linked.
  -- `written_off_total` is an invoice write-off, not a deposit movement.
  -- Draft and cancelled close-outs have not disposed anything that committed.
  --
  -- Both sides are aggregated to contract_id BEFORE they meet. A join from
  -- insurance_payments to contract_closeouts would multiply the holding:
  -- insurance is unique on contract_id, but completed close-outs are not
  -- (freeze then close again; archive, restore, close again — restore leaves
  -- the completed row in place and does not reverse the money).
  select coalesce(sum(greatest(collected.amount - coalesce(disposed.amount, 0), 0)), 0)
    into v_total
    from (
      select ins.contract_id, sum(ins.amount) as amount
        from public.insurance_payments ins
        join public.contracts c on c.id = ins.contract_id
       where c.tenant_id = p_tenant_id
         -- Scoped to the contract the dashboard has selected, like the lease and
         -- invoice KPIs beside it. Tenant-wide totals sat next to one contract's
         -- rent and attributed every lease's deposit to it. A contract id belonging
         -- to someone else yields 0 rather than leaking, because the tenant test
         -- above is ANDed with it, not replaced by it. Review round 3 on PR #212.
         and (p_contract_id is null or c.id = p_contract_id)
         -- Draft deposits can be collected (mirrored on save) but the portal
         -- deliberately does not report them: the lease is unagreed. The
         -- Insurance tab and budget KPI still count the row.
         and c.state <> 'draft'
         and not coalesce(c.hide_from_portal, false)
       group by ins.contract_id
    ) collected
    left join (
      select co.contract_id,
             sum(
               co.deductions_total
               + case
                   when settlement.status = 'reversed' then 0
                   else co.settled_total
                 end
               + case
                   when r.status in ('voided', 'reversed') then 0
                   else co.refund_total
                 end
             ) as amount
        from public.contract_closeouts co
        left join public.refunds r on r.id = co.refund_id
        left join public.payments settlement
          on settlement.id::text = co.result ->> 'settlement_payment_id'
       where co.status = 'completed'
       group by co.contract_id
    ) disposed on disposed.contract_id = collected.contract_id;

  return v_total;
end;
$fn$;

comment on function public.portal_insurance_total(uuid, uuid) is
  'يُرجع صافي التأمين الذي ما زال المكتب يحمله للمستأجر، دون العقود المخفية عن البوابة. Sums by CONTRACT ownership so a reassigned lease follows its new tenant, scopes to the selected contract, excludes drafts (even when a deposit was already collected), nets live collected minus completed close-out deductions/settlements and still-live linked refunds per contract floored at zero rather than the deposit_held snapshot, drops reversed settlement payments and voided/reversed close-out refunds (the lifecycle RPCs leave the header totals unchanged), ignores generic refunds, and returns only the summed amount, never the insurance_payments rows themselves: a SELECT policy on that table would have handed a tenant the staff-entered note, created_by and internal unit/building ids along with the figure the dashboard needs.';

revoke all on function public.portal_insurance_total(uuid, uuid) from public, anon;
grant execute on function public.portal_insurance_total(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
