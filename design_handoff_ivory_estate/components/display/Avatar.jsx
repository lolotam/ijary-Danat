import * as React from "react";
const __css =
  "\n.ds-avatar{position:relative;display:flex;height:40px;width:40px;flex-shrink:0;overflow:hidden;border-radius:9999px}\n.ds-avatar img{aspect-ratio:1;height:100%;width:100%;object-fit:cover}\n.ds-avatar-fallback{display:flex;height:100%;width:100%;align-items:center;justify-content:center;border-radius:9999px;background:var(--muted);color:var(--muted-foreground);font:500 0.875rem/1 var(--font-sans)}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-avatar")) {
  const s = document.createElement("style");
  s.id = "ds-css-avatar";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Avatar({ src, fallback, size = 40, className = "" }) {
  const [err, setErr] = React.useState(false);
  return (
    <span className={"ds-avatar " + className} style={{ height: size, width: size }}>
      {src && !err ? (
        <img src={src} alt="" onError={() => setErr(true)} />
      ) : (
        <span className="ds-avatar-fallback">{fallback}</span>
      )}
    </span>
  );
}
