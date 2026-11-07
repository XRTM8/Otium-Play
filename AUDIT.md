# ZOET by Otium 2.0 — findings and verification

| Problem | Change | Verification |
| --- | --- | --- |
| Only the first catalogue page appeared | Paginated catalogue/search in Rust UI and native/web APIs; independent source progress | Live192Krmzi titles/5pages; browser multi-page/repeated-page guard |
| Cinemana search returned unrelated titles | UTF8 Base64URL request encoding | Official source inspection, live query and unit/browser assertions |
| Dubbed and original episode numbering could be confused | Edition-aware identity and matching | Rust edition tests, real provider variants inspected |
| Source changes lost position or stalled playback | Stage metadata before switching; preserve settings; abort races; roll back media failure | Actual WASM browser switching/mirror/failure tests |
| Broken HLS routing/lifecycle | Restricted OK proxy, direct Cinemana HLS, scoped callbacks and cleanup | HLS browser fixtures plus real decoded video |
| History could restart from0 or open Cinemana episodes as series | Merge saved progress with context; explicit episode identity; sanitized records | Browser history/favourite regressions |
| Canceled search could remain loading | Generation/abort cleanup and reload preserved query | Browser close/reopen/source-change tests |
| Overloaded interface | Separate series/movies grids; vertical episode detail; dark glass controls | Real screenshots and4viewport+2TVlayout checks |
| Risky120FPS claim and blanket GPU hints | Remove forced per-card layers; support reduced motion; request compatible refresh rate | Code review; no physical-device FPS claim |
| Duplicate Node/Kotlin scraping implementations | Shared Rust core, RustWASM authored application logic | Native4ABI builds, Rust tests, standalone HTTP tests, Android lint/build |
| Offline UI could depend on old JS bundle | Versioned atomic WASM shell cache; no API/stream cache | Offline browser boot regression |

Physical Android/TV playback and frame timings still require supported hardware. Cinemana network restrictions remain upstream-controlled. Cross-origin external iframe players cannot reliably share timeline/pause state; direct-source switching preserves settings. Exact matching intentionally refuses ambiguous remakes, dubbed cuts or episode numbers. See HANDOFF.md for current build/release checkpoint and reproducible commands.
