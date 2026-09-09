// Real (in-memory) IndexedDB so buildFullBackup()/restoreFullBackup() run
// against actual Dexie tables, the same way they do in the app.
import "fake-indexeddb/auto";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_NAME_PREFIX,
  CHUNK_BYTES,
  MANIFEST_NAME,
  botTokenForChunk,
  buildFullBackup,
  chunkCaption,
  chunkCount,
  chunkFileName,
  chunksFromUpdates,
  decodePairingPayload,
  encodePairingPayload,
  fullBackupSummary,
  joinChunks,
  latestCompleteGroup,
  parseChunkName,
  parseFullBackupManifest,
  restoreFullBackup,
  restoreSummary,
  retryAfterMs,
  splitIntoChunks,
  telegramErrorMessage,
  uploadFullBackup,
  downloadChunk,
  type TelegramConfig,
} from "./telegram-backup";
import { db, newId, nowIso } from "./localdb";

const cfg = (over: Partial<TelegramConfig> = {}): TelegramConfig => ({
  botToken: "bot-1",
  chatId: "-100123",
  extraBotTokens: [],
  deviceLabel: "Windows",
  ...over,
});

async function seedExpenseWithReceipt(bytes: Uint8Array, spentAt = "2026-09-04") {
  const id = newId();
  const path = `Receipts/${spentAt}/${id}.jpg`;
  await db.expenses.add({
    id,
    expense_no: "TX-20260904-0001",
    business: "Turf",
    category: "Maintenance",
    description: "Net repair",
    note: null,
    amount: 500,
    spent_at: spentAt,
    receipt_path: path,
    created_at: nowIso(),
    updated_at: nowIso(),
  } as never);
  await db.receipts.put({
    path,
    blob: new Blob([bytes.slice().buffer as ArrayBuffer]),
    created_at: nowIso(),
  });
  return { id, path };
}

/* ------------------------------------------------------------------ *
 * Archive building & restoring
 * ------------------------------------------------------------------ */

describe("buildFullBackup()", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.receipts.clear();
  });

  it("packs the manifest and the receipt photo bytes into one archive", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { path } = await seedExpenseWithReceipt(bytes);

    const result = await buildFullBackup("Windows");
    expect(result.missingFiles).toEqual([]);
    expect(result.backup.device_label).toBe("Windows");
    expect(result.backup.files.map((f) => f.path)).toEqual([path]);

    const zip = await JSZip.loadAsync(result.bytes);
    expect(zip.files[MANIFEST_NAME]).toBeTruthy();
    const stored = await zip.files[path]!.async("uint8array");
    expect(Array.from(stored)).toEqual(Array.from(bytes));

    // Row metadata travels, photo Blobs never do.
    const manifest = parseFullBackupManifest(await zip.files[MANIFEST_NAME]!.async("string"));
    expect(manifest.tables["expenses"]).toHaveLength(1);
    expect(JSON.stringify(manifest.tables["receipts"])).not.toContain("blob");
  });

  it("reports a photo the expense claims but the device doesn't have, without failing", async () => {
    const id = newId();
    await db.expenses.add({
      id,
      expense_no: "TX-20260904-0002",
      business: "Turf",
      category: "Maintenance",
      description: "Paint",
      note: null,
      amount: 100,
      spent_at: "2026-09-04",
      receipt_path: `Receipts/2026-09-04/${id}.jpg`,
      created_at: nowIso(),
      updated_at: nowIso(),
    } as never);

    const result = await buildFullBackup("Android");
    expect(result.missingFiles).toEqual([`Receipts/2026-09-04/${id}.jpg`]);
    expect(result.backup.files).toEqual([]);
  });
});

describe("restoreFullBackup()", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.receipts.clear();
  });

  it("round-trips rows and photos back onto an empty device", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const { path } = await seedExpenseWithReceipt(bytes);
    const archive = (await buildFullBackup("Windows")).bytes;

    await db.expenses.clear();
    await db.receipts.clear();

    const result = await restoreFullBackup(archive, "replace");
    expect(result.rowsRestored).toBeGreaterThan(0);
    expect(result.filesRestored).toBe(1);
    expect(result.filesCorrupted).toEqual([]);
    const restored = await db.receipts.get(path);
    expect(new Uint8Array(await restored!.blob.arrayBuffer())).toEqual(bytes);
  });

  it("never overwrites a photo already on the device", async () => {
    await seedExpenseWithReceipt(new Uint8Array([1, 1, 1]));
    const archive = (await buildFullBackup("Windows")).bytes;

    const result = await restoreFullBackup(archive, "merge");
    expect(result.filesRestored).toBe(0);
    expect(result.filesSkippedExisting).toBe(1);
  });

  it("refuses to write bytes that fail the manifest checksum", async () => {
    const { path } = await seedExpenseWithReceipt(new Uint8Array([4, 4, 4]));
    const built = await buildFullBackup("Windows");

    // Tamper with the photo bytes while keeping the manifest's checksum.
    const zip = await JSZip.loadAsync(built.bytes);
    zip.file(path, new Uint8Array([0, 0, 0, 0]));
    const tampered = await zip.generateAsync({ type: "uint8array" });

    await db.receipts.clear();
    const result = await restoreFullBackup(tampered, "merge");
    expect(result.filesCorrupted).toEqual([path]);
    expect(result.filesRestored).toBe(0);
    expect(await db.receipts.get(path)).toBeUndefined();
  });

  it("rejects an archive with no manifest", async () => {
    const zip = new JSZip();
    zip.file("Receipts/2026-09-04/x.jpg", new Uint8Array([1]));
    await expect(
      restoreFullBackup(await zip.generateAsync({ type: "uint8array" })),
    ).rejects.toThrow(/manifest/i);
  });
});

describe("fullBackupSummary() / restoreSummary()", () => {
  it("counts records and photos in plain words", () => {
    expect(
      fullBackupSummary({
        format: "turf-snack-ledger-full",
        version: 1,
        created_at: nowIso(),
        device_label: "Windows",
        tables: {},
        files: [{ path: "Receipts/a.jpg", expense_id: "e1", sha256: "x" }],
      }),
    ).toContain("1 receipt photo");

    expect(
      restoreSummary({
        rowsRestored: 2,
        filesRestored: 1,
        filesSkippedExisting: 3,
        filesCorrupted: [],
        filesSkippedUnmatched: 0,
      }),
    ).toContain("2 records");
  });
});

/* ------------------------------------------------------------------ *
 * Chunk math, naming and grouping
 * ------------------------------------------------------------------ */

describe("chunk math", () => {
  it("counts parts against the 19 MB limit", () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(10)).toBe(1);
    expect(chunkCount(CHUNK_BYTES)).toBe(1);
    expect(chunkCount(CHUNK_BYTES + 1)).toBe(2);
    expect(chunkCount(CHUNK_BYTES * 3)).toBe(3);
  });

  it("splits and rejoins to exactly the original bytes", () => {
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const parts = splitIntoChunks(bytes, 300);
    expect(parts.map((p) => p.length)).toEqual([300, 300, 300, 100]);
    expect(joinChunks(parts)).toEqual(bytes);
  });

  it("leaves a small payload as a single part", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(splitIntoChunks(bytes)).toHaveLength(1);
  });
});

describe("chunk names and captions", () => {
  it("omits the part suffix for a single-part backup and round-trips", () => {
    const name = chunkFileName("2026-09-07T10-00-00-000Z", 1, 1);
    expect(name).toBe(`${BACKUP_NAME_PREFIX}-2026-09-07T10-00-00-000Z.zip`);
    expect(parseChunkName(name)).toEqual({
      session: "2026-09-07T10-00-00-000Z",
      part: 1,
      total: 1,
    });
  });

  it("round-trips a multi-part name", () => {
    const name = chunkFileName("S1", 2, 3);
    expect(name).toBe(`${BACKUP_NAME_PREFIX}-S1.zip.part2of3`);
    expect(parseChunkName(name)).toEqual({ session: "S1", part: 2, total: 3 });
  });

  it("ignores files that aren't backup parts", () => {
    expect(parseChunkName("holiday.jpg")).toBeNull();
    expect(parseChunkName("notes.zip")).toBeNull();
  });

  it("names the device and the part in the caption", () => {
    expect(chunkCaption("S1", 2, 3, "Windows")).toBe(
      `${BACKUP_NAME_PREFIX} S1 from Windows part 2/3`,
    );
    expect(chunkCaption("S1", 1, 1, "")).toBe(`${BACKUP_NAME_PREFIX} S1`);
  });
});

describe("latestCompleteGroup()", () => {
  const chunk = (fileName: string, fileId = fileName) => ({ fileName, fileId });

  it("returns the newest complete session, in part order, whatever order they arrived", () => {
    const group = latestCompleteGroup([
      chunk(`${BACKUP_NAME_PREFIX}-2026-09-01.zip.part2of2`),
      chunk(`${BACKUP_NAME_PREFIX}-2026-09-01.zip.part1of2`),
      chunk(`${BACKUP_NAME_PREFIX}-2026-09-05.zip.part2of2`),
      chunk(`${BACKUP_NAME_PREFIX}-2026-09-05.zip.part1of2`),
    ]);
    expect(group?.session).toBe("2026-09-05");
    expect(group?.chunks.map((c) => parseChunkName(c.fileName)?.part)).toEqual([1, 2]);
  });

  it("skips a half-uploaded session and falls back to the last complete one", () => {
    const group = latestCompleteGroup([
      chunk(`${BACKUP_NAME_PREFIX}-2026-09-01.zip`),
      chunk(`${BACKUP_NAME_PREFIX}-2026-09-09.zip.part1of3`),
    ]);
    expect(group?.session).toBe("2026-09-01");
  });

  it("de-dupes a part that was retried into the chat twice", () => {
    const group = latestCompleteGroup([
      chunk(`${BACKUP_NAME_PREFIX}-S.zip.part1of2`),
      chunk(`${BACKUP_NAME_PREFIX}-S.zip.part1of2`),
      chunk(`${BACKUP_NAME_PREFIX}-S.zip.part2of2`),
    ]);
    expect(group?.chunks).toHaveLength(2);
  });

  it("returns nothing when no session is complete", () => {
    expect(latestCompleteGroup([chunk(`${BACKUP_NAME_PREFIX}-S.zip.part1of2`)])).toBeNull();
  });
});

describe("chunksFromUpdates()", () => {
  it("keeps only backup documents from the configured chat", () => {
    const found = chunksFromUpdates(
      [
        {
          message: {
            chat: { id: -100123 },
            message_id: 7,
            document: { file_id: "f1", file_name: `${BACKUP_NAME_PREFIX}-S.zip` },
          },
        },
        {
          message: {
            chat: { id: -999 },
            message_id: 8,
            document: { file_id: "f2", file_name: `${BACKUP_NAME_PREFIX}-S.zip` },
          },
        },
        {
          channel_post: {
            chat: { id: "-100123" },
            message_id: 9,
            document: { file_id: "f3", file_name: "cat.jpg" },
          },
        },
      ],
      "-100123",
    );
    expect(found).toEqual([
      { fileName: `${BACKUP_NAME_PREFIX}-S.zip`, fileId: "f1", messageId: 7 },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Config, pairing, multi-bot, rate limits
 * ------------------------------------------------------------------ */

describe("QR pairing", () => {
  it("round-trips credentials", () => {
    const payload = decodePairingPayload(
      encodePairingPayload(cfg({ extraBotTokens: ["bot-2"] })),
    );
    expect(payload).toEqual({ botToken: "bot-1", chatId: "-100123", extraBotTokens: ["bot-2"] });
  });

  it("explains a QR code that isn't a setup code", () => {
    expect(() => decodePairingPayload("hello")).toThrow(/setup code/i);
    expect(() => decodePairingPayload(JSON.stringify({ botToken: "x" }))).toThrow(/chat ID/i);
  });
});

describe("botTokenForChunk()", () => {
  it("round-robins across the configured bots", () => {
    const c = cfg({ extraBotTokens: ["bot-2", "bot-3"] });
    expect([0, 1, 2, 3].map((i) => botTokenForChunk(c, i))).toEqual([
      "bot-1",
      "bot-2",
      "bot-3",
      "bot-1",
    ]);
  });

  it("uses the single bot when there are no extras", () => {
    expect(botTokenForChunk(cfg(), 5)).toBe("bot-1");
  });
});

describe("retryAfterMs()", () => {
  it("obeys Telegram's own retry_after", () => {
    expect(retryAfterMs({ parameters: { retry_after: 7 } }, 1)).toBe(7000);
  });

  it("backs off exponentially, capped, when Telegram says nothing", () => {
    expect(retryAfterMs(null, 1)).toBe(3000);
    expect(retryAfterMs(null, 2)).toBe(6000);
    expect(retryAfterMs({}, 99)).toBe(60_000);
  });
});

describe("telegramErrorMessage()", () => {
  it("turns Telegram's codes into something actionable", () => {
    expect(telegramErrorMessage(401, null)).toMatch(/bot token/i);
    expect(telegramErrorMessage(403, null)).toMatch(/admin/i);
    expect(telegramErrorMessage(400, { description: "Bad Request: chat not found" })).toMatch(
      /chat ID/i,
    );
    expect(telegramErrorMessage(500, { description: "boom" })).toMatch(/boom/);
  });
});

/* ------------------------------------------------------------------ *
 * Network: upload, 429 retry, download
 * ------------------------------------------------------------------ */

describe("uploadFullBackup()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const ok = (messageId: number) =>
    new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });

  it("sends every part with the same session id and reports progress", async () => {
    const calls: string[] = [];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(url);
        const form = init.body as FormData;
        calls.push(String((form.get("document") as File).name));
        return ok(++n);
      }),
    );

    const progress: number[] = [];
    const result = await uploadFullBackup(cfg(), new Uint8Array(700), {
      session: "S",
      deviceLabel: "Windows",
      onProgress: (p) => progress.push(p.part),
    });

    expect(result).toEqual({ session: "S", parts: 1, messageIds: [1] });
    expect(progress).toEqual([1]);
    expect(calls[0]).toContain("/botbot-1/sendDocument");
    expect(calls[1]).toBe(`${BACKUP_NAME_PREFIX}-S.zip`);
  });

  it("waits out a 429 using Telegram's retry_after and then succeeds", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt++;
      if (attempt === 1)
        return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), {
          status: 429,
        });
      return ok(42);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = uploadFullBackup(cfg(), new Uint8Array(10), { session: "S" });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.messageIds).toEqual([42]);
  });

  it("stops with a readable message when the token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 401 })),
    );
    await expect(
      uploadFullBackup(cfg(), new Uint8Array(10), { session: "S" }),
    ).rejects.toThrow(/bot token/i);
  });

  it("refuses to upload before setup is finished", async () => {
    await expect(
      uploadFullBackup(cfg({ botToken: "" }), new Uint8Array(10)),
    ).rejects.toThrow(/before backing up/i);
  });
});

describe("downloadChunk()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves the file path, then fetches the bytes", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes("getFile"))
          return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/a.zip" } }), {
            status: 200,
          });
        return new Response(new Uint8Array([5, 6, 7]));
      }),
    );

    expect(Array.from(await downloadChunk("bot-1", "fid"))).toEqual([5, 6, 7]);
    expect(urls[1]).toContain("/file/botbot-1/documents/a.zip");
  });

  it("says so when Telegram won't hand back a download path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
    );
    await expect(downloadChunk("bot-1", "fid")).rejects.toThrow(/download path/i);
  });
});
