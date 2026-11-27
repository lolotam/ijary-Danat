import { Outlet, createFileRoute } from "@tanstack/react-router";
import { guardModuleRoute } from "@/company/requireModule";

export const Route = createFileRoute("/admin/tenants/$id")({
  beforeLoad: () => guardModuleRoute("tenants"),
  component: TenantIdLayout,
});

function TenantIdLayout() {
  return <Outlet />;
}
