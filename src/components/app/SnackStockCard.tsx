import { useMemo, useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertTriangle, Boxes, Check, History, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ListDisclosure } from "./ListDisclosure";
import { SectionHeading } from "@/components/app/SectionHeading";
import { LayoutPart, LayoutParts } from "./LayoutSection";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  useAdjustSnackStock,
  useSnackItems,
  useSnackStockHistory,
  type SnackItem,
} from "@/lib/ops";
import { compareBy, useSortState, type SortOption } from "@/lib/sort";
import { SortMenu } from "./SortMenu";

const ALL_CATEGORIES = "__all__";

type StockSortField = "name" | "stock" | "updated";

const STOCK_SORT_OPTIONS: SortOption<StockSortField>[] = [
  { value: "stock", label: "Stock level", defaultDir: "asc" },
  { value: "name", label: "Name", defaultDir: "asc" },
  { value: "updated", label: "Recently updated", defaultDir: "desc" },
];

/** Stock counts per snack: quick +/- and an exact stock-take input, grouped
 * by category with a filter, a last-updated timestamp, and a per-item
 * change history popover. */
export function SnackStockCard() {
  const { data: items = [] } = useSnackItems();
  const adjust = useAdjustSnackStock();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const sort = useSortState<StockSortField>("snack-stock", STOCK_SORT_OPTIONS, {
    field: "stock",
    dir: "asc",
  });

  const active = items.filter((i) => i.is_active);
  const low = active.filter((i) => i.stock_quantity <= i.low_stock_threshold);

  const categories = useMemo(
    () => Array.from(new Set(active.map((i) => i.category || "General"))).sort(),
    [active],
  );

  const visible =
    category === ALL_CATEGORIES
      ? active
      : active.filter((i) => (i.category || "General") === category);

  // Grouped by category so a long "All categories" list still scans easily;
  // collapses to a single group when a specific category is selected.
  const groups = useMemo(() => {
    const map = new Map<string, SnackItem[]>();
    for (const item of visible) {
      const key = item.category || "General";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    const compareItems = (a: SnackItem, b: SnackItem) => {
      switch (sort.field) {
        case "name":
          return compareBy(a.item_name.toLowerCase(), b.item_name.toLowerCase(), sort.dir);
        case "updated":
          return compareBy(
            a.stock_updated_at ? new Date(a.stock_updated_at).getTime() : 0,
            b.stock_updated_at ? new Date(b.stock_updated_at).getTime() : 0,
            sort.dir,
          );
        case "stock":
        default:
          return compareBy(a.stock_quantity, b.stock_quantity, sort.dir);
      }
    };
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, groupItems]) => [name, [...groupItems].sort(compareItems)] as const);
  }, [visible, sort.field, sort.dir]);

  const setStock = (item: SnackItem, next: number, previous: number, undoLabel?: string) => {
    setPendingId(item.id);
    adjust.mutate(
      { id: item.id, stock_quantity: next },
      {
        onSuccess: () => {
          setDraft((d) => ({ ...d, [item.id]: "" }));
          if (undoLabel) {
            toast(undoLabel, {
              action: {
                label: "Undo",
                onClick: () => adjust.mutate({ id: item.id, stock_quantity: previous }),
              },
            });
          }
        },
        onError: (e) => toast.error(e.message),
        onSettled: () => setPendingId((id) => (id === item.id ? null : id)),
      },
    );
  };

  const addFromDraft = (item: SnackItem) => {
    const amount = Math.max(0, Number(draft[item.id]) || 0);
    if (!amount) return;
    setStock(item, item.stock_quantity + amount, item.stock_quantity);
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <LayoutParts sectionId="snacks.stock" className="space-y-4">
        <LayoutPart id="snacks.stock.heading" className="space-y-4">
        <SectionHeading
          icon={Boxes}
          eyebrow="Inventory"
          title="Stock counts"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <SortMenu
                options={STOCK_SORT_OPTIONS}
                field={sort.field}
                dir={sort.dir}
                onFieldChange={sort.setField}
                onToggleDir={sort.toggleDir}
              />
              {categories.length > 1 && (
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="h-8 w-40">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          }
        />
        {active.length === 0 && (
          <p className="text-sm text-muted-foreground">Add snack items in Settings first.</p>
        )}

        {low.length > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p>
              Running low:{" "}
              <span className="font-medium">
                {low.map((i) => `${i.item_name} (${i.stock_quantity})`).join(", ")}
              </span>
            </p>
          </div>
        )}
        </LayoutPart>

        <LayoutPart id="snacks.stock.table" className="space-y-4">
      <ListDisclosure storageKey="snacks.stock" label="Stock items" count={active.length}>
        {groups.map(([groupName, groupItems]) => (
          <div key={groupName} className="space-y-2">
            {category === ALL_CATEGORIES && categories.length > 1 && (
              <p className="micro-label">{groupName}</p>
            )}
            {groupItems.map((i) => (
              <StockRow
                key={i.id}
                item={i}
                draftValue={draft[i.id] ?? ""}
                pending={pendingId === i.id}
                onDraftChange={(value) => setDraft((d) => ({ ...d, [i.id]: value }))}
                onAdd={() => addFromDraft(i)}
                onIncrement={() =>
                  setStock(
                    i,
                    i.stock_quantity + 1,
                    i.stock_quantity,
                    `${i.item_name} stock increased to ${i.stock_quantity + 1}`,
                  )
                }
                onDecrement={() =>
                  setStock(
                    i,
                    i.stock_quantity - 1,
                    i.stock_quantity,
                    `${i.item_name} stock reduced to ${i.stock_quantity - 1}`,
                  )
                }
              />
            ))}
          </div>
        ))}
      </ListDisclosure>
        </LayoutPart>
        </LayoutParts>
      </CardContent>
    </Card>
  );
}

function StockRow({
  item: i,
  draftValue,
  pending,
  onDraftChange,
  onAdd,
  onIncrement,
  onDecrement,
}: {
  item: SnackItem;
  draftValue: string;
  pending: boolean;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onIncrement: () => void;
  onDecrement: () => void;
}) {
  return (
    <div className="lift frost-soft flex flex-wrap items-center gap-2 rounded-xl border p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{i.item_name}</p>
        <p
          className={cn(
            "text-xs text-muted-foreground",
            i.stock_quantity <= i.low_stock_threshold && "text-destructive",
          )}
        >
          {i.stock_quantity} left · alert at {i.low_stock_threshold}
          {i.stock_updated_at && (
            <>
              {" "}
              · updated{" "}
              {formatDistanceToNowStrict(new Date(i.stock_updated_at), {
                addSuffix: true,
              })}
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="outline"
          className="size-9"
          aria-label={`Reduce ${i.item_name} stock`}
          disabled={pending}
          onClick={onDecrement}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-9"
          aria-label={`Add one to ${i.item_name} stock`}
          disabled={pending}
          onClick={onIncrement}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Input
          className="h-9 w-20"
          type="number"
          min={0}
          placeholder="Add"
          value={draftValue}
          disabled={pending}
          onChange={(e) => {
            const raw = e.target.value;
            // Clamp to non-negative so this box only ever adds, never subtracts.
            const clamped = raw === "" ? "" : String(Math.max(0, Number(raw) || 0));
            onDraftChange(clamped);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onAdd();
          }}
        />
        <Button
          size="icon"
          variant="outline"
          className="size-9"
          aria-label={`Add entered amount to ${i.item_name} stock`}
          disabled={!draftValue || pending}
          onClick={onAdd}
        >
          <Check className="h-4 w-4" />
        </Button>
        <StockHistoryButton item={i} />
      </div>
    </div>
  );
}

function StockHistoryButton({ item }: { item: SnackItem }) {
  const [open, setOpen] = useState(false);
  const { data: history = [], isLoading } = useSnackStockHistory(item.id, 10);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-9"
          aria-label={`View ${item.item_name} stock history`}
        >
          <History className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="end">
        <p className="mb-2 text-sm font-medium">{item.item_name} — recent changes</p>
        {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {!isLoading && history.length === 0 && (
          <p className="text-xs text-muted-foreground">No changes recorded yet.</p>
        )}
        <ul className="max-h-64 space-y-1.5 overflow-y-auto text-xs">
          {history.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-2">
              <span className={cn(h.delta > 0 ? "text-success" : "text-destructive")}>
                {h.delta > 0 ? `+${h.delta}` : h.delta}
              </span>
              <span className="text-muted-foreground">
                {h.previous_quantity} → {h.new_quantity}
              </span>
              <span className="text-muted-foreground">
                {formatDistanceToNowStrict(new Date(h.created_at), {
                  addSuffix: true,
                })}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
