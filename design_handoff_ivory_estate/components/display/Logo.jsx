import * as React from "react";
const __css =
  "\n.ds-logo{display:flex;align-items:center;gap:12px}\n.ds-logo-tile{display:grid;place-items:center;border-radius:var(--radius-md);background:var(--ink);color:var(--accent);font-weight:700;font-family:var(--font-sans);overflow:hidden;flex-shrink:0}\n.ds-logo-tile img{width:100%;height:100%;object-fit:cover;display:block}\n.ds-logo-name{font:600 0.875rem/1.2 var(--font-sans);color:var(--foreground)}\n.ds-logo-sub{font:400 0.6875rem/1.2 var(--font-sans);color:var(--gold-deep);letter-spacing:0.08em}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-logo")) {
  const s = document.createElement("style");
  s.id = "ds-css-logo";
  s.textContent = __css;
  document.head.appendChild(s);
}
export function Logo({
  size = 44,
  src,
  name = "دانة المستقبل العقارية",
  subName = "DANAT AL MUSTAQBAL",
  showName = true,
  onDark,
}) {
  return (
    <div className="ds-logo">
      <div
        className="ds-logo-tile"
        style={{
          height: size,
          width: size,
          fontSize: size * 0.44,
          borderRadius: Math.round(size * 0.23),
        }}
      >
        {src ? <img src={src} alt="" /> : "د"}
      </div>
      {showName && (
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
          <span className="ds-logo-name" style={onDark ? { color: "var(--ink-foreground)" } : null}>
            {name}
          </span>
          {subName && <span className="ds-logo-sub">{subName}</span>}
        </div>
      )}
    </div>
  );
}
