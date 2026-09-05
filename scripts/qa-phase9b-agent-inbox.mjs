import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Isolated browser QA exercises actual UI/runtime/IndexedDB; native ownership and authentication are test doubles.
const baseUrl = process.env.PHASE9B_QA_URL ?? 'http://127.0.0.1:9090'
const output = path.resolve('docs/local/evidence/phase-09b')
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), environment: 'isolated Chromium + Vite',
    bounds: 'Real Data Hub browser unsupported state, actual AgentCommandPanel and ForegroundAgentCommandRuntime, real IndexedDB receipt. Native port/authentication and read/plan handlers are test doubles. No real keyring, ACL, installed app, Provider or generation execution.',
    pageErrors: [], consoleErrors: [], blockedExternalRequests: [], checks: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] })
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
    const appPanel = page.getByTestId('agent-command-panel')
    await appPanel.waitFor()
    assert.match(await appPanel.innerText(), /Windows 앱에서 사용 가능/)
    assert.equal(await appPanel.getByRole('button', { name: '조회·계획 권한 등록', exact: true }).isDisabled(), true)
    report.checks.push('Actual /data AI tab mounts command panel with browser unsupported state and disabled registration')
    await page.screenshot({ path: path.join(output, '01-data-hub-browser-unsupported.png'), fullPage: true })

    await page.evaluate(async () => {
        const source = await (await fetch('/src/main.tsx')).text()
        const { default: React } = await import(source.match(/from\s+"([^"]*\/react\.js[^"]*)"/)[1])
        const { default: ReactDOM } = await import(source.match(/from\s+"([^"]*\/react-dom_client\.js[^"]*)"/)[1])
        const { AgentCommandPanel } = await import('/src/presentation/agent/AgentCommandPanel.tsx')
        const { ForegroundAgentCommandRuntime } = await import('/src/composition-root/foreground-agent-command-runtime.ts')
        const { IndexedDbCommandReceiptRepository } = await import('/src/adapters/agent/indexeddb-command-receipt-repository.ts')
        const { agentRequestHash } = await import('/src/application/agent/agent-command-contract.ts')
        let clients = [], owner = null, keyRevision = 1
        const files = new Map(), results = new Map(), calls = []
        const native = {
            initialize: async () => ({ available: true, workspaceId: 'qa-workspace-9b', clients }),
            acquire: async () => { if (owner) return null; owner = 'qa-owner'; return owner },
            release: async () => { owner = null },
            register: async (label, actorKind) => { const client = { clientId: 'qa-client', keyId: 'qa-key-1', label, actorKind, createdAt: new Date().toISOString(), revokedAt: null }; clients = [...clients, client]; calls.push('register'); return client },
            rotate: async id => { clients = clients.map(client => client.clientId === id ? { ...client, keyId: `qa-key-${++keyRevision}` } : client); calls.push('rotate'); return clients[0] },
            revoke: async id => { clients = clients.map(client => client.clientId === id ? { ...client, revokedAt: new Date().toISOString() } : client); calls.push('revoke'); return clients[0] },
            list: async () => [...files.keys()].map(id => `${id}.ready.json`),
            read: async (_owner, id) => files.get(id),
            publish: async (_owner, id, text) => results.set(id, JSON.parse(text)),
            reject: async (_owner, id, text) => results.set(id, JSON.parse(text)),
            retire: async (_owner, id) => files.delete(id),
            authentication: () => ({ authenticate: async envelope => ({ clientId: envelope.context.clientId, actor: { kind: 'agent', id: `client:${envelope.context.clientId}` } }) }),
        }
        const receipts = new IndexedDbCommandReceiptRepository()
        const runtime = new ForegroundAgentCommandRuntime({ native, receipts, createHandlers: async () => [
            { command: 'workspace.get_snapshot', effect: 'read', validate: input => input, execute: async () => ({ totalDrafts: 0 }) },
            { command: 'generation.plan', effect: 'plan', validate: input => input, execute: async () => ({ status: 'qa-plan-only' }) },
        ] })
        await runtime.start(Promise.resolve({ inboxReady: true }))
        window.phase9bQa = { runtime, calls, receipts, results, submit: async () => {
            const envelope = { schemaVersion: 1, requestId: 'qa-read-9b', requestHash: `sha256:${'0'.repeat(64)}`, submittedAt: new Date().toISOString(),
                context: { apiVersion: 'nai-blue.agent/v1alpha1', workspaceId: 'qa-workspace-9b', clientId: 'qa-client', actor: { kind: 'agent' }, idempotencyKey: 'qa-read-9b' },
                command: { name: 'workspace.get_snapshot', input: {} }, authentication: { scheme: 'hmac-sha256', keyId: 'qa-key-1', signature: `hmac-sha256:${'0'.repeat(64)}` } }
            envelope.requestHash = agentRequestHash(envelope)
            files.set(envelope.requestId, JSON.stringify(envelope)); await runtime.poll()
            return { result: results.get(envelope.requestId), saved: await receipts.get(envelope.requestId) }
        } }
        document.getElementById('root').style.display = 'none'
        // The application shell owns viewport scrolling; the isolated harness owns document scrolling.
        document.documentElement.style.cssText = 'height:auto;overflow:auto'
        document.body.style.cssText = 'height:auto;min-height:100vh;overflow:auto'
        const host = document.createElement('main')
        host.id = 'phase9b-harness'; host.style.cssText = 'padding:16px;max-width:1000px;margin:auto'
        document.body.append(host)
        ReactDOM.createRoot(host).render(React.createElement(AgentCommandPanel, { runtime }))
    })
    const panel = page.locator('#phase9b-harness').getByTestId('agent-command-panel')
    await panel.getByRole('textbox', { name: 'AI 접속 이름' }).fill('격리 QA 도우미')
    await panel.getByRole('button', { name: '조회·계획 권한 등록', exact: true }).click()
    await panel.getByRole('button', { name: '접속 정보 복사', exact: true }).click()
    await panel.getByText('비밀키가 없는 접속 정보를 복사했습니다.', { exact: true }).waitFor()
    const connection = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
    assert.deepEqual(connection, { workspaceId: 'qa-workspace-9b', clientId: 'qa-client', keyId: 'qa-key-1', actorKind: 'agent' })
    report.checks.push('Human register + clipboard copy yields only workspace/client/key identifiers and actor kind')
    const receipt = await page.evaluate(() => window.phase9bQa.submit())
    assert.equal(receipt.saved.state, 'completed')
    assert.deepEqual(receipt.saved, receipt.result)
    report.checks.push('Native-port fixture request passes actual dispatcher and persists matching completed IndexedDB receipt/result')
    await panel.locator('summary').click()
    const capabilities = await page.evaluate(() => window.phase9bQa.runtime.getSnapshot().capabilities)
    assert.equal(capabilities.find(item => item.command === 'workspace.get_snapshot').available, true)
    assert.equal(capabilities.find(item => item.command === 'generation.plan').available, true)
    assert.ok(capabilities.filter(item => item.requiresHumanApproval).every(item => !item.available))
    report.checks.push('Same runtime capability registry exposes registered read/plan and blocks every mutation')
    await panel.getByRole('button', { name: '수신 중지', exact: true }).click()
    await panel.getByRole('button', { name: '수신 재개', exact: true }).waitFor()
    assert.ok(await page.evaluate(() => window.phase9bQa.runtime.getSnapshot().capabilities.every(item => !item.available)))
    await panel.getByRole('button', { name: '수신 재개', exact: true }).click()
    await panel.getByRole('button', { name: '수신 중지', exact: true }).waitFor()
    report.checks.push('Human stop disables all capabilities and resume restores foreground readiness')
    await panel.getByRole('button', { name: '키 교체', exact: true }).click()
    await page.waitForFunction(() => window.phase9bQa.runtime.getSnapshot().clients[0].keyId === 'qa-key-2' && !window.phase9bQa.runtime.getSnapshot().changingClient)
    await panel.getByRole('button', { name: '접속 정보 복사', exact: true }).click()
    await page.waitForFunction(async () => JSON.parse(await navigator.clipboard.readText()).keyId === 'qa-key-2')
    report.checks.push('Human rotation updates copied connection key identifier')
    await page.screenshot({ path: path.join(output, '02-ready-registered-rotated.png'), fullPage: true })
    await panel.getByRole('button', { name: '권한 폐기', exact: true }).click()
    await panel.getByText('권한 폐기됨', { exact: true }).waitFor()
    assert.equal(await panel.getByRole('button', { name: '키 교체', exact: true }).isDisabled(), true)
    assert.equal(await panel.getByRole('button', { name: '접속 정보 복사', exact: true }).isDisabled(), true)
    assert.equal(await panel.getByRole('button', { name: '권한 폐기', exact: true }).isDisabled(), true)
    report.checks.push('Human revoke marks client revoked and disables copy/rotate/revoke actions')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(output, '03-mobile-revoked.png'), fullPage: true, animations: 'disabled' })
    report.mobileDimensions = await panel.evaluate(element => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    assert.ok(report.mobileDimensions.documentWidth <= 390 && report.mobileDimensions.scrollWidth <= report.mobileDimensions.clientWidth + 1, JSON.stringify(report.mobileDimensions))
    report.checks.push('390px component harness and document have no horizontal overflow')
    assert.deepEqual(report.pageErrors, [])
    assert.deepEqual(report.consoleErrors, [])
    assert.ok(report.blockedExternalRequests.every(url => ['fonts.googleapis.com', 'cdn.jsdelivr.net'].includes(new URL(url).hostname)))
    report.status = 'passed'
} catch (error) {
    report.status = 'failed'; report.failure = error.stack ?? String(error)
    report.bodyAtFailure = (await page.locator('body').innerText().catch(() => '')).slice(0, 12000)
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined)
    process.exitCode = 1
} finally {
    await page.evaluate(() => window.phase9bQa?.runtime.stop()).catch(() => undefined)
    report.completedAt = new Date().toISOString()
    await writeFile(path.join(output, 'browser-qa-report.json'), JSON.stringify(report, null, 2) + '\n')
    await browser.close()
    console.log(JSON.stringify(report, null, 2))
}
