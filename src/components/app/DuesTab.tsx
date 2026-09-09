import { sumRupees } from "@/lib/money";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { BookOpen, ChevronDown, HandCoins, Receipt, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ListDisclosure } from "./ListDisclosure";
import { SectionHeading } from "@/components/app/SectionHeading";
import { NewDueCard } from "@/components/app/NewDueCard";
import { money, formatDMY } from "@/lib/biz";
import { groupTabLedger } from "@/lib/dues";
import { useBills } from "@/lib/data";
import { useSnackSales, useTurfBookings } from "@/lib/ops";
import { useAddTabEntry, useSettleAndCloseTab, useTabSummaries, type TabSummary } from "@/lib/tabs";
import { compareBy, useSortState, type SortOption } from "@/lib/sort";
import { SortMenu } from "./SortMenu";
import { LayoutSection, LayoutSections, LayoutPart, LayoutParts } from "./LayoutSection";

type OpenTabSortField = "balance" | "name" | "activity";

const OPEN_TAB_SORT_OPTIONS: SortOption<OpenTabSortField>[] = [
  { value: "balance", label: "Balance", defaultDir: "desc" },
  { value: "name", label: "Name (A–Z)", defaultDir: "asc" },
  { value: "activity", label: "Last activity", defaultDir: "desc" },
];

function lastActivity(s: TabSummary) {
  return s.entries.reduce((latest, e) => (e.entry_date > latest ? e.entry_date : latest), "");
}

/** One open tab: balance, last activity, and a quick collect box. */
function OpenTabRow({
  summary,
  sources,
}: {
  summary: TabSummary;
  sources: Parameters<typeof groupTabLedger>[1];
}) {
  const addEntry = useAddTabEntry();
  const settle = useSettleAndCloseTab();
  const [amount, setAmount] = useState("");
  const [payMode, setPayMode] = useState<"Cash" | "UPI">("Cash");
  const [openLedger, setOpenLedger] = useState(false);
  // One line per source record, so the operator can see WHERE the balance came from.
  const groups = useMemo(
    () => groupTabLedger(summary.entries, sources),
    [summary.entries, sources],
  );

  const tab = summary.tab;
  const name = tab?.customer_name ?? summary.entries[0]?.customer_key ?? "Customer";
  const phone = tab?.phone ?? null;
  const balance = summary.balance;

  const collect = () => {
    const value = Number(amount) || 0;
    if (value <= 0) {
      toast.error("Enter an amount to collect");
      return;
    }
    if (value > balance) {
      toast.error(`Payment is more than the ${money(balance)} balance`);
      return;
    }
    addEntry.mutate(
      {
        name,
        phone,
        kind: "payment",
        business: "Shared",
        amount: value,
        note: "Payment received",
        payment_mode: payMode,
      },
      {
        onSuccess: () => {
          setAmount("");
          toast.success(`Collected ${money(value)} from ${name}`);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  const last = lastActivity(summary);

  return (
    <div className="frost-soft space-y-3 rounded-2xl border p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {phone ? `${phone} · ` : ""}
            {last ? `Last activity ${formatDMY(last)}` : "No entries yet"}
          </p>
        </div>
        <Badge variant={balance > 0 ? "destructive" : "secondary"}>
          {balance > 0 ? money(balance) : "Settled"}
        </Badge>
      </div>

      {balance > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            placeholder={`Collect (max ${money(balance)})`}
            className="h-9 w-40 flex-1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Select value={payMode} onValueChange={(v) => setPayMode(v as "Cash" | "UPI")}>
            <SelectTrigger className="h-9 w-24" aria-label="Payment mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Cash">Cash</SelectItem>
              <SelectItem value="UPI">UPI</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" disabled={addEntry.isPending} onClick={collect}>
            <HandCoins className="mr-1 size-4" /> Collect
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!tab || settle.isPending}
            onClick={() =>
              tab &&
              settle.mutate(
                { tabId: tab.id, payment_mode: payMode },
                {
                  onSuccess: () => toast.success(`Settled via ${payMode} and closed`),
                  onError: (e) => toast.error(e.message),
                },
              )
            }
          >
            Settle all
          </Button>
        </div>
      )}

      {groups.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpenLedger((v) => !v)}
          >
            <ChevronDown
              className={`size-3.5 transition-transform ${openLedger ? "" : "-rotate-90"}`}
            />
            {openLedger ? "Hide breakdown" : `Breakdown (${groups.length})`}
          </button>
          {openLedger && (
            <div className="space-y-1 rounded-xl border p-2">
              {groups.map((g) => (
                <div key={g.key} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">
                    {g.label}
                    <span className="text-muted-foreground">
                      {g.dueNo ? ` · ${g.dueNo}` : ""}
                      {g.date ? ` · ${formatDMY(g.date)}` : ""}
                      {g.paid > 0 && g.charged > 0 ? ` · paid ${money(g.paid)}` : ""}
                    </span>
                  </span>
                  <span
                    className={`stat-value shrink-0 text-sm ${
                      g.net > 0 ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {g.net > 0 ? money(g.net) : money(-g.net)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Dues: add a manual due to a customer's running tab and collect open balances.
 * Tab dues are deliberately separate from bill / booking dues (see lib/tabs.ts).
 */
export function DuesTab() {
  const summaries = useTabSummaries();
  const { data: bills = [] } = useBills();
  const { data: bookings = [] } = useTurfBookings();
  const { data: sales = [] } = useSnackSales();
  const sources = useMemo(() => ({ bills, bookings, sales }), [bills, bookings, sales]);
  const [q, setQ] = useState("");
  const openTabSort = useSortState<OpenTabSortField>("dues-open-tabs", OPEN_TAB_SORT_OPTIONS, {
    field: "balance",
    dir: "desc",
  });

  const openTabs = useMemo(() => {
    const list = [...summaries.values()].filter((s) => s.tab?.status !== "closed");
    const term = q.trim().toLowerCase();
    return list
      .filter((s) => {
        if (!term) return true;
        const name = (s.tab?.customer_name ?? "").toLowerCase();
        const phone = s.tab?.phone ?? "";
        return name.includes(term) || phone.includes(term.replace(/\D/g, "") || term);
      })
      .sort((a, b) => {
        switch (openTabSort.field) {
          case "name": {
            const nameA = (a.tab?.customer_name ?? a.entries[0]?.customer_key ?? "").toLowerCase();
            const nameB = (b.tab?.customer_name ?? b.entries[0]?.customer_key ?? "").toLowerCase();
            return compareBy(nameA, nameB, openTabSort.dir);
          }
          case "activity":
            return compareBy(lastActivity(a), lastActivity(b), openTabSort.dir);
          case "balance":
          default:
            return compareBy(a.balance, b.balance, openTabSort.dir);
        }
      });
  }, [summaries, q, openTabSort.field, openTabSort.dir]);

  const owing = openTabs.filter((s) => s.balance > 0);
  const totalOwed = sumRupees(owing.map((t) => t.balance));

  return (
    <div className="space-y-6">
      <SectionHeading eyebrow="BILLS & MONEY" title="Dues" icon={BookOpen} />

      <LayoutSections tabId="dues" className="space-y-6">
        <LayoutSection id="dues.summary">
          <LayoutParts sectionId="dues.summary" className="grid grid-cols-2 gap-2">
            <LayoutPart id="dues.summary.count" className="frost-well rounded-2xl border p-3.5 text-center">
              <p className="micro-label whitespace-nowrap">Open tabs</p>
              <p className="stat-value mt-1 text-lg">{owing.length}</p>
            </LayoutPart>
            <LayoutPart id="dues.summary.total" className="frost-well rounded-2xl border border-primary/30 p-3.5 text-center">
              <p className="micro-label whitespace-nowrap">Total on tabs</p>
              <p className="stat-value mt-1 text-lg text-destructive">{money(totalOwed)}</p>
            </LayoutPart>
          </LayoutParts>
        </LayoutSection>

        <LayoutSection id="dues.new-due">
          <section className="space-y-3">
            <SectionHeading eyebrow="LOG" title="New due" icon={Receipt} />
            <NewDueCard />
          </section>
        </LayoutSection>

        <LayoutSection id="dues.open-tabs">
          <section className="space-y-3">
            <LayoutParts sectionId="dues.open-tabs" className="space-y-3">
            <LayoutPart id="dues.open-tabs.toolbar" className="space-y-3">
            <SectionHeading
              eyebrow="COLLECT"
              title="Open tabs"
              icon={HandCoins}
              action={
                <SortMenu
                  options={OPEN_TAB_SORT_OPTIONS}
                  field={openTabSort.field}
                  dir={openTabSort.dir}
                  onFieldChange={openTabSort.setField}
                  onToggleDir={openTabSort.toggleDir}
                />
              }
            />
            <Card className="frost">
              <CardContent className="pt-5">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search name or phone"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    data-shortcut="search"
                  />
                </div>
              </CardContent>
            </Card>
            </LayoutPart>
            <LayoutPart id="dues.open-tabs.list">
      <ListDisclosure storageKey="dues.open-tabs" label="Open tabs" count={openTabs.length}>
            <Card className="frost">
              <CardContent className="space-y-3 pt-5">
                {openTabs.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No open tabs. Add a due above to start one.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {openTabs.map((s) => (
                      <OpenTabRow
                        key={s.tab?.id ?? s.entries[0]?.customer_key}
                        summary={s}
                        sources={sources}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
      </ListDisclosure>
            </LayoutPart>
            </LayoutParts>
          </section>
        </LayoutSection>
      </LayoutSections>
    </div>
  );
}
