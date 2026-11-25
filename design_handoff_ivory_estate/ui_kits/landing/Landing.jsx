const { Button, Input, Textarea, Card, Alert, AlertDescription, Logo, Icon } =
  window.DanatAlMustaqbalDesignSystem_110f06;
function Landing() {
  const [locale, setLocale] = React.useState("ar");
  const t = window.landingDict[locale];
  const [status, setStatus] = React.useState("idle");
  const submit = (e) => {
    e.preventDefault();
    setStatus("loading");
    setTimeout(() => setStatus("success"), 700);
  };
  const inputStyle = { background: "var(--background)" };
  return (
    <div dir={t.dir} style={{ minHeight: "100vh" }}>
      <header
        style={{
          background: "var(--ink)",
          color: "var(--ink-foreground)",
          position: "sticky",
          top: 0,
          zIndex: 40,
        }}
      >
        <div
          style={{
            margin: "0 auto",
            display: "flex",
            height: 64,
            maxWidth: 1280,
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
          }}
        >
          <Logo src="../../assets/logo.png" name={t.brand} subName={t.brandSub} onDark />
          <nav style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 14 }}>
            <a href="#features" style={{ color: "var(--gold-soft)", textDecoration: "none" }}>
              {t.navServices}
            </a>
            <a href="#contact" style={{ color: "var(--gold-soft)", textDecoration: "none" }}>
              {t.navContact}
            </a>
            <button
              onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
              style={{
                borderRadius: 9999,
                border: "1px solid var(--ink-muted)",
                background: "none",
                color: "var(--ink-foreground)",
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t.lang}
            </button>
            <a
              href="../auth/index.html"
              style={{
                borderRadius: 9999,
                background: "var(--accent)",
                padding: "8px 18px",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--accent-foreground)",
                textDecoration: "none",
              }}
            >
              {t.adminLogin}
            </a>
          </nav>
        </div>
      </header>
      <section style={{ margin: "0 auto", maxWidth: 1280, padding: "84px 16px 40px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.05fr 1fr",
            gap: 44,
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 12,
                letterSpacing: "0.14em",
                color: "var(--gold-deep)",
                fontWeight: 600,
              }}
            >
              {t.tagline}
            </div>
            <h1 style={{ fontSize: 56, fontWeight: 700, lineHeight: 1.28, margin: "18px 0 0" }}>
              {t.headline}
            </h1>
            <p
              style={{
                maxWidth: 540,
                fontSize: 17,
                color: "var(--muted-foreground)",
                lineHeight: 1.9,
                margin: "20px 0 0",
              }}
            >
              {t.sub}
            </p>
            <div style={{ marginTop: 34, display: "flex", flexWrap: "wrap", gap: 14 }}>
              <Button
                size="lg"
                onClick={() =>
                  window.scrollTo({
                    top: document.getElementById("contact").offsetTop,
                    behavior: "smooth",
                  })
                }
              >
                {t.ctaContact}
              </Button>
              <Button size="lg" variant="outline">
                {t.ctaTenant}
              </Button>
            </div>
          </div>
          <div style={{ position: "relative" }}>
            <img
              src="../../assets/landing/hero.png"
              alt=""
              style={{
                width: "100%",
                aspectRatio: "4/3.4",
                objectFit: "cover",
                borderRadius: 18,
                display: "block",
              }}
            />
            <div
              style={{
                position: "absolute",
                bottom: -20,
                insetInlineStart: -20,
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                padding: "16px 22px",
                boxShadow: "0 10px 30px rgb(23 21 18 / 0.12)",
              }}
            >
              <div style={{ fontSize: 11, color: "var(--gold-deep)", fontWeight: 600 }}>
                {t.occupancy}
              </div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>
                86%{" "}
                <span style={{ fontSize: 12, color: "var(--muted-foreground)", fontWeight: 400 }}>
                  · {t.units}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section
        style={{
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          background: "color-mix(in oklab,var(--card) 50%,transparent)",
        }}
      >
        <div style={{ margin: "0 auto", maxWidth: 1280, padding: "64px 16px" }}>
          <div
            style={{
              margin: "0 auto",
              aspectRatio: "16/9",
              maxWidth: 896,
              overflow: "hidden",
              borderRadius: "var(--radius-xl)",
              border: "1px solid var(--border)",
              background: "var(--muted)",
              display: "grid",
              placeItems: "center",
              color: "var(--muted-foreground)",
            }}
          >
            <span style={{ fontSize: 14 }}>{t.video}</span>
          </div>
        </div>
      </section>
      <section id="features" style={{ margin: "0 auto", maxWidth: 1280, padding: "96px 16px" }}>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 48, alignItems: "center" }}
        >
          <div
            style={{
              overflow: "hidden",
              borderRadius: "var(--radius-2xl)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <img
              src="../../assets/landing/feature.png"
              alt=""
              style={{ aspectRatio: "4/3", width: "100%", objectFit: "cover", display: "block" }}
            />
          </div>
          <div style={{ maxWidth: 640 }}>
            <h2 style={{ fontSize: 34, fontWeight: 700, margin: 0 }}>{t.featTitle}</h2>
            <div style={{ marginTop: 32, display: "grid", gap: 24 }}>
              {[
                ["building-2", t.f1t, t.f1b],
                ["credit-card", t.f2t, t.f2b],
                ["line-chart", t.f3t, t.f3b],
              ].map(([ic, title, body]) => (
                <Card key={ic} style={{ padding: 24, borderRadius: "var(--radius-xl)" }}>
                  <div
                    style={{
                      display: "grid",
                      placeItems: "center",
                      height: 40,
                      width: 40,
                      borderRadius: "var(--radius-md)",
                      background: "color-mix(in oklab,var(--primary) 10%,transparent)",
                      color: "var(--primary)",
                    }}
                  >
                    <Icon name={ic} size={24} />
                  </div>
                  <h3 style={{ margin: "16px 0 0", fontSize: 18, fontWeight: 600 }}>{title}</h3>
                  <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--muted-foreground)" }}>
                    {body}
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section
        id="contact"
        style={{
          background: "color-mix(in oklab,var(--card) 50%,transparent)",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            margin: "0 auto",
            display: "grid",
            maxWidth: 1280,
            gap: 48,
            padding: "96px 16px",
            gridTemplateColumns: "1fr 1fr",
          }}
        >
          <div>
            <h2 style={{ fontSize: 34, fontWeight: 700, margin: 0 }}>{t.contactTitle}</h2>
            <p style={{ marginTop: 16, color: "var(--muted-foreground)" }}>{t.contactSub}</p>
            {status === "success" && (
              <div style={{ marginTop: 24 }}>
                <Alert variant="success">
                  <AlertDescription>{t.success}</AlertDescription>
                </Alert>
              </div>
            )}
          </div>
          <form style={{ display: "grid", gap: 16 }} onSubmit={submit}>
            <Input placeholder={t.name} required style={inputStyle} />
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr" }}>
              <Input type="tel" placeholder={t.phone} style={inputStyle} />
              <Input type="email" placeholder={t.email} required style={inputStyle} />
            </div>
            <Input placeholder={t.subject} style={inputStyle} />
            <Textarea
              placeholder={t.message}
              required
              style={{ minHeight: 128, background: "var(--background)" }}
            />
            <Button type="submit" disabled={status === "loading"}>
              {status === "loading" ? t.sending : t.send}
            </Button>
          </form>
        </div>
      </section>
      <footer style={{ background: "var(--ink)", color: "var(--ink-foreground)" }}>
        <div
          style={{
            margin: "0 auto",
            display: "grid",
            maxWidth: 1280,
            gap: 32,
            padding: "48px 16px",
            gridTemplateColumns: "1fr 1fr 1fr",
          }}
        >
          <div>
            <Logo src="../../assets/logo.png" name={t.brand} subName={null} onDark />
            <p style={{ marginTop: 12, fontSize: 12, color: "var(--ink-muted)" }}>
              © 2026 — {t.rights}
            </p>
          </div>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t.footContact}</h3>
            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 14,
                color: "var(--ink-muted)",
              }}
            >
              <Icon name="mail" size={16} />
              <a
                href="mailto:info@example.com"
                style={{ color: "inherit", textDecoration: "none" }}
              >
                info@example.com
              </a>
            </div>
          </div>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t.follow}</h3>
            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                gap: 12,
                color: "var(--gold-soft)",
              }}
            >
              <Icon name="facebook" size={20} />
              <Icon name="instagram" size={20} />
            </div>
            <div style={{ marginTop: 24 }}>
              <a href="../auth/index.html" style={{ fontSize: 12, color: "var(--gold-soft)" }}>
                {t.adminLogin}
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
window.Landing = Landing;
