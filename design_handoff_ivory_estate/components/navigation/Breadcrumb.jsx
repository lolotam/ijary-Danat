import * as React from "react";
const __css =
  "\n.ds-breadcrumb{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:0.875rem;color:var(--muted-foreground);list-style:none;margin:0;padding:0}\n.ds-breadcrumb li{display:inline-flex;align-items:center;gap:6px}\n.ds-breadcrumb a{color:inherit;text-decoration:none;transition:color .15s}\n.ds-breadcrumb a:hover{color:var(--foreground)}\n.ds-breadcrumb .ds-breadcrumb-page{color:var(--foreground)}\n[dir=rtl] .ds-breadcrumb svg{transform:scaleX(-1)}\n";
if (typeof document !== "undefined" && !document.getElementById("ds-css-breadcrumb")) {
  const s = document.createElement("style");
  s.id = "ds-css-breadcrumb";
  s.textContent = __css;
  document.head.appendChild(s);
}

export function Breadcrumb({ items = [], className = "" }) {
  return (
    <nav aria-label="breadcrumb">
      <ol className={"ds-breadcrumb " + className}>
        {items.map((it, i) => (
          <React.Fragment key={i}>
            <li>
              {i < items.length - 1 ? (
                <a href={it.href || "#"}>{it.label}</a>
              ) : (
                <span className="ds-breadcrumb-page" aria-current="page">
                  {it.label}
                </span>
              )}
            </li>
            {i < items.length - 1 && (
              <li aria-hidden="true">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </li>
            )}
          </React.Fragment>
        ))}
      </ol>
    </nav>
  );
}
