# Dues, merges and money-math correctness pass

Your uploaded app is not yet in this project (it currently shows the blank starter), so the first step is bringing your code in unchanged, then doing the money work on top of it.

## Step 0 — Bring the app in

Import the uploaded project (all screens, settings, tests, docs) into this project so it runs in the preview and every later change is verifiable.

## What already works (checked in your code)

- One shared rule for rounding and rupee display; every amount is a whole rupee, discount before tax.
- One definition of "still owed": a rupee lives in exactly one of three places — a booking balance, a bill balance, or the customer's running tab. Moving a balance to dues subtracts it from the source, so it is not counted twice.
- Merging bookings and snack slips into one bill happens in a single all-or-nothing write, reverses each source's tab charge by the exact amount it added, un-merge puts it back, and an "on tab" bill is not treated as money received.
- Merged and cancelled records stop counting as their own money everywhere.
- Bills list already fades a bill that was moved to dues, shows "Moved to dues · D-…", and disables its payment buttons.

## Gaps to fix

1. **Greying out is only on Bills.** A turf booking whose balance was put on the tab, and a snack sale billed "On tab", still look and behave like unpaid records in the Turf and Snacks lists. Fix: same treatment everywhere — faded row, "Moved to dues · D-…" badge, payment/collect actions disabled, collection only from the Dues tab. Same for the customer popup and any merged-away source row.
2. **Due numbers are missing on the Dues tab.** The Dues tab and its ledger lines don't show the D-… number, so a due can't be matched back to its bill/booking/slip. Fix: show it on every due line and in the ledger.
3. **Double-count sweep, end to end.** Trace each risk path with a test that would fail if it regressed: snack sale on a tab vs. the same amount as a due; a sale attached to a booking vs. counted standalone; the parts of a merged bill vs. the merged bill; merged customers; advance counted both as collected and as due reduction; over-collection turning into a negative due that cancels a real one; expenses appearing in both profit and payment-split views; archived/cancelled rows leaking into a month.
4. **Double-billing sweep.** Same booking or slip saved twice, a reprint creating a second record, tax applied twice on a merged bill, discount applied twice (line and total).
5. **Cross-surface agreement.** For one seeded month, each figure must be identical on Home, Reports, the tab/customer views, the Excel export, the PDF export and the printed receipt — including tax and rounding. Any disagreement gets fixed once in the shared formula, not patched per screen.
6. **Dues definition used everywhere.** Dues tab, Home dues card, customer directory, customer popup and exports all read the same "outstanding" figure; part payments, overpayments and settled-to-zero all behave.

## Proof

- New regression tests for every issue found, plus mixed scenarios (taxed bookings, taxed snack sales, tab charges, part payments, merges, un-merges, cancellations).
- The independent hand-check script extended with the same scenarios, so two separate methods must agree.
- Full test run and type check clean, and a short written report listing each issue found, where it showed a wrong number, and how it was fixed.
- The rules doc updated to match final behaviour.

## Technical notes

- Import with git metadata excluded; keep `src/lib` helpers as the single source of truth (`money.ts`, `biz.ts`, `dues.ts`, `merge.ts`, `tabs.ts`).
- Extend `dues.ts` with `bookingMovedToDues` / `saleMovedToDues` mirroring the existing `billMovedToDues`, and reuse `dueNoForRef` for the Turf, Snacks, Dues and customer surfaces.
- Aggregators (`analytics.ts` `periodStats`/`taxReport`, `data.ts` `customerLifetimeStats`) and every export/print path (`xlsx.ts`, `dashboard-xlsx.ts`, `report-pdf.ts`, `print.ts`, `receipt.ts`, `receipts-share.ts`) must consume the shared stat objects, never re-derive tax or dues inline.
- Audit all `isFinancialBooking` / `isFinancialSale` filter sites for consistent exclusion of merged/cancelled/archived rows.
- Tests land in the existing `*.test.ts` files; `scripts/verify-math.ts` gets matching sections.
