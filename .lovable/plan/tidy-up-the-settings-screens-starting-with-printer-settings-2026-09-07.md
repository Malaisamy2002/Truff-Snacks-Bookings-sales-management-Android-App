# Tidy up the settings screens, starting with printer settings

The printer settings panel is the worst offender: fields are laid out in fixed three-across rows, but some fields only appear for certain paper types and some have an extra note underneath. That leaves gaps and steps in the rows, so labels and boxes don't line up — on a phone it turns into one long unlabelled stack, and on Windows the wide window stretches everything oddly.

## What will change

**Printer settings, regrouped**

Instead of one long run of boxes, the panel gets clear labelled groups:

1. Quick setup — pick your printer model
2. Paper and size — paper type, custom width, text size, copies
3. Print quality — darkness, line spacing, feed before cut, side margin
4. What prints on the receipt — shop name, header, footer, address, phone, email, currency
5. Options — the three on/off switches
6. Test and reset buttons

Every field gets the same shape: label on one line, box below, and a fixed space kept for the small grey note so neighbouring fields still line up even when only one of them has a note. Boxes that appear or disappear (custom roll width, feed before cut) no longer punch holes in a row — the grid reflows cleanly.

**Reads well on both phone and Windows**

- Phone: one field per line, larger tap targets, switches on their own full-width rows with the label on the left and the switch on the right, buttons stretched to full width so they don't wrap into a ragged pile.
- Windows/desktop: two columns on medium windows, three on wide ones, with a sensible maximum width so a single field never stretches across the whole screen. Group headings and dividers give the panel structure.

**Same treatment applied across settings**

The same field and switch building blocks get reused in the other settings cards that share the problem (Telegram backup, invoice branding, billing, layout), so labels, spacing, note text and button rows match everywhere instead of each card doing its own thing.

Nothing about how printing actually works changes — same options, same saved values, same test print.

## Technical notes

- Add small shared presentation components (e.g. `SettingsField`, `SettingsSwitchRow`, `SettingsGroup`) under `src/components/app/`, built on existing `Label`/`Input`/`Switch` and semantic tokens only — no hardcoded colours.
- Rewrite `PrintSettingsCard.tsx` markup using those primitives: `grid gap-4 sm:grid-cols-2 xl:grid-cols-3` with `items-start` and `auto-rows-fr`, textarea spanning full width, conditional fields as normal grid children rather than partial rows.
- Reserve hint space with a consistent `min-h` on the helper paragraph so rows stay aligned.
- Buttons row: `flex-col sm:flex-row` with `w-full sm:w-auto`.
- Apply the same primitives to `TelegramBackupCard`, `InvoiceBrandingCard`, `BillingSettingsCard`, `LayoutSettingsCard` for consistency; no logic or state changes anywhere.
