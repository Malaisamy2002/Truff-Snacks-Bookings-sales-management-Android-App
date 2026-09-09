// `fake-indexeddb/auto` installs a real (in-memory) IndexedDB implementation
// globally before Dexie opens the database, so `buildBackup()` can run
// against an actual `db` here the same way it does in the app — this test
// is asserting on buildBackup()'s real output, not a stand-in for it.
import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";

import { buildBackup, restoreBackup, BACKUP_TABLES, type BackupFile } from "./backup";
import { db, DATA_TABLES, newId, nowIso } from "./localdb";

describe("DATA_TABLES / BACKUP_TABLES", () => {
  it("never lists the receipts table among the plain-row tables", () => {
    // Receipt photos are still not part of the row-shaped `tables` object —
    // buildBackup() carries them separately in `photos` (base64-encoded),
    // see the test below. Keeping "receipts" out of this list is what keeps
    // photo bytes out of `tables`, specifically.
    expect(DATA_TABLES).not.toContain("receipts");
    expect(BACKUP_TABLES).not.toContain("receipts");
  });
});

describe("buildBackup()", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.receipts.clear();
  });

  it("includes every receipt photo, base64-encoded, in `photos` — not in `tables`", async () => {
    // An expense with a photo actually attached — receipt_path is a plain
    // string reference, never the bytes themselves.
    const receiptPath = `Receipts/2026-09-04/${newId()}.jpg`;
    await db.expenses.add({
      id: newId(),
      expense_no: "TX-20260904-0001",
      business: "Turf",
      category: "Maintenance",
      description: "Net repair",
      note: null,
      amount: 500,
      spent_at: "2026-09-04",
      receipt_path: receiptPath,
      created_at: nowIso(),
    });
    // uploadReceipt now mirrors every photo into db.receipts on every
    // platform (see its doc comment in expenses.ts) — this is that copy.
    const fakeJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    await db.receipts.put({
      path: receiptPath,
      blob: new Blob([fakeJpegBytes]),
      created_at: nowIso(),
    });

    const backup = await buildBackup();

    expect(backup.version).toBe(2);
    expect(backup.tables["receipts"]).toBeUndefined();
    expect(Object.keys(backup.tables)).not.toContain("receipts");
    expect(backup.tables["expenses"]?.[0]?.["receipt_path"]).toBe(receiptPath);

    expect(backup.photos).toHaveLength(1);
    expect(backup.photos?.[0]?.path).toBe(receiptPath);
    expect(backup.photos?.[0]?.data).toBe(btoa(String.fromCharCode(...fakeJpegBytes)));
  });

  it("produces an empty photos array when no receipts exist", async () => {
    const backup = await buildBackup();
    expect(backup.photos).toEqual([]);
  });
});

describe("restoreBackup() — photos", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.receipts.clear();
  });

  const makeBackup = (path: string, byte: number): BackupFile => ({
    format: "turf-snack-ledger",
    version: 2,
    exported_at: nowIso(),
    tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    photos: [{ path, data: btoa(String.fromCharCode(byte)), created_at: nowIso() }],
  });

  it("writes photos back into db.receipts on replace", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    await restoreBackup(makeBackup(path, 42), "replace");
    const row = await db.receipts.get(path);
    expect(row).toBeDefined();
    expect(new Uint8Array(await row!.blob.arrayBuffer())).toEqual(new Uint8Array([42]));
  });

  it("replace clears photos that aren't in the new backup", async () => {
    const stalePath = `Receipts/2026-01-01/${newId()}.jpg`;
    await db.receipts.put({ path: stalePath, blob: new Blob([new Uint8Array([1])]), created_at: nowIso() });
    const freshPath = `Receipts/2026-09-04/${newId()}.jpg`;
    await restoreBackup(makeBackup(freshPath, 99), "replace");
    expect(await db.receipts.get(stalePath)).toBeUndefined();
    expect(await db.receipts.get(freshPath)).toBeDefined();
  });

  it("merge never overwrites an existing photo at the same path", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    await db.receipts.put({ path, blob: new Blob([new Uint8Array([7])]), created_at: nowIso() });
    await restoreBackup(makeBackup(path, 200), "merge");
    const row = await db.receipts.get(path);
    expect(new Uint8Array(await row!.blob.arrayBuffer())).toEqual(new Uint8Array([7]));
  });

  it("a version-1 backup with no photos field restores cleanly with zero photos", async () => {
    const legacy: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    };
    await expect(restoreBackup(legacy, "replace")).resolves.toBe(0);
    expect(await db.receipts.toArray()).toEqual([]);
  });
});
