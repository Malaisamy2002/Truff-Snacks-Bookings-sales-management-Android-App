import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  CheckCircle2,
  FileDown,
  Percent,
  Printer,
  Download,
  ChevronLeft,
  ChevronRight,
  Trophy,
  AlertCircle,
  ListChecks,
  NotebookPen,
} from "lucide-react";
import { exportToExcel } from "@/lib/xlsx";
import { INVOICE_SECTIONS } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { ListDisclosure } from "./ListDisclosure";
import { SectionHeading } from "@/components/app/SectionHeading";
import { LayoutSection, LayoutSections, LayoutPart, LayoutParts } from "./LayoutSection";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { bookingGrossTotal, formatDMY, money } from "@/lib/biz";
import { rupees } from "@/lib/money";
import {
  bookingCashCollected,
  bookingDue,
  bookingMovedToDues,
  bookingStateLabel,
  dueNoForRef,
  isFinancialBooking,
  netTabAmountFor,
} from "@/lib/dues";
import { Badge } from "@/components/ui/badge";
import { useBills } from "@/lib/data";
import { cn, localDateStr } from "@/lib/utils";
import { useSaveCustomer } from "@/lib/data";
import { compareBy, sortSuffix, useSortState, type SortOption } from "@/lib/sort";
import { TAB_REF_TURF_BOOKING, useAddTabEntry, useTabEntries } from "@/lib/tabs";
import { CustomerFields } from "./CustomerFields";
import { SortMenu } from "./SortMenu";
import {
  TimeSlotPicker,
  minuteLabel,
  rangeLabel,
  hoursLabel,
  parseMinutes,
  DAY_PARTS,
  type DayPartId,
} from "./TimeSlotPicker";
import { TurfCalendarCard } from "./TurfCalendarCard";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { bookingReceipt, printReceipt, downloadReceipt } from "@/lib/receipt";
import { usePrintSettings } from "@/lib/print";
import {
  BOOKING_STATUSES,
  PAYMENT_MODES,
  useCreateTurfBooking,
  useDeleteTurfBooking,
  useTurfBookings,
  useTurfRates,
  useUpdateTurfBooking,
  rateForInterval,
  allowedIntervalsFor,
  useSlotDurations,
  priceForDuration,
} from "@/lib/ops";

const today = () => localDateStr();

const defaultDayPart = (): DayPartId => {
  const h = new Date().getHours();
  if (h < 6) return "latenight";
  if (h < 12) return "morning";
  if (h < 16) return "afternoon";
  if (h < 20) return "evening";
  return "night";
};

/**
 * Peak-hour pricing: matches an existing slot-rate name to the chosen day part
 * and date. Evening/night/late-night count as "peak", morning/afternoon as
 * "off peak", and weekend/weekday names match the calendar date.
 */
const pickRateForContext = (names: string[], dayPart: DayPartId, date: string) => {
  const isWeekend = [0, 6].includes(new Date(`${date}T00:00:00`).getDay());
  const peak = dayPart === "evening" || dayPart === "night" || dayPart === "latenight";
  const wanted = [dayPart, peak ? "peak" : "off", isWeekend ? "weekend" : "weekday"];
  for (const want of wanted) {
    const hit = names.find((n) => {
      const low = n.toLowerCase();
      if (want === "peak" && low.includes("off")) return false; // "Off Peak" isn't peak
      return low.includes(want);
    });
    if (hit) return hit;
  }
  return null;
};

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
};

type BookingSortField = "date" | "customer" | "slot" | "amount";

const BOOKING_SORT_OPTIONS: SortOption<BookingSortField>[] = [
  { value: "date", label: "Date", defaultDir: "desc" },
  { value: "customer", label: "Customer", defaultDir: "asc" },
  { value: "slot", label: "Slot", defaultDir: "asc" },
  { value: "amount", label: "Amount", defaultDir: "desc" },
];

type DuesSortField = "date" | "amount";

const DUES_SORT_OPTIONS: SortOption<DuesSortField>[] = [
  { value: "date", label: "Due date", defaultDir: "asc" },
  { value: "amount", label: "Amount due", defaultDir: "desc" },
];

export function TurfTab() {
  const { data: rates = [] } = useTurfRates();
  const { data: bookings = [] } = useTurfBookings();
  const create = useCreateTurfBooking();
  const { settings: printSettings } = usePrintSettings();
  const update = useUpdateTurfBooking();
  const addTabEntry = useAddTabEntry();
  const del = useDeleteTurfBooking();
  const saveCustomer = useSaveCustomer();

  const activeRates = rates.filter((r) => r.is_active);

  const [form, setForm] = useState({
    booking_date: today(),
    customer_name: "",
    phone: "",
    slot_name: "",
    advance_paid: "",
    payment_mode: "Cash",
    status: "Confirmed",
  });
  const [courts, setCourts] = useState(1);
  const [dayPart, setDayPart] = useState<DayPartId>(defaultDayPart());
  const [interval, setInterval] = useState<number>(60);
  const [selectedSlots, setSelectedSlots] = useState<number[]>([]);

  const [discount, setDiscount] = useState("");
  const [notes, setNotes] = useState("");
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [draftDiscount, setDraftDiscount] = useState("");
  const [draftNotes, setDraftNotes] = useState("");

  const [repeatWeeks, setRepeatWeeks] = useState(1);
  const [collect, setCollect] = useState<Record<string, string>>({});

  /**
   * Every minute already covered by a non-cancelled booking on `date`.
   *
   * Bookings are stored as a start time + duration, so a late-night booking
   * can run past midnight (e.g. 23:00 + 2 h). Those spill-over minutes belong
   * to the FOLLOWING calendar day, so the previous day's bookings have to be
   * checked too or the early hours of `date` look free and get double-booked.
   */
  const occupiedMinutesOn = useMemo(() => {
    const prevDay = (date: string) => {
      const d = new Date(`${date}T00:00:00`);
      if (Number.isNaN(d.getTime())) return null;
      d.setDate(d.getDate() - 1);
      // Local calendar day — toISOString() renders UTC, which for IST turned
      // "one day back" into TWO days back (10 Mar asked for 8 Mar), so a
      // late-night spill-over from the real previous day was never seen and
      // could be double-booked.
      return localDateStr(d);
    };

    return (date: string) => {
      // minute -> number of courts already in use at that minute
      const occupied = new Map<number, number>();
      const use = (m: number) => occupied.set(m, (occupied.get(m) ?? 0) + (b_courts ?? 1));
      let b_courts = 1;
      const yesterday = prevDay(date);
      for (const b of bookings) {
        if (b.status === "Cancelled") continue;
        const sameDay = b.booking_date === date;
        const dayBefore = yesterday !== null && b.booking_date === yesterday;
        if (!sameDay && !dayBefore) continue;
        const start = parseMinutes(b.start_time);
        if (start === null) continue;
        const span = Math.max(1, Math.round((b.hours || 1) * 60));
        b_courts = Math.max(1, Number(b.courts ?? 1));
        for (let m = start; m < start + span; m++) {
          // Same-day booking: only the minutes before midnight land on `date`.
          if (sameDay && m < 1440) use(m);
          // Previous-day booking: only the minutes past midnight land on `date`.
          if (dayBefore && m >= 1440) use(m - 1440);
        }
      }
      return occupied;
    };
  }, [bookings]);

  // Slot durations + court count switched on globally in Settings → Turf rates.
  const { data: slotDurations } = useSlotDurations();
  const totalCourts = Math.max(1, Number(slotDurations?.total_courts ?? 1));

  /**
   * Slot-grid marks (in the currently selected `interval`) that overlap an
   * existing booking on `date` — including one made under a *different*
   * interval setting. A booking is stored as an exact start time + duration,
   * so e.g. a 45-min booking starting at 6:45 must still block the 6:00–7:00
   * and 7:00–8:00 hourly slots. Comparing raw start-minute values missed this
   * whenever the grids didn't line up, letting the same time get booked twice.
   */
  const takenOn = useMemo(() => {
    return (date: string) => {
      const occupied = occupiedMinutesOn(date);
      const taken: number[] = [];
      for (const part of DAY_PARTS) {
        for (let m = part.from * 60; m < part.to * 60; m += interval) {
          // A slot is taken only when the courts already in use plus the
          // courts this booking wants exceed the venue's court count — so a
          // 2-court turf can hold two 1-court bookings at the same time.
          let overlaps = false;
          for (let k = 0; k < interval; k++) {
            if ((occupied.get(m + k) ?? 0) + courts > totalCourts) {
              overlaps = true;
              break;
            }
          }
          if (overlaps) taken.push(m);
        }
      }
      return taken;
    };
  }, [occupiedMinutesOn, interval, courts, totalCourts]);

  const bookedSlots = useMemo(() => takenOn(form.booking_date), [takenOn, form.booking_date]);

  // Peak-hour pricing: when the day part (or date) changes, auto-pick the slot
  // rate that matches it — evening/night = peak, morning/afternoon = off-peak,
  // plus weekday/weekend names.
  const rateKey = `${dayPart}|${form.booking_date}`;
  const lastRateKey = useRef("");
  useEffect(() => {
    if (activeRates.length === 0) return;
    if (lastRateKey.current === rateKey) return;
    lastRateKey.current = rateKey;
    const match = pickRateForContext(
      activeRates.map((r) => r.slot_name),
      dayPart,
      form.booking_date,
    );
    if (match) setForm((f) => (f.slot_name === match ? f : { ...f, slot_name: match }));
    else if (!form.slot_name) setForm((f) => ({ ...f, slot_name: activeRates[0]!.slot_name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateKey, activeRates.length]);

  const rateRow = activeRates.find((r) => r.slot_name === form.slot_name);
  const rate = rateRow?.rate_per_hour ?? 0;

  const allowedIntervals = useMemo(() => allowedIntervalsFor(slotDurations), [slotDurations]);
  useEffect(() => {
    if (allowedIntervals.includes(interval)) return;
    // Snap to the closest available duration and clear the picked time.
    const next = allowedIntervals.reduce((best, m) =>
      Math.abs(m - interval) < Math.abs(best - interval) ? m : best,
    );
    setInterval(next);
    setSelectedSlots([]);
  }, [allowedIntervals, interval]);

  // Price for ONE slot at the chosen duration (uses the slot's own per-duration
  // price when set in Settings, otherwise the prorated hourly rate).
  const bookedMinutes = selectedSlots.length * interval;
  const hours = bookedMinutes / 60;
  // Full hours at the hourly rate + the leftover 15/30/45 min at its own rate.
  const turfAmount = rateRow ? priceForDuration(rateRow, bookedMinutes) * courts : 0;
  const gross = turfAmount;
  const discountValue = Math.min(Math.max(rupees(discount), 0), gross);
  const total = Math.max(0, gross - discountValue);
  const balance = Math.max(0, total - rupees(form.advance_paid));

  const { data: tabEntries = [] } = useTabEntries();
  const { data: allBills = [] } = useBills();
  /** invoice_no by bill id, so a merged booking can name its bill. */
  const invoiceNoById = useMemo(
    () => new Map(allBills.map((b) => [b.id, b.invoice_no])),
    [allBills],
  );

  const duesSort = useSortState<DuesSortField>("turf-dues", DUES_SORT_OPTIONS, {
    field: "date",
    dir: "asc",
  });
  const dues = useMemo(
    () =>
      bookings
        // bookingDue() (lib/dues.ts) drops anything merged into a bill or
        // already moved onto the customer's tab, so the same rupee is never
        // shown as owed in two places.
        .filter((b) => bookingDue(b, tabEntries) > 0)
        .sort((a, b) =>
          duesSort.field === "amount"
            ? compareBy(bookingDue(a, tabEntries), bookingDue(b, tabEntries), duesSort.dir)
            : compareBy(
                new Date(a.booking_date).getTime(),
                new Date(b.booking_date).getTime(),
                duesSort.dir,
              ),
        ),
    [bookings, tabEntries, duesSort.field, duesSort.dir],
  );
  const [duesVisible, setDuesVisible] = useState(25);
  const visibleDues = useMemo(() => dues.slice(0, duesVisible), [dues, duesVisible]);

  const bookingSort = useSortState<BookingSortField>("turf-bookings", BOOKING_SORT_OPTIONS, {
    field: "date",
    dir: "desc",
  });
  /** Set by the calendar-popup on the "Date" sort control — narrows the
   * bookings list to exactly one day. */
  const [bookingDate, setBookingDate] = useState<string | undefined>(undefined);
  const sortedBookings = useMemo(
    () =>
      [...bookings].sort((a, b) => {
        switch (bookingSort.field) {
          case "customer":
            return compareBy(
              a.customer_name.toLowerCase(),
              b.customer_name.toLowerCase(),
              bookingSort.dir,
            );
          case "slot":
            return compareBy(a.slot_name.toLowerCase(), b.slot_name.toLowerCase(), bookingSort.dir);
          case "amount":
            return compareBy(bookingGrossTotal(a), bookingGrossTotal(b), bookingSort.dir);
          case "date":
          default:
            return compareBy(
              new Date(a.booking_date).getTime(),
              new Date(b.booking_date).getTime(),
              bookingSort.dir,
            );
        }
      }),
    [bookings, bookingSort.field, bookingSort.dir],
  );

  /** sortedBookings narrowed to bookingDate when the calendar popup picked
   * one — used everywhere sortedBookings previously fed pagination/export,
   * so "one specific day" applies consistently across the tab. */
  const dateFilteredBookings = useMemo(
    () =>
      bookingDate ? sortedBookings.filter((b) => b.booking_date === bookingDate) : sortedBookings,
    [sortedBookings, bookingDate],
  );

  const PAGE_SIZE = 25;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(dateFilteredBookings.length / PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [bookings.length, bookingSort.field, bookingSort.dir, bookingDate]);
  const pageBookings = useMemo(
    () => dateFilteredBookings.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [dateFilteredBookings, page],
  );

  const toggleSlot = (m: number) =>
    setSelectedSlots((prev) => {
      // Deselect
      if (prev.includes(m)) return prev.filter((x) => x !== m);
      if (prev.length === 0) return [m];
      // Treat the second tap as the booking's end time. Fill only the slots
      // before that endpoint so 6:30 → 7:30 remains one hour, not 90 minutes.
      const min = Math.min(...prev, m);
      const max = Math.max(...prev, m);
      const next: number[] = [];
      for (let x = min; x < max; x += interval) next.push(x);
      // Don't allow the span to swallow an already-booked slot
      if (next.some((x) => bookedSlots.includes(x))) return [m];
      return next;
    });

  const submit = async () => {
    if (!form.customer_name.trim()) {
      toast.error("Customer name required");
      return;
    }
    if (form.phone && !/^\d{10}$/.test(form.phone)) {
      toast.error("Phone must be 10 digits");
      return;
    }
    if (!form.slot_name) {
      toast.error("Pick a slot");
      return;
    }
    if (hours === 0) {
      toast.error("Pick at least one time slot");
      return;
    }
    const sorted = [...selectedSlots].sort((a, b) => a - b);
    const weeks = Math.max(1, Math.min(52, Math.round(repeatWeeks) || 1));
    const advance = rupees(form.advance_paid);

    const basePayload = {
      customer_name: form.customer_name.trim(),
      phone: form.phone || null,
      slot_name: form.slot_name,
      hours,
      // effective hourly rate so receipts/exports stay consistent
      rate_per_hour: hours > 0 ? turfAmount / hours / courts : rate,
      discount: discountValue,
      notes: notes.trim() || null,
      total_amount: total,
      payment_mode: form.payment_mode,
      status: form.status,
      start_time: minuteLabel(sorted[0]!),
      end_time: minuteLabel(sorted[sorted.length - 1]! + interval),
      courts,
      snacks: [],
      snacks_total: 0,
      turf_amount: turfAmount,
    };

    let savedCount = 0;
    let skipped = 0;
    let firstSaved: Awaited<ReturnType<typeof create.mutateAsync>> | null = null;

    try {
      for (let week = 0; week < weeks; week++) {
        const date = addDays(form.booking_date, week * 7);
        if (week > 0 && sorted.some((m) => takenOn(date).includes(m))) {
          skipped++;
          continue;
        }
        const saved = await create.mutateAsync({
          ...basePayload,
          booking_date: date,
          // Only the first date collects the advance; later weeks start unpaid.
          advance_paid: week === 0 ? advance : 0,
        });
        if (week === 0) firstSaved = saved;
        savedCount++;
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save booking");
      return;
    }

    toast.success(
      weeks > 1
        ? `${savedCount} weekly booking${savedCount > 1 ? "s" : ""} saved${skipped ? ` · ${skipped} skipped (slot taken)` : ""}`
        : "Booking saved",
    );
    if (firstSaved && printSettings.autoPrint)
      printReceipt(bookingReceipt(firstSaved), printSettings, INVOICE_SECTIONS.turf);
    saveCustomer.mutate({
      name: form.customer_name.trim(),
      phone: form.phone || null,
    });
    setForm({ ...form, customer_name: "", phone: "", advance_paid: "" });
    setSelectedSlots([]);
    setDiscount("");
    setNotes("");
    setRepeatWeeks(1);
  };

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="TURF"
        title="Turf bookings"
        hint="Book slots, track dues and history"
        icon={Trophy}
      />

      <LayoutSections tabId="turf" className="space-y-6">
        <LayoutSection id="turf.new-booking">
          <Card className="frost lift border-primary/30">
            <CardContent className="space-y-4">
              <SectionHeading icon={Plus} eyebrow="New" title="New turf booking" />
              <LayoutParts sectionId="turf.new-booking" className="grid gap-3 md:grid-cols-3">
                <LayoutPart id="turf.new-booking.customer" className="md:col-span-3">
                  <CustomerFields
                    name={form.customer_name}
                    phone={form.phone}
                    onChange={({ name, phone }) =>
                      setForm((f) => ({ ...f, customer_name: name, phone }))
                    }
                  />
                </LayoutPart>

                <LayoutPart id="turf.new-booking.slot-picker" className="md:col-span-3">
                  <TimeSlotPicker
                    date={form.booking_date}
                    onDateChange={(d) => {
                      setForm((f) => ({ ...f, booking_date: d }));
                      setSelectedSlots([]);
                    }}
                    courts={courts}
                    onCourtsChange={setCourts}
                    dayPart={dayPart}
                    onDayPartChange={setDayPart}
                    interval={interval}
                    allowedIntervals={allowedIntervals}
                    onIntervalChange={(m) => {
                      setInterval(m);
                      setSelectedSlots([]);
                    }}
                    selected={selectedSlots}
                    onToggleSlot={toggleSlot}
                    bookedSlots={bookedSlots}
                  />
                </LayoutPart>

                <LayoutPart id="turf.new-booking.slot-rate" className="space-y-1">
                  <Label className="text-xs">Slot rate</Label>
                  <Select
                    value={form.slot_name}
                    onValueChange={(v) => setForm({ ...form, slot_name: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select slot rate" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeRates.map((r) => (
                        <SelectItem key={r.id} value={r.slot_name}>
                          {r.slot_name} — {money(rateForInterval(r, interval))}/
                          {interval === 60 ? "hr" : `${interval} min`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </LayoutPart>
                <LayoutPart id="turf.new-booking.selected-time" className="space-y-1">
                  <Label className="text-xs">Selected time (auto)</Label>
                  <Input readOnly disabled value={rangeLabel(selectedSlots, interval) || "—"} />
                </LayoutPart>
                <LayoutPart id="turf.new-booking.turf-amount" className="space-y-1">
                  <Label className="text-xs">Turf amount (auto)</Label>
                  <Input readOnly disabled value={money(turfAmount)} />
                  {bookedMinutes > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {hoursLabel(hours)} × {courts} court{courts > 1 ? "s" : ""}
                    </p>
                  )}
                </LayoutPart>

                <LayoutPart id="turf.new-booking.extras" className="space-y-1">
                  <Label className="text-xs">Discount &amp; notes</Label>
                  <Dialog
                    open={extrasOpen}
                    onOpenChange={(open) => {
                      setExtrasOpen(open);
                      if (open) {
                        setDraftDiscount(discount);
                        setDraftNotes(notes);
                      }
                    }}
                  >
                    <DialogTrigger asChild>
                      <Button variant="outline" className="w-full justify-start font-normal">
                        <Percent className="mr-2 h-4 w-4" />
                        {discountValue > 0 ? `- ${money(discountValue)}` : "Add discount / note"}
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Discount &amp; notes</DialogTitle>
                        <DialogDescription>
                          Applies to this booking only. Discount is subtracted from the combined
                          turf + snacks total.
                        </DialogDescription>
                      </DialogHeader>
                      <LayoutParts surfaceId="surface.booking-extras" className="space-y-3">
                        <LayoutPart id="surface.booking-extras.discount" className="space-y-1">
                          <Label className="text-xs">Discount amount (₹)</Label>
                          <Input
                            inputMode="decimal"
                            value={draftDiscount}
                            onChange={(e) => setDraftDiscount(e.target.value)}
                            placeholder="0"
                          />
                          <p className="text-xs text-muted-foreground">
                            Combined total {money(gross)} · after discount{" "}
                            {money(Math.max(0, gross - (Number(draftDiscount) || 0)))}
                          </p>
                        </LayoutPart>
                        <LayoutPart id="surface.booking-extras.notes" className="space-y-1">
                          <Label className="text-xs">Notes</Label>
                          <Textarea
                            rows={3}
                            value={draftNotes}
                            onChange={(e) => setDraftNotes(e.target.value)}
                            placeholder="e.g. regular customer, rain reschedule"
                          />
                        </LayoutPart>
                        <LayoutPart id="surface.booking-extras.actions">
                          <DialogFooter>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setDraftDiscount("");
                                setDraftNotes("");
                              }}
                            >
                              Clear
                            </Button>
                            <Button
                              onClick={() => {
                                setDiscount(draftDiscount);
                                setNotes(draftNotes);
                                setExtrasOpen(false);
                                toast.success("Discount & notes applied");
                              }}
                            >
                              Apply
                            </Button>
                          </DialogFooter>
                        </LayoutPart>
                      </LayoutParts>
                    </DialogContent>
                  </Dialog>
                </LayoutPart>

                <LayoutPart id="turf.new-booking.grand-total" className="space-y-1">
                  <Label className="text-xs">Grand total (auto)</Label>
                  <Input readOnly disabled value={money(total)} className="font-semibold" />
                </LayoutPart>
                <LayoutPart id="turf.new-booking.advance" className="space-y-1">
                  <Label className="text-xs">Advance paid</Label>
                  <Input
                    inputMode="decimal"
                    value={form.advance_paid}
                    onChange={(e) => setForm({ ...form, advance_paid: e.target.value })}
                    placeholder="0"
                  />
                </LayoutPart>
                <LayoutPart id="turf.new-booking.balance" className="space-y-1">
                  <Label className="text-xs">Balance due (auto)</Label>
                  <Input
                    readOnly
                    disabled
                    value={money(balance)}
                    className={cn(balance > 0 && "!text-destructive font-semibold")}
                  />
                </LayoutPart>

                <LayoutPart id="turf.new-booking.payment-mode" className="space-y-1">
                  <Label className="text-xs">Payment mode</Label>
                  <Select
                    value={form.payment_mode}
                    onValueChange={(v) => setForm({ ...form, payment_mode: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_MODES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </LayoutPart>
                <LayoutPart id="turf.new-booking.status" className="space-y-1">
                  <Label className="text-xs">Status</Label>
                  <Select
                    value={form.status}
                    onValueChange={(v) => setForm({ ...form, status: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BOOKING_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </LayoutPart>
                <LayoutPart id="turf.new-booking.repeat" className="space-y-1">
                  <Label className="text-xs">Repeat weekly</Label>
                  <Select
                    value={String(repeatWeeks)}
                    onValueChange={(v) => setRepeatWeeks(Number(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">One-time only</SelectItem>
                      {[2, 3, 4, 6, 8, 12].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          Same slot for {n} weeks
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {repeatWeeks > 1 && (
                    <p className="text-[11px] text-muted-foreground">
                      {formatDMY(form.booking_date)} →{" "}
                      {formatDMY(addDays(form.booking_date, (repeatWeeks - 1) * 7))} · advance
                      applies to the first date only
                    </p>
                  )}
                </LayoutPart>

                <LayoutPart id="turf.new-booking.save" className="md:col-span-3">
                  <Button
                    className="w-full"
                    onClick={submit}
                    disabled={create.isPending}
                    data-shortcut="save"
                  >
                    <Plus className="mr-1 h-4 w-4" /> Save booking
                    {repeatWeeks > 1 ? ` × ${repeatWeeks} weeks` : ""}
                  </Button>
                </LayoutPart>
              </LayoutParts>
            </CardContent>
          </Card>
        </LayoutSection>

        <LayoutSection id="turf.calendar">
          <TurfCalendarCard />
        </LayoutSection>

        {dues.length > 0 && (
          <LayoutSection id="turf.pending-dues">
            <Card>
              <CardContent className="space-y-3">
                <LayoutParts sectionId="turf.pending-dues" className="space-y-3">
                  <LayoutPart id="turf.pending-dues.heading">
                    <SectionHeading
                      icon={AlertCircle}
                      eyebrow="Collections"
                      title="Pending dues"
                      action={
                        <SortMenu
                          options={DUES_SORT_OPTIONS}
                          field={duesSort.field}
                          dir={duesSort.dir}
                          onFieldChange={duesSort.setField}
                          onToggleDir={duesSort.toggleDir}
                        />
                      }
                    />
                  </LayoutPart>
                  <LayoutPart id="turf.pending-dues.list" className="space-y-3">
                    <ListDisclosure
                      storageKey="turf.pending-dues"
                      label="Pending dues"
                      count={dues.length}
                    >
                      {visibleDues.map((b) => {
                        const due = bookingDue(b, tabEntries);
                        const entered = rupees(collect[b.id] ?? "");
                        const pay = Math.min(Math.max(entered, 0), due);
                        return (
                          <div
                            key={b.id}
                            className="frost-soft lift space-y-2 rounded-xl border p-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-sm">
                                <p className="font-medium">
                                  {b.customer_name} · {b.booking_no}
                                </p>
                                <p className="stat-value text-destructive">Due {money(due)}</p>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={update.isPending}
                                onClick={() =>
                                  update.mutate(
                                    {
                                      id: b.id,
                                      // Tax-inclusive: clearing the due means collecting
                                      // the receipt's grand total, not the pre-tax figure.
                                      advance_paid: bookingGrossTotal(b),
                                      status: "Completed",
                                    },
                                    {
                                      onSuccess: () => {
                                        setCollect((c) => ({ ...c, [b.id]: "" }));
                                        toast.success("Marked as paid");
                                      },
                                    },
                                  )
                                }
                              >
                                <CheckCircle2 className="mr-1 h-4 w-4" /> Mark paid
                              </Button>
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                inputMode="decimal"
                                className="h-9"
                                placeholder={`Part payment (max ${money(due)})`}
                                value={collect[b.id] ?? ""}
                                onChange={(e) =>
                                  setCollect((c) => ({ ...c, [b.id]: e.target.value }))
                                }
                              />
                              <Button
                                size="sm"
                                disabled={pay <= 0 || update.isPending}
                                onClick={() => {
                                  const paid = b.advance_paid + pay;
                                  update.mutate(
                                    {
                                      id: b.id,
                                      advance_paid: paid,
                                      ...(paid >= bookingGrossTotal(b)
                                        ? { status: "Completed" }
                                        : {}),
                                    },
                                    {
                                      onSuccess: () => {
                                        setCollect((c) => ({ ...c, [b.id]: "" }));
                                        toast.success(
                                          `Collected ${money(pay)} · balance ${money(Math.max(0, due - pay))}`,
                                        );
                                      },
                                      onError: (e) => toast.error(e.message),
                                    },
                                  );
                                }}
                              >
                                Collect
                              </Button>
                            </div>
                            {/* Moves the outstanding balance onto the customer's running tab as a
                      Turf charge and clears it off the booking, so the same rupee is
                      never owed in both places. */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="w-full justify-center text-primary"
                              disabled={addTabEntry.isPending || update.isPending}
                              onClick={() => {
                                if (!b.customer_name?.trim()) {
                                  toast.error(
                                    "This booking has no customer name to open a tab for",
                                  );
                                  return;
                                }
                                addTabEntry.mutate(
                                  {
                                    name: b.customer_name,
                                    phone: b.phone,
                                    kind: "charge",
                                    business: "Turf",
                                    amount: due,
                                    note: `Turf booking ${b.booking_no}`,
                                    ref_type: "turf_booking",
                                    ref_id: b.id,
                                    entry_date: b.booking_date,
                                  },
                                  {
                                    onSuccess: () =>
                                      update.mutate(
                                        {
                                          id: b.id,
                                          // The tab charge above is the tax-inclusive
                                          // balance, so the booking is settled at gross.
                                          advance_paid: bookingGrossTotal(b),
                                          status: "Completed",
                                          notes: [b.notes, `${money(due)} moved to tab`]
                                            .filter(Boolean)
                                            .join(" · "),
                                        },
                                        {
                                          onSuccess: () =>
                                            toast.success(
                                              `${money(due)} put on ${b.customer_name}'s tab`,
                                            ),
                                          onError: (e) => toast.error(e.message),
                                        },
                                      ),
                                    onError: (e) => toast.error(e.message),
                                  },
                                );
                              }}
                            >
                              <NotebookPen className="mr-1 h-4 w-4" /> Put balance on tab
                            </Button>
                          </div>
                        );
                      })}

                      {dues.length > duesVisible && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => setDuesVisible((v) => v + PAGE_SIZE)}
                        >
                          Show more ({dues.length - duesVisible} remaining)
                        </Button>
                      )}
                    </ListDisclosure>
                  </LayoutPart>
                </LayoutParts>
              </CardContent>
            </Card>
          </LayoutSection>
        )}

        <LayoutSection id="turf.bookings">
          <Card>
            <CardContent className="space-y-3">
              <LayoutParts sectionId="turf.bookings" className="space-y-3">
                <LayoutPart id="turf.bookings.heading">
                  <SectionHeading icon={ListChecks} eyebrow="History" title="Bookings" />
                </LayoutPart>
                <LayoutPart id="turf.bookings.toolbar">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <SortMenu
                      options={BOOKING_SORT_OPTIONS}
                      field={bookingSort.field}
                      dir={bookingSort.dir}
                      onFieldChange={bookingSort.setField}
                      onToggleDir={bookingSort.toggleDir}
                      dateField="date"
                      selectedDate={bookingDate}
                      onSelectDate={setBookingDate}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        exportToExcel(
                          dateFilteredBookings.flatMap((b) => {
                            const merged = !!b.merged_into_bill_id;
                            const base = {
                              "Booking ID": b.booking_no,
                              Date: formatDMY(b.booking_date),
                              Customer: b.customer_name,
                              Phone: b.phone ?? "",
                              Slot: b.slot_name,
                              Time:
                                b.start_time && b.end_time ? `${b.start_time} - ${b.end_time}` : "",
                              Courts: b.courts,
                              Hours: b.hours,
                              "Rate/hr": b.rate_per_hour,
                              "Payment mode": b.payment_mode,
                              Status: b.status,
                              // Once merged, this booking's revenue lives on the Bill
                              // instead (see Bills sheet) — money columns below are
                              // zeroed so summing this sheet + the Bills sheet doesn't
                              // count the same rupees twice. The row itself is kept so
                              // the booking's history/occupancy record isn't lost.
                              Merged: merged ? "Yes \u2014 see Bills sheet" : "No",
                            };
                            const rows: Record<string, string | number>[] = [
                              {
                                ...base,
                                Type: "Turf",
                                Item: `${b.slot_name} slot`,
                                Qty: b.hours,
                                Amount: merged
                                  ? 0
                                  : b.turf_amount || b.hours * b.rate_per_hour * (b.courts ?? 1),
                                Discount: merged ? 0 : b.discount,
                                "Grand total": merged ? 0 : bookingGrossTotal(b),
                                Advance: merged ? 0 : b.advance_paid,
                                Balance: merged
                                  ? 0
                                  : Math.max(0, bookingGrossTotal(b) - b.advance_paid),
                                Notes: b.notes ?? "",
                              },
                            ];
                            for (const it of b.snacks ?? []) {
                              rows.push({
                                ...base,
                                Type: "Snack",
                                Item: it.item_name,
                                Qty: it.qty,
                                Amount: merged ? 0 : it.amount,
                                Discount: 0,
                                "Grand total": merged ? 0 : bookingGrossTotal(b),
                                Advance: merged ? 0 : b.advance_paid,
                                Balance: merged
                                  ? 0
                                  : Math.max(0, bookingGrossTotal(b) - b.advance_paid),
                                Notes: "",
                              });
                            }
                            return rows;
                          }),
                          `turf-bookings-${sortSuffix(bookingSort.field, bookingSort.dir)}`,
                          "Bookings",
                          INVOICE_SECTIONS.turf,
                        )
                      }
                    >
                      <FileDown className="h-4 w-4" /> Excel
                    </Button>
                  </div>
                </LayoutPart>
                <LayoutPart id="turf.bookings.list" className="space-y-3">
                  <ListDisclosure
                    storageKey="turf.bookings"
                    label="Bookings"
                    count={dateFilteredBookings.length}
                  >
                    {bookingDate && (
                      <div className="frost-soft flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm">
                        <span>
                          Showing <span className="font-medium">{dateFilteredBookings.length}</span>{" "}
                          booking
                          {dateFilteredBookings.length === 1 ? "" : "s"} for{" "}
                          <span className="font-medium">{formatDMY(bookingDate)}</span>
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => setBookingDate(undefined)}>
                          Clear
                        </Button>
                      </div>
                    )}
                    {bookings.length === 0 && (
                      <p className="text-sm text-muted-foreground">No bookings yet.</p>
                    )}
                    {pageBookings.map((b) => {
                      // Cash really collected — advance_paid is inflated to the full
                      // gross when a balance is moved to dues (lib/dues.ts).
                      const paid = bookingCashCollected(b, tabEntries);
                      const due = bookingDue(b, tabEntries);
                      const moved = bookingMovedToDues(b, tabEntries);
                      const onDues = netTabAmountFor(tabEntries, TAB_REF_TURF_BOOKING, b.id);
                      const dueNo = moved
                        ? dueNoForRef(
                            tabEntries,
                            TAB_REF_TURF_BOOKING,
                            b.id,
                            b.booking_no,
                            b.booking_date,
                          )
                        : null;
                      return (
                        <div
                          key={b.id}
                          className={cn(
                            "frost-soft lift rounded-xl border p-3 text-sm",
                            moved && "opacity-60 saturate-50",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="flex flex-wrap items-center gap-2 font-semibold">
                                <span>
                                  {b.booking_no} · {b.customer_name}
                                </span>
                                {moved ? (
                                  <Badge variant="secondary">Moved to dues · {dueNo}</Badge>
                                ) : (
                                  (() => {
                                    const state = bookingStateLabel(
                                      b,
                                      tabEntries,
                                      b.merged_into_bill_id
                                        ? invoiceNoById.get(b.merged_into_bill_id)
                                        : null,
                                    );
                                    return state ? <Badge variant="outline">{state}</Badge> : null;
                                  })()
                                )}
                              </p>

                              <p className="text-muted-foreground">
                                {formatDMY(b.booking_date)}
                                {b.start_time && b.end_time
                                  ? ` · ${b.start_time}–${b.end_time}`
                                  : ""}{" "}
                                · {b.slot_name} · {hoursLabel(b.hours)} × {b.courts ?? 1} court ×{" "}
                                {money(b.rate_per_hour)}
                              </p>
                              {(b.snacks ?? []).length > 0 && (
                                <ul className="mt-1 text-muted-foreground">
                                  {b.snacks.map((it, i) => (
                                    <li key={i}>
                                      🍿 {it.item_name} · {it.qty} × {money(it.unit_price)} ={" "}
                                      {money(it.amount)}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <p>
                                Total {money(bookingGrossTotal(b))}
                                {b.snacks_total > 0 && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · snacks {money(b.snacks_total)}
                                  </span>
                                )}
                                {b.discount > 0 && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · discount {money(b.discount)}
                                  </span>
                                )}{" "}
                                · Paid {money(paid)}
                                {due > 0 && (
                                  <span className="text-destructive"> · Due {money(due)}</span>
                                )}
                                {moved && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · {money(onDues)} on dues
                                  </span>
                                )}
                              </p>
                              {moved && (
                                <p className="text-xs text-muted-foreground">
                                  This balance now sits on {b.customer_name}'s dues — collect it
                                  from the Dues tab so the same money isn't counted twice.
                                </p>
                              )}
                              {b.merged_into_bill_id && (
                                <p className="text-xs text-muted-foreground">
                                  Now billed via the Bills tab — the total above is history only;
                                  don't count it again when adding up revenue here.
                                </p>
                              )}

                              {b.notes && (
                                <p className="mt-1 text-muted-foreground italic">{b.notes}</p>
                              )}
                            </div>
                            <div className="flex flex-col items-end gap-2">
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-xs font-medium",
                                  b.status === "Confirmed" && "bg-primary/15 text-primary",
                                  b.status === "Completed" && "bg-success/15 text-success",
                                  b.status === "Cancelled" && "bg-destructive/15 text-destructive",
                                )}
                              >
                                {b.status}
                              </span>
                              {b.merged_into_bill_id && (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                  Merged into bill
                                </span>
                              )}
                              <div className="flex gap-1">
                                <Button
                                  size="touch"
                                  variant="outline"
                                  aria-label="Print booking receipt"
                                  title="Print receipt"
                                  onClick={() =>
                                    printReceipt(
                                      bookingReceipt(b),
                                      undefined,
                                      INVOICE_SECTIONS.turf,
                                    )
                                  }
                                >
                                  <Printer className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="touch"
                                  variant="outline"
                                  aria-label="Download booking receipt"
                                  title="Download PDF"
                                  onClick={() =>
                                    downloadReceipt(
                                      bookingReceipt(b),
                                      undefined,
                                      INVOICE_SECTIONS.turf,
                                    )
                                  }
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                                <ConfirmDeleteButton
                                  size="touch"
                                  ariaLabel="Delete booking"
                                  title={`Delete booking ${b.booking_no}?`}
                                  description={`This permanently removes ${b.booking_no} for ${b.customer_name} and can't be undone.`}
                                  onConfirm={() =>
                                    del.mutate(b.id, {
                                      onSuccess: () => toast.success("Deleted"),
                                    })
                                  }
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {dateFilteredBookings.length > PAGE_SIZE && (
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
                          Page {page} of {pageCount} · {dateFilteredBookings.length} bookings
                          {bookingDate ? ` (of ${bookings.length} total)` : ""}
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
        </LayoutSection>
      </LayoutSections>
    </div>
  );
}
