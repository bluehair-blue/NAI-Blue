import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Uses the same registered connection arguments as the normal stdio entry.
// Only public discovery/reads are issued; no generation, client registration,
// credentials, or policy are changed by this end-to-end verification.
const client = new Client({ name: 'nai-blue-runtime-verification', version: '1.0.0' })
const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./run-agent-mcp-stdio.mjs', import.meta.url)), ...process.argv.slice(2)], stderr: 'pipe' })
const pause = () => new Promise(resolve => setTimeout(resolve, 5000))
const deadline = Date.now() + 300_000
const resource = async uri => {
    const result = await client.readResource({ uri })
    return JSON.parse(result.contents[0].text)
}
try {
    await client.connect(transport)
    transport.stderr?.resume()
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
