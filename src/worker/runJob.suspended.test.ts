import { describe, expect, it } from "vitest";

import { MODULE_KEYS } from "@/company/modules";
import type { JobKind } from "@/jobs/catalog";

import {
  createRunJob,
  type HandlerLookup,
  type JobRequestRow,
  type JobRequestStatus,
  type RunJobPorts,
  type SkipReason,
} from "./runJob";
import type { JobAttempt } from "./types";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const NOTIFICATION_ID = "33333333-3333-4333-8333-333333333333";
const PAYMENT_REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const WEBHOOK_EVENT_ID = "55555555-5555-4555-8555-555555555555";

/** ما سجّله العامل: حالة الصف وسبب التخطي وعدد مرات تشغيل المعالج. */
interface FakeState {
  status: JobRequestStatus;
  skipReason: SkipReason | null;
  handlerRuns: number;
}

/**
 * يبني منافذ وهمية فوق الذاكرة: الصف هو مصدر الحقيقة الوحيد الذي يرى العامل.
 */
function createFakePorts(row: JobRequestRow, companyStatus: "active" | "suspended") {
  const state: FakeState = { status: row.status, skipReason: null, handlerRuns: 0 };

  const ports: RunJobPorts = {
    loadRequest: async (ref) => (row.id === ref.id && row.companyId === ref.companyId ? row : null),
    companyStatus: async () => companyStatus,
    sectionEnabled: async (_companyId, section) => MODULE_KEYS.includes(section),
    markRunning: async () => {
      state.status = "running";
    },
    markSucceeded: async () => {
      state.status = "succeeded";
    },
    markFailed: async () => {
      state.status = "failed";
    },
    markSkipped: async (_ref, reason) => {
      state.status = "skipped";
      state.skipReason = reason;
    },
    writeNotice: async () => {},
  };

  const handlerFor: HandlerLookup = () => async () => {
    state.handlerRuns += 1;
    return { done: true };
  };

  return { ports, handlerFor, state };
}

/**
 * يعيد حمولة صالحة لنوع المهمة، لأن مخططات الكتالوج تشترط uuid.
 */
function payloadFor(kind: JobKind): unknown {
  switch (kind) {
    case "notification.dispatch":
      return { notificationId: NOTIFICATION_ID };
    case "payment.settle":
      return { paymentRequestId: PAYMENT_REQUEST_ID };
    case "webhook.process":
      return { webhookEventId: WEBHOOK_EVENT_ID };
    default:
      throw new Error(`no payload prepared for ${kind}`);
  }
}

/**
 * يبني صف طلب مهمة بحمولة صالحة لنوعها.
 */
function requestRow(kind: JobKind): JobRequestRow {
  return {
    id: REQUEST_ID,
    companyId: COMPANY_ID,
    kind,
    payload: payloadFor(kind),
    status: "published",
    requestedBy: null,
  };
}

/**
 * يبني محاولة عامل كما يسلّمها BullMQ.
 */
function attemptFor(kind: JobKind): JobAttempt {
  return {
    jobRequestId: REQUEST_ID,
    companyId: COMPANY_ID,
    kind,
    attempt: 1,
    maxAttempts: 3,
  };
}

describe("the worker on a suspended company (T122)", () => {
  it("skips the company's notification job instead of running it", async () => {
    const { ports, handlerFor, state } = createFakePorts(
      requestRow("notification.dispatch"),
      "suspended",
    );

    await createRunJob(ports, handlerFor)(attemptFor("notification.dispatch"));

    expect(state.status).toBe("skipped");
    expect(state.skipReason).toBe("company_suspended");
    expect(state.handlerRuns).toBe(0);
  });

  it("runs the company's payment settlement while it is suspended", async () => {
    // The money is already taken at the gateway: skipping the settlement would
    // lose the payment, so this kind is exempt from the suspension.
    const { ports, handlerFor, state } = createFakePorts(requestRow("payment.settle"), "suspended");

    await createRunJob(ports, handlerFor)(attemptFor("payment.settle"));

    expect(state.status).toBe("succeeded");
    expect(state.skipReason).toBeNull();
    expect(state.handlerRuns).toBe(1);
  });

  it("runs the company's webhook processing while it is suspended", async () => {
    // The stored provider callback is what schedules the settlement, so
    // dropping it would strand the payment it carries.
    const { ports, handlerFor, state } = createFakePorts(
      requestRow("webhook.process"),
      "suspended",
    );

    await createRunJob(ports, handlerFor)(attemptFor("webhook.process"));

    expect(state.status).toBe("succeeded");
    expect(state.skipReason).toBeNull();
    expect(state.handlerRuns).toBe(1);
  });

  it("runs the notification job of an active company", async () => {
    const { ports, handlerFor, state } = createFakePorts(
      requestRow("notification.dispatch"),
      "active",
    );

    await createRunJob(ports, handlerFor)(attemptFor("notification.dispatch"));

    expect(state.status).toBe("succeeded");
    expect(state.handlerRuns).toBe(1);
  });
});
