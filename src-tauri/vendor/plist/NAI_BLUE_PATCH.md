# NAI Blue plist Patch

Source: `ebarnard/rust-plist` commit `58a19eb1c45cf7f92ec22947ff18fba2c416a9c0`.

Reason: Tauri 2.11.x depended on `plist 1.9.0`. The published crate pins
`quick-xml ^0.39.2`, which leaves `quick-xml 0.39.x` in `Cargo.lock` and
triggers `RUSTSEC-2026-0194`. Tauri 2.12.x (`tauri-utils 2.10.4`) accepts
`plist ^1`, and this patch still holds it on the 1.9.0 source.

Local delta: only `Cargo.toml` changes, raising `quick-xml` to `0.41.0`.
The vendored crate was verified with `cargo check` before wiring it through
`src-tauri/Cargo.toml` using `[patch.crates-io]`.

Removal condition: delete this vendor patch once crates.io publishes a `plist`
release that depends on `quick-xml >=0.41.0` and Tauri resolves to it.

Status 2026-11-27: the condition is met on paper. crates.io has `plist 1.10.x`
on `quick-xml 0.41`/`0.42`, and Tauri 2.12 would resolve to it without this
patch. The patch stays until a macOS build has compiled against the published
crate, because only tag builds compile macOS and a failed tag cannot be reused.
