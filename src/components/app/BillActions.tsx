import { Copy, Download, Printer, QrCode, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { billText, copyText, whatsappUrl, type Bill } from "@/lib/biz";
import { downloadBillPdf, printBillPdf, shareBillPdf } from "@/lib/receipt";
import { INVOICE_SECTIONS, type InvoiceSection } from "@/lib/desktop";
import { usePrintSettings } from "@/lib/print";
import { upiUri } from "@/lib/receipt-upi";

export function BillActions({
  bill,
  section = INVOICE_SECTIONS.bills,
  restricted = false,
}: {
  bill: Bill;
  /** Which `Invoices/` subfolder this bill's saved files go in — pass
   * "Merged" for bills produced by merging turf/snack records so they
   * land separately from ordinary bills. Defaults to "Bills". */
  section?: InvoiceSection;
  /** True once the bill's balance has moved onto the customer's tab
   * (greyed out in the list). Such bills are read-only everywhere except
   * PDF download and Print — WhatsApp share and Copy are disabled since
   * the bill text/number is no longer how this money gets collected. */
  restricted?: boolean;
}) {
  const { settings } = usePrintSettings();
  const upiId = settings.upiId.trim();

  const payViaUpi = () => {
    const uri = upiUri({
      upiId,
      payeeName: settings.shopName,
      note: `Bill ${bill.invoice_no}`,
    });
    // upi:// only means anything to a UPI app, so treat it as a link the OS
    // hands off to GPay/PhonePe/etc. rather than something to fetch — same
    // navigation a plain <a href="upi://..."> would do. window.location.href
    // triggers that hand-off reliably in the Android WebView, where
    // window.open often gets swallowed.
    window.location.href = uri;
  };

  return (
    <div className={`grid grid-cols-2 gap-2 ${upiId ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
      <Button
        variant="outline"
        className="lift min-h-11"
        onClick={() => downloadBillPdf(bill, section)}
      >
        <Download className="size-4" /> PDF
      </Button>
      <Button
        variant="outline"
        className="lift min-h-11"
        aria-label="Print bill"
        title="Print"
        onClick={() => printBillPdf(bill, section)}
      >
        <Printer className="size-4" /> Print
      </Button>
      <Button
        className="lift min-h-11"
        aria-label="Share on WhatsApp"
        title="Share on WhatsApp"
        disabled={restricted}
        onClick={async () => {
          const res = await shareBillPdf(
            bill,
            whatsappUrl(billText(bill), bill.customer_phone),
            section,
          );
          if (res === "fallback") toast.info("PDF downloaded — attach it in WhatsApp");
          // "cancelled" (Web Share dismissed, or an Android save failure —
          // which already showed its own error toast) intentionally shows
          // nothing further here.
        }}
      >
        <Share2 className="size-4" /> WhatsApp
      </Button>
      <Button
        variant="outline"
        className="lift min-h-11"
        aria-label="Copy bill"
        title="Copy"
        disabled={restricted}
        onClick={async () => {
          const ok = await copyText(billText(bill));
          if (ok) toast.success("Bill copied");
          else toast.error("Copy failed");
        }}
      >
        <Copy className="size-4" />
      </Button>
      {upiId && (
        <Button
          variant="outline"
          className="lift min-h-11"
          aria-label="Pay via UPI"
          title="Pay via UPI"
          onClick={payViaUpi}
        >
          <QrCode className="size-4" /> Pay via UPI
        </Button>
      )}
    </div>
  );
}
