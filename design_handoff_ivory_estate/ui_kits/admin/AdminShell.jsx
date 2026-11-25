const { Button, SidebarNav, Logo, Icon } = window.DanatAlMustaqbalDesignSystem_110f06;
const moduleLabels = {
  dashboard: "لوحة التحكم",
  invoices: "فواتير الإيجار",
  tenants: "المستأجرون",
  properties: "العقارات والمباني",
  units: "الوحدات",
  contracts: "العقود",
  payments: "المدفوعات",
  deposits: "الإيداعات البنكية",
  expenses: "المصروفات",
  electricity: "الكهرباء",
  reports: "التقارير",
  audit: "سجل التدقيق",
  settings: "إعدادات الشركة والنظام",
};
function AdminShell() {
  const [screen, setScreen] = React.useState("invoices");
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div dir="rtl" style={{ display: "flex", minHeight: "100vh", width: "100%" }}>
      {!collapsed && (
        <SidebarNav activeKey={screen} onNavigate={setScreen} className="admin-sidebar" />
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header
          style={{
            height: 56,
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px",
            gap: 8,
            background: "var(--background)",
            position: "sticky",
            top: 0,
            zIndex: 30,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button variant="ghost" size="icon" onClick={() => setCollapsed(!collapsed)}>
              <Icon name="panel-right" />
            </Button>
            <Logo src="../../assets/logo.png" size={32} subName={null} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              style={{
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border)",
                background: "none",
                padding: "4px 12px",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              English
            </button>
            <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>مرحبًا بك، admin</span>
            <Button variant="outline" size="sm">
              تسجيل الخروج
            </Button>
          </div>
        </header>
        <main style={{ flex: 1, padding: 24 }}>
          {screen === "dashboard" ? (
            <AdminDashboard />
          ) : screen === "invoices" ? (
            <AdminInvoices />
          ) : (
            <ModulePlaceholder title={moduleLabels[screen]} />
          )}
        </main>
      </div>
    </div>
  );
}
window.AdminShell = AdminShell;
