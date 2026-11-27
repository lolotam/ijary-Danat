/**
 * @vitest-environment jsdom
 *
 * مسار تأكيد الإيداع في useDeposits لا يرسل أي إشعار بنفسه.
 *
 * T072b: the `deposit.confirmed` job (enqueued by the SQL function in migration
 * 308) owns the deposit-confirmed send, so the hook's old direct call to the
 * notify server fn was a second send path for one event. Every variant of the
 * confirm path — created already confirmed, or updated to confirmed — must
 * reach the write and the audit row but never the notify boundary. A
 * reintroduced direct call fails these tests.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CreateDepositInput, Deposit, UpdateDepositInput } from "@/hooks/useDeposits";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const from = vi.hoisted(() => vi.fn());
const auditSpy = vi.hoisted(() => vi.fn(async () => ({ id: "audit-1" })));
const notifyFnSpy = vi.hoisted(() => vi.fn());
const notifyRecordSpy = vi.hoisted(() => vi.fn());

vi.mock("@/auth/AuthProvider", () => ({ useAuth: () => ({ user: { id: "staff-1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => from(table),
    auth: {
      getUser: async () => ({ data: { user: { id: "staff-1" } } }),
      getSession: async () => ({ data: { session: { access_token: "test-token" } } }),
    },
  },
}));
vi.mock("@/fns/audit", () => ({ logAudit: auditSpy }));
// حدّ الإرسال الذي تغلّفه دوال الإشعار: مسار التأكيد في الهوك لا يعبره بعد T072،
// والمحاكاة هنا تفشل الاختبار لو أُعيد استدعاء الدوال مباشرة من الهوك.
vi.mock("@/fns/notifyDepositConfirmed", () => ({
  notifyDepositConfirmed: notifyFnSpy,
  notifyDepositConfirmedRecord: notifyRecordSpy,
}));

const { useCreateDeposit, useUpdateDeposit } = await import("@/hooks/useDeposits");

const confirmedRow = {
  id: "deposit-1",
  status: "confirmed",
  attachment_path: null,
} as Deposit;
const pendingRow = { id: "deposit-1", status: "pending", attachment_path: null } as Deposit;

const createInput: CreateDepositInput = {
  amount: 250,
  bank_name: "NBK",
  currency: "KWD",
  deposit_date: "2026-11-20",
  code: "DEP-1",
  deposit_type: "cheque",
  status: "confirmed",
};

const updateInput: { id: string; updates: UpdateDepositInput } = {
  id: "deposit-1",
  updates: { status: "confirmed" },
};

let mutations: {
  create: ReturnType<typeof useCreateDeposit>;
  update: ReturnType<typeof useUpdateDeposit>;
};
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

/** مكوّن يلتقط كائنات الخطّافات عند الرسم لأن التخطيط التفاعلي هو المطلوب. */
function Probe() {
  mutations = {
    create: useCreateDeposit(),
    update: useUpdateDeposit(),
  };
  return null;
}

/**
 * يركّب الخطّافات داخل مزوّد حقيقي لـ React Query.
 *
 * `usePermissions` stays real: seeding `["my-roles", "staff-1"]` as admin is
 * what lets `can()` pass without extra queries, so the permission gate in the
 * mutation is exercised, not skipped.
 */
function mount() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["my-roles", "staff-1"], ["admin"]);
  queryClient.setQueryData(["deposits"], { items: [], count: 0 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
}

/** منشئ PostgREST وهمي: كل مرشّح يعيد `this`، و`single()` تحلّ بالنتيجة. */
function stub(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "insert", "update"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(() => Promise.resolve(result));
  return builder;
}

beforeEach(() => {
  from.mockReset();
  auditSpy.mockClear();
  notifyFnSpy.mockClear();
  notifyRecordSpy.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("the deposit confirm path reaches no notify boundary", () => {
  test.each([
    {
      label: "creating a deposit already confirmed",
      runConfirm: () => {
        from.mockReturnValueOnce(stub({ data: confirmedRow, error: null }));
        return mutations.create.mutateAsync(createInput);
      },
    },
    {
      label: "updating a deposit from pending to confirmed",
      runConfirm: () => {
        from
          .mockReturnValueOnce(stub({ data: pendingRow, error: null }))
          .mockReturnValueOnce(stub({ data: confirmedRow, error: null }));
        return mutations.update.mutateAsync(updateInput);
      },
    },
  ])("$label sends nothing to the notify fn", async ({ runConfirm }) => {
    mount();

    let resolved: unknown;
    await act(async () => {
      resolved = await runConfirm();
    });

    // الشاهد: الكتابة وصف التدقيق تمّا فعلاً، فالامتناع عن الإرسال اختيار لا صدفة.
    expect(resolved).toMatchObject({ id: "deposit-1", status: "confirmed" });
    expect(auditSpy).toHaveBeenCalled();
    expect(from).toHaveBeenCalled();
    expect(notifyFnSpy).not.toHaveBeenCalled();
    expect(notifyRecordSpy).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(["deposits"])?.isInvalidated).toBe(true);
  });
});
