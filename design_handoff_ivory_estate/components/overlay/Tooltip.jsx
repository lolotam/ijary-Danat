import * as React from "react";
const __css =
  "\n.ds-tooltip-wrap{position:relative;display:inline-flex}\n.ds-tooltip{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:50;overflow:hidden;border-radius:var(--radius-md);background:var(--primary);color:var(--primary-foreground);padding:6px 12px;font-size:0.75rem;white-space:nowrap;pointer-events:none}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-tooltip")) {
  const s = document.createElement("style");
  s.id = "ds-css-tooltip";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Tooltip({ content, children }) {
  const [show, setShow] = React.useState(false);
  return (
    <span
      className="ds-tooltip-wrap"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span className="ds-tooltip" role="tooltip">
          {content}
        </span>
      )}
    </span>
  );
}
