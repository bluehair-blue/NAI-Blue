import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
    createRuntimeCapabilities,
    detectRuntimePlatform,
    UnsupportedRuntimeCapabilityError,
} from '@/platform/capabilities'

describe('RuntimeCapabilities', () => {
    it('exposes the complete desktop capability matrix', () => {
        const capabilities = createRuntimeCapabilities('windows')

        expect(capabilities.platform).toBe('windows')
        expect(capabilities.nativePluginRuntime.supported).toBe(true)
        expect(capabilities.novelAiCredentialVault.supported).toBe(true)
        expect(capabilities.absoluteOutputPath.supported).toBe(true)
        expect(capabilities.externalProfileFileWatch.supported).toBe(true)
        expect(capabilities.localTaggerSidecar.supported).toBe(true)
        expect(capabilities.embeddedBrowser.supported).toBe(true)
        expect(capabilities.r2DeployTooling.supported).toBe(true)
        expect(capabilities.secureLanSyncTransport.supported).toBe(true)
        expect(capabilities.lanBlobTransfer.supported).toBe(false)
        expect(capabilities.embeddedPngMetadataWrite.supported).toBe(true)
        expect(capabilities.generationPublication).toEqual({
            supported: true,
            outputReservationGuarantee: 'atomic-no-replace',
            generationLimits: {
                maxJobsPerAtomicBatch: 100,
                maxOutputClaimsPerAtomicBatch: 400,
                measuredAt: '2026-09-04T07:06:52.993Z',
                evidenceId: 'benchmark:queue:edge:webview2-152.0.4191.62@d1118542+b44519c5#docs/releases/evidence/queue-edge-benchmark.json',
            },
        })
        expect(capabilities.supportedImageFormats).toEqual(['png', 'webp'])
        expect(createRuntimeCapabilities('web').nativePluginRuntime.supported).toBe(false)
        expect(createRuntimeCapabilities('web').novelAiCredentialVault.supported).toBe(false)
        expect(createRuntimeCapabilities('web').embeddedBrowser.supported).toBe(false)
    })

    it('does not extrapolate Windows publication measurements to other runtimes', () => {
        for (const platform of ['android', 'ios', 'macos', 'linux', 'web', 'unknown', 'desktop'] as const) {
            const publication = createRuntimeCapabilities(platform).generationPublication
            expect(publication.supported).toBe(false)
            expect(publication.generationLimits).toBeNull()
        }
    })

    it('binds Windows publication limits to tracked clean WebView2 evidence', async () => {
        const evidencePath = 'docs/releases/evidence/queue-edge-benchmark.json'
        const evidence = JSON.parse(await readFile(resolve(process.cwd(), evidencePath), 'utf8')) as {
            timestamp: string
            source: { commit: string; tree: string; clean: boolean }
            browser: { channel: string; version: string }
            supportedMeasuredMaximum: { jobs: number; totalClaims: number }
            pass: boolean
        }
        const limits = createRuntimeCapabilities('windows').generationPublication.generationLimits

        expect(evidence).toMatchObject({
            timestamp: limits?.measuredAt,
            source: { clean: true },
            browser: { channel: 'embedded-webview2-cdp', version: '152.0.4191.62' },
            supportedMeasuredMaximum: {
                jobs: limits?.maxJobsPerAtomicBatch,
                totalClaims: limits?.maxOutputClaimsPerAtomicBatch,
            },
            pass: true,
        })
        expect(limits?.evidenceId).toBe(
            `benchmark:queue:edge:webview2-${evidence.browser.version}`
            + `@${evidence.source.commit.slice(0, 8)}+${evidence.source.tree.slice(0, 8)}#${evidencePath}`,
        )
    })

    it('accepts the native WebView marker without trusting a browser preview build target', () => {
        expect(detectRuntimePlatform({
            configuredPlatform: 'windows',
            hasWindow: true,
            hasTauriRuntime: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        })).toBe('windows')
        expect(detectRuntimePlatform({
            configuredPlatform: 'windows',
            hasWindow: true,
            hasTauriRuntime: false,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        })).toBe('web')
        expect(detectRuntimePlatform({
            configuredPlatform: '',
            hasWindow: true,
            hasTauriRuntime: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        })).toBe('windows')
        expect(detectRuntimePlatform({
            configuredPlatform: 'android',
            hasWindow: true,
            hasTauriRuntime: false,
            userAgent: 'Mozilla/5.0 (Linux; Android 16)',
        })).toBe('web')
    })

    it('provides a reason and alternative for every unsupported Android capability', () => {
        const capabilities = createRuntimeCapabilities('android')
        const unsupported = [
            capabilities.novelAiCredentialVault,
            capabilities.absoluteOutputPath,
            capabilities.externalProfileFileWatch,
            capabilities.localTaggerSidecar,
            capabilities.embeddedBrowser,
            capabilities.r2DeployTooling,
            capabilities.r2ForegroundUpload,
            capabilities.r2BackgroundUpload,
            capabilities.lanBlobTransfer,
        ]

        expect(unsupported.every(capability => (
            !capability.supported
            && Boolean(capability.reason)
            && Boolean(capability.alternative)
        ))).toBe(true)
        expect(capabilities.secureLanSyncTransport.supported).toBe(true)
        expect(capabilities.embeddedPngMetadataWrite.supported).toBe(true)
        expect(capabilities.supportedImageFormats).toEqual(['png', 'webp'])
        expect(capabilities.novelAiCredentialVault.alternative).toContain('session')
    })

    it('carries actionable details in unsupported errors', () => {
        const capability = createRuntimeCapabilities('android').r2DeployTooling
        const error = new UnsupportedRuntimeCapabilityError('r2DeployTooling', capability)

        expect(error.message).toContain(capability.reason)
        expect(error.message).toContain(capability.alternative)
    })

    it('never leaves the legacy Android output fallback silent', async () => {
        const [generation, sceneOutput, scenePresentation, styleLab] = await Promise.all([
            'src/services/generation/generation-runtime-store.ts',
            'src/lib/scene-generation/save-scene-result.ts',
            'src/presentation/scene/zustand-scene-result-presentation.ts',
            'src/services/style-lab-generation.ts',
        ].map(path => readFile(resolve(process.cwd(), path), 'utf8')))

        for (const source of [generation, styleLab]) {
            expect(source).toContain('capabilityFallbackUsed')
            expect(source).toContain('capabilityFallbackReason')
            expect(source).toContain('capabilityFallbackAlternative')
            expect(source).toContain('outputCapabilityFallbackTitle')
        }
        expect(sceneOutput).toContain('capabilityFallbackUsed')
        expect(sceneOutput).toContain('capabilityFallbackReason')
        expect(sceneOutput).toContain('capabilityFallbackAlternative')
        expect(sceneOutput).toContain('presentation.reportCapabilityFallback')
        expect(scenePresentation).toContain('outputCapabilityFallbackTitle')
    })
})
