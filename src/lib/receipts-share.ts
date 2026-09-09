const loadJSZip = async () => (await import("jszip")).default;
import { db, nowIso, type ExpenseRow } from "./localdb";
import {
  appDocumentExists,
  isAndroid,
  isDesktop,
  readAppDocument,
  saveExportFile,
  saveToAppDocuments,
} from "./desktop";

/**
 * Receipts sharing — a separate import/export path for just the receipt
 * photo *files*, as a lighter-weight alternative to the full `.db` backup
 * in `backup.ts` (which, as of its `photos` field, also carries every
 * receipt photo inline — see `buildBackup()`'s doc comment there). This
 * module stays useful when someone wants to move *only* photos — e.g.
 * re-attaching photos on a device that already has the data rows but
 * skipped photos when restoring an older (pre-photos) `.db` backup.
 *
 * Built with `jszip`, using the same relative-path convention
 * (`Receipts/<date>/<id>.<ext>`) the app already stores in
 * `ExpenseRow.receipt_path` — so the archive is self-describing and needs
 * no extra lookup table to unpack.
 *
 * Restoring an archive only ever re-attaches a photo to an expense row that
 * already exists and already points at that path — it never creates new
 * expense rows. That stays the full backup's job.
 */

const ZIP_RECEIPTS_PREFIX = "Receipts/";
const MANIFEST_NAME = "manifest.json";

/**
 * Hex-encoded SHA-256 of a byte array, via Web Crypto's `crypto.subtle`
 * (available in both the Tauri webview and the browser build — no extra
 * dependency needed). Used to fingerprint receipt photos at capture time
 * and again on export/import/verify, so a corrupted byte anywhere in that
 * lifecycle is caught instead of silently traveling forward as a "valid"
 * photo.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ReceiptManifestEntry = {
  path: string;
  expense_id: string;
  expense_no: string | null;
  spent_at: string;
  category: string;
  amount: number;
  /**
   * SHA-256 of the exact bytes packed for this file, computed while
   * building the archive. Absent on archives built before this field
   * existed — those are treated as "unverifiable", not "corrupt", by both
   * the export self-check and the import checker below.
   */
  sha256?: string;
};

/** Pure — builds one manifest row for an expense known to have a receipt. */
export function buildManifestEntry(
  expense: Pick<ExpenseRow, "id" | "expense_no" | "spent_at" | "category" | "amount"> & {
    receipt_path: string;
  },
): ReceiptManifestEntry {
  return {
    path: expense.receipt_path,
    expense_id: expense.id,
    expense_no: expense.expense_no,
    spent_at: expense.spent_at,
    category: expense.category,
    amount: Number(expense.amount),
  };
}

/**
 * True if a path inside the zip is an actual receipt file to restore — under
 * `Receipts/`, not a folder entry, and not the manifest. Pure and exported
 * mainly so the import logic below and its tests share one definition.
 */
export function isReceiptZipPath(zipPath: string): boolean {
  if (zipPath === MANIFEST_NAME) return false;
  if (!zipPath.startsWith(ZIP_RECEIPTS_PREFIX)) return false;
  if (zipPath.endsWith("/")) return false;
  return true;
}

export type ImportAction = "restore" | "skip-existing" | "skip-unmatched";

/**
 * Pure decision for one file found in an imported zip:
 * - `skip-unmatched`: no current expense row's `receipt_path` points here —
 *   importing a receipt never creates a new expense row, so there is
 *   nothing to attach this photo to.
 * - `skip-existing`: a file is already saved at this path — never overwrite.
 * - `restore`: write it.
 */
export function resolveImportAction(
  path: string,
  knownReceiptPaths: ReadonlySet<string>,
  alreadyExists: boolean,
): ImportAction {
  if (!knownReceiptPaths.has(path)) return "skip-unmatched";
  if (alreadyExists) return "skip-existing";
  return "restore";
}

export function receiptsArchiveFileName() {
  return `turf-receipts-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip`;
}

/** Number of expenses that currently have a receipt attached — for the settings card. */
export async function countReceipts(): Promise<number> {
  const rows = await db.expenses.toArray();
  return rows.filter((e) => !!e.receipt_path).length;
}

async function readReceiptBytes(path: string): Promise<Uint8Array> {
  if (isDesktop() && (await appDocumentExists(path))) {
    return readAppDocument(path);
  }
  // Falls through here on desktop/Android when the on-disk file is missing
  // (e.g. right after a `.db` restore that included photos — see
  // uploadReceipt's doc comment in expenses.ts), and always on plain
  // web/PWA builds, which only ever had the Dexie copy.
  const row = await db.receipts.get(path);
  if (!row) throw new Error(`Missing on this device: ${path}`);
  return new Uint8Array(await row.blob.arrayBuffer());
}

export type BuildReceiptsArchiveResult = {
  blob: Blob;
  /** Receipts actually packed into the zip. */
  included: number;
  /** `receipt_path`s that exist on the expense row but whose file couldn't be found. */
  missing: string[];
  /** Packed receipts whose re-hash after generateAsync matched the manifest. */
  verified: number;
  /**
   * Packed receipts whose re-hash after `generateAsync` did NOT match what
   * was read from disk — a corrupt read/re-encode caught before the file
   * ever reaches disk or a share sheet. Each entry is that receipt's
   * `expense_no` (falling back to its path if the expense has none), so the
   * person knows which physical receipt to check.
   */
  hashMismatch: string[];
};

/**
 * Packs every expense's receipt photo into one `.zip`, preserving the
 * `Receipts/<date>/<id>.<ext>` structure, plus a root `manifest.json` for
 * traceability. Missing files (a `receipt_path` set but no matching photo —
 * can happen after a partial restore) are skipped, not fatal; they're
 * reported back so the caller can tell the person.
 *
 * Every packed file is SHA-256 hashed as its bytes are read, and that hash
 * is recorded in the manifest. After the zip is actually generated, it's
 * re-opened in memory and every entry is re-hashed against that recorded
 * value — this is what catches a corrupt read or a JSZip re-encoding bug
 * before the archive ever reaches disk or a share sheet, rather than only
 * discovering it later on import.
 */
export async function buildReceiptsArchive(): Promise<BuildReceiptsArchiveResult> {
  const rows = await db.expenses.toArray();
  const withReceipts = rows.filter(
    (e): e is ExpenseRow & { receipt_path: string } => !!e.receipt_path,
  );

  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const manifest: ReceiptManifestEntry[] = [];
  const missing: string[] = [];

  for (const expense of withReceipts) {
    let bytes: Uint8Array;
    try {
      bytes = await readReceiptBytes(expense.receipt_path);
    } catch {
      missing.push(expense.receipt_path);
      continue;
    }
    const sha256 = await sha256Hex(bytes);
    zip.file(expense.receipt_path, bytes);
    manifest.push({ ...buildManifestEntry(expense), sha256 });
  }

  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({ type: "blob" });

  // Self-verify: re-open what was actually generated and re-hash every
  // packed entry against the manifest value recorded above.
  let verified = 0;
  const hashMismatch: string[] = [];
  // JSZip accepts Blobs in browsers, but ArrayBuffer is the portable common
  // format across Android WebView and the Node-based verification suite.
  const reopened = await (await loadJSZip()).loadAsync(await blob.arrayBuffer());
  for (const entry of manifest) {
    const packedFile = reopened.files[entry.path];
    const rehash = packedFile ? await sha256Hex(await packedFile.async("uint8array")) : null;
    if (rehash === entry.sha256) {
      verified++;
    } else {
      hashMismatch.push(entry.expense_no ?? entry.path);
    }
  }

  return { blob, included: manifest.length, missing, verified, hashMismatch };
}

/**
 * Saves a receipts archive to disk. Same dual-path pattern as
 * `downloadBackup()` in `backup.ts`: native Save dialog on desktop, a
 * Blob-URL `<a download>` on web. Returns the path chosen (desktop), a
 * fixed placeholder (web, which has no path to report), or `null` if the
 * user cancelled the desktop Save dialog (or, on Android, if the save
 * failed).
 *
 * Android is matched before the generic desktop branch for the same reason
 * as `downloadBackup`/`downloadText`: the Save dialog's `content://` result
 * can't actually be written to by `tauri-plugin-fs` there, so it's routed
 * through the `android-save` plugin instead.
 */
export async function downloadReceiptsArchive(
  blob: Blob,
  name = receiptsArchiveFileName(),
): Promise<string | null> {
  if (isAndroid()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await saveExportFile(bytes, name, "application/zip");
    if (!result.saved)
      throw new Error(`Couldn't save the receipts archive: ${result.error ?? "unknown reason"}`);
    return result.path ?? name;
  }

  if (isDesktop()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: name,
      filters: [{ name: "Receipts archive", extensions: ["zip"] }],
    });
    if (!path) return null; // user cancelled — caller should not claim success
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

/**
 * Opens a native file-open dialog and reads the chosen archive's bytes.
 * Desktop-only — the browser build uses the `<input type="file">` element
 * already in `ReceiptsCard.tsx`, since a plain `<input>` has no native-dialog
 * equivalent to call from here. Returns `null` if the user cancelled.
 */
export async function pickReceiptsArchiveFile(): Promise<Uint8Array | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const path = await open({
    multiple: false,
    filters: [{ name: "Receipts archive", extensions: ["zip"] }],
  });
  if (!path || Array.isArray(path)) return null;
  return readFile(path);
}

export type ImportReceiptsArchiveResult = {
  restored: number;
  skippedExisting: number;
  skippedUnmatched: number;
  /**
   * Files whose extracted bytes did NOT match the `sha256` recorded for
   * them in `manifest.json` — not written to disk. Each entry is the
   * affected expense's `expense_no` (falling back to the zip path if the
   * expense has none), so the person knows which receipts to re-export
   * from the source device.
   */
  corrupted: string[];
  /**
   * Files restored normally but with no `sha256` to check them against —
   * either the manifest predates this field, or (rarer) the manifest has
   * no entry at all for this path. Restored as before, just flagged so the
   * UI can say "restored without a checksum" instead of implying a full
   * check happened.
   */
  unverifiable: number;
};

/**
 * Unpacks a receipts `.zip` and writes back every file under `Receipts/**`
 * that a current expense row's `receipt_path` points to and that doesn't
 * already exist on this device — skip-if-exists, never overwrite. Files
 * that don't match any current expense's `receipt_path` are left alone;
 * this only restores photos for rows that already exist (see module doc).
 *
 * Every file about to be restored is hashed and checked against
 * `manifest.json`'s recorded `sha256` (when present) before it's written —
 * a mismatch means the bytes were damaged somewhere between export and this
 * import, so it's reported as `corrupted` and never written, rather than
 * silently restoring a bad photo.
 */
export async function importReceiptsArchive(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ImportReceiptsArchiveResult> {
  const zip = await (await loadJSZip()).loadAsync(bytes);
  const rows = await db.expenses.toArray();
  const knownReceiptPaths = new Set(
    rows.map((e) => e.receipt_path).filter((p): p is string => !!p),
  );

  const manifestEntry = zip.files[MANIFEST_NAME];
  let manifestByPath = new Map<string, ReceiptManifestEntry>();
  if (manifestEntry && !manifestEntry.dir) {
    try {
      const parsed = JSON.parse(await manifestEntry.async("string")) as ReceiptManifestEntry[];
      manifestByPath = new Map(parsed.map((e) => [e.path, e]));
    } catch {
      // A manifest that fails to parse is treated the same as "no manifest
      // at all" below — every file falls back to "unverifiable", not fatal.
    }
  }

  let restored = 0;
  let skippedExisting = 0;
  let skippedUnmatched = 0;
  let unverifiable = 0;
  const corrupted: string[] = [];

  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (!entry || entry.dir || !isReceiptZipPath(path)) continue;

    const alreadyExists =
      (isDesktop() && (await appDocumentExists(path))) || (await db.receipts.get(path)) != null;
    const action = resolveImportAction(path, knownReceiptPaths, alreadyExists);

    if (action === "skip-unmatched") {
      skippedUnmatched++;
      continue;
    }
    if (action === "skip-existing") {
      skippedExisting++;
      continue;
    }

    const fileBytes = await entry.async("uint8array");
    const manifestForPath = manifestByPath.get(path);
    if (manifestForPath?.sha256) {
      const actualHash = await sha256Hex(fileBytes);
      if (actualHash !== manifestForPath.sha256) {
        corrupted.push(manifestForPath.expense_no ?? path);
        continue; // don't write a file that failed its checksum
      }
    } else {
      unverifiable++;
    }

    // Mirror into Dexie on every platform (see uploadReceipt's doc comment
    // in expenses.ts), plus the on-disk file on desktop/Android.
    await db.receipts.put({
      path,
      blob: new Blob([fileBytes.buffer.slice(0) as ArrayBuffer]),
      created_at: nowIso(),
    });
    if (isDesktop()) {
      await saveToAppDocuments(path, fileBytes);
    }
    restored++;
  }

  return { restored, skippedExisting, skippedUnmatched, corrupted, unverifiable };
}

export type MissingReceiptScan = {
  /** Expense rows that claim a receipt photo. */
  expected: number;
  /** Of those, the `receipt_path`s with no photo on this device. */
  missing: string[];
};

/**
 * A version-2+ `.db` restore now brings photos along (see `photos` on
 * `BackupFile` in backup.ts), so this mainly matters for an
 * older version-1 backup, or a device that skipped photos for some other
 * reason. Without this scan the person only discovers it much later, one
 * expense at a time, when "View receipt" errors out. This reports the gap
 * up front so the restore flow can point them at "Import receipt photos".
 */
export async function scanMissingReceipts(): Promise<MissingReceiptScan> {
  const rows = await db.expenses.toArray();
  const paths = rows.map((e) => e.receipt_path).filter((p): p is string => !!p);
  const missing: string[] = [];
  for (const path of paths) {
    const present =
      (isDesktop() && (await appDocumentExists(path))) || (await db.receipts.get(path)) != null;
    if (!present) missing.push(path);
  }
  return { expected: paths.length, missing };
}

/** One-line notice text for a scan result, or null when nothing is missing. */
export function missingReceiptsNotice(scan: MissingReceiptScan): string | null {
  if (scan.missing.length === 0) return null;
  const n = scan.missing.length;
  return `${n} of ${scan.expected} expense${scan.expected === 1 ? "" : "s"} ${
    n === 1 ? "has a receipt photo" : "have receipt photos"
  } that isn't on this device. Photos travel separately — use "Import receipt photos" to bring them over.`;
}

export type VerifyReceiptsResult = {
  /** Expense rows that claim a receipt photo. */
  expected: number;
  /** Present on this device and, where a capture-time hash exists, matching it. */
  ok: number;
  /** No file at all on this device — same set `scanMissingReceipts` would find. */
  missing: string[];
  /**
   * Present on disk but whose current bytes don't match the hash recorded
   * at capture time (`uploadReceipt` in expenses.ts) — on-disk corruption
   * that neither import nor export would have caught, since it can happen
   * to a photo that never went through an archive at all. Each entry is
   * that receipt's `expense_no` (falling back to its path).
   */
  corrupted: string[];
  /** Present on disk, but no capture-time hash was ever recorded for it (a
   * photo saved before the `receipt_hashes` table existed) — can't be
   * checked either way. */
  unverifiable: number;
};

/**
 * Standalone integrity check a person can run any time from
 * `ReceiptsCard.tsx`, independent of any import/export — for every expense
 * with a `receipt_path`, confirms the file still exists on this device and,
 * where `uploadReceipt` recorded a hash for it at capture time, that its
 * bytes still match that hash. This is what catches a photo that
 * corrupts on-disk *between* captures (bad sector, sync-tool bug, etc.), not
 * just corruption introduced by an export/import round-trip — those are
 * caught separately by `buildReceiptsArchive`'s self-verify and
 * `importReceiptsArchive`'s per-file check above.
 */
export async function verifyReceipts(): Promise<VerifyReceiptsResult> {
  const rows = await db.expenses.toArray();
  const withReceipts = rows.filter(
    (e): e is ExpenseRow & { receipt_path: string } => !!e.receipt_path,
  );

  let ok = 0;
  let unverifiable = 0;
  const missing: string[] = [];
  const corrupted: string[] = [];

  for (const expense of withReceipts) {
    let bytes: Uint8Array;
    try {
      bytes = await readReceiptBytes(expense.receipt_path);
    } catch {
      missing.push(expense.receipt_path);
      continue;
    }
    const recorded = await db.receipt_hashes.get(expense.receipt_path);
    if (!recorded) {
      unverifiable++;
      ok++; // present and un-checkable is not a failure — just unverified
      continue;
    }
    const actual = await sha256Hex(bytes);
    if (actual === recorded.sha256) {
      ok++;
    } else {
      corrupted.push(expense.expense_no ?? expense.receipt_path);
    }
  }

  return { expected: withReceipts.length, ok, missing, corrupted, unverifiable };
}
