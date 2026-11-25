/**
 * @vitest-environment jsdom
 *
 * المزامنة العكسية للتأمين (تصميم البند 8، قرار D11): بعد حفظ سجل تأمين يدوي
 * (إنشاء أو تحديث) يُكتب المبلغ إلى `contracts.deposit` دون التراجع عن سجل
 * التأمين عبر دالة `sync_contract_deposit_from_insurance` (ترحيل 220)، ويُبطل
 * مفتاح `["contracts"]`. الخطأ أو غياب الصف تحذير toast فقط.
 *
 * يُحاكى عميل Supabase عند الحدّ (`@/integrations/supabase/client`) بدالة
 * `rpc()` تسجّل اسمها ووسيطاتها، ويُراقَب
 * `toast.warning` الحقيقي من `sonner`، بينما `QueryClient` حقيقي ليُثبَت
 * الإبطال فعليًا لا ادعاءً. الترجمة عبر القاموس الحقيقي لا نسخة مكتوبة يدًا.
 * نفس تقنية jsdom + createRoot + act مثل TypedText.test.tsx.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t as translate } from "@/i18n/dictionary";
import { toast } from "sonner";

const mocks = vi.hoisted(() => ({
  rpcCall: vi.fn<(fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>(),
  warning: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => mocks.rpcCall(fn, args),
  },
}));
vi.mock("sonner", () => ({
  toast: { warning: mocks.warning },
}));

// `t` تُحلّ عبر الكتالوج الحقيقي: تحذير المزامنة نصه يعيش هناك، ومعرّف `t`
// سيجعل التأكيد أدناه يقارن مفاتيح لا نصوصًا.
vi.mock("@/i18n/provider", async () => {
  const { translatorFor } = await import("@/i18n/dictionary");
  return { useI18n: () => ({ locale: "en", t: translatorFor("en") }) };
});

import { useInsuranceDepositSync } from "./useInsuranceDepositSync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.spyOn>;
let syncFn: (insuranceId: string) => Promise<void>;

/** مكوّن اختبار يلتقط دالة المزامنة ليستدعيها الاختبار. */
function Probe() {
  const { sync } = useInsuranceDepositSync();
  syncFn = sync;
  return null;
}

/**
 * يركّب المكوّن فوق مخزن استعلامات حقيقي مع جاسوس على الإبطال.
 *
 * الجاسوس على المثيل (لا على الوحدة) يُبقي السلوك الحقيقي ويُثبت أن
 * `sync` نادت الإبطال بالمفتاح الصحيح فعلًا.
 */
async function mountProbe(): Promise<void> {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

/**
 * يستدعي المزامنة داخل `act` وينتظر اكتمالها.
 *
 * الانتظار داخل `act` يضمّ تحديثات `invalidateQueries` فلا تتسرب تحذيرات
 * React خارج الاختبار.
 */
async function runSync(insuranceId = "insurance-1"): Promise<void> {
  await act(async () => {
    await syncFn(insuranceId);
  });
}

/**
 * نص التحذير المتوقع من القاموس الحقيقي.
 */
function expectedWarning(): string {
  return translate("en", "insurance.depositSyncFailed");
}

beforeEach(async () => {
  vi.clearAllMocks();
  await mountProbe();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useInsuranceDepositSync", () => {
  it("sends the saved insurance id to the audited RPC and invalidates [contracts] on success", async () => {
    mocks.rpcCall.mockResolvedValue({ data: { id: "contract-1", deposit: 500 }, error: null });

    await runSync("insurance-1");

    expect(mocks.rpcCall).toHaveBeenCalledWith("sync_contract_deposit_from_insurance", {
      p_insurance_id: "insurance-1",
    });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contracts"] });
  });

  it("warns and skips invalidation when the RPC returns an error", async () => {
    mocks.rpcCall.mockResolvedValue({ data: null, error: { message: "row-level" } });

    await runSync("insurance-1");

    expect(toast.warning).toHaveBeenCalledWith(expectedWarning());
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("warns when the RPC returns no row and no error", async () => {
    mocks.rpcCall.mockResolvedValue({ data: null, error: null });

    await runSync("insurance-1");

    expect(toast.warning).toHaveBeenCalledWith(expectedWarning());
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("warns and resolves instead of rejecting when the client throws", async () => {
    mocks.rpcCall.mockRejectedValue(new Error("network down"));

    await expect(runSync("insurance-1")).resolves.toBeUndefined();

    expect(toast.warning).toHaveBeenCalledWith(expectedWarning());
  });
});
