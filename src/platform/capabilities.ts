export type RuntimePlatform = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'unknown' | 'desktop' | 'web'

declare const __NAI_BLUE_TAURI_PLATFORM__: string | undefined

export interface RuntimeCapability {
    readonly supported: boolean
    /** Human-readable explanation shown beside disabled platform features. */
    readonly reason?: string
    /** A safe workflow that is available on this platform. */
    readonly alternative?: string
}

export interface RuntimeCapabilities {
    readonly platform: RuntimePlatform
    readonly nativePluginRuntime: RuntimeCapability
    readonly novelAiCredentialVault: RuntimeCapability
    readonly absoluteOutputPath: RuntimeCapability
    readonly externalProfileFileWatch: RuntimeCapability
    readonly localTaggerSidecar: RuntimeCapability
    readonly embeddedBrowser: RuntimeCapability
    readonly r2DeployTooling: RuntimeCapability
    readonly r2ProfileRead: RuntimeCapability
    readonly r2ForegroundUpload: RuntimeCapability
    readonly r2BackgroundUpload: RuntimeCapability
    readonly secureLanSyncTransport: RuntimeCapability
    readonly lanBlobTransfer: RuntimeCapability
    readonly embeddedPngMetadataWrite: RuntimeCapability
    readonly generationPublication: GenerationPublicationCapability
    readonly supportedImageFormats: readonly ('png' | 'webp')[]
}

const WINDOWS_GENERATION_LIMITS = Object.freeze({
    maxJobsPerAtomicBatch: 100,
    maxOutputClaimsPerAtomicBatch: 400,
    measuredAt: '2026-09-04T06:37:16.424Z',
    evidenceId: 'benchmark:queue:edge:webview2-152.0.4191.62@2f9d43b',
})

const NO_MEASURED_GENERATION_PUBLICATION = Object.freeze({
    supported: false,
    reason: 'Atomic generation publication has not been measured on this runtime.',
    alternative: 'Use the measured Windows desktop runtime or replay reservation-free legacy work.',
    outputReservationGuarantee: 'unmeasured' as const,
    generationLimits: null,
})

const supported = (): RuntimeCapability => ({ supported: true })

const unsupported = (reason: string, alternative: string): RuntimeCapability => ({
    supported: false,
    reason,
    alternative,
})

const APP_SCOPED_OUTPUT = unsupported(
    'This runtime cannot write to arbitrary absolute desktop paths.',
    'Choose an app-scoped destination or use the installed desktop app.',
)
const NO_NATIVE_PLUGIN_RUNTIME = unsupported(
    'Tauri file, store, and opener plugins are unavailable in the browser runtime.',
    'Use browser storage, file inputs, and normal browser links instead.',
)
const NO_NOVELAI_CREDENTIAL_VAULT = unsupported(
    'Persistent NovelAI credential storage is available only in the installed desktop app.',
    'The token remains available only until this browser or mobile app session ends.',
)
const NO_EXTERNAL_WATCH = unsupported(
    'External profile file watching is available only in the installed desktop app.',
    'Import the profile explicitly, then refresh it when the source changes.',
)
const NO_LOCAL_TAGGER = unsupported(
    'The desktop Python tagger sidecar is not bundled in this runtime.',
    'Generate without local verification or verify tags on the desktop app.',
)
const NO_EMBEDDED_BROWSER = unsupported(
    'The embedded browser view is available only in the installed desktop app.',
    'Open the page in the system browser and return to NAI Blue when finished.',
)
const NO_R2_TOOLING = unsupported(
    'R2 deploy tooling requires the installed desktop app and local Wrangler environment.',
    'Export locally and deploy from the desktop app or Wrangler CLI.',
)
const NO_NATIVE_R2_FOREGROUND = unsupported(
    'Native foreground R2 upload is not enabled in this mobile build.',
    'Review the saved profile on mobile, then upload from the desktop app.',
)
const NO_NATIVE_R2_HOST = unsupported(
    'Native foreground R2 upload requires a supported desktop Tauri build.',
    'Use Wrangler on a desktop host or open the installed Windows, macOS, or Linux app.',
)
const NO_NATIVE_R2_BACKGROUND = unsupported(
    'Background R2 upload workers are not part of the current capability set.',
    'Keep the desktop app open for foreground upload or wait for the background-worker phase.',
)
const NO_SECURE_LAN_SYNC_RUNTIME = unsupported(
    'Secure LAN sync is available only in the installed desktop and Android apps.',
    'Use data backup/restore on this platform, or pair an Android device with a desktop app on the same Wi-Fi.',
)
const NO_LAN_BLOB_TRANSFER = unsupported(
    'Resumable LAN image transfer is not enabled in this build.',
    'Synchronize the succeeded R2 object reference and transfer image bytes through the existing R2 workflow.',
)

/**
 * Deterministic platform matrix. Keep platform behavior here rather than placing
 * platform conditionals in the Composition Domain.
 */
export function createRuntimeCapabilities(platform: RuntimePlatform): RuntimeCapabilities {
    const mobile = platform === 'android' || platform === 'ios'
    const nativeR2Desktop = platform === 'windows' || platform === 'macos' || platform === 'linux' || platform === 'desktop'
    const nativePluginRuntime = mobile || nativeR2Desktop

    return Object.freeze({
        platform,
        nativePluginRuntime: nativePluginRuntime ? supported() : NO_NATIVE_PLUGIN_RUNTIME,
        novelAiCredentialVault: nativeR2Desktop ? supported() : NO_NOVELAI_CREDENTIAL_VAULT,
        // `unknown` remains desktop-compatible for headless characterization;
        // an actual unconfigured browser is detected as `web` below.
        absoluteOutputPath: mobile || platform === 'web' ? APP_SCOPED_OUTPUT : supported(),
        externalProfileFileWatch: nativeR2Desktop ? supported() : NO_EXTERNAL_WATCH,
        localTaggerSidecar: nativeR2Desktop ? supported() : NO_LOCAL_TAGGER,
        embeddedBrowser: nativeR2Desktop ? supported() : NO_EMBEDDED_BROWSER,
        r2DeployTooling: nativeR2Desktop ? supported() : NO_R2_TOOLING,
        r2ProfileRead: supported(),
        r2ForegroundUpload: mobile ? NO_NATIVE_R2_FOREGROUND : nativeR2Desktop ? supported() : NO_NATIVE_R2_HOST,
        r2BackgroundUpload: NO_NATIVE_R2_BACKGROUND,
        // Phase 12 uses desktop as the explicit listener and Android as an
        // outbound-only client. iOS/web stay closed until they have equivalent
        // native mTLS, replay journal, and actual-device QA coverage.
        secureLanSyncTransport: platform === 'android' || nativeR2Desktop
            ? supported()
            : NO_SECURE_LAN_SYNC_RUNTIME,
        lanBlobTransfer: NO_LAN_BLOB_TRANSFER,
        // PNG metadata insertion is a byte-level TypeScript adapter and works on
        // both desktop and Android; it does not depend on a native image library.
        embeddedPngMetadataWrite: supported(),
        generationPublication: platform === 'windows'
            ? {
                supported: true,
                outputReservationGuarantee: 'atomic-no-replace' as const,
                generationLimits: WINDOWS_GENERATION_LIMITS,
            }
            : platform === 'android' || platform === 'ios'
                ? {
                    ...NO_MEASURED_GENERATION_PUBLICATION,
                    outputReservationGuarantee: 'single-app-reservation-external-writer-best-effort' as const,
                }
                : NO_MEASURED_GENERATION_PUBLICATION,
        supportedImageFormats: Object.freeze(['png', 'webp'] as const),
    })
}

interface RuntimePlatformDetectionInput {
    readonly configuredPlatform: string
    readonly hasWindow: boolean
    readonly hasTauriRuntime: boolean
    readonly userAgent: string
}

export type OutputReservationGuarantee = 'atomic-no-replace'
    | 'single-app-reservation-external-writer-best-effort'
    | 'unmeasured'

export interface GenerationPublicationCapability extends RuntimeCapability {
    readonly outputReservationGuarantee: OutputReservationGuarantee
    readonly generationLimits: import('@/domain/queue/types').GenerationAtomicBatchLimits | null
}

/**
 * Keeps browser previews closed while accepting both Tauri runtime markers.
 * Some WebView2 builds expose `__TAURI_INTERNALS__` before the compatibility
 * `isTauri` boolean, so requiring only the latter incorrectly disables every
 * desktop capability during application startup.
 */
export function detectRuntimePlatform({
    configuredPlatform,
    hasWindow,
    hasTauriRuntime,
    userAgent,
}: RuntimePlatformDetectionInput): RuntimePlatform {
    const configured = configuredPlatform.toLowerCase()
    const agent = userAgent.toLowerCase()
    const configuredNative = configured === 'android' || configured === 'ios'
        || configured === 'windows' || configured === 'macos' || configured === 'linux'

    if (!hasWindow) return configuredNative ? configured : 'unknown'
    if (hasTauriRuntime) {
        if (configuredNative) return configured
        if (agent.includes('android')) return 'android'
        if (/iphone|ipad|ipod/.test(agent)) return 'ios'
        if (agent.includes('windows')) return 'windows'
        if (agent.includes('mac os') || agent.includes('macintosh')) return 'macos'
        if (agent.includes('linux')) return 'linux'
        return 'desktop'
    }
    return 'web'
}

function hasTauriRuntimeMarker(): boolean {
    if (Reflect.get(globalThis, 'isTauri') === true) return true
    const internals = Reflect.get(globalThis, '__TAURI_INTERNALS__')
    return typeof internals === 'object'
        && internals !== null
        && typeof Reflect.get(internals, 'invoke') === 'function'
}

// Loaded lazily to avoid a runtime.ts -> capabilities.ts cycle. runtime.ts only
// re-exports compatibility booleans after this value has been constructed.
const detectedPlatform = detectRuntimePlatform({
    configuredPlatform: typeof __NAI_BLUE_TAURI_PLATFORM__ === 'string'
        ? __NAI_BLUE_TAURI_PLATFORM__
        : '',
    hasWindow: typeof window !== 'undefined',
    hasTauriRuntime: hasTauriRuntimeMarker(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
})

export const runtimeCapabilities: RuntimeCapabilities = createRuntimeCapabilities(detectedPlatform)

export function requireRuntimeCapability(
    capabilityName: keyof Omit<RuntimeCapabilities, 'platform' | 'supportedImageFormats'>,
    capabilities: RuntimeCapabilities = runtimeCapabilities,
): void {
    const capability = capabilities[capabilityName]
    if (capability.supported) return
    throw new UnsupportedRuntimeCapabilityError(capabilityName, capability)
}

export class UnsupportedRuntimeCapabilityError extends Error {
    constructor(
        readonly capabilityName: keyof Omit<RuntimeCapabilities, 'platform' | 'supportedImageFormats'>,
        readonly capability: RuntimeCapability,
    ) {
        super(`${capability.reason ?? `${capabilityName} is unsupported`} ${capability.alternative ?? ''}`.trim())
        this.name = 'UnsupportedRuntimeCapabilityError'
    }
}
