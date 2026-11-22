import { access, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

// How long the application's handlers took, per command, from saved receipts: a receipt's observedAt is stamped when
// dispatch starts and its result file is written when the handler returns. Read-only; nothing is submitted.
const { values } = parseArgs({ options: {
    since: { type: 'string' }, until: { type: 'string' },
    'max-seconds': { type: 'string', default: '600' },
    'results-dir': { type: 'string', default: path.join(process.env.APPDATA ?? '', 'blue.bluehair.naiblue', 'agent-commands', 'results') },
    timings: { type: 'boolean' },
    'timings-dir': { type: 'string' },
    help: { type: 'boolean' },
} })
if (values.help || !values.since) {
    console.log('node scripts/measure-agent-command-latency.mjs --since <ISO time> [--until <ISO time>] [--max-seconds 600] [--timings]\n'
        + 'Seconds from dispatch start to the result file, grouped by command, for receipts observed in that window.\n'
        + 'Measure before restarting NAI Blue: startup rewrites the result files of requests still in the execution\n'
        + 'history, so their write time no longer says when the handler finished. Those are counted as rewritten.\n'
        + 'Span timings (agent-commands/timings next to the results folder) are summarized when that folder exists;\n'
        + '--timings makes a missing folder an error, --timings-dir reads another folder.')
    process.exit(values.help ? 0 : 1)
}
const since = new Date(values.since).toISOString(), until = values.until ? new Date(values.until).toISOString() : '9999'
const maxSeconds = Number(values['max-seconds'])
const timingsDir = values['timings-dir'] ?? path.join(path.dirname(values['results-dir']), 'timings')

const groups = new Map()
const windowRequests = new Map()
for (const name of await readdir(values['results-dir'])) {
    // Adapter-made capability probes are not agent work.
    if (!name.endsWith('.json') || name.startsWith('mcp-cap-')) continue
    const file = path.join(values['results-dir'], name)
    const info = await stat(file)
    // A receipt cannot be written before it was observed, so older files are outside the window without being read.
    if (info.size > 2_000_000 || info.mtime.toISOString() < since) continue
    let receipt
    try { receipt = JSON.parse(await readFile(file, 'utf8')) } catch { continue }
    if (typeof receipt.observedAt !== 'string' || receipt.observedAt < since || receipt.observedAt > until
        || receipt.command === 'system.describe_capabilities') continue
    windowRequests.set(typeof receipt.requestId === 'string' ? receipt.requestId : name.slice(0, -'.json'.length), receipt.command)
    const group = groups.get(receipt.command) ?? { seconds: [], rewritten: 0 }
    const seconds = (info.mtimeMs - Date.parse(receipt.observedAt)) / 1000
    if (seconds > maxSeconds) group.rewritten += 1
    else group.seconds.push(Math.max(0, seconds))
    groups.set(receipt.command, group)
}

const round = value => Math.round(value * 10) / 10
const median = list => { const sorted = [...list].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)] }
const report = { since, until: values.until ? until : null, commands: Object.fromEntries([...groups].sort().map(([command, group]) => {
    const sorted = group.seconds.sort((a, b) => a - b)
    return [command, { count: sorted.length, ...(sorted.length ? { min: round(sorted[0]),
        median: round(sorted[Math.floor((sorted.length - 1) / 2)]), max: round(sorted.at(-1)) } : {}),
        ...(group.rewritten ? { rewritten: group.rewritten } : {}) }]
})) }

const timingsExist = await access(timingsDir).then(() => true, () => false)
if (values.timings && !timingsExist) { console.error(`No timings folder at ${timingsDir}`); process.exit(1) }
if (timingsExist) report.timings = summarizeTimings(await readTimings(timingsDir, windowRequests))
console.log(JSON.stringify(report, null, 2))

async function readTimings(directory, requests) {
    const files = []
    for (const [requestId, receiptCommand] of requests) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(requestId) || requestId.includes('..')) continue
        let timing
        try { timing = JSON.parse(await readFile(path.join(directory, `${requestId}.json`), 'utf8')) } catch { continue }
        if (timing?.schemaVersion !== 1 || !Array.isArray(timing.spans)) continue
        files.push({ ...timing, command: timing.command ?? receiptCommand })
    }
    return files
}

/** Length of the union of [start, end) intervals: nested spans are counted once. */
function covered(intervals) {
    let total = 0, end = -Infinity
    for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
        if (stop <= end) continue
        total += stop - Math.max(start, end)
        end = stop
    }
    return total
}

function summarizeTimings(files) {
    const byCommand = new Map()
    for (const file of files) byCommand.set(file.command, [...byCommand.get(file.command) ?? [], file])
    return Object.fromEntries([...byCommand].sort().map(([command, list]) => {
        const names = new Map()
        const handlerCoverage = [], requestCoverage = [], handlerMs = []
        for (const file of list) {
            const perRequest = new Map()
            for (const span of file.spans) {
                const entry = perRequest.get(span.name) ?? { ms: 0, count: 0 }
                entry.ms += span.ms; entry.count += 1
                perRequest.set(span.name, entry)
                const name = names.get(span.name) ?? { totals: [], counts: [], details: new Map() }
                for (const [key, value] of Object.entries(span.detail ?? {})) {
                    if (typeof value === 'number') name.details.set(key, [...name.details.get(key) ?? [], value])
                }
                names.set(span.name, name)
            }
            for (const [spanName, entry] of perRequest) { names.get(spanName).totals.push(entry.ms); names.get(spanName).counts.push(entry.count) }
            const interval = span => [span.offsetMs, span.offsetMs + span.ms]
            if (file.totalMs > 0) requestCoverage.push(covered(file.spans.map(interval)) / file.totalMs)
            // Rounding to 0.1 ms can push a child a hair outside its parent.
            const handler = file.spans.find(span => span.name === 'agent-dispatch:handler')
            if (handler && handler.ms > 0) {
                handlerMs.push(handler.ms)
                const inside = file.spans.filter(span => span !== handler && span.offsetMs >= handler.offsetMs - 0.1
                    && span.offsetMs + span.ms <= handler.offsetMs + handler.ms + 0.2)
                handlerCoverage.push(Math.min(1, covered(inside.map(interval)) / handler.ms))
            }
        }
        const spans = [...names].map(([name, value]) => ({ name, requests: value.totals.length,
            medianMs: round(median(value.totals)), medianCount: median(value.counts),
            ...(value.details.size ? { detail: Object.fromEntries([...value.details].map(([key, values]) => [key, round(median(values))])) } : {}) }))
            .sort((left, right) => right.medianMs - left.medianMs)
        return [command, { requests: list.length, medianTotalMs: round(median(list.map(file => file.totalMs))),
            ...(handlerMs.length ? { medianHandlerMs: round(median(handlerMs)), handlerCoveredByChildSpans: round(median(handlerCoverage) * 100) / 100 } : {}),
            ...(requestCoverage.length ? { requestCoveredBySpans: round(median(requestCoverage) * 100) / 100 } : {}),
            spans }]
    }))
}
