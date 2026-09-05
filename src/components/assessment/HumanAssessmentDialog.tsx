import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
    deriveHumanAssessmentDecision,
    latestArtifactAssessments,
    type CriterionResult,
    type HumanIntentAssessmentEventV1,
    type IntentAssessmentEvent,
    type IntentAssessmentRunBinding,
} from '@/domain/assessment/intent-assessment'
import {
    getRuntimeAssessmentPreview,
    getRuntimeIntentAssessmentRun,
    LOCAL_ASSESSMENT_ACTOR_ID,
    recordRuntimeHumanIntentAssessment,
} from '@/services/assessment/intent-assessment-runtime'

interface HumanAssessmentDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    runId: string
    onSaved: () => void | Promise<void>
}

type AssessmentRun = NonNullable<Awaited<ReturnType<typeof getRuntimeIntentAssessmentRun>>>

/** Reads durable run evidence; saves append-only human decisions through the trusted local runtime. */
export function HumanAssessmentDialog({ open, onOpenChange, runId, onSaved }: HumanAssessmentDialogProps) {
    const { t } = useTranslation()
    const id = useId()
    const [run, setRun] = useState<AssessmentRun | null>(null)
    const [selectedId, setSelectedId] = useState('')
    const [revision, setRevision] = useState(0)
    const [loading, setLoading] = useState(true)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const submitLock = useRef(false)
    const session = useRef(0)

    useEffect(() => {
        const token = ++session.current
        if (!open) return
        setLoading(true)
        setError(null)
        void getRuntimeIntentAssessmentRun(runId).then(result => {
            if (session.current !== token) return
            setRun(result)
            setSelectedId(previous => result?.candidateArtifactIds.includes(previous) ? previous : result?.candidateArtifactIds[0] ?? '')
        }).catch(reason => {
            if (session.current !== token) return
            setRun(null)
            setError(reason instanceof Error ? reason.message : String(reason))
        }).finally(() => {
            if (session.current === token) setLoading(false)
        })
        return () => { session.current++ }
    }, [open, runId, revision])

    const currentRun = run?.binding.runId === runId ? run : null
    const closed = currentRun?.events.some(event => event.type === 'run-decision') ?? false
    const latest = currentRun
        ? latestArtifactAssessments(currentRun.binding, currentRun.candidateArtifactIds, currentRun.events).get(selectedId)
        : undefined

    const save = async (event: IntentAssessmentEvent) => {
        if (submitLock.current || loading || closed) return
        submitLock.current = true
        setSubmitting(true)
        setError(null)
        const token = session.current
        try {
            await recordRuntimeHumanIntentAssessment(event)
            // Re-read the persisted projection before allowing another superseding submission.
            const refreshed = await getRuntimeIntentAssessmentRun(event.runId)
            if (token !== session.current) return
            if (refreshed === null) throw new Error('Saved assessment run could not be read back')
            setRun(refreshed)
            await onSaved()
        } catch (reason) {
            if (token === session.current) setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
            submitLock.current = false
            setSubmitting(false)
        }
    }

    const closeAsRejected = () => {
        if (!currentRun) return
        void save({
            schemaVersion: 1,
            type: 'run-decision',
            assessmentId: crypto.randomUUID(),
            runId,
            planHash: currentRun.binding.planHash,
            evaluator: { kind: 'human', actorId: LOCAL_ASSESSMENT_ACTOR_ID },
            decision: 'close-as-rejected',
            createdAt: new Date().toISOString(),
        })
    }

    return (
        <Dialog open={open} onOpenChange={next => { if (!submitLock.current) onOpenChange(next) }}>
            <DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col overflow-hidden"
                style={{ width: 'min(48rem, calc(100vw - 2rem))' }}
                closeLabel={t('assessment.close', 'Close')}
                onEscapeKeyDown={event => { if (submitting) event.preventDefault() }}
                onPointerDownOutside={event => { if (submitting) event.preventDefault() }}>
                <DialogHeader>
                    <DialogTitle>{t('assessment.title', 'Request fulfillment assessment')}</DialogTitle>
                    <DialogDescription>{t('assessment.description', 'Inspect each image and record whether it meets the saved requirements.')}</DialogDescription>
                </DialogHeader>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto" data-testid="human-assessment-dialog">
                    {loading ? <p role="status">{t('assessment.loading', 'Loading assessment…')}</p> : currentRun ? <>
                        <p className="text-sm" role="status">
                            {t('assessment.runSummary', '{{accepted}} / {{required}} accepted · {{candidates}} candidates', {
                                accepted: currentRun.projection.acceptedArtifactIds.length,
                                required: currentRun.projection.requiredAcceptedCount,
                                candidates: currentRun.candidateArtifactIds.length,
                            })}
                            {' · '}{t(`assessment.state.${currentRun.projection.state}`, currentRun.projection.state)}
                        </p>
                        {closed && <p className="text-sm text-muted-foreground">{t('assessment.closed', 'This run was explicitly closed as rejected.')}</p>}
                        {currentRun.candidateArtifactIds.length > 0 ? <>
                            <label className="block space-y-1 text-sm" htmlFor={`${id}-artifact`}>
                                <span>{t('assessment.candidate', 'Image to assess')}</span>
                                <select id={`${id}-artifact`} className="h-11 w-full rounded-control border border-input bg-canvas px-3" value={selectedId} disabled={submitting} onChange={event => setSelectedId(event.target.value)}>
                                    {currentRun.candidateArtifactIds.map((artifactId, index) => <option key={artifactId} value={artifactId}>
                                        {t('assessment.imageNumber', 'Image {{number}}', { number: index + 1 })} · {artifactId}
                                    </option>)}
                                </select>
                            </label>
                            {open && selectedId && <ArtifactAssessmentForm key={`${runId}:${selectedId}:${latest?.assessmentId ?? 'new'}`}
                                binding={currentRun.binding} artifactId={selectedId} latest={latest}
                                disabled={submitting || closed} onSubmit={save} />}
                        </> : <p className="text-sm">{t('assessment.noCandidates', 'No generated images are available for assessment yet.')}</p>}
                    </> : <p>{t('assessment.notFound', 'No assessment requirement was found for this run.')}</p>}
                    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
                </div>
                <DialogFooter>
                    <Button type="button" variant="destructive" disabled={!currentRun || loading || submitting || closed} onClick={closeAsRejected}>
                        {t('assessment.closeRejected', 'Close run as rejected')}
                    </Button>
                    <Button type="button" variant="outline" disabled={submitting} onClick={() => setRevision(previous => previous + 1)}>
                        {t('assessment.refresh', 'Refresh')}
                    </Button>
                    <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>{t('assessment.close', 'Close')}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

/** Keyed by artifact/latest event so a correction starts from exactly the evidence it supersedes. */
function ArtifactAssessmentForm({ binding, artifactId, latest, disabled, onSubmit }: {
    binding: IntentAssessmentRunBinding
    artifactId: string
    latest?: HumanIntentAssessmentEventV1
    disabled: boolean
    onSubmit: (event: HumanIntentAssessmentEventV1) => Promise<void>
}) {
    const { t } = useTranslation()
    const id = useId()
    const { rubric, rubricHash } = binding.requirement
    const [results, setResults] = useState<readonly CriterionResult[]>(() => rubric.hardConstraints.map(criterion => ({
        criterionId: criterion.criterionId,
        result: latest?.hardConstraintResults.find(result => result.criterionId === criterion.criterionId)?.result ?? 'needs-review',
    })))
    const [score, setScore] = useState(latest?.softScore == null ? '' : String(latest.softScore))
    const [summary, setSummary] = useState(latest?.explanationSummary ?? '')
    const [preview, setPreview] = useState<string | null>(null)
    const [previewLoaded, setPreviewLoaded] = useState(false)
    const [previewError, setPreviewError] = useState<string | null>(null)

    useEffect(() => {
        let active = true
        let dispose: (() => void) | undefined
        void getRuntimeAssessmentPreview(artifactId).then(result => {
            if (!active) { result.dispose(); return }
            dispose = result.dispose
            setPreview(result.url)
        }).catch(reason => {
            if (active) setPreviewError(reason instanceof Error ? reason.message : String(reason))
        })
        return () => { active = false; dispose?.() }
    }, [artifactId])

    const softScore = rubric.softCriteria.length === 0 || score.trim() === '' ? null : Number(score)
    const validScore = softScore === null || (Number.isFinite(softScore) && softScore >= 0 && softScore <= 100)
    const decision = validScore ? deriveHumanAssessmentDecision(rubric, results, softScore) : 'needs-review'
    const submit = () => {
        if (disabled || !previewLoaded || !validScore) return
        void onSubmit({
            schemaVersion: 1,
            type: 'artifact-assessment',
            assessmentId: crypto.randomUUID(),
            runId: binding.runId,
            planHash: binding.planHash,
            artifactId,
            rubricId: rubric.rubricId,
            rubricVersion: rubric.version,
            rubricHash,
            evaluator: { kind: 'human', actorId: LOCAL_ASSESSMENT_ACTOR_ID },
            hardConstraintResults: results,
            softScore,
            decision,
            ...(summary.trim() ? { explanationSummary: summary.trim() } : {}),
            supersedesAssessmentId: latest?.assessmentId ?? null,
            createdAt: new Date().toISOString(),
        })
    }

    return <div className="space-y-3">
        {preview ? <img src={preview} alt={t('assessment.previewAlt', 'Generated image being assessed')} className="max-h-[40dvh] w-full rounded-control object-contain" onLoad={() => setPreviewLoaded(true)} onError={() => { setPreviewLoaded(false); setPreview(null); setPreviewError(t('assessment.previewFailed', 'The image preview could not be displayed.')) }} />
            : <p role={previewError ? 'alert' : 'status'} className="text-sm">{previewError ?? t('assessment.loadingPreview', 'Loading image preview…')}</p>}
        {latest && <p className="text-sm">{t('assessment.latestDecision', 'Last saved decision: {{decision}}', { decision: t(`assessment.state.${latest.decision}`, latest.decision) })}</p>}
        <fieldset disabled={disabled} className="space-y-3">
            <legend className="mb-2 text-sm font-medium">{t('assessment.hardResults', 'Hard constraint results')}</legend>
            {rubric.hardConstraints.map((criterion, index) => <label key={criterion.criterionId} className="block space-y-1 text-sm" htmlFor={`${id}-hard-${index}`}>
                <span>{criterion.label}</span>
                <select id={`${id}-hard-${index}`} className="h-11 w-full rounded-control border border-input bg-canvas px-3" value={results[index].result}
                    onChange={event => setResults(previous => previous.map((result, resultIndex) => resultIndex === index ? { ...result, result: event.target.value as CriterionResult['result'] } : result))}>
                    <option value="needs-review">{t('assessment.result.needs-review', 'Needs review')}</option>
                    <option value="pass">{t('assessment.result.pass', 'Pass')}</option>
                    <option value="fail">{t('assessment.result.fail', 'Fail')}</option>
                </select>
            </label>)}
            {rubric.softCriteria.length > 0 && <label className="block space-y-1 text-sm" htmlFor={`${id}-score`}>
                <span>{t('assessment.softScore', 'Overall criterion score (0–100; blank means needs review)')}</span>
                <ul className="list-inside list-disc text-xs text-muted-foreground">{rubric.softCriteria.map(criterion => <li key={criterion.criterionId}>{criterion.label} ({t('assessment.criterionWeight', 'weight {{weight}}', { weight: criterion.weight })})</li>)}</ul>
                <p className="text-xs text-muted-foreground">{t('assessment.thresholdValue', 'Acceptance threshold: {{threshold}}', { threshold: rubric.acceptanceThreshold })}</p>
                <Input id={`${id}-score`} type="number" min={0} max={100} step="any" value={score} aria-invalid={!validScore} onChange={event => setScore(event.target.value)} />
            </label>}
            <label className="block space-y-1 text-sm" htmlFor={`${id}-summary`}>
                <span>{t('assessment.explanation', 'Notes (optional)')}</span>
                <Textarea id={`${id}-summary`} maxLength={2000} rows={2} value={summary} onChange={event => setSummary(event.target.value)} />
            </label>
            <p className="text-sm" role="status">{t('assessment.resultingDecision', 'Decision to save: {{decision}}', { decision: t(`assessment.state.${decision}`, decision) })}</p>
            <Button type="button" disabled={disabled || !previewLoaded || !validScore} onClick={submit}>
                {latest ? t('assessment.saveCorrection', 'Save revised assessment') : t('assessment.save', 'Save assessment')}
            </Button>
        </fieldset>
    </div>
}
