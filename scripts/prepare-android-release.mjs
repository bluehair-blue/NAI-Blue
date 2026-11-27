import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    patchAndroidBackDispatcher,
    patchAndroidKotlinToolchain,
    patchAndroidSigning,
    patchAndroidTargetSdk,
} from './patch-android-signing.mjs'

function requiredEnvironment(name) {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required to prepare a signed Android release`)
    return value
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false })
    if (result.error) throw result.error
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
    }
}

function assertReleasePolicy(projectRoot, policy) {
    const tauriConfig = JSON.parse(
        readFileSync(join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    )
    const androidConfig = JSON.parse(
        readFileSync(join(projectRoot, 'src-tauri', 'tauri.android.conf.json'), 'utf8'),
    )
    if (tauriConfig.identifier !== policy.applicationId) {
        throw new Error(
            `Android release policy applicationId ${policy.applicationId} does not match Tauri identifier ${tauriConfig.identifier}`,
        )
    }
    if (androidConfig.bundle?.android?.minSdkVersion !== policy.minSdkVersion) {
        throw new Error('Android release policy minSdkVersion does not match tauri.android.conf.json')
    }
    if (androidConfig.bundle?.android?.versionCode !== policy.versionCode) {
        throw new Error('Android release policy versionCode does not match tauri.android.conf.json')
    }
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRootIndex = process.argv.indexOf('--project-root')
const projectRoot = resolve(
    projectRootIndex >= 0 ? process.argv[projectRootIndex + 1] : join(scriptDirectory, '..'),
)
const policy = JSON.parse(readFileSync(join(projectRoot, 'android-release-policy.json'), 'utf8'))
assertReleasePolicy(projectRoot, policy)

const configuredKeystorePath = requiredEnvironment('ANDROID_KEYSTORE_PATH')
const keystorePath = resolve(
    isAbsolute(configuredKeystorePath)
        ? configuredKeystorePath
        : join(projectRoot, configuredKeystorePath),
)
if (!existsSync(keystorePath)) {
    throw new Error(`Android release keystore does not exist: ${keystorePath}`)
}
const relativeKeystorePath = relative(projectRoot, keystorePath)
if (!relativeKeystorePath.startsWith('..') && !isAbsolute(relativeKeystorePath)) {
    throw new Error('ANDROID_KEYSTORE_PATH must point outside the project directory')
}

const keyAlias = requiredEnvironment('ANDROID_KEY_ALIAS')
if (keyAlias !== policy.signing.keyAlias) {
    throw new Error(
        `ANDROID_KEY_ALIAS must match android-release-policy.json (${policy.signing.keyAlias})`,
    )
}
const androidRoot = join(projectRoot, 'src-tauri', 'gen', 'android')
const gradleFile = join(androidRoot, 'app', 'build.gradle.kts')
if (!existsSync(gradleFile)) {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    run(npx, ['--no-install', 'tauri', 'android', 'init', '--ci'], projectRoot)
}
if (!existsSync(gradleFile)) {
    throw new Error(`Tauri Android initialization did not create ${gradleFile}`)
}

patchAndroidKotlinToolchain(join(androidRoot, 'build.gradle.kts'))
patchAndroidSigning(gradleFile, policy.debugApplicationIdSuffix)
patchAndroidTargetSdk(gradleFile, policy.targetSdkVersion)
patchAndroidBackDispatcher(join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml'))

const generatedGradle = readFileSync(gradleFile, 'utf8')
for (const [label, pattern] of [
    [
        'applicationId',
        new RegExp(
            `applicationId\\s*=\\s*"${policy.applicationId.replaceAll('.', '\\.')}"`,
        ),
    ],
    ['minSdkVersion', new RegExp(`minSdk\\s*=\\s*${policy.minSdkVersion}\\b`)],
    ['targetSdkVersion', new RegExp(`targetSdk\\s*=\\s*${policy.targetSdkVersion}\\b`)],
]) {
    if (!pattern.test(generatedGradle)) {
        throw new Error(
            `Generated Android project has a stale ${label}; remove src-tauri/gen/android and run android:prepare again`,
        )
    }
}

console.log(`Android release project prepared: ${androidRoot}`)
