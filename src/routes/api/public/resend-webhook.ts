import { createFileRoute } from "@tanstack/react-router";

import { respondToResendWebhook } from "@/fns/resendWebhook";

export const Route = createFileRoute("/api/public/resend-webhook")({
  server: {
    handlers: {
      POST: ({ request }) => respondToResendWebhook(request),
    },
  },
});
