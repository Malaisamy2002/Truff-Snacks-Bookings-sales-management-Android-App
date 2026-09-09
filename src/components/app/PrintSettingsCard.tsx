import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, Printer, RotateCcw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_PRINT_SETTINGS,
  DENSITY_OPTIONS,
  LINE_SPACING_OPTIONS,
  PAPER_TYPES,
  PRINTER_PRESETS,
  isRollPaper,
  usePrintSettings,
  type DensityId,
  type LineSpacingId,
  type PaperId,
} from "@/lib/print";
import { formatDMY } from "@/lib/biz";
import { dayKey } from "@/lib/analytics";
import { isAndroid } from "@/lib/desktop";
import { previewReceipt, printReceipt, type ReceiptDoc } from "@/lib/receipt";
import {
  SettingsActions,
  SettingsField,
  SettingsGrid,
  SettingsGroup,
  SettingsSwitchRow,
} from "./SettingsField";

const sample: ReceiptDoc = {
  kind: "Sample",
  docNo: "TEST-001",
  dateText: formatDMY(dayKey(new Date())),
  customer: "Test Customer",
  phone: "9876543210",
  lines: [
    { label: "Turf slot", sub: "1 hr x Rs 1,200", amount: 1200 },
    { label: "Tea", sub: "2 x Rs 15", amount: 30 },
  ],
  totals: [{ label: "TOTAL", value: "Rs 1,230", strong: true }],
  fileName: "print-test",
};

export function PrintSettingsCard() {
  const { settings, save } = usePrintSettings();
  const set = <K extends keyof typeof settings>(k: K, v: (typeof settings)[K]) =>
    save({ ...settings, [k]: v });
  const rollPaper = isRollPaper(settings.paper);
  const [numberDrafts, setNumberDrafts] = useState({
    customWidthMm: String(settings.customWidthMm),
    copies: String(settings.copies),
    cutFeedMm: String(settings.cutFeedMm),
    marginMm: String(settings.marginMm),
    a4ContentTopMm: String(settings.a4ContentTopMm),
  });

  // Keep edits as text until the field is complete. Saving on every keypress
  // made it impossible to clear "80" before typing a new width: the empty
  // intermediate value was immediately replaced with a fallback number.
  useEffect(() => {
    setNumberDrafts({
      customWidthMm: String(settings.customWidthMm),
      copies: String(settings.copies),
      cutFeedMm: String(settings.cutFeedMm),
      marginMm: String(settings.marginMm),
      a4ContentTopMm: String(settings.a4ContentTopMm),
    });
  }, [
    settings.customWidthMm,
    settings.copies,
    settings.cutFeedMm,
    settings.marginMm,
    settings.a4ContentTopMm,
  ]);

  const editNumber = (key: keyof typeof numberDrafts, value: string) =>
    setNumberDrafts((current) => ({ ...current, [key]: value }));

  const commitNumber = (
    key: keyof typeof numberDrafts,
    min: number,
    max: number,
    fallback: number,
    round = false,
  ) => {
    const parsed = Number(numberDrafts[key]);
    const value = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
    const committed = round ? Math.round(value) : value;
    set(key, committed as (typeof settings)[typeof key]);
  };

  const textSize = (
    <Select value={String(settings.fontScale)} onValueChange={(v) => set("fontScale", Number(v))}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="0.9">Small</SelectItem>
        <SelectItem value="1">Normal</SelectItem>
        <SelectItem value="1.15">Large</SelectItem>
        <SelectItem value="1.3">Extra large</SelectItem>
      </SelectContent>
    </Select>
  );

  return (
    <section className="space-y-3">
      <Card className="frost">
        <CardContent className="space-y-6 p-4 sm:p-5">
          <SettingsGroup
            title="Quick setup"
            hint="Optional shortcut — fills in paper size, darkness and spacing for common hardware. Everything stays editable below."
          >
            <Select
              value=""
              onValueChange={(id) => {
                const preset = PRINTER_PRESETS.find((p) => p.id === id);
                if (!preset) return;
                save({ ...settings, ...preset.settings });
                toast.success(`Applied "${preset.label}" printer settings`);
              }}
            >
              <SelectTrigger className="w-full max-w-xl">
                <SelectValue placeholder="Choose a printer to auto-fill the fields below…" />
              </SelectTrigger>
              <SelectContent>
                {PRINTER_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsGroup>

          <Separator />

          <SettingsGroup title="Paper and size">
            <SettingsGrid>
              <SettingsField label="Paper / printer type">
                <Select value={settings.paper} onValueChange={(v) => set("paper", v as PaperId)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAPER_TYPES.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>

              {settings.paper === "custom" && (
                <SettingsField label="Custom roll width (mm)" hint="Between 50 and 300 mm.">
                  <Input
                    inputMode="numeric"
                    value={numberDrafts.customWidthMm}
                    onChange={(e) => editNumber("customWidthMm", e.target.value)}
                    onBlur={() => commitNumber("customWidthMm", 50, 300, 72)}
                    placeholder="e.g. 72"
                  />
                </SettingsField>
              )}

              <SettingsField label="Text size">{textSize}</SettingsField>

              <SettingsField label="Copies per print" hint="1 to 5 copies.">
                <Input
                  inputMode="numeric"
                  value={numberDrafts.copies}
                  onChange={(e) => editNumber("copies", e.target.value)}
                  onBlur={() => commitNumber("copies", 1, 5, 1, true)}
                />
              </SettingsField>
            </SettingsGrid>
          </SettingsGroup>

          <Separator />

          <SettingsGroup title="Print quality">
            <SettingsGrid>
              <SettingsField label="Print darkness">
                <Select
                  value={settings.density}
                  onValueChange={(v) => set("density", v as DensityId)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DENSITY_OPTIONS.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>

              <SettingsField label="Line spacing">
                <Select
                  value={settings.lineSpacing}
                  onValueChange={(v) => set("lineSpacing", v as LineSpacingId)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LINE_SPACING_OPTIONS.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>

              {rollPaper && (
                <SettingsField label="Feed before cut (mm)" hint="Blank paper fed after each bill.">
                  <Input
                    inputMode="numeric"
                    value={numberDrafts.cutFeedMm}
                    onChange={(e) => editNumber("cutFeedMm", e.target.value)}
                    onBlur={() => commitNumber("cutFeedMm", 0, 40, 0)}
                    placeholder="0"
                  />
                </SettingsField>
              )}

              <SettingsField
                label="Side margin (mm)"
                hint="0 = automatic (5 mm on rolls, 12 mm on sheets)"
              >
                <Input
                  inputMode="numeric"
                  value={numberDrafts.marginMm}
                  onChange={(e) => editNumber("marginMm", e.target.value)}
                  onBlur={() => commitNumber("marginMm", 0, 40, 0)}
                  placeholder="0"
                />
              </SettingsField>
              {settings.paper === "a4" && settings.background && settings.showLogo && (
                <SettingsField
                  label="A4 letterhead content starts (mm)"
                  hint="Increase this if your uploaded letterhead header overlaps bill details."
                >
                  <Input
                    inputMode="numeric"
                    value={numberDrafts.a4ContentTopMm}
                    onChange={(e) => editNumber("a4ContentTopMm", e.target.value)}
                    onBlur={() => commitNumber("a4ContentTopMm", 40, 140, 68)}
                    placeholder="68"
                  />
                </SettingsField>
              )}
            </SettingsGrid>
          </SettingsGroup>

          <Separator />

          <SettingsGroup title="What prints on the receipt">
            <SettingsGrid>
              <SettingsField label="Shop name on receipt">
                <Input
                  value={settings.shopName}
                  onChange={(e) => set("shopName", e.target.value)}
                  placeholder="Leave blank for default"
                />
              </SettingsField>
              <SettingsField label="Header line">
                <Input
                  value={settings.headerLine}
                  onChange={(e) => set("headerLine", e.target.value)}
                />
              </SettingsField>
              <SettingsField label="Footer line">
                <Input
                  value={settings.footerLine}
                  onChange={(e) => set("footerLine", e.target.value)}
                />
              </SettingsField>

              <SettingsField label="Shop address on receipt" full reserveHint={false}>
                <Textarea
                  rows={2}
                  value={settings.shopAddress}
                  onChange={(e) => set("shopAddress", e.target.value)}
                  placeholder="Leave blank to skip printing the address"
                />
              </SettingsField>

              <SettingsField label="Shop phone on receipt">
                <Input
                  inputMode="tel"
                  value={settings.shopPhone}
                  onChange={(e) => set("shopPhone", e.target.value)}
                  placeholder="Leave blank to skip"
                />
              </SettingsField>
              <SettingsField label="Shop email on receipt">
                <Input
                  type="email"
                  value={settings.shopEmail}
                  onChange={(e) => set("shopEmail", e.target.value)}
                  placeholder="Leave blank to skip"
                />
              </SettingsField>
              <SettingsField label="Currency symbol">
                <Input
                  value={settings.currencySymbol}
                  onChange={(e) => set("currencySymbol", e.target.value.slice(0, 4))}
                  placeholder="Rs"
                />
              </SettingsField>
            </SettingsGrid>
          </SettingsGroup>

          <Separator />

          <SettingsGroup title="Options">
            <div className="grid gap-2 lg:grid-cols-2">
              <SettingsSwitchRow
                label="Print customer phone"
                checked={settings.showPhone}
                onCheckedChange={(v) => set("showPhone", v)}
              />
              <SettingsSwitchRow
                label="Auto-print after saving a bill"
                checked={settings.autoPrint}
                onCheckedChange={(v) => set("autoPrint", v)}
              />
              <SettingsSwitchRow
                label="Preview before printing"
                // printReceipt() (receipt.ts) branches on isAndroid() before
                // it ever checks previewBeforePrint — every print on Android
                // already saves the PDF and opens it in the native viewer
                // first (Android WebView can't silently print), so this
                // setting has no separate effect there. Disabling it here
                // instead of leaving it live-but-inert, which used to let
                // someone toggle it off expecting a direct print and see no
                // change.
                hint={
                  isAndroid()
                    ? "Always on for this device — printing opens the PDF viewer first"
                    : "Opens in a tab instead of printing right away"
                }
                checked={isAndroid() ? true : settings.previewBeforePrint}
                onCheckedChange={(v) => set("previewBeforePrint", v)}
                disabled={isAndroid()}
              />
            </div>
          </SettingsGroup>

          <Separator />

          <SettingsGroup title="Test and reset">
            <SettingsActions>
              <Button variant="outline" onClick={() => printReceipt(sample, settings)}>
                <Printer className="mr-1 h-4 w-4" /> Test print
              </Button>
              <Button variant="outline" onClick={() => void previewReceipt(sample, settings)}>
                <Eye className="mr-1 h-4 w-4" /> Preview layout
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  save(DEFAULT_PRINT_SETTINGS);
                  toast.success("Reset to thermal 80 mm default");
                }}
              >
                <RotateCcw className="mr-1 h-4 w-4" /> Reset defaults
              </Button>
            </SettingsActions>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Tip: try "Quick setup" above first, then fine-tune darkness or spacing if receipts
                print too light or too cramped.
              </span>
            </p>
          </SettingsGroup>
        </CardContent>
      </Card>
    </section>
  );
}
