# Staff Payment Callback Specification

## Status

Approved for implementation on 2026-07-21.

## Problem

An administrator can create a MyFatoorah payment while previewing a tenant portal, but the gateway callback fails with HTTP 403 before payment settlement. The callback currently requires the authenticated profile to have a `tenant_id`; staff profiles intentionally do not have one.

MyFatoorah replaces callback query parameters with its own payment identifiers. This removes the tenant-preview context and the `preq` fallback code, so callback CTAs return staff to `/admin` instead of the previewed tenant portal.

## Confirmed Root Cause

`src/fns/confirmGatewayPayment.ts` resolves `profiles.tenant_id` before resolving the payment request. For staff, this value is null and the handler returns `Tenant profile is not linked.` with HTTP 403. `settleGatewayPayment` is therefore never called.

The existing `createPayment` handler already supports staff through `payment_links.create`; the callback must use the same authorization rule.

## Scope

1. Allow a tenant or authorized staff member to confirm a payment request.
2. Put the payment-request code in the callback path so it survives the gateway redirect.
3. Return the resolved tenant ID from confirmation so cache invalidation and callback CTAs preserve staff preview context.
4. Preserve query-string `preq` support for previously issued gateway URLs.

## Non-Goals

1. Change MyFatoorah status inquiry behavior.
2. Change invoice-selection, allocation, or duplicate-payment rules.
3. Add new permissions or database schema changes.

## Design

### Payment-Request Resolution and Authorization

`confirmGatewayPayment` will resolve the payment request from the callback code when present. Otherwise it will resolve the gateway status first, then locate the request by provider invoice ID or provider payment ID.

After a payment request is available, the handler will authorize the caller as either:

1. The request's tenant (`profiles.tenant_id === payment_request.tenant_id`), or
2. A staff member with `payment_links.create`.

The handler will return `{ status, tenantId }` for every non-error gateway outcome. A paid result continues to call `settleGatewayPayment` once, after authorization.

### Callback URL

New hosted payment requests will use:

`/portal/payments/callback/PREQ-<number>`

The dynamic callback route supplies the path code to a shared callback component. The existing query-based callback route remains available for payments created before this deployment.

### Portal UI

The confirmation hook invalidates portal data using the `tenantId` returned by the server rather than relying on a callback-page identity lookup. This works when the callback page is outside the portal layout and the visitor is staff.

After confirmation, receipt, invoices, and payments links include `?tenant=<resolved tenant ID>` for staff previewing a tenant. Tenant self-service users continue to receive the same portal destinations without a required preview context.

## Regression Coverage

Add a server-function regression test where a staff profile with no `tenant_id` and `payment_links.create` permission confirms a paid MyFatoorah status. The test must assert a paid outcome with the request tenant ID and one settlement call.

Existing tenant confirmation tests must continue to pass. The test suite must also cover a staff caller without the permission receiving HTTP 403.

## Acceptance Criteria

1. Staff preview callbacks no longer fail because their profile has no `tenant_id`.
2. A successful staff callback creates the normal payment, receipt, and allocations through `settleGatewayPayment`.
3. New callback URLs retain the PREQ code after the gateway redirect.
4. Callback CTAs retain the previewed tenant context for staff.
5. Paid invoice, payment, receipt, and dashboard data refetch for the resolved tenant.
6. Existing tenant self-service callbacks remain authorized and functional.
