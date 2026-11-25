import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsPanel } from "@/components/admin/WorkflowsPanel";

// The screen itself lives in WorkflowsPanel, because it also renders as the
// Workflows tab of the Automations screen. This route stays for existing links;
// it is no longer listed in the settings nav.
export const Route = createFileRoute("/admin/settings/cron")({ component: WorkflowsPanel });
