import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

function leafKeys(value: unknown, prefix = ''): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
    return Object.entries(value as Record<string, unknown>)
        .flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
        .sort()
}

function hasPath(value: unknown, path: string): boolean {
    return path.split('.').every(segment => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !(segment in value)) return false
        value = (value as Record<string, unknown>)[segment]
        return true
    })
}

describe('Guided batch production contract', () => {
    it('keeps all four choices inside Guided and exports starter, editor, and queue surfaces', async () => {
        const component = await source('src/presentation/workflow/GuidedBatchImages.tsx')

        expect(component).toContain('export function GuidedBatchTask')
        expect(component).toContain('export function GuidedBatchImages')
        expect(component).toContain('export function GuidedBatchQueueSurface')
        expect(component).toContain("sameSettings: 'same-settings'")
        expect(component).toContain("variations: 'variations'")
        expect(component).toContain("scenes: 'scenes'")
        expect(component).toContain("selected === 'queue'")
        expect(component).not.toContain("navigate('/advanced')")
        expect(component).not.toContain("navigate('/scenes')")
        expect(component).not.toContain("navigate('/queue')")
        expect(component).not.toContain('useGenerationStore')
    })

    it('returns every batch surface to the second-level method picker', async () => {
        const component = await source('src/presentation/workflow/GuidedBatchImages.tsx')

        expect(component).toContain('<Link to="/guided-preview/guide/batch"')
        expect(component).toContain("navigate('/guided-preview/guide/batch')")
        expect(component.match(/\/guided-preview\/guide\/batch/g)?.length).toBeGreaterThanOrEqual(4)
    })

    it('offers both resume and new work without letting a completed draft block creation', async () => {
        const component = await source('src/presentation/workflow/GuidedBatchImages.tsx')

        expect(component).toContain("const recent = drafts[0] ?? null")
        expect(component).toContain("t('guided.batch.starter.resume'")
        expect(component).toContain("t('guided.batch.starter.new'")
        expect(component).toContain('if (createInFlightRef.current) return')
        expect(component).toContain('for (let attempt = 0; attempt < 2; attempt += 1)')
        expect(component).toContain("if (result.status === 'conflict') continue")
        expect(component).toContain("draft.status === 'queued' || draft.status === 'completed'")
    })

    it('requires detached planning, explicit cost consent, stable idempotency, and durable previews', async () => {
        const [component, single, command] = await Promise.all([
            source('src/presentation/workflow/GuidedBatchImages.tsx'),
            source('src/presentation/workflow/GuidedSingleImage.tsx'),
            source('src/presentation/generation/workflow-draft-generation-command.ts'),
        ])
        const results = await source('src/presentation/workflow/guided-batch-results.ts')

        for (const guided of [component, single]) {
            expect(guided).toContain('enqueueWorkflowDraftGenerationCommand({')
            expect(guided).toContain('drafts: getWorkflowDraftRepository()')
            expect(guided).toContain('fragmentRepository: useFragmentStore.getState().getLookupRepository()')
            expect(guided).not.toContain('enqueuePlannedMainBatch')
        }
        expect(command).toContain('planWorkflowDraftGeneration(planInput, {')
        expect(command).toContain('createAnlasCostConsentSnapshot({')
        expect(command).toContain('return enqueueGeneration<PreparedMainGeneration>({')
        expect(command).toContain("actor: { kind: 'user', id: 'guided-ui:user' }")
        expect(command).toContain('idempotencyKey: `guided:${input.draft.id}:revision:${input.draft.revision}`')
        expect(command).not.toContain('privatePayload')
        expect(command).not.toContain('spool')
        expect(component).toContain('listGuidedBatchResultJobs(batchId, resultLimit)')
        expect(results).toContain('Math.min(250, requested - items.length)')
        expect(component).toContain('onLoadMore={() => setResultLimit(current => current + 48)}')
        expect(component).toContain('readJobArtifact(job.id, artifactId)')
        expect(component).toContain('[artifactId, format, job.id]')
        expect(component).toContain('GUIDED_QUEUE_ACTIVITY_REFRESH_EVENT')
        expect(component).not.toContain('setInterval(')
    })

    it('lets free batches run without consent and keeps queue behavior as help text', async () => {
        const component = await source('src/presentation/workflow/GuidedBatchImages.tsx')

        expect(component).toContain('{estimatedAnlas > 0 && (')
        expect(component).toContain('disabled={!assessmentValid || (estimatedAnlas > 0 && !consented)')
        expect(component).toContain("t('guided.batch.review.free', '0 Anlas · 무료 조건')")
        expect(component).toContain("t('guided.batch.review.enqueue', '{{count}}장 만들기'")
        expect(component).toContain("t('guided.batch.review.queueHelp', '다른 작업이 실행 중이면 다음 순서에서 자동으로 시작합니다.')")
    })

    it('prioritizes repeat, prompt editing, and preset save without exposing seeds in card captions', async () => {
        const component = await source('src/presentation/workflow/GuidedBatchImages.tsx')
        const resultStart = component.indexOf('<section className="border-y border-primary/30 py-6">')
        const result = component.slice(resultStart)

        const repeat = result.indexOf("t('guided.batch.result.regenerate'")
        const edit = result.indexOf("t('guided.batch.result.edit'")
        const preset = result.indexOf("t('guided.batch.result.savePreset'")
        const queue = result.indexOf("t('guided.batch.result.queue'")
        expect(repeat).toBeGreaterThanOrEqual(0)
        expect(repeat).toBeLessThan(edit)
        expect(edit).toBeLessThan(preset)
        expect(preset).toBeLessThan(queue)
        expect(result).toContain('<Button type="button" onClick={onRetry}>')
        expect(result).toContain('<Button type="button" variant="outline" onClick={onEdit}>')
        expect(component).toContain('<span className="block font-mono text-foreground">#{job.ordinal + 1}</span>')
        expect(component).not.toContain('` · Seed ${facts.seed}`')
    })

    it('saves only the common batch prompt and generation working copy as a preset', async () => {
        const component = await source('src/presentation/workflow/GuidedBatchImages.tsx')
        const projectionStart = component.indexOf('const workingCopy: PresetWorkingCopy = {')
        const projectionEnd = component.indexOf('saveSnapshot(`Guided · ${timestamp}`', projectionStart)
        const projection = component.slice(projectionStart, projectionEnd)

        expect(component).toContain('const saveSnapshot = usePresetStore(state => state.saveSnapshot)')
        expect(projection).toContain('basePrompt: draft.payload.prompt.positive')
        expect(projection).toContain("additionalPrompt: ''")
        expect(projection).toContain("detailPrompt: ''")
        expect(projection).toContain('negativePrompt: draft.payload.prompt.negative')
        expect(projection).toContain('selectedResolution: {')
        for (const excluded of ['seed:', 'output:', 'metadataMode:', 'characterPrompts:', 'batchMode:']) {
            expect(projection).not.toContain(excluded)
        }
    })

    it('persists the visible output folder and format without coupling them to cost consent', async () => {
        const [component, outputStep] = await Promise.all([
            source('src/presentation/workflow/GuidedBatchImages.tsx'),
            source('src/presentation/workflow/GuidedOutputDestinationStep.tsx'),
        ])

        expect(outputStep).toContain('if (next !== value.directory) onChange({ directory: next })')
        expect(outputStep).toContain("imageFormat: event.target.value as SingleImageOutputSettings['imageFormat']")
        expect(outputStep).toContain('outputPatchFromGenerationFolder')
        expect(component).toContain('<GuidedOutputDestinationStep')
        expect(component).toContain('output: { ...current.payload.output, ...patch }')
        expect(component).toContain("t('guided.batch.review.output'")
    })

    it('does not leave failed or cancelled terminal batches looking active forever', async () => {
        const component = await source('src/presentation/workflow/GuidedBatchImages.tsx')

        expect(component).toContain('const finishedWithIssues = summary !== null')
        expect(component).toContain("summary?.states.cancelled")
        expect(component).toContain("summary?.states.skipped")
        expect(component).toContain("guided.batch.result.finishedWithIssues")
        expect(component).toContain("guided.batch.result.noSuccessfulResults")
    })

    it('resumes batch drafts through the My Work rail', async () => {
        const activity = await source('src/presentation/activity/MyWorkActivity.tsx')

        expect(activity).toContain("draft.kind === 'batch-image'")
        expect(activity).toContain('`/guided-preview/batch/${draft.id}/${targetNode}`')
        expect(activity).toContain('`guided.batch.steps.${targetNode}.short`')
    })

    it('keeps production batch copy aligned and covers every static component key', async () => {
        expect(leafKeys(ko.guided.batch)).toEqual(leafKeys(en.guided.batch))
        expect(leafKeys(ja.guided.batch)).toEqual(leafKeys(en.guided.batch))

        const component = await source('src/presentation/workflow/GuidedBatchImages.tsx')
        const referenced = [...component.matchAll(/t\('([^']+)'/g)]
            .map(match => match[1])
            .filter((key): key is string => key?.startsWith('guided.batch.') === true)
        for (const key of referenced) {
            const relative = key.slice('guided.batch.'.length)
            expect(hasPath(ko.guided.batch, relative), `ko is missing ${key}`).toBe(true)
            expect(hasPath(en.guided.batch, relative), `en is missing ${key}`).toBe(true)
            expect(hasPath(ja.guided.batch, relative), `ja is missing ${key}`).toBe(true)
        }
    })

    it('describes Guided-native batch execution instead of external expert handoffs', () => {
        expect(ko.guided.workflows.batch.description).toContain('Guided 안에서')
        expect(en.guided.workflows.batch.description).toContain('without leaving Guided')
        expect(ja.guided.workflows.batch.description).toContain('Guided内')
        expect(ko.guided.workflows.batch.options.sameSettings.description).toContain('생성 수량')
        expect(en.guided.workflows.batch.options.variations.description).toContain('random')
        expect(ja.guided.workflows.batch.options.scenes.description).toContain('シーン')
    })
})
