import { createFileRoute } from "@tanstack/react-router";

import { respondToEvolutionWebhook } from "@/fns/evolutionWebhook";

export const Route = createFileRoute("/api/public/evolution-webhook")({
  server: { handlers: { POST: ({ request }) => respondToEvolutionWebhook(request) } },
});
