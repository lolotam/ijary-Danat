# Contract Expiry Delivery Retry Design

## Goal

Ensure contract-expiry email and WhatsApp deliveries retry independently after
failure without duplicating deliveries that were already sent or are queued.

## Delivery Identity

Each delivery is identified by its contract, milestone, audience, channel, and
recipient address. A sent or queued delivery with that identity is complete;
failed and skipped rows are eligible for a new attempt.

## Job Flow

1. The expiry RPC returns a candidate for an active contract during its
   milestone retry window.
2. The job evaluates tenant email, tenant WhatsApp, and admin email separately.
3. Before enqueueing a delivery, the job checks whether that exact identity is
   already sent or queued.
4. The database enforces the same identity for sent and queued rows, preventing
   concurrent cron runs from producing duplicates.

## Retry Window

Each milestone remains eligible through the day before the next milestone. The
7-day reminder remains eligible through the contract end date. This permits the
daily cron to retry failed or skipped deliveries without sending a second copy
of a successful channel.

## Verification

Tests will cover independent tenant/admin delivery decisions and the retry
window. Existing typecheck, lint, test, and production-build commands remain
required before deployment. After deployment, all four cron jobs will be
smoke-tested against `https://danat-future.com/api/public/cron`.
