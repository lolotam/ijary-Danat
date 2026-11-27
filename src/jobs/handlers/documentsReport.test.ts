import { beforeEach, describe, expect, test, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  scheduleSingle: vi.fn(),
  generatedInsertSingle: vi.fn(),
  generatedSelect: vi.fn(),
  generatedSingle: vi.fn(),
  notificationInsertSingle: vi.fn(),
  generatedUpdateEq: vi.fn(),
  scheduleUpdateEq: vi.fn(),
  scheduleUpdateValues: vi.fn(),
  generatedUpdateValues: vi.fn(),
  generatedInsertValues: vi.fn(),
  notificationInsertValues: vi.fn(),
  rpc: vi.fn(),
  dispatch: vi.fn(),
  renderPdf: vi.fn(),
  attachmentPayload: vi.fn(),
}));

const dbClient = {
  from: (table: string) => {
    if (table === "report_schedules") {
      return {
        select: () => ({ eq: () => ({ single: mocks.scheduleSingle }) }),
        update: (values: unknown) => {
          mocks.scheduleUpdateValues(values);
          return { eq: mocks.scheduleUpdateEq };
        },
      };
    }
    if (table === "generated_reports") {
      return {
        insert: (values: unknown) => {
          mocks.generatedInsertValues(values);
          return { select: () => ({ single: mocks.generatedInsertSingle }) };
        },
        update: (values: unknown) => {
          mocks.generatedUpdateValues(values);
          return { eq: mocks.generatedUpdateEq };
        },
        // The handler looks for a report already stored for the same schedule
        // and period end: `.eq().eq().order().limit().maybeSingle()`. The
        // resend reads one report by id: `.eq().single()`.
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({ limit: () => ({ maybeSingle: mocks.generatedSelect }) }),
            }),
            single: mocks.generatedSingle,
          }),
        }),
      };
    }
    if (table === "notifications") {
      return {
        insert: (values: unknown) => {
          mocks.notificationInsertValues(values);
          return { select: () => ({ single: mocks.notificationInsertSingle }) };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  },
  rpc: (...args: unknown[]) => mocks.rpc(...args),
};

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbClient,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/fns/dispatchNotification", () => ({
  dispatchNotificationRecord: (...args: unknown[]) => mocks.dispatch(...args),
}));

vi.mock("@/lib/reportPdfAttachment", () => ({
  renderAndStorePdf: (...args: unknown[]) => mocks.renderPdf(...args),
  attachmentPayload: (...args: unknown[]) => mocks.attachmentPayload(...args),
}));

const { createReportRunHandler, runReportScheduleRecord } = await import("./documentsReport");

const SNAPSHOT = {
  html: "<html>overdue</html>",
  period_start: "2026-09-21",
  period_end: "2026-09-28",
};

/** جدول زمني بالحالة المعطاة — البريد الوحيد الصالح هو ما يعتمد عليه التشغيل. */
function scheduleRow(reportKind: string) {
  return {
    id: "schedule-1",
    report_kind: reportKind,
    frequency: "weekly",
    locale: "ar",
    name_ar: "تقرير المتأخرات الأسبوعي",
    name_en: "Weekly Overdue Report",
    recipients: ["owner@example.com"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attachmentPayload.mockReturnValue({});
  mocks.renderPdf.mockResolvedValue(null);
  mocks.dispatch.mockResolvedValue({ id: "notification-1", state: "sent" });
  mocks.generatedInsertSingle.mockResolvedValue({
    data: { id: "generated-1" },
    error: null,
  });
  mocks.notificationInsertSingle.mockResolvedValue({
    data: { id: "notification-1" },
    error: null,
  });
  mocks.generatedUpdateEq.mockResolvedValue({ error: null });
  mocks.scheduleUpdateEq.mockResolvedValue({ error: null });
  mocks.generatedSelect.mockResolvedValue({ data: null, error: null });
  mocks.generatedSingle.mockResolvedValue({
    data: {
      id: "generated-1",
      schedule_id: "schedule-1",
      period_start: SNAPSHOT.period_start,
      period_end: SNAPSHOT.period_end,
      html_content: SNAPSHOT.html,
      locale: "ar",
    },
    error: null,
  });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "build_scheduled_report_html" || name === "build_overdue_contracts_report_html") {
      return { data: [SNAPSHOT], error: null };
    }
    return { data: null, error: null };
  });
});

describe("runReportScheduleRecord report kinds", () => {
  test("an overdue_contracts schedule builds through the overdue builder", async () => {
    mocks.scheduleSingle.mockResolvedValue({ data: scheduleRow("overdue_contracts"), error: null });

    await runReportScheduleRecord("schedule-1", null, COMPANY_ID);

    // The RPC name is the system boundary: the wrong builder would email a
    // summary titled as an overdue report.
    expect(mocks.rpc).toHaveBeenCalledWith("build_overdue_contracts_report_html", {
      p_schedule_id: "schedule-1",
      p_as_of: null,
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith("build_scheduled_report_html", expect.anything());
  });

  test("a summary schedule builds through the summary builder", async () => {
    mocks.scheduleSingle.mockResolvedValue({ data: scheduleRow("summary"), error: null });

    await runReportScheduleRecord("schedule-1", null, COMPANY_ID);

    expect(mocks.rpc).toHaveBeenCalledWith("build_scheduled_report_html", {
      p_schedule_id: "schedule-1",
      p_as_of: null,
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "build_overdue_contracts_report_html",
      expect.anything(),
    );
  });

  test("the builder snapshot flows into the generated_reports insert", async () => {
    mocks.scheduleSingle.mockResolvedValue({ data: scheduleRow("overdue_contracts"), error: null });

    await runReportScheduleRecord("schedule-1", "2026-09-28", COMPANY_ID);

    // The stored report must carry the builder's bytes, not a re-render: the
    // email body and the PDF are read from this row downstream.
    expect(mocks.generatedInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule_id: "schedule-1",
        period_start: SNAPSHOT.period_start,
        period_end: SNAPSHOT.period_end,
        html_content: SNAPSHOT.html,
      }),
    );
    expect(mocks.notificationInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ body: SNAPSHOT.html }),
    );
  });

  test("a builder error propagates and stores nothing", async () => {
    mocks.scheduleSingle.mockResolvedValue({ data: scheduleRow("overdue_contracts"), error: null });
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "build_overdue_contracts_report_html"
        ? { data: null, error: { message: "builder exploded" } }
        : { data: null, error: null },
    );

    await expect(runReportScheduleRecord("schedule-1", null, COMPANY_ID)).rejects.toThrow(
      "builder exploded",
    );
    expect(mocks.generatedInsertValues).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe("the report.run handler", () => {
  /** ما يرسله العامل إلى المعالج: الحمولة محقّقة مسبقاً بمخطط الكتالوج. */
  function jobContext(date: string) {
    return {
      jobRequestId: "33333333-3333-4333-8333-333333333333",
      companyId: COMPANY_ID,
      payload: { scheduleId: "schedule-1", date },
      attempt: 1,
    };
  }

  test("runs the schedule when no report is stored for that date", async () => {
    mocks.scheduleSingle.mockResolvedValue({ data: scheduleRow("overdue_contracts"), error: null });

    const result = await createReportRunHandler()(jobContext("2026-09-28"));

    expect(mocks.generatedInsertValues).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scheduleId: "schedule-1", date: "2026-09-28", resent: false });
  });

  test("sends the stored report again instead of generating a second one", async () => {
    // The report for that schedule and period end is already there, so the job
    // is the admin asking for it again — not a new run.
    mocks.generatedSelect.mockResolvedValue({ data: { id: "generated-1" }, error: null });
    mocks.scheduleSingle.mockResolvedValue({ data: scheduleRow("summary"), error: null });

    const result = await createReportRunHandler()(jobContext("2026-09-28"));

    expect(mocks.generatedInsertValues).not.toHaveBeenCalled();
    expect(mocks.notificationInsertValues).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ resent: true });
  });
});
