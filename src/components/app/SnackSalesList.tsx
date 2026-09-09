import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, Printer, ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDMY, money } from "@/lib/biz";
import { rupees } from "@/lib/money";
import { snackSaleReceipt, printReceipt, downloadReceipt } from "@/lib/receipt";
import { INVOICE_SECTIONS } from "@/lib/desktop";
import { exportToExcel } from "@/lib/xlsx";
import { useDeleteSnackSale, useSnackSales } from "@/lib/ops";
import { dueNoForRef, saleMovedToDues, saleStateLabel } from "@/lib/dues";
import { TAB_REF_SNACK_SALE, useTabEntries } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { useBills } from "@/lib/data";
import { Badge } from "@/components/ui/badge";
import { compareBy, sortSuffix, useSortState, type SortOption } from "@/lib/sort";
import { ListDisclosure } from "./ListDisclosure";
import { SectionHeading } from "@/components/app/SectionHeading";
import { LayoutPart, LayoutParts } from "./LayoutSection";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { SortMenu } from "./SortMenu";

const PAGE_SIZE = 25;

type SnackSaleSortField = "date" | "amount" | "customer";

const SNACK_SALE_SORT_OPTIONS: SortOption<SnackSaleSortField>[] = [
  { value: "date", label: "Date", defaultDir: "desc" },
  { value: "amount", label: "Amount", defaultDir: "desc" },
  { value: "customer", label: "Customer", defaultDir: "asc" },
];

/** Legacy snacks-only bills, kept visible inside the combined Turf & Snacks tab. */
export function SnackSalesList() {
  const { data: sales = [] } = useSnackSales();
  const del = useDeleteSnackSale();
  const { data: bills = [] } = useBills();
  const { data: tabEntries = [] } = useTabEntries();
  const invoiceNoById = useMemo(() => new Map(bills.map((b) => [b.id, b.invoice_no])), [bills]);

  const sort = useSortState<SnackSaleSortField>("snack-sales", SNACK_SALE_SORT_OPTIONS, {
    field: "date",
    dir: "desc",
  });
  const sortedSales = useMemo(
    () =>
      [...sales].sort((a, b) => {
        switch (sort.field) {
          case "amount":
            return compareBy(a.total, b.total, sort.dir);
          case "customer":
            return compareBy(
              (a.customer_name ?? "").toLowerCase(),
              (b.customer_name ?? "").toLowerCase(),
              sort.dir,
            );
          case "date":
          default:
            return compareBy(a.sale_date, b.sale_date, sort.dir);
        }
      }),
    [sales, sort.field, sort.dir],
  );

  /** Set by the calendar-popup on the "Date" sort control — narrows the
   * snack bills list to exactly one day. */
  const [saleDate, setSaleDate] = useState<string | undefined>(undefined);
  const dateFilteredSales = useMemo(
    () => (saleDate ? sortedSales.filter((s) => s.sale_date === saleDate) : sortedSales),
    [sortedSales, saleDate],
  );

  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(dateFilteredSales.length / PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [sales.length, sort.field, sort.dir, saleDate]);
  const pageSales = useMemo(
    () => dateFilteredSales.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [dateFilteredSales, page],
  );

  const exportSales = () =>
    exportToExcel(
      dateFilteredSales.flatMap((s) =>
        s.items.map((it) => ({
          "Bill No": s.bill_no,
          Date: formatDMY(s.sale_date),
          Customer: s.customer_name ?? "",
          Item: it.item_name,
          Qty: it.qty,
          "Unit Price": it.unit_price,
          Amount: it.amount,
          Profit: rupees(it.amount - it.qty * it.cost_price),
          "Payment Mode": s.payment_mode,
          Notes: s.notes ?? "",
        })),
      ),
      `snack-sales-${sortSuffix(sort.field, sort.dir)}`,
      "Snack Sales",
      INVOICE_SECTIONS.snacks,
    );

  return (
    <Card>
      <CardContent className="space-y-4">
        <LayoutParts sectionId="snacks.sales" className="space-y-4">
          <LayoutPart id="snacks.sales.toolbar">
            <SectionHeading
              icon={Receipt}
              eyebrow="Bills"
              title="Saved snack bills"
              action={
                <div className="flex items-center gap-2">
                  <SortMenu
                    options={SNACK_SALE_SORT_OPTIONS}
                    field={sort.field}
                    dir={sort.dir}
                    onFieldChange={sort.setField}
                    onToggleDir={sort.toggleDir}
                    dateField="date"
                    selectedDate={saleDate}
                    onSelectDate={setSaleDate}
                  />
                  <Button size="sm" variant="outline" onClick={exportSales}>
                    <Download className="mr-1 h-4 w-4" /> Excel
                  </Button>
                </div>
              }
            />
          </LayoutPart>
          <LayoutPart id="snacks.sales.list" className="space-y-4">
            <ListDisclosure
              storageKey="snacks.sales"
              label="Saved snack bills"
              count={dateFilteredSales.length}
            >
              {saleDate && (
                <div className="frost-soft flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm">
                  <span>
                    Showing <span className="font-medium">{dateFilteredSales.length}</span> snack
                    bill
                    {dateFilteredSales.length === 1 ? "" : "s"} for{" "}
                    <span className="font-medium">{formatDMY(saleDate)}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setSaleDate(undefined)}>
                    Clear
                  </Button>
                </div>
              )}
              {sales.length === 0 && (
                <p className="text-sm text-muted-foreground">No snack bills yet.</p>
              )}
              {pageSales.map((s) => {
                const moved = saleMovedToDues(s, tabEntries);
                const dueNo = moved
                  ? dueNoForRef(tabEntries, TAB_REF_SNACK_SALE, s.id, s.bill_no, s.sale_date)
                  : null;
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "frost-soft lift rounded-xl border p-3 text-sm",
                      moved && "opacity-60 saturate-50",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="flex flex-wrap items-center gap-2 font-semibold">
                          <span>
                            {s.bill_no}
                            {s.customer_name ? ` · ${s.customer_name}` : ""}
                          </span>
                          {moved ? (
                            <Badge variant="secondary">Moved to dues · {dueNo}</Badge>
                          ) : (
                            (() => {
                              const state = saleStateLabel(
                                s,
                                s.merged_into_bill_id
                                  ? invoiceNoById.get(s.merged_into_bill_id)
                                  : null,
                              );
                              return state ? <Badge variant="outline">{state}</Badge> : null;
                            })()
                          )}
                        </p>
                        <p className="text-muted-foreground">
                          {formatDMY(s.sale_date)} · {s.payment_mode}
                          {s.booking_no ? ` · Linked to ${s.booking_no}` : ""}
                        </p>
                        <ul className="mt-1 text-muted-foreground">
                          {s.items.map((it, i) => (
                            <li key={i}>
                              {it.item_name} · {it.qty} × {money(it.unit_price)} ={" "}
                              {money(it.amount)}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1 font-medium">
                          Total <span className="stat-value">{money(s.total)}</span>
                        </p>
                        {moved && (
                          <p className="text-xs text-muted-foreground">
                            On {s.customer_name || "the customer"}'s dues — collect it from the Dues
                            tab so the same money isn't counted twice.
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="touch"
                          variant="outline"
                          aria-label="Print snack bill"
                          title="Print bill"
                          onClick={() =>
                            printReceipt(snackSaleReceipt(s), undefined, INVOICE_SECTIONS.snacks)
                          }
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                        <Button
                          size="touch"
                          variant="outline"
                          aria-label="Download snack bill"
                          title="Download PDF"
                          onClick={() =>
                            downloadReceipt(snackSaleReceipt(s), undefined, INVOICE_SECTIONS.snacks)
                          }
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        <ConfirmDeleteButton
                          size="touch"
                          ariaLabel="Delete snack bill"
                          title={`Delete snack bill ${s.bill_no}?`}
                          description={`This permanently removes ${s.bill_no} (${money(s.total)}) and restores the sold items back to stock. This can't be undone.`}
                          onConfirm={() =>
                            del.mutate(s.id, {
                              onSuccess: () => toast.success("Deleted"),
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                );
              })}

              {dateFilteredSales.length > PAGE_SIZE && (
                <div className="flex items-center justify-between pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" /> Prev
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {page} of {pageCount} · {dateFilteredSales.length} bills
                    {saleDate ? ` (of ${sales.length} total)` : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  >
                    Next <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              )}
            </ListDisclosure>
          </LayoutPart>
        </LayoutParts>
      </CardContent>
    </Card>
  );
}
