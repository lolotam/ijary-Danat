import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { loadPaymentReturnState } from "@/fns/paymentReturnPage.server";

const returnInputSchema = z.object({
  paymentRequestCode: z.string().min(1).max(40),
  paymentId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[0-9A-Za-z-]+$/, "Invalid payment reference.")
    .optional(),
});

/** نتيجة صفحة عودة الدفع الخالية من الجلسة: مدفوع أو معلّق أو فاشل أو غير موجود أو خطأ. */
export type PaymentReturnState =
  | { status: "paid"; code: string }
  | { status: "pending"; code: string }
  | { status: "failed"; code: string }
  | { status: "not_found" }
  | { status: "error"; code: string };

/**
 * دالة خادم خالية من الجلسة تؤكد حالة الدفع لصفحة العودة المربوطة برمز الطلب والشركة.
 */
export const confirmPaymentReturnPage = createServerFn({ method: "POST" })
  .inputValidator(returnInputSchema)
  .handler(async ({ data }): Promise<PaymentReturnState> => {
    return loadPaymentReturnState({
      preq: data.paymentRequestCode,
      paymentId: data.paymentId,
    });
  });
