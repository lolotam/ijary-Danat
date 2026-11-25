# PRD — Danat Al Mustaqbal Real Estate Management Platform

**Product name:** Danat Al Mustaqbal Real Estate Management Platform (ERMP)  
**Company:** دانة المستقبل العقارية / Danat Al Mustaqbal Real Estate  
**Version:** 1.1 — Product Requirements Baseline  
**Date:** 14 July 2026  
**Revision 1.1:** Approved platform, portal, migration, payment, and provider decisions  
**Primary UI language:** Arabic (RTL); English (LTR) supported throughout  
**Status:** Draft for stakeholder approval  
**Deployment:** Dokploy on private VPS, Dockerized application and self-hosted Supabase

---

## 1. Executive Summary

ERMP is a bilingual web-first property, lease, billing, collection, payment, reporting, and tenant-portal platform for Danat Al Mustaqbal Real Estate. It serves residential apartments and commercial/investment units, centralizes tenant records and documents, creates monthly obligations, controls overdue accounts, records payments and deposits, produces professional investment-value receipts, and automates compliant communications.

The system has three audiences:

1. **Public visitors** use the corporate landing page and contact form.
2. **Management users** use the secured administration portal to operate properties, tenants, invoices, payments, expenses, reporting, notifications, and permissions.
3. **Tenant users** use a restricted portal to review their own lease and payment history, then pay due months chronologically through MyFatoorah.

### Product goals

- Make collections, outstanding amounts, deposits, expenses, occupancy, contracts, and tenant status visible from one dashboard.
- Eliminate untraceable manual changes by using immutable financial history and audit logs.
- Enforce payment order: overdue balances first, then current and consecutive future months.
- Deliver professional receipts and scheduled reports automatically.
- Support Arabic first while retaining complete English capability for commercial tenants.

### Explicit non-goals for MVP

- Dana-bot, vector database, Ollama, embeddings, and LLM integrations.
- Full general ledger / trial balance accounting engine.
- Sophisticated maintenance/electricity billing until business rules are confirmed.

---

## 2. Scope and Assumptions

### In scope

- Responsive Web application plus native iOS and Android applications in MVP.

- Corporate landing page, video, contact form, chatbot placeholder/integration boundary.
- Admin portal, tenant portal, RBAC, custom permissions.
- Company, property/compound, building, unit, tenant, lease, documents.
- Monthly invoices through the end of the current calendar year, recurring future generation, free periods/discounts, overdue processing.
- Payment tracking, MyFatoorah gateway, payment webhooks, receipts, manual methods, bank deposits.
- Expenses, reports, notification pool, audit logs, settings, backup configuration.
- Arabic/English notification templates and scheduled email/WhatsApp messaging.

### Assumptions needing validation

| ID   | Assumption                                                                                                                           | Impact if wrong                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| A-01 | The product is a responsive web application; React Native is delivered through Expo + React Native Web, not mobile-only React Native | Landing page/admin/tenant portal require browser delivery                |
| A-02 | Supabase self-hosted provides PostgreSQL, Auth, Storage, Realtime, and Edge Functions                                                | Database is PostgreSQL, not MySQL/phpMyAdmin                             |
| A-03 | Tenant logins are created by Admin using username/password and do not require email verification                                     | Requires secure credential reset and session policies                    |
| A-04 | MyFatoorah account supports the selected payment methods in Kuwait                                                                   | Payment methods must be read from enabled gateway methods, not hardcoded |
| A-05 | “قيمة استثمار” is the approved legal/business wording on every commercial receipt                                                    | Must be configurable if residential wording differs legally              |
| A-06 | Admin manages company details in a single-company MVP                                                                                | Schema remains multi-company-ready for future                            |

### Critical technology reconciliation

The requested stack is React Native + TypeScript + self-hosted Supabase. This PRD delivers a responsive Web application and native iOS/Android applications in MVP using **Expo + React Native + TypeScript + React Native Web**. Web-specific components are allowed for printable HTML/PDF, SEO landing content, and gateway browser flows. Supabase uses PostgreSQL; it is not SQL Server/MySQL.

---

## 3. Stakeholders and Personas

| Persona             | Primary needs                                                                       | Permissions                                            |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Super Admin / Owner | Full operational view, settings, approvals, reports                                 | All, including role management and financial reversal  |
| Admin               | Daily property/tenant/contract operations                                           | Assigned management permissions                        |
| Accountant          | Payments, deposits, receipts, expenses, reports                                     | Financial permissions, no unrestricted system settings |
| Collector           | Follow-up on overdue accounts and manual reminders                                  | Tenant, invoice, communication permissions as assigned |
| Read-only           | View assigned reports/data                                                          | No write access                                        |
| Tenant              | See only own lease, invoices, payment history, allowed receipts, and payment action | Own tenant portal data only                            |

---

## 4. Success Metrics

- 100% of active eligible leases produce the correct monthly obligation once per billing period.
- 100% of payment changes are traceable to a user, provider webhook, timestamp, and original record.
- No tenant can view another tenant’s records through the portal.
- Monthly report totals reconcile with approved payments, deposits, and expense records.
- At least 95% of eligible scheduled notifications are dispatched successfully or appear in a retry/failure queue.
- Admin can identify overdue tenants, value, aging, and last notification without exporting data.

---

## 5. Navigation and Localization

### Public navigation

- Home, About, Properties/Services (if enabled), Contact, language selector.
- Admin login link is placed in the footer as requested.

### Management navigation

- Dashboard
- Monthly Rent Invoices
- Tenants
- Properties & Buildings
- Units
- Contracts
- Payments
- Deposits
- Expenses
- Reports
- Notification Pool
- Audit Log
- Users, Roles & Permissions
- Company & System Settings

### Tenant portal navigation

- My Dashboard
- My Lease
- My Invoices / Payment Schedule
- My Payments
- My Receipts (subject to admin visibility setting)
- Pay Now
- Profile / password change

### Bilingual behavior

- Arabic is default with RTL menu on the right.
- English changes all layouts to LTR with navigation on the left.
- Tenant profile stores `preferred_language` and notifications use the matching Arabic/English template.
- User-entered legal/company values may be stored in Arabic and English fields where required.

---

## 6. Functional Requirements

### 6.1 Landing Page

| ID     | Requirement                                                                                            | Priority |
| ------ | ------------------------------------------------------------------------------------------------------ | -------- |
| LP-001 | Show company logo, Arabic/English company name, navigation and brand colors derived from uploaded logo | Critical |
| LP-002 | Provide Hero section, company value proposition, responsive imagery/mockups and introductory video     | High     |
| LP-003 | Provide chatbot integration placeholder with configurable provider/embed                               | Medium   |
| LP-004 | Provide contact form with name, phone, email, subject/message, consent and anti-spam controls          | High     |
| LP-005 | Show email, Facebook and Instagram in footer; show Admin login link                                    | Critical |
| LP-006 | Store contact submissions and notify designated company recipients                                     | High     |

**Acceptance criteria:** landing page is responsive, Arabic-first, bilingual, SEO metadata is editable, and a contact submission creates a lead record plus an auditable notification event.

### 6.2 Company Management

- Store company name in Arabic and English, logo, mobile numbers, email, address, map/location, IBAN/bank details, social links, invoice footer text and brand colors.
- Add `max_visible_unpaid_invoices` setting (allowed values: 5, 6, 10, or validated custom positive integer) to control the maximum number of unpaid invoices visible in each tenant portal.
- Generate a company information PDF with logo header and share/download/print actions.
- Allow Admin to select any stored company document and send it by WhatsApp or email.
- Company details are used in receipts, reports, email templates and landing page.

### 6.3 Property, Building and Unit Management

**Terminology decision:** `Property/Compound` is the top-level asset; `Building` can be a physical building/complex; `Unit` is an apartment, shop, office or commercial space. The UI may label these according to the business vocabulary.

| Entity            | Required data                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Property/Compound | auto code, Arabic/English name, type, location/address, area, description, image, status, documents                                |
| Building          | auto code, parent property, Arabic/English name, commercial sector/category, location, area, image, status, document library       |
| Unit              | auto code, property/building, unit number/name, type, area, occupancy status, electricity meter ownership, default rent, documents |

- Building categories are Admin-managed settings: restaurants/cafes, retail/perfume/clothing/children goods, health clubs, groceries, telecom companies, and custom categories.
- Unit statuses: Available, Reserved, Occupied, Vacant, Under Maintenance, Archived.
- Unit form includes `electricity_meter_ownership` dropdown only: `company_owned` (ملك للشركة) or `tenant_owned` (ملك للعميل/المستأجر). Electricity billing, readings, and management are explicitly out of MVP.
- If a unit is occupied, tenant linking is shown only through an active contract; the add-unit screen must not create an inconsistent direct relationship.
- All property/building/unit tables support server-side search, pagination, date filters, column filters, CSV/XLSX export and validated import.
- Dedicated property/building and unit pages show header summary, documents, active/previous leases, payment/invoice history, status timeline and related entities.

### 6.4 Tenant Management

#### Tenant fields

| Field group       | Fields                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Identity          | immutable auto-generated tenant code, name, mobile, email, nationality, preferred language                                   |
| Classification    | tenant category: VIP, Uncommitted, Chronically Distressed, custom tags; lifecycle: Active, Inactive, Contract Ended, Blocked |
| Commercial tenant | commercial name, authorized manager, owner; all optional                                                                     |
| Contacts          | mobile, WhatsApp number, email, alternate contacts                                                                           |
| Preferences       | reminders switch, receipt visibility switch, notification language, preferred channel                                        |
| Relations         | current and historical contracts, property/building/unit shown through contracts                                             |

- Tenant code format is configurable; initial format: `DANA-{sequential_number}`, e.g. `DANA-123456`.
- Code is created atomically at tenant creation, is unique, immutable and never reused.
- Reminder switch controls automatic email/WhatsApp reminders for this tenant; it must not erase history.
- Tenant documents support: Civil ID, Commercial License, Power of Attorney, Authorized Signature, Contract, Payment Evidence, Other.
- Tenant fields include `tenant_portal_enabled` and `receipt_visible_to_tenant`, both controlled by Admin.
- Files are private; storage paths use immutable IDs, not raw display names, e.g. `companies/{company_id}/tenants/{tenant_id}/documents/{file_id}`.
- Dedicated tenant page has a top header summary and tabs: Profile, Contracts, Invoices, Payments, Receipts, Documents, Notes, Communication, Audit History.

### 6.5 Contracts and Lease Logic

- Contract types: `Investment Contract` and `Lease Contract`.
- Contract duration selection supports 1, 2, 3 years and custom months/years.
- End date is calculated automatically from start date and duration; Admin may override only with a mandatory reason and audit log.
- Store entry date, contract start/end, recurring amount, due-day policy, grace period, deposit, discount/free period, renewal/termination and document attachments.
- Free period is a dedicated `Concession / Free Period` entity, not a simple contract field. At contract/tenant creation, Admin may select 0 free months (default, no concession) or enter/select any positive count. The system calculates end date from selected start date. It also supports percentage or fixed discount over a defined period. The billing engine must create zero/discounted invoice line items rather than omit history.
- Contract can be Active, Frozen, Suspended, Expired, Renewed, Terminated or Draft.
- Frozen/Suspended contracts do not generate new invoices or notifications unless Admin explicitly selects a policy override.
- Automated expiry reminders are configurable at 4, 3, 2 and 1 months before expiry, per channel and language template.

### 6.6 Invoice Engine and Monthly Cards

- Generate all eligible monthly rent/investment invoices from current month to 31 December of the current year after contracts are approved; use idempotency keys to prevent duplicate invoices.
- Continue generating future invoices by scheduled job, configurable rolling horizon.
- Dashboard shows a card for each month. Clicking a card opens a monthly invoice table grouped by building header, then invoices under each building.
- Invoice states: `Due` (مستحقة الدفع), `Overdue` (متأخرة/منتهية حسب approved wording), `Paid`, `Partially Paid`, `Cancelled`, `Waived`.
- Company Settings contains overdue day and/or grace policy. The scheduled job marks unpaid eligible invoices Overdue, changes visual badge to red, and triggers dashboard alarm/attention state.
- Manual WhatsApp actions must be available from overdue invoices, subject to permission and tenant reminder policy.
- Invoices hold immutable issue date, due date, period month, total, paid, balance, currency, state and invoice items.
- Invoice form includes `is_visible_to_tenant`. A hidden invoice is excluded from tenant portal visibility and payment selection. Admin can independently override visibility per invoice without changing financial history.

### 6.7 Payments, Payment Ordering and Receipts

#### Manual payments

- Admin records account type: Commercial Account or Personal Account.
- Methods: Payment Link, Bank Transfer, Cheque, Cash; KNET may appear as gateway/manual method where applicable.
- Store amount, date, method, reference, unit, tenant, invoices/periods, attachment (PDF/image), note, creator and approval state.
- Payment can cover partial month, one full month or multiple months.
- Allocation updates invoice state immediately: Paid, Partially Paid or Overdue where applicable.
- No payment is deleted. Corrections create a reversal record linked to original payment, reason, actor and timestamp.

#### Tenant portal ordering rule

1. Every overdue unpaid/partially-paid month must be selected and cleared before later months become payable.
2. After overdue balance, the tenant can select current month and future months only in consecutive order.
3. A future-month payment control remains disabled until every prior invoice in the sequence is selected/paid or waived.
4. The backend—not frontend alone—enforces sequence and recalculates eligible invoices at payment-request creation.
5. Admin can create a documented exception only if granted `payments.override_chronological_order` permission.

#### MyFatoorah integration

- Create payment request only after server validates tenant session, selected invoices, amount, order, and current outstanding balances.
- The configured online methods are KNET, Apple Pay and Google Pay through MyFatoorah. The application retrieves enabled methods from the merchant account and shows only eligible methods. UI may prefer Apple Pay on compatible Apple devices and Google Pay on compatible Android/desktop environments, but final availability is determined by MyFatoorah and merchant configuration.
- Store provider invoice/payment IDs, payment URL, request payload summary, status transitions, gateway response and webhook events.
- Treat redirect success as non-authoritative; webhook and/or provider status verification must confirm payment before marking invoices paid.
- Webhook requests must verify signature/authenticity, be idempotent, log raw-safe event metadata, and reject replay/invalid requests.

#### Receipt requirements

- Create one professional PDF receipt per successful payment transaction, listing every paid month and total.
- Receipt header: company logo and clear Arabic wording **“قيمة استثمار”**.
- Receipt body must never say “قيمة إيجار” or “عن قيمة إيجار”; use approved phrase **“قيمة استثمار”** and note **“قيمة استثمار للوحدة”**.
- Footer: company address, telephone, location and company name.
- Do not print the word “توقيع”; leave designated signature area blank.
- Tenant can download/print receipt, and can see it only if `receipt_visible_to_tenant` is enabled for that tenant/payment policy.
- Admin can download, print and resend the stored receipt through WhatsApp/email.
- On successful payment, receipt is automatically queued for WhatsApp and email when channels, consent, and templates allow.

### 6.8 Expenses

- Expense classes: Contractual Monthly/Annual, Regular Recurring, Sudden One-Time.
- Categories include security, cleaning, maintenance, fire services, lifts and configurable custom categories.
- Store supplier/payee, amount, currency, property/building/unit/cost-center link, start/end dates, recurrence, approval, attachments, notes and status.
- Expenses appear in budget and expense reports but do not alter rent invoice balances.

### 6.9 Bank Deposits

- Deposit form: date, bank, amount, note, proof document (PDF/image), creator and status.
- Deposit listing supports filters and total amount footer.
- Reports compare collections, manual payments and deposits without assuming they are automatically reconciled.

### 6.10 Reports and Budget

- Required reports: custom/sample report, tenant report, payment report, expenses, deposits, overdue aging, property status, tenant status, monthly/weekly/daily/yearly management report.
- Every report supports date range (`from`, `to`), relevant entity/status filters, print view and XLSX/CSV/PDF export where appropriate.
- Scheduled daily/weekly/monthly/yearly management report is sent by **email only** using an Arabic/English HTML+CSS table template.
- Scheduled report includes: paid rents for period, collected total, bank deposits, overdue tenants, property/rent status and tenant status.
- Budget module aggregates collections, deposits and expenses by selected date/property/building/category. Accounting-grade ledger is a later phase.

### 6.11 Notification Pool and Communications

- Notification Pool shows all outbound messages in filterable tables: tenant, invoice/contract if related, language, channel (WhatsApp/Email/Both), template, scheduled time, sent time, provider ID, state, failure reason and retry count.
- Notification templates exist in separate Arabic and English forms with equal variables/data model.
- Channels: SMTP, Resend, WhatsApp Official API; Admin can configure and enable/disable each provider and notification rule.
- Notification types: due reminder, overdue reminder, receipt, contract expiry, scheduled report, document sending, manual message.
- A manual document-send action can send a selected private document to an explicitly selected recipient after permission and confirmation.
- All proactive WhatsApp messages require documented opt-in and approved templates; do not send when tenant reminder switch is off.

### 6.12 Audit Log

- Audit events include login, logout, failed login, CRUD operations, imports, exports, print/download/send receipt, payment processing, payment reversal, invoice changes, building/unit/tenant changes, role/permission changes, setting changes, webhook events and system jobs.
- Audit record fields: actor/user or system, role, action, entity type/id, endpoint/method, IP, user agent, request correlation ID, safe before/after changes, timestamp, result, error code.
- Secrets, passwords, full payment card data, provider tokens and unnecessary PII are never logged.
- Audit logs are append-only for application users and filterable/exportable only to authorized roles.

### 6.13 Users, Roles and Permissions

- Seed roles: Admin, Accountant, Collector, Read-only, Customer/Tenant.
- Admin can create management roles and assign granular feature/action permissions.
- Permission naming pattern: `{module}.{action}`, e.g. `tenants.create`, `payments.reverse`, `reports.export`, `notifications.send`, `portal.enable`, `payment_links.create`.
- Permissions protect UI, API/edge-function endpoints, data queries, exports, document access and background actions; hiding a button alone is insufficient.
- Admin can activate/disable a role, user, feature and tenant portal/payment link eligibility.
- Users are created from Admin dashboard using username and password; no email verification is required. Password reset must be Admin-initiated or use a secure controlled recovery process.
- Tenant portal user maps to exactly one tenant identity unless a future approved household/company-contact model is enabled.

### 6.14 Settings, Backups and Operations

- Company details, invoice/receipt numbering, due/overdue policy, currencies, notification providers, templates, schedules, MyFatoorah credentials, branding and building categories.
- Daily database backup and file/storage backup; backups encrypted and stored outside the primary VPS.
- “Full system backup” means infrastructure/configuration backup plan plus persistent volumes; it must not expose secrets in archives.
- Restore drills are logged and scheduled; backup completion alone is not acceptance evidence.
- Dokploy deploys versioned Docker images/services. App uploads must persist in Supabase Storage or a mounted/S3-compatible volume, never the ephemeral application container filesystem.

### 6.15 Electricity Management

**Phase status: navigation placeholder only; no MVP implementation.** Electricity Management appears in the Navigation Sidebar as a disabled/Coming Soon feature. The only MVP data point is the Unit form dropdown `electricity_meter_ownership`: ملك للشركة or ملك للعميل/المستأجر. No electricity readings, consumption, charges, invoices, reports, or workflows are included.

### 6.16 Dana-bot (Future)

**Out of MVP.** Future Dana-bot may use self-hosted Ollama, embeddings, vector search and configurable OpenAI/Anthropic/OpenRouter providers. It must be permission-aware, retrieve only tenant/company scoped information, never expose secrets, log prompts/actions, require approval for mutations, and avoid direct unrestricted database access.

---

## 7. Core Data Model

| Table / collection                       | Essential fields                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| companies                                | id, names, logo, contacts, address, iban, locale, timezone, max_visible_unpaid_invoices                           |
| users / profiles                         | auth_user_id, username, display_name, role/status, tenant_id nullable                                             |
| roles, permissions, role_permissions     | name, scope, module/action, enabled                                                                               |
| properties, buildings, units             | codes, parent IDs, names, type/category, area, status, electricity_meter_ownership                                |
| tenants                                  | code, type, names, contacts, language, status, reminder_enabled, tenant_portal_enabled, receipt_visible_to_tenant |
| tenant_documents                         | tenant_id, type, storage_path, mime, size, access level                                                           |
| contracts                                | tenant_id, unit_id, type, dates, duration, amount, due policy, state                                              |
| concessions                              | contract_id, type, free_months, percentage/fixed discount, start/end, reason, status                              |
| invoices, invoice_items                  | contract_id, period, due date, totals, balance, state, is_visible_to_tenant, idempotency key                      |
| payments, payment_allocations, reversals | source, method, provider refs, amount, status, allocation, reverse reason                                         |
| receipts                                 | payment_id, receipt number, PDF path, visibility, sent state                                                      |
| expenses, deposits                       | classification, dates, amount, attachment, related asset, status                                                  |
| communications, templates, rules         | channel, locale, template, payload hash, provider result, retry count                                             |
| audit_logs, webhook_logs, job_logs       | actor, action, trace ID, safe payload, status/error                                                               |
| report_schedules, generated_reports      | schedule, recipients, locale, output path, state                                                                  |
| contact_leads                            | landing page submissions, consent, status, owner                                                                  |

### Data integrity rules

- Use UUID primary keys for externally referenced records; human codes are separate unique fields.
- Monetary fields use `numeric(14,3)` for KWD; never floating point.
- Invoice/receipt code uniqueness is enforced by database indexes.
- Row Level Security is mandatory for tenant portal data and all tenant-facing Storage objects.
- Storage uses IDs in paths and database metadata for display names; sanitize uploads and restrict MIME/size.

---

## 8. Automation Workflows

### WF-01 — Invoice generation

1. Scheduled server job finds Active contracts eligible for a billing period.
2. It applies free period/discount/concession rules and creates invoice + items idempotently.
3. It logs result; failures enter retry/alert workflow.
4. Dashboard monthly card data updates.

### WF-02 — Overdue evaluation

1. Daily job evaluates Due/Partially Paid invoices against due day and grace policy.
2. Eligible balances change to Overdue; visual alert appears.
3. System checks tenant/contract/invoice reminder suppression.
4. Allowed reminders are queued; no external sending occurs directly in the scheduler.

### WF-03 — Payment gateway

1. Tenant selects permitted sequential invoice periods.
2. Edge Function validates tenant identity, ordering, amounts and current states.
3. It creates MyFatoorah request and stores pending transaction.
4. User redirects to hosted/embedded gateway payment flow.
5. Verified webhook updates payment state idempotently.
6. Allocation marks invoices Paid/Partially Paid, stores receipt, queues permitted receipt notifications.

### WF-04 — Contract expiry

1. Daily job identifies contracts at configured 4/3/2/1 month thresholds.
2. It selects language/channel/template based on tenant and settings.
3. It queues notification and logs dispatch outcome.

### WF-05 — Scheduled reports

1. Daily/weekly/monthly/yearly job generates data snapshot and branded HTML email.
2. It sends to configured internal recipients only.
3. It logs generation, delivery, errors and file artifact when created.

### WF-06 — Historical Excel Data Migration

1. The existing Excel workbook is treated as the source archive and is retained unchanged.
2. An Admin/data-entry team manually creates properties, buildings, units, tenants, and active contracts in dependency order.
3. The team records opening balances, contract dates, and historical payment records from Excel as required by approved cutover scope.
4. A designated company data owner validates each batch against Excel totals and signs off before production activation.
5. Import/Export remains available for future operations, but the initial migration is manual to prevent incorrect entity relationships or historical financial mapping.

### WF-07 — Upload management

1. Admin creates tenant/property/building entity.
2. Storage namespace is available using its immutable UUID.
3. Upload policy validates type/size, stores file privately, writes metadata/audit event.
4. Optional document notification is an explicit user action; documents are not automatically disclosed.

---

## 9. API and Edge Functions

| Area            | Endpoint/function examples                                       | Security                                                      |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| Tenant portal   | `GET /tenant/me`, `GET /tenant/invoices`, `GET /tenant/receipts` | Supabase JWT + RLS tenant scope                               |
| Payment request | `POST /functions/v1/create-payment`                              | JWT, ordering validation, rate limit, idempotency key         |
| Payment webhook | `POST /functions/v1/myfatoorah-webhook`                          | Provider verification, replay protection, IP/signature policy |
| Admin actions   | `/api/v1/tenants`, `/contracts`, `/invoices`, `/payments`        | Admin JWT + permission checks                                 |
| Documents       | signed URL function / secure download route                      | Entity permission + short TTL                                 |
| Reports         | report generation/export endpoints                               | permission + async job + audit log                            |
| Notifications   | send/retry endpoints                                             | permission, opt-in/template validation                        |

All APIs return a consistent error envelope, correlation ID, and no sensitive internal stack traces. API schema is documented in OpenAPI before integration testing.

---

## 10. UI/UX Requirements

- Modern real-estate brand design based on supplied company logo; final tokens are derived after logo upload.
- Desktop-first Admin tables, responsive mobile layouts, loading/empty/error states, confirmation dialogs for sensitive actions.
- Every table: numbered row column, global search, pagination, date filter, all relevant column filters, import, export XLSX/CSV, printable report route where meaningful.
- Detail pages use top summary header with linked entity breadcrumbs and history/timeline below.
- Status uses text + icon + accessible color badge; Overdue uses red badge and configured alert animation without relying on flashing alone for accessibility.
- Tenant portal payment sequence explains why a later month is locked and highlights overdue months first.
- Apple Pay/Google Pay presentation is capability-aware but never promises availability; gateway-enabled methods control final UI.

---

## 11. Security and Privacy Requirements

- HTTPS-only, secure cookies, short session lifetimes for Admin and tenant portal, login throttling, password hashing.
- Tenant portal uses RLS and server-side validation; client IDs from URL/request never determine authorization alone.
- Self-hosted Supabase Studio, database and storage admin endpoints must not be exposed publicly without restrictive access controls.
- Secrets stored in Dokploy environment variables/secrets, never client bundle, logs, source code or exports.
- Edge Functions use service-role credentials only server-side.
- Validate upload MIME/signature, size, filename; store private; scan if anti-malware service becomes available.
- Webhooks verify authenticity and are idempotent.
- Financial records require audit logs; payment reversal requires reason and permission.
- Exports containing PII are permission-controlled and audited.

---

## 12. Non-Functional Requirements

| Area          | Requirement                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Performance   | Common Admin list/dashboard views target under 3 seconds at expected scale; reports/PDFs/notifications run asynchronously               |
| Reliability   | Background jobs retry with exponential backoff; failed jobs visible and alertable; invoice creation is idempotent                       |
| Availability  | Separate Dokploy services for frontend/API, worker/scheduler, Supabase dependencies; health checks required                             |
| Scalability   | Pagination, indexed PostgreSQL queries, object storage, queue-based external calls                                                      |
| Observability | Structured logs, error monitoring, webhook/job logs, request correlation IDs, dashboard health indicators                               |
| Accessibility | RTL/LTR, keyboard basics, semantic labels, contrast, non-color-only status                                                              |
| Compliance    | WhatsApp consent/template policy, data retention policy, local legal wording and invoice requirements approved by company/legal advisor |

---

## 13. Test Plan and Acceptance Scenarios

### Critical scenarios

| ID        | Scenario                                            | Expected result                                                                              |
| --------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| TC-INV-01 | Scheduler runs twice for same month                 | Only one invoice exists per contract/period                                                  |
| TC-INV-02 | Invoice crosses due+grace date unpaid               | State becomes Overdue, dashboard alert appears                                               |
| TC-PAY-01 | Tenant has unpaid June and selects August           | Backend blocks request and returns required June first                                       |
| TC-PAY-02 | Tenant pays June + July + August sequentially       | Gateway request includes only validated amounts; allocation succeeds after verified webhook  |
| TC-PAY-03 | Gateway redirect says success but webhook is absent | Invoice remains pending/unpaid until verified provider status                                |
| TC-PAY-04 | Partial payment recorded                            | Invoice becomes Partially Paid with correct remaining balance                                |
| TC-PAY-05 | Payment reversed                                    | Original remains visible; reversal is linked, audited, and balances recalculate              |
| TC-REC-01 | Successful payment                                  | Correct Arabic/English receipt PDF lists periods and uses “قيمة استثمار” wording only        |
| TC-RLS-01 | Tenant changes request tenant ID                    | Cannot access another tenant’s data/documents/receipts                                       |
| TC-NOT-01 | Reminder switch off                                 | No automatic notification is queued; audit/history remains intact                            |
| TC-NOT-02 | Invalid WhatsApp opt-in/template state              | System blocks proactive send and records actionable reason                                   |
| TC-IMP-01 | Invalid CSV import                                  | Preview identifies errors; no partial destructive import without explicit transaction policy |
| TC-BKP-01 | Restore drill                                       | Backup restores into isolated environment and passes integrity checks                        |

### Definition of Done for every module

- Approved requirements, UX state designs, user stories and acceptance criteria.
- Database migration/RLS/policies reviewed; indexes and constraints present.
- Frontend, Edge Functions/API and error states implemented.
- Permission enforcement verified at UI and backend layers.
- Unit, integration and feature tests pass; critical flows have regression coverage.
- Audit events, operational logs, monitoring and failure handling implemented.
- Arabic/English and RTL/LTR review completed.
- Documentation, environment variables and deployment notes updated.
- Product-owner UAT approval recorded.

---

## 14. Delivery Phases

| Phase | Scope                                                                                                    | Priority |
| ----- | -------------------------------------------------------------------------------------------------------- | -------: |
| 0     | Brand assets, process validation, legal wording, payment/WhatsApp account readiness, data import samples | Critical |
| 1     | Dokploy/Docker, self-hosted Supabase, Auth/RBAC, company settings, localization foundation               | Critical |
| 2     | Properties, buildings, units, categories, document storage, tenants, contracts                           | Critical |
| 3     | Invoice engine, monthly cards, free periods/discounts, payment records, PDF receipts                     | Critical |
| 4     | Tenant portal, chronological payment flow, MyFatoorah, verified webhooks                                 | Critical |
| 5     | Notifications, notification pool, contract expiry, reports and audit log                                 | Critical |
| 6     | Expenses, deposits, budget dashboard, data import/export hardening                                       |     High |
| 7     | Electricity billing rules, maintenance, accounting readiness                                             |     High |
| 8     | Dana-bot / vector search / AI insights                                                                   |   Medium |

---

## 15. Deployment Requirements

### Required repository deliverables

- `Dockerfile` for Expo Web/frontend or deployed static bundle as applicable.
- `docker-compose.yaml` / Dokploy compose configuration for application services and integration network.
- `.dockerignore`, `.env.example`, environment validation script.
- Supabase self-hosted Compose configuration/overrides, persistent volumes, backup scripts, Edge Function source.
- Nginx/reverse-proxy configuration, security headers and HTTPS routing.
- CI pipeline: lint, typecheck, tests, build, migration checks, container build.

### Persistence rules

- Postgres and Supabase Storage volumes are persistent and backed up.
- Uploaded tenant/property files do not live in frontend container filesystems.
- All uploads use private buckets/path policies and metadata records.
- Dokploy binding/volumes are documented per environment: staging and production.

---

## 16. Open Decisions Before Development

1. **Resolved:** MVP delivers responsive Web plus native iOS and Android applications using Expo/React Native and TypeScript.
2. **Resolved:** “قيمة استثمار” is required for every receipt; business/legal owner must confirm final compliance before production.
3. What exact day/grace policy turns each invoice Overdue: one global day, per contract day, or both?
4. How are partial payments treated for reminders: continue reminder, pause reminder, or configurable?
5. **Resolved:** Admin chooses 0 or more free months at tenant/contract creation; the free period creates a documented zero/discounted invoice item rather than deleting history.
6. **Resolved target methods:** KNET, Apple Pay and Google Pay. Merchant account/domain activation and device eligibility remain required before go-live.
7. **Resolved provider strategy:** Meta WhatsApp Cloud API Direct is primary; 360dialog or an official Kuwait Meta Solution Partner is fallback. Opt-in text, templates, sender number and escalation rules remain required inputs.
8. **Resolved:** tenant, unit/building, dates/balances, and payment history exist in Excel. Initial migration will be manual with designated company data-owner validation and Excel reconciliation.
9. **Resolved:** Sales Report is replaced by Payment Report. “Sample/custom report” definition and columns remain to be approved.
10. **Resolved:** Electricity Management is sidebar placeholder only. MVP contains only unit-level meter ownership dropdown: company-owned or tenant-owned.
11. **Resolved:** Tenant users view their full profile/lease Hero section, permitted invoices, payments and permitted receipts, then pay sequentially. Profile-edit permissions remain disabled unless later approved.
12. **Open:** Define retention periods for civil IDs, commercial documents, contracts, payments, audit logs, and backups with company/legal owner.

---

## 17. Reference Integration Notes

- MyFatoorah payment methods must be driven by methods enabled on the merchant account. Hosted payment creation returns a payment URL, and payment status needs provider verification rather than trusting a browser redirect.
- WhatsApp automated proactive messaging must follow opt-in and approved template requirements.
- This project uses TypeScript across React Native/React Native Web and Supabase Edge Functions, with strict typing and automated type checks.

---

## 18. Version 1.1 Change Log

| ID     | Approved change                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V11-01 | MVP now explicitly includes responsive Web plus native iOS and Android applications.                                                                              |
| V11-02 | Sales Report renamed and replaced by Payment Report.                                                                                                              |
| V11-03 | Added company setting `max_visible_unpaid_invoices` with 5, 6, 10 and custom validated limit.                                                                     |
| V11-04 | Added `invoices.is_visible_to_tenant` and Admin invoice-form control.                                                                                             |
| V11-05 | Added `tenants.tenant_portal_enabled` and `tenants.receipt_visible_to_tenant`.                                                                                    |
| V11-06 | Added `units.electricity_meter_ownership` with only company-owned/tenant-owned values; electricity module is navigation placeholder only.                         |
| V11-07 | Replaced simple free-period field with dedicated `concessions` entity supporting zero or more free months and discounts.                                          |
| V11-08 | Confirmed MyFatoorah target online methods: KNET, Apple Pay, Google Pay.                                                                                          |
| V11-09 | Confirmed WhatsApp primary provider: Meta Cloud API Direct; fallback: 360dialog or official Kuwait Meta Solution Partner.                                         |
| V11-10 | Confirmed existing Excel source includes tenants, units/buildings, dates/balances and payment history; initial migration is manual and reconciled.                |
| V11-11 | Expanded Tenant Portal: Hero section with tenant/lease details; visible-unpaid-invoice cap; per-invoice visibility; backend-enforced chronological payment order. |

## 19. Data Migration Plan

### Source data

The existing Excel workbook contains tenant information, buildings and units, contract dates, current balances, and payment history. It remains the source archive during migration.

### Manual migration sequence

1. Freeze a dated copy of the Excel workbook before cutover.
2. Define and approve cutover date, historical period to enter, and required opening balances.
3. Manually create property/compound, building, and unit hierarchy.
4. Manually create tenants and validate generated `DANA-` codes.
5. Manually create active contracts and concessions/free periods.
6. Enter opening balances and, if approved, historical payments in chronological order.
7. Reconcile tenant count, active contract count, total outstanding balance, total historical collections and deposit figures against Excel.
8. Company data owner signs a migration reconciliation report.
9. Activate invoice generation and live collection only after reconciliation approval.

### Migration acceptance criteria

- Every active tenant in the agreed Excel scope maps to one correct active contract and unit.
- No unit has conflicting active contracts unless a documented business exception exists.
- Sum of opening balances equals the signed Excel reconciliation total.
- Sampled payment records match Excel date, amount, method and tenant.
- Excel source archive is read-only and retained according to approved retention policy.
