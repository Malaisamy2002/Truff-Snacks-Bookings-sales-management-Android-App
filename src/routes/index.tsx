import { lazy, Suspense, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Cookie,
  FileText,
  Wallet,
  BookOpen,
  BarChart3,
  Trophy,
  Settings,
  LayoutDashboard,
  MoreHorizontal,
} from "lucide-react";
import { ArchiveYearDialog } from "@/components/app/ArchiveYearDialog";
import { DesktopFirstRunNotice } from "@/components/app/DesktopFirstRunNotice";
import { YearSwitcher } from "@/components/app/YearSwitcher";
import { ScrollEdgeButton } from "@/components/app/ScrollEdgeButton";
import { DataEntryShortcuts, ShortcutsHintButton } from "@/components/app/DataEntryShortcuts";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { BUSINESS_NAME } from "@/lib/biz";
import { usePrintSettings } from "@/lib/print";
import { usePersistedState } from "@/lib/ui-prefs";
import { useLayoutPrefs, visibleTabIds } from "@/lib/layout-prefs";

import { backupReminderDue, readAppSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { isAndroid } from "@/lib/desktop";
import { useArrangeMode } from "@/lib/arrange-mode";

const TITLE = "Turf Bookings & Sales — Booking, Billing & Reports";
const DESC =
  "Calculate turf bookings, generate numbered invoices with PDF receipts, track expenses and profit, and share bills on WhatsApp.";

// Tabs contain charts, export tools and large forms. Loading them only when
// selected keeps the Android WebView's first paint and memory use focused on
// the Home screen instead of parsing the whole application up front.
//
// Each tab keeps its own loader so we can also *prefetch* the chunk before the
// owner taps it (on idle, and on hover/press of a tab button). Combined with
// keeping already-visited tabs mounted, switching feels instant after the
// first visit instead of re-parsing and re-rendering the whole section.
const TAB_LOADERS = {
  home: () =>
    import("@/components/app/DashboardTab").then(({ DashboardTab }) => ({ default: DashboardTab })),
  turf: () => import("@/components/app/TurfTab").then(({ TurfTab }) => ({ default: TurfTab })),
  snacks: () =>
    import("@/components/app/SnacksTab").then(({ SnacksTab }) => ({ default: SnacksTab })),
  bills: () => import("@/components/app/BillsTab").then(({ BillsTab }) => ({ default: BillsTab })),
  money: () =>
    import("@/components/app/ExpensesTab").then(({ ExpensesTab }) => ({ default: ExpensesTab })),
  dues: () => import("@/components/app/DuesTab").then(({ DuesTab }) => ({ default: DuesTab })),
  reports: () =>
    import("@/components/app/ReportsTab").then(({ ReportsTab }) => ({ default: ReportsTab })),
  settings: () =>
    import("@/components/app/SettingsTab").then(({ SettingsTab }) => ({ default: SettingsTab })),
} as const;

const TAB_COMPONENTS = {
  home: lazy(TAB_LOADERS.home),
  turf: lazy(TAB_LOADERS.turf),
  snacks: lazy(TAB_LOADERS.snacks),
  bills: lazy(TAB_LOADERS.bills),
  money: lazy(TAB_LOADERS.money),
  dues: lazy(TAB_LOADERS.dues),
  reports: lazy(TAB_LOADERS.reports),
  settings: lazy(TAB_LOADERS.settings),
} as const;

const prefetched = new Set<string>();

/** Warms a tab's chunk without rendering it, so the tap has nothing to wait for. */
function prefetchTab(id: keyof typeof TAB_LOADERS) {
  if (prefetched.has(id)) return;
  prefetched.add(id);
  void TAB_LOADERS[id]().catch(() => prefetched.delete(id));
}


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const TABS = [
  { id: "home", label: "Home", icon: LayoutDashboard },
  { id: "turf", label: "Turf", icon: Trophy },
  { id: "snacks", label: "Snacks", icon: Cookie },
  { id: "bills", label: "Bills", icon: FileText },
  { id: "money", label: "Money", icon: Wallet },
  { id: "dues", label: "Dues", icon: BookOpen },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "settings", label: "Settings", icon: Settings },
] as const;

type TabId = (typeof TABS)[number]["id"];

const TAB_IDS = TABS.map((t) => t.id);

function Index() {
  const [tab, setTab] = usePersistedState<TabId>("active-tab", "home", (v) =>
    (TAB_IDS as readonly string[]).includes(v),
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { on: arranging, setOn: setArranging } = useArrangeMode();

  // Settings → "Arrange this app" leaves Settings and lands on Home, where the
  // real cards are already framed by arrange mode.
  useEffect(() => {
    const onStart = () => setTab("home");
    window.addEventListener("arrange:start", onStart);
    return () => window.removeEventListener("arrange:start", onStart);
  }, [setTab]);

  const { settings: printSettings } = usePrintSettings();
  const shopTitle = printSettings.shopName.trim() || BUSINESS_NAME;

  // Tab bar follows Settings → Layout & arrangement: hidden tabs disappear and
  // the rest keep the owner's chosen order. Settings itself can never be hidden.
  const { layout } = useLayoutPrefs();
  const visibleIds = visibleTabIds(layout);
  const visibleTabs = visibleIds
    .map((id) => TABS.find((t) => t.id === id))
    .filter((t): t is (typeof TABS)[number] => Boolean(t));
  const shownTabs = visibleTabs.length ? visibleTabs : TABS.slice();
  const activeTab: TabId = shownTabs.some((t) => t.id === tab)
    ? tab
    : ((shownTabs[0]?.id ?? "settings") as TabId);
  const navTabIds = shownTabs.map((t) => t.id);
  const primaryMobileTabs = shownTabs.slice(0, 4);
  const moreMobileTabs = shownTabs.slice(4);

  // Every tab visited so far stays mounted (hidden) so revisiting is instant.
  const [mountedTabs, setMountedTabs] = useState<TabId[]>([activeTab]);
  useEffect(() => {
    setMountedTabs((prev) => (prev.includes(activeTab) ? prev : [...prev, activeTab]));
  }, [activeTab]);

  // Warm the remaining tab chunks once the browser is idle, so the first tap on
  // each section no longer waits on a download.
  useEffect(() => {
    let cancelled = false;
    const ids = TAB_IDS.filter((id) => id !== activeTab);
    const warm = (index: number) => {
      if (cancelled || index >= ids.length) return;
      const id = ids[index];
      if (id) prefetchTab(id);
      const next = () => warm(index + 1);
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(next);
      else window.setTimeout(next, 200);
    };
    const start = () => warm(0);
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(start);
    else window.setTimeout(start, 500);
    return () => {
      cancelled = true;
    };
    // Runs once: prefetching is global and guarded by the `prefetched` set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  // Android sends this event before applying its default WebView back action.
  // Keep navigation predictable: dismiss an open sheet/dialog first, then
  // leave arrange mode, return to Home, and only then let Android exit.
  useEffect(() => {
    if (!isAndroid()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/app")
      .then(({ onBackButtonPress }) =>
        onBackButtonPress(() => {
          if (document.querySelector('[role="dialog"][data-state="open"]')) {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            return;
          }
          if (moreOpen) {
            setMoreOpen(false);
            return;
          }
          if (shortcutsOpen) {
            setShortcutsOpen(false);
            return;
          }
          if (arranging) {
            setArranging(false);
            return;
          }
          if (activeTab !== "home") setTab("home");
        }),
      )
      .then((listener) => {
        unlisten = () => {
          void listener.unregister();
        };
      })
      .catch(() => {
        // Browser/PWA builds have no native Android back event.
      });
    return () => unlisten?.();
  }, [activeTab, arranging, moreOpen, setArranging, setTab, shortcutsOpen]);

  // One-time backup reminder, per the Settings → Backup frequency.
  useEffect(() => {
    const s = readAppSettings();
    if (!backupReminderDue(s)) return;
    const t = window.setTimeout(() => {
      toast.info("Time for a backup", {
        description: `Your ${s.backupReminder} backup is due. Open Settings → Backup & restore to export.`,
        duration: 10000,
      });
    }, 4000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen bg-background pb-24 md:pb-8" data-density={layout.density}>
      <ArchiveYearDialog />
      <DesktopFirstRunNotice />
      <ScrollEdgeButton />
      {!isAndroid() && (
        <>
          <ShortcutsHintButton onClick={() => setShortcutsOpen(true)} />
          <DataEntryShortcuts
            tabIds={navTabIds}
            onGoToTab={(id) => setTab(id as TabId)}
            helpOpen={shortcutsOpen}
            onHelpOpenChange={setShortcutsOpen}
          />
        </>
      )}
      <header className="sticky top-0 z-20 border-b border-white/15 brand-gradient pt-[env(safe-area-inset-top)] text-primary-foreground shadow-[0_10px_30px_-20px_oklch(0.4_0.1_250)] backdrop-blur-xl">
        <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 md:flex md:justify-between md:gap-6 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-white/25 bg-white/15 backdrop-blur-md">
              <Trophy className="size-5" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold leading-tight tracking-tight md:text-lg">
                {shopTitle}
              </h1>
              <p className="truncate text-[11px] uppercase tracking-[0.08em] opacity-75">
                Booking, billing &amp; business manager
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <YearSwitcher />
          </div>

          <nav className="hidden items-center gap-1 rounded-full border border-white/20 bg-white/10 p-1 backdrop-blur-md md:flex">
            {shownTabs.map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onPointerEnter={() => prefetchTab(t.id)}
                  onFocus={() => prefetchTab(t.id)}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition-all",
                    active
                      ? "bg-background text-primary shadow-sm"
                      : "text-primary-foreground/85 hover:bg-white/15",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-2xl p-4 md:max-w-6xl md:px-8 md:py-8">
        <Suspense
          fallback={
            <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
              Loading section…
            </div>
          }
        >
          {/* Visited tabs stay mounted but hidden: coming back to one is instant
              (no re-parse, no recompute) and it keeps scroll/filters in place. */}
          {mountedTabs.map((id) => {
            const TabComponent = TAB_COMPONENTS[id];
            const active = id === activeTab;
            return (
              <div key={id} hidden={!active} aria-hidden={!active}>
                <TabComponent />
              </div>
            );
          })}
        </Suspense>
      </main>


      <nav className="frost fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t pb-[env(safe-area-inset-bottom)] md:hidden">
        {primaryMobileTabs.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              onPointerDown={() => prefetchTab(t.id)}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative flex min-w-0 flex-col items-center gap-1 whitespace-nowrap py-2.5 text-[11px] font-medium transition-colors",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "grid size-8 place-items-center rounded-full transition-all",
                  active ? "bg-primary/12 shadow-[0_6px_16px_-10px_var(--primary)]" : "",
                )}
              >
                <Icon className="h-5 w-5" />
              </span>
              {t.label}
            </button>
          );
        })}
        {moreMobileTabs.length > 0 && (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="Open more sections"
            className={cn(
              "relative flex min-w-0 flex-col items-center gap-1 whitespace-nowrap py-2.5 text-[11px] font-medium transition-colors",
              moreMobileTabs.some((tab) => tab.id === activeTab)
                ? "text-primary"
                : "text-muted-foreground",
            )}
          >
            <span className="grid size-8 place-items-center rounded-full bg-primary/12 shadow-[0_6px_16px_-10px_var(--primary)]">
              <MoreHorizontal className="h-5 w-5" />
            </span>
            More
          </button>
        )}
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[75dvh] overflow-y-auto pb-[calc(1.5rem+env(safe-area-inset-bottom))] md:hidden"
        >
          <SheetHeader>
            <SheetTitle>More sections</SheetTitle>
            <SheetDescription>Choose another part of your business ledger.</SheetDescription>
          </SheetHeader>
          <div className="mt-5 grid grid-cols-2 gap-3">
            {moreMobileTabs.map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onPointerDown={() => prefetchTab(t.id)}
                  onClick={() => {
                    setTab(t.id);
                    setMoreOpen(false);
                  }}
                  className={cn(
                    "flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border text-sm font-medium",
                    active ? "border-primary bg-primary/10 text-primary" : "bg-muted/35",
                  )}
                >
                  <Icon className="size-6" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
