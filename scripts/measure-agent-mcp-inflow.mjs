import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Compares what the MCP adapter put into an agent's context on two days. Since the compact adapter, each
// response's size is logged by run-agent-mcp-stdio.mjs; an earlier day is rebuilt from the saved receipts,
// because every call then returned its whole receipt and was preceded by one forced guide read.
const repo = fileURLToPath(new URL('../', import.meta.url))
// Sizes at commit 8678e21, the last one with the per-call guide gate.
const LEGACY = { guideChars: 17_969, instructionsChars: 645, toolsListChars: 43_000 }

const { values } = parseArgs({ options: {
    date: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, baseline: { type: 'string' },
    'usage-dir': { type: 'string', default: path.join(repo, 'output', 'mcp-usage') },
    'results-dir': { type: 'string', default: path.join(process.env.APPDATA ?? '', 'blue.bluehair.naiblue', 'agent-commands', 'results') },
    help: { type: 'boolean' },
} })
if (values.help || (!values.date && !values.baseline)) {
    console.log('node scripts/measure-agent-mcp-inflow.mjs [--date YYYY-MM-DD [--since ISO] [--until ISO]] [--baseline YYYY-MM-DD]\n'
        + '--date sums the adapter usage log of that UTC day; --since/--until narrow it to one session.\n'
        + '--baseline rebuilds the inflow of a day before the compact adapter from saved receipts.')
    process.exit(values.help ? 0 : 1)
}

async function measured(date) {
    let raw
    try { raw = await readFile(path.join(values['usage-dir'], `${date}.jsonl`), 'utf8') }
    catch { return null }
    const groups = new Map()
    let chars = 0, images = 0, calls = 0
    for (const line of raw.split('\n').filter(Boolean)) {
        const entry = JSON.parse(line)
        if ((values.since && entry.at < values.since) || (values.until && entry.at > values.until)) continue
        const key = entry.kind === 'tool' || entry.kind === 'resource' ? `${entry.kind} ${entry.name}` : entry.kind
        const group = groups.get(key) ?? { responses: 0, chars: 0, images: 0 }
        group.responses += 1; group.chars += entry.chars; group.images += entry.images
        groups.set(key, group)
        chars += entry.chars; images += entry.images
        if (entry.kind === 'tool') calls += 1
    }
    return { date, toolCalls: calls, chars, images, groups: Object.fromEntries([...groups].sort((a, b) => b[1].chars - a[1].chars)) }
}

async function rebuilt(date) {
    const groups = new Map()
    let calls = 0, receiptChars = 0
    for (const name of await readdir(values['results-dir'])) {
        // Adapter-made capability probes never reached the model as tool results.
        if (!name.endsWith('.json') || name.startsWith('mcp-cap-')) continue
        const file = path.join(values['results-dir'], name)
        if ((await stat(file)).size > 2_000_000) continue
        let receipt
        try { receipt = JSON.parse(await readFile(file, 'utf8')) } catch { continue }
        if (typeof receipt.observedAt !== 'string' || !receipt.observedAt.startsWith(date)) continue
        // Hosts also probe capabilities on their own; leaving those out keeps the baseline from being overstated.
        if (receipt.command === 'system.describe_capabilities') continue
        // The old adapter returned { status, requestId, requiresAppProcess, receipt } as text.
        const size = JSON.stringify({ status: 'application-receipt', requestId: receipt.requestId, requiresAppProcess: true, receipt }).length
        const group = groups.get(receipt.command) ?? { responses: 0, chars: 0 }
        group.responses += 1; group.chars += size
        groups.set(receipt.command, group)
        calls += 1; receiptChars += size
    }
    const guideChars = calls * LEGACY.guideChars
    return { date, toolCalls: calls, chars: receiptChars + guideChars + LEGACY.toolsListChars + LEGACY.instructionsChars,
        parts: { forcedGuideReads: guideChars, receipts: receiptChars, toolsList: LEGACY.toolsListChars, instructions: LEGACY.instructionsChars },
        groups: Object.fromEntries([...groups].sort((a, b) => b[1].chars - a[1].chars)) }
}

const report = {}
if (values.date) report.measured = await measured(values.date) ?? { date: values.date, error: 'no usage log for that day' }
if (values.baseline) report.baseline = await rebuilt(values.baseline)
if (report.measured?.chars && report.baseline?.chars) {
    report.ratio = Number((report.measured.chars / report.baseline.chars).toFixed(4))
    report.perToolCall = { measured: Math.round(report.measured.chars / Math.max(report.measured.toolCalls, 1)),
        baseline: Math.round(report.baseline.chars / Math.max(report.baseline.toolCalls, 1)) }
}
console.log(JSON.stringify(report, null, 2))
