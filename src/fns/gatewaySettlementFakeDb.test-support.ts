/**
 * قاعدة بيانات وهمية في الذاكرة لاختبار تسوية البوابة بحالة حقيقية.
 *
 * The settlement tests need state that CHANGES: an allocation must lower an
 * invoice's balance, an insert must be visible to the next read, and the unique
 * `MF:%` payment reference must reject a duplicate the way Postgres does
 * (migration 06). A stub that returns the same canned row for every query — the
 * shape `settleGatewayPaymentAdoption.test.ts` uses for its read-only branch —
 * cannot show money being booked twice or not at all, which is the whole point
 * of these tests.
 *
 * Only the query shapes the settlement, reservation and reconcile code
 * actually issue are supported; anything else throws, so a new query fails
 * loudly instead of silently matching nothing. `apply_payment_allocation` reproduces the checks from
 * migrations 213/217 that settlement can hit as `service_role`: payment must be
 * confirmed, the total must not exceed the payment's unallocated remainder, and
 * each amount must not exceed the invoice's balance.
 */

type Row = Record<string, unknown>;
type Filter = { column: string; op: "eq" | "in" | "gt" | "notNull"; value: unknown };

/** قيمة مالية كرقم مقرّب إلى الفلس، كما تعيده PostgREST نصّاً. */
function money(value: unknown): number {
  return Math.round(Number(value) * 1000) / 1000;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  audits: Array<Record<string, unknown>>;
  client: {
    from: (table: string) => unknown;
    rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
}

/** يبني قاعدة وهمية من صفوف أولية ويعيد عميلاً بشكل supabaseAdmin. */
export function createFakeDb(seed: Record<string, Row[]>): FakeDb {
  const tables: Record<string, Row[]> = {
    payment_requests: [],
    invoices: [],
    payments: [],
    payment_allocations: [],
    receipts: [],
    tenants: [],
    ...structuredClone(seed),
  };
  const audits: Array<Record<string, unknown>> = [];
  let sequence = 0;

  /** يطبّق شروط الاستعلام على صفوف جدول. */
  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((filter) => {
      const value = row[filter.column];
      if (filter.op === "eq") return value === filter.value;
      if (filter.op === "in") return (filter.value as unknown[]).includes(value);
      if (filter.op === "gt") return String(value) > String(filter.value);
      return value !== null && value !== undefined;
    });
  }

  /**
   * يضيف طلب دفع كما يفعل Postgres: قيم افتراضية وفهرس فريد على مفتاح عدم التكرار.
   *
   * The unique `idempotency_key` (migration 06) is what forces a retired
   * request to release its key before a new one can take it; many nulls are
   * allowed, exactly as in Postgres.
   */
  function insertPaymentRequest(values: Row): { data: Row | null; error: Row | null } {
    const key = values.idempotency_key;
    if (key != null && tables.payment_requests.some((row) => row.idempotency_key === key)) {
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }
    const id = `preq-${++sequence}`;
    const row = {
      id,
      code: `PREQ-${String(sequence).padStart(7, "0")}`,
      status: "pending",
      currency: "KWD",
      payment_url: null,
      provider_invoice_id: null,
      provider_payment_id: null,
      resulting_payment_id: null,
      gateway_response: null,
      created_at: new Date().toISOString(),
      ...values,
    };
    tables.payment_requests.push(row);
    return { data: row, error: null };
  }

  /** يضيف دفعة كما يفعل Postgres: فهرس فريد على مرجع MF ومحفّز الإيصال. */
  function insertPayment(values: Row): { data: Row | null; error: Row | null } {
    const reference = values.reference as string | null;
    if (
      reference?.startsWith("MF:") &&
      tables.payments.some((payment) => payment.reference === reference)
    ) {
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }
    const id = `pay-${++sequence}`;
    const row = { id, code: `PAY-${String(sequence).padStart(7, "0")}`, ...values };
    tables.payments.push(row);
    // sync_payment_receipt: every payment gets a receipt, hidden from the tenant.
    tables.receipts.push({ id: `rcpt-${id}`, payment_id: id, visible_to_tenant: false });
    return { data: row, error: null };
  }

  /** يعيد الصفوف مع تضمين جدول الدفعات إن طُلب في select. */
  function project(table: string, rows: Row[], columns: string): Row[] {
    if (table === "payment_allocations" && columns.includes("payments(")) {
      return rows.map((row) => ({
        ...row,
        payments: tables.payments.find((payment) => payment.id === row.payment_id) ?? null,
      }));
    }
    return rows;
  }

  /** يبني سلسلة استعلام بشكل PostgREST لجدول واحد. */
  function query(table: string) {
    const filters: Filter[] = [];
    let columns = "*";
    let mode: "select" | "update" | "insert" = "select";
    let payload: Row = {};

    /** ينفّذ الاستعلام المتراكم ويعيد نتيجة بشكل PostgREST. */
    function run(): { data: unknown; error: unknown } {
      if (!(table in tables)) throw new Error(`fake db: unknown table ${table}`);
      if (mode === "insert") {
        if (table === "payments") return insertPayment(payload);
        if (table === "payment_requests") return insertPaymentRequest(payload);
        throw new Error(`fake db: insert into ${table} unsupported`);
      }
      const rows = tables[table].filter((row) => matches(row, filters));
      if (mode === "update") {
        for (const row of rows) Object.assign(row, payload);
        return { data: rows, error: null };
      }
      return { data: project(table, rows, columns), error: null };
    }

    const chain = {
      select(cols = "*") {
        columns = cols;
        return chain;
      },
      insert(values: Row) {
        mode = "insert";
        payload = values;
        return chain;
      },
      update(values: Row) {
        mode = "update";
        payload = values;
        return chain;
      },
      eq(column: string, value: unknown) {
        filters.push({ column, op: "eq", value });
        return chain;
      },
      in(column: string, value: unknown[]) {
        filters.push({ column, op: "in", value });
        return chain;
      },
      gt(column: string, value: unknown) {
        filters.push({ column, op: "gt", value });
        return chain;
      },
      not(column: string, operator: string, value: unknown) {
        if (operator !== "is" || value !== null) {
          throw new Error(`fake db: not(${column}, ${operator}) unsupported`);
        }
        filters.push({ column, op: "notNull", value });
        return chain;
      },
      order() {
        return chain;
      },
      async single() {
        const result = run();
        if (result.error) return result;
        const data = Array.isArray(result.data) ? result.data : [result.data];
        if (data.length !== 1) {
          return {
            data: null,
            error: { code: "PGRST116", message: `expected 1 row, got ${data.length}` },
          };
        }
        return { data: data[0], error: null };
      },
      async maybeSingle() {
        const result = run();
        const data = result.data as Row[];
        return { data: data[0] ?? null, error: result.error };
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          return Promise.resolve(run()).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      },
    };
    return chain;
  }

  /** يعيد ما لم يُخصَّص بعد من دفعة. */
  function unallocated(paymentId: string, amount: unknown): number {
    const used = tables.payment_allocations
      .filter((allocation) => allocation.payment_id === paymentId)
      .reduce((sum, allocation) => sum + money(allocation.amount), 0);
    return money(money(amount) - used);
  }

  /** يطبّق تخصيص دفعة كما تفعله الدالة في قاعدة البيانات. */
  function applyAllocation(args: Record<string, unknown>) {
    const payment = tables.payments.find((row) => row.id === args.p_payment_id);
    if (!payment) return { data: null, error: { message: "Payment not found" } };
    if (payment.status !== "confirmed") {
      return { data: null, error: { message: "Only confirmed payments can be allocated" } };
    }
    const allocations = args.p_allocations as Array<{ invoice_id: string; amount: number }>;
    const total = allocations.reduce((sum, allocation) => sum + money(allocation.amount), 0);
    if (money(total) > unallocated(payment.id as string, payment.amount)) {
      return { data: null, error: { message: "Allocations exceed the remaining payment amount" } };
    }
    for (const allocation of allocations) {
      const invoice = tables.invoices.find((row) => row.id === allocation.invoice_id);
      if (!invoice) return { data: null, error: { message: "Invoice not found" } };
      if (money(allocation.amount) > money(invoice.balance)) {
        return { data: null, error: { message: "Allocation exceeds invoice balance" } };
      }
    }
    for (const allocation of allocations) {
      const invoice = tables.invoices.find((row) => row.id === allocation.invoice_id) as Row;
      tables.payment_allocations.push({
        invoice_id: allocation.invoice_id,
        payment_id: payment.id,
        amount: money(allocation.amount),
      });
      invoice.paid = money(money(invoice.paid) + money(allocation.amount));
      invoice.balance = money(money(invoice.total) - money(invoice.paid));
    }
    return { data: null, error: null };
  }

  const client = {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "apply_payment_allocation") return applyAllocation(args);
      if (name === "write_audit") {
        audits.push(args);
        return { data: null, error: null };
      }
      throw new Error(`fake db: unknown rpc ${name}`);
    },
  };

  return { tables, audits, client };
}

/** مجموع مبالغ الدفعات المرتبطة بطلب دفع، بعد التقريب إلى الفلس. */
export function paymentsTotalForRequest(db: FakeDb, requestId: string): number {
  return money(
    db.tables.payments
      .filter((payment) => payment.payment_request_id === requestId)
      .reduce((sum, payment) => sum + money(payment.amount), 0),
  );
}
