import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/tenants/$id")({
  component: TenantIdLayout,
});

function TenantIdLayout() {
  return <Outlet />;
}
