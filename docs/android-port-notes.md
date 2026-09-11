# Android port — progress notes

Tracks what's been done against `docs/android-app-build-prompt.md`, and what
still needs a real device/Android Studio to finish (this pass was done
without network access, so nothing native could be scaffolded or built).

## Done in this pass (source-only, no native build)

- **CI**: added `.github/workflows/build-android.yml`, parallel to the
  existing `build-windows-installer.yml`. It runs `tauri android init` fresh
  on GitHub's Ubuntu runner (network + Android SDK available there, unlike
  this sandbox), installs the NDK + Rust Android targets, and builds a
  **debug** APK as a downloadable workflow artifact. Release signing is
  deliberately left as a documented stub at the bottom of that file — it
  needs `gen/android/app/build.gradle.kts` to actually exist and be
  inspected first, which only happens once this workflow (or a local
  `tauri android init`) has actually run once. **This workflow has not been
  run yet** — the NDK version pin (`27.0.12077973`) and the
  `tauri android init --ci` / `tauri android build --apk --debug` flags are
  based on current Tauri v2 CLI conventions, not verified against an actual
  run's log. Check the Actions tab after pushing this and adjust the NDK
  version / flags if either step fails.
- **§6 UI — notch space**: `src/routes/index.tsx`'s sticky header now has
  `pt-[env(safe-area-inset-top)]` on the outer `<header>`, so the
  brand-gradient background still fills the status-bar/cutout area but the
  logo/title/nav content sits below it. `env()` is `0` on browsers/desktop
  that don't need it, so this is a no-op there — verified no other
  `fixed`/`sticky` top-anchored elements exist (checked the Sonner toaster,
  which is `position="bottom-right"` already, and found no other top-fixed
  overlays).
- **§3 filesystem**: `src/lib/desktop.ts`'s `saveToAppDocuments` /
  `appDocumentExists` / `appDocumentAbsPath` / `readAppDocument` no longer
  hard-code `BaseDirectory.Document`. They now call a new
  `resolveAppDocsBase()` that tries `documentDir()` first (desktop's exact
  existing behavior — unchanged) and falls back to
  `BaseDirectory.AppLocalData` if resolving the Documents directory throws.
  This covers the app-private half of §3 (auto-saved PDFs/Excel/receipt
  photos) without touching call sites in `expenses.ts`, `receipt.ts`,
  `report-pdf.ts`, `xlsx.ts`, `receipts-share.ts` — they all go through
  `desktop.ts`, so the fix is in one place.
- **Capabilities scaffold**: added `src-tauri/capabilities/mobile.json`,
  parallel to the existing `default.json`, scoped to
  `$APPDATA/TurfApp/**` and `$APPLOCALDATA/TurfApp/**` instead of
  `$DOCUMENT/TurfApp/**`, and drops `opener:allow-reveal-item-in-dir` (no
  Android equivalent to Explorer's "reveal in folder"). **Correction from an
  earlier pass**: this file originally had `"platforms": ["android", "iOS"]`
  — removed on a re-check, since the exact enum casing Tauri's capability
  schema expects wasn't verified, and an invalid value there risks failing
  to parse the *entire* capability set (breaking every platform's build, not
  just Android) rather than just failing to scope correctly. The file now
  applies unconditionally, which is harmless (see the note left in the
  file's own `description` field) until the correct casing is confirmed
  against the schema Tauri generates and the restriction is added back.

## Not done — needs Android Studio / a device / network, none of which this
## environment has

- **Nothing has actually been built.** `tauri android init` was not
  executed by hand here — that requires downloading the Android Gradle
  plugin and NDK components, which needs network access this sandbox
  doesn't have. `src-tauri/gen/android/` does not exist in this snapshot.
  The new `build-android.yml` workflow (see above) runs `tauri android init`
  for you on push/dispatch, but it hasn't executed even once yet — push it
  and check the Actions tab before trusting any of its assumptions. To do
  the same locally instead of via CI:
  ```
  bun install
  bun run tauri android init
  bun run tauri android dev    # or `android build` for a release .aab/.apk
  ```
- **`resolveAppDocsBase()`'s fallback path is unverified**, in two ways:
  1. It assumes `documentDir()` *throws* on Android rather than silently
     resolving to something unwritable or restricted. If it turns out
     `documentDir()` resolves without throwing but scoped-storage still
     blocks the actual `writeFile`/`mkdir` call, the try/catch needs to move
     around those calls instead of just the path resolution.
  2. It assumes `BaseDirectory.AppLocalData` exists as an enum member on the
     installed `@tauri-apps/plugin-fs` version — plausible (it mirrors
     Tauri v1's naming) but not checked against this project's actual
     `^2.5.1` pin. If a typecheck/build fails on that reference, that's why.
  Test both on a real device before trusting either.
- **`capabilities/mobile.json`'s `$schema` path** (`../gen/schemas/mobile-schema.json`)
  hasn't been checked against the actual schema Tauri generates — that file
  doesn't exist until `tauri android init` has been run once. Regenerate/
  adjust it against whatever shows up in `gen/schemas/` afterward. Separately,
  the file no longer has a `"platforms"` restriction at all (removed on a
  re-check — see the bullet above) — add it back once the correct enum
  casing (`"android"`/`"ios"` vs `"Android"`/`"iOS"`, unconfirmed) is known,
  so this scope doesn't sit unnecessarily on the desktop/browser builds too.
- **The SAF (Storage Access Framework) picker for user-facing exports**
  (§3b — backup export/import, receipts-zip sharing) is not implemented.
  This needs either confirming the installed `@tauri-apps/plugin-dialog` /
  `plugin-fs` versions support Android's `ACTION_OPEN_DOCUMENT_TREE` picker,
  or writing a small custom Kotlin plugin if they don't — that's native
  Android code this environment can't write blind without the actual plugin
  API surface in front of it.
- **GitHub token storage on Android** (§4) — the Android Keystore /
  `EncryptedSharedPreferences`-backed `keyring_get_token` /
  `keyring_set_token` / `keyring_delete_token` implementation is not
  written. Also still unresolved from the original audit: confirm whether
  those three commands are even registered for the *desktop* build today —
  `src-tauri/src/lib.rs` in this snapshot only registers `opener`, `fs`, and
  `dialog` plugins, no keyring plugin or custom command handlers. If
  desktop doesn't actually have this working yet either, that's a
  pre-existing gap, not something introduced by the Android work.
- **Fluid GitHub transfer** (§4) — `src/lib/github.ts`'s `toBase64`/
  `fromBase64` still encode/decode the whole backup payload synchronously.
  Not changed in this pass since it's a behavior/perf change best validated
  with a real large dataset and on-device profiling, not guessed at blind.
- **Back-button handling, touch-target audit, icons/splash** (§6), and the
  **Tauri Android project + Gradle/signing setup** (§8) are all still open —
  every one of them needs either the generated `gen/android/` project, a
  device/emulator, or both. **Share sheet / print (§5) is no longer in this
  list** — see the dated entry below.

## Print (§5) implemented — UPI app-chip row added to match Windows

This entry supersedes the "Share sheet / print (§5) ... still open" line
that used to be here. That was stale: native printing has been fully wired
for a while — `AndroidSavePlugin.kt`'s `printPdf` command (backed by
`android.print.PrintManager`), exposed through the Rust plugin
(`build.rs`'s `COMMANDS`, `permissions/default.toml`'s `allow-print-pdf`,
`capabilities/mobile.json`'s `android-save:default`), and called from
`desktop.ts`'s `printPdfFile()` → `receipt.ts`'s `printReceipt()`. This
project's own `previewReceipt()` (save-and-open, since Android can't
reliably open a `blob:` URL in a new tab) is also in place and is not
Windows's approach — Windows keeps an in-dialog PDF preview instead, which
doesn't apply here. **None of this has been confirmed against real printer
hardware yet** — only reviewed against source; treat "opens the system
print dialog" as unverified until tested on a device.

What *was* actually missing, and has now been added: the printed premium
receipt's "Scan & Pay" QR box didn't draw the row of UPI app chips
(GPay/PhonePe/etc, driven by the shop's `upiApps` Settings choice) that the
Windows build's `receipt-upi.ts` draws — `PrintSettings` here didn't even
have an `upiApps` field, so the setting couldn't be saved, and the "Pay via
UPI" button in `BillActions.tsx` didn't exist either. Fixed by:
- `src/lib/receipt-upi.ts` (new) — app list, `resolveApps()`, `upiUri()`
  (button-only, amount-less), `drawAppStrip()` (chip row), ported from
  Windows and trimmed to what this project's simpler inline QR box needs
  (not Windows's full boxed multi-variant panel system — this project's
  premium layouts already draw their own box).
- `src/lib/print.ts` — added the missing `upiApps: UpiAppId[]` field,
  default, and normalize/validate logic.
- `src/lib/receipt-premium.ts` — draws the chip row under the QR on both
  the A4/A5 (wide) and 80mm (narrow) layouts, mono/colour following the
  existing `wantColor` flag.
- `src/components/app/PrintSettingsCard.tsx` — added the "UPI apps shown"
  checkbox group.
- `src/components/app/BillActions.tsx` — added the "Pay via UPI" button.
- `src/lib/receipt-premium.test.ts` (new) — paper-dispatch coverage plus
  chip-row coverage (default apps, custom selection, empty-falls-back,
  narrow-layout).

**Not yet done as part of this pass:** a real `npm install`/`vitest run` in
this environment — the sandbox's network proxy denies all npm tarball
downloads (`x-deny-reason: host_not_allowed`) regardless of registry, so
none of the above has been confirmed to actually typecheck or pass tests.
Run `npm run typecheck && npm test -- receipt-premium print` (or the
equivalent `bun` commands, since this repo normally installs through a
private registry mirror per `bun.lock`) before trusting this change.

## Suggested next step

Run `bun install && bun run tauri android init` on a machine with Android
Studio + the NDK installed, commit the generated `gen/android/` project,
then come back to this list — most of the remaining items (SAF picker,
keyring plugin, share-sheet plugin, back-button wiring) need that generated
project to exist before they can be written against real APIs instead of
guessed at.

## Decision recorded on the two §4/§3b gaps (data-integrity pass)

Two items from this doc came up again during a data-integrity/GitHub-sync
review pass; recording the decision here so it isn't re-litigated blind
next time:

- **GitHub token storage on Android.** Still not written — same reasoning
  as above (needs `gen/android/` and a device to write real
  Keystore/`EncryptedSharedPreferences` code against, not guessed at). The
  interim is accepted as-is for now: `github.ts`'s `WEB_TOKEN_KEY`
  localStorage fallback (documented risk, same as the browser/PWA build)
  covers Android until someone with a real device/Android Studio session
  writes and tests the Keystore-backed plugin. `github.test.ts` now has a
  regression test asserting `readGithubConfig`/`writeGithubConfig` never
  call the `keyring_*` Tauri commands when `isAndroid()` is true, so this
  interim can't silently regress into a crash while it's in effect.
- **SAF picker for `pickReceiptsArchiveFile()` / backup import.** Still not
  implemented, same reasoning. The interim is also accepted as-is:
  `ReceiptsCard.tsx` and `BackupCard.tsx` already route Android through the
  plain `<input type="file">` element (same code path as the browser/PWA
  build) instead of the native dialog, via the `isDesktop() && !isAndroid()`
  guard — so "Import receipts (.zip)" and backup restore both work on
  Android today, just through the browser-style file picker rather than a
  native SAF `ACTION_OPEN_DOCUMENT_TREE` dialog. No functional gap, just a
  slightly less native picker UI; revisit once a device is available to
  confirm whether it's worth a custom Kotlin plugin.

## GitHub backup removed

The GitHub-backup module referenced throughout this doc (`src/lib/github.ts`,
`github.test.ts`, the `readGithubConfig`/`writeGithubConfig` token slot) has
been removed from the app. It was never wired into any UI component, so
this is a source-tree cleanup, not a feature removal a user would notice.
The GitHub-shaped entries above are left as-is for history; nothing further
needs to be written against them. The Keystore/`EncryptedSharedPreferences`
secure-store work they were tracking (§4) is done and in use by the
Telegram bot token and the backup passphrase instead — see
`android-secure-store.ts` and `src-tauri/src/lib.rs`.


## Crash-on-launch bug found and fixed (post-CI-build audit)

The first debug APK actually built by the GitHub Actions workflow crashed
immediately on open on every device ("app has stopped" with no UI ever
shown). Root cause: `src-tauri/plugins/android-save/android/src/main/AndroidManifest.xml`
declared a `<provider>` with
`android:name="app.tauri.androidsave.AndroidSaveFileProvider"`, but no such
Kotlin class was ever written — only `AndroidSavePlugin.kt` exists in that
package. Android instantiates every manifest-declared `<provider>` at app
process startup, before any Activity/WebView/Rust code runs, so a
`ClassNotFoundException` there is fatal and unconditional — it doesn't
matter that the plugin's actual save/open code is otherwise correct and
try/catch-wrapped, because the crash happens before any of it executes.

Fix: point the manifest at the real, always-present `androidx.core.content.FileProvider`
class instead of the nonexistent subclass — multiple `<provider>` entries
with different `android:authorities` can share that same class, which is
exactly what the app's *other* (working) file provider entry already does.
No Kotlin code needed to change; `AndroidSavePlugin.openFile()`'s
`FileProvider.getUriForFile(activity, "${activity.packageName}.androidsave.fileprovider", file)`
call works identically either way, since it only depends on the authority
string and the `android_save_file_paths.xml` meta-data, not on the class
being a bespoke subclass.

Re-run the `build-android.yml` workflow (or `tauri android build --apk --debug`
locally) after this change and confirm the new APK actually opens on a
device/emulator before trusting anything else in this doc's "not done" list.

## Correction: the fix above caused a build-time manifest-merge failure

The claim above — "multiple `<provider>` entries with different
`android:authorities` can share that same class" — is wrong across a
plugin/app manifest boundary. It only holds within a single manifest.
Android's manifest merger matches `<provider>` elements by `android:name`
(the class), not by authority. Once the app's own auto-generated manifest
(`gen/android/app/.../AndroidManifest.xml`, built by `tauri android init`)
declared its own `<provider android:name="androidx.core.content.FileProvider">`
for the `${applicationId}.fileprovider` authority, it collided with this
plugin's provider entry — also naming the raw `FileProvider` class, just
with a different authority — and the merge failed at build time.

Real fix: give the plugin's provider its own class identity instead of
reusing the raw `FileProvider` class. Added
`app/tauri/androidsave/AndroidSaveFileProvider.kt`, a bodyless
`class AndroidSaveFileProvider : FileProvider()`, and pointed the plugin's
manifest at `app.tauri.androidsave.AndroidSaveFileProvider` instead of
`androidx.core.content.FileProvider`. This is different from the earlier
crash-on-launch bug: that one named a subclass that was never written, so
the class didn't exist at runtime; this one names a class that exists and
builds fine, so no collision and no `ClassNotFoundException`.
`AndroidSavePlugin.kt` needed no change — `FileProvider.getUriForFile()`
only depends on the authority string, not which class backs it.
