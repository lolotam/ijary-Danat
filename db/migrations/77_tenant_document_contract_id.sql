-- 77_tenant_document_contract_id.sql
--
-- Let a tenant document belong to one of the tenant's contracts.
--
-- Background: a tenant can hold more than one contract — `contracts.tenant_id`
-- is a plain foreign key with no uniqueness constraint, and has always allowed
-- a second shop or a second unit in the same building. The admin UI now gives
-- each contract its own tab with its own invoices, payments and documents.
--
-- Documents were the one of those four with nothing to hang on.
-- `tenant_documents` carries `tenant_id` and a `type` enum that already
-- includes 'contract', but no link to *which* contract. `contracts.documents`
-- (jsonb) looks like it was meant for this, but it is written null at
-- src/routes/admin.contracts.tsx:290 and read nowhere — the same
-- written-but-never-read shape as `is_system` and `archived_at` before it. It
-- is not a usable store and this migration does not revive it.
--
-- The column is nullable and every existing row keeps NULL. The UI reads
--   contract_id = <this contract> OR contract_id IS NULL
-- so today's documents go on appearing under every contract tab exactly as they
-- do now. Nothing disappears on deploy and no backfill is required.
--
-- ON DELETE SET NULL, never CASCADE: deleting a contract must not destroy a
-- civil ID or a commercial licence that happened to be tagged to it. The
-- document falls back to being tenant-wide, which is where it started.

alter table public.tenant_documents
  add column if not exists contract_id uuid references public.contracts (id) on delete set null;

comment on column public.tenant_documents.contract_id is
  'Optional contract this document belongs to. NULL means it applies to the tenant as a whole and shows under every contract.';

-- Every read is "this contract's documents plus the untagged ones", so the
-- column is filtered on every load of a contract tab.
create index if not exists tenant_documents_contract_id_idx
  on public.tenant_documents (contract_id);
