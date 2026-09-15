import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

// Real page layout plus isolated React fixtures exercise the original components.
// No native policy write, client registration, upload or generation is performed.
const base = process.env.CATEGORY_DESIGN_URL ?? 'http://127.0.0.1:5194'
const output = 'artifacts/readable-choices'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ locale: 'ko-KR' })
await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return !['http:', 'https:'].includes(url.protocol) || url.origin === new URL(base).origin ? route.continue() : route.abort()
})
const page = await context.newPage()
page.setDefaultTimeout(8000)
const report = { checks: [], errors: [] }
page.on('pageerror', error => report.errors.push(error.message))
const form = () => page.getByRole('form', { name: '실행 정책', exact: true })
const check = async (name, run) => { await run(); report.checks.push(name); console.log(`PASS ${name}`) }
const geometry = async () => form().evaluate(form => {
    const rows = [...form.querySelectorAll('.choice-row')].filter(element => element.checkVisibility())
    return {
        width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
        formWidth: form.clientWidth, formScroll: form.scrollWidth,
        columns: getComputedStyle(form.querySelector('.agent-policy-grid')).gridTemplateColumns.split(' ').length,
        rows: rows.map(row => {
            const checkbox = row.querySelector('input')
            return { height: row.getBoundingClientRect().height, control: checkbox.getBoundingClientRect().width, font: parseFloat(getComputedStyle(row).fontSize) }
        }),
    }
})
try {
    for (const width of [390, 538, 1024, 1440]) for (const theme of ['light', 'dark']) {
        await check(`policy page ${width} ${theme}`, async () => {
            await page.setViewportSize({ width, height: 960 })
            await page.goto(`${base}/data?tab=agent`)
            await form().waitFor()
            await page.evaluate(async theme => {
                const { useThemeStore } = await import('/src/stores/theme-store.ts')
                useThemeStore.getState().setTheme(theme)
            }, theme)
            const result = await geometry()
            assert.ok(result.scroll <= result.width + 1 && result.formScroll <= result.formWidth + 1)
            assert.equal(result.columns, result.formWidth >= 880 ? 2 : 1)
            for (const row of result.rows) assert.ok(row.control >= 24 && row.height >= 56 && row.font >= 16)
            await form().getByRole('heading').scrollIntoViewIfNeeded()
            await page.screenshot({ path: `${output}/policy-${width}-${theme}-top.png`, animations: 'disabled' })
            await form().getByRole('button', { name: '실행 정책 저장' }).scrollIntoViewIfNeeded()
            await page.screenshot({ path: `${output}/policy-${width}-${theme}-bottom.png`, animations: 'disabled' })
        })
    }
    await check('200 percent text keeps policy controls inside the form', async () => {
        await page.setViewportSize({ width: 538, height: 960 })
        await page.evaluate(() => {
            const elements = [...document.querySelectorAll('form[aria-label="실행 정책"] *')]
            const sizes = elements.map(element => parseFloat(getComputedStyle(element).fontSize))
            elements.forEach((element, index) => { element.style.fontSize = `${sizes[index] * 2}px` })
        })
        const result = await geometry()
        assert.ok(result.formScroll <= result.formWidth + 1 && result.scroll <= result.width + 1)
    })
    await page.goto(`${base}/data?tab=agent`)
    await form().waitFor()
    await page.evaluate(async () => {
        const { default: React } = await import('/node_modules/.vite/deps/react.js')
        const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
        const { MemoryRouter } = await import('/node_modules/.vite/deps/react-router.js')
        const { AgentPolicyForm } = await import('/src/presentation/agent/AgentPolicyForm.tsx')
        const { DEFAULT_AGENT_EXECUTION_POLICY } = await import('/src/application/agent/agent-execution-policy.ts')
        const { getRuntimeR2UploadRepository } = await import('/src/services/r2/runtime.ts')
        const { HumanAssessmentSetup } = await import('/src/components/assessment/HumanAssessmentSetup.tsx')
        const { RemoteImageProcessingConsent } = await import('/src/components/privacy/RemoteImageProcessingConsent.tsx')
        document.getElementById('root').style.display = 'none'
        const host = document.createElement('div')
        host.id = 'readable-choices-fixture'
        host.style.cssText = 'padding:24px;max-width:1100px;margin:auto'
        document.body.append(host)
        const root = ReactDOM.createRoot(host)
        window.policySaves = []
        window.policyFixture = (disabled = false, failure = false) => {
            getRuntimeR2UploadRepository().listProfiles = async () => {
                if (failure) throw new Error('QA listing unavailable')
                return [{ id: 'existing', name: 'QA 저장 연결 — 긴 이름도 읽을 수 있는지 확인' }]
            }
            const policy = structuredClone(DEFAULT_AGENT_EXECUTION_POLICY)
            policy.r2.allowedProfileIds = ['missing']
            root.render(React.createElement(MemoryRouter, null,
                React.createElement(AgentPolicyForm, { key: `${disabled}:${failure}`, policy, disabled,
                    onSave: async (revision, next) => { window.policySaves.push(structuredClone(next)) },
                }),
                React.createElement(HumanAssessmentSetup, { count: 2, value: null, onChange: () => {} }),
                React.createElement(RemoteImageProcessingConsent),
            ))
        }
        window.policyFixture()
        window.characterFixture = async () => {
            const { CharacterRotationDialog } = await import('/src/components/scene/CharacterRotationDialog.tsx')
            const { useCharacterPromptStore } = await import('/src/stores/character-prompt-store.ts')
            useCharacterPromptStore.setState({ characters: [{ id: 'qa-character', name: '긴 캐릭터 이름도 잘 읽히는 선택 항목', prompt: 'QA preview', negative: '', enabled: true, position: { x: .5, y: .5 } }] })
            root.render(React.createElement(MemoryRouter, null, React.createElement(CharacterRotationDialog, { open: true, onOpenChange: () => {} })))
        }
    })
    const edit = () => form().getByRole('checkbox', { name: /^에셋 설정 편집/ })
    await check('whole permission rows toggle independently with mouse and keyboard', async () => {
        await edit().waitFor()
        const row = edit().locator('..')
        const box = await row.boundingBox()
        await row.click({ position: { x: box.width - 8, y: box.height / 2 } })
        assert.equal(await edit().isChecked(), true)
        assert.equal(await form().getByRole('checkbox', { name: /^하위 폴더 만들기/ }).isChecked(), false)
        await edit().focus()
        await page.keyboard.press('Space')
        assert.equal(await edit().isChecked(), false)
        await edit().check()
    })
    await check('saving preserves missing connections and exact selected permissions', async () => {
        await form().getByRole('checkbox', { name: /^QA 저장 연결/ }).check()
        await form().getByRole('button', { name: '실행 정책 저장' }).click()
        await page.waitForFunction(() => window.policySaves.length === 1)
        const saved = await page.evaluate(() => window.policySaves[0])
        assert.equal(saved.authoring.allowSceneChanges, true)
        assert.equal(saved.output.allowCreateFolders, false)
        assert.equal(saved.r2.allowUpload, false)
        assert.deepEqual(saved.r2.allowedProfileIds, ['missing', 'existing'])
        await form().locator('summary').click()
        for (const checkbox of await form().locator('details input').all()) {
            assert.equal(await checkbox.isVisible(), true)
            assert.ok((await checkbox.boundingBox()).width >= 24)
        }
        await page.screenshot({ path: `${output}/enabled-controls.png`, fullPage: true })
    })
    await check('failed connection listing does not clear saved permission', async () => {
        await page.evaluate(() => window.policyFixture(false, true))
        await form().getByRole('alert').waitFor()
        await form().getByRole('button', { name: '실행 정책 저장' }).click()
        await page.waitForFunction(() => window.policySaves.length === 2)
        assert.deepEqual(await page.evaluate(() => window.policySaves[1].r2.allowedProfileIds), ['missing'])
    })
    await check('disabled policy cannot be changed or submitted', async () => {
        await page.evaluate(() => window.policyFixture(true))
        await page.waitForFunction(() => document.querySelector('#readable-choices-fixture form input')?.disabled)
        assert.equal(await edit().isDisabled(), true)
        assert.equal(await form().getByRole('button', { name: '실행 정책 저장' }).isDisabled(), true)
    })
    await check('assessment and external-processing consent keep separated clickable labels', async () => {
        const assessment = page.getByTestId('human-assessment-setup')
        const checkbox = assessment.getByRole('checkbox').first()
        await checkbox.locator('..').click()
        assert.equal(await checkbox.isChecked(), true)
        const consent = page.getByRole('checkbox', { name: '위 이미지 전송과 외부 처리에 동의해요.' })
        await consent.locator('..').click()
        assert.equal(await consent.isChecked(), true)
        assert.ok((await consent.boundingBox()).width >= 24)
        await consent.focus()
        await page.keyboard.press('Space')
        assert.equal(await consent.isChecked(), false)
    })
    await check('character dialog label and separate pin action remain usable on mobile', async () => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.evaluate(() => window.characterFixture())
        const dialog = page.getByRole('dialog')
        const checkbox = dialog.getByRole('checkbox', { name: '긴 캐릭터 이름도 잘 읽히는 선택 항목' })
        await checkbox.waitFor()
        const initiallyChecked = await checkbox.isChecked()
        const label = dialog.locator('label[for="rotation-character-qa-character"]')
        await label.click()
        assert.equal(await checkbox.isChecked(), !initiallyChecked)
        await label.click()
        assert.equal(await checkbox.isChecked(), initiallyChecked)
        assert.ok((await checkbox.boundingBox()).width >= 24)
        const layout = await dialog.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }))
        assert.ok(layout.scroll <= layout.width + 1)
        assert.equal(await checkbox.locator('..').getByRole('button').count(), 1)
        await page.screenshot({ path: `${output}/character-dialog-390.png`, animations: 'disabled' })
    })
    assert.deepEqual(report.errors, [])
} catch (error) {
    report.failure = error.stack
    await page.screenshot({ path: `${output}/failure.png` })
    process.exitCode = 1
} finally {
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
    await browser.close()
}
