# TestSprite Backend Target Allowlist

Use this file as the direct HTTP API contract when configuring TestSprite. It
prevents the test generator from treating TanStack Start server-function names
as public URL paths.

## Direct HTTP targets

| Method | Path                             | TestSprite authentication                                                                                    | Valid test targets                                                                       |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `POST` | `/api/public/cron`               | `Authorization: Bearer <CRON_SECRET>`                                                                        | Authorization, JSON validation, the four job names, idempotency                          |
| `POST` | `/api/public/myfatoorah-webhook` | No Basic Authentication. Send an HMAC signature in `MyFatoorah-Signature` or an accepted alternative header. | Missing secret, invalid signature, ignored event, duplicate event, successful settlement |

No other project-owned HTTP API routes are registered.

## Do not create tests for these URL patterns

The following are TanStack Start `createServerFn` operation names, not public
REST paths. Do not send requests such as `POST /generateInvoices` or
`POST /createPayment`; they return the application HTML `404` page by design.

```text
applyAllocation
backfillContractInvoices
bulkImport
confirmGatewayPayment
contractExpiryJob
createAppUser
createPayment
deleteAppUser
dispatchNotification
eraseAllData
evaluateOverdue
generateElectricityCharges
generateInvoices
getPublicBranding
getPublicSupabaseConfig
logAudit
notifyDepositConfirmed
notifyPaymentSuccessFn
resendGeneratedReport
resolveMapEmbed
reversePayment
runReportSchedule
scheduledReportsJob
sendNotification
sendTenantCredentials
setInvoicePaid
submitContactInquiry
submitLeasingInquiry
updateAppUser
```

Test these operations through their corresponding browser route or through the
Vitest suite. Protected operations expect a Supabase JWT as a Bearer token when
invoked programmatically; they do not implement Basic Authentication.

## Credential configuration

| Test type                | Authentication setup                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Frontend browser journey | `None / No Authentication`; enter staff or tenant credentials in `/auth` or `/portal/auth` and retain the resulting browser session |
| Cron API                 | Bearer token containing `CRON_SECRET`, not an email/password Base64 value                                                           |
| Webhook API              | No Basic Authentication; construct the HMAC from the exact raw request body and `MYFATOORAH_WEBHOOK_SECRET`                         |
| Server-function behavior | Do not call a guessed path; use frontend flow or Vitest                                                                             |

## Producer dependency map

Producer-dependent tests must create IDs through the application flow or an
isolated database fixture. Do not add unauthenticated producer endpoints to
production solely for testing.

| Required ID           | Safe producer                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `contract_id`         | Create property, unit, tenant, then an active contract through `/admin/contracts`                             |
| `payment_id`          | Create a manual payment through `/admin/payments` or complete a sandbox payment flow                          |
| `notification_id`     | Send a notification through `/admin/inbox` or notification settings workflow                                  |
| `report_schedule_id`  | Create a report schedule through `/admin/reports`                                                             |
| `generated_report_id` | Run the created schedule through `/admin/reports` or the scheduled-report job in an isolated test environment |

## Current deployment prerequisites

| Requirement                    | State required before expected-success test                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Cron success cases             | A non-empty `CRON_SECRET` in the deployment and the same value sent as Bearer token                                 |
| Webhook success cases          | A non-empty `MYFATOORAH_WEBHOOK_SECRET` in the deployment plus a valid HMAC signature                               |
| Webhook invalid-signature case | A non-empty `MYFATOORAH_WEBHOOK_SECRET`; otherwise the endpoint correctly returns `503` before signature validation |
| Payment success cases          | MyFatoorah sandbox credentials, payment request, and matching database records                                      |
