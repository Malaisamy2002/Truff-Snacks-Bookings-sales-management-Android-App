import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Download, ShieldCheck, Upload } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  buildReceiptsArchive,
  countReceipts,
  downloadReceiptsArchive,
  importReceiptsArchive,
  pickReceiptsArchiveFile,
  verifyReceipts,
  type ImportReceiptsArchiveResult,
} from "@/lib/receipts-share";
import { isAndroid, isDesktop } from "@/lib/desktop";

export function ReceiptsCard() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [pendingImportBytes, setPendingImportBytes] = useState<Uint8Array | null>(null);

  const refreshCount = () => {
    void countReceipts().then(setCount);
  };

  useEffect(() => {
    refreshCount();
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const reportImport = (result: ImportReceiptsArchiveResult) => {
    const parts = [`Restored ${result.restored} receipt${result.restored === 1 ? "" : "s"}`];
    if (result.skippedExisting > 0) parts.push(`${result.skippedExisting} already on this device`);
    if (result.skippedUnmatched > 0)
      parts.push(`${result.skippedUnmatched} didn't match a current expense`);
    if (result.unverifiable > 0)
      parts.push(`${result.unverifiable} restored without a checksum (older archive)`);
    if (result.corrupted.length > 0)
      parts.push(
        `${result.corrupted.length} failed a checksum and were not restored (${result.corrupted
          .slice(0, 5)
          .join(", ")}${result.corrupted.length > 5 ? ", …" : ""})`,
      );
    toast[result.corrupted.length > 0 ? "warning" : "success"](parts[0], {
      description: parts.length > 1 ? parts.slice(1).join(" · ") : undefined,
    });
    refreshCount();
  };

  const applyImport = async (bytes: Uint8Array) => {
    const result = await importReceiptsArchive(bytes);
    await qc.invalidateQueries();
    reportImport(result);
  };

  return (
    <section className="space-y-3">
      <Card className="frost">
        <CardHeader>
          <CardTitle className="text-base">Receipt photos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Backs up just the receipt photos attached to expenses, separately from the main{" "}
            <code className="mx-1 rounded bg-muted px-1">.db</code> backup above (which doesn't
            include them). Bring this <code className="mx-1 rounded bg-muted px-1">.zip</code> to
            another device to re-attach the same photos there.
          </p>
          <p className="text-sm text-muted-foreground">
            {count === null
              ? "Checking receipts on this device…"
              : count === 0
                ? "No expenses have a receipt attached yet."
                : `${count} expense${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} a receipt attached.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run("verify", async () => {
                  const result = await verifyReceipts();
                  const parts = [`${result.ok} of ${result.expected} OK`];
                  if (result.unverifiable > 0)
                    parts.push(`${result.unverifiable} without a checksum to check`);
                  if (result.missing.length > 0)
                    parts.push(`${result.missing.length} missing from this device`);
                  if (result.corrupted.length > 0)
                    parts.push(
                      `${result.corrupted.length} corrupted (${result.corrupted
                        .slice(0, 5)
                        .join(", ")}${result.corrupted.length > 5 ? ", …" : ""})`,
                    );
                  const hasProblems = result.missing.length > 0 || result.corrupted.length > 0;
                  toast[hasProblems ? "warning" : "success"](
                    hasProblems ? "Some receipts need attention" : "All receipts check out",
                    { description: parts.join(" · ") },
                  );
                })
              }
            >
              <ShieldCheck className="mr-1 h-4 w-4" /> Verify receipts
            </Button>
          </div>
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="frost-well flex w-full items-center justify-between gap-2 rounded-xl p-3 text-left text-sm font-medium">
              <span>Advanced</span>
              <ChevronDown
                className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-wrap gap-2 pt-3">
            <Button
              disabled={busy !== null || count === 0}
              onClick={() =>
                run("export", async () => {
                  const { blob, included, missing, verified, hashMismatch } =
                    await buildReceiptsArchive();
                  const savedTo = await downloadReceiptsArchive(blob);
                  if (savedTo === null) return; // user cancelled the save dialog
                  const descriptionParts = [`${included} photos`, `${verified} verified`];
                  if (missing.length > 0)
                    descriptionParts.push(`${missing.length} couldn't be found on this device`);
                  if (hashMismatch.length > 0)
                    descriptionParts.push(`${hashMismatch.length} failed self-verification`);
                  if (hashMismatch.length > 0) {
                    toast.error("Receipts archive saved with problems", {
                      description: `${descriptionParts.join(" · ")} (${hashMismatch
                        .slice(0, 5)
                        .join(", ")}${hashMismatch.length > 5 ? ", …" : ""})`,
                    });
                    return;
                  }
                  toast.success(isDesktop() ? "Receipts archive saved" : "Receipts archive downloaded", {
                    description: descriptionParts.join(" · "),
                  });
                })
              }
            >
              <Download className="mr-1 h-4 w-4" /> Export receipts (.zip)
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                // Android satisfies isDesktop() too, but
                // pickReceiptsArchiveFile()'s native open dialog (SAF picker)
                // isn't implemented there — fall through to the
                // <input type="file"> below instead, same as the browser/PWA
                // build.
                if (isDesktop() && !isAndroid()) {
                  void run("import", async () => {
                    const bytes = await pickReceiptsArchiveFile();
                    if (bytes === null) return; // user cancelled the open dialog
                    setPendingImportBytes(bytes);
                  });
                  return;
                }
                fileRef.current?.click();
              }}
            >
              <Upload className="mr-1 h-4 w-4" /> Import receipts (.zip)
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                void run("import", async () => {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  setPendingImportBytes(bytes);
                });
              }}
            />
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingImportBytes != null}
        onOpenChange={(o) => (o ? undefined : setPendingImportBytes(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import receipts from this archive?</AlertDialogTitle>
            <AlertDialogDescription>
              Only restores photos for expenses that already exist on this device and already
              point at that file — it won't create new expenses. Files already saved here are left
              untouched (never overwritten).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const bytes = pendingImportBytes;
                setPendingImportBytes(null);
                if (!bytes) return;
                void run("import", async () => applyImport(bytes));
              }}
              disabled={busy !== null}
            >
              Import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
