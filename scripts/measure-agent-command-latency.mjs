import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

// How long the application's handlers took, per command, from saved receipts: a receipt's observedAt is stamped when
// dispatch starts and its result file is written when the handler returns. Read-only; nothing is submitted.
const { values } = parseArgs({ options: {
    since: { type: 'string' }, until: { type: 'string' },
    'max-seconds': { type: 'string', default: '600' },
    'results-dir': { type: 'string', default: path.join(process.env.APPDATA ?? '', 'blue.bluehair.naiblue', 'agent-commands', 'results') },
    help: { type: 'boolean' },
} })
if (values.help || !values.since) {
    console.log('node scripts/measure-agent-command-latency.mjs --since <ISO time> [--until <ISO time>] [--max-seconds 600]\n'
        + 'Seconds from dispatch start to the result file, grouped by command, for receipts observed in that window.\n'
        + 'Measure before restarting NAI Blue: startup rewrites the result files of requests still in the execution\n'
        + 'history, so their write time no longer says when the handler finished. Those are counted as rewritten.')
    process.exit(values.help ? 0 : 1)
}
const since = new Date(values.since).toISOString(), until = values.until ? new Date(values.until).toISOString() : '9999'
const maxSeconds = Number(values['max-seconds'])

const groups = new Map()
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
    const group = groups.get(receipt.command) ?? { seconds: [], rewritten: 0 }
    const seconds = (info.mtimeMs - Date.parse(receipt.observedAt)) / 1000
    if (seconds > maxSeconds) group.rewritten += 1
    else group.seconds.push(Math.max(0, seconds))
    groups.set(receipt.command, group)
}

const round = value => Math.round(value * 10) / 10
console.log(JSON.stringify({ since, until: values.until ? until : null, commands: Object.fromEntries([...groups].sort().map(([command, group]) => {
    const sorted = group.seconds.sort((a, b) => a - b)
    return [command, { count: sorted.length, ...(sorted.length ? { min: round(sorted[0]),
        median: round(sorted[Math.floor((sorted.length - 1) / 2)]), max: round(sorted.at(-1)) } : {}),
        ...(group.rewritten ? { rewritten: group.rewritten } : {}) }]
})) }, null, 2))
