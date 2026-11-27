import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sendMail = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-start", async () =>
  (await import("./dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/company/requestCompany.server", async () =>
  (await import("./dispatchNotification.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (
    await import("./notifyUserCredentials.boundary.testkit")
  ).credentialBoundaryCompanyClientModule(),
);
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail }),
  },
}));

import {
  adminCredentialCopy,
  credentialBoundary,
  dispatchJobsFor,
  ownerCredentialRow,
  resetCredentialBoundary,
} from "./notifyUserCredentials.boundary.testkit";
import { createNotificationDispatchHandler } from "@/jobs/handlers/notification";

const { notifyUserCredentials } = await import("./notifyUserCredentials");

const OWNER = {
  displayName: "Sara",
  email: "sara@example.test",
  kind: "tenant" as const,
  password: "s3cret",
  tenantId: "tenant-1",
  username: "sara",
};

/**
 * Review round 2–3 on PR #211. Splitting the enqueue rows was not enough:
 * `dispatchNotification` used to append `tenants.email` onto any non-admin
 * send, so a portal address that differed from the tenant record put both in
 * one SMTP envelope and accepting either marked the owner delivered. These
 * run the real enqueue + dispatcher and stub only the database and nodemailer.
 *
 * The request no longer sends anything: it writes the row and hands it to the
 * worker, so each case first reads the queued row and the job that was
 * enqueued for it, and only then lets the worker dispatch it.
 */
describe("credential rows survive the dispatcher's recipient expansion", () => {
  beforeEach(() => {
    resetCredentialBoundary();
    sendMail.mockReset();
    sendMail.mockResolvedValue({ messageId: "smtp-1" });
    vi.stubEnv("TEST_SMTP_HOST", "smtp.test");
    vi.stubEnv("TEST_SMTP_PASS", "smtp-pass");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("the owner SMTP envelope lists only the account address", async () => {
    await notifyUserCredentials(OWNER);

    const owner = ownerCredentialRow();
    expect(owner?.state).toBe("queued");
    expect(dispatchJobsFor(owner?.id)).toHaveLength(1);

    await runEnqueuedDispatches();

    expect(smtpRecipients(0)).toEqual(["sara@example.test"]);
    expect(smtpRecipients(0)).not.toContain("record@example.test");
  });

  test("the administrative copy keeps tenant_id and still excludes the tenant record address", async () => {
    await notifyUserCredentials(OWNER);

    const copy = adminCredentialCopy();
    expect(copy?.tenant_id).toBe("tenant-1");
    expect(copy?.state).toBe("queued");
    expect(dispatchJobsFor(copy?.id)).toHaveLength(1);

    await runEnqueuedDispatches();

    expect(smtpRecipients(1)).toEqual(["company@example.test", "ops@example.test"]);
    expect(smtpRecipients(1)).not.toContain("record@example.test");
    expect(smtpRecipients(1)).not.toContain("sara@example.test");
  });

  test("a failed administrative SMTP send leaves the owner row sent and recipientIds intact", async () => {
    sendMail.mockImplementation(async (message: { to: string }) => {
      if (smtpAddressList(message.to).includes("company@example.test")) {
        throw new Error("SMTP rejected the administrative copy");
      }
      return { messageId: "smtp-owner" };
    });

    const result = await notifyUserCredentials(OWNER);

    const owner = ownerCredentialRow();
    expect(owner?.state).toBe("queued");
    expect(dispatchJobsFor(owner?.id)).toHaveLength(1);

    await runEnqueuedDispatches();

    expect(ownerCredentialRow()?.state).toBe("sent");
    expect(adminCredentialCopy()?.state).toBe("failed");
    expect(result.recipientIds).toEqual([owner?.id]);
    expect(result.ids).toContain(owner?.id);
  });

  test("a successful admin copy cannot stand in for an owner whose SMTP send failed", async () => {
    sendMail.mockImplementation(async (message: { to: string }) => {
      if (smtpAddressList(message.to).includes(OWNER.email)) {
        throw new Error("SMTP rejected the account owner");
      }
      return { messageId: "smtp-admin" };
    });

    const result = await notifyUserCredentials(OWNER);

    const owner = ownerCredentialRow();
    const copy = adminCredentialCopy();
    expect(owner?.state).toBe("queued");
    expect(dispatchJobsFor(owner?.id)).toHaveLength(1);
    expect(dispatchJobsFor(copy?.id)).toHaveLength(1);

    await runEnqueuedDispatches();

    expect(ownerCredentialRow()?.state).toBe("failed");
    expect(adminCredentialCopy()?.state).toBe("sent");
    expect(result.recipientIds).toEqual([owner?.id]);
    expect(result.recipientIds).not.toContain(copy?.id);
  });

  test("an administrative insert failure still returns the owner's recipient id", async () => {
    credentialBoundary.failAdminCopyInsert = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await notifyUserCredentials(OWNER);

    const owner = ownerCredentialRow();
    expect(owner).toBeDefined();
    expect(owner?.state).toBe("queued");
    expect(adminCredentialCopy()).toBeUndefined();
    expect(result.recipientIds).toEqual([owner?.id]);
    expect(result.ids).toEqual([owner?.id]);
    // Only the owner's row was ever written, so only its job exists.
    expect(credentialBoundary.jobs).toHaveLength(1);
    expect(dispatchJobsFor(owner?.id)).toHaveLength(1);

    await runEnqueuedDispatches();

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ownerCredentialRow()?.state).toBe("sent");
    consoleError.mockRestore();
  });
});

/**
 * يمرّر كل مهمة إرسال مسجّلة عبر معالج العامل، كما يفعل العامل بعد الترحيل.
 *
 * The jobs are read back from the outbox rather than rebuilt here: the point
 * is that the payload the request wrote is the one the worker consumes.
 */
async function runEnqueuedDispatches(): Promise<void> {
  const handler = createNotificationDispatchHandler({ pace: async () => {} });
  for (const job of credentialBoundary.jobs.filter(
    (entry) => entry.kind === "notification.dispatch",
  )) {
    await handler({
      jobRequestId: "00000000-0000-4000-8000-0000000000ff",
      companyId: "00000000-0000-4000-8000-000000000001",
      payload: job.payload as { notificationId: string },
      attempt: 1,
    });
  }
}

/** عناوين To في إرسال SMTP واحد، بعد فك السلسلة التي يبنيها المزوّد. */
function smtpRecipients(callIndex: number): string[] {
  const message = sendMail.mock.calls[callIndex]?.[0] as { to?: string } | undefined;
  if (!message?.to) return [];
  return smtpAddressList(message.to);
}

/** يفك `to` التي يمرّرها sendWithSmtp كقائمة مفصولة بفواصل. */
function smtpAddressList(to: string): string[] {
  return to
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}
