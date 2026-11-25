import * as React from "react";
const __css =
  "\n.ds-badge{display:inline-flex;align-items:center;border-radius:var(--radius-md);border:1px solid transparent;padding:2px 10px;font:600 0.75rem/1.3 var(--font-sans);transition:background-color .15s}\n.ds-badge--default{background:var(--primary);color:var(--primary-foreground);box-shadow:var(--shadow)}\n.ds-badge--secondary{background:var(--secondary);color:var(--secondary-foreground)}\n.ds-badge--destructive{background:var(--destructive);color:var(--destructive-foreground);box-shadow:var(--shadow)}\n.ds-badge--outline{border-color:var(--border);color:var(--foreground);background:transparent}\n.ds-badge--success{background:color-mix(in oklab,var(--success) 15%,transparent);color:var(--success);border-color:color-mix(in oklab,var(--success) 40%,transparent)}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-badge")) {
  const s = document.createElement("style");
  s.id = "ds-css-badge";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Badge({ variant = "default", className = "", children, ...props }) {
  return (
    <span className={"ds-badge ds-badge--" + variant + " " + className} {...props}>
      {children}
    </span>
  );
}
