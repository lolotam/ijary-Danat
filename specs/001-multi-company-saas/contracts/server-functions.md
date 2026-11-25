# Contract: Server Functions

New and changed server functions, grouped by who may call them. Each lists its guard, input and result. Inputs are validated with Zod. Guards are checked on the server on every call; hiding a control in the screen is never the guard.

## 1. Super admin (`src/platform/`, host `admin.ijary.app`)

Guard for all: signed-in user with an active `platform_admins` row and `aal2`. Every mutating call writes `platform_audit_log`.

| Function | Input | Result | Notes |
|---|---|---|---|
| `platformCreateCompany` | `nameAr`, `nameEn`, `slug`, `firstAdmin { fullName, username, email?, phone? }` | `{ companyId, host, tempPassword }` | Creates company, subdomain row, modules, limits, default roles and permissions, templates, lists, workflows, first admin. `tempPassword` is returned once and never stored in clear. Errors: `SLUG_TAKEN`, `SLUG_RESERVED`, `SLUG_INVALID`. |
| `platformListCompanies` | `status?`, `search?`, cursor | Rows with status, current subscription, usage against limits, health flags | |
| `platformUpdateCompany` | `companyId`, names, branding fields | Updated row | `slug` is not accepted. |
| `platformSetCompanyStatus` | `companyId`, `status`, `reason` | Updated row | `reason` required for `suspended`. |
| `platformSetModules` | `companyId`, `{ [moduleKey]: boolean }` | Current map | Unknown keys rejected. |
| `platformRecordSubscription` | `companyId`, `planName`, `price`, `periodStart`, `renewalDate`, `status`, `note?` | New subscription row | Append-only. |
| `platformSetLimits` | `companyId`, four nullable limits | Limits row | Effective on the next request. |
| `platformListUsers` | `companyId`, cursor | Staff and renter accounts | |
| `platformCreateUser` | `companyId`, account fields, `role` | `{ userId, tempPassword }` | Subject to the staff limit. |
| `platformSetUserActive` | `companyId`, `userId`, `isActive` | Updated profile | Deactivation revokes sessions. |
| `platformResetPassword` | `companyId`, `userId` | `{ tempPassword }` | Forces change at next sign-in. |
| `platformStartSupportSession` | `companyId`, `reason` | `{ url, expiresAt }` | `reason` at least 10 characters. Opens the company host with a 60-minute token. |
| `platformEndSupportSession` | `sessionId` | `{ endedAt }` | |
| `platformOverview` | `from`, `to` | Totals and per-company health | Read-only aggregate functions. |
| `platformAuditLog` | filters, cursor | Entries | |
| `platformSetGatewayLiveAllowed` | `provider`, `allowed` | Flag | Gate for SC-012. |
| `platformAddCustomDomain`, `platformVerifyCustomDomain` | `companyId`, `host` | Domain row | Last phase. |

## 2. Company staff (company host)

Guard for all: signed-in staff of the host's company, the listed permission, and the section switched on.

### Payment gateway — permission `settings.integrations`, section `online_payments`

| Function | Input | Result |
|---|---|---|
| `gatewayList` | — | Connections with `provider`, `mode`, `isActive`, `lastTest`, and `last4` per secret |
| `gatewaySaveCredentials` | `provider`, `mode`, secrets, `publicConfig` | Connection; clears `lastTestOk`; increments `credentialsVersion` |
| `gatewayTestConnection` | `provider` | `{ ok, message }` stored on the connection |
| `gatewayActivate` | `provider` | Connection. Errors: `TEST_REQUIRED`, `LIVE_NOT_ALLOWED` |
| `gatewayDeactivate` | `provider` | Connection |

Refused in a support session: `gatewaySaveCredentials`.

### WhatsApp — permission `settings.integrations`, section `whatsapp`

| Function | Input | Result |
|---|---|---|
| `whatsappStatus` | — | Connections with method, status, number |
| `whatsappStartQr` | — | `{ qr, expiresAt }`; creates the company's instance if absent |
| `whatsappDisconnect` | `method` | Connection |
| `whatsappEmbeddedSignupConfig` | `coexistence: boolean` | Public values the browser SDK needs |
| `whatsappCompleteEmbeddedSignup` | `code`, `phoneNumberId`, `wabaId` | Connection. Error: `NUMBER_IN_USE` |
| `whatsappSaveCloudCredentials` | `phoneNumberId`, `wabaId`, `accessToken` | Connection (manual path) |
| `whatsappActivate` | `method` | Connection; deactivates the other |

### Email — permission `settings.integrations`

`emailSenderStatus` returns `{ mode: "platform_default" | "own", provider?, fromAddress? }`. Existing provider-config functions keep their inputs; secrets now go to `company_secrets`.

### Jobs and notices — any staff

| Function | Input | Result |
|---|---|---|
| `myNotices` | cursor | Own `user_notices` |
| `markNoticeRead` | `noticeId` | — |
| `companyFailedJobs` (permission `workflows.manage`) | cursor | Failed `job_requests` with kind, error, time |
| `retryJob` (permission `workflows.manage`) | `jobRequestId` | New job id; same dedupe key |

### Usage and subscription — admin role

`companyUsage` returns the four limits and current usage. `companySubscriptionBanner` returns `{ renewalDate, daysLeft } | null`.

### Sections — any signed-in user

`myModules` returns the enabled section keys for the caller's company.

## 3. Changed existing functions

| Function | Change |
|---|---|
| `signInWithIdentifier` | Takes the company from the host; searches identifiers within it; refuses when suspended; signs in with the profile's synthetic auth email. |
| `createAppUser`, `updateAppUser`, `deleteAppUser` | Company from the request; uniqueness per company; GoTrue admin calls through a `src/platform/` helper that takes an explicit company. |
| `createPayment` | Uses the company's active `gateway_connections`; stores `gateway_connection_id` and `credentials_version`; refuses when suspended, when no gateway is active, or when the section is off. |
| `enqueueNotification`, `sendNotification` | Insert the notification and a `notification.dispatch` job; return without sending. |
| `sendInvoiceToTenant`, `sendBulkNotification`, `sendCompanyInfo`, `generateInvoices`, `regenerateContractInvoices`, `bulkImport`, `generateElectricityCharges`, `backup`, `restoreBackup` | Validate, enqueue, return `{ jobId }`. |
| `publicBranding` | Branding of the host's company, not the oldest company. |
| `eraseAllData` | Removed from company panels (FR-010). |
| Every function importing `supabaseAdmin` | Uses `companyClient(requireRequestCompany().id)`, or moves under `src/platform/`. |

## 4. Result shape for deferred actions

```ts
type Deferred = { jobId: string; queued: true };
```

The screen shows a short confirmation. Kinds marked "notice" in [jobs.md](./jobs.md) later produce a `user_notices` row with counts (`created`, `skipped`, `failed`) or the error.
