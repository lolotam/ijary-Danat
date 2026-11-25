# Feature Specification: IJARY Multi-Company SaaS Conversion

**Feature Branch**: `001-multi-company-saas` (spec directory only; no git branch was created)

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Convert the single-company Danat estate rental platform into IJARY, a multi-company SaaS: a super admin who creates companies and users, shows and hides sections per company and tracks subscriptions; a payment gateway section and a WhatsApp connection per company; complete separation between companies; slow operations moved to a background worker; custom domains and landing pages last."

**Terminology**: *Company* is a customer of the platform (a real-estate business). *Renter* is the person who rents a unit from a company (called "tenant" in the existing code). *Staff* are a company's employees who use the admin panel. *Super admin* is the platform owner's account. The word "tenant" is never used for a company.

## User Scenarios & Testing *(mandatory)*

The stories are ordered by the delivery order agreed with the owner. Stories 1 and 2 are the foundation; no second company may be onboarded before Story 1 passes.

### User Story 1 - A company's data is invisible to every other company (Priority: P1)

Staff and renters of one company work in the platform as if it were theirs alone. Whatever they open, search, export, download or receive by message belongs to their company only. Nothing they do can read or change another company's records, files, messages, settings or documents, even by guessing links or identifiers.

**Why this priority**: The platform cannot hold a second company without it. Today no rule separates staff by company, so this is a security prerequisite, not an enhancement.

**Independent Test**: Create two companies with similar data. Sign in as each role of company A and attempt to read, change, export and download every kind of record and file of company B, through the screens and directly. Every attempt returns nothing or is refused.

**Acceptance Scenarios**:

1. **Given** companies A and B each have properties, renters, contracts, invoices and payments, **When** a staff member of A opens any list, report, search or export, **Then** only A's records appear and all totals count A's records only.
2. **Given** a staff member of A knows the identifier or link of a record or file of B, **When** they request it directly, **Then** the request is refused and nothing about B is revealed, including whether the record exists.
3. **Given** a renter of A is signed in to the portal, **When** they view invoices, contracts, receipts or messages, **Then** they see only their own records inside A.
4. **Given** both companies have scheduled work due (overdue evaluation, reminders, reports), **When** it runs, **Then** each company's run uses only that company's data, branding and sender, and a failure in A's run does not stop B's.
5. **Given** company A issues its first invoice, payment, receipt and contract, **When** the documents are numbered, **Then** numbering starts from A's own sequence and is unaffected by B's documents.

---

### User Story 2 - Slow work happens in the background (Priority: P1)

A staff member who sends an invoice, imports a file, generates a year of invoices or requests a data export gets an immediate confirmation and keeps working. The slow part (sending email and WhatsApp, building PDF files, bulk processing, syncing, backing up) runs behind the scenes. When a long job finishes or fails, the person who started it is told inside the panel.

**Why this priority**: Staff currently wait on sending and document generation inside each action, and every later story (per-company messaging, gateways, sync) adds more of this work. The background capability has to exist before those stories are built on it.

**Independent Test**: Trigger each moved operation and measure how long the screen is blocked; confirm the result arrives later, that the in-panel notice appears, and that forcing a failure produces a visible failure rather than a silent loss.

**Acceptance Scenarios**:

1. **Given** a staff member sends an invoice by email and WhatsApp with a PDF attached, **When** they confirm, **Then** the screen responds at once, the message is delivered afterwards, and its delivery state appears in the notification log.
2. **Given** a staff member starts a year-long invoice generation or a file import, **When** they confirm, **Then** they can continue working immediately and receive an in-panel notice with the outcome (counts of created, skipped and failed items) when it ends.
3. **Given** a background job fails after its retries, **When** the staff member looks at the panel, **Then** the failure and its reason are shown and the job can be started again without creating duplicates.
4. **Given** an online payment is confirmed, **When** the confirmation is recorded, **Then** the renter and company are notified exactly once; if the recording is rolled back, no notification is sent.
5. **Given** a staff member records a payment, reverses a payment, marks an invoice paid, closes out a contract or creates a payment link, **When** they confirm, **Then** the result is shown immediately as today, because these actions are not moved to the background.

---

### User Story 3 - Each company has its own address and sign-in (Priority: P1)

Every company is reached at its own address (for example `danat.ijary.app`). Staff and renters sign in there, on a page carrying the company's name and logo, with accounts that exist only inside that company. The platform's own address shows a simple page with a way to sign in.

**Why this priority**: It is how a company and its renters reach the product, and it is what makes separate accounts per company workable.

**Independent Test**: Create two companies, open each address, confirm branding differs, and confirm an account of one company cannot sign in at the other's address.

**Acceptance Scenarios**:

1. **Given** a company exists with the short name `danat`, **When** anyone opens its address, **Then** they land on that company's sign-in page showing its name and logo.
2. **Given** the same username, email or phone exists in companies A and B, **When** the person signs in at A's address, **Then** only the A account is considered, and the two accounts keep separate passwords.
3. **Given** a valid account of company A, **When** it is used at company B's address, **Then** sign-in fails with the same message as a wrong password.
4. **Given** an address that matches no company, **When** it is opened, **Then** a "not found" page is shown and no company is revealed.
5. **Given** the platform's main address, **When** it is opened, **Then** a simple temporary page is shown with a sign-in entry, and no company's landing content appears.

---

### User Story 4 - The super admin creates and manages companies and their users (Priority: P1)

The platform owner signs in to a separate super admin panel, protected by a second sign-in factor. From there they create a company with its first admin, see all companies, and create, deactivate or reset the password of any user in any company.

**Why this priority**: Companies do not register themselves; this is the only way a company comes to exist.

**Independent Test**: As super admin, create a company and its first admin, then sign in as that admin at the company's address and confirm the company starts with a working, empty panel.

**Acceptance Scenarios**:

1. **Given** the super admin enters a company's Arabic and English names, short name and first admin's details, **When** they save, **Then** the company exists with its address, default roles, default notification templates and default lists, and the first admin can sign in and must change the temporary password.
2. **Given** a short name that is already used or reserved, **When** the super admin tries to save, **Then** it is refused with a clear reason.
3. **Given** any company, **When** the super admin creates a user, deactivates a user or resets a password, **Then** the change applies to that company only and is written to the platform audit log.
4. **Given** a super admin account without its second factor set up, **When** it signs in, **Then** it is forced to set it up before reaching any company data.
5. **Given** any super admin action, **When** it completes, **Then** the platform audit log records who did it, on which company, what changed and when.

---

### User Story 5 - The super admin shows and hides sections per company (Priority: P2)

For each company the super admin switches sections of the panel on or off (for example electricity, employees and salaries, expenses, inbox, online payments). A hidden section disappears for all of that company's users and cannot be reached by any other route.

**Why this priority**: It lets the owner sell different packages and keep unfinished sections away from a company, but a company can operate with everything on.

**Independent Test**: Switch one section off for company A, confirm it vanishes for A's users, that its direct links and data requests are refused, and that company B still has it.

**Acceptance Scenarios**:

1. **Given** the electricity section is switched off for company A, **When** an A staff member loads the panel, **Then** the section is absent from navigation and the dashboard.
2. **Given** that section is off, **When** an A user opens its link directly or requests its data, **Then** access is refused.
3. **Given** a section is switched off, **When** it is switched on again later, **Then** all its earlier data is still there.
4. **Given** a section with scheduled work or notifications is off for A, **When** that work is due, **Then** it does not run for A.

---

### User Story 6 - The super admin tracks subscriptions and suspends companies (Priority: P2)

The super admin keeps a subscription record for each company: plan name, price, start date, renewal date and status. The panel warns the super admin as renewal approaches and shows a banner to the company's admin. Suspending a company is always the super admin's own decision.

**Why this priority**: It is how the owner knows who has paid and stops service for who has not, without building automatic billing.

**Independent Test**: Give a company a renewal date two weeks away and confirm the warnings appear on schedule; then suspend it and confirm staff and renters are locked out while an already-made online payment is still recorded.

**Acceptance Scenarios**:

1. **Given** a company's renewal date is 14, 7 or 1 day away, **When** that day begins, **Then** the super admin sees a warning and the company's admin sees a banner naming the renewal date.
2. **Given** a renewal date has passed with no renewal recorded, **When** the super admin views the companies list, **Then** the company is flagged as overdue but stays active.
3. **Given** the super admin suspends a company, **When** its staff or renters open the company's address, **Then** they see an "account suspended" page and cannot sign in or use the panel or portal.
4. **Given** a suspended company, **When** its scheduled work and notifications are due, **Then** they do not run.
5. **Given** a renter paid online before the suspension took effect, **When** the payment confirmation arrives afterwards, **Then** the payment is recorded against the right invoice.
6. **Given** a suspended company, **When** the super admin reactivates it, **Then** access returns with all data intact.

---

### User Story 7 - Each company has limits the super admin can raise (Priority: P2)

Each company has limits on rental units, staff accounts, WhatsApp messages per month and stored file size. Reaching a limit blocks further additions with a clear message; the super admin can raise any limit at any time.

**Why this priority**: It protects the platform's capacity and supports packages, but is not needed for a first company to work.

**Independent Test**: Set a low limit of each kind for a company, reach it, confirm the block and its message, raise the limit and confirm the block lifts.

**Acceptance Scenarios**:

1. **Given** a company is at its unit limit, **When** staff try to add or import another unit, **Then** it is refused with a message stating the limit and how to request more.
2. **Given** a company is at its staff account limit, **When** an admin tries to create another staff account, **Then** it is refused; renter accounts are not counted.
3. **Given** a company has used its monthly WhatsApp allowance, **When** another WhatsApp message is due, **Then** it is not sent, is marked as skipped for that reason in the notification log, and email delivery continues.
4. **Given** a company is at its storage limit, **When** a user uploads a file, **Then** the upload is refused with a clear message.
5. **Given** the super admin raises a limit, **When** the company retries, **Then** the action succeeds without delay.
6. **Given** a company reaches 80% of any limit, **When** its admin opens the panel, **Then** a notice shows the usage.

---

### User Story 8 - Each company collects online payments through its own gateway account (Priority: P2)

A company's admin opens a payment gateway section in their panel, picks a supported gateway, enters their own merchant credentials, tests the connection and activates it. Renters of that company then pay online and the money settles to the company's own bank account. The platform never holds the money.

**Why this priority**: Online collection is a core value of the product, and today the credentials are shared platform-wide, which cannot work for more than one company.

**Independent Test**: Configure a sandbox gateway account for company A, pay an invoice as a renter of A, and confirm the payment is recorded through each settlement path; confirm company B, with no gateway, shows no online payment option.

**Acceptance Scenarios**:

1. **Given** a company admin enters gateway credentials, **When** they save, **Then** the secret values are never displayed again (only their last characters) and a "test connection" action reports success or the gateway's error.
2. **Given** a company has two gateways configured, **When** one is activated, **Then** the other becomes inactive, so exactly one is active.
3. **Given** a renter started a payment on gateway X, **When** the company switches its active gateway to Y before the payment completes, **Then** that payment still completes and is recorded through X.
4. **Given** a payment confirmation arrives for company A, **When** it is processed, **Then** it is verified with A's credentials and recorded for A only; a confirmation that fails verification is logged and changes nothing.
5. **Given** a company has no active gateway, **When** its renters open the portal, **Then** online payment is not offered and other payment methods are unaffected.
6. **Given** a confirmation message never arrives, **When** the periodic reconciliation runs, **Then** the paid request is still found and recorded once.

---

### User Story 9 - Each company connects its own WhatsApp (Priority: P3)

A company's admin connects the company's WhatsApp number from their panel in one of three ways: scanning a QR code, connecting the official business API, or the official "coexistence" sign-up that keeps their existing WhatsApp Business app on the same number. Messages to renters go out from that number, and replies arrive in that company's inbox only.

**Why this priority**: WhatsApp is the main channel to renters, but a company can start on email alone.

**Independent Test**: Connect a different number for each of two companies, send from each, reply to each, and confirm every message and conversation appears only in the owning company.

**Acceptance Scenarios**:

1. **Given** a company admin chooses the QR method, **When** they scan the code with the company's phone, **Then** the connection shows as connected with the number, and messages send from it.
2. **Given** a company admin chooses the official sign-up, **When** they complete it, **Then** the number is linked without the admin typing any secret value.
3. **Given** two companies are connected, **When** a renter replies to company A's number, **Then** the reply appears in A's inbox only.
4. **Given** a company's connection drops, **When** it is detected, **Then** that company's admin is alerted and no other company is affected.
5. **Given** a company has one method active, **When** it activates another, **Then** the first becomes inactive.
6. **Given** a number is already connected to one company, **When** another company tries to connect the same number, **Then** it is refused.

---

### User Story 10 - A company can send email before configuring its own (Priority: P3)

A company that has not set up its own email sender still sends notification emails. They go from the platform's sender, show the company's name, and replies go to the company's address. A company that configures its own sender uses it instead.

**Why this priority**: It removes a setup step from onboarding; it is small and depends on the background and isolation foundations.

**Independent Test**: Trigger a notification for a company with no email configuration and inspect the received message's sender name and reply address; then configure the company's own sender and repeat.

**Acceptance Scenarios**:

1. **Given** a company with no email sender configured, **When** a notification email is sent, **Then** it shows the company's name as sender name and the company's reply address.
2. **Given** a company configures its own sender, **When** the next email is sent, **Then** it goes from the company's sender.
3. **Given** a company's own sender fails in a way that did not deliver the message, **When** a fallback is available, **Then** the message is delivered once, not twice.

---

### User Story 11 - The super admin enters a company's panel for support (Priority: P3)

To help a company, the super admin opens that company's panel as its admin. They must write a reason first. A red banner stays visible for the whole session, which ends on its own after 60 minutes. Everything done is recorded under the super admin's name.

**Why this priority**: It makes support practical, but the platform operates without it.

**Independent Test**: Start a support session with a reason, perform an action, and confirm the banner, the time limit, the audit entries in both logs and the blocked password change.

**Acceptance Scenarios**:

1. **Given** the super admin starts a support session without a reason, **When** they confirm, **Then** it is refused.
2. **Given** a support session is active, **When** any page of the company panel is shown, **Then** a red banner states that a support session is active, by whom, and how to end it.
3. **Given** a support session, **When** 60 minutes pass or the super admin ends it, **Then** access to the company panel stops.
4. **Given** a support session, **When** the super admin changes data, **Then** the company's audit log and the platform audit log both name the super admin as the actor.
5. **Given** a support session, **When** the super admin tries to change a user's password or view a stored secret, **Then** it is refused.

---

### User Story 12 - The super admin watches the whole platform (Priority: P3)

The super admin sees an overview: how many companies, units and users exist, how much was collected, and for each company the health of its WhatsApp connection, payment gateway, scheduled work and notification delivery.

**Why this priority**: It turns problems the owner would learn about from complaints into something visible, but nothing else depends on it.

**Independent Test**: With two companies in different states (one healthy, one with a dropped WhatsApp connection and failed notifications), confirm the overview shows each correctly.

**Acceptance Scenarios**:

1. **Given** several companies, **When** the super admin opens the overview, **Then** it shows totals for companies, units, users and collected payments for a chosen period.
2. **Given** a company whose WhatsApp connection dropped or whose gateway test fails, **When** the overview is viewed, **Then** that company is flagged with the affected item.
3. **Given** failed notifications or failed background jobs exist, **When** the overview is viewed, **Then** counts per company are shown with a way to see the items.
4. **Given** each company's usage against its limits, **When** the overview is viewed, **Then** usage is shown per company.

---

### User Story 13 - A company gets its own domain and landing page (Priority: P4, last)

On request, the platform owner connects a company's own domain so its panel and portal open there, and switches on a public landing page for that company. The platform's main address gets its own marketing landing page.

**Why this priority**: The owner placed it last; it is delivered by the platform team per request, not self-service.

**Independent Test**: Connect a test domain to one company, confirm the company opens on it with a valid certificate while its original address keeps working, and confirm the landing page shows only that company's content.

**Acceptance Scenarios**:

1. **Given** the super admin adds a company's own domain, **When** the domain's ownership check passes, **Then** the company's sign-in, panel and portal open on that domain securely, and the original address still works.
2. **Given** the landing page section is switched on for a company, **When** a visitor opens the company's address, **Then** they see that company's landing page; with it off they go to sign-in.
3. **Given** the platform's main address, **When** the new marketing page is published, **Then** it replaces the temporary page.

---

### Edge Cases

- A request arrives with a session from one company at another company's address: it is treated as not signed in.
- A person belongs to two companies: they hold two unrelated accounts; nothing links or merges them.
- A scheduled run or background job belongs to a company that was suspended after the job was queued: the job does not perform its work, except recording a payment that was already made.
- A renter opens a payment page, the company is suspended, then the renter pays: the payment is recorded; no new payment page can be created while suspended.
- The super admin lowers a limit below current usage: existing items stay, new additions are blocked until usage drops or the limit rises.
- A bulk import would cross the unit limit partway through: the import reports which rows were refused for that reason and applies the rest.
- A gateway confirmation arrives twice, or arrives and the reconciliation also finds it: the payment is recorded once.
- A gateway's credentials are replaced while payments are in flight: in-flight payments complete against the credentials they started with.
- A background job is retried after a partial run: no duplicate invoices, messages or records result.
- The worker is down: user actions still succeed and the queued work runs when it returns; nothing is lost.
- A section is switched off while a user has it open: their next request to it is refused with a clear message.
- A short name collides with a reserved word (for example the super admin panel's address): creation is refused.
- A file link of company A is shared with a signed-in user of company B: the download is refused.
- The support session's 60 minutes end mid-action: the action in progress completes or fails as a whole, and the next request is refused.
- A WhatsApp number is moved from company A to company B: A must disconnect first; earlier conversations stay with A.

## Requirements *(mandatory)*

### Functional Requirements

**Isolation**

- **FR-001**: Every business record, file, message, setting, template, scheduled item and log entry MUST belong to exactly one company.
- **FR-002**: The system MUST prevent any user of one company from reading, listing, counting, searching, exporting, downloading, changing or deleting anything belonging to another company, through every screen and every direct request.
- **FR-003**: Isolation MUST be enforced at the data layer independently of the application's own filters, so that a missing filter in application code cannot expose another company's data.
- **FR-004**: Every server-side operation that runs with elevated privileges MUST be bound to a single company for its whole execution, and MUST fail when no company is established.
- **FR-005**: The system MUST refuse to link records of different companies to each other (for example a contract of one company to a unit of another).
- **FR-006**: Uniqueness rules that are business-level (usernames, document codes, list items, template codes) MUST apply per company.
- **FR-007**: Document numbering (invoices, payments, receipts, contracts, refunds) MUST run as a separate sequence per company.
- **FR-008**: Scheduled work MUST run once per active company, using that company's data, branding, sender and settings; a failure for one company MUST NOT stop the others.
- **FR-009**: Stored files MUST be separated per company, and every download MUST be authorised against the requesting user's company.
- **FR-010**: Any destructive bulk action available to a company MUST affect that company only. The existing "erase all data" action MUST NOT be available in company panels.
- **FR-011**: A suite of two-company tests covering every data table and every server operation MUST pass before a second company is onboarded, and MUST run on every later change to data or operations.

**Background processing**

- **FR-012**: The system MUST run the following outside the user's request: all email and WhatsApp sending including the pacing between WhatsApp messages; PDF generation for invoices, receipts, contracts and reports; scheduled reports; generating or regenerating invoices for a period; file imports; electricity charge and salary generation; company data export, backup and restore; WhatsApp history and profile picture sync; mailbox sync; payment reconciliation; and the processing of incoming provider messages after they are verified and stored.
- **FR-013**: The following MUST remain immediate: recording and allocating a payment, reversing a payment, marking an invoice paid or unpaid, closing out a contract and creating a payment link.
- **FR-014**: When a user starts background work, the system MUST confirm at once and let them continue working.
- **FR-015**: When a long job (import, bulk generation, export, backup, restore) ends, the system MUST notify the user who started it inside the panel with the outcome; ordinary message sending reports its state in the notification log only.
- **FR-016**: A failed job MUST be retried a limited number of times, then marked failed with its reason, be visible to the company's admin, and be restartable without producing duplicates.
- **FR-017**: Every background job MUST belong to one company and MUST NOT read or write another company's data.
- **FR-018**: Events that follow a money change (for example "payment succeeded") MUST be recorded together with that change, so that a notification is never sent for a change that was undone and is never lost for a change that was kept.
- **FR-019**: Heavy work of one company MUST NOT delay another company's ordinary notifications by more than one minute.
- **FR-020**: Queued work MUST survive a restart of the worker or the application.

**Company address and sign-in**

- **FR-021**: Each company MUST be reachable at an automatic address formed from its short name under the platform's domain.
- **FR-022**: The system MUST determine the company from the address of each request, and MUST reject a session that belongs to a different company than the address.
- **FR-023**: Accounts MUST be separate per company; username, email and phone MUST be unique within a company only.
- **FR-024**: Sign-in MUST accept username, email or phone and MUST consider only accounts of the address's company.
- **FR-025**: The sign-in page at a company's address MUST show that company's name and logo.
- **FR-026**: An address matching no company MUST show a "not found" page; the platform's main address MUST show a simple temporary page with a sign-in entry.
- **FR-027**: The existing landing page section MUST remain available in the product but switched off for every company until User Story 13.

**Super admin**

- **FR-028**: The super admin panel MUST be separate from every company panel, with its own accounts that are not members of any company.
- **FR-029**: Super admin accounts MUST use a second sign-in factor, with no way to skip it.
- **FR-030**: The super admin MUST be able to create a company with Arabic and English names, a short name, and a first admin account; creation MUST prepare default roles and permissions, notification templates, lists and workflow settings for that company.
- **FR-031**: Short names MUST be unique, limited to letters, digits and hyphens, and MUST NOT match a reserved list.
- **FR-032**: The first admin MUST receive a temporary password and MUST change it at first sign-in.
- **FR-033**: The super admin MUST be able to list companies with status, subscription state and usage, and to edit a company's names and settings.
- **FR-034**: The super admin MUST be able to create users, deactivate and reactivate users and reset passwords in any company.
- **FR-035**: Every super admin action MUST be written to a platform audit log with actor, company, action, before and after values, and time. Secret values MUST NOT be written to any log.
- **FR-036**: The system MUST NOT offer permanent deletion of a company; suspension is the only removal of access.

**Sections per company**

- **FR-037**: The super admin MUST be able to switch each section on or off per company. Switchable sections: invoices, renters, properties and buildings, units, contracts, payments, deposits, expenses, electricity, maintenance, employees and salaries, inbox, reports, audit log, online payments, WhatsApp, landing page. The dashboard and settings are always on.
- **FR-038**: A switched-off section MUST be absent from navigation and dashboard, and every request for its screens, data or actions MUST be refused for that company's users regardless of their role.
- **FR-039**: Switching a section off MUST keep its data, and MUST stop its scheduled work and notifications for that company.
- **FR-040**: A change to a company's sections MUST take effect for its users within one minute, without them signing in again.

**Subscriptions and suspension**

- **FR-041**: The super admin MUST be able to record for each company a plan name, price, start date, renewal date and status, and to record each renewal, keeping the history.
- **FR-042**: The system MUST warn the super admin 14, 7 and 1 day before a renewal date, and show the company's admin a banner on those days and until renewal is recorded.
- **FR-043**: The system MUST flag a company whose renewal date has passed, and MUST NOT suspend it automatically.
- **FR-044**: The super admin MUST be able to suspend and reactivate a company, with a reason recorded.
- **FR-045**: While a company is suspended, its staff and renters MUST see an "account suspended" page and be unable to use the panel or portal; its scheduled work and notifications MUST NOT run; no new payment link may be created.
- **FR-046**: An online payment made on a payment page created before suspension MUST still be recorded.

**Limits**

- **FR-047**: Each company MUST have optional limits for rental units, staff accounts, WhatsApp messages per calendar month and stored file size; an empty limit means unlimited.
- **FR-048**: The system MUST block an addition that would exceed a limit, by every route including import, and explain the limit in the message.
- **FR-049**: WhatsApp messages beyond the monthly limit MUST be skipped and marked with that reason; the count MUST reset at the start of each month in the company's time.
- **FR-050**: The super admin MUST be able to change any limit with immediate effect.
- **FR-051**: A company's admin MUST see current usage against each limit, with a notice from 80%.

**Payment gateway per company**

- **FR-052**: Each company's panel MUST have a payment gateway section, available to users holding the integrations permission.
- **FR-053**: A company MUST be able to configure its own account for each supported gateway: MyFatoorah, Tap and UPayments, each with a test mode and a live mode.
- **FR-054**: Stored credentials MUST be protected so that they are never displayed after saving (only their last characters), never included in exports or logs, and unreadable to other companies and to staff without the integrations permission.
- **FR-055**: A "test connection" action MUST verify credentials and report the gateway's response; a gateway MUST NOT be activated before a successful test.
- **FR-056**: Exactly one gateway MAY be active per company at a time.
- **FR-057**: Each payment request MUST remember the gateway and account it started on, and MUST complete on them even after the active gateway or its credentials change.
- **FR-058**: Each company MUST have its own address for gateway confirmations, verified with that company's secret; every confirmation, valid or not, MUST be logged.
- **FR-059**: A payment MUST be recorded exactly once whether it is learned from the confirmation message, the renter's return page or the periodic reconciliation.
- **FR-060**: A company without an active gateway MUST NOT show online payment to its renters.
- **FR-061**: The platform MUST NOT receive, hold or forward renters' money.

**WhatsApp per company**

- **FR-062**: Each company MUST be able to connect its own WhatsApp number by QR code, by the official business API, or by the official coexistence sign-up, from its own panel.
- **FR-063**: At most one WhatsApp method MAY be active per company, and a number MUST NOT be connected to two companies at once.
- **FR-064**: Incoming messages MUST be routed to the owning company only; conversations, contacts and media MUST be isolated per company.
- **FR-065**: The system MUST alert a company's admin when its connection drops, and show connection state in the panel.
- **FR-066**: With the official API, a notification that requires an approved template and has none linked MUST be refused with a clear reason rather than sent in another form.
- **FR-067**: Sending pace limits MUST apply per company connection.

**Email**

- **FR-068**: A company with no email sender configured MUST send through the platform's default sender, showing the company's name and reply address.
- **FR-069**: A company MUST be able to configure its own sender, which then takes precedence.

**Support access**

- **FR-070**: The super admin MUST be able to open a company's panel as its admin only after entering a reason.
- **FR-071**: A support session MUST show a persistent red banner, end after 60 minutes or on demand, and record every action under the super admin's identity in both the company's and the platform's audit logs.
- **FR-072**: During a support session the super admin MUST NOT be able to change any user's password or sign-in factor, or view stored secrets.

**Platform overview**

- **FR-073**: The super admin MUST see totals of companies, units, users and collected payments for a selectable period.
- **FR-074**: The super admin MUST see, per company, the state of the WhatsApp connection, payment gateway, scheduled work, failed notifications, failed background jobs, usage against limits and subscription state.

**Regional settings**

- **FR-075**: Each company MUST carry its own currency and time zone; for this feature all companies use Kuwaiti dinar and Kuwait time, and no other value is offered.

**Custom domain and landing pages (last)**

- **FR-076**: The super admin MUST be able to attach a company's own domain, which then serves that company alongside its automatic address, after an ownership check and with a valid certificate.
- **FR-077**: The landing page section, when switched on for a company, MUST show only that company's content at its address.
- **FR-078**: The platform's main address MUST be able to show a dedicated marketing page in place of the temporary page.

### Key Entities *(include if feature involves data)*

- **Company**: A customer of the platform. Names in Arabic and English, short name, status (active or suspended), branding, currency, time zone. Owns all business data.
- **Company address**: An address that leads to a company; the automatic one and, later, the company's own domain with its verification state.
- **Company section setting**: Whether a given section is on or off for a company.
- **Subscription record**: Plan name, price, start and renewal dates, status and renewal history for a company.
- **Company limit and usage**: The four limits of a company and the current usage counted against each.
- **Super admin account**: A platform-level account outside all companies, with a mandatory second sign-in factor.
- **Platform audit entry**: A record of a super admin action: actor, company, action, before and after, time.
- **Support session**: A time-limited entry of a super admin into a company's panel, with its reason, start and end.
- **User account**: A staff or renter account belonging to one company, with identifiers unique within it.
- **Payment gateway connection**: A company's account at one gateway: provider, mode, protected credentials, test result, active flag.
- **Payment request**: An attempt to pay online, bound to the gateway connection it started on.
- **WhatsApp connection**: A company's linked number, method, state and protected credentials.
- **Email sender setting**: A company's own sender, or none (platform default applies).
- **Background job**: A unit of deferred work for one company: kind, who started it, state, attempts, outcome.
- **Business event**: A record that something happened (for example a payment succeeded), stored with the change that caused it and delivered to background work afterwards.
- **In-panel notice**: A message to a staff user about a finished or failed job.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the two-company test suite, 100% of cross-company read, write, export and download attempts are refused or return nothing, across every data table and every server operation.
- **SC-002**: The super admin can create a company and its first admin in under 5 minutes, and that admin can sign in at the company's address within 1 minute of creation.
- **SC-003**: For actions whose slow part moved to the background, the screen responds in under 2 seconds in 95% of cases, measured with message providers responding slowly.
- **SC-004**: After starting an invoice generation covering 500 contracts for a year, the user can continue working within 2 seconds and receives the outcome notice when it ends.
- **SC-005**: Across 1,000 simulated payment events with injected failures and retries, every kept payment produces exactly one notification and no undone payment produces any.
- **SC-006**: While one company runs a 10,000-row import, another company's notification is delivered within 1 minute of being triggered.
- **SC-007**: A section switched off for a company is unreachable by all of its users within 1 minute, and 100% of direct requests to it are refused.
- **SC-008**: A suspended company's staff and renters lose access within 1 minute, and 100% of payments made on earlier payment pages are still recorded.
- **SC-009**: 100% of additions beyond a limit are refused by every route, and succeed immediately after the limit is raised.
- **SC-010**: Renewal warnings appear on each of the 14, 7 and 1 day marks for 100% of companies with a renewal date.
- **SC-011**: A company admin can configure a gateway, pass the connection test and complete a test payment in under 10 minutes without help.
- **SC-012**: For each supported gateway, the success, failure, cancellation, expiry and duplicate cases are each recorded correctly through all three paths (confirmation message, return page, reconciliation) before it can be used in live mode.
- **SC-013**: A company admin can connect WhatsApp by QR code in under 3 minutes, and 100% of replies appear only in the owning company's inbox.
- **SC-014**: A new company with no email setup delivers its first notification email with the company's name and reply address, with no configuration step.
- **SC-015**: Every super admin action and every action in a support session appears in the audit log with the super admin named, with zero secret values recorded.
- **SC-016**: Danat's existing production deployment and data are unchanged by this work.

## Assumptions

**Settled with the owner on 2026-11-25 and 2026-11-26**

- The existing Danat codebase in this folder is converted in place. The separate rebuild described in the earlier IJARY PRD is deferred.
- IJARY is a new, separate deployment on the owner's Contabo server managed with Dokploy. Danat's production is not touched and its data is not migrated in this feature.
- The platform domain is `ijary.app`, managed on Cloudflare; companies are reached at `<short-name>.ijary.app`.
- Delivery order: isolation, then the background-work foundation; company address, sign-in and super admin panel; payment gateways; WhatsApp and default email; support access and platform overview; custom domains and landing pages last.
- The background worker uses a job queue backed by a separate in-memory store and runs as its own process (owner's choice: BullMQ and Redis).
- MyFatoorah is delivered first. Tap and UPayments are built when the owner provides sandbox accounts.
- The owner has an approved Meta application, so the official WhatsApp sign-up including coexistence is in scope.
- Kuwait only: Kuwaiti dinar, Kuwait time, Kuwait phone format.
- Subscriptions are a manual record; the platform does not charge companies.
- Companies do not register themselves; only the super admin creates them.

**Defaults chosen where the owner did not specify**

- The existing `companies` concept and its identifier are kept as the company; no new name is introduced in the data.
- A company's short name is fixed after creation.
- The super admin panel lives at a reserved address under the platform domain; reserved short names include that address and common infrastructure names.
- There may be several super admin accounts, all with the same full rights.
- A new company starts with every section on except landing page and maintenance.
- Roles and their permissions are held per company, starting from the current defaults (admin, accountant, collector, read-only, renter).
- Session lengths stay as they are today for staff and renters.
- A support session opens the company as its admin role only, not as a specific renter.
- The WhatsApp monthly count covers outgoing messages on all WhatsApp methods.
- Storage usage counts all files a company has uploaded or generated and kept.
- Platform-level settings (default email sender, the shared WhatsApp QR server, the Meta application) are set at deployment, not through a screen, in this feature.
- A company admin can export their own company's data; restoring data is a platform operation.
- Background job retries: up to 3 attempts with increasing delay.
- Target scale for this feature: tens of companies, each with up to a few thousand units.

**Out of scope**

- Automatic billing of companies, packages with automatic enforcement beyond the four limits, and self-registration.
- Migrating Danat's live data into IJARY.
- Countries, currencies and tax rules other than Kuwait's.
- Self-service custom domain setup by companies.
- Permanent deletion of a company.
- A page listing all background jobs for company admins (only notices and failed-job visibility are included).
- Additional WhatsApp or payment providers beyond those named.
