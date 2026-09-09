import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright'

// Local Vite + fresh browser storage exercise actual UI; network access outside localhost is denied.
assert.match(process.versions.node, /^24\./)
const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const base = `http://127.0.0.1:${port}`
const output = path.resolve(process.env.PRODUCTION_REQUEST_QA_OUTPUT ?? 'artifacts/production-requests/ui')
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), node: process.version, base, checks: [], pageErrors: [], blockedRequests: [], limitations: [
    'Fresh browser IndexedDB fixtures; no installed Windows app or native output verification.',
    'Browser execution is unsupported: next-review action must remain visible but disabled. No generation, Provider, R2, native or model calls are authorized.',
    'Exercises 101 images from one persisted source, partitioned into 100 + 1. The 2400-image boundary is covered by separate domain tests.'
] }
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = '', browser, page
server.stdout.on('data', chunk => { serverLog += chunk })
server.stderr.on('data', chunk => { serverLog += chunk })
const check = async (name, action) => {
    try { await action(); report.checks.push({ name, passed: true }) }
    catch (error) { report.checks.push({ name, passed: false, error: String(error) }); throw error }
}
try {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await fetch(base).then(response => response.ok).catch(() => false)) break
        await new Promise(resolve => setTimeout(resolve, 100))
        if (attempt === 99) throw new Error('Vite did not start')
    }
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'ko-KR' })
    await context.addInitScript(() => localStorage.setItem('i18nextLng', 'ko'))
    await context.route('**/*', route => {
        const url = new URL(route.request().url())
        if (url.origin === base || ['blob:', 'data:'].includes(url.protocol)) return route.continue()
        report.blockedRequests.push(url.origin + url.pathname)
        return route.abort()
    })
    page = await context.newPage()
    page.setDefaultTimeout(12000)
    page.on('pageerror', error => report.pageErrors.push(error.message))
    const ready = async () => {
        await page.getByTestId('folder-workbench').waitFor()
        await page.waitForFunction(async () => (await import('/src/stores/scene-store.ts')).useSceneStore.getState().sceneAuthorityInitialized)
    }
    await page.goto(`${base}/folders`); await ready()
    const fixture = await page.evaluate(async () => {
        const { useSettingsStore } = await import('/src/stores/settings-store.ts')
        const { useSceneStore } = await import('/src/stores/scene-store.ts')
        const { createFolderAssetPreset } = await import('/src/presentation/folders/folder-workbench.ts')
        const { flushSceneAuthorityRuntime } = await import('/src/lib/scene-authority-runtime.ts')
        const id = await useSettingsStore.getState().addGenerationFolder({ name: 'Production QA' })
        useSceneStore.getState().importPreset(createFolderAssetPreset({ name: 'Production QA sources', folderId: id, rows: [{ name: 'Production source 101', prompt: 'QA only, never generate', count: 101 }] }))
        await flushSceneAuthorityRuntime()
        return { folderId: id }
    })
    await page.locator('.fb-sidebar').getByRole('button', { name: /^Production QA 이미지 1개$/ }).click()
    await check('Explicit 101-image selection switches to production save', async () => {
        await page.getByLabel('Production source 101 선택', { exact: true }).check()
        await page.getByRole('button', { name: '생산 요청으로 저장', exact: true }).waitFor()
        assert.equal(await page.getByRole('button', { name: '생산 요청으로 저장', exact: true }).isEnabled(), true)
        assert.match(await page.locator('.fb-workspace-header').innerText(), /101장/)
    })
    await check('Existing composer draft remains separate from saved production selection', async () => {
        await page.getByRole('button', { name: '이미지 추가', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '이미지 추가', exact: true })
        await dialog.locator('textarea').fill('Unsubmitted draft must survive production save')
        await dialog.getByText('이 폴더의 초안을 저장했어요.', { exact: false }).waitFor()
        await dialog.getByRole('button', { name: '닫기', exact: true }).click()
    })
    await check('Title and explicit aggregate budget required; 101 images split into two reviewed batches', async () => {
        await page.getByRole('button', { name: '생산 요청으로 저장', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '생산 요청으로 저장', exact: true })
        assert.equal(await dialog.getByRole('button', { name: '생산 요청으로 저장', exact: true }).isDisabled(), true)
        await dialog.getByLabel('요청 이름', { exact: true }).fill('QA saved production 101')
        await dialog.getByLabel('전체 Anlas 상한', { exact: true }).fill('500')
        await dialog.getByText('총 101장 · 최대 100장씩 2묶음', { exact: true }).waitFor()
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
            await page.waitForFunction(() => { const r = document.querySelector('[role=dialog]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth })
            assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true)
            await page.screenshot({ path: path.join(output, `save-dialog-${width}.png`), fullPage: true, animations: 'disabled' })
        }
        await dialog.getByRole('button', { name: '생산 요청으로 저장', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        await page.getByRole('heading', { name: 'QA saved production 101', exact: true }).waitFor()
        const next = page.getByRole('button', { name: '다음 묶음 검토', exact: true })
        await next.waitFor()
        assert.equal(await next.isDisabled(), true)
    })
    for (const width of [1440, 390]) await check(`${width}: saved request, selection and composer draft survive reload without overflow`, async () => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
        await page.reload(); await ready()
        assert.equal(await page.getByLabel('Production source 101 선택', { exact: true }).isChecked(), true)
        await page.getByText('저장한 생산 요청 (1)', { exact: true }).click()
        await page.getByRole('button', { name: '진행 상태 확인', exact: true }).click()
        await page.getByText('다음 묶음을 검토할 수 있어요.', { exact: true }).waitFor()
        await page.getByText('생성 0장 · 저장 0장 · 업로드 0 / 0장', { exact: true }).waitFor()
        const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }))
        assert.ok(geometry.width <= geometry.viewport, JSON.stringify(geometry))
        report[`geometry${width}`] = geometry
        await page.screenshot({ path: path.join(output, `restored-${width}.png`), fullPage: true, animations: 'disabled' })
        await page.getByRole('button', { name: '다음 묶음 검토', exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(output, `next-step-${width}.png`), fullPage: true, animations: 'disabled' })
        await page.getByRole('button', { name: '이미지 추가', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '이미지 추가', exact: true })
        assert.equal(await dialog.locator('textarea').inputValue(), 'Unsubmitted draft must survive production save')
        await dialog.getByRole('button', { name: '닫기', exact: true }).click()
    })
    await check('Persisted actual source hashes, materialized seeds and no Queue admission', async () => {
        report.persisted = await page.evaluate(async () => {
            const { listRuntimeProductionRequests } = await import('/src/composition-root/production-requests.ts')
            const { getRuntimeQueueRepository } = await import('/src/services/queue/indexeddb-queue-repository.ts')
            const requests = await listRuntimeProductionRequests()
            return { requests, batches: await getRuntimeQueueRepository().listBatches() }
        })
        assert.equal(report.persisted.requests.length, 1)
        const request = report.persisted.requests[0]
        assert.equal(request.title, 'QA saved production 101')
        assert.equal(request.budget.maxAnlas, 500)
        assert.equal(request.targets[0].count, 101)
        assert.match(request.targets[0].sourceHash, /^sha256:[a-f0-9]{64}$/)
        assert.equal(request.materializedSeeds.length, 101)
        assert.deepEqual(request.children.map(child => child.seeds.length), [100, 1])
        assert.equal(request.children.every(child => child.review === null && child.submission === null), true)
        assert.deepEqual(report.persisted.batches, [])
        assert.equal(fixture.folderId.length > 0, true)
    })
    assert.deepEqual(report.pageErrors, [])
    report.passed = true
} catch (error) {
    report.passed = false
    report.failure = error.stack ?? String(error)
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
    process.exitCode = 1
} finally {
    await browser?.close()
    server.kill()
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(output, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n')
    await writeFile(path.join(output, 'vite.log'), serverLog)
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure, output }, null, 2))
}
