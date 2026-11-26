import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import ko from '@/i18n/locales/ko.json'
import en from '@/i18n/locales/en.json'
import ja from '@/i18n/locales/ja.json'
import {
    portableIssuesForResolvedPlan,
    presentCompositionIssue,
    ResolvedPlanView,
    type ReadonlyCompositionIssue,
} from '@/components/composition-workspace'

// core.autocrlf checkouts expand sources to CRLF; snippets below are written with LF.
const source = async (path: string) => (await readFile(resolve(process.cwd(), path), 'utf8')).replace(/\r\n/g, '\n')
const i18n = createInstance()

const issue = (input: Partial<ReadonlyCompositionIssue> = {}): ReadonlyCompositionIssue => ({
    code: 'E_RECIPE_MISSING',
    severity: 'error',
    messageKey: 'composition.issue.recipeMissing',
    repairHintKey: 'composition.repair.selectRecipe',
    fieldPath: ['recipes', 0, 'id'],
    entityRef: { kind: 'recipe', id: 'recipe:missing' },
    actionId: 'select-recipe',
    blocking: true,
    ...input,
})

beforeAll(async () => {
    await i18n.init({
        lng: 'ko',
        fallbackLng: false,
        resources: { ko: { translation: ko } },
        interpolation: { escapeValue: false },
    })
})

function renderIssue(value: ReadonlyCompositionIssue, repairable = false): string {
    return renderToStaticMarkup(createElement(
        I18nextProvider,
        { i18n },
        createElement(ResolvedPlanView, {
            plan: null,
            issues: [value],
            onRepairIssue: () => undefined,
            canRepairIssue: () => repairable,
            labels: { repair: '문제 해결', technical: '기술 정보', issueDiagnostics: '문제 진단 정보' },
        }),
    ))
}

describe('composition issue presentation', () => {
    it('shows localized user copy with a visible text repair action and keeps raw diagnostics folded', () => {
        const markup = renderIssue(issue(), true)
        const visible = markup.slice(0, markup.indexOf('<details'))

        expect(visible).toContain('사용할 생성 구성을 찾을 수 없어요')
        expect(visible).toContain('사용할 생성 구성을 다시 선택해 주세요.')
        expect(visible).toContain('문제 해결')
        expect(visible).not.toContain('E_RECIPE_MISSING')
        expect(visible).not.toContain('composition.issue.recipeMissing')
        expect(markup).toContain('E_RECIPE_MISSING')
        expect(markup).toContain('composition.issue.recipeMissing')
        expect(markup).toContain('recipe:missing')
        expect(markup).toContain('recipes')
    })

    it('fails closed for unknown locale keys while allowing an actual human sentence', () => {
        const translations: Record<string, string> = {
            'composition.issue.genericErrorTitle': 'Safe title',
            'composition.issue.genericErrorDescription': 'Safe description',
        }
        expect(presentCompositionIssue(issue({ messageKey: 'composition.issue.notRegistered' }), key => translations[key])).toEqual({
            title: 'Safe title',
            description: 'Safe description',
        })
        expect(presentCompositionIssue(issue({ messageKey: 'Choose a valid prompt before generating.' }), key => translations[key])).toEqual({
            title: 'Choose a valid prompt before generating.',
            description: 'Safe description',
        })
        expect(presentCompositionIssue(issue({
            messageKey: 'Choose a valid prompt before generating.',
            repairHintKey: 'composition.repair.notRegistered',
        }), key => translations[key] ?? key)).toEqual({
            title: 'Choose a valid prompt before generating.',
            description: 'Safe description',
        })
    })

    it('renders issues without a plan and hides unsupported repair actions', () => {
        const markup = renderIssue(issue({ actionId: 'repair-document' }))
        const visible = markup.slice(0, markup.indexOf('<details'))

        expect(visible).toContain('사용할 생성 구성을 찾을 수 없어요')
        expect(visible).not.toContain('<button')
        expect(markup).toContain('repair-document')
    })

    it('maps all portable failures to stable locale and repair keys', () => {
        const codes = [
            'E_PORTABLE_PATH_INVALID',
            'E_PORTABLE_PATH_ROOT_UNSUPPORTED',
            'E_PORTABLE_PATH_TOKEN_MISSING',
            'E_PORTABLE_PATH_PLATFORM_MISMATCH',
        ] as const
        const mapped = portableIssuesForResolvedPlan(codes.map(code => ({
            code,
            message: 'raw English platform message',
            blocking: true as const,
            resourceId: 'resource:1',
            repairAction: { kind: 'select-file' as const, label: 'raw repair label' },
        })))

        expect(mapped.map(value => value.messageKey)).toEqual([
            'composition.issue.portablePathInvalid',
            'composition.issue.portablePathRootUnsupported',
            'composition.issue.portablePathTokenMissing',
            'composition.issue.portablePathPlatformMismatch',
        ])
        expect(mapped.every(value => value.repairHintKey?.startsWith('composition.repair.'))).toBe(true)
        expect(JSON.stringify(mapped)).not.toContain('raw English')
    })

    it('keeps issue and repair locale keys in ko/en/ja parity', () => {
        const composition = (locale: typeof ko) => locale.composition as typeof ko.composition
        expect(Object.keys(composition(en as typeof ko).issue).sort()).toEqual(Object.keys(composition(ko).issue).sort())
        expect(Object.keys(composition(ja as typeof ko).issue).sort()).toEqual(Object.keys(composition(ko).issue).sort())
        expect(Object.keys(composition(en as typeof ko).repair).sort()).toEqual(Object.keys(composition(ko).repair).sort())
        expect(Object.keys(composition(ja as typeof ko).repair).sort()).toEqual(Object.keys(composition(ko).repair).sort())
    })

    it('routes only supported Main repairs through existing surfaces after closing the resolved sheet', async () => {
        const main = await source('src/pages/MainMode.tsx')

        expect(main).toContain("case 'select-recipe':")
        expect(main).toContain("case 'repair-reference':")
        expect(main).toContain("case 'review-output-path':")
        expect(main).toContain('default:\n                return null')
        expect(main).toContain('setResolvedSheetOpen(false)')
        expect(main).toContain('requestAnimationFrame(() => {')
        expect(main).toContain("navigate('/settings?section=storage')")
        for (const unsupported of ['select-file', 'select-directory', 'copy-to-app-data', 'select-profile', 'repair-document', 'complete-engine-defaults']) {
            expect(main).not.toContain(`case '${unsupported}':`)
        }
    })
})
