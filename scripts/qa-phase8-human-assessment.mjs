import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Browser-only QA: durable Queue/Artifact/assessment adapters are real; only native file bytes are substituted.
const baseUrl = process.env.PHASE8_QA_URL ?? 'http://127.0.0.1:9090'
const output = path.resolve('docs/local/evidence/phase-08')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ko-KR' })
const page = await context.newPage()
const report = { startedAt: new Date().toISOString(), environment: 'isolated Chromium + local Vite; no native/installed-app verification', baseUrl,
    fixture: 'single completed Queue job + registered PNG Artifact; native byte reader replaced only for fixture path',
    consoleErrors: [], pageErrors: [], blockedExternalRequests: [], checks: [] }
page.on('pageerror', error => report.pageErrors.push(error.message))
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()) })
await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(baseUrl).origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
    report.blockedExternalRequests.push(url.origin + url.pathname)
    // Fonts are intentionally offline in this isolated run; an empty local response avoids unrelated console noise.
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'text/css', body: '/* external fonts intentionally omitted in offline browser QA */' })
    return route.abort()
})
await context.addInitScript(() => localStorage.setItem('i18nextLng', 'ko'))
try {
    // Seed before app startup so no queued fixture can be claimed by the runtime coordinator.
    await page.route('**/__phase8_seed', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Isolated Phase 8 fixture seed</body></html>' }))
    await page.goto(`${baseUrl}/__phase8_seed`)
    const fixture = await page.evaluate(async () => {
        const { createAssessmentRequirement } = await import('/src/domain/assessment/visual-rubric.ts')
        const { getRuntimeQueueRepository } = await import('/src/services/queue/indexeddb-queue-repository.ts')
        const { getRuntimeArtifactRepository } = await import('/src/services/organizer/runtime.ts')
        const { createGenerationJobSnapshot } = await import('/src/services/queue/job-snapshot.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 64; canvas.height = 64
        const painter = canvas.getContext('2d')
        painter.fillStyle = '#126bce'; painter.fillRect(0, 0, 64, 64)
        const bytes = new Uint8Array(await (await fetch(canvas.toDataURL('image/png'))).arrayBuffer())
        const digest = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('')}`
        const now = new Date().toISOString()
        const runId = 'phase8-browser-qa-run'
        const jobId = 'phase8-browser-qa-job'
        const artifactId = 'phase8-browser-qa-artifact'
        const requirement = createAssessmentRequirement({ rubricId: 'phase8-browser-qa-rubric', version: 1,
            hardConstraints: [{ criterionId: 'blue-square', label: '파란 사각형이 보인다' }],
            softCriteria: [{ criterionId: 'composition', label: '구성의 명확성', weight: 1 }], acceptanceThreshold: 70 }, 1)
        const binding = { runId, planHash: `sha256:${'b'.repeat(64)}`, requirement }
        const queue = getRuntimeQueueRepository()
        const snapshot = { ...createGenerationJobSnapshot({ prompt: { positive: 'browser QA fixture', negative: '' },
            parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable' }), intentAssessment: binding }
        await queue.createBatchAndEnqueue({ batch: { id: runId, workflow: 'main', createdAt: now,
            failurePolicy: 'continue', origin: 'fresh', idempotencyKey: runId },
        jobs: [{ id: jobId, batchId: runId, workflow: 'main', sceneId: null, createdAt: now, priority: 0, ordinal: 0,
            snapshot, compositionPlanHash: null, maxAttempts: 1, idempotencyKey: jobId }] })
        const lease = await queue.acquireLease({ jobId, owner: 'qa-seed-only', now, ttlMs: 60000 })
        const leaseInput = { jobId, now, leaseOwner: 'qa-seed-only', leaseToken: lease.leaseToken }
        await queue.transitionJob({ ...leaseInput, to: 'running' })
        await getRuntimeArtifactRepository().putOriginal({ artifactId, sourceJobId: jobId,
            file: { directory: { kind: 'standard', root: 'pictures', segments: ['phase8-browser-qa'] }, fileName: 'fixture.png' },
            format: 'png', contentChecksum: digest, size: bytes.byteLength, createdAt: now })
        await queue.transitionJob({ ...leaseInput, to: 'succeeded', outputTransactionId: 'phase8-browser-qa-fixture-transaction', artifactReference: { kind: 'output-writer', artifactId, digest } })
        return { runId, artifactId, bytes: [...bytes], digest }
    })
    const attachFixtureReader = async () => {
        await page.getByTestId('queue-fulfillment-summary').waitFor()
        return page.evaluate(async bytes => {
        const { runtimePortableResourceByteReader } = await import('/src/platform/tauri-portable-resource-reader.ts')
        runtimePortableResourceByteReader.read = async materialized => {
            if (materialized.relativePath !== 'phase8-browser-qa/fixture.png') throw new Error('QA refused a non-fixture file read')
            return Uint8Array.from(bytes)
        }
        }, fixture.bytes)
    }
    const readRun = () => page.evaluate(async runId => {
        const { getRuntimeIntentAssessmentRun } = await import('/src/services/assessment/intent-assessment-runtime.ts')
        return getRuntimeIntentAssessmentRun(runId)
    }, fixture.runId)
    const openAssessment = async () => {
        const fulfillment = page.getByTestId('queue-fulfillment-summary')
        await fulfillment.locator('summary').first().click()
        await fulfillment.getByRole('button', { name: /요청 충족 판정|Request fulfillment assessment/ }).click()
        await page.getByTestId('human-assessment-dialog').waitFor()
        await page.waitForFunction(() => {
            const image = document.querySelector('[data-testid="human-assessment-dialog"] img')
            return image?.complete && image.naturalWidth === 64
        })
    }
    await page.goto(`${baseUrl}/queue`)
    await attachFixtureReader()
    await openAssessment()
    report.checks.push('Actual QueueCenter fulfillment button opens assessment and decodes verified 64x64 PNG')
    const dialog = page.getByRole('dialog')
    await dialog.locator('select').last().selectOption('fail')
    await dialog.locator('input[type="number"]').fill('100')
    await dialog.getByRole('button', { name: /평가 저장|Save assessment/, exact: true }).click()
    await page.waitForFunction(async runId => {
        const runtime = await import('/src/services/assessment/intent-assessment-runtime.ts')
        return (await runtime.getRuntimeIntentAssessmentRun(runId))?.events.length === 1
    }, fixture.runId)
    const rejected = await readRun()
    assert.equal(rejected.events[0].decision, 'rejected')
    assert.equal(rejected.projection.state, 'needs-review')
    assert.equal(rejected.projection.acceptedArtifactIds.length, 0)
    report.checks.push('Hard fail + soft score 100 persists rejected artifact; run stays needs-review without explicit close')
    await page.screenshot({ path: path.join(output, '01-hard-fail.png'), fullPage: true })

    await page.reload()
    await attachFixtureReader()
    await openAssessment()
    assert.deepEqual((await readRun()).projection, rejected.projection)
    assert.deepEqual((await readRun()).binding, rejected.binding)
    report.checks.push('Full browser document reload restores identical immutable binding and assessment projection from IndexedDB')
    await dialog.locator('select').last().selectOption('pass')
    await dialog.getByRole('button', { name: /평가 정정 저장|Save revised assessment/ }).click()
    await page.waitForFunction(async runId => {
        const runtime = await import('/src/services/assessment/intent-assessment-runtime.ts')
        return (await runtime.getRuntimeIntentAssessmentRun(runId))?.events.length === 2
    }, fixture.runId)
    const corrected = await readRun()
    assert.equal(corrected.events.length, 2)
    assert.deepEqual(corrected.events[0], rejected.events[0])
    assert.equal(corrected.events[1].supersedesAssessmentId, rejected.events[0].assessmentId)
    assert.deepEqual(corrected.projection.acceptedArtifactIds, [fixture.artifactId])
    assert.equal(corrected.projection.state, 'accepted')
    report.checks.push('Hard-pass correction appends a superseding event, retains prior rejection unchanged, counts artifact exactly once')
    await page.screenshot({ path: path.join(output, '02-corrected-accepted.png'), fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    // Allow responsive viewport/style recalculation and the app's transitions to settle before measuring.
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getBoundingClientRect().width <= innerWidth, null, { timeout: 5000 })
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))) })
    await page.screenshot({ path: path.join(output, '03-mobile-assessment.png'), fullPage: true, animations: 'disabled' })
    const dimensions = await dialog.evaluate(element => ({ viewport: innerWidth, width: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, documentWidth: document.documentElement.scrollWidth }))
    report.mobileDimensions = dimensions
    assert.ok(dimensions.width <= dimensions.viewport && dimensions.scrollWidth <= dimensions.clientWidth + 1 && dimensions.documentWidth <= dimensions.viewport, JSON.stringify(dimensions))
    report.checks.push('390px mobile assessment dialog and document have no horizontal overflow')
    await dialog.getByRole('button', { name: /실행.*거절|거절.*종료|Close run as rejected/ }).click()
    await page.waitForFunction(async runId => {
        const runtime = await import('/src/services/assessment/intent-assessment-runtime.ts')
        return (await runtime.getRuntimeIntentAssessmentRun(runId))?.projection.state === 'rejected'
    }, fixture.runId)
    const closed = await readRun()
    assert.equal(closed.events.length, 3)
    assert.equal(closed.events[2].type, 'run-decision')
    assert.equal(closed.events[2].decision, 'close-as-rejected')
    report.checks.push('Explicit close appends run-decision and is the only transition to rejected run')
    await page.screenshot({ path: path.join(output, '04-explicit-close.png'), fullPage: true })
    report.finalProjection = closed.projection
    report.eventHistory = closed.events

    // The setup gate gets its own component harness: it never calls actual generation or a Provider.
    await dialog.getByRole('button', { name: /^닫기$|^Close$/ }).first().click()
    await page.evaluate(async () => {
        // Reuse Vite's exact optimized module URLs, including version queries, to preserve React identity.
        const mainSource = await (await fetch('/src/main.tsx')).text()
        const reactUrl = mainSource.match(/from\s+"([^"]*\/react\.js[^"]*)"/)[1]
        const domUrl = mainSource.match(/from\s+"([^"]*\/react-dom_client\.js[^"]*)"/)[1]
        const { default: React } = await import(reactUrl)
        const { default: ReactDOM } = await import(domUrl)
        const { HumanAssessmentSetup } = await import('/src/components/assessment/HumanAssessmentSetup.tsx')
        const host = document.createElement('div')
        host.id = 'phase8-setup-harness'
        host.style.cssText = 'position:fixed;inset:0;z-index:100;background:#111827;color:white;overflow:auto;padding:16px'
        document.body.append(host)
        function Harness() {
            const [value, setValue] = React.useState(null)
            const [valid, setValid] = React.useState(true)
            return React.createElement(React.Fragment, null,
                React.createElement('h1', null, 'Phase 8 setup component harness'),
                React.createElement(HumanAssessmentSetup, { count: 2, value, onChange: setValue, onValidityChange: setValid }),
                React.createElement('button', { disabled: !valid, 'data-testid': 'qa-generation-gate' }, 'Generation gate (no operation)'),
                React.createElement('output', { 'data-testid': 'qa-requirement', style: { overflowWrap: 'anywhere' } }, JSON.stringify(value)))
        }
        ReactDOM.createRoot(host).render(React.createElement(Harness))
    })
    const setup = page.getByTestId('human-assessment-setup')
    const gate = page.getByTestId('qa-generation-gate')
    await setup.locator('input[type="checkbox"]').first().check()
    assert.equal(await gate.isDisabled(), true)
    assert.equal(await page.getByTestId('qa-requirement').innerText(), 'null')
    await setup.locator('textarea').fill('파란 사각형이 보인다')
    await page.waitForFunction(() => !document.querySelector('[data-testid="qa-generation-gate"]').disabled)
    assert.equal(JSON.parse(await page.getByTestId('qa-requirement').innerText()).rubric.softCriteria.length, 0)
    await setup.locator('input[type="number"]').first().fill('3')
    assert.equal(await gate.isDisabled(), true)
    await setup.locator('input[type="number"]').first().fill('2')
    await setup.locator('input[type="checkbox"]').nth(1).check()
    assert.equal(await gate.isDisabled(), true)
    await setup.locator('input:not([type])').fill('구성의 명확성')
    await setup.locator('input[type="number"]').nth(1).fill('0')
    assert.equal(await gate.isDisabled(), true)
    await setup.locator('input[type="number"]').nth(1).fill('1')
    await page.waitForFunction(() => !document.querySelector('[data-testid="qa-generation-gate"]').disabled)
    assert.equal(JSON.parse(await page.getByTestId('qa-requirement').innerText()).rubric.softCriteria.length, 1)
    report.checks.push('Setup component harness: enabled empty draft, over-count and zero weight disable generation gate and valid hard-only/weighted drafts enable it; no generation called')
    await page.screenshot({ path: path.join(output, '05-setup-validity-harness.png'), fullPage: true, animations: 'disabled' })
    assert.deepEqual(report.pageErrors, [], 'Browser page errors must be empty')
    assert.deepEqual(report.consoleErrors, [], 'Browser console errors must be empty')
    assert.ok(report.blockedExternalRequests.every(url => ['fonts.googleapis.com', 'cdn.jsdelivr.net'].includes(new URL(url).hostname)), 'No Provider or other external request may be attempted')
    report.status = 'passed'
} catch (error) {
    report.status = 'failed'
    report.failure = error.stack ?? String(error)
    report.bodyAtFailure = (await page.locator('body').innerText().catch(() => '')).slice(0, 12000)
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined)
    process.exitCode = 1
} finally {
    report.completedAt = new Date().toISOString()
    await writeFile(path.join(output, 'browser-qa-report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
    console.log(JSON.stringify(report, null, 2))
}
