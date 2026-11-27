import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Facebook } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  whatsappCompleteEmbeddedSignup,
  whatsappEmbeddedSignupConfig,
} from "@/fns/whatsappSettings";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import { describeError } from "@/lib/toastError";
import type { EmbeddedSignupPublicConfig } from "@/whatsapp/embeddedSignup";

/*
 * زر الربط عبر فيسبوك (Meta Embedded Signup with Coexistence): يحمّل حزمة Facebook SDK
 * عند النقر، يفتح نافذة التسجيل المدمج، يلتقط `phone_number_id` و`waba_id` من حدث
 * `WA_EMBEDDED_SIGNUP`، ثم يرسل الرمز إلى الخادم لإتمام الربط. يختفي الزر إذا غابت إعدادات Meta.
 */

const FACEBOOK_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
const FACEBOOK_SDK_SCRIPT_ID = "facebook-jssdk";
const WHATSAPP_STATUS_QUERY_KEY = ["whatsapp-settings-status"] as const;
const EMBEDDED_SIGNUP_CONFIG_QUERY_KEY = ["whatsapp-embedded-signup-config"] as const;

interface FacebookLoginResponse {
  authResponse?: {
    code?: string;
  };
}

interface FacebookSdk {
  init: (params: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }) => void;
  login: (
    callback: (response: FacebookLoginResponse) => void,
    options: {
      config_id: string;
      response_type: "code";
      override_default_response_type: true;
      extras: EmbeddedSignupPublicConfig["extras"];
    },
  ) => void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

interface WhatsAppEmbeddedSignupButtonProps {
  enabled: boolean;
  disabled?: boolean;
}

interface EmbeddedSignupIds {
  phoneNumberId: string;
  wabaId: string;
}

/**
 * يقرأ ترويسة التفويض من جلسة Supabase الحالية لتمريرها إلى دوال الخادم.
 */
async function sessionHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Authentication required.");
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * يحمّل حزمة Facebook JS SDK مرة واحدة ويهيّئها بمعرّف التطبيق وإصدار Graph API.
 */
async function ensureFacebookSdk(config: EmbeddedSignupPublicConfig): Promise<FacebookSdk> {
  if (window.FB) {
    window.FB.init({
      appId: config.appId,
      autoLogAppEvents: true,
      xfbml: true,
      version: config.graphApiVersion,
    });
    return window.FB;
  }

  await new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: config.appId,
        autoLogAppEvents: true,
        xfbml: true,
        version: config.graphApiVersion,
      });
      resolve();
    };

    if (document.getElementById(FACEBOOK_SDK_SCRIPT_ID)) return;
    const script = document.createElement("script");
    script.id = FACEBOOK_SDK_SCRIPT_ID;
    script.src = FACEBOOK_SDK_URL;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Failed to load Facebook SDK."));
    document.body.appendChild(script);
  });

  if (!window.FB) {
    throw new Error("Facebook SDK did not initialize.");
  }
  return window.FB;
}

/**
 * يستخرج معرّفات واتساب من رسالة `WA_EMBEDDED_SIGNUP` الواردة من نافذة Meta.
 */
function parseEmbeddedSignupMessage(event: MessageEvent): EmbeddedSignupIds | null {
  let originHost: string;
  try {
    originHost = new URL(event.origin).hostname;
  } catch {
    return null;
  }
  // Exact host or a real subdomain: a bare suffix check would accept
  // `evilfacebook.com` and let any page post fake signup ids into this tab.
  if (originHost !== "facebook.com" && !originHost.endsWith(".facebook.com")) return null;

  let payload: unknown = event.data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  const record = payload as {
    type?: unknown;
    event?: unknown;
    data?: { phone_number_id?: unknown; waba_id?: unknown };
  };
  if (record.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (
    record.event !== "FINISH" &&
    record.event !== "FINISH_ONLY_WABA" &&
    record.event !== "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
  ) {
    return null;
  }

  const phoneNumberId = record.data?.phone_number_id;
  const wabaId = record.data?.waba_id;
  if (typeof phoneNumberId !== "string" || typeof wabaId !== "string") return null;
  if (!phoneNumberId.trim() || !wabaId.trim()) return null;

  return { phoneNumberId, wabaId };
}

/**
 * يفتح نافذة تسجيل Meta المدمج وينتظر رمز OAuth ومعرّفات الهاتف والحساب التجاري.
 */
async function launchEmbeddedSignupFlow(
  fb: FacebookSdk,
  config: EmbeddedSignupPublicConfig,
): Promise<{ code: string; phoneNumberId: string; wabaId: string }> {
  return new Promise((resolve, reject) => {
    let capturedIds: EmbeddedSignupIds | null = null;
    let capturedCode: string | null = null;
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      window.removeEventListener("message", onMessage);
    };

    const tryResolve = () => {
      if (settled || !capturedCode || !capturedIds) return;
      settled = true;
      cleanup();
      resolve({
        code: capturedCode,
        phoneNumberId: capturedIds.phoneNumberId,
        wabaId: capturedIds.wabaId,
      });
    };

    const onMessage = (event: MessageEvent) => {
      const ids = parseEmbeddedSignupMessage(event);
      if (!ids) return;
      capturedIds = ids;
      tryResolve();
    };

    window.addEventListener("message", onMessage);

    fb.login(
      (response) => {
        const code = response.authResponse?.code?.trim();
        if (!code) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error("EMBEDDED_SIGNUP_CANCELLED"));
          }
          return;
        }
        capturedCode = code;
        tryResolve();
        if (!settled) {
          fallbackTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(new Error("EMBEDDED_SIGNUP_CANCELLED"));
            }
          }, 2_000);
        }
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: config.extras,
      },
    );
  });
}

/**
 * زر "Connect with Facebook" لربط واتساب للأعمال عبر Meta Embedded Signup (Coexistence).
 */
export function WhatsAppEmbeddedSignupButton({
  enabled,
  disabled,
}: WhatsAppEmbeddedSignupButtonProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: EMBEDDED_SIGNUP_CONFIG_QUERY_KEY,
    enabled,
    retry: false,
    queryFn: async () => {
      const headers = await sessionHeaders();
      return whatsappEmbeddedSignupConfig({ data: { coexistence: true }, headers });
    },
  });

  const completeMutation = useMutation({
    mutationFn: async (config: EmbeddedSignupPublicConfig) => {
      const fb = await ensureFacebookSdk(config);
      const signup = await launchEmbeddedSignupFlow(fb, config);
      const headers = await sessionHeaders();
      return whatsappCompleteEmbeddedSignup({
        data: {
          code: signup.code,
          phoneNumberId: signup.phoneNumberId,
          wabaId: signup.wabaId,
          coexistence: true,
        },
        headers,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WHATSAPP_STATUS_QUERY_KEY });
    },
  });

  if (!configQuery.data) {
    return null;
  }

  /**
   * يبدأ تدفق التسجيل المدمج ويعرض إشعار النجاح أو الخطأ للمستخدم.
   */
  async function onConnectClick() {
    if (!configQuery.data) return;
    try {
      await completeMutation.mutateAsync(configQuery.data);
      toast.success(t("whatsappSettings.embeddedSignupConnectedToast"));
    } catch (error) {
      if (error instanceof Error && error.message === "EMBEDDED_SIGNUP_CANCELLED") {
        toast.error(t("whatsappSettings.embeddedSignupCancelledToast"));
        return;
      }
      const message = describeError(error);
      toast.error(
        message?.includes("NUMBER_IN_USE")
          ? t("whatsappSettings.embeddedSignupNumberInUseToast")
          : (message ?? t("common.error")),
      );
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled || completeMutation.isPending}
      onClick={() => void onConnectClick()}
    >
      <Facebook className="size-4" />
      {t("whatsappSettings.connectWithFacebook")}
    </Button>
  );
}
