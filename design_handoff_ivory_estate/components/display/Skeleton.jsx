import * as React from "react";
const __css =
  "\n@keyframes ds-pulse{50%{opacity:.5}}\n.ds-skeleton{animation:ds-pulse 2s cubic-bezier(.4,0,.6,1) infinite;border-radius:var(--radius-md);background:color-mix(in oklab,var(--primary) 10%,transparent)}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-skeleton")) {
  const s = document.createElement("style");
  s.id = "ds-css-skeleton";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Skeleton({ className = "", style, ...props }) {
  return <div className={"ds-skeleton " + className} style={style} {...props} />;
}
