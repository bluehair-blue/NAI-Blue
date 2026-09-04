import { Film, ImagePlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import Counter from '@/components/ui/counter'
import { toast } from '@/components/ui/use-toast'
import { NovelAiV5UsageLimit } from '@/components/credentials/NovelAiV5UsageLimit'
import { SceneQueueReviewDialog } from '@/components/queue/SceneQueueReviewDialog'
import { calculateAnlasCost } from '@/lib/anlas-calculator'
import { cn } from '@/lib/utils'
import { executePromptGenerationCommand } from '@/services/generation/prompt-generation-command'
import {
    enqueueReviewedSceneQueue,
    prepareCurrentSceneQueueReview,
    type PreparedSceneQueueReview,
    type SceneQueueSubmission,
} from '@/services/queue/scene-queue-adapter'
import { useRotationStore } from '@/stores/character-rotation-store'
import { useCharacterStore } from '@/stores/character-store'
import { useGenerationDraftStore } from '@/stores/generation-draft-store'
import { useGenerationSessionStore } from '@/stores/generation-session-store'
import { useSceneStore } from '@/stores/scene-store'
import { useQueueStore } from '@/stores/queue-store'
import { isSceneQueueReviewConflict } from '@/application/scene/scene-queue-review'

interface PromptGenerationControlsProps {
    isSceneMode: boolean
}

/**
 * Generation status and controls consume Session/Scene projections and invoke
 * one route command adapter. This separation lets PromptEditorSurface remain
 * mounted independently without duplicating queue or cancellation behavior.
 */
export function PromptGenerationControls({ isSceneMode }: PromptGenerationControlsProps) {
    const { t } = useTranslation()
    const [sceneReview, setSceneReview] = useState<PreparedSceneQueueReview | null>(null)
    const selectDurableBatch = useQueueStore(state => state.setSelectedBatchId)
    const activePresetId = useSceneStore(state => state.activePresetId)
    const getTotalQueueCount = useSceneStore(state => state.getTotalQueueCount)
    const sceneIsGenerating = useSceneStore(state => state.isGenerating)
    const sceneIsCancelling = useSceneStore(state => state.isCancelling)
    const completedCount = useSceneStore(state => state.completedCount)
    const totalQueuedCount = useSceneStore(state => state.totalQueuedCount)
    const rotationActive = useRotationStore(state => state.active)
    const isGenerating = useGenerationSessionStore(state => state.isGenerating)
    const isCancelled = useGenerationSessionStore(state => state.isCancelled)
    const currentBatch = useGenerationSessionStore(state => state.currentBatch)
    const generatingMode = useGenerationSessionStore(state => state.generatingMode)
    const batchCount = useGenerationDraftStore(state => state.batchCount)
    const model = useGenerationDraftStore(state => state.model)
    const selectedResolution = useGenerationDraftStore(state => state.selectedResolution)
    const steps = useGenerationDraftStore(state => state.steps)
    const setBatchCount = useGenerationDraftStore(state => state.setBatchCount)
    const hasCharacterReference = useCharacterStore(state => (
        state.characterImages.some(image => image.enabled)
    ))
    const sceneQueueCount = activePresetId ? getTotalQueueCount(activePresetId) : 0
    const isMainGenerating = generatingMode === 'main'
    const isSceneGenerating = generatingMode === 'scene'
    const isStyleLabGenerating = generatingMode === 'styleLab'
    const isConflict = isSceneMode
        ? isMainGenerating || isStyleLabGenerating
        : isSceneGenerating
    const paidMaximumAnlas = calculateAnlasCost({
        model,
        width: selectedResolution.width,
        height: selectedResolution.height,
        steps,
        imageCount: 1,
        pricingBasis: 'paid',
    }) * batchCount

    const execute = () => {
        if (isConflict) return
        void executePromptGenerationCommand(isSceneMode ? 'scene' : 'main')
            .then(async outcome => {
                if (outcome === 'credential-required') {
                    toast({
                        title: t('credentialVault.unlockRequired', 'API 토큰 잠금 해제 필요'),
                        description: t('credentialVault.unlockRequiredForGeneration', '이미지를 생성하려면 NovelAI API 토큰 보관소를 잠금 해제하세요.'),
                    })
                    return
                }
                if (outcome === 'low-quality-steps') {
                    toast({
                        title: t('generate.lowStepsBlockedTitle', 'Check Steps first'),
                        description: t('generate.lowStepsDescription', '{{steps}} steps can stop before the image is resolved. Use 28 steps for a normal generation.', { steps }),
                        variant: 'destructive',
                    })
                    return
                }
                if (outcome === 'review-required') {
                    setSceneReview(await prepareCurrentSceneQueueReview())
                    return
                }
                if (outcome !== 'rotation-stopped') return
                toast({
                    title: t('rotation.stopped', '로테이션 중단'),
                    description: t('rotation.resumeLater', '현재 위치를 저장했습니다. 나중에 이어서 생성할 수 있습니다.'),
                })
            })
            .catch(error => toast({
                title: t('common.error', 'Error'),
                description: error instanceof Error ? error.message : t('queue.enqueueFailed', 'Queue enqueue failed'),
                variant: 'destructive',
            }))
    }

    const approveSceneReview = async (submission: SceneQueueSubmission): Promise<boolean> => {
        try {
            const result = await enqueueReviewedSceneQueue(submission)
            selectDurableBatch(result.batch.id)
            toast({
                title: t('queue.enqueued', 'Added to durable queue'),
                description: t('queue.enqueuedCount', '{{count}} jobs are ready in Queue Center.', { count: result.jobs.length }),
            })
            return true
        } catch (error) {
            if (isSceneQueueReviewConflict(error)) throw error
            toast({
                title: t('common.error', 'Error'),
                description: error instanceof Error ? error.message : t('queue.enqueueFailed', 'Queue enqueue failed'),
                variant: 'destructive',
            })
            return false
        }
    }

    const replanSceneReview = async (): Promise<boolean> => {
        try {
            const next = await prepareCurrentSceneQueueReview()
            setSceneReview(next)
            return next !== null
        } catch (error) {
            toast({
                title: t('common.error', 'Error'),
                description: error instanceof Error ? error.message : t('queue.enqueueFailed', 'Queue enqueue failed'),
                variant: 'destructive',
            })
            return false
        }
    }

    return (
        <>
        <div className="p-0">
            {!isSceneMode && (
                <NovelAiV5UsageLimit
                    model={model}
                    width={selectedResolution.width}
                    height={selectedResolution.height}
                    steps={steps}
                    maxAnlas={paidMaximumAnlas}
                    hasCharacterReference={hasCharacterReference}
                    className="mb-3"
                />
            )}
            <div className="flex flex-wrap gap-2">
                <Button
                    data-testid="prompt-generate-action"
                    variant={(isGenerating || (isSceneMode && (sceneIsGenerating || sceneIsCancelling || rotationActive))) ? 'destructive' : 'generate'}
                    size="lg"
                    className={cn(
                        'h-12 min-w-40 flex-1 rounded-control px-4 text-sm font-semibold leading-tight whitespace-normal',
                        isConflict && 'cursor-not-allowed opacity-50',
                    )}
                    onClick={execute}
                    disabled={
                        (isSceneMode && sceneQueueCount === 0 && !sceneIsGenerating && !sceneIsCancelling && !rotationActive)
                        || isConflict
                        || (sceneIsCancelling && !rotationActive)
                        || (isGenerating && isCancelled)
                    }
                >
                    {isSceneMode ? (
                        sceneIsCancelling ? (
                            <><Spinner />{t('common.cancelling', '취소 중...')}</>
                        ) : rotationActive ? (
                            <><Spinner />{t('rotation.stopAndResume', '중단하고 나중에 이어서')}</>
                        ) : sceneIsGenerating ? (
                            <><Spinner />{t('common.cancel', '취소')} {totalQueuedCount > 0 && `(${completedCount + 1}/${totalQueuedCount})`}</>
                        ) : (
                            <><Film className="mr-2 h-5 w-5" />{t('scene.generateAll', '씬 생성')} {sceneQueueCount > 0 && `(${sceneQueueCount})`}</>
                        )
                    ) : (
                        isGenerating && isCancelled ? (
                            <><Spinner />{t('common.cancelling', '취소 중...')}</>
                        ) : isGenerating ? (
                            <>
                                <Spinner />
                                {batchCount > 1
                                    ? `${t('generate.cancel')} (${currentBatch}/${batchCount})`
                                    : t('generate.cancel')}
                            </>
                        ) : (
                            <><ImagePlus className="mr-2 h-5 w-5" />{t('generate.button')}</>
                        )
                    )}
                </Button>
                <Counter
                    value={batchCount}
                    onChange={setBatchCount}
                    min={1}
                    max={9999}
                    fontSize={16}
                    className="shrink-0"
                />
            </div>
        </div>
        {sceneReview !== null && (
            <SceneQueueReviewDialog
                open
                onOpenChange={open => { if (!open) setSceneReview(null) }}
                prepared={sceneReview}
                onApprove={approveSceneReview}
                onReplan={replanSceneReview}
            />
        )}
        </>
    )
}

function Spinner() {
    return <span className="mr-2 h-5 w-5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" aria-hidden="true" />
}
