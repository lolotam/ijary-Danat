import * as React from "react";
import { Icon } from "../display/Icon.jsx";
const __css =
  "\n.ds-portalnav{display:flex;gap:4px;overflow-x:auto;padding:0}\n.ds-portalnav-link{display:flex;flex-shrink:0;align-items:center;gap:8px;border-radius:var(--radius-lg);padding:8px 12px;font:500 0.75rem/1.3 var(--font-sans);color:var(--muted-foreground);text-decoration:none;transition:background-color .15s,color .15s}\n.ds-portalnav-link:hover{background:var(--muted);color:var(--foreground)}\n.ds-portalnav-link[data-active=true]{background:var(--primary);color:var(--primary-foreground)}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-portalnav")) {
  const s = document.createElement("style");
  s.id = "ds-css-portalnav";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function PortalNav({ items, activeKey, onNavigate, className = "" }) {
  const defaults = [
    { key: "dashboard", label: "لوحتي", icon: "home" },
    { key: "lease", label: "عقدي", icon: "building-2" },
    { key: "invoices", label: "فواتيري", icon: "file-text" },
    { key: "payments", label: "مدفوعاتي", icon: "credit-card" },
    { key: "receipts", label: "إيصالاتي", icon: "receipt-text" },
    { key: "profile", label: "الملف الشخصي", icon: "user-round" },
  ];
  const list = items || defaults;
  return (
    <nav className={"ds-portalnav " + className}>
      {list.map((it) => (
        <a
          key={it.key}
          href="#"
          className="ds-portalnav-link"
          data-active={activeKey === it.key}
          onClick={(e) => {
            e.preventDefault();
            onNavigate && onNavigate(it.key);
          }}
        >
          <Icon name={it.icon} size={16} />
          {it.label}
        </a>
      ))}
    </nav>
  );
}
