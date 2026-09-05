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

describe('Guided B-E workflow contract', () => {
    it('uses semantic home choices, expands the second question inline, and preserves deep routes', async () => {
        const home = await source('src/presentation/workflow/GuidedHome.tsx')
        const preview = await source('src/presentation/workflow/GuidedPreview.tsx')

        for (const id of ['single', 'batch', 'prompt', 'library', 'environment']) {
            expect(home).toContain(`id: '${id}'`)
        }
        for (const id of ['A', 'B', 'C', 'D', 'E']) expect(home).not.toContain(`id: '${id}'`)
        expect(home).not.toContain('cursor-not-allowed')
        expect(home).toContain('<GuidedWorkflowChoices workflowId={selectedWorkflow} />')
        expect(home).toContain('else setSelectedWorkflow(choice.id)')
        expect(home).toContain("t('guided.home.resume'")
        expect(home.indexOf("t('guided.home.resume'")).toBeLessThan(home.indexOf('{choices.map(choice =>'))
        expect(preview).toContain('path="guide/:workflowId"')
        expect(preview).toContain('path="task/:workflowId/:optionId"')
        expect(preview).toContain('path="work/:draftId/:nodeId"')
        expect(preview).toContain('path="batch/:draftId/:nodeId"')
        expect(preview).not.toContain('path="guide/:workflowId/:optionId"')
    })

    it('maps all four workflow families to Guided-native task components', async () => {
        const [hub, router, preview, batch, prompt, library, environment] = await Promise.all([
            source('src/presentation/workflow/GuidedWorkflowHub.tsx'),
            source('src/presentation/workflow/GuidedTaskRouter.tsx'),
            source('src/presentation/workflow/GuidedPreview.tsx'),
            source('src/presentation/workflow/GuidedBatchImages.tsx'),
            source('src/presentation/workflow/GuidedPromptTasks.tsx'),
            source('src/presentation/workflow/GuidedLibraryTask.tsx'),
            source('src/presentation/workflow/GuidedEnvironmentTask.tsx'),
        ])

        expect(hub).toContain('to={`/guided-preview/task/${workflowId}/${option.id}`}')
        expect(router).toContain("case 'batch':")
        expect(router).toContain('<GuidedBatchTask optionId={optionId as GuidedBatchOptionId} />')
        expect(router).toContain("case 'prompt':")
        expect(router).toContain('<GuidedPromptTasks taskId={optionId} />')
        expect(router).toContain("case 'library':")
        expect(router).toContain('<GuidedLibraryTask optionId={optionId} />')
        expect(router).toContain("case 'environment':")
        expect(router).toContain('<GuidedEnvironmentTask optionId={optionId} />')
        expect(preview).toContain('<Route path="task/:workflowId/:optionId" element={<GuidedTaskRouter />} />')
        expect(preview).toContain('<Route path="batch/:draftId/:nodeId" element={<GuidedBatchImages />} />')

        expect(batch).toContain("export type GuidedBatchOptionId = 'sameSettings' | 'variations' | 'scenes' | 'queue'")
        expect(prompt).toContain("export type GuidedPromptTaskId = 'direct' | 'styleLab' | 'localAgent'")

        for (const taskSource of [hub, router, batch, prompt, library, environment]) {
            expect(taskSource).not.toMatch(/['"]\/(?:advanced|scenes|queue|data|style-lab|library|tools|trash|r2|settings|web)(?:[?'"])/)
        }
    })

    it('lets users draft before connecting and keeps compact native-shell controls accessible', async () => {
        const [preview, shell] = await Promise.all([
            source('src/presentation/workflow/GuidedPreview.tsx'),
            source('src/presentation/workflow/GuidedShell.tsx'),
        ])

        expect(preview).not.toContain('GuidedCredentialGate')
        expect(shell).toContain("isAndroidRuntime && 'android-landscape-safe-inline'")
        expect(shell).toContain('!isMac && !isMobileRuntime && <CustomTitleBar')
        expect(shell).toContain("aria-label={t('guided.activity.title', '내 작업')}")
        expect(shell).toContain('aria-expanded={activityOpen}')
        expect(shell).toContain('aria-controls="guided-activity-sheet"')
        expect(shell).toContain('id="guided-activity-sheet"')
        expect(shell).toContain("aria-label={t('guided.advanced', '고급 생성 모드')}")
    })

    it('keeps the full B-E copy tree aligned in every locale', () => {
        expect(leafKeys(ko.guided.workflows)).toEqual(leafKeys(en.guided.workflows))
        expect(leafKeys(ja.guided.workflows)).toEqual(leafKeys(en.guided.workflows))
        expect(Object.keys(ko.guided.workflows.batch.options)).toHaveLength(4)
        expect(Object.keys(ko.guided.workflows.prompt.options)).toHaveLength(3)
        expect(Object.keys(ko.guided.workflows.library.options)).toHaveLength(6)
        expect(Object.keys(ko.guided.workflows.environment.options)).toHaveLength(8)

        const locales = [ko, en, ja] as const
        for (const workflowId of ['batch', 'prompt', 'library', 'environment'] as const) {
            const optionIds = Object.keys(ko.guided.workflows[workflowId].options)
            for (const optionId of optionIds) {
                for (const locale of locales) {
                    const options = locale.guided.workflows[workflowId].options as unknown as Record<string, {
                        title: string
                        description: string
                    }>
                    expect(options[optionId].title.trim()).not.toHaveLength(0)
                    expect(options[optionId].description.trim()).not.toHaveLength(0)
                }
            }
        }
    })
})

describe('Guided single-image production contract', () => {
    it('keeps completion and review editing inside Guided without a second polling loop', async () => {
        const single = await source('src/presentation/workflow/GuidedSingleImage.tsx')

        expect(single).toContain("GUIDED_SINGLE_IMAGE_NODE_IDS = [...SINGLE_IMAGE_NODE_IDS, 'result']")
        expect(single).toContain('getRuntimeQueueRepository().listJobs({ batchId, limit: 10 })')
        expect(single).toContain('item.sourceJobId !== undefined && queuedJobIds.has(item.sourceJobId)')
        expect(single).toContain('const succeededJob = queuedJobs.find(job =>')
        expect(single).toContain("job.state === 'succeeded' && job.artifactReference !== null")
        expect(single).toContain('deriveGuidedQueueIssue(queuedJobs.map(job => job.state))')
        expect(single).toContain('GUIDED_QUEUE_ACTIVITY_REFRESH_EVENT')
        expect(single).toContain("t('guided.single.result.failedTitle'")
        expect(single).toContain("t('guided.single.result.cancelledTitle'")
        expect(single).toContain("t('guided.single.result.needsAttentionTitle'")
        expect(single.match(/<Link to="\/guided-preview\/task\/batch\/queue">/g)).toHaveLength(2)
        expect(single).toContain("navigate(`/guided-preview/work/${draft.id}/result`")
        expect(single).toContain("onEdit={submitted ? undefined : () => onEdit('prompt')}")
        expect(single).not.toContain("navigate('/advanced')")
        expect(single).not.toContain('setInterval(')
    })

    it('keeps four stable milestones, excludes the result, and leaves validation beside the blocking step', async () => {
        const single = await source('src/presentation/workflow/GuidedSingleImage.tsx')

        expect(single).toContain('GUIDED_SINGLE_IMAGE_MILESTONE_COUNT = 4')
        expect(single).toContain("nodes.push('prompt', 'resolution')")
        expect(single).toContain("nodes.push('output')")
        expect(single).toContain("['content', 'shape', 'save', 'review'][milestoneIndex]")
        expect(single).toContain("nodeId !== 'result'")
        expect(single).not.toContain('<ol className="mt-3')
        expect(single).toContain('role="alert"')
        expect(single).toContain('setStepError(')
        expect(single).not.toContain("title: t('guided.single.review.blockedTitle'")
    })

    it('keeps all Guided single-image copy aligned across locales', () => {
        expect(leafKeys(ko.guided.single)).toEqual(leafKeys(en.guided.single))
        expect(leafKeys(ja.guided.single)).toEqual(leafKeys(en.guided.single))
        expect(leafKeys(ko.guided.characters)).toEqual(leafKeys(en.guided.characters))
        expect(leafKeys(ja.guided.characters)).toEqual(leafKeys(en.guided.characters))
    })

    it('shows the shared Opus V5 allowance beside every Guided paid-consent boundary', async () => {
        const [single, batch, promptTasks] = await Promise.all([
            source('src/presentation/workflow/GuidedSingleImage.tsx'),
            source('src/presentation/workflow/GuidedBatchImages.tsx'),
            source('src/presentation/workflow/GuidedPromptTasks.tsx'),
        ])

        for (const [surface, consentMarker] of [
            [single, 'checked={consented}'],
            [batch, 'checked={consented}'],
            [promptTasks, 'checked={costConsented}'],
        ] as const) {
            expect(surface).toContain('<NovelAiV5UsageLimit')
            expect(surface.indexOf('<NovelAiV5UsageLimit')).toBeLessThan(surface.indexOf(consentMarker))
        }
        expect(promptTasks).toContain("pricingBasis === 'all-active-opus'")
    })

    it('lets free single-image work run without consent and prioritizes honest result actions', async () => {
        const single = await source('src/presentation/workflow/GuidedSingleImage.tsx')

        expect(single).toContain(') : estimatedAnlas > 0 ? (')
        expect(single).toContain('disabled={!assessmentValid || (estimatedAnlas > 0 && !consented)')
        expect(single).toContain("t('guided.single.review.free', '0 Anlas · 무료 조건')")
        expect(single).toContain("t('guided.single.review.enqueue', '이미지 1장 만들기')")
        expect(single).toContain("t('guided.single.review.queueHelp', '다른 작업이 실행 중이면 다음 순서에서 자동으로 시작합니다.')")

        const resultStart = single.indexOf('<section className="border-y border-primary/30 py-6" aria-labelledby="guided-result-keep-title">')
        const result = single.slice(resultStart)
        const orderedActions = [
            "t('guided.single.result.regenerate'",
            "t('guided.single.result.edit'",
            "t('guided.single.result.savePreset'",
            "t('guided.single.result.saveImage'",
            "t('guided.single.result.technicalDetails'",
            "t('guided.single.result.saveMetadata'",
        ]
        let previous = -1
        for (const action of orderedActions) {
            const current = result.indexOf(action)
            expect(current).toBeGreaterThan(previous)
            previous = current
        }
        expect(result).toContain('<Button type="button" onClick={onRegenerate}>')
        expect(result).toContain('<Button type="button" variant="outline" onClick={onEdit}>')
        expect(result).toContain('<details className="border-y border-border/70 py-4">')
        expect(result).toContain('variant="ghost"')
        expect(result).toContain('Seed {result.seed}')
        const captionStart = single.indexOf('<figcaption className="mt-4')
        const captionEnd = single.indexOf('</figcaption>', captionStart)
        expect(single.slice(captionStart, captionEnd)).not.toContain('Seed')
    })

    it('saves only the completed single-image prompt and generation working copy as a preset', async () => {
        const single = await source('src/presentation/workflow/GuidedSingleImage.tsx')

        expect(single).toContain('const saveSnapshot = usePresetStore(state => state.saveSnapshot)')
        expect(single).toContain('basePrompt: result.prompt')
        expect(single).toContain("additionalPrompt: ''")
        expect(single).toContain("detailPrompt: ''")
        expect(single).toContain('negativePrompt: draft.payload.prompt.negative')
        expect(single).toContain('selectedResolution: {')
        expect(single).toContain('saveSnapshot(`Guided · ${timestamp}`, workingCopy)')
        for (const excluded of ['seed:', 'output:', 'metadataMode:', 'characterPrompts:']) {
            expect(single.slice(single.indexOf('const workingCopy: PresetWorkingCopy = {'), single.indexOf('saveSnapshot(`Guided · ${timestamp}`'))).not.toContain(excluded)
        }
    })

    it('keeps character prompts inside each Guided draft and behind one compact sheet', async () => {
        const [single, batch, sheet] = await Promise.all([
            source('src/presentation/workflow/GuidedSingleImage.tsx'),
            source('src/presentation/workflow/GuidedBatchImages.tsx'),
            source('src/presentation/workflow/GuidedCharacterPromptSheet.tsx'),
        ])

        expect(single).toContain('<GuidedCharacterPromptSheet')
        expect(single).toContain('characterPromptsRef.current = value')
        expect(batch).toContain('<GuidedCharacterPromptSheet')
        expect(batch).toContain('editableRef.current = { ...editableRef.current, characterPrompts: value }')
        expect(sheet).toContain('side="right"')
        expect(sheet).toContain('<details className="mt-4 border-t border-border/55 pt-3">')
        expect(sheet).not.toContain('DndContext')
    })

    it('does not erase a legacy Variety+ choice when Guided switches to V5', async () => {
        const [single, batch] = await Promise.all([
            source('src/presentation/workflow/GuidedSingleImage.tsx'),
            source('src/presentation/workflow/GuidedBatchImages.tsx'),
        ])

        for (const workflow of [single, batch]) {
            expect(workflow).not.toMatch(/variety:\s*isNovelAiV5Model\(model\)/)
            expect(workflow).toContain('...current.payload.generation')
        }
    })

    it('reuses one foldered prompt-module picker across single, batch, and scene editors', async () => {
        const [single, advanced, scene, picker, creator, editor] = await Promise.all([
            source('src/presentation/workflow/GuidedSingleImage.tsx'),
            source('src/components/prompt/PromptEditorSurface.tsx'),
            source('src/components/scene/ScenePromptEditor.tsx'),
            source('src/components/fragments/PromptModulePicker.tsx'),
            source('src/components/fragments/PromptModuleCreator.tsx'),
            source('src/components/fragments/PromptModuleContentEditor.tsx'),
        ])

        expect(single.match(/<PromptModulePicker/g)).toHaveLength(2)
        expect(advanced).toContain('<PromptModulePicker')
        expect(scene).toContain('<PromptModulePicker')
        expect(picker).toContain('useFragmentStore(state => state.files)')
        expect(picker).toContain('onSelectLine(line)')
        expect(picker).toContain('<PromptModuleCreator')
        expect(picker).toContain('<PromptModuleContentEditor')
        expect(picker).not.toContain('addFile(')
        expect(picker).not.toContain('updateFile(')
        expect(creator).toContain('setContent(promptModuleSourceLine(sourceText))')
        expect(creator).toContain('}, [open, sourceText, suggestedName])')
        expect(editor).toContain('updateFile(file.id, { content: lines })')
        expect(editor).toContain('onSaved?.(lines)')
        expect(editor).not.toContain('normalizeFragmentPath')
    })

    it('keeps prompt-module copy aligned across locales', () => {
        expect(leafKeys(ko.guided.promptModules)).toEqual(leafKeys(en.guided.promptModules))
        expect(leafKeys(ja.guided.promptModules)).toEqual(leafKeys(en.guided.promptModules))
    })

    it('anchors hidden Guided radios inside the scroll surface', async () => {
        const [shell, ...surfaces] = await Promise.all([
            source('src/presentation/workflow/GuidedShell.tsx'),
            source('src/presentation/workflow/GuidedSingleImage.tsx'),
            source('src/presentation/workflow/GuidedBatchImages.tsx'),
            source('src/presentation/workflow/GuidedPromptTasks.tsx'),
        ])
        const radios = surfaces.flatMap(surface => [
            ...surface.matchAll(/className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"/g),
        ]
            .map(match => ({ surface, index: match.index })))

        expect(shell).toContain("cn('relative min-w-0 flex-1 overflow-y-auto surface-canvas'")
        expect(radios).toHaveLength(6)
        expect(surfaces.join('\n')).not.toMatch(/type="radio"[^/]*className="sr-only"/)
        expect(surfaces.join('\n')).not.toContain('<motion.section')
        expect(surfaces.join('\n')).not.toContain('<motion.main')
        for (const { surface, index } of radios) {
            const labelStart = surface.lastIndexOf('<label', index)
            const labelEnd = surface.indexOf('>', labelStart)
            expect(surface.slice(labelStart, labelEnd + 1)).toContain('relative')
        }
    })
})
