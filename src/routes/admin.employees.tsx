import { createFileRoute } from "@tanstack/react-router";

import { ModuleHeader } from "@/components/admin/Phase2Ui";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n/provider";
import { EmployeeTab } from "@/components/admin/employees/EmployeeTab";
import { SalaryTab } from "@/components/admin/employees/SalaryTab";

export const Route = createFileRoute("/admin/employees")({ component: EmployeesPage });

/**
 * شاشة الموظفين: تبويبا الموظفين والرواتب.
 *
 * Each tab is its own component in `components/admin/employees/`; this route
 * only lays them out.
 */
function EmployeesPage() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader title={t("employees.title")} subtitle={t("employees.subtitle")} />
      <Tabs defaultValue="employees" className="space-y-4">
        <TabsList>
          <TabsTrigger value="employees">{t("employees.tab")}</TabsTrigger>
          <TabsTrigger value="salaries">{t("salaries.tab")}</TabsTrigger>
        </TabsList>
        <TabsContent value="employees">
          <EmployeeTab />
        </TabsContent>
        <TabsContent value="salaries">
          <SalaryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
