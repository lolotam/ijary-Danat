-- 12_database_reset.sql
-- Create database erase/reset function for admins.
-- Safe to re-run.

create or replace function public.erase_all_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Restrict to admin users only
  if not public.has_role(auth.uid(), 'admin') then
    raise exception 'Unauthorized: Only administrators can wipe the database.';
  end if;

  -- Truncate operational and transactional tables in order
  truncate table
    public.receipts,
    public.payment_allocations,
    public.payments,
    public.invoice_items,
    public.invoices,
    public.payment_requests,
    public.webhook_events,
    public.concessions,
    public.contracts,
    public.tenant_documents,
    public.tenants,
    public.electricity_charges,
    public.meter_readings,
    public.electricity_meters,
    public.units,
    public.buildings,
    public.properties,
    public.expenses,
    public.deposits,
    public.notifications,
    public.generated_reports,
    public.audit_logs,
    public.contact_inquiries
    cascade;
end;
$$;

-- Grant execution permissions
grant execute on function public.erase_all_data() to authenticated;
grant execute on function public.erase_all_data() to service_role;
