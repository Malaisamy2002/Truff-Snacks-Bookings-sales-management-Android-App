import { useMemo } from "react";
import { MessageCircle, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  billGrossTotal,
  customerTag,
  formatDMY,
  money,
  sameCustomerName,
  whatsappUrl,
} from "@/lib/biz";
import { matchesCustomer, useBills } from "@/lib/data";
import { useSnackSales, useTurfBookings } from "@/lib/ops";
import { isFinancialBooking } from "@/lib/analytics";
import {
  billDue,
  billMovedToDues,
  bookingCashCollected,
  bookingDue,
  customerOutstanding,
  dueNoForRef,
  isFinancialSale,
  saleStateLabel,
  type CustomerDues,
} from "@/lib/dues";
import { TAB_REF_BILL, tabKey, useTabEntries, useTabSummaries } from "@/lib/tabs";
import { CustomerTabCard } from "./CustomerTabCard";

type Props = {
  name: string | null;
  phone: string | null;
  onOpenChange: (open: boolean) => void;
};

const same = sameCustomerName;

/** Everything about one customer: bills, bookings, snack orders and dues. */
export function CustomerDetailDialog({ name, phone, onOpenChange }: Props) {
  // Phone-first, name-fallback — same identity rule as everywhere else in the
  // app (matchesCustomer), so two different customers who share a name but
  // have different phones never get merged into one view here.
  const matches = (n: string | null | undefined, p?: string | null) =>
    matchesCustomer({ name: name ?? "", phone }, n, p);
  const { data: bills = [] } = useBills();
  const { data: bookings = [] } = useTurfBookings();
  const { data: sales = [] } = useSnackSales();
  const { data: tabEntries = [] } = useTabEntries();
  const tabSummaries = useTabSummaries();
  const tabBalance = name ? (tabSummaries.get(tabKey(name, phone))?.balance ?? 0) : 0;
  const myEntries = name ? tabEntries.filter((e) => e.customer_key === tabKey(name, phone)) : [];

  const data = useMemo(() => {
    if (!name) return null;
    const myBills = bills.filter((b) => matches(b.customer_name, b.customer_phone));
    // myBookings keeps merged rows in — it's used to render the raw booking
    // list below (with a "merged" badge), not to total money or visits.
    const myBookings = bookings.filter(
      (b) => matches(b.customer_name, b.phone) && b.status !== "Cancelled",
    );
    // Money and visit-count math routes through isFinancialBooking() so a
    // merged booking's amount/visit (already represented via myBills) isn't
    // counted twice — same rule as every other revenue/dues calc in the app.
    const myFinancialBookings = myBookings.filter(isFinancialBooking);
    const mySales = sales.filter((s) => same(s.customer_name, name));
    const myFinancialSales = mySales.filter(isFinancialSale);

    const spent =
      myBills.reduce((s, b) => s + billGrossTotal(b), 0) +
      myFinancialBookings.reduce((s, b) => s + (Number(b.total_amount) || 0), 0) +
      myFinancialSales.reduce((s, b) => s + (Number(b.total) || 0), 0);

    // The ONE dues source of truth — tab, bookings and bills, each counted once.
    const dues: CustomerDues = customerOutstanding(
      { name, phone },
      {
        bills: myBills,
        bookings: myBookings,
        tabEntries: myEntries,
        tabBalance,
        match: matches,
      },
    );

    return {
      myBills,
      myBookings,
      mySales,
      spent,
      dues,
      visits: myBills.length + myFinancialBookings.length + myFinancialSales.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bills, bookings, sales, name, phone, tabBalance, tabEntries]);

  return (
    <Dialog open={!!name} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <span className="truncate">{name}</span>
            {data && (
              <Badge variant={data.visits >= 5 ? "default" : "secondary"} className="shrink-0">
                {customerTag(data.visits)}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>{phone || "No phone saved"}</DialogDescription>
        </DialogHeader>

        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
              <Metric label="Visits" value={String(data.visits)} />
              <Metric label="Total spent" value={money(data.spent)} />
              <Metric label="Pending" value={money(data.dues.total)} danger={data.dues.total > 0} />
            </div>

            {data.dues.lines.length > 0 && (
              <div className="frost-well space-y-1 rounded-xl border p-3">
                <p className="micro-label">Pending breakdown</p>
                {data.dues.lines.map((l, i) => (
                  <div
                    key={`${l.kind}-${l.label}-${i}`}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 truncate text-muted-foreground">
                      {l.label}
                      {l.date ? ` · ${formatDMY(l.date)}` : ""}
                    </span>
                    <span className="stat-value shrink-0 text-sm text-destructive">
                      {money(l.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <CustomerTabCard
              name={name ?? ""}
              phone={phone}
              autoDue={data.dues.bookings + data.dues.bills}
            />

            {phone && (
              <div className="flex gap-2">
                <Button variant="outline" className="h-11 flex-1" asChild>
                  <a href={`tel:${phone}`}>
                    <Phone className="mr-1 size-4" /> Call
                  </a>
                </Button>
                <Button className="h-11 flex-1" asChild>
                  <a
                    href={whatsappUrl(
                      data.dues.total > 0
                        ? `Hi ${name}, your pending balance is ${money(data.dues.total)}. Thank you!`
                        : `Hi ${name}, thanks for visiting!`,

                      phone,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MessageCircle className="mr-1 size-4" /> WhatsApp
                  </a>
                </Button>
              </div>
            )}

            <Section title="Bills">
              {data.myBills.length === 0 ? (
                <Empty />
              ) : (
                data.myBills
                  .slice(0, 20)
                  .map((b) => (
                    <Row
                      key={b.id}
                      left={`${b.invoice_no} · ${formatDMY(b.bill_date)}`}
                      right={money(billGrossTotal(b))}
                      note={
                        billDue(b, myEntries) > 0
                          ? `Paid ${money(b.status === "paid" ? billGrossTotal(b) : b.amount_paid)} · Due ${money(billDue(b, myEntries))}`
                          : billMovedToDues(b, myEntries)
                            ? `On tab · ${dueNoForRef(myEntries, TAB_REF_BILL, b.id, b.invoice_no, b.bill_date)}`
                            : b.status
                      }
                    />
                  ))
              )}
            </Section>

            <Section title="Turf bookings">
              {data.myBookings.length === 0 ? (
                <Empty />
              ) : (
                data.myBookings.slice(0, 20).map((b) => {
                  const due = bookingDue(b, myEntries);
                  return (
                    <Row
                      key={b.id}
                      left={`${b.booking_no} · ${formatDMY(b.booking_date)}${
                        b.start_time ? ` · ${b.start_time}` : ""
                      }`}
                      right={money(b.total_amount)}
                      note={
                        b.merged_into_bill_id
                          ? "Merged into bill"
                          : due > 0
                            ? // Real cash taken, never `advance_paid` at face
                              // value — a balance moved to dues inflates that.
                              `Paid ${money(bookingCashCollected(b, myEntries))} · Due ${money(due)}`
                            : b.status
                      }
                    />
                  );
                })
              )}
            </Section>

            <Section title="Snack orders">
              {data.mySales.length === 0 ? (
                <Empty />
              ) : (
                data.mySales
                  .slice(0, 20)
                  .map((s) => (
                    <Row
                      key={s.id}
                      left={`${s.bill_no} · ${formatDMY(s.sale_date)}`}
                      right={money(s.total)}
                      note={saleStateLabel(s) ?? s.payment_mode}
                    />
                  ))
              )}
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Metric({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="frost-well rounded-xl border p-3">
      <p className="micro-label truncate">{label}</p>
      <p
        className={
          danger
            ? "stat-value truncate text-sm text-destructive"
            : "stat-value truncate text-sm text-primary"
        }
      >
        {value}
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="micro-label">{title}</p>
      <div className="frost-soft space-y-1 rounded-xl border p-2">{children}</div>
    </div>
  );
}

function Empty() {
  return <p className="px-1 py-2 text-xs text-muted-foreground">Nothing yet.</p>;
}

function Row({ left, right, note }: { left: string; right: string; note?: string }) {
  return (
    <div className="lift grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-1.5 py-1 text-sm sm:flex sm:justify-between">
      <span className="min-w-0 truncate">
        {left}
        {note && <span className="text-muted-foreground"> · {note}</span>}
      </span>
      <span className="stat-value shrink-0 text-sm">{right}</span>
    </div>
  );
}
