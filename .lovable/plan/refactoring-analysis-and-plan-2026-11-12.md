# Refactoring analysis and plan

## Findings (from a scan of src/)
- No production file is past the 600-line ceiling. Closest to it: `admin.settings.roles.tsx` (592), `resolveTemplateVariables.ts` (589), `resendWebhook.ts` (583), `notifyPaymentSuccess.ts` (578), `TenantsTable.tsx` (571), `PaymentSidePanels.tsx` (559), `CreatePaymentDialog.tsx` (547).
- 12 test files are past 600 lines (largest: `contractCloseout.sqltest.ts` at 1286, `notifyPaymentSuccess.test.ts` at 998). CLAUDE.md already lists them as split-when-touched.
- `as any` casts show up in production code: `useCustomRoles.ts` (11) and `updateAppUser.ts` (7). Tests carry more (createPayment 22, backup 32 combined), mostly mocks.
- 16 route files use `useEffect`. Each one should be checked for data fetching that belongs in loader/query.

## Proposed work, in priority order
1. **Type safety.** Remove the `as any` casts in `useCustomRoles.ts` and `updateAppUser.ts` by adding the missing custom-role table and RPC entries to `database.types.ts`. Replace the test mock casts with typed mock builders.
2. **Split near-ceiling production files by responsibility:**
   - `admin.settings.roles.tsx` → custom-roles tab, built-in matrix tab, permission pool picker.
   - `resolveTemplateVariables.ts` → per-domain variable resolvers (tenant/invoice/payment/contract).
   - `resendWebhook.ts` → signature verification, event mapping, status transition.
   - `notifyPaymentSuccess.ts` → recipient/copy building vs dispatch.
   - `TenantsTable.tsx`, `PaymentSidePanels.tsx`, `CreatePaymentDialog.tsx` → columns/filters/form sections.
3. **Split the 12 oversized test files** by scenario group, starting with the two largest.
4. **Audit the `useEffect` usage** in the 16 routes. Move data reads to loader + `useSuspenseQuery` where that applies.
5. **Guards and gates after each step:** clean-code-guard and test-guard, then lint, typecheck, test, and test:sql. Add Arabic doc comments to every function that is moved, then run `graphify update .`.

## Out of scope
No behavior, schema, or UI changes. Generated, vendored, and hand-maintained types files keep their current exceptions.
