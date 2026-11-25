const {
  Card,
  Badge,
  Button,
  Input,
  Label,
  Select,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Icon,
} = window.DanatAlMustaqbalDesignSystem_110f06;
function StatusBadge({ s }) {
  return s === "paid" ? (
    <Badge variant="success">مدفوعة</Badge>
  ) : s === "overdue" ? (
    <Badge variant="destructive">متأخرة</Badge>
  ) : (
    <Badge variant="secondary">قيد السداد</Badge>
  );
}
function AdminDashboard() {
  return (
    <div style={{ display: "grid", gap: 32 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>لوحة التحكم</h1>
        <p style={{ margin: "4px 0 0", fontSize: 14, color: "var(--muted-foreground)" }}>
          نظرة عامة على المؤشرات الرئيسية.
        </p>
      </div>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(4,1fr)" }}>
        {window.adminData.stats.map((c) => (
          <Card key={c.label} style={{ padding: 20 }}>
            <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{c.label}</div>
            <div style={{ marginTop: 8, fontSize: 30, fontWeight: 700 }}>{c.value}</div>
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted-foreground)" }}>
              {c.sub}
            </div>
          </Card>
        ))}
      </div>
      <Card style={{ padding: 24 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>أحدث الفواتير</div>
        <InvoiceTable rows={window.adminData.invoices.slice(0, 4)} />
      </Card>
    </div>
  );
}
function InvoiceTable({ rows }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>رقم الفاتورة</TableHead>
          <TableHead>المستأجر</TableHead>
          <TableHead>الوحدة</TableHead>
          <TableHead>المبلغ (د.ك)</TableHead>
          <TableHead>الاستحقاق</TableHead>
          <TableHead>الحالة</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell style={{ fontWeight: 500 }} dir="ltr">
              {r.id}
            </TableCell>
            <TableCell>{r.tenant}</TableCell>
            <TableCell>{r.unit}</TableCell>
            <TableCell dir="ltr">{r.amount}</TableCell>
            <TableCell dir="ltr">{r.due}</TableCell>
            <TableCell>
              <StatusBadge s={r.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
function AdminInvoices() {
  const [filter, setFilter] = React.useState("all");
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const rows = window.adminData.invoices.filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      (q === "" || r.tenant.includes(q) || r.id.includes(q)),
  );
  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>فواتير الإيجار</h1>
          <p style={{ margin: "4px 0 0", fontSize: 14, color: "var(--muted-foreground)" }}>
            إصدار ومتابعة فواتير الإيجار الشهرية.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Icon name="plus" /> فاتورة جديدة
        </Button>
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ position: "relative", width: 280 }}>
          <Input
            placeholder="بحث"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ paddingInlineStart: 34 }}
          />
          <span
            style={{
              position: "absolute",
              insetInlineStart: 10,
              top: 10,
              color: "var(--muted-foreground)",
            }}
          >
            <Icon name="search" size={16} />
          </span>
        </div>
        <div style={{ width: 180 }}>
          <Select
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "all", label: "الكل" },
              { value: "paid", label: "مدفوعة" },
              { value: "pending", label: "قيد السداد" },
              { value: "overdue", label: "متأخرة" },
            ]}
          />
        </div>
      </div>
      <Card style={{ padding: "8px 16px 16px" }}>
        {rows.length ? (
          <InvoiceTable rows={rows} />
        ) : (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              fontSize: 14,
              color: "var(--muted-foreground)",
            }}
          >
            لا توجد بيانات لعرضها.
          </div>
        )}
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogHeader>
          <DialogTitle>فاتورة جديدة</DialogTitle>
          <DialogDescription>أدخل بيانات الفاتورة الشهرية.</DialogDescription>
        </DialogHeader>
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 6 }}>
            <Label>المستأجر</Label>
            <Select
              placeholder="اختر"
              options={window.adminData.invoices.map((r) => ({ value: r.id, label: r.tenant }))}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ display: "grid", gap: 6 }}>
              <Label>المبلغ (د.ك)</Label>
              <Input dir="ltr" placeholder="0.000" />
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              <Label>تاريخ الاستحقاق</Label>
              <Input dir="ltr" type="date" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            إلغاء
          </Button>
          <Button onClick={() => setOpen(false)}>حفظ التغييرات</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
function ModulePlaceholder({ title }) {
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        placeItems: "center",
        padding: "96px 0",
        textAlign: "center",
      }}
    >
      <div
        style={{
          display: "grid",
          placeItems: "center",
          width: 48,
          height: 48,
          borderRadius: "var(--radius-lg)",
          background: "var(--muted)",
          color: "var(--muted-foreground)",
        }}
      >
        <Icon name="wrench" size={22} />
      </div>
      <h2 style={{ margin: "8px 0 0", fontSize: 18, fontWeight: 600 }}>هذه الوحدة قيد التطوير</h2>
      <p style={{ margin: 0, fontSize: 14, color: "var(--muted-foreground)" }}>
        سيتم تسليم شاشة «{title}» ضمن المرحلة المخصصة لها في خارطة الطريق.
      </p>
    </div>
  );
}
Object.assign(window, { AdminDashboard, AdminInvoices, ModulePlaceholder });
