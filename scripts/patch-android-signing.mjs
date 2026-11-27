import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const START_MARKER = '// NAI_BLUE_ANDROID_SIGNING_START'
const END_MARKER = '// NAI_BLUE_ANDROID_SIGNING_END'
const CONFIG_MARKER = '// NAI_BLUE_ANDROID_SIGNING_CONFIG'
const DEBUG_ID_MARKER = '// NAI_BLUE_ANDROID_DEBUG_ID'
const ANDROID_KOTLIN_VERSION = '2.1.20'

// Tauri owns the generated root build file, while the tracked transfer module
// depends on AndroidX. Normalizing the compiler here connects regenerated
// projects to WorkManager's Kotlin 2.1 metadata without tracking generated files.
export function patchAndroidKotlinToolchain(buildFile, version = ANDROID_KOTLIN_VERSION) {
    const absolutePath = resolve(buildFile)
    const original = readFileSync(absolutePath, 'utf8')
    const kotlinPlugin = /classpath\("org\.jetbrains\.kotlin:kotlin-gradle-plugin:[^"]+"\)/g
    const matches = original.match(kotlinPlugin) ?? []
    if (matches.length !== 1) {
        throw new Error(
            `Expected one Kotlin Gradle plugin declaration in ${absolutePath}, found ${matches.length}`,
        )
    }
    const content = original.replace(
        kotlinPlugin,
        `classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${version}")`,
    )
    if (content !== original) {
        writeFileSync(absolutePath, content, 'utf8')
    }
    return content !== original
}

// Tauri's template targets the newest Android API (37 since CLI 2.12), while
// android-release-policy.json pins the level this app was tested against and the
// release scripts refuse any other value. compileSdk stays the template's: it only
// has to satisfy the bundled AndroidX artifacts, whereas targetSdk switches runtime behavior.
export function patchAndroidTargetSdk(gradleFile, targetSdkVersion) {
    if (!Number.isInteger(targetSdkVersion) || targetSdkVersion < 1) {
        throw new Error(`Invalid Android targetSdkVersion: ${targetSdkVersion}`)
    }
    const absolutePath = resolve(gradleFile)
    const original = readFileSync(absolutePath, 'utf8')
    const declaration = /\btargetSdk\s*=\s*\d+/g
    const matches = original.match(declaration) ?? []
    if (matches.length !== 1) {
        throw new Error(
            `Expected one targetSdk declaration in ${absolutePath}, found ${matches.length}`,
        )
    }
    const content = original.replace(declaration, `targetSdk = ${targetSdkVersion}`)
    if (content !== original) {
        writeFileSync(absolutePath, content, 'utf8')
    }
    return content !== original
}

function removeManagedSigning(content) {
    return content
        .replace(
            /^[ \t]*\/\/ NAI_BLUE_(?:LOCAL_APK|ANDROID)_SIGNING_START[\s\S]*?^[ \t]*\/\/ NAI_BLUE_(?:LOCAL_APK|ANDROID)_SIGNING_END[ \t]*\r?\n?/gm,
            '',
        )
        .replace(
            /^[ \t]*\/\/ NAI_BLUE_(?:LOCAL_APK|ANDROID)_SIGNING_CONFIG[ \t]*\r?\n[^\r\n]*\r?\n?/gm,
            '',
        )
        .replace(
            /^[ \t]*\/\/ NAI_BLUE_ANDROID_DEBUG_ID[ \t]*\r?\n[^\r\n]*\r?\n?/gm,
            '',
        )
}

export function patchAndroidSigning(gradleFile, debugApplicationIdSuffix = '') {
    const absolutePath = resolve(gradleFile)
    const original = readFileSync(absolutePath, 'utf8')
    const newline = original.includes('\r\n') ? '\r\n' : '\n'
    let content = removeManagedSigning(original)

    if (
        /\bsigningConfigs\s*\{/.test(content) ||
        /\bsigningConfig\s*=/.test(content) ||
        /\bapplicationIdSuffix\s*=/.test(content)
    ) {
        throw new Error(
            `Refusing to replace an unmanaged Android signing or debug ID configuration in ${absolutePath}`,
        )
    }
    if (debugApplicationIdSuffix !== '' && !/^\.[a-z][a-z0-9_.]*$/i.test(debugApplicationIdSuffix)) {
        throw new Error(`Invalid Android debug application ID suffix: ${debugApplicationIdSuffix}`)
    }

    const imports = []
    if (!/^import java\.io\.FileInputStream\s*$/m.test(content)) {
        imports.push('import java.io.FileInputStream')
    }
    if (!/^import java\.util\.Properties\s*$/m.test(content)) {
        imports.push('import java.util.Properties')
    }
    if (imports.length > 0) {
        content = `${imports.join(newline)}${newline}${content}`
    }

    const signingBlock = [
        `    ${START_MARKER}`,
        '    val naiBlueKeystorePropertiesFile = rootProject.file("keystore.properties")',
        '    val naiBlueKeystoreProperties = Properties()',
        '    if (naiBlueKeystorePropertiesFile.exists()) {',
        '        FileInputStream(naiBlueKeystorePropertiesFile).use { naiBlueKeystoreProperties.load(it) }',
        '    }',
        '    val naiBlueStoreFile = System.getenv("ANDROID_KEYSTORE_PATH")',
        '        ?: naiBlueKeystoreProperties.getProperty("storeFile")',
        '    val naiBlueKeyAlias = System.getenv("ANDROID_KEY_ALIAS")',
        '        ?: naiBlueKeystoreProperties.getProperty("keyAlias")',
        '    val naiBluePassword = System.getenv("ANDROID_KEY_PASSWORD")',
        '        ?: naiBlueKeystoreProperties.getProperty("password")',
        '        ?: naiBlueKeystoreProperties.getProperty("storePassword")',
        '',
        '    val naiBlueUserSigningConfig = if (naiBlueStoreFile != null && naiBlueKeyAlias != null && naiBluePassword != null) {',
        '        signingConfigs.create("release") {',
        '            keyAlias = naiBlueKeyAlias',
        '            keyPassword = System.getenv("ANDROID_KEY_PASSWORD")',
        '                ?: naiBlueKeystoreProperties.getProperty("keyPassword")',
        '                ?: naiBluePassword',
        '            storeFile = file(naiBlueStoreFile)',
        '            storePassword = naiBluePassword',
        '        }',
        '    } else {',
        '        null',
        '    }',
        `    ${END_MARKER}`,
        '',
    ].join(newline)

    const buildTypesAnchor = '    buildTypes {'
    const buildTypesIndex = content.indexOf(buildTypesAnchor)
    if (buildTypesIndex < 0) {
        throw new Error(`Could not find the Android buildTypes block in ${absolutePath}`)
    }
    content = content.slice(0, buildTypesIndex) + signingBlock + content.slice(buildTypesIndex)

    const releaseAnchor = '        getByName("release") {'
    const releaseIndex = content.indexOf(releaseAnchor)
    if (releaseIndex < 0) {
        throw new Error(`Could not find the Android release build type in ${absolutePath}`)
    }
    const releaseConfig = [
        releaseAnchor,
        `            ${CONFIG_MARKER}`,
        '            naiBlueUserSigningConfig?.let { signingConfig = it }',
    ].join(newline)
    content =
        content.slice(0, releaseIndex) +
        releaseConfig +
        content.slice(releaseIndex + releaseAnchor.length)

    const debugAnchor = '        getByName("debug") {'
    const debugIndex = content.indexOf(debugAnchor)
    if (debugIndex < 0) {
        throw new Error(`Could not find the Android debug build type in ${absolutePath}`)
    }
    const debugConfig = [
        debugAnchor,
        `            ${DEBUG_ID_MARKER}`,
        '            naiBlueUserSigningConfig?.let { signingConfig = it }',
    ].join(newline)
    content =
        content.slice(0, debugIndex) +
        debugConfig +
        content.slice(debugIndex + debugAnchor.length)

    if (content !== original) {
        writeFileSync(absolutePath, content, 'utf8')
    }
    return content !== original
}

export function patchAndroidBackDispatcher(manifestFile) {
    const absolutePath = resolve(manifestFile)
    const original = readFileSync(absolutePath, 'utf8')
    const applicationTag = original.match(/<application\b[\s\S]*?>/)?.[0]
    if (!applicationTag) {
        throw new Error(`Could not find the Android application tag in ${absolutePath}`)
    }

    // AndroidX supplies Tauri's native Back callback, which the React sheet listener consumes
    // before Activity teardown; the generated manifest must opt into that dispatcher on API 33+.
    const callbackAttribute = /android:enableOnBackInvokedCallback\s*=\s*["'][^"']*["']/
    const updatedTag = callbackAttribute.test(applicationTag)
        ? applicationTag.replace(callbackAttribute, 'android:enableOnBackInvokedCallback="true"')
        : applicationTag.replace(
            '<application',
            '<application\n        android:enableOnBackInvokedCallback="true"',
        )
    const content = original.replace(applicationTag, updatedTag)

    if (content !== original) {
        writeFileSync(absolutePath, content, 'utf8')
    }
    return content !== original
}

function readOption(name, fallback) {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : fallback
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
    const gradleFile = readOption(
        '--gradle-file',
        resolve('src-tauri', 'gen', 'android', 'app', 'build.gradle.kts'),
    )
    const manifestFile = readOption(
        '--manifest-file',
        join(dirname(gradleFile), 'src', 'main', 'AndroidManifest.xml'),
    )
    const rootBuildFile = readOption(
        '--root-build-file',
        resolve(dirname(gradleFile), '..', 'build.gradle.kts'),
    )
    const debugSuffix = readOption('--debug-suffix', '')
    // Callers pass absolute Gradle paths from other working directories, so the policy is found beside this script.
    const policyFile = readOption(
        '--policy-file',
        fileURLToPath(new URL('../android-release-policy.json', import.meta.url)),
    )
    const { targetSdkVersion } = JSON.parse(readFileSync(policyFile, 'utf8'))
    const toolchainChanged = patchAndroidKotlinToolchain(rootBuildFile)
    const changed = patchAndroidSigning(gradleFile, debugSuffix)
    const targetSdkChanged = patchAndroidTargetSdk(gradleFile, targetSdkVersion)
    const manifestChanged = patchAndroidBackDispatcher(manifestFile)
    console.log(`Android Kotlin toolchain ${toolchainChanged ? 'updated' : 'already current'}: ${rootBuildFile}`)
    console.log(`Android signing configuration ${changed ? 'updated' : 'already current'}: ${gradleFile}`)
    console.log(`Android targetSdk ${targetSdkChanged ? `set to ${targetSdkVersion}` : 'already current'}: ${gradleFile}`)
    console.log(`Android Back dispatcher ${manifestChanged ? 'updated' : 'already current'}: ${manifestFile}`)
}
