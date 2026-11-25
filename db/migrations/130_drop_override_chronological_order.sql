-- 130 - drop the unused payments.override_chronological_order permission
--
-- The code was a checkbox on the roles screen that promised an override the
-- system has never had. No server function, RPC or UI path reads it. With
-- migration 129 the chronological block is hard and has no override.
--
-- role_permissions is the only table with a foreign key onto permissions, and
-- it cascades on delete, so removing the catalogue row also removes any role
-- assignment of a switch that never did anything.
--
-- Verified against production before applying: the `admin` role DID hold this
-- permission. Every admin therefore believed they could settle an invoice out
-- of order, and none of them could — which is the strongest argument for
-- deleting the checkbox rather than leaving it to keep making the promise.

delete from public.permissions
where code = 'payments.override_chronological_order';
