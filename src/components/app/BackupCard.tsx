import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, ShieldAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { shortDate } from "@/lib/biz";
import { useQueryClient } from "@tanstack/react-query";
import {
  backupSummary,
  buildBackup,
  decodeBackupBytes,
  downloadBackup,
  parseBackup,
  pickBackupFile,
  restoreBackup,
  type BackupFile,
} from "@/lib/backup";
import { isAndroid, isDesktop } from "@/lib/desktop";
import { hasBackupPassphrase } from "@/lib/backup-passphrase";
import { BackupEncryptionSettings } from "./BackupEncryptionSettings";
import {
  useAppSettings,
  writeAppSettings,
  readAppSettings,
  type BackupReminder,
} from "@/lib/settings";

export function BackupCard() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [merge, setMerge] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<BackupFile | null>(null);
  const { settings: appSettings, save: saveAppSettings } = useAppSettings();
  // `null` = still checking; `false` is what shows the inline encryption
  // setup below. Exports are encrypted unconditionally (downloadBackup ->
  // encryptFullBackupBytes), so a person who only ever uses this card — and
  // never opens the Telegram backup card, the other place this passphrase
  // can be set — needs a way to set one from right here too, not just a
  // toast error the first time they click Export.
  const [passphraseSet, setPassphraseSet] = useState<boolean | null>(null);

  useEffect(() => {
    void hasBackupPassphrase().then(setPassphraseSet);
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

  const applyBackup = async (bytes: Uint8Array) => {
    const text = await decodeBackupBytes(bytes);
    const backup = parseBackup(text);
    if (!merge) {
      // Replace mode wipes existing data — confirm before doing it.
      setPendingRestore(backup);
      return;
    }
    const count = await restoreBackup(backup, "merge");
    await qc.invalidateQueries();
    toast.success(`Restored ${count} records`, { description: backupSummary(backup) });
  };

  const confirmRestore = async () => {
    if (!pendingRestore) return;
    const backup = pendingRestore;
    setPendingRestore(null);
    setBusy("restore");
    try {
      const count = await restoreBackup(backup, "replace");
      await qc.invalidateQueries();
      toast.success(`Restored ${count} records`, { description: backupSummary(backup) });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3">
      <Card className="frost">
        <CardHeader>
          <CardTitle className="text-base">Single-file backup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Exports every customer, bill, expense, booking and snack sale into one encrypted
            <code className="mx-1 rounded bg-muted px-1">.db</code> file you can keep or move to
            another device.
          </p>
          {passphraseSet === false && (
            <div className="frost-well space-y-2 rounded-xl p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                <ShieldAlert className="h-3.5 w-3.5" /> Set a backup passphrase before exporting
              </p>
              <BackupEncryptionSettings onSaved={() => setPassphraseSet(true)} />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy !== null}
              onClick={() =>
                run("export", async () => {
                  const backup = await buildBackup();
                  const savedTo = await downloadBackup(backup);
                  if (savedTo === null) return; // user cancelled the save dialog
                  writeAppSettings({
                    ...readAppSettings(),
                    lastBackupAt: new Date().toISOString(),
                  });
                  toast.success(isDesktop() ? "Backup saved" : "Backup file downloaded", {
                    description: backupSummary(backup),
                  });
                })
              }
            >
              <Download className="mr-1 h-4 w-4" /> Export .db file
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                // Android satisfies isDesktop() too, but pickBackupFile()'s
                // native open dialog (SAF picker) isn't implemented there —
                // fall through to the <input type="file"> below instead,
                // same as the browser/PWA build.
                if (isDesktop() && !isAndroid()) {
                  void run("import", async () => {
                    const bytes = await pickBackupFile();
                    if (bytes === null) return; // user cancelled the open dialog
                    await applyBackup(bytes);
                  });
                  return;
                }
                fileRef.current?.click();
              }}
            >
              <Upload className="mr-1 h-4 w-4" /> Import .db file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".db,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                void run("import", async () =>
                  applyBackup(new Uint8Array(await file.arrayBuffer())),
                );
              }}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={merge} onCheckedChange={setMerge} />
            Merge with existing data (off = replace everything)
          </label>

          <div className="frost-well flex flex-wrap items-center justify-between gap-2 rounded-xl p-3">
            <div className="text-sm">
              <p className="micro-label">Backup reminders</p>
              <span className="block text-xs text-muted-foreground">
                {appSettings.lastBackupAt
                  ? `Last backup: ${shortDate(appSettings.lastBackupAt)}`
                  : "No backup downloaded yet on this device."}
              </span>
            </div>
            <div className="flex gap-2">
              {(["off", "daily", "weekly"] as BackupReminder[]).map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant={appSettings.backupReminder === opt ? "default" : "outline"}
                  onClick={() => saveAppSettings({ ...appSettings, backupReminder: opt })}
                >
                  {opt === "off" ? "Off" : opt === "daily" ? "Daily" : "Weekly"}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingRestore != null}
        onOpenChange={(o) => (o ? undefined : setPendingRestore(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace all data with this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRestore
                ? `This deletes everything currently on this device and replaces it with ${backupSummary(pendingRestore)}. This can't be undone. Turn on "Merge with existing data" instead if you want to add these records without deleting anything.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRestore();
              }}
              disabled={busy !== null}
            >
              Replace everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
