import { createFileRoute } from "@tanstack/react-router";

import { handleMetaWebhookGet, handleMetaWebhookPost } from "@/whatsapp/routing";

/*
 * مسار ويب هوك Meta Cloud API العام: التحقق من الاشتراك (GET) واستقبال الأحداث (POST).
 */

export const Route = createFileRoute("/api/public/webhooks/meta")({
  server: {
    handlers: {
      GET: ({ request }) => handleMetaWebhookGet(request),
      POST: ({ request }) => handleMetaWebhookPost(request),
    },
  },
});
