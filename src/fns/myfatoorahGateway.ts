import { getFromMyFatoorah, postToMyFatoorah, type MyFatoorahConfig } from "@/gateways/myfatoorah";

/*
 * مسار توافق مؤقت: قراءة مفتاح ماي فاتورة من متغيرات البيئة.
 *
 * The adapter in `src/gateways/myfatoorah.ts` takes its credentials from the
 * company connection, never from the environment. Three callers still run on
 * the old path — `createPayment.ts`, `confirmGatewayPayment.ts` and
 * `paymentReconcileJob.ts` — and are rebound to the registry in T144, after
 * which this file is deleted.
 */

/** بيانات الاتصال بماي فاتورة كما يقرأها المسار القديم من البيئة. */
export type GatewayConfig = MyFatoorahConfig;

/**
 * يقرأ مفتاح البوابة ورابطها من البيئة، ويرفض الإعداد الناقص.
 *
 * A bare `fetch` has no timeout — the timeout lives in the adapter's request
 * helper, which this path now shares.
 */
export function gatewayConfigFromEnv(): GatewayConfig {
  const apiKey = process.env.MYFATOORAH_API_KEY;
  // `||`, not `??`: compose sets unset vars to "" and an empty base URL is never valid.
  const baseUrl = process.env.MYFATOORAH_BASE_URL || "https://api.myfatoorah.com";
  if (!apiKey) {
    throw new Error("MyFatoorah is not configured. Set MYFATOORAH_API_KEY.");
  }
  return { apiKey, baseUrl };
}

/** يرسل طلب POST إلى ماي فاتورة (مسار التوافق القديم). */
export const postToGateway = postToMyFatoorah;

/** يرسل طلب GET إلى ماي فاتورة (مسار التوافق القديم). */
export const getFromGateway = getFromMyFatoorah;
