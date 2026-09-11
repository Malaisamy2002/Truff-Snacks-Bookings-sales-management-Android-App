import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import { rupees } from "./money";
import type { ReceiptDoc } from "./receipt";
import { paperInfo, paperWidthMm, type PrintSettings } from "./print";

/**
 * "Premium" receipt/invoice templates — the boxed, two-tone, letterhead-style
 * layouts (as opposed to the plain ruled-line "classic" layout in receipt.ts).
 * Covers 5 of the reference formats: A4 (full letterhead), A5 (compact single
 * column), 80mm thermal in color, 80mm thermal in black & white, and a
 * condensed 58mm POS slip. Letter/76mm/custom-width paper falls back to the
 * classic renderer (returns null here) since there's no dedicated layout for
 * them yet.
 *
 * Kept in its own file (rather than folded into receipt.ts's renderBody) so
 * the two rendering styles don't share mutable state or drawing helpers —
 * each is a complete, from-scratch pass over the same ReceiptDoc/PrintSettings
 * inputs the classic renderer uses.
 */

const NAVY: [number, number, number] = [24, 40, 79];
const GOLD: [number, number, number] = [199, 161, 60];
const LIGHT_FILL: [number, number, number] = [242, 244, 248];
const GREEN: [number, number, number] = [30, 130, 76];
const RED: [number, number, number] = [190, 40, 40];
const RULE: [number, number, number] = [205, 208, 214];

const imgFormat = (dataUrl: string): "PNG" | "JPEG" =>
  dataUrl.startsWith("data:image/jpeg") ? "JPEG" : "PNG";

const pmoney = (n: number, symbol: string) => {
  const v = rupees(n);
  const sym = (symbol || "Rs").trim();
  const prefix = sym ? `${sym} ` : "";
  return (v < 0 ? "-" : "") + prefix + Math.abs(v).toLocaleString("en-IN");
};

/** Builds the dark/light module grid for a QR code synchronously (no canvas
 * or async image decode needed), so it can be drawn as plain jsPDF rects —
 * same drawing pipeline as everything else on the receipt, and crisp at any
 * size since it's vector, not a rasterized PNG. */
function qrGrid(text: string): boolean[][] | null {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const grid: boolean[][] = [];
    for (let r = 0; r < size; r++) {
      const row: boolean[] = [];
      for (let c = 0; c < size; c++) row.push(!!qr.modules.get(r, c));
      grid.push(row);
    }
    return grid;
  } catch {
    return null;
  }
}

function drawQr(
  pdf: jsPDF,
  x: number,
  y: number,
  sizeMm: number,
  text: string,
  dark: [number, number, number] = [0, 0, 0],
) {
  const grid = qrGrid(text);
  if (!grid) return;
  const n = grid.length;
  const mod = sizeMm / n;
  pdf.setFillColor(255, 255, 255);
  pdf.rect(x, y, sizeMm, sizeMm, "F");
  pdf.setFillColor(...dark);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c]) pdf.rect(x + c * mod, y + r * mod, mod + 0.02, mod + 0.02, "F");
    }
  }
}

/** UPI deep-link payload for the "Scan & Pay" QR — the standard `upi://pay`
 * URI every UPI app (GPay/PhonePe/Paytm/BHIM) recognises. Amount/note are
 * only included when known so a blank/partial bill still yields a scannable
 * (if less prefilled) code. */
function upiUri(upiId: string, payeeName: string, amount: number | null, note: string) {
  const params = new URLSearchParams();
  params.set("pa", upiId);
  if (payeeName) params.set("pn", payeeName);
  params.set("cu", "INR");
  if (amount !== null && amount > 0) params.set("am", String(rupees(amount)));
  if (note) params.set("tn", note.slice(0, 40));
  return `upi://pay?${params.toString()}`;
}

/** Entry point. Returns null when the current paper has no premium layout
 * (caller falls back to the classic renderer). */
export function buildPremiumReceiptPdf(doc: ReceiptDoc, s: PrintSettings): jsPDF | null {
  const paper = paperInfo(s.paper);
  if (paper.id === "a4") return renderBoxed(doc, s, "a4");
  if (paper.id === "a5") return renderBoxed(doc, s, "a5");
  if (paper.id === "80mm") return renderBoxed(doc, s, "roll");
  if (paper.id === "58mm" || paper.id === "50mm") return renderCondensed(doc, s);
  return null;
}

/* ---------------------------------------------------------------------- */
/* A4 / A5 / 80mm-roll boxed layout                                        */
/* ---------------------------------------------------------------------- */

/** "roll" here always means 80mm — the one roll width the boxed layout is
 * designed for (58/50mm goes to the condensed layout instead; it's too
 * narrow for two-column cards). A4/A5 are always full color (`wide` below);
 * the 80mm roll's color vs. black-and-white treatment is the explicit
 * `s.thermalColorMode` setting — real thermal rolls are monochrome hardware,
 * so it defaults to "bw", with "color" available for an actual color
 * receipt printer or a screen/WhatsApp copy. */
function renderBoxed(doc: ReceiptDoc, s: PrintSettings, kind: "a4" | "a5" | "roll"): jsPDF {
  const wide = kind === "a4" || kind === "a5";
  const width = wide ? paperInfo(s.paper).widthMm : paperWidthMm(s);
  const scale = s.fontScale || 1;
  const sym = s.currencySymbol;
  const wantColor = wide || s.thermalColorMode === "color";
  const navy = wantColor ? NAVY : ([40, 40, 40] as [number, number, number]);
  const gold = wantColor ? GOLD : ([90, 90, 90] as [number, number, number]);
  const fill = wantColor ? LIGHT_FILL : ([238, 238, 238] as [number, number, number]);
  const green = wantColor ? GREEN : ([50, 50, 50] as [number, number, number]);
  const red = wantColor ? RED : ([70, 70, 70] as [number, number, number]);

  const marginX = wide ? (kind === "a4" ? 14 : 10) : 5;
  const contentW = width - marginX * 2;
  const money = (v: number) => pmoney(v, sym);

  const renderBody = (pdf: jsPDF, pageH: number): number => {
    let y = 0;
    const headerFont = wide ? (kind === "a4" ? 20 : 15) : 11;
    const bodyFont = wide ? (kind === "a4" ? 10 : 8.5) : 7.5;
    const smallFont = wide ? (kind === "a4" ? 8 : 7) : 6;

    // Header band. Base height for a single-line shop name; grows below if
    // the name wraps, so the header line / doc-kind title never land on top
    // of a wrapped second line (previously they were drawn at a fixed
    // offset that assumed the shop name was always one line).
    const baseHeaderH = wide ? (kind === "a4" ? 34 : 26) : 22;

    const logo = s.logo;
    const logoH = baseHeaderH - (wide ? 12 : 8);
    let textLeftX = marginX;
    if (s.showLogo && logo) {
      const logoW = logoH * (logo.width / logo.height);
      textLeftX = marginX + logoW + (wide ? 5 : 3);
    }

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(headerFont * scale);
    const shopName = (s.shopName || "Receipt").toUpperCase();
    // Wide layouts (A4/A5) have vertical room to wrap the shop name onto a
    // second line; the roll header doesn't, so it stays single-line there
    // (long names get clipped by jsPDF's maxWidth as before).
    let nameLines = wide ? (pdf.splitTextToSize(shopName, contentW * 0.6) as string[]) : [shopName];
    if (nameLines.length > 2) {
      nameLines = nameLines.slice(0, 2);
      nameLines[1] = `${nameLines[1].replace(/\s+\S*$/, "")}…`;
    }
    const nameLineH = headerFont * scale * 0.42; // mm per line at this font size
    const headerH = baseHeaderH + (nameLines.length - 1) * nameLineH;

    pdf.setFillColor(...navy);
    pdf.rect(0, 0, width, headerH, "F");
    pdf.setFillColor(...gold);
    pdf.rect(0, headerH - 1.6, width, 1.6, "F");
    if (s.showLogo && logo) {
      const logoW = logoH * (logo.width / logo.height);
      pdf.addImage(logo.dataUrl, imgFormat(logo.dataUrl), marginX, (headerH - logoH) / 2, logoW, logoH);
    }

    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(headerFont * scale);
    const nameBlockH = nameLines.length * nameLineH;
    let nameY = (headerH - nameBlockH) / 2 + nameLineH * 0.75;
    for (const line of nameLines) {
      pdf.text(line, textLeftX, nameY);
      nameY += nameLineH;
    }
    if (s.headerLine) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(smallFont * scale);
      pdf.text(s.headerLine, textLeftX, nameY + (wide ? 1 : 0.5));
    }
    // Doc-kind title, right-aligned in the header (wide layouts only — no
    // room for it on an 80mm roll header without crowding the shop name).
    if (wide) {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize((kind === "a4" ? 22 : 16) * scale);
      pdf.text(doc.kind.toUpperCase(), width - marginX, headerH / 2 + 2, { align: "right" });
    }
    y = headerH + (wide ? 8 : 5);

    // Status badge (PAID / UNPAID / PARTIAL / etc.) — pulled from the last
    // totals row whose label is exactly "Status", same source classic uses.
    const statusRow = doc.totals.find((t) => t.label === "Status");
    const statusVal = (statusRow?.value || "").toUpperCase();
    const statusColor: [number, number, number] =
      statusVal === "PAID" ? green : statusVal === "UNPAID" ? red : gold;

    // Doc-info strip (on narrow roll, since there's no header title row).
    if (!wide) {
      pdf.setTextColor(30, 30, 30);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11 * scale);
      pdf.text(`${doc.kind.toUpperCase()} · ${doc.docNo}`, marginX, y);
      if (statusVal) {
        pdf.setFontSize(7 * scale);
        const w = pdf.getTextWidth(statusVal) + 4;
        pdf.setFillColor(...statusColor);
        pdf.roundedRect(width - marginX - w, y - 3.6, w, 5, 1, 1, "F");
        pdf.setTextColor(255, 255, 255);
        pdf.text(statusVal, width - marginX - w / 2, y - 0.2, { align: "center" });
      }
      y += 5;
      pdf.setDrawColor(...RULE);
      pdf.setLineDashPattern([1, 1], 0);
      pdf.line(marginX, y, width - marginX, y);
      pdf.setLineDashPattern([], 0);
      y += 4;
    }

    // Two boxed info cards: Bill To / Booking details. On the roll, these
    // stack instead of sitting side by side — no room for two columns.
    const cardGap = wide ? 4 : 0;
    const cardW = wide ? (contentW - cardGap) / 2 : contentW;
    // Takes its top-left corner explicitly (cardY) rather than reading the
    // enclosing `y` from closure — wide layouts place both cards at the SAME
    // y (side by side), but the narrow roll stacks them (one below the
    // other), so the caller needs to pass a different y for the second card
    // in that case. Reading `y` implicitly here previously drew both narrow
    // cards on top of each other at an identical position.
    const drawCard = (
      cardX: number,
      cardY: number,
      title: string,
      rows: { label: string; value: string }[],
    ): number => {
      const rowH = (wide ? 5.5 : 4.4) * scale;
      const pad = 3;
      const h = pad * 2 + rowH * rows.length + 5;
      pdf.setFillColor(...fill);
      pdf.setDrawColor(...RULE);
      pdf.roundedRect(cardX, cardY, cardW, h, 1.5, 1.5, "FD");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize((wide ? 8 : 6.5) * scale);
      pdf.setTextColor(...navy);
      pdf.text(title.toUpperCase(), cardX + pad, cardY + pad + 2);
      let ry = cardY + pad + 2 + rowH;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(bodyFont * scale);
      pdf.setTextColor(40, 40, 40);
      for (const row of rows) {
        pdf.setFont("helvetica", "bold");
        pdf.text(row.label, cardX + pad, ry);
        pdf.setFont("helvetica", "normal");
        const labelW = pdf.getTextWidth(row.label);
        pdf.text(`: ${row.value}`, cardX + pad + labelW, ry);
        ry += rowH;
      }
      return h;
    };

    const billRows = [
      ...(doc.customer ? [{ label: "Name", value: doc.customer }] : []),
      ...(doc.phone && s.showPhone ? [{ label: "Phone", value: doc.phone }] : []),
      ...(doc.email ? [{ label: "Email", value: doc.email }] : []),
    ];
    const infoRows = [
      { label: "Date", value: doc.dateText },
      { label: `${doc.kind} No.`, value: doc.docNo },
      ...(statusVal && wide ? [{ label: "Status", value: statusVal }] : []),
    ];

    if (billRows.length || infoRows.length) {
      const h1 = billRows.length ? drawCard(marginX, y, "Bill To", billRows) : 0;
      const secondX = wide ? marginX + cardW + cardGap : marginX;
      const secondY = wide ? y : y + h1 + (h1 ? 3 : 0);
      const h2 = infoRows.length ? drawCard(secondX, secondY, wide ? "Details" : "", infoRows) : 0;
      y += wide ? Math.max(h1, h2) + 6 : h1 + (h1 ? 3 : 0) + h2 + 4;
    }

    // Item table — shaded navy header, zebra rows.
    const noColW = wide ? 8 : 6;
    const qtyColW = wide ? contentW * 0.14 : contentW * 0.18;
    const amtColW = wide ? contentW * 0.2 : contentW * 0.26;
    const labelColW = contentW - noColW - qtyColW - amtColW;
    const rowH = (wide ? 6.5 : 5) * scale;
    const headerBandH = (wide ? 7 : 5.5) * scale;

    pdf.setFillColor(...navy);
    pdf.rect(marginX, y, contentW, headerBandH, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize((wide ? 8.5 : 6.5) * scale);
    const midY = y + headerBandH / 2 + 1.2;
    // Narrow "roll" (80mm) paper needs the same short-form header the
    // classic (receipt.ts) and condensed (58/50mm) renderers already use —
    // the full word doesn't fit the shrunken column and used to bleed left
    // into the QTY header.
    const amountHeader = wide ? "AMOUNT" : "AMT";
    pdf.text("#", marginX + 2, midY);
    pdf.text("DESCRIPTION", marginX + noColW, midY);
    pdf.text("QTY", marginX + noColW + labelColW + qtyColW, midY, { align: "right" });
    pdf.text(amountHeader, width - marginX - 1, midY, { align: "right" });
    y += headerBandH;

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(bodyFont * scale);
    doc.lines.forEach((line, i) => {
      const labelLines = pdf.splitTextToSize(line.label, labelColW - 2) as string[];
      const nLines = Math.max(1, Math.min(2, labelLines.length)) + (line.sub ? 1 : 0);
      const bandH = rowH * Math.max(1, nLines * 0.72);
      if (i % 2 === 1) {
        pdf.setFillColor(...fill);
        pdf.rect(marginX, y, contentW, bandH, "F");
      }
      pdf.setTextColor(30, 30, 30);
      const ty = y + rowH * 0.62;
      pdf.setFont("helvetica", "normal");
      pdf.text(String(i + 1), marginX + 2, ty);
      pdf.text(labelLines[0] ?? "", marginX + noColW, ty);
      pdf.text(
        line.qty !== undefined ? String(line.qty) : "",
        marginX + noColW + labelColW + qtyColW,
        ty,
        { align: "right" },
      );
      pdf.text(money(line.amount ?? 0), width - marginX - 1, ty, { align: "right" });
      if (line.sub) {
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize((wide ? 7.5 : 6) * scale);
        pdf.setTextColor(110, 110, 110);
        pdf.text(line.sub, marginX + noColW, ty + rowH * 0.68);
        pdf.setFontSize(bodyFont * scale);
      }
      pdf.setDrawColor(...RULE);
      pdf.line(marginX, y + bandH, width - marginX, y + bandH);
      y += bandH;
    });
    y += wide ? 4 : 3;

    // Totals — right-aligned box, grand total picked out in the navy bar.
    const totalsW = wide ? contentW * 0.46 : contentW;
    const totalsX = width - marginX - totalsW;
    const grand = doc.totals.find((t) => t.strong);
    const otherTotals = doc.totals.filter((t) => t !== grand && t.label !== "Status");
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(bodyFont * scale);
    for (const t of otherTotals) {
      const isDiscount = t.value.trim().startsWith("-");
      pdf.setTextColor(isDiscount ? red[0] : 60, isDiscount ? red[1] : 60, isDiscount ? red[2] : 60);
      pdf.text(t.label, totalsX, y);
      pdf.text(t.value, width - marginX, y, { align: "right" });
      y += rowH * 0.8;
    }
    if (grand) {
      y += 1;
      const barH = (wide ? 9 : 7) * scale;
      pdf.setFillColor(...navy);
      pdf.rect(totalsX, y, totalsW, barH, "F");
      pdf.setTextColor(255, 255, 255);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize((wide ? 11 : 9) * scale);
      pdf.text(grand.label, totalsX + 3, y + barH / 2 + 1.4);
      pdf.text(grand.value, width - marginX - 3, y + barH / 2 + 1.4, { align: "right" });
      y += barH;
    }
    y += wide ? 6 : 5;

    // Payment / QR box — only when a UPI ID is configured.
    if (s.upiId.trim()) {
      const grandVal = grand ? Number(grand.value.replace(/[^0-9.-]/g, "")) : null;
      const qrSize = wide ? 24 : 18;
      const boxH = qrSize + (wide ? 6 : 4);
      const payW = wide ? contentW - qrSize - 8 : contentW;
      pdf.setFillColor(...fill);
      pdf.setDrawColor(...RULE);
      if (wide) {
        pdf.roundedRect(marginX, y, payW, boxH, 1.5, 1.5, "FD");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8 * scale);
        pdf.setTextColor(...navy);
        pdf.text("PAYMENT", marginX + 3, y + 6);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(bodyFont * scale);
        pdf.setTextColor(40, 40, 40);
        pdf.text(`UPI ID: ${s.upiId}`, marginX + 3, y + 12);
        if (statusVal) pdf.text(`Status: ${statusVal}`, marginX + 3, y + 18);
        pdf.roundedRect(marginX + payW + 4, y, qrSize + 4, boxH, 1.5, 1.5, "FD");
        drawQr(
          pdf,
          marginX + payW + 6,
          y + 2,
          qrSize,
          upiUri(s.upiId, s.shopName, grandVal, `${doc.kind} ${doc.docNo}`),
        );
      } else {
        const centerX = marginX + contentW / 2;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(7 * scale);
        pdf.setTextColor(...navy);
        pdf.text("SCAN & PAY", centerX, y + 3, { align: "center" });
        drawQr(
          pdf,
          centerX - qrSize / 2,
          y + 5,
          qrSize,
          upiUri(s.upiId, s.shopName, grandVal, `${doc.kind} ${doc.docNo}`),
        );
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(smallFont * scale);
        pdf.setTextColor(80, 80, 80);
        pdf.text(s.upiId, centerX, y + qrSize + 8, { align: "center" });
      }
      // Wide (A4/A5) draws a fixed-height boxed row, so its own height
      // (boxH) plus a gap is exactly how far y needs to move. The narrow
      // (80mm) layout instead stacks the QR above a caption line below it,
      // so its content runs to qrSize + 8 (the caption's baseline) — advance
      // past that plus the same gap, not past boxH (which undershoots here,
      // since boxH was sized for the wide box's shorter side-by-side row).
      y += wide ? boxH + 6 : qrSize + 8 + 6;
    }

    if (doc.note) {
      pdf.setFont("helvetica", "italic");
      pdf.setFontSize(smallFont * scale);
      pdf.setTextColor(90, 90, 90);
      const noteLines = pdf.splitTextToSize(`Note: ${doc.note}`, contentW) as string[];
      for (const line of noteLines) {
        pdf.text(line, marginX, y);
        y += smallFont * scale * 0.5;
      }
      y += 3;
    }

    // Footer band.
    const footerText = [s.footerLine, s.shopPhone && s.showPhone ? `Ph: ${s.shopPhone}` : ""]
      .filter(Boolean)
      .join("   ·   ");
    if (footerText || (wide && s.shopAddress)) {
      const footH = wide ? 12 : 8;
      pdf.setFillColor(...navy);
      pdf.rect(0, pageH - footH, width, footH, "F");
      pdf.setTextColor(255, 255, 255);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(smallFont * scale);
      if (wide && s.shopAddress) {
        pdf.text(s.shopAddress, width / 2, pageH - footH + footH * 0.42, {
          align: "center",
          maxWidth: contentW,
        });
      }
      if (footerText) {
        pdf.text(footerText, width / 2, pageH - footH + footH * (wide ? 0.8 : 0.6), {
          align: "center",
        });
      }
    }

    return y;
  };

  if (wide) {
    const height = paperInfo(s.paper).heightMm!;
    const pdf = new jsPDF({ unit: "mm", format: [width, height] });
    renderBody(pdf, height);
    return pdf;
  }

  const SCRATCH = 3000;
  const scratch = new jsPDF({ unit: "mm", format: [width, SCRATCH] });
  const measured = renderBody(scratch, SCRATCH);
  const height = measured + 14; // room for the footer band + cut feed
  const pdf = new jsPDF({ unit: "mm", format: [width, height] });
  renderBody(pdf, height);
  return pdf;
}

/* ---------------------------------------------------------------------- */
/* 58mm / 50mm condensed POS slip                                          */
/* ---------------------------------------------------------------------- */

function renderCondensed(doc: ReceiptDoc, s: PrintSettings): jsPDF {
  const width = paperWidthMm(s);
  const scale = s.fontScale || 1;
  const marginX = 4;
  const contentW = width - marginX * 2;
  const sym = s.currencySymbol;
  const money = (v: number) => pmoney(v, sym);

  const renderBody = (pdf: jsPDF, pageH: number): number => {
    let y = 6;
    const titleFont = 10 * scale;
    const bodyFont = 7 * scale;
    const smallFont = 6 * scale;

    if (s.showLogo && s.logo) {
      const logoH = 12;
      const logoW = logoH * (s.logo.width / s.logo.height);
      pdf.addImage(s.logo.dataUrl, imgFormat(s.logo.dataUrl), (width - logoW) / 2, y, logoW, logoH);
      y += logoH + 2;
    }
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(titleFont);
    pdf.setTextColor(20, 20, 20);
    const nameLines = pdf.splitTextToSize((s.shopName || "Receipt").toUpperCase(), contentW) as string[];
    for (const line of nameLines) {
      pdf.text(line, width / 2, y, { align: "center" });
      y += titleFont * 0.45;
    }
    if (s.headerLine) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(smallFont);
      pdf.text(s.headerLine, width / 2, y, { align: "center" });
      y += smallFont * 0.55;
    }
    y += 1;
    pdf.setDrawColor(...RULE);
    pdf.setLineDashPattern([1, 0.8], 0);
    pdf.line(marginX, y, width - marginX, y);
    pdf.setLineDashPattern([], 0);
    y += 4;

    const field = (label: string, value: string) => {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(bodyFont);
      pdf.setTextColor(20, 20, 20);
      pdf.text(`${label}:`, marginX, y);
      pdf.setFont("helvetica", "normal");
      const labelW = pdf.getTextWidth(`${label}: `);
      const maxW = contentW - labelW;
      const text = pdf.getTextWidth(value) > maxW ? `${value}`.slice(0, 24) : value;
      pdf.text(text, marginX + labelW, y);
      y += bodyFont * 0.6;
    };
    field("INV", doc.docNo);
    field("DATE", doc.dateText);
    if (doc.customer) field("CUST", doc.customer);
    if (doc.phone && s.showPhone) field("PH", doc.phone);
    y += 1;
    pdf.setLineDashPattern([1, 0.8], 0);
    pdf.line(marginX, y, width - marginX, y);
    pdf.setLineDashPattern([], 0);
    y += 4;

    // Column widths are measured from the actual content (qty values, amounts)
    // rather than a fixed guess — a hardcoded qty-column width here previously
    // risked crowding into the item description on the narrowest paper (50mm,
    // contentW ~42mm), the same trap the classic renderer's item table already
    // avoids by measuring real text widths instead of assuming a column size.
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(smallFont);
    const qtyTexts = doc.lines.map((l) => (l.qty !== undefined ? String(l.qty) : ""));
    const amtTexts = doc.lines.map((l) => money(l.amount ?? 0));
    const qtyColW = Math.max(pdf.getTextWidth("QTY"), ...qtyTexts.map((t) => pdf.getTextWidth(t))) + 1;
    const amtColW = Math.max(pdf.getTextWidth("AMT"), ...amtTexts.map((t) => pdf.getTextWidth(t))) + 1;
    const amtX = width - marginX;
    const qtyX = amtX - amtColW - 3;
    const labelMaxW = Math.max(10, qtyX - qtyColW - 3 - marginX);
    pdf.text("ITEM", marginX, y);
    pdf.text("QTY", qtyX, y, { align: "right" });
    pdf.text("AMT", amtX, y, { align: "right" });
    y += bodyFont * 0.6;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(bodyFont);
    doc.lines.forEach((line, i) => {
      const labelLines = pdf.splitTextToSize(line.label, labelMaxW) as string[];
      pdf.text(labelLines[0] ?? "", marginX, y);
      pdf.text(qtyTexts[i] ?? "", qtyX, y, { align: "right" });
      pdf.text(amtTexts[i] ?? "", amtX, y, { align: "right" });
      y += bodyFont * 0.62;
      for (let j = 1; j < labelLines.length; j++) {
        pdf.text(labelLines[j], marginX, y);
        y += bodyFont * 0.62;
      }
    });
    y += 1;
    pdf.setLineDashPattern([1, 0.8], 0);
    pdf.line(marginX, y, width - marginX, y);
    pdf.setLineDashPattern([], 0);
    y += 4;

    const grand = doc.totals.find((t) => t.strong);
    for (const t of doc.totals) {
      const bold = t === grand;
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(bold ? bodyFont * 1.15 : bodyFont);
      pdf.text(t.label.toUpperCase(), marginX, y);
      pdf.text(t.value, width - marginX, y, { align: "right" });
      y += (bold ? bodyFont * 1.15 : bodyFont) * 0.65;
      if (bold) {
        pdf.setDrawColor(...RULE);
        pdf.line(marginX, y - 1, width - marginX, y - 1);
      }
    }
    y += 2;

    if (doc.note) {
      pdf.setFont("helvetica", "italic");
      pdf.setFontSize(smallFont);
      const noteLines = pdf.splitTextToSize(`Note: ${doc.note}`, contentW) as string[];
      for (const line of noteLines) {
        pdf.text(line, marginX, y);
        y += smallFont * 0.6;
      }
      y += 2;
    }

    pdf.setLineDashPattern([1, 0.8], 0);
    pdf.setDrawColor(...RULE);
    pdf.line(marginX, y, width - marginX, y);
    pdf.setLineDashPattern([], 0);
    y += 4;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(bodyFont);
    pdf.text("THANK YOU!", width / 2, y, { align: "center" });
    y += bodyFont * 0.6;
    if (s.footerLine) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(smallFont);
      pdf.text(s.footerLine, width / 2, y, { align: "center" });
      y += smallFont * 0.6;
    }
    if (s.shopPhone && s.showPhone) {
      pdf.text(s.shopPhone, width / 2, y, { align: "center" });
      y += smallFont * 0.6;
    }

    const cutFeedMm = Math.max(0, Math.min(40, s.cutFeedMm || 0));
    if (cutFeedMm) y += cutFeedMm;
    return y;
  };

  const SCRATCH = 3000;
  const scratch = new jsPDF({ unit: "mm", format: [width, SCRATCH] });
  const measured = renderBody(scratch, SCRATCH);
  const height = measured + 2;
  const pdf = new jsPDF({ unit: "mm", format: [width, height] });
  renderBody(pdf, height);
  return pdf;
}
