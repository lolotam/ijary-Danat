-- 18_gateway_card_method.sql
-- The MyFatoorah v3 hosted payment page offers every method enabled on the
-- account (VISA/MASTER, MADA, AMEX, ...), not only KNET / Apple Pay /
-- Google Pay. Without a card value the webhook/settlement path had to reject
-- successful card transactions after the tenant had already been charged.

alter type public.payment_methods add value if not exists 'card';
alter type public.gateway_payment_methods add value if not exists 'card';
