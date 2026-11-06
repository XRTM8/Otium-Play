# Otium Play continuation

Read `HANDOFF.md` before changing this repository. It contains the current user requirements, completed Rust migration, verification evidence, remaining release work, and signing constraints.

- Continue on `main`; the user explicitly requested keeping only the main branch.
- The runtime application logic is now Rust: `rust/otium-ui` (WASM) and `rust/otium-core` (native/JNI/web host). Do not restore the deleted JavaScript app or Kotlin scraper as the default runtime.
- Preserve Android application ID `com.krmzi.app` and compatible local storage keys.
- Never commit `.signing/`, `android/signing.properties`, private keys, generated native libraries, `ep.json`, or `home.json`. The two JSON files predate this task and contain live fixtures; leave them untouched.
- Build the WASM UI and synchronize assets with `scripts/build-rust-ui.ps1` before Android packaging. Build JNI with `scripts/build-rust-android.ps1` after core changes.
- Use the retained local signing configuration. Do not upload a private signing key to GitHub Secrets without explicit approval to export it. Local APK signing and authorized release asset upload are separate from private-key export.
- Report browser fixture tests, live upstream/video tests, and physical-device tests separately. No Android/TV hardware was tested in this work. Never promise guaranteed120FPS.
