# ZOET by Otium 2.0 — Rust architecture

The authored application logic is implemented in Rust. This includes the UI state and DOM rendering, catalogue adapters and identity matching, playback orchestration, provider extraction, caching and media proxying. It does not mean every dependency or operating-system interface is written in Rust.

| Layer | Implementation | Purpose |
| --- | --- | --- |
| UI, navigation, catalogue and playback state | `rust/otium-ui`, compiled to WebAssembly | Runs the same application in Android WebView and a desktop/mobile browser. |
| Provider and network engine | `rust/otium-core` | Fetches and parses Krmzi, forwards the supported read-only Cinemana routes, resolves mirrors and streams media. |
| Android integration | `MainActivity.kt`, `RustApi.kt` | WebView, JNI, Android lifecycle, fullscreen/orientation, Picture in Picture and remote events. Provider work runs in Rust. |
| Browser integration | Generated `wasm-bindgen` JavaScript | Connects WebAssembly to browser APIs. It is generated from Rust sources. |
| HLS compatibility | Vendored `hls.js` | Uses Media Source Extensions where the browser lacks native HLS. Video decoding uses the platform media stack. |
| Presentation | HTML/CSS, fonts and artwork | Styles and accessible document structure. |

The Android application ID and existing signing identity stay stable so compatible installed versions can update in place. Existing `krmzi_*` storage names are retained where needed for local viewing history and favourites.

## Build the web application

Install Rust, the `wasm32-unknown-unknown` target and the matching `wasm-bindgen` CLI, then run:

```powershell
./scripts/build-rust-ui.ps1
cargo run --manifest-path rust/otium-core/Cargo.toml --locked --release
```

The Rust HTTP host defaults to `127.0.0.1:3000`. `PORT` changes the port; `OTIUM_BIND` can specify an explicit bind address, and `OTIUM_PUBLIC` can point to a deployed copy of `public/`. The built server does not need Node.js. The host serves the WebAssembly file as `application/wasm`.

For a read-only provider probe without opening a listening port:

```powershell
cargo run --manifest-path rust/otium-core/Cargo.toml --locked -- --request /api/health
```

## Build Android

Install Android NDK and the Rust targets `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android` and `x86_64-linux-android`. The checked-in PowerShell build script discovers the NDK from `ANDROID_NDK_HOME` or `ANDROID_HOME` and supports a subset via `-Abis`:

```powershell
./scripts/build-rust-ui.ps1
./scripts/build-rust-android.ps1
# Run the repository Android release build after the web assets have been synchronized.
```

The native script emits `libotium_core.so` for arm64-v8a, armeabi-v7a, x86 and x86_64 into Android's generated `jniLibs/` directory. It targets API 24 and uses 16 KiB ELF segment alignment. Build outputs and private signing material are excluded from source control. See [SIGNING.md](SIGNING.md) for signing requirements.

## API and failure handling

- `/api/home`, `/api/series`, `/api/episodes` and `/api/search` use one-based application pages and expose `hasNext` and `nextPage`. Cinemana's own zero-based pagination is translated by its Rust adapter.
- `/api/episode/detail?url=...&server=...` resolves the requested listed OK mirror. It never substitutes an unrelated mirror while labelling it as the selected server. Unsupported or unavailable direct sources retain their explicit embed fallback.
- Concurrent requests for one catalogue/episode share a resolution, including failures. A failed or incomplete catalogue response is not cached as a successful empty list.
- Signed stream details expire after 45 seconds, with no stale-on-error fallback. `fresh=1` forces a refresh. Media, subtitles and signed detail responses use `Cache-Control: no-store`.
- The media proxy permits HTTPS OK/VK CDN hosts only and checks every redirect. HLS child manifests, segments and encryption-key URLs are rewritten to the same-origin proxy. Cinemana subtitle requests are restricted to the expected VTT host/path.
- Media bodies stream in bounded chunks through the HTTP host or JNI, rather than collecting an entire video in memory. JNI closes ownership on EOF, error or explicit close.
- Provider timeouts and an unavailable Cinemana network remain visible; this integration cannot remove the source's network restrictions.

## Verification

```powershell
cargo test --manifest-path rust/otium-core/Cargo.toml --locked
cargo clippy --manifest-path rust/otium-core/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path rust/otium-ui/Cargo.toml --locked
```

The core tests cover paginated routes, provider parsing, encoded links and numeric mirror IDs, first-ready mirror selection and cancellation, cache coalescing and expiry, partial-source failures, strict URL validation, HLS rewriting, streamed reads, and real HTTP serving of health/static WebAssembly responses.

UI animation follows the browser's display refresh timing. A 120 Hz screen allows an 8.33 ms frame budget; Rust and compositor-friendly animation alone do not guarantee 120 fps on every device. On-device frame timing and real Android/TV playback still need physical-device verification.
