import * as React from "react";
const __css =
  "\n.ds-progress{position:relative;height:8px;width:100%;overflow:hidden;border-radius:9999px;background:color-mix(in oklab,var(--primary) 20%,transparent)}\n.ds-progress-bar{height:100%;background:var(--primary);transition:width .3s;border-radius:9999px}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-progress")) {
  const s = document.createElement("style");
  s.id = "ds-css-progress";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Progress({ value = 0, className = "", ...props }) {
  return (
    <div className={"ds-progress " + className} role="progressbar" aria-valuenow={value} {...props}>
      <div className="ds-progress-bar" style={{ width: (value || 0) + "%" }}></div>
    </div>
  );
}
