import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Uses the same registered connection arguments as the normal stdio entry.
// With --verify-launch, start from a closed app and use an unapplied folder
// preview to exercise a real work request without editing user data.
const args = process.argv.slice(2)
const verifyLaunch = args.includes('--verify-launch')
const client = new Client({ name: 'nai-blue-runtime-verification', version: '1.0.0' })
const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./run-agent-mcp-stdio.mjs', import.meta.url)), ...args.filter(arg => arg !== '--verify-launch')], stderr: 'pipe' })
const pause = () => new Promise(resolve => setTimeout(resolve, 5000))
const deadline = Date.now() + 300_000
const resource = async uri => {
    const result = await client.readResource({ uri })
    return JSON.parse(result.contents[0].text)
}
try {
    await client.connect(transport)
    transport.stderr?.resume()
    if (verifyLaunch) {
        if ((await resource('nai-blue://runtime')).code !== 'APP_NOT_RUNNING') throw new Error('Start this check with NAI Blue closed.')
        const listed = await client.listTools()
        const caps = await resource('nai-blue://capabilities')
        if (!listed.tools.length || caps.runtime?.code !== 'APP_NOT_RUNNING') throw new Error('Discovery started the app.')
        await client.readResource({ uri: 'nai-blue://guides/agent-workflow/v1' })
        const read = await client.callTool({ name: 'system.describe_capabilities', arguments: { requestId: `read-${randomUUID()}`, input: {} } })
        if (read.structuredContent?.code !== 'APP_NOT_RUNNING' || (await resource('nai-blue://runtime')).code !== 'APP_NOT_RUNNING') {
            throw new Error('Status polling started the app.')
        }
        const requestId = `launch-preview-${randomUUID()}`
        const input = { expectedRevision: 0, changes: [{ op: 'patch', folderId: requestId, displayName: 'Preview' }] }
        let preview
        do {
            await client.readResource({ uri: 'nai-blue://guides/agent-workflow/v1' })
            const call = await client.callTool({ name: 'folder.plan_changes', arguments: { requestId, input } })
            preview = call.structuredContent
            if (!(preview?.code === 'APP_STARTING' && preview.submissionAttempted === false)) break
            if (Date.now() >= deadline) throw new Error('Timed out before preview submission.')
            await pause()
        } while (true)
        while (['submitted-to-inbox', 'submission-unconfirmed'].includes(preview?.status) && Date.now() < deadline) {
            await pause()
            preview = await resource(`nai-blue://requests/${requestId}`)
        }
        if (preview?.receipt?.command !== 'folder.plan_changes') throw new Error('Preview receipt unavailable.')
        console.log(JSON.stringify({ closedDuringDiscovery: true, launchRequest: requestId, previewState: preview.receipt.state }))
    }
    let runtime, lastCode
    do {
        runtime = await resource('nai-blue://runtime')
        if (runtime.status === 'ready') break
        if (runtime.code !== lastCode) { console.log(JSON.stringify({ runtime })); lastCode = runtime.code }
        if (runtime.code !== 'APP_STARTING') throw new Error(`Runtime unavailable: ${runtime.code}`)
        if (Date.now() >= deadline) throw new Error('Runtime readiness was not observed; retain the reported probe ID.')
        await pause()
    } while (true)
    await client.listTools()
    await client.readResource({ uri: 'nai-blue://guides/agent-workflow/v1' })
    const requestId = `runtime-verification-${randomUUID()}`
    const call = await client.callTool({ name: 'workspace.get_snapshot', arguments: { requestId, input: { limit: 1 } } })
    let result = call.structuredContent ?? JSON.parse(call.content.find(item => item.type === 'text').text)
    while (result.status === 'submitted-to-inbox' || result.status === 'submission-unconfirmed') {
        if (Date.now() >= deadline) throw new Error(`Read completion was not observed; inspect nai-blue://requests/${requestId}`)
        await pause()
        result = await resource(`nai-blue://requests/${requestId}`)
    }
    if (result.receipt?.state !== 'completed') throw new Error(`Read failed: ${result.code ?? result.receipt?.state ?? result.status}`)
    const { totalPresets, totalScenes, totalDrafts, queueActivity } = result.receipt.result
    console.log(JSON.stringify({ verified: true, runtime, requestId, resultDigest: result.receipt.resultDigest,
        totalPresets, totalScenes, totalDrafts, queueActivity }))
} finally { await client.close() }
