# Staff Payment Callback Implementation Plan

**Goal:** Settle gateway callbacks made by authorized staff previewing a tenant portal and retain the tenant context after the redirect.

## Files

- Modify `src/fns/confirmGatewayPayment.test.ts`: prove staff authorization and rejection without permission.
- Modify `src/fns/confirmGatewayPayment.ts`: resolve a payment request before authorization and return its tenant ID.
- Modify `src/hooks/useConfirmPayment.ts`: invalidate the confirmed payment's tenant caches.
- Modify `src/routes/portal_.payments.callback.tsx`: share a callback component and retain a confirmed tenant in portal links.
- Create `src/routes/portal_.payments.callback.$preq.tsx`: expose a path-based PREQ callback route.
- Modify `src/fns/createPayment.ts`: send newly created hosted payments to the path-based callback URL.

## Steps

1. Add the staff-preview regression test and run `npm test -- src/fns/confirmGatewayPayment.test.ts`; it must fail because staff profiles currently receive HTTP 403.
2. Add payment-request resolution and the existing `payment_links.create` authorization rule to `confirmGatewayPayment`; return the authorized request's tenant ID with every outcome.
3. Re-run the focused server-function test; it must pass with tenant and staff scenarios.
4. Change cache invalidation to use the confirmed result's tenant ID.
5. Share the callback UI between the current query-based route and a dynamic path route. Use the route parameter as the preferred PREQ code and preserve raw query handling for existing callback URLs.
6. Build new MyFatoorah redirect URLs with `/portal/payments/callback/<PREQ>` and include the confirmed tenant ID in staff callback CTAs.
7. Run focused tests, lint, typecheck, and build. Update Graphify after production-code changes.
