# Otium Play — continuation checkpoint

Updated: 2026-11-06, Asia/Baghdad. The user has approximately5% quota left and explicitly requested a durable handoff so another tool can continue. Do not start over or replace this implementation with a mockup.

## Ready-to-copy prompt

> Continue the Otium Play work in this repository. Read AGENTS.md, HANDOFF.md, AUDIT.md and RUST_MIGRATION.md first, inspect git status and the latest commit, and finish the remaining checks/release work below. Preserve the actual Rust implementation and the user's minimal series/movies interface. Do not upload private signing material or include ep.json/home.json. Check what has already completed before repeating builds. Explain any remaining physical-device limitation honestly.

## Repository and user intent

- Local directory: `C:\Users\mjd20\OneDrive\Desktop\krmzi-app`.
- GitHub: https://github.com/XRTM8/Otium-Play ; origin is already renamed correctly.
- Only `main` should remain. Base before this work: `8b96a17` (v1.5.0). All changes in this checkpoint belong to the current request.
- Latest published release when inspected: v1.5.0. **v2.0.0 has not been published by this session.**
- New version:2.0.0, Android versionCode15. Android applicationId stays `com.krmzi.app`.
- User chose **complete Rust application rewrite even if the release takes longer** after being explicitly offered gradual migration versus full rewrite.
- Final UI steering: one minimal series grid and a separate movies grid; no horizontal carousel rows, hero marketing blocks or confusing nested navigation. Series detail shows episodes vertically. Dark frosted glass, responsive phone/desktop/TV layouts. Main focus: complete catalogue and robust player/source switching.

## Implemented

- `rust/otium-ui`: real Rust/WebAssembly application, DOM rendering, navigation, provider adapters, pagination/search, catalogue identity, history/favourites, player orchestration, HLS interop, shortcuts, gestures, TV remote focus.
- `rust/otium-core`: shared Rust scraping/network/cache/streaming engine, standalone web host and Android JNI. All4Android ABI libraries built locally (ignored output).
- Deleted old runtime `server.js`, `public/app.js`, `public/catalogue.js`, `public/device-ui.js`, `public/providers/cinemana.js`, their Android copies and `KrmziScraper.kt`. Their old tests were replaced with Rust tests + actual-WASM browser tests. Do not reintroduce them accidentally.
- `MainActivity.kt` + `RustApi.kt` are Android platform/JNI glue, not scraping/application logic. JavaScript under `public/wasm` is generated wasm-bindgen output. Vendored HLS.js and the small browser service worker remain external/platform code. Do not claim every dependency is Rust.
- Missing-series bug fixed at all layers: 1-based page/hasNext/nextPage, independent source failures/retry, duplicate repeated-page guard, progressive painting and retained DOM cards.
- Cinemana search fixed against official live JS: it requires unpadded UTF8 Base64URL, not percentencoded plain search text. Verified with الخليفة returning1310480.
- Original and dubbed editions are separate identities even when Arabic title/year match. `catalogue::edition` labels them; counterpart and episode matching reject different editions. Live example:1320095original versus3129341dubbed for هذا البحر سوف يفيض. Root added dubbed card label and explicit edition to discovery identity; more detail-source labels can be polished if needed.
- Switching resolves replacement first, preserves position/pause/rate/volume/mute, aborts stale requests and rolls back failed media. Selected OK mirror uses `/api/episode/detail?url=...&server=<id>` instead of silently choosing a different mirror.
- HLS: same-origin restricted OK/VK proxy; Cinemana HLS bypasses that proxy. Bounded startup/stall retries, fresh signed URLs, scoped session callbacks, destroy-on-close. Auto-next only after ended.
- No episode poster fetched at startup; reuse catalogue/series artwork. Saved history/favourites allowlist metadata only, excluding expiring streams/embeds/subtitles.
- Fixed contextual history resume, playable Cinemana episode history type, canceled search reopening, source-change invalidation, focus trapping and old-version downgrade update prompt.
- CSS dark glass, reduced motion/transparency support, no blanket will-change/forced per-card GPU layers. Android requests up to120Hz at current physical resolution. Full120FPS needs real device measurement.
- Prepared Rust/WASM/JNI release workflow is saved in `scripts/release-workflow.yml.pending`; see the permission note below before applying it. Existing GitHub workflow remains manual-only/fail-closed on missing stable key. New Gradle artifact check prevents building APK without JNI/WASM.

## Verification evidence and commands

The following passed before the final tiny edition/label changes; rerun the final source checks if not recorded in the appended checkpoint below:

- Rust core:16tests (14unit+2real local HTTP) and strict Clippy.
- Rust UI:8unit tests after edition fix; WASM cargo check/Clippy.
- `node tests/rust-ui.test.cjs`: actual compiled WASM and browser DOM with deterministic network/media fixtures. Covers pagination, duplicate guard, movies separation, partial-source retry,80verticalepisodes, 320x640/390x844/844x390/1280x800, both-way source switching/settings/rollback/cancellation/discovery/OKmirror, history/favourites, canceled search, HLS lifecycle, bounded watchdog, TV1280/1920 D-pad/Back.
- `node tests/pwa.test.cjs`: offline WASM boot and no API/stream caching.
- `node tests/live-rust-smoke.cjs`: real Rust server + live upstreams. Observed192unique Krmzi titles across5pages until exhausted,24movies,36episodes in first live series. **Actual latest episode decoded and currentTime advanced, zero browser errors**. Old first episode only offered external embeds; the live test chooses the latest episode for direct-stream validation.
- Android assembleRelease + lintRelease succeeded after fixing API24 guards, TV orientation and PiP lifecycle. No physical Android/TV device was available.
- Real screenshots under ignored `artifacts/ui-2.0.0/`: phone-series.png, phone-detail.png, phone-movies.png, desktop-series.png, player.png. `player-failure.png` is an obsolete diagnostic from probing an old embed-only episode; do not present it as the final result.

```powershell
cargo test --manifest-path rust/otium-core/Cargo.toml --locked
cargo test --manifest-path rust/otium-ui/Cargo.toml --locked
cargo clippy --manifest-path rust/otium-ui/Cargo.toml --target wasm32-unknown-unknown --locked -- -D warnings
./scripts/build-rust-ui.ps1
node tests/rust-ui.test.cjs
node tests/pwa.test.cjs
./scripts/build-rust-android.ps1 -Offline
gradle -p android assembleRelease lintRelease --offline
```

Local tool fallback paths:

- Gradle: `C:\Users\mjd20\.gradle\wrapper\dists\gradle-9.6.1-bin\4ticwg1pgcbps2hj28r8so764\gradle-9.6.1\bin\gradle.bat`.
- Java17: `C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot`.
- Android SDK: `C:\Users\mjd20\AppData\Local\Android\Sdk`, NDK26.1.10909125.
- Playwright module: `C:/Users/mjd20/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`.
- Browser: `C:/Users/mjd20/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe`.
- Python (if needed): `C:/Users/mjd20/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`.
- Rust1.99.1, wasm32 target, fourAndroid targets and wasm-bindgen-cli0.2.130 installed.
- Browser/local HTTP tests and Gradle may require execution outside the sandbox. A previous default-sandbox `npm test` failed to start its local HTTP test host; the exact same tests passed with approved local execution. Not a source failure.

## Remaining before publishing

1. Confirm final rebuilt WASM and Android assets include the edition/source-identity changes and sanitized history; final build/check status is appended below.
2. Final Android package must be rebuilt **after** the final WASM synchronization. Output `android/app/build/outputs/apk/release/app-release.apk`.
3. Verify APK `apksigner verify --print-certs`, inspect packaged fourlibotium_core.so ABIs and WASM, check version2.0.0/code15, then hash APK.
4. Review diff/commit; preserve ep.json/home.json untracked and private/generated exclusions. Keep onlymain.
5. Publish authorized v2.0.0 only after checks pass: pushmain, create tag/release and upload exactly the verified signed APK as otium-play.apk. Use structured body file for Arabic notes. Never overwrite old releases. `gh` is authenticated as XRTM8 and supports release operations; GitHub connector cannot manage releases.
6. Verify GitHub asset digest equals the local hash. Keep physical-device testing limitation and source network restrictions in release notes.

## Signing constraints — critical

Stable certificate SHA256: `2c6d74a5251577fcdfd8a9df651d52fb2641ff4ef1be6686c8266abed0a0cbf3`, pinned in `.github/signing-certificate.sha256`. Compatible with1.2/1.3/1.4/1.5retained-key builds. Old1.0.6/1.1.0/1.1.1published builds used different lost ephemeral CI certificates and cannot be migrated in place by changing versionCode.

Retained local signing configuration is already ignored/private (`.signing/`, `android/signing.properties`). Use it through Gradle; do not print, commit or attach it. Uploading the private keystore to GitHub Secrets was previously rejected by automatic approval review because explicit export approval was missing. The user has **not** approved private-key export. Continue local signing/manual APK asset upload; do not retry secret export.

No messages need to be sent to third parties. No other repository (especially Otium-Downloader) belongs in this work.

## Final checkpoint — supersedes earlier pending-build notes

After the final edition/labels, clean history, search fixes and formatting:

- **Final Rust tests passed:24/24** (16core+8UI).
- **Final actual-WASM browser suite passed in full**, including all source-switch/HLS/history/search/TV regressions. No active test/build process remains.
- Final WASM check/Clippy passed. UI was rebuilt and synchronized.
- **Final Android assembleRelease + lintRelease passed.** APK contains all4Rust ABI libraries and the exact final public WASM, JS bindings, CSS and index; obsolete app.js is absent.
- Version verified:2.0.0/code15/applicationIdcom.krmzi.app. Certificate matches the pinned retained key.
- Final APK SHA256: `f1efc9dedad4ffc651d4a22835e6f66a7a45edcee59d37944ff12e7b0baa16bf`.
- Local reviewable APK: `release-output/otium-play-2.0.0.apk` (ignored; rebuilt from final sources). Original build output is also present. A different machine must rebuild; this ignored APK is not in Git.
- Offline PWA test passed; live upstream/video smoke passed with192series/5pages,24movies and a decoded advancing video. Physical-device/FPS checks remain unperformed.
- Steps1–3 in “Remaining before publishing” are now complete. Review this checkpoint commit/status, then the remaining external action is publishing the verified v2.0.0 release when continuing the authorized release work. **No v2.0.0 release or tag has been published yet.**

The handoff is intentionally stored with the code, not just in chat. A tool using another provider can continue from this directory or the pushed main branch without access to this conversation. Read the latest git log to identify the checkpoint commit.

### GitHub workflow permission note

The first checkpoint push was rejected because the authenticated OAuth App lacks `workflow` scope. No remote refs changed in that failed push. To preserve a normal code handoff without asking for broader account access, the proposed workflow is committed as `scripts/release-workflow.yml.pending`, while `.github/workflows/release.yml` retains the previously published version. The checkpoint code/docs can be pushed with the existing repository permission. A future owner-authorized workflow update can copy the pending candidate into `.github/workflows/release.yml` using an account with workflow permission. **Do not dispatch the old CI workflow as a complete Rust release build.** Local signed builds and manual `gh release create`/asset uploads do not require changing the workflow or exporting a signing key.
