import { db, table, DATA_TABLES, type DataTable, type Row } from "./localdb";
import {
  isAndroid,
  isDesktop,
  saveExportFile,
  saveToAppDocuments,
  bytesToBase64,
  base64ToBytes,
} from "./desktop";

export const BACKUP_TABLES = DATA_TABLES;

export type BackupTable = DataTable;

/** One receipt photo, base64-encoded, as carried inline in a version-2+ backup. */
export type BackupPhoto = { path: string; data: string; created_at: string };

export type BackupFile = {
  format: "turf-snack-ledger";
  /**
   * Version 1 was table rows only — receipt photos travelled separately via
   * the `.zip` export in receipts-share.ts. Version 2 adds `photos` below,
   * so a single `.db` file is fully self-contained (data + receipt photos)
   * and can be copied straight to another device (Windows ⇄ Android) with
   * nothing else to transfer. `restoreBackup` reads both versions the same
   * way — `photos` simply comes back empty for a version-1 file.
   */
  version: 1 | 2;
  exported_at: string;
  tables: Record<string, Record<string, unknown>[]>;
  photos?: BackupPhoto[];
};

/**
 * Reads every local table, plus every receipt photo, into one portable
 * snapshot. Photos come from `db.receipts` — `uploadReceipt` (expenses.ts)
 * mirrors every photo there on every platform (not just the browser/PWA
 * build), so this one Dexie table is always the complete set regardless of
 * whether the device also keeps an on-disk copy under `Documents/TurfApp`.
 */
export async function buildBackup(): Promise<BackupFile> {
  const tables: BackupFile["tables"] = {};
  for (const t of BACKUP_TABLES) {
    tables[t] = (await table(t).toArray()) as Record<string, unknown>[];
  }
  const receiptRows = await db.receipts.toArray();
  const photos: BackupPhoto[] = await Promise.all(
    receiptRows.map(async (r) => ({
      path: r.path,
      data: bytesToBase64(new Uint8Array(await r.blob.arrayBuffer())),
      created_at: r.created_at,
    })),
  );
  return {
    format: "turf-snack-ledger",
    version: 2,
    exported_at: new Date().toISOString(),
    tables,
    photos,
  };
}

export function backupFileName() {
  return `turf-ledger-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.db`;
}

/**
 * Saves a backup to disk. In the browser/PWA this is a Blob + `<a download>`
 * click (fire-and-forget, no result). In the desktop shell it opens a native
 * Save dialog via `tauri-plugin-dialog` + `tauri-plugin-fs`; returns the path
 * the user chose, or `null` if they cancelled the dialog.
 *
 * Android is matched before the generic desktop branch and does NOT use that
 * Save dialog: `tauri-plugin-dialog`'s `save()` hands back a `content://`
 * URI on Android that `tauri-plugin-fs`'s `writeTextFile()` cannot write to
 * — it does not throw, it just silently produces a 0-byte file (see
 * `saveExportFile`'s doc comment in desktop.ts). That's a real correctness
 * risk here specifically, since `archiveYear` in archive.ts (which shares
 * this same dialog+fs pattern) deletes local rows once its own download
 * reports success — a silently-empty backup would mean deleted data with no
 * usable copy anywhere. Android instead writes through the bundled
 * `android-save` plugin straight into the public Downloads folder, with no
 * dialog and thus no "cancelled" outcome — just saved or not.
 *
 * Kept async (the browser branch always did the work synchronously, so
 * existing unawaited call sites keep working unchanged) so BackupCard/
 * ArchiveCard can `await` it to know whether a desktop save was cancelled
 * (or an Android save failed).
 */
export async function downloadBackup(
  backup: BackupFile,
  name = backupFileName(),
): Promise<string | null> {
  const text = JSON.stringify(backup, null, 2);

  if (isAndroid()) {
    const bytes = new TextEncoder().encode(text);
    const result = await saveExportFile(bytes, name, "application/json");
    // A failed Android save throws with the device's own reason so the
    // caller's catch can show it, instead of returning null — which the
    // caller can't tell apart from "the person cancelled".
    if (!result.saved)
      throw new Error(`Couldn't save the backup: ${result.error ?? "unknown reason"}`);
    return result.path ?? name;
  }

  if (isDesktop()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: name,
      filters: [{ name: "Ledger backup", extensions: ["db", "json"] }],
    });
    if (!path) return null; // user cancelled — caller should not claim success
    await writeTextFile(path, text);
    return path;
  }

  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

/**
 * Opens a native file-open dialog and reads the chosen backup. Desktop-only —
 * the browser build keeps using the `<input type="file">` element already in
 * BackupCard.tsx, since a plain `<input>` has no native-dialog equivalent to
 * call from here. Returns `null` if the user cancelled.
 */
export async function pickBackupFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const path = await open({
    multiple: false,
    filters: [{ name: "Ledger backup", extensions: ["db", "json"] }],
  });
  if (!path || Array.isArray(path)) return null;
  return readTextFile(path);
}

export function parseBackup(text: string): BackupFile {
  const parsed = JSON.parse(text) as BackupFile;
  if (parsed?.format !== "turf-snack-ledger" || !parsed.tables)
    throw new Error("Not a valid ledger backup file");
  return parsed;
}

export function backupSummary(backup: BackupFile) {
  const base = BACKUP_TABLES.map((t) => `${t}: ${backup.tables[t]?.length ?? 0}`).join(" · ");
  const photoCount = backup.photos?.length ?? 0;
  return photoCount > 0 ? `${base} · photos: ${photoCount}` : base;
}

/**
 * Restores a snapshot. `mode: "replace"` wipes current rows first;
 * `mode: "merge"` keeps existing rows and adds only the ones missing.
 * Returns the number of table rows inserted — photos are restored too (see
 * the `backup.photos` loop below), but aren't counted in this return value.
 */
export async function restoreBackup(backup: BackupFile, mode: "replace" | "merge" = "replace") {
  let inserted = 0;

  await db.transaction("rw", [...BACKUP_TABLES.map((t) => table(t)), db.receipts], async () => {
    if (mode === "replace") {
      for (const t of [...BACKUP_TABLES].reverse()) {
        await table(t).clear();
      }
      // Photos are keyed by `receipt_path`, so a "replace" that wipes the
      // expense rows but leaves old photos behind would strand them —
      // clear them together so the two stay in sync.
      await db.receipts.clear();
    }

    for (const t of BACKUP_TABLES) {
      const rows = (backup.tables[t] ?? []) as Row[];
      if (rows.length === 0) continue;
      const target = table(t);
      if (mode === "merge") {
        // Dedup on each table's OWN primary key, not a hardcoded "id" —
        // most DATA_TABLES use "id", but app_settings is keyed by "key"
        // (see localdb.ts). Hardcoding "id" made every app_settings row
        // (existing and incoming) collapse to the same "undefined" bucket,
        // so a merge restore silently kept whichever settings the target
        // device already had and dropped the incoming ones with no error.
        const primKey = target.schema.primKey.name as string;
        const existing = new Set((await target.toArray()).map((r) => String(r[primKey])));
        const fresh = rows.filter((r) => !existing.has(String(r[primKey])));
        if (fresh.length === 0) continue;
        await target.bulkAdd(fresh);
        inserted += fresh.length;
      } else {
        await target.bulkPut(rows);
        inserted += rows.length;
      }
    }

    for (const photo of backup.photos ?? []) {
      if (mode === "merge" && (await db.receipts.get(photo.path))) continue; // never overwrite
      await db.receipts.put({
        path: photo.path,
        blob: new Blob([base64ToBytes(photo.data).buffer as ArrayBuffer]),
        created_at: photo.created_at,
      });
    }
  });

  // Best-effort, outside the transaction (real filesystem I/O, not
  // IndexedDB): also write each restored photo to disk on desktop/Android,
  // so "View receipt" works immediately without falling back to the Dexie
  // copy just written above. If any of these fail, that Dexie copy is
  // still there as a fallback (see openReceipt in expenses.ts).
  if (isDesktop() && backup.photos?.length) {
    for (const photo of backup.photos) {
      try {
        await saveToAppDocuments(photo.path, base64ToBytes(photo.data));
      } catch {
        /* best-effort only */
      }
    }
  }

  return inserted;
}
