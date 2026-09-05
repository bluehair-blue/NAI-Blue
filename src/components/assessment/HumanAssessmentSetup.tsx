import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { createAssessmentRequirement, type GenerationAssessmentRequirement } from '@/domain/assessment/visual-rubric'

interface HumanAssessmentSetupProps {
    count: number
    value: GenerationAssessmentRequirement | null
    onChange: (value: GenerationAssessmentRequirement | null) => void
    onValidityChange?: (valid: boolean) => void
}

/** A local draft becomes plan input only after the domain validates and hashes its rubric. */
export function HumanAssessmentSetup({ count, value, onChange, onValidityChange }: HumanAssessmentSetupProps) {
    const { t } = useTranslation()
    const id = useId()
    const [rubricId] = useState(() => value?.rubric.rubricId ?? crypto.randomUUID())
    const [draft, setDraft] = useState(() => ({
        enabled: value !== null,
        hard: value?.rubric.hardConstraints.map(criterion => criterion.label).join('\n') ?? '',
        required: String(value?.requiredAcceptedCount ?? 1),
        softEnabled: (value?.rubric.softCriteria.length ?? 0) > 0,
        softLabel: value?.rubric.softCriteria[0]?.label ?? '',
        softWeight: String(value?.rubric.softCriteria[0]?.weight ?? 1),
        threshold: String(value?.rubric.acceptanceThreshold ?? 70),
    }))
    const [invalid, setInvalid] = useState(false)
    const callbacks = useRef({ onChange, onValidityChange })
    callbacks.current = { onChange, onValidityChange }

    const update = (change: Partial<typeof draft>) => {
        // Invalidate synchronously so a generation click cannot submit an older valid rubric.
        callbacks.current.onValidityChange?.(false)
        callbacks.current.onChange(null)
        setDraft(previous => ({ ...previous, ...change }))
    }

    useEffect(() => {
        let active = true
        callbacks.current.onChange(null)
        callbacks.current.onValidityChange?.(!draft.enabled)
        if (!draft.enabled) {
            setInvalid(false)
            return
        }
        const validate = () => {
            try {
                const required = Number(draft.required)
                if (!Number.isInteger(required) || required < 1 || required > count) throw new Error('Invalid count')
                if (draft.softEnabled && (!draft.softWeight.trim() || !draft.threshold.trim())) throw new Error('Missing score settings')
                const requirement = createAssessmentRequirement({
                    rubricId,
                    version: 1,
                    hardConstraints: draft.hard.split('\n').map(label => label.trim()).filter(Boolean)
                        .map((label, index) => ({ criterionId: `hard-${index + 1}`, label })),
                    softCriteria: draft.softEnabled
                        ? [{ criterionId: 'soft-1', label: draft.softLabel.trim(), weight: Number(draft.softWeight) }]
                        : [],
                    acceptanceThreshold: draft.softEnabled ? Number(draft.threshold) : 0,
                }, required)
                if (!active) return
                setInvalid(false)
                callbacks.current.onChange(requirement)
                callbacks.current.onValidityChange?.(true)
            } catch {
                if (active) setInvalid(true)
            }
        }
        validate()
        return () => { active = false }
    }, [count, draft, rubricId])

    return (
        <section className="space-y-3 rounded-panel border border-border p-3 text-sm" data-testid="human-assessment-setup">
            <label className="flex items-center gap-2">
                <input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} />
                <span>{t('assessment.enable', 'Assess request fulfillment after generation')}</span>
            </label>
            {draft.enabled && <div className="space-y-3">
                <p className="text-xs text-muted-foreground">{t('assessment.setupDescription', 'Write the requirements you will check against each generated image.')}</p>
                <label className="block space-y-1" htmlFor={`${id}-hard`}>
                    <span>{t('assessment.hardConstraints', 'Hard constraints (one per line)')}</span>
                    <Textarea id={`${id}-hard`} rows={3} value={draft.hard} onChange={event => update({ hard: event.target.value })} />
                </label>
                <label className="block space-y-1" htmlFor={`${id}-required`}>
                    <span>{t('assessment.requiredCount', 'Required accepted images (1–{{count}})', { count })}</span>
                    <Input id={`${id}-required`} type="number" min={1} max={count} step={1} value={draft.required} onChange={event => update({ required: event.target.value })} />
                </label>
                <label className="flex items-center gap-2">
                    <input type="checkbox" checked={draft.softEnabled} onChange={event => update({ softEnabled: event.target.checked })} />
                    <span>{t('assessment.enableSoft', 'Add a scored criterion')}</span>
                </label>
                {draft.softEnabled && <div className="space-y-2">
                    <label className="block space-y-1" htmlFor={`${id}-soft`}>
                        <span>{t('assessment.softCriterion', 'Scored criterion')}</span>
                        <Input id={`${id}-soft`} value={draft.softLabel} onChange={event => update({ softLabel: event.target.value })} />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="block space-y-1" htmlFor={`${id}-weight`}>
                            <span>{t('assessment.weight', 'Weight')}</span>
                            <Input id={`${id}-weight`} type="number" min={0.01} step="any" value={draft.softWeight} onChange={event => update({ softWeight: event.target.value })} />
                        </label>
                        <label className="block space-y-1" htmlFor={`${id}-threshold`}>
                            <span>{t('assessment.threshold', 'Acceptance threshold (0–100)')}</span>
                            <Input id={`${id}-threshold`} type="number" min={0} max={100} step="any" value={draft.threshold} onChange={event => update({ threshold: event.target.value })} />
                        </label>
                    </div>
                </div>}
                {invalid && <p role="alert" className="text-xs text-destructive">{t('assessment.invalidSetup', 'Add at least one criterion and check the count, positive weight, and score range.')}</p>}
            </div>}
        </section>
    )
}
