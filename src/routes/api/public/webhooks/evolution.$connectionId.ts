import { createFileRoute } from "@tanstack/react-router";

import { respondToEvolutionWebhook } from "@/fns/evolutionWebhook.server";

export const Route = createFileRoute("/api/public/webhooks/evolution/$connectionId")({
  server: {
    handlers: {
      POST: ({ request, params }) => respondToEvolutionWebhook(request, params.connectionId),
    },
  },
});
