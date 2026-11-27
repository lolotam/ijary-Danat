import { createFileRoute } from "@tanstack/react-router";

import { respondToResendWebhook } from "@/fns/resendWebhook";

/**
 * يستقبل أحداث تسليم البريد من المُرسِل الافتراضي للمنصة.
 *
 * The platform's default sender serves every company that has no sender of
 * its own, so its deliveries all arrive here and the company behind a
 * message is only known from the message id. The signature is verified with
 * the platform's own secret, which is what tells a platform delivery apart
 * from a company's.
 */
export async function handlePlatformResendWebhook(request: Request): Promise<Response> {
  return respondToResendWebhook(request, { kind: "platform" });
}

export const Route = createFileRoute("/api/public/webhooks/resend-platform")({
  server: {
    handlers: {
      POST: ({ request }) => handlePlatformResendWebhook(request),
    },
  },
});
