import "fake-indexeddb/auto";
import JSZip from "jszip";
import { describe, expect, it, beforeEach } from "vitest";
import {
  buildManifestEntry,
  buildReceiptsArchive,
  importReceiptsArchive,
  isReceiptZipPath,
  receiptsArchiveFileName,
  resolveImportAction,
  sha256Hex,
  verifyReceipts,
  type ReceiptManifestEntry,
} from "./receipts-share";
import { db, newId, nowIso } from "./localdb";

describe("buildManifestEntry", () => {
  it("carries the traceability fields for one expense's receipt", () => {
    expect(
      buildManifestEntry({
        id: "e1",
        expense_no: "TX-20260904-0001",
        spent_at: "2026-09-04T10:00:00.000Z",
        category: "Maintenance",
        amount: 500,
        receipt_path: "Receipts/2026-09-04/abc.jpg",
      }),
    ).toEqual({
      path: "Receipts/2026-09-04/abc.jpg",
      expense_id: "e1",
      expense_no: "TX-20260904-0001",
      spent_at: "2026-09-04T10:00:00.000Z",
      category: "Maintenance",
      amount: 500,
    });
  });

  it("coerces amount to a number (Dexie can hand back a string)", () => {
    const entry = buildManifestEntry({
      id: "e1",
      expense_no: null,
      spent_at: "2026-09-04T10:00:00.000Z",
      category: "Other",
      amount: "500" as unknown as number,
      receipt_path: "Receipts/2026-09-04/abc.jpg",
    });
    expect(entry.amount).toBe(500);
  });
});

describe("isReceiptZipPath", () => {
  it("accepts a real receipt file under Receipts/", () => {
    expect(isReceiptZipPath("Receipts/2026-09-04/abc.jpg")).toBe(true);
  });

  it("rejects the manifest", () => {
    expect(isReceiptZipPath("manifest.json")).toBe(false);
  });

  it("rejects folder entries", () => {
    expect(isReceiptZipPath("Receipts/2026-09-04/")).toBe(false);
    expect(isReceiptZipPath("Receipts/")).toBe(false);
  });

  it("rejects anything outside Receipts/", () => {
    expect(isReceiptZipPath("Invoices/Turf/foo.pdf")).toBe(false);
    expect(isReceiptZipPath("readme.txt")).toBe(false);
  });
});

describe("resolveImportAction", () => {
  const known = new Set(["Receipts/2026-09-04/abc.jpg"]);

  it("restores a matched file that isn't already on this device", () => {
    expect(resolveImportAction("Receipts/2026-09-04/abc.jpg", known, false)).toBe("restore");
  });

  it("skips a matched file that's already saved (never overwrite)", () => {
    expect(resolveImportAction("Receipts/2026-09-04/abc.jpg", known, true)).toBe("skip-existing");
  });

  it("skips a file no current expense row points to, existing or not", () => {
    expect(resolveImportAction("Receipts/2026-09-04/orphan.jpg", known, false)).toBe(
      "skip-unmatched",
    );
    expect(resolveImportAction("Receipts/2026-09-04/orphan.jpg", known, true)).toBe(
      "skip-unmatched",
    );
  });
});

describe("receiptsArchiveFileName", () => {
  it("names the file turf-receipts-<timestamp>.zip", () => {
    expect(receiptsArchiveFileName()).toMatch(
      /^turf-receipts-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/,
    );
  });
});

describe("sha256Hex()", () => {
  it("is deterministic for the same bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(bytes.slice()));
  });

  it("differs for different bytes", async () => {
    const a = await sha256Hex(new Uint8Array([1, 2, 3]));
    const b = await sha256Hex(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});

async function seedExpenseWithReceipt(over: { path: string; expense_no?: string | null }) {
  const id = newId();
  await db.expenses.add({
    id,
    expense_no: over.expense_no ?? "TX-20260904-0001",
    business: "Turf",
    category: "Maintenance",
    description: null,
    note: null,
    amount: 500,
    spent_at: "2026-09-04",
    receipt_path: over.path,
    created_at: nowIso(),
  });
  return id;
}

describe("buildReceiptsArchive() self-verification", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.receipts.clear();
  });

  it("hashes every packed photo and self-verifies with no mismatches on a clean build", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    await seedExpenseWithReceipt({ path });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    await db.receipts.put({ path, blob: new Blob([bytes]), created_at: nowIso() });

    const result = await buildReceiptsArchive();
    expect(result.included).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.hashMismatch).toEqual([]);

    // The manifest actually written into the zip carries the recorded hash.
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const manifest = JSON.parse(
      await zip.files["manifest.json"]!.async("string"),
    ) as ReceiptManifestEntry[];
    expect(manifest[0]?.sha256).toBe(await sha256Hex(bytes));
  });
});

describe("importReceiptsArchive() integrity checks", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.receipts.clear();
  });

  it("restores a file whose bytes match the manifest's recorded hash", async () => {
    const path = "Receipts/2026-09-04/good.jpg";
    await seedExpenseWithReceipt({ path });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const manifest: ReceiptManifestEntry[] = [
      {
        path,
        expense_id: "e1",
        expense_no: "TX-20260904-0001",
        spent_at: "2026-09-04",
        category: "Maintenance",
        amount: 500,
        sha256: await sha256Hex(bytes),
      },
    ];
    const zip = new JSZip();
    zip.file(path, bytes);
    zip.file("manifest.json", JSON.stringify(manifest));
    const archiveBytes = await zip.generateAsync({ type: "uint8array" });

    const result = await importReceiptsArchive(archiveBytes);
    expect(result.restored).toBe(1);
    expect(result.corrupted).toEqual([]);
    expect(result.unverifiable).toBe(0);
    expect(await db.receipts.get(path)).toBeDefined();
  });

  it("rejects and does not write a file whose bytes don't match the manifest's hash, reporting the expense_no", async () => {
    const path = "Receipts/2026-09-04/bad.jpg";
    await seedExpenseWithReceipt({ path, expense_no: "TX-20260904-0009" });
    const realBytes = new Uint8Array([1, 2, 3, 4]);
    const manifest: ReceiptManifestEntry[] = [
      {
        path,
        expense_id: "e1",
        expense_no: "TX-20260904-0009",
        spent_at: "2026-09-04",
        category: "Maintenance",
        amount: 500,
        // Hash of DIFFERENT bytes — simulates corruption between export and import.
        sha256: await sha256Hex(new Uint8Array([9, 9, 9, 9])),
      },
    ];
    const zip = new JSZip();
    zip.file(path, realBytes);
    zip.file("manifest.json", JSON.stringify(manifest));
    const archiveBytes = await zip.generateAsync({ type: "uint8array" });

    const result = await importReceiptsArchive(archiveBytes);
    expect(result.restored).toBe(0);
    expect(result.corrupted).toEqual(["TX-20260904-0009"]);
    expect(await db.receipts.get(path)).toBeUndefined();
  });

  it("restores a legacy archive with no sha256 field and reports it as unverifiable, not corrupt", async () => {
    const path = "Receipts/2026-09-04/legacy.jpg";
    await seedExpenseWithReceipt({ path });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // Pre-hash-field manifest shape — no sha256 key at all.
    const manifest = [
      {
        path,
        expense_id: "e1",
        expense_no: "TX-20260904-0001",
        spent_at: "2026-09-04",
        category: "Maintenance",
        amount: 500,
      },
    ];
    const zip = new JSZip();
    zip.file(path, bytes);
    zip.file("manifest.json", JSON.stringify(manifest));
    const archiveBytes = await zip.generateAsync({ type: "uint8array" });

    const result = await importReceiptsArchive(archiveBytes);
    expect(result.restored).toBe(1);
    expect(result.corrupted).toEqual([]);
    expect(result.unverifiable).toBe(1);
  });
});

describe("verifyReceipts()", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.receipts.clear();
    await db.receipt_hashes.clear();
  });

  it("passes a photo whose current bytes match its capture-time hash", async () => {
    const path = "Receipts/2026-09-04/ok.jpg";
    await seedExpenseWithReceipt({ path });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await db.receipts.put({ path, blob: new Blob([bytes]), created_at: nowIso() });
    await db.receipt_hashes.put({ path, sha256: await sha256Hex(bytes), created_at: nowIso() });

    const result = await verifyReceipts();
    expect(result.ok).toBe(1);
    expect(result.corrupted).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("catches on-disk corruption outside of any import/export flow", async () => {
    const path = "Receipts/2026-09-04/corrupted.jpg";
    await seedExpenseWithReceipt({ path, expense_no: "TX-20260904-0005" });
    const originalBytes = new Uint8Array([1, 2, 3, 4]);
    await db.receipt_hashes.put({
      path,
      sha256: await sha256Hex(originalBytes),
      created_at: nowIso(),
    });
    // The bytes on disk have since changed (e.g. bad sector, sync-tool bug)
    // without going through uploadReceipt again.
    const corruptedBytes = new Uint8Array([9, 9, 9, 9]);
    await db.receipts.put({ path, blob: new Blob([corruptedBytes]), created_at: nowIso() });

    const result = await verifyReceipts();
    expect(result.corrupted).toEqual(["TX-20260904-0005"]);
    expect(result.ok).toBe(0);
  });

  it("treats a photo with no recorded hash as unverifiable, not corrupt", async () => {
    const path = "Receipts/2026-09-04/no-hash.jpg";
    await seedExpenseWithReceipt({ path });
    await db.receipts.put({
      path,
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      created_at: nowIso(),
    });
    // No db.receipt_hashes entry for this path at all.

    const result = await verifyReceipts();
    expect(result.unverifiable).toBe(1);
    expect(result.corrupted).toEqual([]);
    expect(result.ok).toBe(1);
  });

  it("reports a photo with no file on this device as missing", async () => {
    await seedExpenseWithReceipt({ path: "Receipts/2026-09-04/gone.jpg" });
    const result = await verifyReceipts();
    expect(result.missing).toEqual(["Receipts/2026-09-04/gone.jpg"]);
    expect(result.corrupted).toEqual([]);
  });
});
