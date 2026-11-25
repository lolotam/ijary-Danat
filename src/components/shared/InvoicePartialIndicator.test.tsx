/**
 * @vitest-environment jsdom
 *
 * مؤشر الدفع الجزئي (تصميم البند 10، قرار D1): يظهر نص "مدفوعة جزئيًا ·
 * {paid} / {total}" فقط عندما تكون الفاتورة `due` أو `overdue` وفيها تحصيل
 * ناقص (`paid > 0 && paid < total`).
 *
 * تُبنى السلسلة المتوقعة من القاموس الحقيقي (`t`) ودالة العرض الحقيقية
 * (`formatAmount`) — لا نسخ مكتوبة يدًا — ويُركَّب المكوّن داخل `I18nProvider`
 * الحقيقي، فيفشل أي اختبار هنا لو حُذف المكوّن أو تغيّر شرط ظهوره.
 * نفس تقنية jsdom + createRoot + act مثل TypedText.test.tsx؛ لا توجد
 * testing-library في هذا المستودع.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCALE_STORAGE_KEY, t as translate } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";
import { formatAmount } from "@/lib/money";

import { InvoicePartialIndicator } from "./InvoicePartialIndicator";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * يركّب المؤشر داخل مزوّد i18n الحقيقي باللغة الإنجليزية وينتظر استقرار المؤثرات.
 *
 * تُضبط اللغة عبر `localStorage` قبل التركيب لأن المزوّد يقرأ التفضيل
 * المخزّن في مؤثر ما بعد التهيئة؛ الانتظار غير المتزامن هو ما يجعل القراءة
 * اللاحقة للنص حتمية.
 */
async function mountIndicator(state: string, paid: number, total: number): Promise<void> {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  await act(async () => {
    root.render(
      <I18nProvider>
        <InvoicePartialIndicator state={state} paid={paid} total={total} />
      </I18nProvider>,
    );
  });
  localStorage.removeItem(LOCALE_STORAGE_KEY);
}

/**
 * يبني النص المتوقع من القاموس الحقيقي ودالة تنسيق المبالغ الحقيقية.
 *
 * يعيد إنتاج نفس الاستبدال الذي يجريه المكوّن (`{paid}` و`{total}`)، فأي
 * تغيير في مفتاح الترجمة أو صيغته يكسر الاختبار بدل أن يقارن ضد نسخة قديمة.
 */
function expectedIndicator(paid: number, total: number): string {
  return translate("en", "invoices.partiallyPaidIndicator")
    .replace("{paid}", formatAmount(paid, "en"))
    .replace("{total}", formatAmount(total, "en"));
}

describe("InvoicePartialIndicator", () => {
  it("shows both amounts for a due invoice with 0 < paid < total", async () => {
    await mountIndicator("due", 350, 700);

    expect(container.textContent).toContain(expectedIndicator(350, 700));
  });

  it("shows both amounts for an overdue invoice with 0 < paid < total", async () => {
    await mountIndicator("overdue", 350, 700);

    expect(container.textContent).toContain(expectedIndicator(350, 700));
  });

  it("renders nothing when nothing has been paid yet", async () => {
    await mountIndicator("due", 0, 700);

    expect(container.textContent).toBe("");
  });

  it("renders nothing when the invoice is fully paid", async () => {
    await mountIndicator("due", 700, 700);

    expect(container.textContent).toBe("");
  });

  it.each(["paid", "partially_paid", "cancelled", "waived"])(
    "renders nothing for state %s even with 0 < paid < total",
    async (state) => {
      await mountIndicator(state, 350, 700);

      expect(container.textContent).toBe("");
    },
  );
});
