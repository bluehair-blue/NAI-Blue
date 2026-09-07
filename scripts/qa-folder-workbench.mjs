import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Isolated browser storage and local-only routing keep fixture QA away from user data and Providers.
const base = process.env.FOLDER_WORKBENCH_URL ?? 'http://127.0.0.1:5194'
const output = path.resolve('artifacts/folder-workbench')
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), base, checks: [], blockedRequests: [], pageErrors: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'ko-KR' })
await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(base).origin) {
        report.blockedRequests.push(url.origin + url.pathname)
        return route.abort()
    }
    return route.continue()
})
const page = await context.newPage()
page.on('pageerror', error => report.pageErrors.push(error.message))
const check = async (name, run) => {
    const started = performance.now()
    try {
        await run()
        report.checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - started) })
    } catch (error) {
        report.checks.push({ name, passed: false, milliseconds: Math.round(performance.now() - started), failure: error.stack ?? String(error) })
        await page.screenshot({ path: path.join(output, `failure-${report.checks.length}.png`), fullPage: true })
    }
}
const rows = () => page.locator('[data-scene-id]')
const summary = () => page.getByTestId('folder-workbench').locator('[aria-live="polite"]').first()
const waitText = async text => page.getByText(text, { exact: false }).first().waitFor()
try {
    await check('default route redirects to folders', async () => {
        await page.goto(base)
        await page.getByTestId('folder-workbench').waitFor()
        assert.equal(new URL(page.url()).pathname, '/folders')
        await page.waitForFunction(async () => (await import('/src/stores/scene-store.ts')).useSceneStore.getState().sceneAuthorityInitialized)
    })
    const fixture = await page.evaluate(async () => {
        const { useSettingsStore } = await import('/src/stores/settings-store.ts')
        const store = useSettingsStore.getState()
        return {
            small: await store.addGenerationFolder({ name: 'QA Paste Folder' }),
            large: await store.addGenerationFolder({ name: 'QA 2400 Folder' }),
        }
    })
    await check('folder search filters folder navigation', async () => {
        const search = page.getByLabel('폴더 검색', { exact: true })
        await search.fill('2400')
        assert.equal(await page.getByRole('button', { name: 'QA Paste Folder', exact: true }).count(), 0)
        assert.equal(await page.getByRole('button', { name: 'QA 2400 Folder', exact: true }).count(), 1)
        await search.fill('')
    })
    await check('GUI bulk paste preview and durable import', async () => {
        await page.getByRole('button', { name: 'QA Paste Folder', exact: true }).click()
        await page.getByRole('button', { name: '여러 프롬프트 붙여넣기', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.locator('textarea').fill('QA happy\tsmile, looking at viewer\t3\nQA sad\ttears, looking down\t2\nQA surprised\twide eyes, open mouth\t1')
        await dialog.getByText('추가 전 확인 · 처음 5개', { exact: true }).waitFor()
        assert.equal(await dialog.locator('ol li').count(), 3)
        await dialog.getByRole('button', { name: '항목 3개 추가', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(await rows().count(), 3)
        await page.reload()
        await page.getByLabel('QA happy 생성 수량', { exact: true }).waitFor()
        await page.waitForFunction(async () => (await import('/src/stores/scene-store.ts')).useSceneStore.getState().sceneAuthorityInitialized)
        for (const [name, count] of [['happy', '3'], ['sad', '2'], ['surprised', '1']]) {
            assert.equal(await page.getByLabel(`QA ${name} 생성 수량`, { exact: true }).inputValue(), count)
        }
        await page.screenshot({ path: path.join(output, 'paste-reloaded-desktop.png'), fullPage: true })
    })
    await check('2400 standard imports persist', async () => {
        await page.evaluate(async ({ large }) => {
            const { createFolderAssetPreset } = await import('/src/presentation/folders/folder-workbench.ts')
            const { useSceneStore } = await import('/src/stores/scene-store.ts')
            const { flushSceneAuthorityRuntime } = await import('/src/lib/scene-authority-runtime.ts')
            useSceneStore.getState().importPreset(createFolderAssetPreset({
                name: 'QA scale preset', folderId: large,
                rows: Array.from({ length: 2400 }, (_, index) => ({ name: `QA item ${String(index).padStart(4, '0')}`, prompt: `${index % 2 ? 'oddgroup' : 'evengroup'}, distinct prompt ${index}`, count: 1 })),
            }))
            await flushSceneAuthorityRuntime()
        }, fixture)
        await page.getByRole('button', { name: 'QA 2400 Folder', exact: true }).click()
        await waitText('검색 결과 2400개 중 선택 0개')
        assert.equal(await rows().count(), 60)
        await page.reload()
        await waitText('검색 결과 2400개 중 선택 0개')
        assert.equal(await rows().count(), 60)
    })
    await check('search, all-results selection, quantity and exact displayed target', async () => {
        const search = page.getByLabel('항목 이름 · 프롬프트 검색', { exact: true })
        await search.fill('evengroup')
        await page.getByRole('button', { name: '검색 결과 전체 1200개 선택', exact: true }).click()
        await page.getByLabel('항목당 수량', { exact: true }).fill('3')
        await page.getByRole('button', { name: '선택에 적용', exact: true }).click()
        await waitText('검색 결과 1200개 중 선택 1200개 · 총 3600장')
        await search.fill('oddgroup')
        await waitText('검색 결과 1200개 중 선택 0개 · 총 0장')
        assert.equal(await page.getByRole('button', { name: '선택 0장 생성 검토', exact: true }).isDisabled(), true)
        await search.fill('evengroup')
        await waitText('검색 결과 1200개 중 선택 1200개 · 총 3600장')
        await page.getByRole('button', { name: 'QA Paste Folder', exact: true }).click()
        await page.getByRole('button', { name: 'QA 2400 Folder', exact: true }).click()
        assert.equal(await search.inputValue(), 'evengroup')
        assert.match(await summary().innerText(), /선택 1200개 · 총 3600장/)
        assert.equal(await page.getByLabel('QA item 0000 생성 수량', { exact: true }).inputValue(), '3')
    })
    await check('keyboard views and pagination stay bounded', async () => {
        const grid = page.getByRole('button', { name: '썸네일 보기', exact: true })
        await grid.focus()
        await page.keyboard.press('Enter')
        assert.equal(await grid.getAttribute('aria-pressed'), 'true')
        assert.equal(await rows().count(), 60)
        const next = page.getByRole('button', { name: '다음', exact: true })
        await next.focus()
        await page.keyboard.press('Enter')
        await page.getByLabel('QA item 0120 선택', { exact: true }).waitFor()
        assert.equal(await rows().count(), 60)
        await page.getByRole('button', { name: '목록 보기', exact: true }).click()
        await page.getByRole('button', { name: '이전', exact: true }).click()
        await page.getByLabel('QA item 0000 선택', { exact: true }).waitFor()
    })
    for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
        await check(`viewport ${viewport.width}x${viewport.height} overflow and keyboard access`, async () => {
            await page.setViewportSize(viewport)
            const geometry = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }))
            assert.ok(geometry.scrollWidth <= geometry.innerWidth, JSON.stringify(geometry))
            assert.ok(geometry.bodyWidth <= geometry.innerWidth, JSON.stringify(geometry))
            const apply = page.getByRole('button', { name: '선택에 적용', exact: true })
            await apply.scrollIntoViewIfNeeded()
            await apply.focus()
            assert.equal(await apply.evaluate(element => document.activeElement === element), true)
            const box = await apply.boundingBox()
            assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height, JSON.stringify(box))
            await page.screenshot({ path: path.join(output, `workbench-${viewport.width}.png`), fullPage: true })
            if (viewport.width === 390) {
                await page.getByLabel('QA item 0000 생성 수량', { exact: true }).scrollIntoViewIfNeeded()
                await page.screenshot({ path: path.join(output, 'workbench-390-item.png'), fullPage: true })
            }
        })
    }
    report.finalSummary = await summary().innerText()
    await check('bulk quantity configuration survives reload', async () => {
        await page.evaluate(async () => (await import('/src/lib/scene-authority-runtime.ts')).flushSceneAuthorityRuntime())
        await page.reload()
        await page.getByLabel('QA item 0000 생성 수량', { exact: true }).waitFor()
        await page.waitForFunction(async () => (await import('/src/stores/scene-store.ts')).useSceneStore.getState().sceneAuthorityInitialized)
        assert.equal(await page.getByLabel('QA item 0000 생성 수량', { exact: true }).inputValue(), '3')
        assert.equal(await page.getByLabel('QA item 0001 생성 수량', { exact: true }).inputValue(), '1')
    })
    assert.deepEqual(report.pageErrors, [])
    report.passed = report.checks.every(result => result.passed)
    if (!report.passed) process.exitCode = 1
} catch (error) {
    report.passed = false
    report.failure = error.stack ?? String(error)
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    process.exitCode = 1
} finally {
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(output, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
    await browser.close()
}
