import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Real browser UI, execution coordinator and IndexedDB; fixtures never reach native keys or a Provider.
const baseUrl = process.env.PHASE9C_QA_URL ?? 'http://127.0.0.1:9191'
const output = path.resolve(process.env.AGENT_EXECUTION_QA_OUTPUT ?? 'docs/local/evidence/phase-09c')
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), environment: 'isolated Chromium + loopback Vite',
    bounds: 'Actual AgentCommandPanel, AgentPolicyForm, ForegroundAgentCommandRuntime, AgentExecutionCoordinator, settings persistence/hydration and IndexedDB approval/receipt repositories. Native ownership/client/authentication, immutable plan lookup and Queue enqueue/reconcile and cancellation ports are fixtures. The expiry scenario advances only the coordinator clock. No Windows keyring, HMAC cryptography, native filesystem inbox, real Queue execution, Provider request, Anlas spending or production profile.',
    pageErrors: [], consoleErrors: [], blockedExternalRequests: [], checks: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ko-KR' })
const page = await context.newPage()
page.on('pageerror', error => report.pageErrors.push(error.message))
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()) })
await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(baseUrl).origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
    report.blockedExternalRequests.push(url.origin + url.pathname)
    if (['fonts.googleapis.com', 'cdn.jsdelivr.net'].includes(url.hostname)) return route.fulfill({ contentType: 'text/css', body: '/* offline QA */' })
    return route.abort()
})
await context.addInitScript(() => localStorage.setItem('i18nextLng', 'ko'))
try {
    await page.goto(`${baseUrl}/data`)
    await page.getByRole('tab', { name: 'AI 편집', exact: true }).click()
    await page.getByTestId('agent-command-panel').getByText('Windows 앱에서 사용 가능', { exact: true }).waitFor()
    await page.evaluate(async () => {
        const source = await (await fetch('/src/main.tsx')).text()
        const { default: React } = await import(source.match(/from\s+"([^"]*\/react\.js[^"]*)"/)[1])
        const { default: ReactDOM } = await import(source.match(/from\s+"([^"]*\/react-dom_client\.js[^"]*)"/)[1])
        const panelSource = await (await fetch('/src/presentation/agent/AgentCommandPanel.tsx')).text()
        // Use Vite's exact resolved URL so the fixture provider and production Link share one context.
        const { MemoryRouter } = await import(panelSource.match(/from\s+"([^"]*\/react-router\.js[^"]*)"/)[1])
        const { AgentCommandPanel } = await import('/src/presentation/agent/AgentCommandPanel.tsx')
        const { ForegroundAgentCommandRuntime } = await import('/src/composition-root/foreground-agent-command-runtime.ts')
        const { createAgentExecutionCoordinator } = await import('/src/application/agent/agent-execution-coordinator.ts')
        const { IndexedDbCommandReceiptRepository } = await import('/src/adapters/agent/indexeddb-command-receipt-repository.ts')
        const { IndexedDbAgentExecutionRepository } = await import('/src/adapters/agent/indexeddb-agent-execution-repository.ts')
        const { agentRequestHash } = await import('/src/application/agent/agent-command-contract.ts')
        const { useSettingsStore, isAgentExecutionPolicyUpdatePending } = await import('/src/stores/settings-store.ts')
        await useSettingsStore.persist.rehydrate()
        const digest = `sha256:${'a'.repeat(64)}`
        const plan = { schemaVersion: 1, planId: digest, planHash: digest, semanticPlanHash: digest,
            sourceBindings: [{ resourceType: 'workflow-draft', resourceId: 'qa-reviewed-source', revision: 1, contentHash: digest }],
            materializedSeedTrace: { source: 'fixed', traceId: null, seeds: [1] },
            jobs: [{ ordinal: 0, estimatedAnlas: 7, compatibility: { status: 'captured-pass', compatibilityProfileId: 'qa-captured' },
                destination: { collisionPolicy: 'fail' }, prepared: { fixtureOnly: true } }],
            estimatedAnlas: 7, issues: [], requiredApprovals: [], executionPolicy: { maxConcurrency: 1 }, budget: { maxImages: 1, maxAnlas: 10 } }
        let owner = null, timeOffset = 0, enqueueCount = 0, cancelCount = 0, runtime, mountRevision = 0
        const client = { clientId: 'qa-client-9c', keyId: 'qa-key-9c', label: '격리 QA 도우미', actorKind: 'agent', createdAt: new Date().toISOString(), revokedAt: null }
        const files = new Map(), published = new Map(), envelopes = new Map(), queueFacts = new Map()
        const cancelFacts = new Map()
        const cancelTarget = { runId: 'qa-cancel-batch', batchId: 'qa-cancel-batch',
            jobIds: ['qa-cancel-job-1', 'qa-cancel-job-2'], targetHash: digest, previouslyStoppedJobIds: [] }
        const native = {
            initialize: async () => ({ available: true, workspaceId: 'qa-workspace-9c', clients: [client] }),
            acquire: async () => { if (owner) return null; owner = 'qa-owner'; return owner }, release: async () => { owner = null },
            register: async () => client, rotate: async () => client, revoke: async () => undefined,
            list: async () => [...files.keys()].map(id => `${id}.ready.json`), read: async (_owner, id) => files.get(id),
            publish: async (_owner, id, value) => published.set(id, JSON.parse(value)), reject: async (_owner, id, value) => published.set(id, JSON.parse(value)),
            retire: async (_owner, id) => files.delete(id),
            authentication: () => ({ authenticate: async envelope => ({ clientId: envelope.context.clientId, actor: { kind: 'agent', id: `client:${envelope.context.clientId}` } }) }),
        }
        const receipts = new IndexedDbCommandReceiptRepository()
        const createRuntime = () => new ForegroundAgentCommandRuntime({ native, receipts, createHandlers: async () => [],
            policy: { get: () => useSettingsStore.getState().agentExecutionPolicy,
                set: (revision, next) => useSettingsStore.getState().setAgentExecutionPolicy(revision, next),
                subscribe: listener => useSettingsStore.subscribe(listener), isSaving: isAgentExecutionPolicyUpdatePending },
            createExecution: async (workspaceId, isClientAuthorized) => createAgentExecutionCoordinator({ workspaceId,
                receipts, repository: new IndexedDbAgentExecutionRepository(), plans: { get: async () => structuredClone(plan), putIfAbsent: async () => 'same' },
                getPolicy: () => useSettingsStore.getState().agentExecutionPolicy, isClientAuthorized,
                now: () => new Date(Date.now() + timeOffset).toISOString(),
                ports: { validate: async () => true, isOutstanding: async () => false,
                    enqueue: async (_plan, grant) => { enqueueCount++; const batchId = `main-batch-${grant.scopeId}`
                        const result = { status: 'ready', batchId, runId: batchId, jobIds: [`${batchId}:0`] }; queueFacts.set(grant.scopeId, result); return result },
                    reconcile: async grant => queueFacts.get(grant.scopeId) ?? null },
                cancellation: { inspect: async () => structuredClone(cancelTarget),
                    cancel: async (target, grant) => { cancelCount++; const result = { status: 'cancel-requested',
                        runId: target.runId, batchId: target.batchId, jobIds: [...target.jobIds] }
                        cancelFacts.set(grant.requestId, result); return result },
                    reconcile: async grant => cancelFacts.get(grant.requestId) ?? null } }),
        })
        document.getElementById('root').style.display = 'none'
        document.documentElement.style.cssText = 'height:auto;overflow:auto'
        document.body.style.cssText = 'height:auto;min-height:100vh;overflow:auto'
        const host = document.createElement('main'); host.id = 'phase9c-harness'; host.style.cssText = 'padding:16px;max-width:1000px;margin:auto'; document.body.append(host)
        const root = ReactDOM.createRoot(host)
        const reopen = async () => {
            await runtime?.stop(); await useSettingsStore.persist.rehydrate(); runtime = createRuntime()
            await runtime.start(Promise.resolve({ inboxReady: true }))
            root.render(React.createElement(MemoryRouter, { key: ++mountRevision }, React.createElement(AgentCommandPanel, { runtime })))
        }
        await reopen()
        window.phase9cQa = { reopen, stop: () => runtime.stop(), offset: value => { timeOffset = value },
            facts: async id => ({ receipt: await receipts.get(id), published: published.get(id), enqueueCount, cancelCount, files: files.size,
                policy: useSettingsStore.getState().agentExecutionPolicy, pending: runtime.getSnapshot().pendingApprovals }),
            submit: async (id, replay = false, cancel = false) => {
                const envelope = replay ? envelopes.get(id) : { schemaVersion: 1, requestId: id, requestHash: digest,
                    submittedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
                    context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'qa-workspace-9c', clientId: client.clientId, actor: { kind: 'agent' }, idempotencyKey: id },
                    command: cancel ? { name: 'generation.cancel', input: { runId: cancelTarget.runId } }
                        : { name: 'generation.enqueue', input: { planId: digest, planHash: digest } },
                    authentication: { scheme: 'hmac-sha256', keyId: client.keyId, signature: `hmac-sha256:${'0'.repeat(64)}` } }
                envelope.requestHash = agentRequestHash(envelope); envelopes.set(id, envelope); files.set(id, JSON.stringify(envelope)); await runtime.poll()
                return window.phase9cQa.facts(id)
            } }
    })
    const panel = page.locator('#phase9c-harness').getByTestId('agent-command-panel')
    const row = id => panel.locator('li').filter({ has: page.getByText(`요청: ${id}`, { exact: true }) })
    const submit = id => page.evaluate(id => window.phase9cQa.submit(id), id)
    const facts = id => page.evaluate(id => window.phase9cQa.facts(id), id)
    const save = async () => { await panel.getByRole('button', { name: '실행 정책 저장', exact: true }).click(); await panel.getByText('실행 정책을 저장했습니다.', { exact: true }).waitFor() }
    const first = await submit('qa-approve')
    assert.equal(first.enqueueCount, 0); assert.equal(first.receipt.state, 'needs-input'); assert.equal(first.files, 0)
    await row('qa-approve').getByText('검토한 원본: qa-reviewed-source', { exact: true }).waitFor()
    report.checks.push('Suggest enqueue is durably pending after ready-file retirement; zero Queue-port calls and reviewed source/cost/output are visible')
    await page.screenshot({ path: path.join(output, '01-suggest-review.png'), fullPage: true })
    await panel.getByRole('spinbutton', { name: '실행당 Anlas', exact: true }).fill('21'); await save()
    assert.equal((await facts('qa-approve')).policy.revision, 1)
    assert.equal((await facts('qa-approve')).pending[0].policyRevision, 1)
    await row('qa-approve').getByRole('button', { name: '이번 요청 승인', exact: true }).click()
    await panel.getByRole('link', { name: /등록된 배치 열기/ }).waitFor()
    const approved = await facts('qa-approve')
    assert.equal(approved.enqueueCount, 1); assert.equal(approved.receipt.state, 'completed'); assert.deepEqual(approved.receipt, approved.published)
    assert.equal(await panel.getByRole('link', { name: /등록된 배치 열기/ }).getAttribute('href'), '/queue')
    report.checks.push('Actual policy form save increments and durably stores revision; fresh single-use approval enqueues exactly once and publishes exact persisted receipt with existing batch link')
    const replay = await page.evaluate(() => window.phase9cQa.submit('qa-approve', true))
    assert.equal(replay.enqueueCount, 1); assert.deepEqual(replay.receipt, approved.receipt)
    report.checks.push('Exact envelope replay preserves the completed receipt and makes no second Queue-port call')
    await submit('qa-reject'); await row('qa-reject').getByRole('button', { name: '거절', exact: true }).click()
    await row('qa-reject').waitFor({ state: 'detached' }); assert.equal((await facts('qa-reject')).receipt.state, 'rejected')
    assert.equal((await facts('qa-reject')).enqueueCount, 1)
    report.checks.push('Human reject finalizes durable rejected receipt without enqueue')
    await submit('qa-reopen'); await page.evaluate(() => window.phase9cQa.reopen())
    await row('qa-reopen').getByRole('button', { name: '이번 요청 승인', exact: true }).waitFor()
    const reopened = await facts('qa-reopen'); assert.equal(reopened.policy.revision, 1); assert.equal(reopened.files, 0); assert.equal(reopened.enqueueCount, 1)
    report.checks.push('New foreground/coordinator instance and settings rehydration restore retired pending approval and policy revision from actual IndexedDB')
    await row('qa-reopen').getByRole('button', { name: '거절', exact: true }).click(); await row('qa-reopen').waitFor({ state: 'detached' })
    await panel.getByRole('combobox', { name: '실행 모드', exact: true }).selectOption('bounded-auto')
    const expiry = new Date(Date.now() + 600_000)
    const localExpiry = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    await panel.locator('input[type="datetime-local"]').fill(localExpiry); await save()
    const automatic = await submit('qa-auto'); assert.equal(automatic.enqueueCount, 2); assert.equal(automatic.receipt.state, 'completed')
    report.checks.push('Explicit mode selection plus future expiry saved through the human form permits an in-budget fixture enqueue')
    await panel.getByRole('checkbox', { name: '실행 일시 중지', exact: true }).check(); await save()
    const paused = await submit('qa-paused'); assert.equal(paused.enqueueCount, 2); assert.equal(paused.receipt.state, 'needs-input')
    assert.equal(await row('qa-paused').getByRole('button', { name: '이번 요청 승인', exact: true }).isDisabled(), true)
    report.checks.push('Saved global pause produces pending review and disables approval without enqueue')
    await panel.getByRole('checkbox', { name: '실행 일시 중지', exact: true }).uncheck(); await save()
    await page.evaluate(() => window.phase9cQa.offset(900_000))
    const expired = await submit('qa-expired-auto'); assert.equal(expired.enqueueCount, 2); assert.equal(expired.receipt.state, 'needs-input')
    report.checks.push('Advancing only the coordinator clock beyond the persisted auto expiry downgrades new enqueue to pending without a timer or additional Queue call')
    await page.screenshot({ path: path.join(output, '02-policy-and-pending.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(output, '03-mobile-policy-and-pending.png'), fullPage: true, animations: 'disabled' })
    report.mobileDimensions = await panel.evaluate(element => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    assert.ok(report.mobileDimensions.documentWidth <= 390 && report.mobileDimensions.scrollWidth <= report.mobileDimensions.clientWidth + 1, JSON.stringify(report.mobileDimensions))
    report.checks.push('390px panel and document have no horizontal overflow')
    await page.evaluate(() => window.phase9cQa.offset(0))
    await panel.getByRole('checkbox', { name: '실행 일시 중지', exact: true }).check(); await save()
    const cancellation = await page.evaluate(() => window.phase9cQa.submit('qa-cancel', false, true))
    assert.equal(cancellation.receipt.state, 'needs-input'); assert.equal(cancellation.cancelCount, 0)
    await row('qa-cancel').getByText('배치 전체 중단 요청', { exact: true }).waitFor()
    await row('qa-cancel').getByText('중단할 배치: qa-cancel-batch', { exact: true }).waitFor()
    assert.equal(await row('qa-cancel').getByRole('button', { name: '이번 요청 승인', exact: true }).isDisabled(), false)
    assert.equal(await row('qa-paused').getByRole('button', { name: '이번 요청 승인', exact: true }).isDisabled(), true)
    assert.equal(await row('qa-cancel').getByText(/예상 .* Anlas/).count(), 0)
    report.checks.push('Cancellation in bounded-auto still requires human approval, shows exact run/jobs without generation cost, and remains approvable during global pause while enqueue stays blocked')
    await page.screenshot({ path: path.join(output, '04-cancel-review-mobile.png'), fullPage: true, animations: 'disabled' })
    const cancelDimensions = await panel.evaluate(element => ({ documentWidth: document.documentElement.scrollWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    assert.ok(cancelDimensions.documentWidth <= 390 && cancelDimensions.scrollWidth <= cancelDimensions.clientWidth + 1)
    await page.evaluate(() => window.phase9cQa.reopen())
    await row('qa-cancel').getByRole('button', { name: '이번 요청 승인', exact: true }).waitFor()
    const restoredCancel = await facts('qa-cancel')
    assert.equal(restoredCancel.cancelCount, 0); assert.equal(restoredCancel.files, 0)
    await row('qa-cancel').getByRole('button', { name: '이번 요청 승인', exact: true }).click()
    await panel.getByText('중단 요청 기록됨', { exact: true }).waitFor()
    await panel.getByRole('link', { name: '대상 배치 열기: qa-cancel-batch', exact: true }).waitFor()
    const cancelled = await facts('qa-cancel')
    assert.equal(cancelled.cancelCount, 1); assert.equal(cancelled.enqueueCount, 2)
    assert.equal(cancelled.receipt.result.status, 'cancel-requested'); assert.deepEqual(cancelled.receipt, cancelled.published)
    report.checks.push('Retired cancellation review survives runtime/settings rehydration and human approval publishes the durable cancel-requested acknowledgement once with a target batch link')
    const cancelReplay = await page.evaluate(() => window.phase9cQa.submit('qa-cancel', true))
    assert.equal(cancelReplay.cancelCount, 1); assert.deepEqual(cancelReplay.receipt, cancelled.receipt)
    await page.evaluate(() => window.phase9cQa.submit('qa-cancel-reject', false, true))
    await row('qa-cancel-reject').getByRole('button', { name: '거절', exact: true }).click()
    await row('qa-cancel-reject').waitFor({ state: 'detached' })
    const cancelRejected = await facts('qa-cancel-reject')
    assert.equal(cancelRejected.cancelCount, 1); assert.equal(cancelRejected.receipt.state, 'rejected')
    report.checks.push('Exact cancel replay and a separately rejected cancellation add no cancellation or enqueue calls')
    report.cancelFacts = cancelled
    await page.screenshot({ path: path.join(output, '05-cancel-acknowledged.png'), fullPage: true, animations: 'disabled' })
    report.finalFacts = await facts('qa-expired-auto')
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, [])
    assert.ok(report.blockedExternalRequests.every(url => ['fonts.googleapis.com', 'cdn.jsdelivr.net'].includes(new URL(url).hostname)))
    report.status = 'passed'
} catch (error) {
    report.status = 'failed'; report.failure = error.stack ?? String(error)
    report.bodyAtFailure = (await page.locator('body').innerText().catch(() => '')).slice(0, 16000)
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined)
    process.exitCode = 1
} finally {
    await page.evaluate(() => window.phase9cQa?.stop()).catch(() => undefined)
    report.completedAt = new Date().toISOString()
    await writeFile(path.join(output, 'browser-qa-report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
    console.log(JSON.stringify(report, null, 2))
}
