import { describe, expect, it, vi } from "vitest";

import { buildPremiumReceiptPdf } from "./receipt-premium";
import { DEFAULT_PRINT_SETTINGS, type PaperId, type PrintSettings } from "./print";
import { PAYMENT_BRAND_LOGOS } from "./payment-brand-assets";
import type { ReceiptDoc } from "./receipt";

/**
 * jsPDF assigns methods as own instance properties, not on the prototype —
 * see the identical mock in receipt-layout.test.ts / report-pdf.test.ts.
 * Here it's used to confirm the embedded official wordmarks are actually
 * drawn, not just that the PDF builds without throwing.
 */
let textCapture: string[] | null = null;
let imageCapture: string[] | null = null;

vi.mock("jspdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jspdf")>();
  function PatchedJsPDF(this: unknown, ...args: ConstructorParameters<typeof actual.jsPDF>) {
    const instance = new actual.jsPDF(...args);
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
    const originalAddImage = instance.addImage.bind(instance);
    instance.addImage = ((...args: Parameters<typeof instance.addImage>) => {
      const [image] = args;
      if (
        imageCapture &&
        typeof image === "string" &&
        Object.values(PAYMENT_BRAND_LOGOS).some((logo) => logo.dataUrl === image)
      ) {
        imageCapture.push(image);
      }
      return originalAddImage(...args);
    }) as typeof instance.addImage;
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

  it("draws the default Google Pay + PhonePe wordmarks under the QR on A4", () => {
    imageCapture = [];
    buildPremiumReceiptPdf(SAMPLE_DOC, settingsFor("a4", { upiId: "shop@upi" }));
    expect(imageCapture).toEqual([
      PAYMENT_BRAND_LOGOS.gpay.dataUrl,
      PAYMENT_BRAND_LOGOS.phonepe.dataUrl,
    ]);
    imageCapture = null;
  });

  it("respects a custom upiApps selection, including on the narrow 80mm layout", () => {
    imageCapture = [];
    buildPremiumReceiptPdf(
      SAMPLE_DOC,
      settingsFor("80mm", { upiId: "shop@upi", upiApps: ["paytm", "bhim"] }),
    );
    expect(imageCapture).toEqual([
      PAYMENT_BRAND_LOGOS.paytm.dataUrl,
      PAYMENT_BRAND_LOGOS.bhim.dataUrl,
      PAYMENT_BRAND_LOGOS.paytm.dataUrl,
      PAYMENT_BRAND_LOGOS.bhim.dataUrl,
    ]);
    imageCapture = null;
  });

  it("falls back to the Google Pay + PhonePe wordmarks when upiApps is empty/corrupted", () => {
    imageCapture = [];
    buildPremiumReceiptPdf(
      SAMPLE_DOC,
      settingsFor("a5", { upiId: "shop@upi", upiApps: [] as unknown as PrintSettings["upiApps"] }),
    );
    expect(imageCapture).toEqual([
      PAYMENT_BRAND_LOGOS.gpay.dataUrl,
      PAYMENT_BRAND_LOGOS.phonepe.dataUrl,
    ]);
    imageCapture = null;
  });

  it("keeps the supplied wordmarks visible on the always-colour A4/A5 layout", () => {
    imageCapture = [];
    // A4/A5 are always full colour regardless of thermalColorMode — see
    // renderBoxed()'s wantColor = wide || thermalColorMode === "color".
    buildPremiumReceiptPdf(
      SAMPLE_DOC,
      settingsFor("a4", { upiId: "shop@upi", thermalColorMode: "bw" }),
    );
    expect(imageCapture).toHaveLength(2);
    imageCapture = null;
  });

  it("keeps the supplied wordmarks visible on a monochrome 80mm thermal", () => {
    imageCapture = [];
    buildPremiumReceiptPdf(
      SAMPLE_DOC,
      settingsFor("80mm", { upiId: "shop@upi", thermalColorMode: "bw" }),
    );
    // 80mm is measured once on a scratch page and then rendered again at
    // the measured height, so the row is drawn twice during one export.
    expect(imageCapture).toHaveLength(4);
    imageCapture = null;
  });
});
