/** الصفحات التي تحمل صفّ بطاقات مؤشرات قابلًا للإخفاء. */
export type CardPage =
  | "dashboard"
  | "tenants"
  | "units"
  | "contracts"
  | "payments"
  | "deposits"
  | "expenses"
  | "portal";

export interface CardDefinition {
  /** Stored in `card_visibility.card_id`. Never renumber or reuse an id. */
  id: string;
  page: CardPage;
  /** i18n key for the label shown in Settings › Cards control. */
  labelKey: string;
}

/**
 * السجلّ الوحيد لبطاقات المؤشرات: شاشة الإعدادات ترسم منه، والصفحات تحجب منه.
 *
 * One list, two consumers. If the settings screen and the pages each kept their
 * own list, a card could be listed in settings and never gated on its page —
 * which is this codebase's recurring defect shape: configuration that is
 * written and never read.
 *
 * The `labelKey` reuses each page's existing `summary.*` string where one
 * exists. The dashboard's nine cards build their labels inline from `locale`
 * rather than through `t()`, so they get dedicated keys here; the dashboard's
 * own rendering is deliberately left alone.
 */
export const CARD_REGISTRY: readonly CardDefinition[] = [
  {
    id: "dashboard.outstanding",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.outstanding",
  },
  {
    id: "dashboard.paymentsThisMonth",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.paymentsThisMonth",
  },
  { id: "dashboard.overdue", page: "dashboard", labelKey: "settings.cards.dashboard.overdue" },
  { id: "dashboard.collected", page: "dashboard", labelKey: "settings.cards.dashboard.collected" },
  { id: "dashboard.employees", page: "dashboard", labelKey: "settings.cards.dashboard.employees" },
  { id: "dashboard.salaries", page: "dashboard", labelKey: "settings.cards.dashboard.salaries" },
  {
    id: "dashboard.properties",
    page: "dashboard",
    labelKey: "settings.cards.dashboard.properties",
  },
  { id: "dashboard.units", page: "dashboard", labelKey: "settings.cards.dashboard.units" },
  { id: "dashboard.tenants", page: "dashboard", labelKey: "settings.cards.dashboard.tenants" },

  { id: "tenants.total", page: "tenants", labelKey: "summary.tenants.total" },
  { id: "tenants.active", page: "tenants", labelKey: "summary.tenants.active" },
  { id: "tenants.arrears", page: "tenants", labelKey: "summary.tenants.arrears" },
  { id: "tenants.blocked", page: "tenants", labelKey: "summary.tenants.blocked" },

  { id: "units.total", page: "units", labelKey: "summary.units.total" },
  { id: "units.occupied", page: "units", labelKey: "summary.units.occupied" },
  { id: "units.vacant", page: "units", labelKey: "summary.units.vacant" },
  { id: "units.maintenance", page: "units", labelKey: "summary.units.maintenance" },
  { id: "units.rentPotential", page: "units", labelKey: "summary.units.rentPotential" },

  { id: "contracts.total", page: "contracts", labelKey: "summary.contracts.total" },
  { id: "contracts.active", page: "contracts", labelKey: "summary.contracts.active" },
  { id: "contracts.expiring60", page: "contracts", labelKey: "summary.contracts.expiring60" },
  { id: "contracts.ended", page: "contracts", labelKey: "summary.contracts.ended" },
  { id: "contracts.annualValue", page: "contracts", labelKey: "summary.contracts.annualValue" },

  { id: "payments.full", page: "payments", labelKey: "summary.payments.full" },
  { id: "payments.partial", page: "payments", labelKey: "summary.payments.partial" },
  { id: "payments.insurance", page: "payments", labelKey: "summary.payments.insurance" },
  { id: "payments.refunds", page: "payments", labelKey: "summary.payments.refunds" },
  { id: "payments.net", page: "payments", labelKey: "summary.payments.net" },

  { id: "deposits.total", page: "deposits", labelKey: "summary.deposits.total" },
  { id: "deposits.confirmed", page: "deposits", labelKey: "summary.deposits.confirmed" },
  { id: "deposits.pending", page: "deposits", labelKey: "summary.deposits.pending" },
  { id: "deposits.thisMonth", page: "deposits", labelKey: "summary.deposits.thisMonth" },

  { id: "expenses.total", page: "expenses", labelKey: "summary.expenses.total" },
  { id: "expenses.approved", page: "expenses", labelKey: "summary.expenses.approved" },
  { id: "expenses.pending", page: "expenses", labelKey: "summary.expenses.pending" },
  { id: "expenses.thisMonth", page: "expenses", labelKey: "summary.expenses.thisMonth" },

  {
    id: "portal.reminderPopup",
    page: "portal",
    labelKey: "settings.cards.portal.reminderPopup",
  },
  {
    id: "portal.messageCompose",
    page: "portal",
    labelKey: "settings.cards.portal.messageCompose",
  },
  {
    id: "portal.leaseConcessions",
    page: "portal",
    labelKey: "settings.cards.portal.leaseConcessions",
  },
  { id: "portal.insurance", page: "portal", labelKey: "settings.cards.portal.insurance" },
  { id: "portal.nextDue", page: "portal", labelKey: "settings.cards.portal.nextDue" },
  {
    id: "portal.overdueInvoices",
    page: "portal",
    labelKey: "settings.cards.portal.overdueInvoices",
  },
  { id: "portal.totalOverdue", page: "portal", labelKey: "settings.cards.portal.totalOverdue" },
] as const;

/** ترتيب الصفحات في شاشة الإعدادات، ومفتاح عنوان كل مجموعة. */
export const CARD_PAGE_LABEL_KEYS: Record<CardPage, string> = {
  dashboard: "admin.dashboard",
  tenants: "admin.tenants",
  units: "admin.units",
  contracts: "admin.contracts",
  payments: "admin.payments",
  deposits: "admin.deposits",
  expenses: "admin.expenses",
  portal: "settings.cards.portal",
};

/**
 * يجمع بطاقات السجلّ حسب الصفحة مع الحفاظ على ترتيب ظهورها في الواجهة.
 *
 * YAGNI exception, stated deliberately: this has no production caller in this
 * commit — the Cards control screen that consumes it lands in the next one.
 * Grouping lives here rather than in that screen because the page order is a
 * property of the registry, and a screen that grouped independently could
 * silently drop a page the registry knows about.
 */
export function cardsByPage(): Array<{ page: CardPage; cards: CardDefinition[] }> {
  const order: CardPage[] = Object.keys(CARD_PAGE_LABEL_KEYS) as CardPage[];
  return order.map((page) => ({
    page,
    cards: CARD_REGISTRY.filter((card) => card.page === page),
  }));
}
