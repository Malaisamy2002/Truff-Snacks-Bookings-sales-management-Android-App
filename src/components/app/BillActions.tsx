import { Copy, Download, Printer, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { billText, copyText, whatsappUrl, type Bill } from "@/lib/biz";
import { downloadBillPdf, printBillPdf, shareBillPdf } from "@/lib/receipt";
import { INVOICE_SECTIONS, type InvoiceSection } from "@/lib/desktop";

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
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
    </div>
  );
}
