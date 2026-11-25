import { createFileRoute } from "@tanstack/react-router";

import { respondToCronRequest } from "@/fns/cronJobs";

export const Route = createFileRoute("/api/public/cron")({
  server: {
    handlers: {
      POST: ({ request }) => respondToCronRequest(request),
    },
  },
});
