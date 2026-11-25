const {
  Card,
  Badge,
  Button,
  PortalNav,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Logo,
  Icon,
  Progress,
} = window.DanatAlMustaqbalDesignSystem_110f06;
const invoices = [
  { id: "INV-2026-0344", month: "يوليو 2026", amount: "210.000", status: "pending" },
  { id: "INV-2026-0298", month: "يونيو 2026", amount: "210.000", status: "paid" },
  { id: "INV-2026-0251", month: "مايو 2026", amount: "210.000", status: "paid" },
];
function PStatus({ s }) {
  return s === "paid" ? (
    <Badge variant="success">مدفوعة</Badge>
  ) : (
    <Badge variant="secondary">قيد السداد</Badge>
  );
}
function PortalDashboard() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
        <Card style={{ padding: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--muted-foreground)",
            }}
          >
            <Icon name="file-text" size={14} /> فاتورة يوليو
          </div>
          <div style={{ marginTop: 8, fontSize: 28, fontWeight: 700 }} dir="ltr">
            210.000 <span style={{ fontSize: 13, fontWeight: 400 }}>د.ك</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button size="sm">ادفع الآن</Button>
          </div>
        </Card>
        <Card style={{ padding: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--muted-foreground)",
            }}
          >
            <Icon name="building-2" size={14} /> وحدتي
          </div>
          <div style={{ marginTop: 8, fontSize: 16, fontWeight: 600 }}>عمارة الجابرية — C-02</div>
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted-foreground)" }}>
            عقد سنوي حتى 2027-03-31
          </div>
        </Card>
        <Card style={{ padding: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--muted-foreground)",
            }}
          >
            <Icon name="scroll-text" size={14} /> مدة العقد المتبقية
          </div>
          <div style={{ marginTop: 12 }}>
            <Progress value={71} />
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted-foreground)" }}>
            8 أشهر متبقية من 12
          </div>
        </Card>
      </div>
      <Card style={{ padding: "8px 20px 16px" }}>
        <div style={{ fontWeight: 600, padding: "12px 0 4px" }}>أحدث الفواتير</div>
        <InvoiceList rows={invoices} />
      </Card>
    </div>
  );
}
function InvoiceList({ rows }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>رقم الفاتورة</TableHead>
          <TableHead>الشهر</TableHead>
          <TableHead>المبلغ (د.ك)</TableHead>
          <TableHead>الحالة</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell dir="ltr" style={{ fontWeight: 500 }}>
              {r.id}
            </TableCell>
            <TableCell>{r.month}</TableCell>
            <TableCell dir="ltr">{r.amount}</TableCell>
            <TableCell>
              <PStatus s={r.status} />
            </TableCell>
            <TableCell>
              {r.status !== "paid" && (
                <Button size="sm" variant="outline">
                  ادفع
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
function Portal() {
  const [screen, setScreen] = React.useState("dashboard");
  return (
    <div
      dir="rtl"
      style={{ minHeight: "100vh", background: "color-mix(in oklab,var(--muted) 30%,transparent)" }}
    >
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          borderBottom: "1px solid var(--border)",
          background: "color-mix(in oklab,var(--background) 95%,transparent)",
          backdropFilter: "blur(8px)",
        }}
      >
        <div
          style={{
            margin: "0 auto",
            display: "flex",
            maxWidth: 1280,
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 16px",
          }}
        >
          <Logo
            src="../../assets/logo.png"
            size={40}
            name="دانة المستقبل العقارية"
            subName="يوسف المطيري"
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="outline" size="sm">
              English
            </Button>
            <Button variant="ghost" size="sm">
              تسجيل الخروج
            </Button>
          </div>
        </div>
        <div style={{ margin: "0 auto", maxWidth: 1280, padding: "0 16px 12px" }}>
          <PortalNav
            activeKey={screen}
            onNavigate={(k) => setScreen(k === "invoices" ? "invoices" : "dashboard")}
          />
        </div>
      </header>
      <main style={{ margin: "0 auto", maxWidth: 1280, padding: 24 }}>
        {screen === "invoices" ? (
          <Card style={{ padding: "8px 20px 16px" }}>
            <div style={{ fontWeight: 600, padding: "12px 0 4px" }}>فواتيري</div>
            <InvoiceList rows={invoices} />
          </Card>
        ) : (
          <PortalDashboard />
        )}
      </main>
    </div>
  );
}
window.Portal = Portal;
