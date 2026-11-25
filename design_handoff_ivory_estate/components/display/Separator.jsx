import * as React from "react";
const __css =
  "\n.ds-separator{flex-shrink:0;background:var(--border)}\n.ds-separator--h{height:1px;width:100%}\n.ds-separator--v{height:100%;width:1px}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-separator")) {
  const s = document.createElement("style");
  s.id = "ds-css-separator";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Separator({ orientation = "horizontal", className = "", ...props }) {
  return (
    <div
      className={
        "ds-separator ds-separator--" + (orientation === "horizontal" ? "h" : "v") + " " + className
      }
      {...props}
    />
  );
}
