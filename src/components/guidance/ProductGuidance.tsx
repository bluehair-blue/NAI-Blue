import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CompositionWorkspaceSheet } from '@/components/composition-workspace/CompositionWorkspaceSheet'
import { useAuthStore } from '@/stores/auth-store'
import { useGenerationStore } from '@/stores/generation-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useAssetModuleStore } from '@/stores/asset-module-store'
import { isMobileRuntime, runtimeCapabilities } from '@/platform/runtime'
import {
    deriveProductGuidanceState,
    PRODUCT_GUIDANCE_VERSION,
    type GuidanceStepId,
} from '@/services/guidance/onboarding'
import {
    guideSectionForDiagnosticCode,
    PRODUCT_GUIDANCE_OPEN_EVENT,
} from '@/services/guidance/diagnostic-guides'

function GuidanceStatus({ step, status }: { step: GuidanceStepId; status: string }) {
    const { t } = useTranslation()
    return (
        <span className="rounded-control bg-muted px-2 py-1 text-xs" data-step={step}>
            {t(`productGuidance.status.${status}`)}
        </span>
    )
}

function GuideSection({
    id,
    title,
    description,
    status,
    active,
    children,
}: {
    id: GuidanceStepId | 'advanced'
    title: string
    description: string
    status?: string
    active: boolean
    children: React.ReactNode
}) {
    return (
        <details id={`product-guidance-${id}`} className="rounded-panel border border-border" open={active}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">
                    <strong className="block text-sm">{title}</strong>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
                </span>
                {status && <GuidanceStatus step={id as GuidanceStepId} status={status} />}
            </summary>
            <div className="space-y-3 border-t border-border p-3 text-sm">{children}</div>
        </details>
    )
}

/** Versioned onboarding and contextual recovery help; all actions stay user initiated. */
export function ProductGuidance({ returnFocusRef }: { returnFocusRef?: RefObject<HTMLElement | null> } = {}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [activeSection, setActiveSection] = useState<GuidanceStepId | 'advanced'>('credential')
    const [diagnosticCode, setDiagnosticCode] = useState<string | null>(null)
    const productGuidanceVersion = useSettingsStore(state => state.productGuidanceVersion)
    const setProductGuidanceVersion = useSettingsStore(state => state.setProductGuidanceVersion)
    const savePath = useSettingsStore(state => state.savePath)
    const imageFormat = useSettingsStore(state => state.imageFormat)
    const metadataMode = useSettingsStore(state => state.metadataMode)
    const setImageFormat = useSettingsStore(state => state.setImageFormat)
    const setMetadataMode = useSettingsStore(state => state.setMetadataMode)
    const hasCredential = useAuthStore(state => Boolean(state.token || state.token2))
    const requestTokenEntry = useAuthStore(state => state.requestTokenEntry)
    const hasResolvedPlan = useGenerationStore(state => state.lastResolvedPlan !== null)
    const r2Configured = useAssetModuleStore(state => state.profile.r2.enabled)
    const guidance = deriveProductGuidanceState({
        completedVersion: productGuidanceVersion,
        hasCredential,
        hasResolvedPlan,
        outputConfigured: savePath.trim().length > 0,
        r2Configured,
        queueVisited: false,
    })
    const status = (id: GuidanceStepId) => guidance.steps.find(step => step.id === id)?.status ?? 'available'
    const triggerLabel = t('productGuidance.trigger')

    useEffect(() => {
        const handleOpen = (event: Event) => {
            const detail = (event as CustomEvent<{ diagnosticCode?: string }>).detail
            const code = detail?.diagnosticCode
            setDiagnosticCode(code ?? null)
            setActiveSection(code ? guideSectionForDiagnosticCode(code) : 'credential')
            setOpen(true)
        }
        window.addEventListener(PRODUCT_GUIDANCE_OPEN_EVENT, handleOpen)
        return () => window.removeEventListener(PRODUCT_GUIDANCE_OPEN_EVENT, handleOpen)
    }, [])

    const handleOpenChange = (nextOpen: boolean) => {
        setOpen(nextOpen)
        if (!nextOpen && productGuidanceVersion < PRODUCT_GUIDANCE_VERSION) {
            setProductGuidanceVersion(PRODUCT_GUIDANCE_VERSION)
        }
    }

    const closeThen = (action: () => void) => {
        handleOpenChange(false)
        window.setTimeout(action, 0)
    }

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-control border border-border text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:w-auto xl:px-3"
                onClick={() => {
                    setDiagnosticCode(null)
                    setActiveSection('credential')
                    setOpen(true)
                }}
                aria-haspopup="dialog"
                aria-label={triggerLabel}
                aria-expanded={open}
                aria-controls="product-guidance-sheet"
                data-onboarding-pending={guidance.showOnboardingCue}
            >
                <CircleHelp className="h-4 w-4" aria-hidden="true" />
                <span className="hidden xl:inline">{triggerLabel}</span>
                {guidance.showOnboardingCue && (
                    <>
                        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
                        <span className="sr-only">{t('productGuidance.onboardingAvailable')}</span>
                    </>
                )}
            </button>
            <CompositionWorkspaceSheet
                open={open}
                onOpenChange={handleOpenChange}
                title={t('productGuidance.title')}
                description={t('productGuidance.description')}
                closeLabel={t('common.close')}
                side={isMobileRuntime ? 'bottom' : 'right'}
                returnFocusRef={returnFocusRef ?? triggerRef}
                testId="product-guidance-sheet"
                className="motion-reduce:transition-none"
            >
                {diagnosticCode && (
                    <p className="mb-3 rounded-control bg-muted p-3 text-xs" role="status">
                        {t('productGuidance.diagnosticLinked')} <code>{diagnosticCode}</code>
                    </p>
                )}
                <div className="space-y-3">
                    <GuideSection id="credential" title={t('productGuidance.steps.credential.title')} description={t('productGuidance.steps.credential.description')} status={status('credential')} active={activeSection === 'credential'}>
                        <p>{t(hasCredential ? 'productGuidance.steps.credential.ready' : 'productGuidance.steps.credential.missing')}</p>
                        <Button className="min-h-11" onClick={() => closeThen(requestTokenEntry)}>{t('productGuidance.steps.credential.action')}</Button>
                    </GuideSection>
                    <GuideSection id="validation" title={t('productGuidance.steps.validation.title')} description={t('productGuidance.steps.validation.description')} status={status('validation')} active={activeSection === 'validation'}>
                        <p>{t('productGuidance.steps.validation.safe')}</p>
                        <Button variant="outline" className="min-h-11" onClick={() => closeThen(() => navigate('/advanced'))}>{t('productGuidance.steps.validation.action')}</Button>
                    </GuideSection>
                    <GuideSection id="output" title={t('productGuidance.steps.output.title')} description={t('productGuidance.steps.output.description')} status={status('output')} active={activeSection === 'output'}>
                        <label className="grid gap-1 text-xs">
                            <span>{t('productGuidance.steps.output.format')}</span>
                            <select className="min-h-11 rounded-control border border-input bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={imageFormat} onChange={event => setImageFormat(event.target.value as 'png' | 'webp')}>
                                <option value="png">PNG</option><option value="webp">WebP</option>
                            </select>
                        </label>
                        <label className="grid gap-1 text-xs">
                            <span>{t('productGuidance.steps.output.privacy')}</span>
                            <select className="min-h-11 rounded-control border border-input bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={metadataMode} onChange={event => setMetadataMode(event.target.value as typeof metadataMode)}>
                                <option value="embedded">{t('productGuidance.steps.output.metadata.embedded')}</option>
                                <option value="sidecar-only">{t('productGuidance.steps.output.metadata.sidecar')}</option>
                                <option value="strip-and-sidecar">{t('productGuidance.steps.output.metadata.stripped')}</option>
                                <option value="strip-only">{t('settingsPage.save.metadataMode.stripOnly')}</option>
                            </select>
                        </label>
                        <p className="break-all text-xs text-muted-foreground">{t('productGuidance.steps.output.location')}: {savePath}</p>
                        {!runtimeCapabilities.absoluteOutputPath.supported && (
                            <div className="rounded-control border border-warning/50 bg-warning/10 p-3 text-xs">
                                <code>absoluteOutputPath</code>
                                <p className="mt-1">{t('productGuidance.capabilities.absolutePath.reason')}</p>
                                <p className="mt-1">{t('productGuidance.capabilities.absolutePath.alternative')}</p>
                            </div>
                        )}
                        <Button variant="outline" className="min-h-11" onClick={() => closeThen(() => navigate('/settings'))}>{t('productGuidance.steps.output.action')}</Button>
                    </GuideSection>
                    <GuideSection id="r2" title={t('productGuidance.steps.r2.title')} description={t('productGuidance.steps.r2.description')} status={status('r2')} active={activeSection === 'r2'}>
                        {!runtimeCapabilities.r2ForegroundUpload.supported && (
                            <div className="rounded-control border border-warning/50 bg-warning/10 p-3 text-xs">
                                <code>r2ForegroundUpload</code>
                                <p className="mt-1">{t('productGuidance.capabilities.r2.reason')}</p>
                                <p className="mt-1">{t('productGuidance.capabilities.r2.alternative')}</p>
                            </div>
                        )}
                        <Button variant="outline" className="min-h-11" onClick={() => closeThen(() => navigate('/r2'))}>{t('productGuidance.steps.r2.action')}</Button>
                    </GuideSection>
                    <GuideSection id="queue" title={t('productGuidance.steps.queue.title')} description={t('productGuidance.steps.queue.description')} status={status('queue')} active={activeSection === 'queue'}>
                        <p>{t('productGuidance.steps.queue.help')}</p>
                        <Button variant="outline" className="min-h-11" onClick={() => closeThen(() => navigate('/queue'))}>{t('productGuidance.steps.queue.action')}</Button>
                    </GuideSection>
                    <GuideSection id="advanced" title={t('productGuidance.advanced.title')} description={t('productGuidance.advanced.description')} active={activeSection === 'advanced'}>
                        <p>{t('productGuidance.advanced.help')}</p>
                        {diagnosticCode && <code className="block break-all">{diagnosticCode}</code>}
                    </GuideSection>
                </div>
            </CompositionWorkspaceSheet>
        </>
    )
}
