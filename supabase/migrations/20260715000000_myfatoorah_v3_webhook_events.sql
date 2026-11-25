-- MyFatoorah v3 edge-function support: webhook_events table and
-- additional payment_requests columns for idempotency and session tokens.

-- Ensure webhook_events table exists (Danat already has it in types but
-- the table may not be created yet on the self-hosted instance).
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway text NOT NULL DEFAULT 'myfatoorah',
  event_type text,
  provider_payment_id text,
  provider_event_id text,
  raw_payload jsonb,
  signature_valid boolean,
  processed boolean DEFAULT false,
  result text,
  error text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_payment_id
  ON public.webhook_events(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_event_id
  ON public.webhook_events(provider_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_webhook_events_provider_event_id
  ON public.webhook_events(provider_event_id)
  WHERE provider_event_id IS NOT NULL;

GRANT SELECT ON public.webhook_events TO authenticated;
GRANT ALL ON public.webhook_events TO service_role;

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Admins view all webhook events'
      AND tablename = 'webhook_events'
  ) THEN
    CREATE POLICY "Admins view all webhook events"
      ON public.webhook_events FOR SELECT TO authenticated
      USING (public.has_role(auth.uid(), 'admin'));
  END IF;
END $$;
