import * as React from "react";
const __css =
  "\n.ds-table-wrap{position:relative;width:100%;overflow:auto}\n.ds-table{width:100%;caption-side:bottom;font-size:0.875rem;border-collapse:collapse}\n.ds-table thead tr{border-bottom:1px solid var(--border)}\n.ds-table tbody tr{border-bottom:1px solid var(--border);transition:background-color .15s}\n.ds-table tbody tr:last-child{border-bottom:0}\n.ds-table tbody tr:hover{background:color-mix(in oklab,var(--muted) 50%,transparent)}\n.ds-table th{height:40px;padding:0 8px;text-align:start;vertical-align:middle;font-weight:500;color:var(--muted-foreground)}\n.ds-table td{padding:8px;vertical-align:middle}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-table")) {
  const s = document.createElement("style");
  s.id = "ds-css-table";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Table({ className = "", children, ...props }) {
  return (
    <div className="ds-table-wrap">
      <table className={"ds-table " + className} {...props}>
        {children}
      </table>
    </div>
  );
}
export function TableHeader(props) {
  return <thead {...props} />;
}
export function TableBody(props) {
  return <tbody {...props} />;
}
export function TableRow(props) {
  return <tr {...props} />;
}
export function TableHead(props) {
  return <th {...props} />;
}
export function TableCell(props) {
  return <td {...props} />;
}
