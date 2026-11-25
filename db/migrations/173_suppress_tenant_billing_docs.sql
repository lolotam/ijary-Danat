-- 173_suppress_tenant_billing_docs.sql
-- إخفاء المستندات القابلة للطباعة لعقود إيجار السطح في بوابة المستأجر مع إبقاء الفواتير ظاهرة وقابلة للسداد.
-- Suppress printable billing documents for eight roof-rental contracts without
-- hiding the receivables themselves. The portal keeps showing the invoices and
-- the gateway keeps settling them; only the printable/downloadable paper stops.
--
-- Flag lives on `contracts`, not derived from `units.floor` / `units.type` at
-- read time. That catalogue is operator-editable free text (see
-- `src/lib/unitFloorTypeBinding.ts`; one seeded value even carries a typo the
-- owner owns) — billing-document behaviour must not hang off a label an
-- operator can rename in Settings -> Lists.
--
-- Behaviour column, not a roof column: named for what it DOES, with the roof
-- reason in the comment. A ninth roof contract next month flips this switch,
-- not a migration.
--
-- Invariant this must NOT be confused with:
--   `invoices.is_visible_to_tenant` -> the tenant may SEE and PAY this
--   receivable row (gateway payment is invoice-driven and requires it).
--   `contracts.suppress_tenant_billing_docs` -> the tenant may not be ISSUED a
--   formal document for it (invoice PDF, receipt PDF, print, preview). Set this
--   and the invoices stay visible and payable while their paper disappears.
-- Do NOT overload `is_visible_to_tenant` for this; hiding the rows would break
-- gateway payment, which `evaluate_portal_payable_invoices` filters on exactly
-- that flag.

alter table public.contracts
  add column if not exists suppress_tenant_billing_docs boolean not null default false;

comment on column public.contracts.suppress_tenant_billing_docs is
  'When true, the tenant portal suppresses printable/downloadable billing documents (invoice PDF, receipt PDF, print, preview) for this contract''s invoices, while the invoice rows themselves remain visible and payable. Behaviour flag — not derived from units.floor/type.';

-- Re-issue the save RPC with the new column, copied verbatim from
-- 166_save_contract_extra_charges.sql (whose body is 119's) and edited only
-- where marked. The live body is 119, NOT 117, whose filename makes it look
-- canonical — see 166's header. Signature unchanged so `create or replace`
-- stays legal and PostgREST sees one candidate.

create or replace function public.save_contract_with_units(
  p_contract jsonb,
  p_units jsonb,
  p_contract_id uuid default null
)
returns public.contracts
language plpgsql security definer set search_path = public
as $$
declare
  v_contract public.contracts;
  v_unit jsonb;
  v_line integer := 1;
  v_charge jsonb;
  v_charge_order integer := 1;
begin
  -- I3: create and update are separate permissions. Do not collapse these.
  if not public.has_permission(
       auth.uid(),
       case when p_contract_id is null then 'contracts.create' else 'contracts.update' end
     ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if jsonb_array_length(p_units) = 0 then
    raise exception 'A contract must have at least one unit';
  end if;
  -- M6: reject a malformed payload here, where the message can name the real
  -- problem, rather than letting a NULL poison the prune below.
  if exists (
    select 1 from jsonb_array_elements(p_units) u
     where nullif(u->>'unit_id', '') is null
  ) then
    raise exception 'Every unit entry must carry a unit_id';
  end if;

  if p_contract_id is null then
    -- Explicit column list, NOT `select * from jsonb_populate_record(...)`:
    -- that yields NULL for every omitted key including `id` and `code`,
    -- overriding their defaults.
    insert into public.contracts
      (tenant_id, type, state, commercial_activity, start_date, end_date,
       duration_months, end_date_override_reason, due_day, grace_days,
       deposit, notes, suppress_tenant_billing_docs)
    values (
      (p_contract->>'tenant_id')::uuid,
      coalesce((p_contract->>'type')::public.contract_types, 'investment'),
      coalesce((p_contract->>'state')::public.contract_states, 'draft'),
      p_contract->>'commercial_activity',
      (p_contract->>'start_date')::date,
      (p_contract->>'end_date')::date,
      (p_contract->>'duration_months')::integer,
      p_contract->>'end_date_override_reason',
      coalesce((p_contract->>'due_day')::integer, 1),
      coalesce((p_contract->>'grace_days')::integer, 0),
      coalesce((p_contract->>'deposit')::numeric, 0),
      p_contract->>'notes',
      coalesce((p_contract->>'suppress_tenant_billing_docs')::boolean, false)
    )
    returning * into v_contract;
  else
    update public.contracts c set
      tenant_id = coalesce((p_contract->>'tenant_id')::uuid, c.tenant_id),
      type = coalesce((p_contract->>'type')::public.contract_types, c.type),
      state = coalesce((p_contract->>'state')::public.contract_states, c.state),
      commercial_activity = p_contract->>'commercial_activity',
      start_date = coalesce((p_contract->>'start_date')::date, c.start_date),
      end_date = coalesce((p_contract->>'end_date')::date, c.end_date),
      duration_months = (p_contract->>'duration_months')::integer,
      end_date_override_reason = p_contract->>'end_date_override_reason',
      due_day = coalesce((p_contract->>'due_day')::integer, c.due_day),
      grace_days = coalesce((p_contract->>'grace_days')::integer, c.grace_days),
      deposit = coalesce((p_contract->>'deposit')::numeric, c.deposit),
      notes = p_contract->>'notes',
      suppress_tenant_billing_docs = coalesce((p_contract->>'suppress_tenant_billing_docs')::boolean, c.suppress_tenant_billing_docs)
     where c.id = p_contract_id
     returning * into v_contract;
    if not found then raise exception 'Contract not found'; end if;
    -- M6: `not exists`, not `not in` — a NULL anywhere in the subquery would
    -- make `not in` NULL for every row and prune nothing at all.
    delete from public.contract_units cu
     where cu.contract_id = v_contract.id
       and not exists (
         select 1 from jsonb_array_elements(p_units) u
          where (u->>'unit_id')::uuid = cu.unit_id
       );
  end if;

  for v_unit in select * from jsonb_array_elements(p_units) loop
    insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
    values (v_contract.id, (v_unit->>'unit_id')::uuid, (v_unit->>'monthly_amount')::numeric, v_line)
    on conflict (contract_id, unit_id)
      do update set monthly_amount = excluded.monthly_amount, line_order = excluded.line_order;
    v_line := v_line + 1;
  end loop;

  -- Extra charges ride inside p_contract rather than as a fourth argument.
  -- A new parameter would create an overload, and PostgREST resolves an RPC by
  -- its named argument set -- two candidates is an ambiguity error, not a
  -- fallback. Dropping and recreating with four arguments instead would break
  -- the bundle still being served for the minutes a Dokploy build takes. The
  -- jsonb payload was already the extension point; nothing else had to move.
  --
  -- ABSENT key and EMPTY array mean different things, and conflating them is
  -- the bug waiting to happen here:
  --   absent  -> the caller is not managing extras. That is the bundle still
  --              being served during a deploy, and any future caller that only
  --              touches the contract's own fields. Leave them alone.
  --   []      -> the caller IS managing extras and says there are none.
  --              Delete them all.
  if p_contract ? 'extra_charges' then
    -- `not exists`, not `not in`: a NULL category_id anywhere in the payload
    -- would make `not in` NULL for every row and prune nothing at all. Same
    -- correction migration 119 made to the unit prune above.
    delete from public.contract_extra_charges ec
     where ec.contract_id = v_contract.id
       and not exists (
         select 1 from jsonb_array_elements(p_contract->'extra_charges') c
          where (c->>'category_id')::uuid = ec.category_id
       );
    for v_charge in select * from jsonb_array_elements(p_contract->'extra_charges') loop
      insert into public.contract_extra_charges
        (contract_id, category_id, amount, line_order)
      values (
        v_contract.id,
        (v_charge->>'category_id')::uuid,
        (v_charge->>'amount')::numeric,
        v_charge_order
      )
      on conflict (contract_id, category_id)
        do update set amount = excluded.amount, line_order = excluded.line_order;
      v_charge_order := v_charge_order + 1;
    end loop;
  end if;

  select * into v_contract from public.contracts where id = v_contract.id;
  return v_contract;
end;
$$;

-- REVOKE FIRST — see 117's correction 2.
revoke execute on function public.save_contract_with_units(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.save_contract_with_units(jsonb, jsonb, uuid) to authenticated;

do $$
declare
  missing_count int;
begin
  update public.contracts
     set suppress_tenant_billing_docs = true
   where id in (
    '4382a1fe-db50-4bae-8360-58ec43ecf3c8', -- CON-00011
    '12bb78a9-5eb2-43b1-bf47-294c87342fc4', -- CON-00059
    '1fd7bde9-2c61-4b0c-8a3e-8bf7576afd74', -- CON-00060
    '18d2b025-f2ed-4b82-8a2e-167cf5c7a534', -- CON-00061
    '1bf7c20c-ed78-4ebe-bdd1-e33868fcb014', -- CON-00062
    '902ca137-319a-42de-99d2-11cfa187493b', -- CON-00063
    '154d51ae-3755-4ea9-a081-f89bf2ead877', -- CON-00064
    '7b0d6e9c-d13a-49f1-99a1-42badb2dde2e'  -- CON-00065
  )
    and suppress_tenant_billing_docs is distinct from true;

  -- Backfill assertion: verify all eight ids EXIST in `contracts`. A bare
  -- `update ... where id in (...)` silently succeeds having matched 7 — or 0 —
  -- which would look like a clean migration and ship a feature that does
  -- nothing. Counting rows affected would also raise after the admin toggle
  -- (finding 1) legitimately turns one of the eight OFF and a later re-apply
  -- touches 1 row. Existence is what catches a mistyped or stale id, which is
  -- the real risk.
  select count(*) into missing_count
    from (values
      ('4382a1fe-db50-4bae-8360-58ec43ecf3c8'::uuid),
      ('12bb78a9-5eb2-43b1-bf47-294c87342fc4'::uuid),
      ('1fd7bde9-2c61-4b0c-8a3e-8bf7576afd74'::uuid),
      ('18d2b025-f2ed-4b82-8a2e-167cf5c7a534'::uuid),
      ('1bf7c20c-ed78-4ebe-bdd1-e33868fcb014'::uuid),
      ('902ca137-319a-42de-99d2-11cfa187493b'::uuid),
      ('154d51ae-3755-4ea9-a081-f89bf2ead877'::uuid),
      ('7b0d6e9c-d13a-49f1-99a1-42badb2dde2e'::uuid)
    ) as required(id)
    left join public.contracts c on c.id = required.id
    where c.id is null;

  -- Skip the check entirely when NONE of the eight are present. A clean
  -- database built by `bun run test:db` applies every migration before any
  -- fixture exists, so it legitimately holds none of these production ids;
  -- raising there would break test:db, test:sql and every fresh install.
  -- A PARTIAL match is the real alarm: it means an id was mistyped or a
  -- contract was deleted, and the feature would ship half-applied.
  if missing_count > 0 and missing_count < 8 then
    raise exception '173_suppress_tenant_billing_docs: % of the 8 required contracts are missing', missing_count;
  end if;
end $$;
