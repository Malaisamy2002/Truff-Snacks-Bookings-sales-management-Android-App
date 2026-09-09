import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readCache, writeCache } from "./data";
import { bookingTaxable, freezeTax } from "./biz";
import { rupees } from "./money";
import { rowsForYears, useYearWindow, type YearTable } from "./years";
import {
  db,
  newId,
  nextExpenseNo,
  nextSnackBillNo,
  nextTurfBookingNo,
  nowIso,
  sortBy,
  type ExpenseRow,
  type SnackSaleRow,
  type TurfBookingRow,
} from "./localdb";

export type TurfRate = {
  id: string;
  slot_name: string;
  rate_per_hour: number;
  /** Optional fixed prices per slot duration; null falls back to prorated hourly rate. */
  rate_15: number | null;
  rate_30: number | null;
  rate_45: number | null;
  rate_60: number | null;
  is_active: boolean;
};

/** Global on/off switches for which slot durations can be picked on new bookings. */
export type SlotDurations = {
  allow_15: boolean;
  allow_30: boolean;
  allow_45: boolean;
  allow_60: boolean;
  /** How many courts/pitches the venue has. A time slot is only "booked"
   * once every court is taken, so two 1-court bookings can share a slot on a
   * 2-court turf. Defaults to 1 (old behaviour: any booking blocks the slot). */
  total_courts: number;
};

export const DEFAULT_SLOT_DURATIONS: SlotDurations = {
  allow_15: true,
  allow_30: true,
  allow_45: true,
  allow_60: true,
  total_courts: 1,
};

export const MAX_COURTS = 10;
export const clampCourts = (n: unknown) =>
  Math.max(1, Math.min(MAX_COURTS, Math.round(Number(n)) || 1));

/** Slot durations enabled globally. Missing values count as enabled. */
export const allowedIntervalsFor = (d?: SlotDurations | null): number[] => {
  const s = d ?? DEFAULT_SLOT_DURATIONS;
  const list = [
    [15, s.allow_15],
    [30, s.allow_30],
    [45, s.allow_45],
    [60, s.allow_60],
  ] as const;
  const on = list.filter(([, v]) => v !== false).map(([m]) => m as number);
  return on.length > 0 ? on : [60];
};

export function useSlotDurations() {
  return useQuery({
    queryKey: ["slot_durations"],
    initialData: () => readCache<SlotDurations>("slot_durations", DEFAULT_SLOT_DURATIONS),
    queryFn: async () => {
      const row = await db.app_settings.get("slot_durations");
      const v = (row?.value ?? {}) as Partial<SlotDurations>;
      const out: SlotDurations = {
        allow_15: v.allow_15 !== false,
        allow_30: v.allow_30 !== false,
        allow_45: v.allow_45 !== false,
        allow_60: v.allow_60 !== false,
        total_courts: clampCourts(v.total_courts ?? 1),
      };
      writeCache("slot_durations", out);
      return out;
    },
  });
}

export function useSaveSlotDurations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (d: SlotDurations) => {
      await db.app_settings.put({ key: "slot_durations", value: d, updated_at: nowIso() });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slot_durations"] }),
  });
}

/** Price for one slot of `interval` minutes. Falls back to the prorated hourly rate. */
export const rateForInterval = (r: TurfRate, interval: number) => {
  const custom =
    interval === 15
      ? r.rate_15
      : interval === 30
        ? r.rate_30
        : interval === 45
          ? r.rate_45
          : r.rate_60;
  return custom != null && custom > 0 ? custom : (r.rate_per_hour * interval) / 60;
};

/**
 * Price for a booking of `totalMinutes`: full hours are charged at the hourly
 * rate, and the leftover 15/30/45 minutes are added on top using the slot's
 * per-duration price (falling back to the prorated hourly rate).
 */
export const priceForDuration = (r: TurfRate, totalMinutes: number) => {
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hourPrice = r.rate_60 != null && r.rate_60 > 0 ? r.rate_60 : r.rate_per_hour;
  const wholeHours = Math.floor(mins / 60);
  const remainder = mins % 60;
  // The remainder uses its own 15/30/45 price when one is set; otherwise it is
  // prorated from the SAME hourly price the full hours use (rate_60 when set),
  // so a custom 1 hr price isn't silently ignored for the leftover minutes.
  const remainderCustom =
    remainder === 15
      ? r.rate_15
      : remainder === 30
        ? r.rate_30
        : remainder === 45
          ? r.rate_45
          : null;
  const remainderPrice =
    remainder > 0
      ? remainderCustom != null && remainderCustom > 0
        ? remainderCustom
        : (hourPrice * remainder) / 60
      : 0;
  return rupees(wholeHours * hourPrice + remainderPrice);
};

export type SnackItem = {
  id: string;
  item_name: string;
  category: string;
  unit_price: number;
  cost_price: number;
  is_active: boolean;
  stock_quantity: number;
  low_stock_threshold: number;
  stock_updated_at: string | null;
};

export type SnackStockHistoryEntry = {
  id: string;
  item_id: string;
  item_name: string;
  delta: number;
  previous_quantity: number;
  new_quantity: number;
  created_at: string;
};

export type TurfBooking = {
  id: string;
  booking_no: string;
  booking_date: string;
  customer_name: string;
  phone: string | null;
  slot_name: string;
  hours: number;
  rate_per_hour: number;
  total_amount: number;
  /** Tax frozen at creation — see lib/biz.ts TaxSnapshot. */
  tax_amount?: number;
  tax_lines?: { label: string; value: number }[];
  advance_paid: number;
  payment_mode: string;
  status: string;
  discount: number;
  notes: string | null;
  start_time: string | null;
  end_time: string | null;
  courts: number;
  /**
   * DEAD FIELD (currently unused): always created as `[]` — nothing in the
   * app writes to it. Snack sales linked to a booking today live entirely
   * in the separate `sales` table (see SnacksTab's `booking_id` link),
   * counted once via `snacksRevenue` in periodStats. If a future feature
   * starts populating this instead (e.g. "add snacks directly to a
   * booking"), it MUST be excluded from `snacksRevenue`/`turfRevenue`
   * wherever it's summed, or a snack sold this way would be double-counted
   * against the same sale recorded in `sales` — see
   * docs/calculation-rules.md §2 for the existing pattern this should
   * follow (an `isFinancialX`-style guard, not an inline check).
   */
  snacks: SnackSaleItem[];
  /** DEAD FIELD (currently unused): always created as `0` — see `snacks` above. */
  snacks_total: number;
  turf_amount: number;
  /** Set once this booking's revenue has been rolled into a merged bill. */
  merged_into_bill_id?: string | null;
};

export type SnackSaleItem = {
  item_name: string;
  qty: number;
  unit_price: number;
  cost_price: number;
  amount: number;
};

export type SnackSale = {
  id: string;
  bill_no: string;
  sale_date: string;
  customer_name: string | null;
  items: SnackSaleItem[];
  total: number;
  /** Tax frozen at creation — see lib/biz.ts TaxSnapshot. */
  tax_amount?: number;
  tax_lines?: { label: string; value: number }[];
  profit: number;
  payment_mode: string;
  notes: string | null;
  booking_id?: string | null;
  booking_no?: string | null;
  /** Set once this sale's items have been rolled into a merged bill: the row
   * stays (so a `snack_sale:<id>` tab charge keeps a parent) but stops
   * counting as its own revenue. */
  merged_into_bill_id?: string | null;
};

/** A one-tap deal: a fixed set of snack items sold at a combo price. */
export type SnackCombo = {
  id: string;
  name: string;
  items: { item_name: string; qty: number }[];
  price: number;
  is_active: boolean;
};

export const PAYMENT_MODES = ["Cash", "UPI", "Card", "Pending"] as const;
/** "On tab" bills are unpaid: the amount is pushed onto the customer's tab. */
export const TAB_PAYMENT_MODE = "On tab";
export const SNACK_PAYMENT_MODES = ["Cash", "UPI", TAB_PAYMENT_MODE] as const;

export const BOOKING_STATUSES = ["Confirmed", "Completed", "Cancelled"] as const;
export const BUSINESSES = ["Turf", "Snacks", "Shared"] as const;
export const EXPENSE_CATEGORIES_V2 = [
  "Electricity",
  "Maintenance",
  "Raw Material",
  "Rent",
  "Staff Wages",
  "Transport",
  "Equipment",
  "Other",
] as const;

/** Default slots seeded once when the rate table is still empty. */
export const DEFAULT_TURF_RATES = [
  { slot_name: "Weekdays", rate_per_hour: 1200 },
  { slot_name: "Weekends", rate_per_hour: 1400 },
];

export function useTurfRates() {
  return useQuery({
    queryKey: ["turf_rates"],
    initialData: () => readCache<TurfRate[]>("turf_rates", []),
    queryFn: async () => {
      const load = async () =>
        sortBy(await db.turf_rates.toArray(), "created_at", "asc").map((r) => ({
          id: r.id,
          slot_name: r.slot_name,
          rate_per_hour: Number(r.rate_per_hour),
          rate_15: r.rate_15 != null ? Number(r.rate_15) : null,
          rate_30: r.rate_30 != null ? Number(r.rate_30) : null,
          rate_45: r.rate_45 != null ? Number(r.rate_45) : null,
          rate_60: r.rate_60 != null ? Number(r.rate_60) : null,
          is_active: r.is_active,
        })) as TurfRate[];

      let rows = await load();
      if (rows.length === 0) {
        await db.turf_rates.bulkAdd(
          DEFAULT_TURF_RATES.map((r, i) => ({
            id: newId(),
            slot_name: r.slot_name,
            rate_per_hour: r.rate_per_hour,
            rate_15: null,
            rate_30: null,
            rate_45: null,
            rate_60: null,
            is_active: true,
            created_at: new Date(Date.now() + i).toISOString(),
          })),
        );
        rows = await load();
      }
      writeCache("turf_rates", rows);
      return rows;
    },
  });
}

export function useSaveTurfRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<TurfRate> & { slot_name: string }) => {
      const body = {
        slot_name: payload.slot_name,
        rate_per_hour: payload.rate_per_hour ?? 0,
        rate_15: payload.rate_15 ?? null,
        rate_30: payload.rate_30 ?? null,
        rate_45: payload.rate_45 ?? null,
        rate_60: payload.rate_60 ?? null,
        is_active: payload.is_active ?? true,
      };
      if (payload.id) {
        await db.turf_rates.update(payload.id, body);
        return;
      }
      await db.turf_rates.add({ id: newId(), created_at: nowIso(), ...body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["turf_rates"] }),
  });
}

export function useDeleteTurfRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await db.turf_rates.delete(id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["turf_rates"] }),
  });
}

export function useSnackItems() {
  return useQuery({
    queryKey: ["snack_items"],
    initialData: () => readCache<SnackItem[]>("snack_items", []),
    queryFn: async () => {
      const rows = sortBy(await db.snack_items.toArray(), "item_name", "asc").map((r) => ({
        id: r.id,
        item_name: r.item_name,
        category: r.category,
        unit_price: Number(r.unit_price),
        cost_price: Number(r.cost_price),
        is_active: r.is_active,
        stock_quantity: Number(r.stock_quantity ?? 0),
        low_stock_threshold: Number(r.low_stock_threshold ?? 0),
        stock_updated_at: r.stock_updated_at ?? null,
      })) as SnackItem[];
      writeCache("snack_items", rows);
      return rows;
    },
  });
}

export function useSaveSnackItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<SnackItem> & { item_name: string }) => {
      const body = {
        item_name: payload.item_name,
        category: payload.category || "General",
        unit_price: payload.unit_price ?? 0,
        cost_price: payload.cost_price ?? 0,
        is_active: payload.is_active ?? true,
        stock_quantity: payload.stock_quantity ?? 0,
        low_stock_threshold: payload.low_stock_threshold ?? 5,
      };
      if (payload.id) {
        await db.snack_items.update(payload.id, body);
        return;
      }
      await db.snack_items.add({ id: newId(), created_at: nowIso(), ...body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snack_items"] }),
  });
}

/** Sets stock to an exact count (stock take) or adds/removes a delta. Logs
 * every change to snack_stock_history so quantity changes stay traceable. */
export function useAdjustSnackStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { id: string; stock_quantity: number }) => {
      await db.transaction("rw", db.snack_items, db.snack_stock_history, async () => {
        const item = await db.snack_items.get(payload.id);
        if (!item) throw new Error("Snack item not found");
        const next = Math.max(0, Math.round(payload.stock_quantity));
        const previous = Number(item.stock_quantity ?? 0);
        const timestamp = nowIso();
        await db.snack_items.update(payload.id, {
          stock_quantity: next,
          stock_updated_at: timestamp,
        });
        if (next !== previous) {
          await db.snack_stock_history.add({
            id: newId(),
            item_id: payload.id,
            item_name: item.item_name,
            delta: next - previous,
            previous_quantity: previous,
            new_quantity: next,
            created_at: timestamp,
          });
        }
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["snack_items"] });
      qc.invalidateQueries({ queryKey: ["snack_stock_history"] });
    },
  });
}

/** Recent stock-change log for the stock card, newest first. Optionally
 * scoped to one item (e.g. an "activity" popover on that row). */
export function useSnackStockHistory(itemId?: string, limit = 50) {
  return useQuery({
    queryKey: ["snack_stock_history", itemId ?? "all", limit],
    queryFn: async () => {
      const rows = itemId
        ? await db.snack_stock_history.where("item_id").equals(itemId).toArray()
        : await db.snack_stock_history.toArray();
      return sortBy(rows, "created_at", "desc").slice(0, limit) as SnackStockHistoryEntry[];
    },
  });
}

export function useDeleteSnackItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await db.snack_items.delete(id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snack_items"] }),
  });
}

export function useTurfBookings() {
  const { years } = useYearWindow();
  return useQuery({
    queryKey: ["turf_bookings", years],
    initialData: () => readCache<TurfBooking[]>(`turf_bookings:${years.join("-")}`, []),
    queryFn: async () => {
      // Indexed range read for the shown year(s) only — stays fast at 100k+ rows.
      const raw = await rowsForYears<TurfBookingRow>("turf_bookings" as YearTable, years);
      const rows = sortBy(sortBy(raw, "created_at", "desc"), "booking_date", "desc").map((b) => ({
        id: b.id,
        booking_no: b.booking_no,
        booking_date: b.booking_date,
        customer_name: b.customer_name,
        phone: b.phone,
        slot_name: b.slot_name,
        hours: Number(b.hours),
        rate_per_hour: Number(b.rate_per_hour),
        total_amount: Number(b.total_amount),
        tax_amount: b.tax_amount,
        tax_lines: b.tax_lines,
        advance_paid: Number(b.advance_paid),
        payment_mode: b.payment_mode,
        status: b.status,
        discount: Number(b.discount ?? 0),
        notes: b.notes ?? null,
        start_time: b.start_time ?? null,
        end_time: b.end_time ?? null,
        courts: Number(b.courts ?? 1),
        snacks: (b.snacks ?? []) as unknown as SnackSaleItem[],
        snacks_total: Number(b.snacks_total ?? 0),
        turf_amount: Number(b.turf_amount ?? 0),
        merged_into_bill_id: b.merged_into_bill_id ?? null,
      })) as TurfBooking[];

      writeCache(`turf_bookings:${years.join("-")}`, rows);
      return rows;
    },
  });
}

export function useCreateTurfBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Omit<TurfBooking, "id" | "booking_no">): Promise<TurfBooking> => {
      const booking_no = await nextTurfBookingNo();
      const id = newId();
      // Tax is computed ONCE, from the settings in effect right now, and saved
      // on the booking — a later GST change can never move this receipt's
      // grand total, balance due, or the amount its tab charge posts.
      const tax = freezeTax(bookingTaxable(payload));
      const row = {
        ...payload,
        tax_amount: tax.taxAmount,
        tax_lines: tax.taxLines,
        id,
        booking_no,
        created_at: nowIso(),
      };
      await db.turf_bookings.add(row);
      return { ...payload, tax_amount: tax.taxAmount, tax_lines: tax.taxLines, id, booking_no };
    },

    onSuccess: () => qc.invalidateQueries({ queryKey: ["turf_bookings"] }),
  });
}

export function useUpdateTurfBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Partial<TurfBooking>) => {
      await db.turf_bookings.update(id, patch);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["turf_bookings"] }),
  });
}

export function useDeleteTurfBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await db.turf_bookings.delete(id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["turf_bookings"] }),
  });
}

export function useSnackSales() {
  const { years } = useYearWindow();
  return useQuery({
    queryKey: ["snack_sales", years],
    initialData: () => readCache<SnackSale[]>(`snack_sales:${years.join("-")}`, []),
    queryFn: async () => {
      const raw = await rowsForYears<SnackSaleRow>("snack_sales" as YearTable, years);
      const rows = sortBy(sortBy(raw, "created_at", "desc"), "sale_date", "desc").map((s) => ({
        id: s.id,
        bill_no: s.bill_no,
        sale_date: s.sale_date,
        customer_name: s.customer_name,
        items: (s.items ?? []) as unknown as SnackSaleItem[],
        total: Number(s.total),
        tax_amount: s.tax_amount,
        tax_lines: s.tax_lines,
        profit: Number(s.profit),
        payment_mode: s.payment_mode,
        notes: s.notes,
        booking_id: s.booking_id ?? null,
        booking_no: s.booking_no ?? null,
        merged_into_bill_id: s.merged_into_bill_id ?? null,
      })) as SnackSale[];
      writeCache(`snack_sales:${years.join("-")}`, rows);
      return rows;
    },
  });
}

export function useCreateSnackSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Omit<SnackSale, "id" | "bill_no">): Promise<SnackSale> => {
      const bill_no = await nextSnackBillNo();
      const id = newId();
      // Same tax freeze as bookings/bills (lib/biz.ts TaxSnapshot).
      const tax = freezeTax(payload.total);
      await db.snack_sales.add({
        id,
        bill_no,
        sale_date: payload.sale_date,
        customer_name: payload.customer_name,
        items: payload.items,
        total: payload.total,
        tax_amount: tax.taxAmount,
        tax_lines: tax.taxLines,
        profit: payload.profit,
        payment_mode: payload.payment_mode,
        notes: payload.notes,
        booking_id: payload.booking_id ?? null,
        booking_no: payload.booking_no ?? null,
        created_at: nowIso(),
      });

      // Reduce stock counts for the items sold (best-effort; never blocks the bill).
      try {
        const stockRows = await db.snack_items.toArray();
        for (const line of payload.items) {
          const row = stockRows.find((s) => s.item_name === line.item_name);
          if (!row) continue;
          const next = Math.max(0, Number(row.stock_quantity ?? 0) - line.qty);
          await db.snack_items.update(row.id, { stock_quantity: next });
        }
      } catch {
        // ignore stock sync failures
      }

      return { ...payload, tax_amount: tax.taxAmount, tax_lines: tax.taxLines, id, bill_no };
    },

    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["snack_sales"] });
      qc.invalidateQueries({ queryKey: ["snack_items"] });
    },
  });
}

export function useUpdateSnackSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Partial<SnackSale>) => {
      await db.snack_sales.update(id, patch);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snack_sales"] }),
  });
}

export function useDeleteSnackSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const sale = await db.snack_sales.get(id);
      await db.snack_sales.delete(id);

      // Restore stock for the items sold (best-effort, mirrors the decrement
      // in useCreateSnackSale; never blocks the delete).
      if (sale) {
        try {
          const items = (sale.items ?? []) as unknown as SnackSaleItem[];
          const stockRows = await db.snack_items.toArray();
          for (const line of items) {
            const row = stockRows.find((s) => s.item_name === line.item_name);
            if (!row) continue;
            const next = Math.max(0, Number(row.stock_quantity ?? 0) + line.qty);
            await db.snack_items.update(row.id, { stock_quantity: next });
          }
        } catch {
          // ignore stock sync failures
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["snack_sales"] });
      qc.invalidateQueries({ queryKey: ["snack_items"] });
    },
  });
}

export type ExpenseV2 = {
  id: string;
  expense_no: string | null;
  business: string;
  category: string;
  description: string | null;
  note: string | null;
  amount: number;
  spent_at: string;
  receipt_path: string | null;
};

export function useExpensesV2() {
  const { years } = useYearWindow();
  return useQuery({
    queryKey: ["expenses_v2", years],
    initialData: () => readCache<ExpenseV2[]>(`expenses_v2:${years.join("-")}`, []),
    queryFn: async () => {
      const raw = await rowsForYears<ExpenseRow>("expenses" as YearTable, years);
      const rows = sortBy(raw, "spent_at", "desc").map((e) => ({
        id: e.id,
        expense_no: e.expense_no,
        business: e.business ?? "Shared",
        category: e.category,
        description: e.description,
        note: e.note,
        amount: Number(e.amount),
        spent_at: e.spent_at,
        receipt_path: e.receipt_path,
      })) as ExpenseV2[];
      writeCache(`expenses_v2:${years.join("-")}`, rows);
      return rows;
    },
  });
}

export function useAddExpenseV2() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      business: string;
      category: string;
      description: string;
      amount: number;
      note: string;
      spent_at: string;
      receipt_path?: string | null;
    }) => {
      await db.expenses.add({
        id: newId(),
        expense_no: await nextExpenseNo(),
        business: payload.business,
        category: payload.category,
        description: payload.description || null,
        note: payload.note || null,
        amount: payload.amount,
        spent_at: new Date(payload.spent_at).toISOString(),
        receipt_path: payload.receipt_path ?? null,
        created_at: nowIso(),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses_v2"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

export function useDeleteExpenseV2() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await db.expenses.delete(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses_v2"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

export function useSnackCombos() {
  return useQuery({
    queryKey: ["snack_combos"],
    initialData: () => readCache<SnackCombo[]>("snack_combos", []),
    queryFn: async () => {
      const rows = sortBy(await db.snack_combos.toArray(), "name", "asc").map((r) => ({
        id: r.id,
        name: r.name,
        items: (r.items ?? []) as unknown as SnackCombo["items"],
        price: Number(r.price),
        is_active: r.is_active,
      })) as SnackCombo[];
      writeCache("snack_combos", rows);
      return rows;
    },
  });
}

export function useSaveSnackCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<SnackCombo> & { name: string }) => {
      const body = {
        name: payload.name,
        items: (payload.items ?? []) as unknown[],
        price: payload.price ?? 0,
        is_active: payload.is_active ?? true,
      };
      if (payload.id) {
        await db.snack_combos.update(payload.id, body);
        return;
      }
      await db.snack_combos.add({ id: newId(), created_at: nowIso(), ...body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snack_combos"] }),
  });
}

export function useDeleteSnackCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await db.snack_combos.delete(id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["snack_combos"] }),
  });
}
