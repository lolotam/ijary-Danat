const { Button, Input, Label, Logo } = window.DanatAlMustaqbalDesignSystem_110f06;
function Auth() {
  const [error, setError] = React.useState(null);
  const [u, setU] = React.useState("");
  const [p, setP] = React.useState("");
  const submit = (e) => {
    e.preventDefault();
    setError(u && p ? null : "بيانات الدخول غير صحيحة.");
  };
  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--background)",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 448,
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--border)",
          background: "var(--card)",
          padding: 32,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Logo src="../../assets/logo.png" name="Danat Al Mustaqbal" subName={null} />
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
        </div>
        <h1 style={{ margin: "32px 0 0", fontSize: 24, fontWeight: 700 }}>تسجيل الدخول</h1>
        <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--muted-foreground)" }}>
          أدخل اسم المستخدم وكلمة المرور المخصصة لك من قبل الإدارة.
        </p>
        <form style={{ marginTop: 24, display: "grid", gap: 16 }} onSubmit={submit}>
          <div style={{ display: "grid", gap: 6 }}>
            <Label htmlFor="u">اسم المستخدم</Label>
            <Input id="u" dir="ltr" value={u} onChange={(e) => setU(e.target.value)} />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <Label htmlFor="p">كلمة المرور</Label>
            <Input
              id="p"
              type="password"
              dir="ltr"
              value={p}
              onChange={(e) => setP(e.target.value)}
            />
          </div>
          {error && (
            <div
              style={{
                borderRadius: "var(--radius-md)",
                border: "1px solid color-mix(in oklab,var(--destructive) 40%,transparent)",
                background: "color-mix(in oklab,var(--destructive) 10%,transparent)",
                padding: "8px 12px",
                fontSize: 14,
                color: "var(--destructive)",
              }}
            >
              {error}
            </div>
          )}
          <Button type="submit" style={{ marginTop: 8 }}>
            دخول
          </Button>
        </form>
        <div style={{ marginTop: 24, textAlign: "center" }}>
          <a
            href="../landing/index.html"
            style={{ fontSize: 12, color: "var(--muted-foreground)" }}
          >
            العودة للرئيسية
          </a>
        </div>
        <p style={{ marginTop: 24, fontSize: 11, color: "var(--muted-foreground)" }}>
          الحسابات تُنشأ من قبل الإدارة فقط.
        </p>
      </div>
    </div>
  );
}
window.Auth = Auth;
