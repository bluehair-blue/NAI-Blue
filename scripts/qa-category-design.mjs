import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Isolated local browser storage; no credentials, user files or Provider requests.
const base = process.env.CATEGORY_DESIGN_URL ?? 'http://127.0.0.1:5194'
const output = path.resolve('artifacts/category-design')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ locale: 'ko-KR' })
await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return !['http:', 'https:'].includes(url.protocol) || url.origin === new URL(base).origin
        ? route.continue() : route.abort()
})
const page = await context.newPage()
page.setDefaultTimeout(8000)
const filter = process.env.CATEGORY_DESIGN_CHECK
const report = { filter: filter ?? null, checks: [], errors: [] }
page.on('pageerror', error => report.errors.push(error.message))
const routes = ['folders', 'advanced', 'scenes', 'tools', 'style-lab', 'queue', 'data', 'r2', 'library', 'settings', 'web', 'trash']
const visit = async route => {
    await page.goto(`${base}/${route}`)
    await page.locator('.workspace-shell').waitFor()
    await page.waitForFunction(() => document.querySelector('.workspace-content')?.children.length > 0)
}
const check = async (name, run) => {
    if (filter && !name.includes(filter)) return
    await run()
    report.checks.push(name)
    console.log(`PASS ${name}`)
}
try {
    for (const width of [390, 768, 1536]) {
        await page.setViewportSize({ width, height: 960 })
        for (const theme of ['light', 'dark']) {
            for (const route of routes) await check(`${route} ${theme} ${width}`, async () => {
                await visit(route)
                await page.evaluate(async theme => {
                    const { useThemeStore } = await import('/src/stores/theme-store.ts')
                    useThemeStore.getState().setTheme(theme)
                }, theme)
                const geometry = await page.evaluate(() => {
                    const root = document.documentElement
                    const main = document.querySelector('.workspace-content')
                    const style = getComputedStyle(document.body)
                    return {
                        width: root.clientWidth, scroll: root.scrollWidth,
                        mainWidth: main.clientWidth, mainScroll: main.scrollWidth,
                        palette: style.getPropertyValue('--background').trim(),
                        header: [...document.querySelectorAll('.fb-app-navigation a, .fb-app-tools, .fb-theme-toggle')].map(element => {
                            const box = element.getBoundingClientRect()
                            return { x: box.x, right: box.right, width: box.width, height: box.height }
                        }),
                    }
                })
                assert.ok(geometry.scroll <= geometry.width + 1)
                assert.ok(geometry.mainScroll <= geometry.mainWidth + 1)
                assert.equal(geometry.palette, theme === 'light' ? '0.945 0.014 265' : '0.225 0.037 265')
                assert.equal(geometry.header.length, 4)
                for (const box of geometry.header) assert.ok(box.x >= 0 && box.right <= width + 1 && box.width >= 44 && box.height >= 44)
                if (!['advanced', 'scenes'].includes(route)) assert.equal(await page.locator('#nai-blue-prompt-dock').isVisible(), false)
                await page.locator('.fb-app-tools').click()
                for (const destination of routes.filter(value => !['folders', 'queue'].includes(value))) {
                    assert.equal(await page.locator(`[role="menuitem"][href="/${destination}"]`).count(), 1)
                }
                if (!['folders', 'queue'].includes(route)) assert.equal(await page.locator(`[role="menuitem"][href="/${route}"]`).getAttribute('aria-current'), 'page')
                await page.keyboard.press('Escape')
                await page.getByRole('menu').waitFor({ state: 'hidden' })
                await page.waitForFunction(() => document.activeElement?.matches('.fb-app-tools'))
                await page.screenshot({ path: path.join(output, `${route}-${theme}-${width}.png`), animations: 'disabled' })
            })
        }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await check('empty queue leads to workbench', async () => {
        await visit('queue')
        await page.getByRole('link', { name: '에셋 작업대에서 시작하기' }).click()
        await page.waitForURL('**/folders')
    })
    await check('empty queue can switch execution authority', async () => {
        await visit('queue')
        const options = page.locator('details.workspace-disclosure').filter({ hasText: '실행 방식 · 오류 처리' })
        await options.waitFor()
        assert.equal(await options.evaluate(element => element.open), false)
        await options.locator('summary').click()
        const authority = options.locator('select').filter({ has: page.locator('option[value="durable"]') })
        await authority.selectOption('legacy')
        await page.waitForFunction(() => document.querySelector('select option[value="durable"]')?.parentElement?.value === 'legacy')
        await authority.selectOption('durable')
        await page.waitForFunction(() => document.querySelector('select option[value="durable"]')?.parentElement?.value === 'durable')
        assert.equal(await options.locator('select').filter({ has: page.locator('option[value="stop-on-first-error"]') }).count(), 0)
    })
    await check('style preparation and mobile section selection', async () => {
        await visit('style-lab')
        await page.getByRole('button', { name: '작가 조합 준비하기' }).click()
        const selector = page.locator('select').filter({ has: page.locator('option[value="battle"]') })
        assert.equal(await selector.inputValue(), 'manage')
        for (const tab of ['market', 'collection', 'evolve', 'analyze', 'stats', 'settings', 'battle']) {
            await selector.selectOption(tab)
            assert.equal(await selector.inputValue(), tab)
            assert.equal(await page.getByRole('tabpanel').count(), 1)
        }
    })
    await check('tools reveal image actions after import', async () => {
        await visit('tools')
        assert.equal(await page.getByRole('button', { name: '배경 제거 실행', exact: true }).count(), 0)
        await page.locator('input[type="file"]').first().setInputFiles({
            name: 'qa.png', mimeType: 'image/png',
            buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64'),
        })
        await page.getByRole('button', { name: '배경 제거 실행', exact: true }).waitFor()
        assert.equal(await page.getByRole('button', { name: '배경 제거 실행', exact: true }).isDisabled(), true)
        await page.getByRole('button', { name: '이미지 제거', exact: true }).click()
        await page.getByRole('button', { name: '이미지 열기', exact: true }).waitFor()
    })
    await check('Prompt and History menu sheets restore focus', async () => {
        await visit('advanced')
        for (const surface of ['prompt', 'history']) {
            await page.locator('.fb-app-tools').click()
            await page.locator(`[role="menuitem"][aria-controls="nai-blue-${surface}-sheet"]`).click()
            await page.locator(`#nai-blue-${surface}-sheet`).waitFor()
            await page.keyboard.press('Escape')
            await page.locator(`#nai-blue-${surface}-sheet`).waitFor({ state: 'hidden' })
            await page.waitForFunction(() => document.activeElement?.matches('.fb-app-tools'))
        }
    })
    await check('populated queue keeps controls and discloses policies', async () => {
        await visit('queue')
        await page.evaluate(async () => {
            const { getRuntimeQueueRepository } = await import('/src/services/queue/indexeddb-queue-repository.ts')
            const { createGenerationJobSnapshot } = await import('/src/services/queue/job-snapshot.ts')
            const repository = getRuntimeQueueRepository()
            const now = new Date().toISOString()
            await repository.createBatchAndEnqueue({
                batch: { id: 'qa-design', workflow: 'main', createdAt: now, failurePolicy: 'continue', origin: 'fresh', idempotencyKey: 'qa-design' },
                jobs: [{
                    id: 'qa-design-job', batchId: 'qa-design', workflow: 'main', sceneId: null,
                    createdAt: now, priority: 0, ordinal: 0, compositionPlanHash: null,
                    maxAttempts: 1, idempotencyKey: 'qa-design-job',
                    snapshot: createGenerationJobSnapshot({ prompt: { positive: 'QA only', negative: '' }, parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable' }),
                }],
            })
            await repository.setBatchControl({ batchId: 'qa-design', state: 'paused', now, reason: 'user' })
        })
        await page.reload()
        const options = page.locator('summary').filter({ hasText: '실행 방식 · 오류 처리' })
        await options.waitFor()
        assert.equal(await options.locator('..').evaluate(element => element.open), false)
        assert.equal(await page.getByRole('button', { name: '계속', exact: true }).isVisible(), true)
        assert.equal(await page.getByRole('button', { name: '전체 취소', exact: true }).isVisible(), true)
        await options.click()
        const policy = page.locator('select').filter({ has: page.locator('option[value="stop-on-first-error"]') })
        await policy.selectOption('pause-on-fatal')
        // Queue controls project the repository after the async write and revision refresh.
        await page.waitForFunction(() => document.querySelector('select:has(option[value="stop-on-first-error"])')?.value === 'pause-on-fatal')
        assert.equal(await policy.inputValue(), 'pause-on-fatal')
        await options.click()
        const jobs = page.locator('[role="list"][aria-label]').filter({ has: page.locator('[role="listitem"]') })
        await jobs.scrollIntoViewIfNeeded()
        const box = await jobs.boundingBox()
        assert.ok(box && box.height >= 256 && box.y < 844 && box.y + box.height <= 845)
        await page.screenshot({ path: path.join(output, 'queue-populated-mobile.png') })
    })
    assert.deepEqual(report.errors, [])
} catch (error) {
    report.failure = error.stack
    await page.screenshot({ path: path.join(output, 'failure.png') })
    process.exitCode = 1
} finally {
    await writeFile(path.join(output, filter ? 'report-focused.json' : 'report.json'), JSON.stringify(report, null, 2))
    await browser.close()
}
