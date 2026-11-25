import * as React from "react";
const __css =
  "\n.ds-alert{position:relative;width:100%;border-radius:var(--radius-lg);border:1px solid var(--border);padding:12px 16px;font-size:0.875rem;box-sizing:border-box}\n.ds-alert--default{background:var(--background);color:var(--foreground)}\n.ds-alert--destructive{border-color:color-mix(in oklab,var(--destructive) 50%,transparent);color:var(--destructive)}\n.ds-alert--success{border-color:color-mix(in oklab,var(--success) 50%,transparent);color:var(--success);background:color-mix(in oklab,var(--success) 6%,transparent)}\n.ds-alert-title{margin:0 0 4px;font-weight:500;line-height:1}\n.ds-alert-desc{font-size:0.875rem;line-height:1.6}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-alert")) {
  const s = document.createElement("style");
  s.id = "ds-css-alert";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Alert({ variant = "default", className = "", children, ...props }) {
  return (
    <div role="alert" className={"ds-alert ds-alert--" + variant + " " + className} {...props}>
      {children}
    </div>
  );
}
export function AlertTitle({ className = "", children }) {
  return <h5 className={"ds-alert-title " + className}>{children}</h5>;
}
export function AlertDescription({ className = "", children }) {
  return <div className={"ds-alert-desc " + className}>{children}</div>;
}
