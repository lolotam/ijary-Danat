import * as React from "react";
const __css =
  "\n.ds-label{font:500 0.875rem/1 var(--font-sans);color:var(--foreground);display:inline-block}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-label")) {
  const s = document.createElement("style");
  s.id = "ds-css-label";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Label({ className = "", children, ...props }) {
  return (
    <label className={"ds-label " + className} {...props}>
      {children}
    </label>
  );
}
