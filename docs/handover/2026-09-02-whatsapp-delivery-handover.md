# Handover — WhatsApp delivery hardening (2026-09-02)

Written for whichever model or engineer picks this up next. Everything below was verified against production (`ssh-danatfuture-mcp`, DB container `danatfuture-supabase-ozoxsa-db-1`) and the code on branch `fix/whatsapp-evolution-session-hardening`, PR #173.

## 1. What was reported

Contract-expiry notification reached admins by email but the tenant WhatsApp leg failed. Later the same day: a new tenant's credentials WhatsApp "sent" in the platform inbox but never appeared on the phone or at the tenant.

## 2. Root causes (all confirmed, none of them configuration)

Every gate/template/tenant setting checked was correct: `cron_jobs.contract-expiry` targets `{admin,company,tenant}`, all 17 `notification_templates.channel = both`, all 55 tenants `reminders_enabled = true`, `provider_configs.evolution_api` enabled, instance `danat` paired to `96592280746`.

| #   | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **WhatsApp unlinked the device mid-batch** at 01:15:14 UTC (`stream:error 401 conflict type=device_removed`). Evolution → `state: close`. Every later `sendText` returned **HTTP 500 "Connection Closed"**. The adapter treated 5xx as transient, retried 3×, and left 11 tenant rows `failed` with "transiently (500)".                                                                                                                                                                                                              | Evolution container log (timestamps print in UTC-3), `notifications` rows 01:15–01:20, `evolution_connections.last_connection_state`.                                                                                                                                                           |
| B   | **Three tenant-facing jobs ran twice per night** (09-01 and 09-02): `overdue-reminders`, `contract-expiry`, `notification-drain`. Concurrent runs raced their own idempotency reads and doubled the WhatsApp burst before the unlink. Source of the second caller is **unidentified**: one line per job in `/etc/cron.d/danat-ermp`, one CMD in syslog, no Dokploy schedules, one replica, Traefik has no access log. Leading hypothesis: the old server's crontab (`116.202.66.131`), which is off-limits to agents by project rule. | `audit_logs` pairs of `job.*` rows per minute; `journalctl -u cron`; Dokploy `schedule` table empty; `docker service ls`.                                                                                                                                                                       |
| C   | **WhatsApp rejects sends to cold contacts with ack error 463** (reach-out time-lock). Evolution answers 201 first; the server ack `status: ERROR` arrives on `messages.update`, which the platform did **not** subscribe to, so the row stayed `sent` forever. Gateway is Evolution **2.3.7 on Baileys 7.0.0-rc.9**; Baileys **7.0.0-rc10** (May 2026) added "Full TC Token lifecycle … Reachout Timelock (463)". Evolution `main` and `2.4.0-rc2` still pin rc.9.                                                                    | Log: `"update": {"status": 0, "messageStubParameters": ["463"]}` for ids `3EB0D778…`, `3EB07531…` (05:29/05:33, new tenant 97550232) and `3EB07B12…` (01:15, tenant 66106604 — recorded `sent`). `findMessages` shows no server ack. `whatsappNumbers` confirms both numbers exist on WhatsApp. |
| D   | `stripMarkup` shipped editor indentation to tenants (seven leading spaces per paragraph).                                                                                                                                                                                                                                                                                                                                                                                                                                             | Message body in the Evolution log.                                                                                                                                                                                                                                                              |

## 3. What the branch changes (PR #173, 3 commits)

- `src/lib/providers/evolution.ts` — 5xx probes `connectionState` once; non-open → `session_disconnected` (needs_review); probe failure stays transient.
- `src/fns/evolutionDelivery.ts` — `requireOpenSession`: refuse on recorded non-open state unless a live probe says open (heals the row). Sent media cached in `whatsapp-media` under the message id, one path for composer/forward/dispatcher.
- `src/fns/notificationDrainJob.ts` — rows at `MAX_RETRIES` → `needs_review` with the last error.
- `src/fns/cronJobs.ts` — process-local lock; concurrent duplicate of a job → 409.
- `contractExpiryJob` / `overdueRemindersJob` — every dropped tenant leg recorded in the audit `skipped[]` with a reason; `src/lib/whatsappSkipReasons.ts` is the single vocabulary.
- `src/fns/evolutionWebhook.ts` + `src/lib/evolution/messageAck.ts` — handles `MESSAGES_UPDATE`: ERROR → inbox row `failed` and the notification carrying that id → `needs_review` (`error_code = whatsapp_rejected`); DELIVERY_ACK/READ → inbox `delivered`/`read`. `evolutionSession.ts` subscribes to the event at pairing.
- `sendCompanyInfo.ts` — WhatsApp leg carries the PDF. `templateRender.ts` — indentation dropped. Dictionary: integration renamed "WhatsApp (Danat-Future API)".
- Tests: 18 new cases; dispatch suite split into `.test` / `.evolution.test` / `.testkit`; new `sendCompanyInfo.test.ts`. Gates green: typecheck, full vitest (274 files), prettier on touched files.

## 4. Production actions already taken (no code)

- `POST /webhook/set/danat` on the live gateway now subscribes `MESSAGES_UPDATE` (same URL, same secret). The deployed app ignores the event with 200 until PR #173 ships, then acts on it.
- One diagnostic text was sent from the gateway to the company's own number (id `3EB07E7163FC5AFE98D439`, "Danat diagnostic test"). No ack was logged; inconclusive.
- User re-scanned the QR at 05:22:30 UTC; session is `open` again.

## 5. Open items, in order

1. **Merge PR #173** (Dokploy auto-deploys; no migration).
2. **Re-queue the 12 stuck rows** once deployed — 9 overdue + 2 contract-expiry (`failed`, retry_count 3, 01:15–01:20) + the 05:17 credentials row. SQL: set `state='queued', retry_count=0, scheduled_at=now(), failure_reason=null, error_code=null` for those ids; the drain (01:40 UTC) or a manual "run now" sends them. Note `identify_contract_expiry_reminders` will not re-offer contract `d9d1e8bd…` for the 30d milestone while non-cancelled rows exist, so the contract-expiry WhatsApp must be re-queued, not regenerated.
3. **Cold-contact sends (463) will still fail** until the gateway's Baileys is ≥ rc10. Options: (a) build the fork `lolotam/evolution-api` with `"baileys": "7.0.0-rc14"` in `package.json` (untested compatibility with Evolution 2.3.7), (b) wait for an Evolution release that bumps Baileys, (c) operational workaround: have new tenants message the company number first, or send their first message from the phone. After the fix lands, rejected rows will show in the Notification Log as `needs_review` with the 463 explanation.
4. **Find the second cron caller** (cause B). One read-only command on the old server settles it: `grep -r danat /etc/cron.d/ /var/spool/cron/crontabs/`. The 409 guard makes the duplicate harmless but visible in the caller's output.
5. Follow-up worth doing: alert admins by email when `CONNECTION_UPDATE` reports `close` (today nobody learns until the next batch fails). Not started.
6. Feature request received mid-task, not started: per-tenant reminder cadence (`tenants.reminder_interval_months` 1/3/6/12, anchored on the last reminder sent). User has not yet said tenant-level vs contract-level.

## 6. How to verify after deploy

```sql
-- session
select last_connection_state, updated_at from evolution_connections where id = 1;
-- anything WhatsApp rejected after acceptance
select id, type, recipient_address, provider_message_id, failure_reason
from notifications where error_code = 'whatsapp_rejected' order by created_at desc;
-- per-run skip reasons
select created_at, after->'skipped' from audit_logs
where action in ('job.contract_expiry','job.overdue_reminders') order by created_at desc limit 4;
```

Gateway-side ack for a message id: `docker logs <evolution> | grep -A6 '"id": "<ID>"'` — `"status": 2` = accepted, `"status": 0` + `["463"]` = rejected.

## 7. Memory notes written this session

`~/.claude/projects/F--Danat-Mostakbal/memory/`: `evolution-device-removed-sends-500.md`, `cron-jobs-double-fire-unknown-source.md`. Add one for cause C if you continue.
