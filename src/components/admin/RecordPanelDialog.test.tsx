/**
 * @vitest-environment jsdom
 *
 * مساعد الدفعة الجزئية في نافذة السجل (تصميم البند 10): عند اختيار فاتورة
 * رصيدها 350 وإجماليها 700 يعرض الحوار إجمالي الفاتورة والرصيد المتبقي
 * ومساعد "أدخل مبلغًا حتى {max}"؛ وفي وضع التحرير يكون الوسم وسم "الحد
 * الأقصى".
 *
 * يُركَّب الحوار الكامل (`RecordPanelDialog`) داخل `I18nProvider` الحقيقي
 * و`QueryClientProvider` حقيقي — محتوى Radix Dialog يخرج عبر portal إلى
 * `document.body` لذا تُقرأ النصوص من هناك. الإجمالي معروف في القائمة فيبقى
 * استعلام الجلب معطّلًا، ويُحاكى عميل Supabase لإثبات أنه لم يُستدعَ.
 * كل النصوص المتوقعة من القاموس الحقيقي (`t`) ودالة العرض الحقيقية
 * (`formatAmount`)، لا نسخ مكتوبة يدًا. نفس تقنية jsdom + createRoot + act
 * مثل TypedText.test.tsx؛ لا توجد testing-library في هذا المستودع.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_STORAGE_KEY, t as translate } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";
import { formatAmount } from "@/lib/money";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => mocks.from(...args),
  },
}));

import { RecordPanelDialog, type SettleableInvoiceOption } from "./RecordPanelDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/**
 * فاتورة قابلة للتسوية برصيد 350 وإجمالي 700 — أرقام البند 10 في التصميم.
 *
 * إرفاق `total` مع الصف هو ما يجعل `knownPickedTotal` يحسم الإجمالي محليًا
 * ويُبقي استعلام `usePickedInvoiceTotal` معطّلًا، فيُختبر المساعد وحده دون
 * شبكة.
 */
function pickedInvoice(): SettleableInvoiceOption {
  return {
    id: "inv-1",
    code: "INV-0007725",
    balance: 350,
    total: 700,
    period_month: 9,
    period_year: 2026,
    state: "due",
  };
}

/**
 * يركّب حوار السجل بالإنجليزية مع الفاتورة مختارة وينتظر استقرار المؤثرات.
 *
 * يمرَّر `remaining` مشتقًا ضمنيًا من القائمة (لا تجاوز صريح) لإثبات أن
 * الاختيار وحده هو ما يملأ الرصيد المتبقي.
 */
async function mountDialog(editing: boolean): Promise<void> {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <RecordPanelDialog
            open
            onOpenChange={vi.fn()}
            editing={editing}
            title="Record partial payment"
            description="Link a partial payment to an invoice"
            contractId="contract-1"
            contractOptions={[{ label: "Contract 1", tenantId: "tenant-1", value: "contract-1" }]}
            lockContract={false}
            onContractChange={vi.fn()}
            amount=""
            onAmountChange={vi.fn()}
            date="2026-09-23"
            onDateChange={vi.fn()}
            note=""
            onNoteChange={vi.fn()}
            invoiceField
            invoiceId="inv-1"
            invoices={[pickedInvoice()]}
            onInvoiceChange={vi.fn()}
            statusField={false}
            status="incomplete"
            onStatusChange={vi.fn()}
            pending={false}
            onSubmit={vi.fn()}
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
  });
  localStorage.removeItem(LOCALE_STORAGE_KEY);
}

/**
 * نص الصفحة الكامل بعد خروج الـ portal — الحوار لا يعيش داخل الحاوية.
 */
function bodyText(): string {
  return document.body.textContent ?? "";
}

describe("RecordPanelDialog partial-payment helper", () => {
  it("shows the invoice total 700, the remaining balance 350, and the up-to-350 hint", async () => {
    await mountDialog(false);
    const body = bodyText();

    expect(body).toContain(
      `${translate("en", "invoiceDocument.invoiceTotal")}: ${formatAmount(700, "en")}`,
    );
    expect(body).toContain(
      `${translate("en", "partialPayments.remainingBalance")}: ${formatAmount(350, "en")}`,
    );
    expect(body).toContain(
      translate("en", "partialPayments.amountHint").replace("{max}", formatAmount(350, "en")),
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("labels the remaining amount with the maximum label in edit mode", async () => {
    await mountDialog(true);
    const body = bodyText();

    expect(body).toContain(
      `${translate("en", "partialPayments.maxForEdit")}: ${formatAmount(350, "en")}`,
    );
    expect(body).not.toContain(translate("en", "partialPayments.remainingBalance"));
  });
});
