# NAI Blue release guide

NAI Blue releases are built from an immutable `v<package version>` tag on `main`.
The public version line was reset to `1.0.0`; this is a version-label reset only.
Do not reset features, persisted stores, the application identifier, credential
services, or legacy-read compatibility when preparing a release.

## Release identity

- Repository: `bluehair-blue/NAI-Blue`
- Desktop product: `NAI Blue`
- Application identifier: `blue.bluehair.naiblue`
- Android application ID: `blue.bluehair.naiblue`
- Android signer certificate SHA-256: pinned in `android-release-policy.json`
- Android version name: package version
- Android version code: explicit monotonic value from
  `android-release-policy.json`, independent of the reset display version

Keeping the install identity stable lets an existing installation and its
operating-system credentials continue across the rename. Compatibility keys
whose serialized names predate NAI Blue may be read by migration code, but new
data must use the current names.

## Required release checks

Use Node.js 24 LTS and Rust 1.93 or newer. Before tagging, run:

```powershell
npm ci
npm run lint
npm run test:release-version
npm run test:android-release-contract
npm run test:composition
npm run build
npm run test:responsive-layout
npm run tauri build
```

The release version must agree in `package.json`, `package-lock.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`.
The Android version code is bumped by hand in `android-release-policy.json` and
`src-tauri/tauri.android.conf.json`; it must be strictly newer than the published
baseline recorded in the policy file. `npm run test:release-version` checks all
of these.

Review the generated installers, updater metadata, signatures, and hashes. The
Windows updater uses NSIS so an existing pre-rename installation can accept the
reset display version through the app's explicit downgrade-compatible updater
check.

## Tag and GitHub Actions

After all changes are committed and `main` is pushed, wait for the Android APK
run on that `main` commit and tag only when its `source-contract` and
`debug-install` jobs are green. The tag build runs the same checks, and a `v*`
tag can never be deleted or moved, so a red check there costs the version number.

```powershell
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
git tag -a "v$version" -m "NAI Blue $version"
git push origin "v$version"
```

`.github/workflows/build.yml` verifies that the tag matches the version sources
and belongs to `main`, then builds desktop artifacts as a draft release.
`.github/workflows/android.yml` builds and verifies the signed universal APK,
uploads it, and publishes the cross-platform release.

The run pauses at `android / signed-build` until a reviewer approves the
`android-release` environment. Until then the release stays a draft that holds
only the desktop assets. macOS is compiled only by this tag build; no earlier
check covers it.

The protected `android-release` GitHub Environment must provide:

- `NAI_BLUE_KEYSTORE_BASE64`
- `NAI_BLUE_KEYSTORE_PASSWORD`

These existing secret names are retained as release-infrastructure
compatibility. They are not product branding and must never be printed or
committed. The environment should require a reviewer and permit only immutable
`v*` tag deployments.

## Local Android fallback

Keep the release keystore outside the repository:

```powershell
$env:APK_RELEASE_KEYSTORE_PATH = "$env:USERPROFILE\.nai-blue\nai-blue-release.jks"
$env:APK_RELEASE_KEY_PASSWORD = '<password>'
npm run release:android:apk
```

The command verifies the signer, package ID, explicit version code, min/target
SDK, supported ABIs, and 16 KiB alignment. Its output is:

```text
release-artifacts/android/NAI-Blue_<version>-universal.apk
release-artifacts/android/NAI-Blue_<version>-universal.apk.sha256
```

`npm run release:android:github` is a guarded fallback. It requires a clean tree
and matching local and remote immutable tags, refuses to replace an existing
asset, and verifies the downloaded hash.

## Security and rollback rules

Never commit a keystore, Base64 key export, `.env`, generated
`keystore.properties`, token, or private metadata sidecar. If signing material
is exposed, stop the release and plan a signing-key migration.

Do not delete or move a published tag and do not replace a published asset with
different bytes. Publish a new version instead. A rollback must preserve the
stable application identity and data migrations; never uninstall or clear user
data as part of an automated recovery.
