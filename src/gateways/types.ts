import type { EventDetails } from "@/fns/gatewaySettlementReads";
import type { GatewayPaymentMethod, Json } from "@/integrations/supabase/database.types";

/*
 * عقد بوابة الدفع الموحّد: المدخلات والمخرجات التي تشترك فيها كل بوابة.
 *
 * Grounded in research.md R14 and in what the MyFatoorah flow already does
 * (`createPayment`, `confirmGatewayPayment`, `myfatoorahWebhook`); Tap and
 * UPayments map onto the same contract when their adapters land. Nothing here
 * is speculative: every shape below mirrors an existing column, an existing
 * normalised type, or a contract line in specs/001-multi-company-saas.
 */

/** مزوّدو بوابات الدفع المسموحون بمفتاح كل منهم كما يُخزَّن في `gateway_connections.provider`. */
export const GATEWAY_PROVIDERS = ["myfatoorah", "tap", "upayments"] as const;

export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];

/** وضع الاتصال: بيانات الاختبار أو بيانات التشغيل الحيّ (`gateway_connections.mode`). */
export type GatewayMode = "test" | "live";

/**
 * الحالة المطبّعة لنتيجة دفعة لدى أي بوابة.
 *
 * The same three values `paymentOutcome()` classifies into today; the
 * settlement paths converge on this vocabulary so the portal, the webhook and
 * the reconciliation job cannot disagree about what "paid" means.
 */
export type GatewayPaymentOutcome = "paid" | "pending" | "failed";

/** اتصال بوابة بعد فك تشفير أسراره: المزوّد والوضع والقيم السرية بالإسم والإعدادات غير السرية. */
export interface GatewayConnection {
  provider: GatewayProvider;
  mode: GatewayMode;
  /** قيم `company_secrets` بعد فك التشفير، مفتاحها هو `name` في الجدول. */
  credentials: Record<string, string>;
  /** `gateway_connections.public_config`، مثل الوسائل المفعّلة. */
  publicConfig: Json;
}

/** طلب إنشاء دفعة مستضافة، كما يستخدمه النطاق الحالي في `createPayment`. */
export interface CreateGatewayPaymentInput {
  /** المبلغ بالدينار الكويتي بثلاث خانات عشرية؛ كل محول يحوّله إلى دقة مزوّده (VERIFY، R14). */
  amount: number;
  /** رمز طلب الدفع، يُرسل للمزوّد كمرجع ويُقرأ من الويب هوك لاحقاً. */
  paymentRequestCode: string;
  /** رابط العودة إلى التطبيق بعد إتمام أو إلغاء الدفع. */
  redirectUrl: string;
  /** اسم الدافع كما يظهر لدى المزوّد. */
  customerName: string;
  /** معرّف الدافع الداخلي (الساكن)، يُخزَّن ميداناً معرفاً لدى المزوّد إن دعمه. */
  customerReference: string;
  /**
   * تثبيت وسيلة دفع واحدة (مثل knet) بدل عرض كل المفعّلة؛
   * المحول وحده يملك التهجئة التي يقبلها مزوّده (مثل KNET).
   */
  method?: GatewayPaymentMethod;
}

/** نتيجة إنشاء الدفعة: رابط الدفع ومعرّفات الفاتورة والدفعة لدى المزوّد، بالحقول التي تحفظها `payment_requests`. */
export interface CreatedGatewayPayment {
  paymentUrl: string;
  providerInvoiceId: string | null;
  providerPaymentId: string | null;
  requestPayload: Json;
  gatewayResponse: Json;
}

/** استعلام حالة الدفع: معرّف الفاتورة أو معرّف الدفعة لدى المزوّد، وأحدهما على الأقل غير فارغ. */
export interface GatewayPaymentStatusQuery {
  providerInvoiceId: string | null;
  providerPaymentId: string | null;
}

/** حالة الدفعة المطبّعة من المزوّد، مع الحالتين الخامّتين لأي سبب وتشخيص. */
export interface GatewayPaymentStatus {
  outcome: GatewayPaymentOutcome;
  method: GatewayPaymentMethod | null;
  providerInvoiceId: string | null;
  providerPaymentId: string | null;
  /** سبب المزوّد لدفعة غير مدفوعة، مثل "MF020: …"؛ لا يظهر للدافع كما هو. */
  error: string | null;
  raw: Json;
}

/** مدخلات التحقق من توقيع ويب هوك وارد. */
export interface VerifyWebhookInput {
  /** جسم الطلب الخام كما ورد بالحرف. */
  rawBody: string;
  /** ترويسات الطلب بأسمائها الصغيرة؛ توقيع المزوّد يأتي في إحداها. */
  headers: Record<string, string>;
  /**
   * عنوان الطلب كاملاً: UPayments قد يرسل رمزه في سلسلة الاستعلام
   * بدل التوقيع (contracts/webhooks.md: "signature or token").
   */
  url: string;
  /** سر الويب هوك الخاص بهذا الاتصال بعد فك التشفير. */
  secret: string;
}

/** نتيجة التحقق: `valid: false` للتوقيع غير الصالح، والمسار يستجيب ويخزّن الحدث دون معالجة. */
export interface WebhookVerification {
  valid: boolean;
}

/** مدخلات تحويل ويب هوك خام إلى حدث مطبّع. */
export interface ParseWebhookInput {
  rawBody: string;
}

/**
 * الحدث المطبّع الذي تستقبله `settleGatewayPayment` مهما كان مصدره
 * (ويب هوك، صفحة عودة، أو مطابقة دورية).
 */
export type GatewayWebhookEvent = EventDetails;

/** نتيجة اختبار الاتصال، تُخزَّن على `gateway_connections` (`last_test_ok`, `last_test_message`). */
export interface GatewayTestResult {
  ok: boolean;
  message: string;
}

/**
 * محول بوابة الدفع: كل ما تحتاجه البوابة من مزوّد واحد.
 *
 * Adapters own the provider's wire format; callers own storage and
 * settlement. `settleGatewayPayment` stays the single settlement function
 * (R14) and receives the normalised shapes returned here.
 */
export interface PaymentGateway {
  /** الوسائل التي يدعمها المزوّد؛ ما يفعّله العميل منها يُقرأ من `public_config` للاتصال. */
  readonly supportedMethods: readonly GatewayPaymentMethod[];

  /** ينشئ دفعة مستضافة ويعيد رابط الدفع ومعرّفاتها لدى المزوّد. */
  createPayment(input: CreateGatewayPaymentInput): Promise<CreatedGatewayPayment>;

  /** يجلب حالة الدفعة من المزوّد ويعيدها بالحالة المطبّعة (`paid` أو `pending` أو `failed`). */
  getPaymentStatus(input: GatewayPaymentStatusQuery): Promise<GatewayPaymentStatus>;

  /** يتحقق من توقيع الويب هوك بسر الاتصال؛ توقيع غير صالح يعيد `valid: false` لا خطأً. */
  verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerification>;

  /** يحوّل جسم ويب هوك خام إلى الحدث المطبّع للتسوية. */
  parseWebhook(input: ParseWebhookInput): Promise<GatewayWebhookEvent>;

  /** يختبر بيانات الاتصال بطلب خفيف لدى المزوّد؛ نجاحته شرط التفعيل (FR-055). */
  testConnection(): Promise<GatewayTestResult>;
}

/** مصنع محول بوابة: يبني محولاً مربوطاً باتصال واحد بأسراره المفكوكة. */
export type GatewayAdapterFactory = (connection: GatewayConnection) => PaymentGateway;
