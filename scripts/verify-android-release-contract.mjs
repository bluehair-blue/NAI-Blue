import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
    patchAndroidBackDispatcher,
    patchAndroidKotlinToolchain,
    patchAndroidSigning,
    patchAndroidTargetSdk,
} from './patch-android-signing.mjs'
import {
    resolveAndroidUpdateBaseline,
    resolveAndroidUpdateBaselineVersionCode,
    resolveAndroidVersionCode,
} from './android-update-baseline.mjs'

const root = process.cwd()
const read = path => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))
const policy = JSON.parse(read('android-release-policy.json'))
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'))
const android = JSON.parse(read('src-tauri/tauri.android.conf.json'))

assert.equal(policy.applicationId, tauri.identifier)
assert.equal(policy.debugApplicationIdSuffix, '')
assert.equal(policy.minSdkVersion, android.bundle.android.minSdkVersion)
assert.equal(policy.versionCode, android.bundle.android.versionCode)
assert.equal(policy.targetSdkVersion, 36)
assert.match(policy.signing.certificateSha256, /^[A-F0-9]{64}$/)
assert.deepEqual(policy.updateBaseline, { tag: 'v1.1.0', versionCode: 2011006 })
assert.equal(policy.firstReleaseForApplicationId, false)
assert.equal(policy.firstReleaseVersion, undefined)
assert.equal(resolveAndroidUpdateBaseline(policy, pkg.version), 'v1.1.0')
assert.equal(resolveAndroidVersionCode(policy, pkg.version), policy.versionCode)
assert.equal(resolveAndroidUpdateBaselineVersionCode(policy, pkg.version), 2011006)
assert.throws(
    () => resolveAndroidUpdateBaseline({ updateBaseline: null }, pkg.version),
    /first release of an applicationId/,
)
assert.throws(
    () =>
        resolveAndroidUpdateBaseline(
            {
                updateBaseline: null,
                firstReleaseForApplicationId: true,
                firstReleaseVersion: pkg.version,
            },
            '2.8.4',
        ),
    /limited to firstReleaseVersion/,
)
assert.equal(
    resolveAndroidUpdateBaseline({
        updateBaseline: { tag: 'v2.8.0' },
        firstReleaseForApplicationId: false,
    }, pkg.version),
    'v2.8.0',
)
assert.throws(
    () =>
        resolveAndroidUpdateBaseline({
            updateBaseline: { tag: 'v2.8.0' },
            firstReleaseForApplicationId: true,
        }, pkg.version),
    /requires firstReleaseForApplicationId to be false/,
)
assert.throws(
    () =>
        resolveAndroidUpdateBaseline({
            updateBaseline: { tag: '2.8.0' },
            firstReleaseForApplicationId: false,
        }, pkg.version),
    /stable v<major>\.<minor>\.<patch> form/,
)
assert.throws(
    () => resolveAndroidUpdateBaseline({ updateBaseline: { tag: 'v2.8.0' } }, pkg.version),
    /requires firstReleaseForApplicationId to be false/,
)
assert.throws(
    () =>
        resolveAndroidUpdateBaseline(
            { updateBaseline: { tag: 'v2.1000.0' }, firstReleaseForApplicationId: false },
            pkg.version,
        ),
    /outside the supported versionCode range/,
)
assert.ok(policy.signing.keyAlias)
assert.deepEqual(policy.requiredAbis, ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'])
assert.match(pkg.devDependencies.playwright, /^\d+\.\d+\.\d+$/)

assert.equal(pkg.scripts['android:prepare'], 'node scripts/prepare-android-release.mjs')
assert.equal(pkg.scripts['test:release-version'], 'node scripts/verify-release-version.mjs')
assert.equal(
    pkg.scripts['test:android-release-contract'],
    'node scripts/verify-android-release-contract.mjs',
)
assert.equal(
    pkg.scripts['test:android-release'],
    'node scripts/verify-android-apk.mjs --mode release',
)
assert.equal(pkg.scripts['test:android-debug'], 'node scripts/verify-android-apk.mjs --mode debug')

for (const path of [
    'scripts/verify-release-version.mjs',
    'scripts/android-update-baseline.mjs',
    'scripts/patch-android-signing.mjs',
    'scripts/prepare-android-release.mjs',
    'scripts/verify-android-apk.mjs',
    '.github/workflows/android.yml',
]) {
    assert.ok(read(path).length > 0, `${path} must exist`)
}

const workflow = read('.github/workflows/android.yml')
for (const requiredText of [
    'secrets.NAI_BLUE_KEYSTORE_BASE64',
    'secrets.NAI_BLUE_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'npm run android:prepare',
    'npm run test:release-version',
    'npm run test:android-release',
    'signed-build:',
    'signed-install:',
    'publish-android:',
    'environment: android-release',
    'inputs.release',
    'GH_REPO: ${{ github.repository }}',
    'Remove signing material',
    'contents: read',
    'contents: write',
    'outputs/apk/universal/debug/app-universal-debug.apk',
    'android-release-policy.json',
    'npm run test:responsive-layout',
    'playwright install --with-deps chromium',
    'verify_or_upload',
    'workflow_call:',
    'NAI_BLUE_KEYSTORE_BASE64:',
    'NAI_BLUE_KEYSTORE_PASSWORD:',
]) {
    assert.ok(workflow.includes(requiredText), `Android workflow must include ${requiredText}`)
}
assert.ok(
    workflow.indexOf('Remove signing material') < workflow.indexOf('signed-install:'),
    'Signing material must be removed before the no-secret emulator job starts',
)
assert.match(
    workflow,
    /script: >-\s+npm run test:android-release --\s+--apk "release-artifacts\/android\/\$\{\{ needs\.signed-build\.outputs\.asset_name \}\}"\s+--install/,
    'The isolated installer must pass the signed-build artifact explicitly to the release verifier',
)
assert.ok(!workflow.includes('Download pinned update baseline'))
assert.ok(!workflow.includes('NAI-Blue_2.8.0-baseline.apk'))

const desktopWorkflow = read('.github/workflows/build.yml')
for (const requiredText of [
    "if: startsWith(github.ref, 'refs/tags/v')",
    'release-preflight:',
    'node scripts/verify-release-version.mjs --tag "$GITHUB_REF_NAME"',
    'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main',
    'needs: release-preflight',
    'releaseDraft: true',
    'needs: desktop',
    'release: true',
    'NAI_BLUE_KEYSTORE_BASE64: ${{ secrets.NAI_BLUE_KEYSTORE_BASE64 }}',
    'NAI_BLUE_KEYSTORE_PASSWORD: ${{ secrets.NAI_BLUE_KEYSTORE_PASSWORD }}',
]) {
    assert.ok(desktopWorkflow.includes(requiredText), `Desktop workflow must include ${requiredText}`)
}
assert.ok(!desktopWorkflow.includes('secrets: inherit'))
assert.ok(!desktopWorkflow.includes('ANDROID_KEY_BASE64: ${{ secrets.NAI_BLUE_KEYSTORE_BASE64 }}'))
assert.ok(!desktopWorkflow.includes('ANDROID_KEY_PASSWORD: ${{ secrets.NAI_BLUE_KEYSTORE_PASSWORD }}'))
assert.ok(workflow.includes('gh release edit "$GITHUB_REF_NAME" --draft=false'))

for (const [name, source] of [
    ['Android workflow', workflow],
    ['desktop workflow', desktopWorkflow],
]) {
    const actionReferences = [...source.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map(
        match => match[1],
    )
    for (const reference of actionReferences) {
        if (reference.startsWith('./')) continue
        assert.match(
            reference,
            /^[^@]+@[a-f0-9]{40}$/,
            `${name} action must use a full commit SHA: ${reference}`,
        )
    }
}

const gitignore = read('.gitignore')
for (const ignoredSecret of [
    'nai-blue-release-key',
    'NAI_BLUE_KEYSTORE_BASE64.txt',
    'keystore.properties',
    '*.jks',
    '*.keystore',
    '/keystore_base64.txt',
    '*.p12',
    '*.pfx',
    '.env.*',
]) {
    assert.ok(gitignore.includes(ignoredSecret), `.gitignore must exclude ${ignoredSecret}`)
}

const localRelease = read('scripts/release-android.ps1')
assert.ok(localRelease.includes('android-release-policy.json'))
assert.ok(localRelease.includes('scripts\\patch-android-signing.mjs'))
assert.ok(localRelease.includes('npm run test:android-release'))
assert.ok(localRelease.includes('ANDROID_KEYSTORE_PATH'))
assert.ok(localRelease.includes('ANDROID_KEY_PASSWORD'))
assert.ok(!localRelease.includes('WriteAllText($keystorePropertiesPath'))

const prepareRelease = read('scripts/prepare-android-release.mjs')
assert.ok(!prepareRelease.includes("requiredEnvironment('ANDROID_KEY_PASSWORD')"))
assert.ok(!prepareRelease.includes('writeFileSync'))
assert.ok(prepareRelease.includes('patchAndroidBackDispatcher'))
assert.ok(prepareRelease.includes('patchAndroidTargetSdk(gradleFile, policy.targetSdkVersion)'))

const localSignedBuild = read('scripts/build-android-signed-local.ps1')
assert.ok(localSignedBuild.includes('scripts\\patch-android-signing.mjs'))

const temporaryRoot = mkdtempSync(join(tmpdir(), 'nai-blue-android-signing-'))
try {
    const rootBuildFile = join(temporaryRoot, 'root-build.gradle.kts')
    writeFileSync(
        rootBuildFile,
        `dependencies {
    classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
}
`,
    )
    assert.equal(patchAndroidKotlinToolchain(rootBuildFile), true)
    assert.equal(patchAndroidKotlinToolchain(rootBuildFile), false)
    assert.match(readFileSync(rootBuildFile, 'utf8'), /kotlin-gradle-plugin:2\.1\.20/)

    const gradleFile = join(temporaryRoot, 'build.gradle.kts')
    writeFileSync(
        gradleFile,
        `import java.util.Properties

plugins {
    id("com.android.application")
}

android {
    buildTypes {
        getByName("debug") {
            isDebuggable = true
        }
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}
`,
    )
    assert.equal(patchAndroidSigning(gradleFile), true)
    const once = readFileSync(gradleFile, 'utf8')
    assert.equal(patchAndroidSigning(gradleFile), false)
    const twice = readFileSync(gradleFile, 'utf8')
    assert.equal(twice, once, 'Gradle signing patch must be idempotent')
    assert.equal((twice.match(/NAI_BLUE_ANDROID_SIGNING_START/g) ?? []).length, 1)
    assert.equal((twice.match(/NAI_BLUE_ANDROID_SIGNING_CONFIG/g) ?? []).length, 1)
    assert.equal((twice.match(/NAI_BLUE_ANDROID_DEBUG_ID/g) ?? []).length, 1)
    assert.equal((twice.match(/naiBlueUserSigningConfig\?\.let \{ signingConfig = it \}/g) ?? []).length, 2)
    assert.doesNotMatch(twice, /applicationIdSuffix\s*=/)

    // The Tauri CLI 2.12 template ships compileSdk and targetSdk 37; only targetSdk follows the policy.
    const sdkGradleFile = join(temporaryRoot, 'sdk-build.gradle.kts')
    writeFileSync(
        sdkGradleFile,
        `android {
    compileSdk = 37
    defaultConfig {
        minSdk = 24
        targetSdk = 37
    }
}
`,
    )
    assert.equal(patchAndroidTargetSdk(sdkGradleFile, policy.targetSdkVersion), true)
    assert.equal(patchAndroidTargetSdk(sdkGradleFile, policy.targetSdkVersion), false)
    const patchedSdkGradle = readFileSync(sdkGradleFile, 'utf8')
    assert.match(patchedSdkGradle, new RegExp(`targetSdk = ${policy.targetSdkVersion}\\b`))
    assert.match(patchedSdkGradle, /compileSdk = 37\b/)
    assert.match(patchedSdkGradle, /minSdk = 24\b/)
    assert.throws(() => patchAndroidTargetSdk(gradleFile, policy.targetSdkVersion), /Expected one targetSdk declaration/)

    const manifestFile = join(temporaryRoot, 'AndroidManifest.xml')
    writeFileSync(
        manifestFile,
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="NAI Blue" />
</manifest>
`,
    )
    assert.equal(patchAndroidBackDispatcher(manifestFile), true)
    const patchedManifest = readFileSync(manifestFile, 'utf8')
    assert.equal(patchAndroidBackDispatcher(manifestFile), false)
    assert.equal(
        (patchedManifest.match(/android:enableOnBackInvokedCallback="true"/g) ?? []).length,
        1,
    )
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
}

console.log('Android release contract passed.')
