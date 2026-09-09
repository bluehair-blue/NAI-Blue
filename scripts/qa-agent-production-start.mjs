import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright'

// Fresh localhost server and isolated browser storage; all external requests are blocked.
assert.match(process.versions.node, /^24\./, 'Run this QA script with the supported Node 24 runtime')
const node24 = process.execPath
const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const base = `http://127.0.0.1:${port}`
const monitorOnly = process.env.QA_ONLY === 'monitor'
const output = path.resolve('artifacts/agent-production-start', monitorOnly ? 'monitor-only' : '')
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), base, node: process.version, monitorOnly, checks: [], pageErrors: [], consoleWarnings: [], blockedRequests: [], limitations: [
    'Isolated browser fixtures only; no installed Windows app, real generation, file bytes or remote upload verification.',
    'R2 refresh uses a legacy-v1 durable upload + manifest fixture, not the Phase 7 remote verification protocol.',
] }
const server = spawn(node24, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', data => { serverLog += data })
server.stderr.on('data', data => { serverLog += data })
let browser, page
const check = async (name, action) => {
    const started = performance.now()
    try { await action(); report.checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - started) }) }
    catch (error) { report.checks.push({ name, passed: false, failure: error.stack ?? String(error) }); throw error }
}
try {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await fetch(base).then(response => response.ok).catch(() => false)) break
        await new Promise(resolve => setTimeout(resolve, 100))
        if (attempt === 99) throw new Error('Vite did not start')
    }
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] })
    await context.addInitScript(() => localStorage.setItem('i18nextLng', 'ko'))
    await context.route('**/*', route => {
        const url = new URL(route.request().url())
        if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
        report.blockedRequests.push(url.origin + url.pathname)
        return route.abort()
    })
    page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => report.pageErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') report.consoleWarnings.push(message.text()) })
    await page.route('**/__production_seed', route => route.fulfill({ contentType: 'text/html', body: '<body>Isolated seed</body>' }))
    await page.goto(`${base}/__production_seed`)
    const monitorFixture = await page.evaluate(async () => {
        const { getRuntimeQueueRepository } = await import('/src/services/queue/indexeddb-queue-repository.ts')
        const { getRuntimeArtifactRepository } = await import('/src/services/organizer/runtime.ts')
        const { createGenerationJobSnapshot } = await import('/src/services/queue/job-snapshot.ts')
        const { getRuntimeR2UploadRepository } = await import('/src/services/r2/runtime.ts')
        const queue = getRuntimeQueueRepository(), r2 = getRuntimeR2UploadRepository()
        const now = new Date().toISOString(), runId = 'qa-production-run', jobId = 'qa-production-job'
        const digest = `sha256:${'b'.repeat(64)}`, artifactId = 'qa-production-artifact'
        const profile = { schemaVersion: 2, id: 'qa-profile', name: 'QA fixture only', accountId: 'fixture', jurisdiction: null,
            endpoint: null, bucket: 'fixture-bucket', prefix: '', credentialRef: 'fixture-no-credential', transport: 'native-s3',
            conflictPolicy: 'fail', publicMode: 'r2-dev', publicBaseUrl: null, createdAt: now, updatedAt: now }
        await r2.putProfile(profile, null)
        const snapshot = createGenerationJobSnapshot({ prompt: { positive: 'fixture only', negative: '' }, parameters: {
            mainWorkflow: { metadataMode: 'strip-and-sidecar', output: { autoR2UploadProfileId: profile.id } },
        }, outputPolicy: {}, resources: [], resumability: 'resumable' })
        await queue.createBatchAndEnqueue({ batch: { id: runId, workflow: 'main', createdAt: now, failurePolicy: 'continue', origin: 'fresh', idempotencyKey: runId },
            jobs: [{ id: jobId, batchId: runId, workflow: 'main', sceneId: null, createdAt: now, priority: 0, ordinal: 0, snapshot, compositionPlanHash: null, maxAttempts: 1, idempotencyKey: jobId }] })
        const lease = await queue.acquireLease({ jobId, owner: 'qa-seed-only', now, ttlMs: 60000 })
        const leaseInput = { jobId, now, leaseOwner: 'qa-seed-only', leaseToken: lease.leaseToken }
        await queue.transitionJob({ ...leaseInput, to: 'running' })
        await getRuntimeArtifactRepository().putOriginal({ artifactId, sourceJobId: jobId,
            file: { directory: { kind: 'standard', root: 'pictures', segments: ['qa-production'] }, fileName: 'fixture.png' },
            format: 'png', contentChecksum: digest, size: 64, createdAt: now })
        await queue.transitionJob({ ...leaseInput, to: 'succeeded', outputTransactionId: 'qa-fixture-transaction', artifactReference: { kind: 'output-writer', artifactId, digest } })
        // The legacy reader links these historical jobs by source job identity.
        const upload = { id: 'qa-upload', contractVersion: 'legacy-v1', profileId: profile.id, profileSnapshot: null,
            artifactBinding: null, linkExpectedArtifactVersion: null, remoteRef: null, artifactId: jobId + ':release-image', localVariant: 'original',
            remoteKey: 'fixture.png', contentSha256: digest, contentType: 'image/png', size: 64, state: 'queued', attempt: 0,
            maxAttempts: 1, nextAttemptAt: now, multipart: { uploadId: null, completedParts: [] }, diagnosticEventId: null,
            createdAt: now, updatedAt: now, version: 1 }
        await r2.enqueue([upload])
        return { runId, profile, upload }
    })
    const ready = async () => {
        await page.getByTestId('folder-workbench').waitFor()
        await page.waitForFunction(async () => (await import('/src/stores/scene-store.ts')).useSceneStore.getState().sceneAuthorityInitialized)
    }
    await page.goto(`${base}/folders`)
    await ready()
    const fixtures = await page.evaluate(async () => {
        const { useSettingsStore } = await import('/src/stores/settings-store.ts')
        const { useSceneStore } = await import('/src/stores/scene-store.ts')
        const { createFolderAssetPreset } = await import('/src/presentation/folders/folder-workbench.ts')
        const { flushSceneAuthorityRuntime } = await import('/src/lib/scene-authority-runtime.ts')
        const a = await useSettingsStore.getState().addGenerationFolder({ name: 'Draft A' })
        const b = await useSettingsStore.getState().addGenerationFolder({ name: 'Draft B' })
        const large = await useSettingsStore.getState().addGenerationFolder({ name: 'Restore 2400' })
        for (const folderId of [a, b, large]) {
            useSceneStore.getState().importPreset(createFolderAssetPreset({ name: 'QA seed', folderId, rows: Array.from({ length: folderId === large ? 2400 : 1 }, (_, index) => ({ name: `QA item ${String(index).padStart(4, '0')}`, prompt: `recover ${index}`, count: 1 })) }))
        }
        await flushSceneAuthorityRuntime()
        return { a, b, large }
    })
    const selectFolder = async name => {
        const mobile = page.viewportSize().width < 1024
        if (mobile) await page.getByRole('button', { name: '폴더', exact: true }).click()
        const scope = mobile ? page.getByRole('dialog', { name: '폴더', exact: true }) : page.locator('.fb-sidebar')
        await scope.getByRole('button', { name: new RegExp(`^${name} 이미지 \\d+개$`) }).click()
        if (mobile) await scope.waitFor({ state: 'hidden' })
    }
    const openComposer = async () => {
        await page.getByRole('button', { name: '이미지 추가', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '이미지 추가', exact: true })
        await dialog.waitFor()
        return dialog
    }
    const closeComposer = async () => {
        const dialog = page.getByRole('dialog', { name: '이미지 추가', exact: true })
        await dialog.getByRole('button', { name: '닫기', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
    }
    const navigateAwayAndBack = async () => {
        const nav = page.getByRole('navigation', { name: '작업대 탐색', exact: true })
        await nav.getByRole('link', { name: '작업 기록', exact: true }).click()
        await page.waitForURL('**/queue')
        await nav.getByRole('link', { name: '이미지 만들기', exact: true }).click()
        await ready()
    }
    if (!monitorOnly) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport)
        const width = viewport.width
        await check(`${width}: form/table draft survives close, route navigation and reload; scope isolation`, async () => {
            await selectFolder('Draft A')
            let dialog = await openComposer()
            await dialog.locator('textarea').fill(`form draft ${width}`)
            await dialog.getByRole('button', { name: '여러 개 붙여넣기', exact: true }).click()
            await dialog.locator('textarea').fill(`table_${width}\ttable draft ${width}\t2`)
            await dialog.getByText('이 폴더의 초안을 저장했어요.', { exact: false }).waitFor()
            await closeComposer()
            dialog = await openComposer()
            assert.equal(await dialog.locator('textarea').inputValue(), `table_${width}\ttable draft ${width}\t2`)
            await closeComposer()
            await navigateAwayAndBack()
            dialog = await openComposer()
            assert.equal(await dialog.locator('textarea').inputValue(), `table_${width}\ttable draft ${width}\t2`)
            await closeComposer()
            await page.reload(); await ready()
            dialog = await openComposer()
            assert.equal(await dialog.locator('textarea').inputValue(), `table_${width}\ttable draft ${width}\t2`)
            await dialog.getByRole('button', { name: '그림 설명 직접 쓰기로 돌아가기', exact: true }).click()
            assert.equal(await dialog.locator('textarea').inputValue(), `form draft ${width}`)
            await page.screenshot({ path: path.join(output, `draft-restored-${width}.png`), fullPage: true })
            await closeComposer()
            await selectFolder('Draft B')
            dialog = await openComposer()
            assert.equal(await dialog.locator('textarea').inputValue(), '')
            await dialog.locator('textarea').fill(`folder B ${width}`)
            await closeComposer()
            await selectFolder('Draft A')
            dialog = await openComposer()
            assert.equal(await dialog.locator('textarea').inputValue(), `form draft ${width}`)
        })
        await check(`${width}: verified import consumes submitted form only; explicit discard persists`, async () => {
            const dialog = page.getByRole('dialog', { name: '이미지 추가', exact: true })
            await dialog.getByRole('button', { name: '만들 이미지 추가', exact: true }).click()
            await dialog.waitFor({ state: 'hidden' })
            await page.waitForFunction(async folderId => {
                const { loadFolderDraft } = await import('/src/presentation/folders/folder-workbench-draft.ts')
                return loadFolderDraft(folderId).draft?.rows[0].prompt === ''
            }, fixtures.a)
            const reopened = await openComposer()
            assert.equal(await reopened.locator('textarea').inputValue(), '')
            await reopened.getByRole('button', { name: '여러 개 붙여넣기', exact: true }).click()
            assert.equal(await reopened.locator('textarea').inputValue(), `table_${width}\ttable draft ${width}\t2`)
            await reopened.getByRole('button', { name: '초안 버리기', exact: true }).click()
            assert.equal(await reopened.locator('textarea').inputValue(), '')
            await closeComposer(); await page.reload(); await ready()
            const cleared = await openComposer()
            assert.equal(await cleared.locator('textarea').inputValue(), '')
            await closeComposer()
            await selectFolder('Draft B')
            const other = await openComposer()
            assert.equal(await other.locator('textarea').inputValue(), `folder B ${width}`)
            await other.getByRole('button', { name: '초안 버리기', exact: true }).click()
            await closeComposer()
        })
        await check(`${width}: 2400-item query/selection/filter/view/page/scroll restore after reload`, async () => {
            await selectFolder('Restore 2400')
            await page.getByLabel('이미지 찾기', { exact: true }).fill('recover')
            await page.locator('.fb-filter-tab').filter({ hasText: '만들기 전' }).click()
            await page.getByRole('button', { name: '목록 보기', exact: true }).click()
            await page.getByRole('button', { name: '다음', exact: true }).click()
            const selectedRow = page.locator('[data-scene-id] input[type="checkbox"]').first()
            await selectedRow.check()
            const selectedLabel = await selectedRow.getAttribute('aria-label')
            await page.locator('.fb-content-scroll').evaluate(element => { element.scrollTop = 750 })
            await page.waitForFunction(() => JSON.parse(localStorage.getItem('nai-blue-folder-workbench-view-v1')).views[JSON.parse(localStorage.getItem('nai-blue-folder-workbench-view-v1')).folderId].scrollTop >= 749)
            const before = await page.evaluate(() => JSON.parse(localStorage.getItem('nai-blue-folder-workbench-view-v1')))
            await page.reload(); await ready()
            await page.getByLabel(selectedLabel, { exact: true }).waitFor()
            assert.equal(await page.getByLabel('이미지 찾기', { exact: true }).inputValue(), 'recover')
            assert.equal(await page.getByLabel(selectedLabel, { exact: true }).isChecked(), true)
            assert.equal(await page.getByRole('button', { name: '목록 보기', exact: true }).getAttribute('aria-pressed'), 'true')
            assert.equal(await page.locator('.fb-filter-tab').filter({ hasText: '만들기 전' }).getAttribute('aria-pressed'), 'true')
            assert.match(await page.locator('.fb-pagination').innerText(), /2\s*\/\s*40/)
            await page.waitForFunction(() => document.querySelector('.fb-content-scroll').scrollTop >= 749)
            const after = await page.evaluate(() => JSON.parse(localStorage.getItem('nai-blue-folder-workbench-view-v1')))
            assert.deepEqual(after, before)
            const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }))
            assert.ok(geometry.width <= geometry.viewport, JSON.stringify(geometry))
            report[`restored${width}`] = { selectedLabel, scrollTop: after.views[fixtures.large].scrollTop, page: after.views[fixtures.large].page, ...geometry }
            await page.screenshot({ path: path.join(output, `view-restored-${width}.png`), fullPage: true })
            // Reset presentation state for the next viewport's independent page-two assertion.
            await page.getByRole('button', { name: '이전', exact: true }).click()
            await page.getByRole('button', { name: '선택 해제', exact: true }).click()
        })
    }
    await check('actual QueueCenter shows generation/storage/upload separately and copies shared status', async () => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`${base}/queue`)
        const monitor = page.getByTestId('generation-run-monitor')
        await monitor.waitFor()
        await monitor.getByText('앱이 생성과 저장을 진행합니다.', { exact: false }).waitFor()
        assert.deepEqual(await monitor.locator('dd').allTextContents(), ['1 / 1', '1 / 1', '0 / 1'])
        await monitor.getByRole('button', { name: '작업 상태 복사', exact: true }).click()
        await monitor.getByRole('button', { name: '상태를 복사했어요', exact: true }).waitFor()
        const copied = await page.evaluate(async () => JSON.parse(await navigator.clipboard.readText()))
        assert.equal(copied.runId, monitorFixture.runId)
        assert.equal(copied.monitor.complete, false)
        report.copiedPending = copied
        await page.screenshot({ path: path.join(output, 'queue-upload-pending-390.png'), fullPage: true })
        await monitor.screenshot({ path: path.join(output, 'monitor-pending-390.png') })
    })
    await check('R2-only manifest completion refreshes actual QueueCenter without reload or Queue revision change', async () => {
        const before = await page.evaluate(async ({ runId, profile, upload }) => {
            const { getRuntimeQueueRepository } = await import('/src/services/queue/indexeddb-queue-repository.ts')
            const { getRuntimeR2UploadRepository } = await import('/src/services/r2/runtime.ts')
            const revision = (await getRuntimeQueueRepository().getBatchProjectionMeta(runId)).revision
            const r2 = getRuntimeR2UploadRepository()
            const running = await r2.updateJob(upload.id, 1, { state: 'running', attempt: 1 })
            await r2.succeedJobWithManifest(profile, upload.id, running.version, { profileId: profile.id, artifactId: upload.artifactId,
                localVariant: upload.localVariant, remoteKey: upload.remoteKey, contentSha256: upload.contentSha256, size: upload.size, completedAt: new Date().toISOString() })
            return revision
        }, monitorFixture)
        const monitor = page.getByTestId('generation-run-monitor')
        await monitor.getByText('요청한 생성·저장·업로드가 끝났습니다.', { exact: false }).waitFor()
        report.monitorDom = await monitor.evaluateAll(elements => elements.map(element => element.outerHTML))
        report.monitorSectionCount = await monitor.count()
        assert.equal(report.monitorSectionCount, 1, 'Polling must replace the existing summary, not append stale summaries')
        assert.deepEqual(await monitor.locator('dd').allTextContents(), ['1 / 1', '1 / 1', '1 / 1'])
        const after = await page.evaluate(async runId => (await (await import('/src/services/queue/indexeddb-queue-repository.ts')).getRuntimeQueueRepository().getBatchProjectionMeta(runId)).revision, monitorFixture.runId)
        assert.equal(after, before)
        report.queueRevisionUnchanged = { before, after }
        await monitor.getByRole('button', { name: '상태를 복사했어요', exact: true }).click()
        const copied = await page.evaluate(async () => JSON.parse(await navigator.clipboard.readText()))
        assert.equal(copied.monitor.complete, true)
        assert.notEqual(copied.monitor.stateHash, report.copiedPending.monitor.stateHash)
        report.copiedComplete = copied
        // Observe two further five-second fulfillment refreshes to detect stale sibling accumulation.
        await page.waitForTimeout(10_500)
        assert.equal(await monitor.count(), 1)
        assert.deepEqual(await monitor.locator('dd').allTextContents(), ['1 / 1', '1 / 1', '1 / 1'])
        report.additionalPollObservationMs = 10_500
        await page.screenshot({ path: path.join(output, 'queue-upload-complete-390.png'), fullPage: true })
        await monitor.screenshot({ path: path.join(output, 'monitor-complete-390.png') })
        await page.setViewportSize({ width: 1440, height: 960 })
        await page.screenshot({ path: path.join(output, 'queue-upload-complete-1440.png'), fullPage: true })
    })
    assert.deepEqual(report.pageErrors, [])
    assert.deepEqual(report.consoleWarnings.filter(message => message.includes('Encountered two children with the same key')), [])
    report.passed = true
} catch (error) {
    report.passed = false
    report.failure = error.stack ?? String(error)
    if (page) report.failureMonitorDom = await page.getByTestId('generation-run-monitor').evaluateAll(elements => elements.map(element => element.outerHTML)).catch(() => [])
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    process.exitCode = 1
} finally {
    await browser?.close()
    server.kill()
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(output, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n')
    await writeFile(path.join(output, 'vite.log'), serverLog)
    console.log(JSON.stringify(report, null, 2))
}
