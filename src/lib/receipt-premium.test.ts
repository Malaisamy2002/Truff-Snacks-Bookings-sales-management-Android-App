import { describe, expect, it, vi } from "vitest";

import { buildPremiumReceiptPdf } from "./receipt-premium";
import { DEFAULT_PRINT_SETTINGS, type PaperId, type PrintSettings } from "./print";
import type { ReceiptDoc } from "./receipt";

/**
 * jsPDF assigns methods as own instance properties, not on the prototype —
 * see the identical mock in receipt-layout.test.ts / report-pdf.test.ts.
 * Here it's used to confirm the UPI app-chip row this patch adds is
 * actually drawn (via roundedRect fills for the chip backgrounds and text
 * calls for the app names), not just that the PDF builds without throwing.
 */
type RectCall = { x: number; y: number; w: number; h: number; style: string };
let rectCapture: RectCall[] | null = null;
let textCapture: string[] | null = null;

vi.mock("jspdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jspdf")>();
  function PatchedJsPDF(this: unknown, ...args: ConstructorParameters<typeof actual.jsPDF>) {
    const instance = new actual.jsPDF(...args);
    const originalRoundedRect = instance.roundedRect.bind(instance);
    instance.roundedRect = (
      x: number,
      y: number,
      w: number,
      h: number,
      rx: number,
      ry: number,
      style: string,
    ) => {
      if (rectCapture) rectCapture.push({ x, y, w, h, style });
      return originalRoundedRect(x, y, w, h, rx, ry, style);
    };
    const originalText = instance.text.bind(instance);
    instance.text = (
      text: string | string[],
      x: number,
      y: number,
      options?: import("jspdf").TextOptions,
    ) => {
      if (textCapture && typeof text === "string") textCapture.push(text);
      return originalText(text, x, y, options);
    };
    return instance;
  }
  return { ...actual, jsPDF: PatchedJsPDF };
});

const SAMPLE_DOC: ReceiptDoc = {
  kind: "Sample",
  docNo: "TEST-001",
  dateText: "01/01/2026",
  customer: "Test Customer",
  phone: "9876543210",
  lines: [
    { label: "Turf slot", sub: "1 hr x Rs 1,200", amount: 1200 },
    { label: "Tea", sub: "2 x Rs 15", amount: 30 },
  ],
  totals: [{ label: "TOTAL", value: "Rs 1,230", strong: true }],
  fileName: "print-test",
};

function settingsFor(paper: PaperId, extra: Partial<PrintSettings> = {}): PrintSettings {
  return { ...DEFAULT_PRINT_SETTINGS, paper, templateStyle: "premium", ...extra };
}

describe("buildPremiumReceiptPdf — paper dispatch", () => {
  it.each<PaperId>(["a4", "a5", "80mm", "58mm", "50mm"])(
    "returns a PDF for %s, which has a dedicated premium layout",
    (paper) => {
      expect(buildPremiumReceiptPdf(SAMPLE_DOC, settingsFor(paper))).not.toBeNull();
    },
  );

  it.each<PaperId>(["letter", "76mm", "custom"])(
    "returns null for %s, which falls back to the classic renderer",
    (paper) => {
      expect(buildPremiumReceiptPdf(SAMPLE_DOC, settingsFor(paper))).toBeNull();
    },
  );
});

describe("buildPremiumReceiptPdf — UPI Scan & Pay box", () => {
  it("draws nothing extra when no UPI ID is configured", () => {
    textCapture = [];
    buildPremiumReceiptPdf(SAMPLE_DOC, settingsFor("a4", { upiId: "" }));
    expect(textCapture.some((t) => t.includes("UPI ID"))).toBe(false);
    textCapture = null;
  });

  it("draws the default GPay + PhonePe chip row under the QR on A4", () => {
    textCapture = [];
    buildPremiumReceiptPdf(SAMPLE_DOC, settingsFor("a4", { upiId: "shop@upi" }));
    expect(textCapture).toContain("GPay");
    expect(textCapture).toContain("PhonePe");
    textCapture = null;
  });

  it("respects a custom upiApps selection, including on the narrow 80mm layout", () => {
    textCapture = [];
    buildPremiumReceiptPdf(
      SAMPLE_DOC,
      settingsFor("80mm", { upiId: "shop@upi", upiApps: ["paytm", "bhim"] }),
    );
    expect(textCapture).toContain("Paytm");
    expect(textCapture).toContain("BHIM");
    expect(textCapture).not.toContain("GPay");
    textCapture = null;
  });

  it("falls back to the GPay + PhonePe default when upiApps is empty/corrupted", () => {
    textCapture = [];
    buildPremiumReceiptPdf(
      SAMPLE_DOC,
      settingsFor("a5", { upiId: "shop@upi", upiApps: [] as unknown as PrintSettings["upiApps"] }),
    );
    expect(textCapture).toContain("GPay");
    expect(textCapture).toContain("PhonePe");
    textCapture = null;
  });

  it("fills the chip row (not outlined) on the always-colour A4/A5 layout", () => {
    rectCapture = [];
    // A4/A5 are always full colour regardless of thermalColorMode — see
    // renderBoxed()'s wantColor = wide || thermalColorMode === "color".
    buildPremiumReceiptPdf(
      SAMPLE_DOC,
      settingsFor("a4", { upiId: "shop@upi", thermalColorMode: "bw" }),
    );
    // Chip rects are short (h = chipFont * 0.5, a few mm) — the payment
    // box and QR-tile rects drawn alongside them are much taller, so this
    // isolates the chip row specifically rather than any roundedRect call.
    const chipRects = rectCapture.filter((r) => r.h < 10);
    expect(chipRects.length).toBeGreaterThan(0);
    expect(chipRects.every((r) => r.style === "F")).toBe(true);
    rectCapture = null;
  });

  it("outlines the chip row (not filled) on a monochrome 80mm thermal", () => {
    rectCapture = [];
    buildPremiumReceiptPdf(
      SAMPLE_DOC,
      settingsFor("80mm", { upiId: "shop@upi", thermalColorMode: "bw" }),
    );
    const chipRects = rectCapture.filter((r) => r.h < 10);
    expect(chipRects.length).toBeGreaterThan(0);
    expect(chipRects.every((r) => r.style === "D")).toBe(true);
    rectCapture = null;
  });
});
