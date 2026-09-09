import { rupees } from "@/lib/money";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  IndianRupee,
  Trophy,
  Cookie,
  AlertCircle,
  Banknote,
  Smartphone,
  Wallet,
  TrendingUp,
  Receipt,
  MessageCircle,
  PiggyBank,
  Lightbulb,
  CalendarClock,
  PartyPopper,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useBills, useUpdateBill } from "@/lib/data";
import { useTurfBookings, useUpdateTurfBooking, useSnackSales, useExpensesV2 } from "@/lib/ops";
import { billGrossTotal, billPaidAmount, bookingGrossTotal, formatDMY, money, whatsappUrl } from "@/lib/biz";
import { billDue, bookingDue } from "@/lib/dues";
import { useTabEntries } from "@/lib/tabs";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { LayoutSection, LayoutSections, LayoutPart, LayoutParts } from "./LayoutSection";
import {
  readAppSettings,
  writeAppSettings,
  monthlyReportDueKey,
} from "@/lib/settings";
import {
  downloadReportPdf,
  reportPdfMoney,
  shareReportPdf,
  type ReportPdfDoc,
} from "@/lib/report-pdf";
import { readPrintSettings } from "@/lib/print";
import {
  dayKey,
  expenseByCategory,
  lastMonthKeys,
  monthKey,
  monthLabel,
  paymentSplit,
  pctChange,
  prevMonthKey,
  profitAndLoss,
  statsForDay,
  statsForMonth,
  type Sources,
} from "@/lib/analytics";
import { compareBy, useSortState, type SortOption } from "@/lib/sort";
import { DeltaStat } from "./DeltaStat";
import { HeroStat, MiniStat } from "./HeroStat";
import { DuesFocusCard } from "./DuesFocusCard";
import { SectionHeading } from "./SectionHeading";
import { SortMenu } from "./SortMenu";
import { TurfUtilizationCard } from "./TurfUtilizationCard";

const isToday = (iso: string | null | undefined) => {
  if (!iso) return false;
  return dayKey(iso) === dayKey(new Date());
};

/** One hue per business line, used consistently across badges and charts. */
const LINE_BADGE = {
  bill: "border-bills/40 bg-bills/10 text-bills",
  turf: "border-turf/40 bg-turf/10 text-turf",
} as const;

const WEEKDAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

type DuesSortField = "date" | "amount";

const DUES_SORT_OPTIONS: SortOption<DuesSortField>[] = [
  { value: "date", label: "Due date", defaultDir: "asc" },
  { value: "amount", label: "Amount due", defaultDir: "desc" },
];

type DueRow = {
  key: string;
  kind: "bill" | "turf";
  id: string;
  label: string;
  sub: string;
  date: string;
  due: number;
  total: number;
  /** Amount already paid, so a partial collection can be added on top. */
  paid: number;
  phone: string | null;
};

type AgeBucket = "overdue" | "month" | "week" | "today";

const AGE_BUCKET_META: Record<AgeBucket, string> = {
  overdue: "30+ days overdue",
  month: "This month",
  week: "This week",
  today: "Today",
};

/** Overdue-first order so the oldest money owed surfaces at the top. */
const AGE_BUCKET_ORDER: AgeBucket[] = ["overdue", "month", "week", "today"];

function ageBucket(dateIso: string): AgeBucket {
  const ageDays = Math.floor((Date.now() - new Date(dateIso).getTime()) / 86_400_000);
  if (ageDays >= 30) return "overdue";
  if (ageDays >= 7) return "month";
  if (ageDays >= 1) return "week";
  return "today";
}

export function DashboardTab() {
  const { data: bills = [] } = useBills();
  const { data: bookings = [] } = useTurfBookings();
  const { data: snackSales = [] } = useSnackSales();
  const { data: expenses = [] } = useExpensesV2();
  const updateBill = useUpdateBill();
  const updateBooking = useUpdateTurfBooking();

  const { data: tabEntries = [] } = useTabEntries();

  // The tab ledger MUST ride along: a balance moved onto a customer's running
  // tab is owed on the Dues tab, and periodStats() needs the ledger to take it
  // off the source booking/bill (and to count tab payments as collected).
  const src = useMemo<Sources>(
    () => ({ bills, bookings, sales: snackSales, expenses, tabEntries }),
    [bills, bookings, snackSales, expenses, tabEntries],
  );

  const thisMonth = monthKey(new Date());
  const today = dayKey(new Date());

  const day = useMemo(() => statsForDay(src, today), [src, today]);
  const month = useMemo(() => statsForMonth(src, thisMonth), [src, thisMonth]);
  const prev = useMemo(() => statsForMonth(src, prevMonthKey(thisMonth)), [src, thisMonth]);

  const totals = useMemo(() => {
    // One canonical "still owed" figure — billDue()/bookingDue() from
    // dues.ts: frozen tax included, anything moved to the running tab
    // excluded — the same rupee the Bills/Turf/Dues tabs show.
    const billsDue = bills.reduce((s, b) => s + billDue(b, tabEntries), 0);
    const turfDue = bookings.reduce((s, b) => s + bookingDue(b, tabEntries), 0);
    return {
      totalDue: billsDue + turfDue,
      // Event count, not money — a merged booking still happened today as
      // a visit, so it's intentionally NOT filtered through
      // isFinancialBooking here (only Cancelled is excluded).
      bookingsToday: bookings.filter((b) => isToday(b.booking_date) && b.status !== "Cancelled")
        .length,
      snackSalesToday: snackSales.filter((s) => isToday(s.sale_date)).length,
    };
  }, [bills, bookings, snackSales, tabEntries]);

  // Cash reconciliation: what should be sitting in the drawer right now.
  // Expenses have no payment-mode field of their own, so — like the rest of
  // this small cash business — they're assumed paid out of the drawer unless
  // the owner knows otherwise; the hint below says so explicitly.
  const cashReconciliation = useMemo(() => {
    const cashCollectedToday =
      paymentSplit(src, (iso) => dayKey(iso) === today).find((p) => p.name === "Cash")?.value ?? 0;
    const cashExpensesToday = expenses
      .filter((e) => dayKey(e.spent_at) === today)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return {
      cashCollectedToday,
      cashExpensesToday,
      expectedInDrawer: cashCollectedToday - cashExpensesToday,
    };
  }, [src, expenses, today]);

  const daily = useMemo(() => {
    const out: { day: string; Collected: number; Expenses: number }[] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const s = statsForDay(src, dayKey(d));
      out.push({
        day: d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
        Collected: s.collected,
        Expenses: s.expenses,
      });
    }
    return out;
  }, [src]);

  const trend = useMemo(() => profitAndLoss(src, lastMonthKeys(thisMonth, 6)), [src, thisMonth]);

  // Cash vs online collected today — the only part of the retired payment-mode
  // pie that still earns its space, now as two plain figures.
  const collectedTodayByMode = useMemo(() => {
    const rows = paymentSplit(src, (iso) => dayKey(iso) === today);
    const cash = rows.find((p) => p.name === "Cash")?.value ?? 0;
    const online = rows
      .filter((p) => p.name === "UPI" || p.name === "Card")
      .reduce((n, p) => n + p.value, 0);
    return { cash, online };
  }, [src, today]);


  // "Monthly summary on the 1st": checked here on every app open rather than
  // via a real scheduler (see monthlyReportDueKey's own note on why).
  const [monthlyReportSettings, setMonthlyReportSettings] = useState(() => readAppSettings());
  const dueReportKey = useMemo(
    () => monthlyReportDueKey(monthlyReportSettings),
    [monthlyReportSettings],
  );

  const buildMonthlyStatementDoc = (key: string): ReportPdfDoc => {
    const s = readPrintSettings();
    const stats = statsForMonth(src, key);
    const prevKey = prevMonthKey(key);
    const prevStats = statsForMonth(src, prevKey);
    const monthSplit = paymentSplit(src, (iso) => monthKey(iso) === key);
    const monthCategories = expenseByCategory(src, (iso) => monthKey(iso) === key);
    const monthPnl = profitAndLoss(src, lastMonthKeys(key, 6));
    return {
      title: `Monthly statement — ${monthLabel(key)}`,
      subtitle: `${s.shopName || "Business"} · generated for ${monthLabel(key)}`,
      fileName: `statement-${key}`,
      tables: [
        {
          title: `${monthLabel(key)} vs ${monthLabel(prevKey)}`,
          columns: ["Metric", monthLabel(key), monthLabel(prevKey), "Change"],
          rows: [
            { label: "Net revenue", cur: stats.netRevenue, prev: prevStats.netRevenue },
            { label: "Tax", cur: stats.tax, prev: prevStats.tax },
            { label: "Revenue (incl. tax)", cur: stats.revenue, prev: prevStats.revenue },
            { label: "Collected", cur: stats.collected, prev: prevStats.collected },
            { label: "Expenses", cur: stats.expenses, prev: prevStats.expenses },
            { label: "Profit", cur: stats.profit, prev: prevStats.profit },
          ].map((r) => ({
            cells: [
              r.label,
              reportPdfMoney(r.cur, s.currencySymbol),
              reportPdfMoney(r.prev, s.currencySymbol),
              (() => {
                const change = pctChange(r.cur, r.prev);
                return change === null ? "n/a" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
              })(),
            ],
            strong: r.label === "Profit",
            negative: r.label === "Profit" && r.cur < 0,
          })),
        },
        {
          title: "Profit & loss — last 6 months",
          columns: ["Month", "Revenue (incl. tax)", "Expenses", "Profit", "Collected"],
          rows: monthPnl.map((r) => ({
            cells: [
              r.month,
              reportPdfMoney(r.Revenue, s.currencySymbol),
              reportPdfMoney(r.Expenses, s.currencySymbol),
              reportPdfMoney(r.Profit, s.currencySymbol),
              reportPdfMoney(r.Collected, s.currencySymbol),
            ],
            negative: r.Profit < 0,
          })),
        },
        {
          title: "Payment modes",
          columns: ["Mode", "Amount"],
          rows: monthSplit.map((p) => ({
            cells: [p.name, reportPdfMoney(p.value, s.currencySymbol)],
          })),
        },
        {
          title: "Expenses by category",
          columns: ["Category", "Amount"],
          rows: monthCategories.map((c) => ({
            cells: [c.name, reportPdfMoney(c.value, s.currencySymbol)],
          })),
        },
      ],
    };
  };

  const dismissMonthlyReport = (key: string) => {
    const next = { ...readAppSettings(), monthlyReportLastSentKey: key };
    writeAppSettings(next);
    setMonthlyReportSettings(next);
  };

  const shareMonthlyReport = (key: string) => {
    const stats = statsForMonth(src, key);
    const text = `${monthLabel(key)} statement: revenue ${money(stats.revenue)} (incl. tax), profit ${money(stats.profit)}.`;
    shareReportPdf(buildMonthlyStatementDoc(key), whatsappUrl(text)).then(
      (result) => {
        if (result !== "cancelled") {
          toast.success("Statement ready to share");
          dismissMonthlyReport(key);
        }
      },
      (e) => toast.error(e instanceof Error ? e.message : "Could not share PDF"),
    );
  };

  const dueSort = useSortState<DuesSortField>("dashboard-dues", DUES_SORT_OPTIONS, {
    field: "date",
    dir: "asc",
  });

  const dueList = useMemo<DueRow[]>(() => {
    // Same canonical due as the hero figure above (billDue/bookingDue):
    // tax-inclusive via the FROZEN tax on each record, and net of anything
    // already moved to the customer's running tab.
    const billRows: DueRow[] = bills
      .map((b) => ({
        key: `bill-${b.id}`,
        kind: "bill" as const,
        id: b.id,
        label: b.customer_name,
        sub: `Invoice ${b.invoice_no}`,
        date: b.bill_date,
        due: billDue(b, tabEntries),
        total: billGrossTotal(b),
        paid: billPaidAmount(b),
        phone: b.customer_phone,
      }))
      .filter((r) => r.due > 0);
    const turfRows: DueRow[] = bookings
      .map((b) => ({
        key: `turf-${b.id}`,
        kind: "turf" as const,
        id: b.id,
        label: b.customer_name,
        sub: `Turf ${b.booking_no} · ${b.slot_name}`,
        date: b.booking_date,
        due: bookingDue(b, tabEntries),
        total: bookingGrossTotal(b),
        paid: rupees(b.advance_paid),
        phone: b.phone,
      }))
      .filter((r) => r.due > 0);
    return [...billRows, ...turfRows].sort((a, b) =>
      dueSort.field === "amount"
        ? compareBy(a.due, b.due, dueSort.dir)
        : compareBy(new Date(a.date).getTime(), new Date(b.date).getTime(), dueSort.dir),
    );
  }, [bills, bookings, tabEntries, dueSort.field, dueSort.dir]);

  const [dueVisible, setDueVisible] = useState(25);
  const visibleDueList = useMemo(() => dueList.slice(0, dueVisible), [dueList, dueVisible]);

  // Plain-sentence callouts — turns raw numbers already on this page into
  // "what to do" rather than "what happened". Each rule only fires when the
  // signal is strong enough to be worth a line (thresholds below), so this
  // stays a short, high-signal strip rather than restating every stat.
  const insightStrip = useMemo(() => {
    const list: string[] = [];
    const lookbackDays = 60;

    const weekdayTotals: number[][] = Array.from({ length: 7 }, () => []);
    for (let i = 0; i < lookbackDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const s = statsForDay(src, dayKey(d));
      weekdayTotals[(d.getDay() + 6) % 7]!.push(s.turfRevenue + s.snacksRevenue);
    }
    const weekdayAvg = weekdayTotals.map((arr) =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
    );
    const overallAvg = weekdayAvg.reduce((a, b) => a + b, 0) / 7;
    if (overallAvg > 0) {
      const bestIdx = weekdayAvg.reduce((best, v, i, arr) => (v > arr[best]! ? i : best), 0);
      const pctAbove = ((weekdayAvg[bestIdx]! - overallAvg) / overallAvg) * 100;
      if (pctAbove >= 10) {
        list.push(
          `${WEEKDAY_LABELS[bestIdx]}s earn ${pctAbove.toFixed(0)}% more than your daily average — consider peak pricing.`,
        );
      }
    }

    const overdueRows = dueList.filter((r) => ageBucket(r.date) === "overdue");
    if (overdueRows.length > 0) {
      const total = overdueRows.reduce((s, r) => s + r.due, 0);
      const customers = new Set(overdueRows.map((r) => r.label)).size;
      list.push(
        `${money(total)} has been outstanding for over 30 days across ${customers} customer${customers === 1 ? "" : "s"}.`,
      );
    }

    if (month.snacksRevenue > 0 && prev.snacksRevenue > 0) {
      const curMargin = (month.snackProfit / month.snacksRevenue) * 100;
      const prevMargin = (prev.snackProfit / prev.snacksRevenue) * 100;
      const diff = curMargin - prevMargin;
      if (Math.abs(diff) >= 3) {
        list.push(
          `Snack margin is ${curMargin.toFixed(0)}% this month, ${diff > 0 ? "up" : "down"} from ${prevMargin.toFixed(0)}% last month.`,
        );
      }
    }

    return list.slice(0, 3);
  }, [src, dueList, month, prev]);

  const groupedDueList = useMemo(() => {
    const groups = new Map<AgeBucket, DueRow[]>();
    for (const row of visibleDueList) {
      const bucket = ageBucket(row.date);
      const list = groups.get(bucket) ?? [];
      list.push(row);
      groups.set(bucket, list);
    }
    return AGE_BUCKET_ORDER.filter((b) => groups.has(b)).map((bucket) => ({
      bucket,
      rows: groups.get(bucket)!,
    }));
  }, [visibleDueList]);

  // Ageing summary over the FULL due list (not just the visible page), so the
  // "Money owed to me" card never under-reports when the list is truncated.
  const dueBuckets = useMemo(() => {
    const totals = new Map<AgeBucket, { total: number; count: number }>();
    for (const row of dueList) {
      const bucket = ageBucket(row.date);
      const cur = totals.get(bucket) ?? { total: 0, count: 0 };
      cur.total += row.due;
      cur.count += 1;
      totals.set(bucket, cur);
    }
    return AGE_BUCKET_ORDER.map((bucket) => ({
      id: bucket,
      label: AGE_BUCKET_META[bucket],
      total: totals.get(bucket)?.total ?? 0,
      count: totals.get(bucket)?.count ?? 0,
      tone: bucket === "overdue" ? ("bad" as const) : ("normal" as const),
    }));
  }, [dueList]);

  const topDebtors = useMemo(
    () =>
      [...dueList]
        .sort((a, b) => b.due - a.due)
        .slice(0, 3)
        .map((r) => ({
          key: r.key,
          label: r.label,
          sub: `${r.sub} · ${formatDMY(r.date)}`,
          date: r.date,
          due: r.due,
          phone: r.phone,
        })),
    [dueList],
  );



  // Partial collection: each row can have its own in-progress amount, which
  // defaults to the full due (so a plain tap on Cash/UPI still settles it in
  // one go, matching the previous behaviour).
  const [collectAmounts, setCollectAmounts] = useState<Record<string, string>>({});
  const amountFor = (row: DueRow) => {
    const raw = collectAmounts[row.key];
    return raw === undefined ? row.due : raw;
  };

  const collect = (row: DueRow, mode: "Cash" | "UPI") => {
    const requested = rupees(amountFor(row));
    const amount = Math.min(row.due, Math.max(0, requested));
    if (amount <= 0) {
      toast.error("Enter an amount to collect");
      return;
    }
    const newPaid = row.paid + amount;
    // Settled when THIS record's own due is cleared — part of its gross may
    // legitimately sit on the running tab, so compare against `due`, not
    // against the gross total.
    const isFullySettled = amount >= row.due - 0.01;
    if (row.kind === "bill") {
      updateBill.mutate(
        {
          id: row.id,
          status: isFullySettled ? "paid" : "partial",
          amount_paid: newPaid,
          payment_mode: mode,
        },
        {
          onSuccess: () => {
            toast.success(`Collected ${money(amount)} via ${mode}`);
            setCollectAmounts((prev) => {
              const next = { ...prev };
              delete next[row.key];
              return next;
            });
          },
          onError: (e) => toast.error(e.message),
        },
      );
    } else {
      updateBooking.mutate(
        { id: row.id, advance_paid: newPaid, payment_mode: mode },
        {
          onSuccess: () => {
            toast.success(`Collected ${money(amount)} via ${mode}`);
            setCollectAmounts((prev) => {
              const next = { ...prev };
              delete next[row.key];
              return next;
            });
          },
          onError: (e) => toast.error(e.message),
        },
      );
    }
  };

  const sendReminder = (row: DueRow) => {
    if (!row.phone) {
      toast.error("No phone number on file for this customer");
      return;
    }
    const text = `Hi ${row.label}, a friendly reminder that ${money(row.due)} is pending for ${row.sub}. Please pay at your convenience — thank you!`;
    void openExternal(whatsappUrl(text, row.phone));
  };

  const supportingCards = [
    {
      title: "Tax today",
      value: money(day.tax),
      icon: Receipt,
      hint: "Included in collected",
    },
    {
      title: "Turf bookings",
      value: String(totals.bookingsToday),
      icon: Trophy,
      hint: "Confirmed & completed",
    },
    {
      title: "Snack sales",
      value: String(totals.snackSalesToday),
      icon: Cookie,
      hint: "Bills issued",
    },
    {
      title: "Expenses today",
      value: money(day.expenses),
      icon: Wallet,
      hint: "All businesses",
    },
  ];

  type MonthCard = {
    title: string;
    value: number;
    change: number | null;
    invert: boolean;
    hint?: string;
  };
  const monthCards: MonthCard[] = [
    {
      title: "Month net revenue",
      value: month.netRevenue,
      change: pctChange(month.netRevenue, prev.netRevenue),
      invert: false,
      hint: "Bills + turf + snacks, no tax",
    },
    {
      title: "Month tax",
      value: month.tax,
      change: pctChange(month.tax, prev.tax),
      invert: false,
      hint: "GST & custom taxes collected",
    },
    {
      title: "Month revenue (incl. tax)",
      value: month.revenue,
      change: pctChange(month.revenue, prev.revenue),
      invert: false,
      hint: "Net revenue + tax",
    },
    {
      title: "Month collected",
      value: month.collected,
      change: pctChange(month.collected, prev.collected),
      invert: false,
    },
    {
      title: "Month expenses",
      value: month.expenses,
      change: pctChange(month.expenses, prev.expenses),
      invert: true,
    },
    {
      title: "Month profit",
      value: month.profit,
      change: pctChange(month.profit, prev.profit),
      invert: false,
    },
  ];

  return (
    <LayoutSections tabId="home" className="space-y-6">
      <SectionHeading
        eyebrow="TODAY"
        title="Dashboard"
        hint={`${monthLabel(thisMonth)} snapshot · updated live`}
        icon={IndianRupee}
      />

      <LayoutSection id="home.report-ready">
        {dueReportKey && (
          <Card className="frost lift border-primary/30">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <CalendarClock className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 truncate">
                  Your <strong>{monthLabel(dueReportKey)}</strong> statement is ready to share.
                </span>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dismissMonthlyReport(dueReportKey)}
                >
                  Not now
                </Button>
                <Button size="sm" onClick={() => shareMonthlyReport(dueReportKey)}>
                  <MessageCircle className="h-3.5 w-3.5" /> Share on WhatsApp
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </LayoutSection>

      <LayoutSection id="home.insights">
        {insightStrip.length > 0 && (
          <Card className="frost border-primary/20">
            <CardContent className="space-y-1.5 p-4">
              <p className="micro-label mb-1 flex items-center gap-1.5">
                <Lightbulb className="h-3.5 w-3.5 text-primary" /> Insights
              </p>
              {insightStrip.map((line, i) => (
                <p key={i} className="flex items-start gap-2 text-sm">
                  <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>{line}</span>
                </p>
              ))}
            </CardContent>
          </Card>
        )}
      </LayoutSection>

      <LayoutSection id="home.today-numbers">
        <section className="space-y-3">
          <LayoutParts sectionId="home.today-numbers" className="space-y-3">
          <LayoutPart id="home.today-numbers.heading">
          <SectionHeading eyebrow="RIGHT NOW" title="Today's headline numbers" />
          </LayoutPart>
          <LayoutPart id="home.today-numbers.collected">
            <HeroStat
              label="Collected today"
              value={money(day.collected)}
              hint="Bills + turf + snacks"
              icon={IndianRupee}
              tone="good"
            />
          </LayoutPart>
          <LayoutPart id="home.today-numbers.pending">
            <HeroStat
              label="Pending dues"
              value={money(totals.totalDue)}
              hint={`${dueList.length} unpaid · bills + turf`}
              icon={AlertCircle}
              tone={totals.totalDue > 0 ? "bad" : "primary"}
            />
          </LayoutPart>

          <LayoutPart id="home.today-numbers.supporting" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {supportingCards.map((c) => (
              <MiniStat key={c.title} label={c.title} value={c.value} hint={c.hint} icon={c.icon} />
            ))}
          </LayoutPart>
          </LayoutParts>
        </section>
      </LayoutSection>

      <LayoutSection id="home.month-compare">
        <section className="space-y-3">
          <LayoutParts sectionId="home.month-compare" className="space-y-3">
          <LayoutPart id="home.month-compare.heading">
          <SectionHeading
            eyebrow="THIS MONTH"
            title={`${monthLabel(thisMonth)} vs ${monthLabel(prevMonthKey(thisMonth))}`}
            icon={TrendingUp}
          />
          </LayoutPart>
          <LayoutPart id="home.month-compare.cards">
          <Card className="frost">
            <CardContent className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
              {monthCards.map((c) => (
                <div key={c.title} className="frost-soft rounded-xl border p-3">
                  <p className="micro-label">{c.title}</p>
                  <p className="stat-value mt-1 text-lg leading-tight">{money(c.value)}</p>
                  <DeltaStat change={c.change} invert={c.invert} />
                  {c.hint && (
                    <p className="mt-1 text-[10px] leading-tight text-muted-foreground">{c.hint}</p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
          </LayoutPart>
          </LayoutParts>
        </section>
      </LayoutSection>

      <LayoutSection id="home.trend-14d">
        <section className="space-y-3">
          <SectionHeading eyebrow="TRENDS" title="Collected vs expenses · last 14 days" />
          <Card className="frost">
            <CardContent className="h-64 px-2 pt-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="day" fontSize={10} interval="preserveStartEnd" />
                  <YAxis fontSize={10} width={44} />
                  <Tooltip formatter={(v: number) => money(v)} />
                  <Bar dataKey="Collected" fill="var(--chart-1)" radius={4} />
                  <Bar dataKey="Expenses" fill="var(--chart-3)" radius={4} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </section>
      </LayoutSection>

      <LayoutSection id="home.cash-drawer">
        <section className="space-y-3">
          <LayoutParts sectionId="home.cash-drawer" className="space-y-3">
          <LayoutPart id="home.cash-drawer.heading">
          <SectionHeading eyebrow="CASH DRAWER" title="Cash in drawer today" icon={PiggyBank} />
          </LayoutPart>
          <LayoutPart id="home.cash-drawer.drawer">
          <Card className="frost">
            <CardContent className="p-4">
              <div className="frost-well rounded-xl p-4">
                <p
                  className={cn(
                    "stat-hero",
                    cashReconciliation.expectedInDrawer < 0 ? "text-destructive" : "text-success",
                  )}
                >
                  {money(cashReconciliation.expectedInDrawer)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {money(cashReconciliation.cashCollectedToday)} cash collected −{" "}
                  {money(cashReconciliation.cashExpensesToday)} expenses today. Count the till
                  against this at closing (expenses are assumed cash unless you track otherwise).
                </p>
              </div>
            </CardContent>
          </Card>
          </LayoutPart>
          </LayoutParts>
        </section>
      </LayoutSection>

      <LayoutSection id="home.profit-trend">
        <section className="space-y-3">
          <SectionHeading eyebrow="TRENDS" title="Profit trend · 6 months" />
          <Card className="frost">
            <CardContent className="h-64 px-2 pt-4">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="month" fontSize={11} />
                  <YAxis fontSize={10} width={44} />
                  <Tooltip formatter={(v: number) => money(v)} />
                  <Line
                    type="monotone"
                    dataKey="Revenue"
                    name="Revenue (incl. tax)"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                  />
                  <Line type="monotone" dataKey="Profit" stroke="var(--chart-2)" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </section>
      </LayoutSection>

      <LayoutSection id="home.dues-focus">
        <DuesFocusCard
          total={totals.totalDue}
          buckets={dueBuckets}
          topDebtors={topDebtors}
          cashCollected={collectedTodayByMode.cash}
          onlineCollected={collectedTodayByMode.online}
          onRemind={(row) => {
            const match = dueList.find((r) => r.key === row.key);
            if (match) sendReminder(match);
          }}
        />
      </LayoutSection>


      <LayoutSection id="home.turf-utilization">
        <TurfUtilizationCard bookings={bookings} />
      </LayoutSection>

      <LayoutSection id="home.collect-now">
        <section className="space-y-3">
          <LayoutParts sectionId="home.collect-now" className="space-y-3">
          <LayoutPart id="home.collect-now.heading">
          <SectionHeading
            eyebrow="COLLECTIONS"
            title="Collect now"
            hint={`${money(totals.totalDue)} outstanding`}
            action={
              <SortMenu
                options={DUES_SORT_OPTIONS}
                field={dueSort.field}
                dir={dueSort.dir}
                onFieldChange={(f) => {
                  dueSort.setField(f);
                  setDueVisible(25);
                }}
                onToggleDir={() => {
                  dueSort.toggleDir();
                  setDueVisible(25);
                }}
              />
            }
          />
          </LayoutPart>
          <LayoutPart id="home.collect-now.list">
          <Card className="frost">
            <CardContent className="space-y-4 p-4">
              {dueList.length === 0 && (
                <p className="flex items-center justify-center gap-1.5 py-6 text-center text-sm text-muted-foreground">
                  No pending dues. Everything is collected
                  <PartyPopper className="h-4 w-4 text-success" />
                </p>
              )}
              {groupedDueList.map(({ bucket, rows }) => (
                <div key={bucket} className="space-y-2">
                  <p
                    className={cn(
                      "stat-label",
                      bucket === "overdue" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {AGE_BUCKET_META[bucket]} · {rows.length}
                  </p>
                  {rows.map((row) => (
                    <div
                      key={row.key}
                      className="frost-soft lift flex flex-wrap items-center gap-2 rounded-xl border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{row.label}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {row.sub} · {formatDMY(row.date)}
                        </p>
                      </div>
                      <Badge variant="outline" className={LINE_BADGE[row.kind]}>
                        {row.kind === "bill" ? "Bill" : "Turf"}
                      </Badge>

                      <p className="text-sm font-bold text-destructive">{money(row.due)}</p>
                      <Input
                        type="number"
                        min={0}
                        max={row.due}
                        value={amountFor(row)}
                        onChange={(e) =>
                          setCollectAmounts((prev) => ({ ...prev, [row.key]: e.target.value }))
                        }
                        className="h-8 w-20 px-2 text-xs"
                        aria-label={`Amount to collect from ${row.label}`}
                      />
                      <div className="flex gap-1">
                        {row.phone && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            onClick={() => sendReminder(row)}
                            aria-label={`Send WhatsApp reminder to ${row.label}`}
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2 text-xs"
                          onClick={() => collect(row, "Cash")}
                          disabled={updateBill.isPending || updateBooking.isPending}
                        >
                          <Banknote className="h-3.5 w-3.5" /> Cash
                        </Button>
                        <Button
                          size="sm"
                          className="h-8 gap-1 px-2 text-xs"
                          onClick={() => collect(row, "UPI")}
                          disabled={updateBill.isPending || updateBooking.isPending}
                        >
                          <Smartphone className="h-3.5 w-3.5" /> UPI
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {dueList.length > dueVisible && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setDueVisible((v) => v + 25)}
                >
                  Show more ({dueList.length - dueVisible} remaining)
                </Button>
              )}
            </CardContent>
          </Card>
          </LayoutPart>
          </LayoutParts>
        </section>
      </LayoutSection>
    </LayoutSections>
  );
}
