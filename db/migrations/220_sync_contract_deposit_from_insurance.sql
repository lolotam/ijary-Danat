-- 220_sync_contract_deposit_from_insurance.sql
--
-- يكتب مبلغ التأمين اليدوي إلى contracts.deposit عبر دالة واحدة مقيّدة بصلاحيات
-- التأمين وتكتب صف التدقيق في نفس العملية.
--
-- The insurance panel used to update `contracts.deposit` straight from the
-- browser. That needed `contracts.update` (so a clerk holding only insurance
-- rights got a failure warning on every save) and wrote no audit row for a
-- money field. Same shape as `update_contract_portal_visibility` (210): one
-- field, permission-checked, audited from inside SQL so the change and its
-- record commit together.
--
-- It takes the insurance row's id, never a contract id and an amount: the
-- contract and the amount are read from the persisted row, so a caller can
-- only bring the deposit into line with insurance that was actually saved,
-- not set an arbitrary figure on an arbitrary contract (Codex review, PR #232).

begin;

create or replace function public.sync_contract_deposit_from_insurance(
  p_insurance_id uuid
)
returns public.contracts
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_row public.contracts;
  v_contract_id uuid;
  v_amount numeric;
  v_old numeric;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'insurance.create')
     and not public.has_permission(auth.uid(), 'insurance.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select ip.contract_id, ip.amount into v_contract_id, v_amount
    from public.insurance_payments ip
   where ip.id = p_insurance_id;
  if v_contract_id is null then
    raise exception 'Insurance record not found';
  end if;

  select * into v_row from public.contracts where id = v_contract_id for update;
  if v_row.id is null then
    raise exception 'Contract not found';
  end if;

  -- An unchanged amount is not an event: re-saving the same insurance row
  -- must not add audit noise.
  if v_row.deposit = v_amount then
    return v_row;
  end if;

  v_old := v_row.deposit;
  update public.contracts
     set deposit = v_amount,
         updated_at = now()
   where id = v_contract_id
  returning * into v_row;

  perform public.write_audit(
    'contract.deposit.sync_from_insurance',
    'contract',
    v_contract_id,
    jsonb_build_object('deposit', v_old),
    jsonb_build_object('deposit', v_amount, 'insurance_id', p_insurance_id)
  );

  return v_row;
end;
$$;

comment on function public.sync_contract_deposit_from_insurance(uuid) is
  'يكتب مبلغ سجل التأمين المحفوظ إلى وديعة عقده ويكتب صف التدقيق في نفس العملية. Reads contract and amount from the insurance row; gated on insurance.create or insurance.update rather than contracts.update, because it is the insurance panel that calls it; a no-op when the amount is unchanged.';

revoke all on function public.sync_contract_deposit_from_insurance(uuid) from public, anon;
grant execute on function public.sync_contract_deposit_from_insurance(uuid)
  to authenticated, service_role;

commit;
