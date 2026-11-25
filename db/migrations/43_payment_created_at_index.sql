-- Migration 43: Create index on payments(created_at) for efficient timestamp sorting and tracking
create index if not exists payments_created_at_idx on public.payments (created_at desc);
