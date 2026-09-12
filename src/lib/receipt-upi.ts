import type { jsPDF } from "jspdf";
import { PAYMENT_BRAND_LOGOS, type PaymentBrandId } from "./payment-brand-assets";

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
  { id: "gpay", name: "Google Pay", color: [66, 133, 244] as RGB, brand: "gpay" },
  { id: "phonepe", name: "PhonePe", color: [95, 37, 159] as RGB, brand: "phonepe" },
  { id: "paytm", name: "Paytm", color: [0, 150, 214] as RGB, brand: "paytm" },
  { id: "bhim", name: "BHIM", color: [242, 101, 34] as RGB, brand: "bhim" },
] as const;

export type UpiAppId = (typeof UPI_APPS)[number]["id"];
export const UPI_APP_IDS: UpiAppId[] = UPI_APPS.map((a) => a.id);

/** Shown on a receipt when the shop hasn't picked a custom set — the two
 * apps almost every customer in India already has installed. */
export const DEFAULT_UPI_APPS: UpiAppId[] = ["gpay", "phonepe"];

export type RGB = [number, number, number];

/**
 * Official NPCI UPI mark — bold "UPI" wordmark followed by the saffron /
 * green tricolour arrow, matching the current npci.org.in logo: two
 * triangles (not three parallel stripes) leaning slightly right, split by
 * a thin gap. Drawn as vector shapes (no bitmap asset) so it prints crisp
 * at any size. `textColor` lets callers match their own header — navy on
 * the white "SCAN & PAY" cards this app uses.
 */
export function drawUpiMark(pdf: jsPDF, x: number, y: number, fontSize: number, textColor: RGB) {
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(fontSize);
  pdf.setTextColor(...textColor);
  pdf.text("UPI", x, y);
  const textW = pdf.getTextWidth("UPI");

  // Two-triangle arrow — saffron on top, green on bottom, each a
  // right-pointing wedge (vertical-ish outer edge, tip on the right) —
  // separated by a thin gap and leaned right at the outer corner, the way
  // the real mark's arrowhead is cut and tilted, rather than three upright
  // parallel stripes offset sideways.
  const gap = fontSize * 0.22;
  const arrowH = fontSize * 0.82;
  const arrowW = arrowH * 0.62;
  const ax = x + textW + gap;
  const topY = y - arrowH * 0.76;
  const botY = y + arrowH * 0.24;
  const midY = (topY + botY) / 2;
  const slit = arrowH * 0.09; // thin gap between the two triangles
  const lean = arrowW * 0.22; // rightward tilt of each triangle's outer corner

  pdf.setFillColor(255, 153, 51);
  pdf.triangle(ax + lean, topY, ax, midY - slit, ax + arrowW, (topY + midY - slit) / 2, "F");
  pdf.setFillColor(19, 136, 8);
  pdf.triangle(ax, midY + slit, ax + lean, botY, ax + arrowW, (midY + slit + botY) / 2, "F");

  return textW + gap + arrowW;
}

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

function appStripWidth(
  apps: (typeof UPI_APPS)[number][],
  logoH: number,
  padX: number,
  gap: number,
) {
  return apps.reduce(
    (w, a) => w + logoH * PAYMENT_BRAND_LOGOS[a.brand as PaymentBrandId].aspect + padX * 2 + gap,
    -gap,
  );
}

/** Packs chips onto as few rows as fit within `maxRowWidth`, greedily
 * adding to the current row and only starting a new one when the next chip
 * would overflow it — so 2-3 apps still sit on one line, and only a full
 * set of 4 (on a narrow enough card) wraps onto a second. */
function wrapAppRows(
  apps: (typeof UPI_APPS)[number][],
  logoH: number,
  padX: number,
  gap: number,
  maxRowWidth: number,
): (typeof UPI_APPS)[number][][] {
  const rows: (typeof UPI_APPS)[number][][] = [[]];
  for (const app of apps) {
    const row = rows[rows.length - 1] ?? [];
    const trial = [...row, app];
    if (row.length && appStripWidth(trial, logoH, padX, gap) > maxRowWidth) {
      rows.push([app]);
    } else {
      rows[rows.length - 1] = trial;
    }
  }
  return rows;
}

function appStripChipMetrics(fontSize: number, mono: boolean) {
  const padX = mono ? 0.8 : 1;
  const gap = 1.2;
  const rowGap = 1;
  const logoH = Math.max(2.8, fontSize * 0.62);
  const padY = 0.45;
  const rowH = logoH + padY * 2;
  return { padX, gap, rowGap, logoH, padY, rowH };
}

/** Height the app-chip strip will consume for a given width budget, without
 * drawing anything — lets callers reserve the right amount of vertical
 * space (the wide-layout overflow check, the narrow-slip cursor advance)
 * even when the shop's picked apps need to wrap onto a second row. */
export function estimateAppStripHeight(
  apps: (typeof UPI_APPS)[number][],
  fontSize: number,
  mono: boolean,
  maxRowWidth: number,
): number {
  const { padX, gap, rowGap, logoH, rowH } = appStripChipMetrics(fontSize, mono);
  const rows = wrapAppRows(apps, logoH, padX, gap, maxRowWidth);
  return rows.length * rowH + (rows.length - 1) * rowGap;
}

/**
 * Official payment wordmarks under the QR. They are embedded locally so the
 * invoice export remains offline and keeps the brand typography instead of
 * substituting a generic font.
 *
 * Wraps onto a second row — instead of running past the edge of the card,
 * which is what a 4-app selection used to do — whenever the full strip
 * doesn't fit the width budget in `bounds`. Each row is centred
 * independently and clamped inside `bounds`, so it stays on the card even
 * when `centerX` (usually the QR's centre) sits off to one side rather than
 * at the panel's true centre. Returns the total height consumed, so callers
 * can advance their cursor by it.
 */
export function drawAppStrip(
  pdf: jsPDF,
  apps: (typeof UPI_APPS)[number][],
  centerX: number,
  y: number,
  fontSize: number,
  mono: boolean,
  bounds?: { left: number; right: number },
): number {
  const { padX, gap, rowGap, logoH, padY, rowH } = appStripChipMetrics(fontSize, mono);
  const left = bounds?.left ?? -1e6;
  const right = bounds?.right ?? 1e6;
  const maxRowWidth = Math.max(logoH * 2, right - left);
  const rows = wrapAppRows(apps, logoH, padX, gap, maxRowWidth);

  let rowY = y;
  for (const row of rows) {
    const rowTotal = appStripWidth(row, logoH, padX, gap);
    let x = centerX - rowTotal / 2;
    x = Math.min(Math.max(x, left), right - rowTotal);
    for (const app of row) {
      const logo = PAYMENT_BRAND_LOGOS[app.brand as PaymentBrandId];
      const logoW = logoH * logo.aspect;
      const w = logoW + padX * 2;
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(mono ? 90 : 220, mono ? 90 : 222, mono ? 90 : 228);
      pdf.setLineWidth(0.15);
      pdf.roundedRect(x, rowY, w, rowH, 0.7, 0.7, "FD");
      pdf.addImage(logo.dataUrl, "PNG", x + padX, rowY + padY, logoW, logoH);
      x += w + gap;
    }
    rowY += rowH + rowGap;
  }
  return rowY - y - rowGap;
}
