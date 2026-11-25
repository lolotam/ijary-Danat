import * as React from "react";
import { Icon } from "../display/Icon.jsx";
const __css =
  "\n.ds-sidebar{display:flex;flex-direction:column;gap:8px;width:256px;min-height:100%;background:var(--sidebar);color:var(--sidebar-foreground);border-inline-end:1px solid var(--sidebar-border);padding:8px;box-sizing:border-box}\n.ds-sidebar-label{padding:8px;font:500 0.75rem/1 var(--font-sans);color:color-mix(in oklab,var(--sidebar-foreground) 70%,transparent)}\n.ds-sidebar-menu{display:flex;flex-direction:column;gap:4px;list-style:none;margin:0;padding:0}\n.ds-sidebar-btn{display:flex;width:100%;align-items:center;gap:8px;border-radius:var(--radius-md);padding:8px;font:400 0.875rem/1.25rem var(--font-sans);color:inherit;text-decoration:none;transition:background-color .15s;box-sizing:border-box}\n.ds-sidebar-btn:hover{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground)}\n.ds-sidebar-btn[data-active=true]{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground);font-weight:500}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-sidebarnav")) {
  const s = document.createElement("style");
  s.id = "ds-css-sidebarnav";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function SidebarNav({ groups, activeKey, onNavigate, className = "" }) {
  const defaultGroups = [
    {
      label: "لوحة التحكم",
      items: [
        { key: "dashboard", label: "لوحة التحكم", icon: "layout-dashboard" },
        { key: "invoices", label: "فواتير الإيجار", icon: "file-text" },
        { key: "tenants", label: "المستأجرون", icon: "users" },
        { key: "properties", label: "العقارات والمباني", icon: "building-2" },
        { key: "units", label: "الوحدات", icon: "home" },
        { key: "contracts", label: "العقود", icon: "scroll-text" },
        { key: "payments", label: "المدفوعات", icon: "credit-card" },
        { key: "deposits", label: "الإيداعات البنكية", icon: "banknote" },
        { key: "expenses", label: "المصروفات", icon: "receipt" },
        { key: "electricity", label: "الكهرباء", icon: "zap" },
      ],
    },
    {
      label: "إعدادات الشركة والنظام",
      items: [
        { key: "reports", label: "التقارير", icon: "bar-chart-3" },
        { key: "audit", label: "سجل التدقيق", icon: "shield-check" },
        { key: "settings", label: "إعدادات الشركة والنظام", icon: "settings" },
      ],
    },
  ];
  const gs = groups || defaultGroups;
  return (
    <nav className={"ds-sidebar " + className}>
      {gs.map((g, gi) => (
        <div key={gi}>
          <div className="ds-sidebar-label">{g.label}</div>
          <ul className="ds-sidebar-menu">
            {g.items.map((it) => (
              <li key={it.key}>
                <a
                  href="#"
                  className="ds-sidebar-btn"
                  data-active={activeKey === it.key}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate && onNavigate(it.key);
                  }}
                >
                  <Icon name={it.icon} size={16} />
                  <span>{it.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
