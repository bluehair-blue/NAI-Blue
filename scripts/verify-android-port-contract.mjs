import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = path => readFileSync(join(root, path), 'utf8')
const readJson = path => JSON.parse(read(path))

function listSourceFiles(directory) {
    return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
        const relativePath = join(directory, entry.name)
        return entry.isDirectory() ? listSourceFiles(relativePath) : [relativePath]
    })
}

const pkg = readJson('package.json')
const rust = read('src-tauri/src/lib.rs')
const nativeNaiTransport = read('src-tauri/src/nai_transport.rs')
const cargoToml = read('src-tauri/Cargo.toml')
const tauriConfig = readJson('src-tauri/tauri.conf.json')
const desktopCapabilities = readJson('src-tauri/capabilities/default.json')
const viteConfig = read('vite.config.ts')
const indexHtml = read('index.html')
const retiredUrlPluginKey = ['deep', 'link'].join('-')
const retiredUrlPluginCrate = ['tauri', 'plugin', 'deep', 'link'].join('-')
const retiredUrlPluginRustModule = ['tauri', 'plugin', 'deep', 'link'].join('_')

const baseCargoDependencies = cargoToml.match(
    /\[dependencies\]([\s\S]*?)(?=\r?\n\[)/,
)?.[1]
const desktopCargoDependencies = cargoToml.match(
    /\[target\.'cfg\(any\(target_os = "windows", target_os = "linux", target_os = "macos"\)\)'\.dependencies\]([\s\S]*?)(?=\r?\n\[)/,
)?.[1]

assert.ok(baseCargoDependencies, 'Cargo.toml must keep a base dependencies section')
assert.ok(desktopCargoDependencies, 'Cargo.toml must keep a desktop dependency section')
assert.ok(
    !baseCargoDependencies.includes('tauri-plugin-updater'),
    'updater must not enable its TLS dependency graph on Android',
)
assert.ok(
    desktopCargoDependencies.includes('tauri-plugin-updater'),
    'desktop builds must retain the updater dependency',
)

assert.equal(pkg.scripts['dev:mobile'], 'vite --host 0.0.0.0')
assert.equal(pkg.scripts['tauri:android:init'], 'npx tauri android init')
assert.equal(pkg.scripts['tauri:android:dev'], 'npx tauri android dev --host 0.0.0.0')
assert.equal(pkg.scripts['tauri:android:build:apk'], 'npx tauri android build --apk')
assert.equal(pkg.scripts['tauri:android:build:aab'], 'npx tauri android build --aab')
assert.equal(
    pkg.scripts['release:android:apk'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-android.ps1',
)
assert.equal(
    pkg.scripts['release:android:github'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-android.ps1 -Publish',
)
assert.equal(pkg.scripts['test:android-port'], 'node scripts/verify-android-port-contract.mjs')
assert.equal(
    pkg.scripts['test:android-idle'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/track-android-idle.ps1',
)
assert.ok(
    existsSync(join(root, 'src-tauri/tauri.android.conf.json')),
    'src-tauri/tauri.android.conf.json must exist',
)
assert.ok(
    existsSync(join(root, 'scripts/track-android-idle.ps1')),
    'Android idle-loop tracking must remain available as a repeatable device check',
)
assert.ok(
    existsSync(join(root, 'scripts/release-android.ps1')),
    'Signed Android releases must use the local release script',
)

const androidConfig = readJson('src-tauri/tauri.android.conf.json')
const androidTargets = JSON.stringify(androidConfig.bundle?.targets ?? '')

assert.ok(!androidTargets.includes('apk'), 'bundle.targets must not include apk')
assert.ok(!androidTargets.includes('aab'), 'bundle.targets must not include aab')
assert.equal(androidConfig.build?.beforeDevCommand, 'npm run dev:mobile')
assert.equal(androidConfig.bundle?.android?.minSdkVersion, 24)
assert.deepEqual(androidConfig.bundle?.externalBin, [])
assert.equal(androidConfig.bundle?.createUpdaterArtifacts, false)
assert.equal(androidConfig.plugins?.[retiredUrlPluginKey], undefined)
assert.equal(tauriConfig.plugins?.[retiredUrlPluginKey], undefined)
assert.ok(!cargoToml.includes(retiredUrlPluginCrate))
assert.ok(!rust.includes(retiredUrlPluginRustModule))

assert.ok(
    existsSync(join(root, 'src-tauri/capabilities/mobile.json')),
    'Android builds require a mobile-only capability',
)
const mobileCapabilities = readJson('src-tauri/capabilities/mobile.json')
const mobilePermissions = JSON.stringify(mobileCapabilities.permissions)
const desktopPermissions = JSON.stringify(desktopCapabilities.permissions)

assert.deepEqual(desktopCapabilities.platforms, ['windows', 'linux', 'macOS'])
assert.deepEqual(mobileCapabilities.platforms, ['android', 'iOS'])
assert.ok(
    mobilePermissions.includes('$APPDATA/**'),
    'Android app-scoped storage requires APPDATA scope',
)
assert.ok(mobilePermissions.includes('fs:allow-write'), 'FS write permission must remain available')
assert.ok(mobilePermissions.includes('fs:allow-read'), 'FS read permission must remain available')
assert.ok(
    mobilePermissions.includes('fs:allow-stat'),
    'Startup snapshot and asset-profile checks require the stat command on mobile',
)
assert.ok(
    mobilePermissions.includes('fs:allow-write-file'),
    'Binary backup and snapshot writes require the write-file command on mobile',
)
assert.ok(
    mobilePermissions.includes('fs:allow-read-file'),
    'Binary backup and snapshot restores require the read-file command on mobile',
)
assert.ok(
    mobilePermissions.includes('fs:allow-write-text-file'),
    'Asset profile JSON writes require the text-file command on mobile',
)
assert.ok(
    mobilePermissions.includes('fs:allow-read-text-file'),
    'Asset profile JSON reads require the text-file command on mobile',
)
assert.ok(!mobilePermissions.includes('updater:'), 'mobile capability must not expose updater IPC')
assert.ok(!mobilePermissions.includes(`${retiredUrlPluginKey}:`), 'mobile capability must not expose retired URL callback IPC')
assert.ok(!desktopPermissions.includes(`${retiredUrlPluginKey}:`), 'desktop capability must not expose retired URL callback IPC')
// API tokens now use the frontend auth store and explicit generation guards.
// Keep the retired native vault out of every platform graph so capability,
// JavaScript, and Rust dependency removal cannot drift independently.
assert.ok(
    !mobilePermissions.includes('stronghold:'),
    'mobile capability must not expose retired Stronghold IPC',
)
assert.ok(
    !desktopPermissions.includes('stronghold:'),
    'desktop capability must not expose retired Stronghold IPC',
)
assert.ok(
    !cargoToml.includes('tauri-plugin-stronghold') && !rust.includes('tauri_plugin_stronghold'),
    'native dependency and startup graphs must not restore the retired Stronghold backend',
)
assert.equal(pkg.dependencies?.['@tauri-apps/plugin-stronghold'], undefined)
assert.ok(
    rust.includes('.manage(nai_transport::NaiTransportState::default())') &&
        rust.includes('nai_transport::nai_generate_request') &&
        rust.includes('nai_transport::cancel_nai_request'),
    'native startup must register the bounded Android NAI transport and cancellation commands',
)
assert.ok(
    nativeNaiTransport.includes('https://image.novelai.net/ai/generate-image') &&
        nativeNaiTransport.includes('https://image.novelai.net/ai/generate-image-stream') &&
        !/nai_generate_request\([\s\S]{0,500}\burl:\s*String/.test(nativeNaiTransport),
    'Android NAI transport must map an endpoint enum to fixed NovelAI URLs instead of accepting arbitrary URLs',
)
assert.ok(
    nativeNaiTransport.includes('NaiTransportEvent::BodyChunk') &&
        nativeNaiTransport.includes('BASE64_STANDARD.encode(part)') &&
        !nativeNaiTransport.includes('Channel<Response>') &&
        nativeNaiTransport.includes('tokio::select!') &&
        nativeNaiTransport.includes('NaiTransportEvent::Cancelled'),
    'Android NAI transport must serialize ordered mobile body chunks and interrupt reqwest work on cancellation',
)

const generatedManifestPath = join(root, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml')
if (existsSync(generatedManifestPath)) {
    const generatedManifest = readFileSync(generatedManifestPath, 'utf8')
    assert.ok(!generatedManifest.includes('android.intent.action.VIEW'))
    assert.ok(!generatedManifest.includes('android.intent.category.BROWSABLE'))
    for (const privilegedSystemPermission of [
        'android.permission.ACCESS_BROADCAST_RESPONSE_STATS',
        'android.permission.READ_SAFETY_CENTER_STATUS',
        'android.permission.SEND_SAFETY_CENTER_UPDATE',
    ]) {
        assert.ok(
            !generatedManifest.includes(privilegedSystemPermission),
            `NAI Blue must not request Google Play Services privileged permission ${privilegedSystemPermission}`,
        )
    }
}
for (const desktopWindowPermission of [
    'core:window:allow-minimize',
    'core:window:allow-toggle-maximize',
    'core:window:allow-start-dragging',
]) {
    assert.ok(
        !mobilePermissions.includes(desktopWindowPermission),
        `mobile capability must not expose ${desktopWindowPermission}`,
    )
}
assert.ok(/cfg_attr\(mobile,\s*tauri::mobile_entry_point\)/.test(rust))
assert.ok(
    /#\[cfg\(not\(mobile\)\)]\s*use tauri::\{LogicalPosition,\s*LogicalSize,\s*Manager,\s*RunEvent,\s*Url\};/.test(
        rust,
    ),
    'desktop-only embedded browser imports must stay out of mobile builds',
)
assert.ok(
    /#\[cfg\(not\(mobile\)\)]\s*use tauri_plugin_shell::\{process::CommandChild,\s*ShellExt\};/.test(
        rust,
    ),
    'desktop sidecar shell imports must stay out of mobile builds',
)
assert.ok(
    /#\[cfg\(not\(mobile\)\)][\s\S]*?async fn open_embedded_browser/.test(rust) &&
        /#\[cfg\(mobile\)][\s\S]*?async fn open_embedded_browser[\s\S]*?Embedded browser is not available on mobile/.test(
            rust,
        ),
    'embedded browser command must have desktop implementation and mobile stub',
)
assert.ok(
    /#\[cfg\(mobile\)][\s\S]*?async fn is_browser_open[\s\S]*?\{\s*false\s*\}/.test(rust),
    'is_browser_open mobile stub must return false',
)
assert.ok(
    /#\[cfg\(mobile\)][\s\S]*?async fn check_tagger_binary\(\) -> bool\s*\{\s*false\s*\}/.test(
        rust,
    ),
    'check_tagger_binary mobile stub must return false',
)
assert.ok(
    /#\[cfg\(mobile\)][\s\S]*?async fn start_tagger[\s\S]*?Tagger sidecar is not available on mobile/.test(
        rust,
    ),
    'tagger sidecar startup must have a mobile stub',
)
assert.ok(
    /#\[cfg\(not\(mobile\)\)][\s\S]*?tauri_plugin_updater::Builder::new\(\)[\s\S]*?builder = builder\.plugin\(updater_builder\.build\(\)\);/m.test(
        rust,
    ),
    'desktop updater plugin must stay behind a non-mobile cfg gate',
)

assert.ok(
    !existsSync(join(root, 'src-tauri/gen/android')) ||
        existsSync(join(root, 'src-tauri/gen/android/app')),
    'Android init output must be absent or contain src-tauri/gen/android/app',
)

assert.ok(
    viteConfig.includes('__NAI_BLUE_TAURI_PLATFORM__') &&
        viteConfig.includes('TAURI_ENV_PLATFORM'),
    'Vite must expose the Tauri build platform to frontend runtime gates',
)

assert.ok(existsSync(join(root, 'src/platform/runtime.ts')), 'src/platform/runtime.ts must exist')
assert.ok(existsSync(join(root, 'src/platform/browser.ts')), 'src/platform/browser.ts must exist')
assert.ok(existsSync(join(root, 'src/platform/storage.ts')), 'src/platform/storage.ts must exist')
assert.ok(existsSync(join(root, 'src/platform/capabilities.ts')), 'src/platform/capabilities.ts must exist')
assert.ok(existsSync(join(root, 'src/platform/portable-resources.ts')), 'src/platform/portable-resources.ts must exist')

const runtime = read('src/platform/runtime.ts')
const browser = read('src/platform/browser.ts')
const storage = read('src/platform/storage.ts')
const capabilities = read('src/platform/capabilities.ts')
const portableResources = read('src/platform/portable-resources.ts')
const webView = read('src/pages/WebView.tsx')
const mainMode = read('src/pages/MainMode.tsx')
const historyPanel = read('src/components/layout/HistoryPanel.tsx')
const threeColumnLayout = read('src/components/layout/ThreeColumnLayout.tsx')
const sheet = read('src/components/ui/sheet.tsx')
const localTagger = read('src/services/local-tagger-server.ts')
const shortcuts = read('src/hooks/useShortcuts.ts')
const promptGenerator = read('src/components/prompt/PromptGeneratorDialog.tsx')
const settingsPage = read('src/pages/Settings.tsx')
const autoBackup = read('src/lib/auto-backup.ts')
const storeSnapshots = read('src/lib/store-snapshots.ts')
const updateChecker = read('src/hooks/useUpdateChecker.tsx')

for (const symbol of [
    'supportsEmbeddedBrowser',
    'supportsLocalTaggerSidecar',
    'supportsKeyboardShortcuts',
    'isMobileRuntime',
]) {
    assert.ok(runtime.includes(`export const ${symbol}`), `runtime.ts must export ${symbol}`)
}

for (const capability of [
    'platform',
    'absoluteOutputPath',
    'externalProfileFileWatch',
    'localTaggerSidecar',
    'embeddedBrowser',
    'r2DeployTooling',
    'embeddedPngMetadataWrite',
    'supportedImageFormats',
]) {
    assert.ok(capabilities.includes(capability), `RuntimeCapabilities must expose ${capability}`)
}
assert.ok(
    capabilities.includes("platform === 'android'") &&
        capabilities.includes('reason') &&
        capabilities.includes('alternative'),
    'Android capability entries must provide explicit reasons and alternative workflows',
)
assert.ok(
    portableResources.includes('readyForGeneration') &&
        portableResources.includes('repairAction') &&
        portableResources.includes('exportIncludesOpaqueTokens: false') &&
        portableResources.includes('syncIncludesOpaqueTokens: false'),
    'portable resources must remain loadable, block unresolved generation, and redact platform tokens',
)

assert.ok(
    indexHtml.includes('viewport-fit=cover'),
    'mobile viewport must expose Android safe-area insets',
)
assert.ok(
    threeColumnLayout.includes('isMobileRuntime') &&
        threeColumnLayout.includes('!isMac && !isMobileRuntime') &&
        threeColumnLayout.includes('safe-area-inset-top') &&
        threeColumnLayout.includes('safe-area-inset-bottom'),
    'mobile shell must hide the desktop titlebar and respect both system insets',
)
assert.ok(
    sheet.includes('safe-area-inset-top'),
    'sheet close controls must remain below the mobile status bar',
)
assert.ok(
    threeColumnLayout.includes('fb-app-navigation') &&
        threeColumnLayout.includes('to="/folders"') &&
        threeColumnLayout.includes('to="/queue"') &&
        threeColumnLayout.includes('navItems.filter') &&
        threeColumnLayout.includes('min-h-11'),
    'mobile navigation must expose two labelled primary routes, Tools, and stable touch targets',
)
for (const symbol of [
    'MEDIA_STORAGE_BASE_DIRECTORY',
    'getMediaStorageRoot',
    'shouldUseAbsoluteMediaPath',
]) {
    assert.ok(storage.includes(`export ${symbol === 'MEDIA_STORAGE_BASE_DIRECTORY' ? 'const' : 'function'} ${symbol}`), `storage.ts must export ${symbol}`)
}
for (const [name, source] of [['MainMode', mainMode], ['HistoryPanel', historyPanel]]) {
    assert.ok(source.includes('@/platform/storage'), `${name} must use the platform storage adapter`)
    assert.ok(!source.includes('BaseDirectory.Picture'), `${name} must not hard-code Picture storage`)
    assert.ok(!source.includes('pictureDir'), `${name} must not resolve Picture paths directly`)
}
for (const [name, source] of [['AutoBackup', autoBackup], ['StoreSnapshots', storeSnapshots]]) {
    assert.ok(source.includes('@/platform/storage'), `${name} must use the platform storage adapter`)
    assert.ok(!source.includes('BaseDirectory.Picture'), `${name} must not hard-code Picture storage`)
}
for (const sourcePath of listSourceFiles('src')) {
    if (!/\.tsx?$/.test(sourcePath) || sourcePath === join('src', 'platform', 'storage.ts')) continue
    const source = read(sourcePath)
    assert.ok(
        !source.includes('BaseDirectory.Picture') && !source.includes('pictureDir'),
        `${sourcePath} must resolve media storage through src/platform/storage.ts`,
    )
}
assert.ok(
    updateChecker.includes("@/platform/runtime") &&
        /useEffect\(\(\) => \{\s*if \(isMobileRuntime\) return/.test(updateChecker),
    'automatic updater checks must stop before scheduling native IPC on mobile',
)
assert.ok(
    settingsPage.includes("@/platform/runtime") &&
        settingsPage.includes('{!isMobileRuntime && (') &&
        settingsPage.includes('{!isMobileRuntime && pendingUpdate && appVersion && (() => {'),
    'mobile settings must not render desktop updater actions',
)

assert.ok(
    browser.includes("@tauri-apps/plugin-opener") &&
        browser.includes('openUrl') &&
        browser.includes('supportsEmbeddedBrowser'),
    'browser adapter must use plugin-opener when embedded browser is unavailable',
)
for (const command of [
    'open_embedded_browser',
    'close_embedded_browser',
    'navigate_embedded_browser',
    'resize_embedded_browser',
    'hide_embedded_browser',
    'show_embedded_browser',
    'zoom_embedded_browser',
    'is_browser_open',
]) {
    assert.ok(browser.includes(command), `browser adapter must own ${command}`)
    assert.ok(!webView.includes(command), `WebView.tsx must not directly invoke ${command}`)
}
assert.ok(!webView.includes("@tauri-apps/api/core"), 'WebView.tsx must not import invoke directly')
assert.ok(webView.includes("@/platform/browser"), 'WebView.tsx must use the browser adapter')

assert.ok(
    localTagger.includes('supportsLocalTaggerSidecar') &&
        localTagger.includes('isLocalTaggerServerSupported') &&
        localTagger.indexOf('supportsLocalTaggerSidecar') < localTagger.indexOf("invoke('start_tagger')"),
    'local tagger service must gate sidecar startup before invoking start_tagger',
)
assert.ok(
    shortcuts.includes('supportsKeyboardShortcuts') &&
        shortcuts.includes('!supportsKeyboardShortcuts || !enabled'),
    'keyboard shortcut hook must no-op on mobile runtimes',
)
assert.ok(
    promptGenerator.includes('supportsLocalTaggerSidecar') &&
        promptGenerator.includes('canVerifyDanbooru'),
    'Danbooru verifier UI must be disabled when the local tagger sidecar is unsupported',
)
// When Android-specific capabilities are split out, this contract should also
// reject desktop-only updater and shell permissions from that mobile surface.
console.log('Android port contract passed.')
