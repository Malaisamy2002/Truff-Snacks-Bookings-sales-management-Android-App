import type { jsPDF } from "jspdf";

/**
 * Shared UPI-app chip list, used by both the printed receipt's "Scan & Pay"
 * box (receipt-premium.ts) and the in-app "Pay via UPI" button
 * (BillActions.tsx), so the two can never drift apart on which apps exist
 * or what their ids/colors are.
 *
 * Ported from the Windows build's `receipt-upi.ts`. This file intentionally
 * only carries the app list, the shop-editable selection, the plain
 * `upi://pay` link builder, and the chip-row drawer — not the full
 * boxed "Scan & Pay" panel system Windows uses, since this project's
 * premium layouts already draw their own QR box inline and just needed the
 * missing chip row underneath it (see receipt-premium.ts).
 */

export const UPI_APPS = [
  { id: "gpay", name: "GPay", color: [66, 133, 244] as RGB },
  { id: "phonepe", name: "PhonePe", color: [95, 37, 159] as RGB },
  { id: "paytm", name: "Paytm", color: [0, 150, 214] as RGB },
  { id: "bhim", name: "BHIM", color: [242, 101, 34] as RGB },
] as const;

export type UpiAppId = (typeof UPI_APPS)[number]["id"];
export const UPI_APP_IDS: UpiAppId[] = UPI_APPS.map((a) => a.id);

/** Shown on a receipt when the shop hasn't picked a custom set — the two
 * apps almost every customer in India already has installed. */
export const DEFAULT_UPI_APPS: UpiAppId[] = ["gpay", "phonepe"];

export type RGB = [number, number, number];

/** Resolves saved app ids to their chip definitions, preserving the order
 * the shop picked and silently dropping anything unrecognised. Falls back
 * to the default pair when the resulting list would otherwise be empty
 * (nothing selected, or a corrupted/blank setting). */
export function resolveApps(ids: UpiAppId[] | undefined): (typeof UPI_APPS)[number][] {
  const wanted = ids && ids.length ? ids : DEFAULT_UPI_APPS;
  const resolved = wanted
    .map((id) => UPI_APPS.find((a) => a.id === id))
    .filter((a): a is (typeof UPI_APPS)[number] => !!a);
  return resolved.length ? resolved : UPI_APPS.filter((a) => DEFAULT_UPI_APPS.includes(a.id));
}

/** Plain (amount-less) UPI deep link, for the in-app "Pay via UPI" button —
 * the payer types the amount themselves. The printed QR in
 * receipt-premium.ts builds its own amount-prefilled link separately;
 * this one is only for BillActions.tsx. */
export function upiUri(opts: { upiId: string; payeeName?: string; note?: string }): string {
  const params = new URLSearchParams();
  params.set("pa", opts.upiId.trim());
  if (opts.payeeName?.trim()) params.set("pn", opts.payeeName.trim().slice(0, 50));
  params.set("cu", "INR");
  if (opts.note?.trim()) params.set("tn", opts.note.trim().slice(0, 50));
  return `upi://pay?${params.toString()}`;
}

/**
 * Row of small UPI-app chips (e.g. "GPay / PhonePe"), limited to whichever
 * apps the shop picked in Settings (default GPay + PhonePe). Colour fills on
 * paper that can print colour; on thermal black & white they become outlined
 * chips so they stay legible on a monochrome head. Returns the row height
 * consumed, so callers can advance their own cursor by it.
 */
export function drawAppStrip(
  pdf: jsPDF,
  apps: (typeof UPI_APPS)[number][],
  centerX: number,
  y: number,
  fontSize: number,
  mono: boolean,
): number {
  const padX = 1.2;
  const gap = 1.2;
  const h = fontSize * 0.5;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(fontSize);
  const total = apps.reduce((w, a) => w + pdf.getTextWidth(a.name) + padX * 2 + gap, -gap);
  let x = centerX - total / 2;
  for (const app of apps) {
    const w = pdf.getTextWidth(app.name) + padX * 2;
    if (mono) {
      pdf.setDrawColor(70, 70, 70);
      pdf.setLineWidth(0.15);
      pdf.roundedRect(x, y, w, h, 0.6, 0.6, "D");
      pdf.setTextColor(40, 40, 40);
    } else {
      pdf.setFillColor(...app.color);
      pdf.roundedRect(x, y, w, h, 0.6, 0.6, "F");
      pdf.setTextColor(255, 255, 255);
    }
    pdf.text(app.name, x + w / 2, y + h * 0.72, { align: "center" });
    x += w + gap;
  }
  return h;
}
