import { createFileRoute } from "@tanstack/react-router";

import { respondToMyFatoorahWebhook } from "@/fns/myfatoorahWebhook";

export const Route = createFileRoute("/api/public/myfatoorah-webhook")({
  server: {
    handlers: {
      POST: ({ request }) => respondToMyFatoorahWebhook(request),
    },
  },
});
