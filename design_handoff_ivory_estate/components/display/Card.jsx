import * as React from "react";
const __css =
  "\n.ds-card{border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--card);color:var(--card-foreground);box-shadow:var(--shadow)}\n.ds-card-header{display:flex;flex-direction:column;gap:6px;padding:24px}\n.ds-card-title{font:600 1rem/1 var(--font-sans);letter-spacing:-0.01em}\n.ds-card-desc{font-size:0.875rem;color:var(--muted-foreground)}\n.ds-card-content{padding:0 24px 24px}\n.ds-card-footer{display:flex;align-items:center;padding:0 24px 24px}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-card")) {
  const s = document.createElement("style");
  s.id = "ds-css-card";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Card({ className = "", children, ...props }) {
  return (
    <div className={"ds-card " + className} {...props}>
      {children}
    </div>
  );
}
export function CardHeader({ className = "", children, ...props }) {
  return (
    <div className={"ds-card-header " + className} {...props}>
      {children}
    </div>
  );
}
export function CardTitle({ className = "", children, ...props }) {
  return (
    <div className={"ds-card-title " + className} {...props}>
      {children}
    </div>
  );
}
export function CardDescription({ className = "", children, ...props }) {
  return (
    <div className={"ds-card-desc " + className} {...props}>
      {children}
    </div>
  );
}
export function CardContent({ className = "", children, ...props }) {
  return (
    <div className={"ds-card-content " + className} {...props}>
      {children}
    </div>
  );
}
export function CardFooter({ className = "", children, ...props }) {
  return (
    <div className={"ds-card-footer " + className} {...props}>
      {children}
    </div>
  );
}
