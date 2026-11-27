import type {
  GatewayAdapterFactory,
  GatewayConnection,
  GatewayProvider,
  PaymentGateway,
} from "./types";
import { GATEWAY_PROVIDERS } from "./types";

/*
 * سجل محولات بوابات الدفع: خريطة مفتاح المزوّد إلى مصنع المحول،
 * وبحث يرمي خطأً مطبّعاً لكل مفتاح غير معروف أو بلا محول بعد.
 */

/** رموز أخطاء سجل البوابات القياسية. */
export const GATEWAY_REGISTRY_ERROR_CODES = ["UNKNOWN_PROVIDER", "NO_ADAPTER"] as const;

export type GatewayRegistryErrorCode = (typeof GATEWAY_REGISTRY_ERROR_CODES)[number];

/**
 * خطأ موحّد لسجل البوابات: مزوّد غير معروف، أو مزوّد معروف بلا محول مسجّل له بعد.
 */
export class GatewayRegistryError extends Error {
  readonly code: GatewayRegistryErrorCode;
  /** مفتاح المزوّد المطلوب؛ ليس سراً فيصلح للرسالة والتشخيص. */
  readonly provider: string;

  /** ينشئ خطأ سجل بوابات برمز قياسي ومفتاح المزوّد المطلوب. */
  constructor(code: GatewayRegistryErrorCode, provider: string) {
    const message =
      code === "UNKNOWN_PROVIDER"
        ? `Unknown payment gateway provider: ${provider}`
        : `No gateway adapter is registered for provider: ${provider}`;
    super(message);
    this.name = "GatewayRegistryError";
    this.code = code;
    this.provider = provider;
  }
}

/** خريطة مفتاح المزوّد إلى مصنع المحول؛ مفتاح غير موجود يعني عدم وجود محول لهذا المزوّد بعد. */
export type GatewayFactoryMap = Partial<Record<GatewayProvider, GatewayAdapterFactory>>;

/** سجل بوابات الدفع: بحث عن مصنع المحول وبناء المحول لاتصال معيّن. */
export interface GatewayRegistry {
  /** يعيد مصنع المحول للمزوّد، أو يرمي GatewayRegistryError لمفتاح غير معروف أو بلا محول. */
  getFactory(provider: string): GatewayAdapterFactory;
  /** يبني محول البوابة لاتصال معيّن بأسراره المفكوكة. */
  create(connection: GatewayConnection): PaymentGateway;
}

/**
 * ينشئ سجل بوابات فوق خريطة مصّنّعات —
 * الفصل بين الخريطة والبحث يسمح باختبار البحث بمحول وهمي دون مساس بالسجل الإنتاجي.
 */
export function createGatewayRegistry(factories: GatewayFactoryMap): GatewayRegistry {
  /**
   * يتحقق من أن المفتاح واحداً من مفاتيح المزوّدين المعروفين.
   */
  function isGatewayProvider(provider: string): provider is GatewayProvider {
    return (GATEWAY_PROVIDERS as readonly string[]).includes(provider);
  }

  /**
   * يبحث في الخريطة عن مصنع محول المزوّد؛ مفتاح مجهول أو بلا محول يرمي خطأً مطبّعاً.
   */
  function getFactory(provider: string): GatewayAdapterFactory {
    if (!isGatewayProvider(provider)) {
      throw new GatewayRegistryError("UNKNOWN_PROVIDER", provider);
    }
    const factory = factories[provider];
    if (!factory) {
      throw new GatewayRegistryError("NO_ADAPTER", provider);
    }
    return factory;
  }

  return {
    getFactory,
    create(connection: GatewayConnection): PaymentGateway {
      return getFactory(connection.provider)(connection);
    },
  };
}

/**
 * خريطة المحولات الإنتاجية: يُضاف مفتاح كل مزوّد هنا عند بناء محوله،
 * وهي فارغة حتى تُبنى المحولات (T143 وما بعدها).
 */
export const GATEWAY_FACTORIES: GatewayFactoryMap = {};

/** السجل الإنتاجي فوق خريطة المحولات الإنتاجية. */
export const gatewayRegistry = createGatewayRegistry(GATEWAY_FACTORIES);
