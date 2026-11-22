import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function workspace() {
    const root = await mkdtemp(path.join(tmpdir(), 'nai-blue-latency-'))
    roots.push(root)
    const results = path.join(root, 'agent-commands', 'results')
    const timings = path.join(root, 'agent-commands', 'timings')
    await mkdir(results, { recursive: true })
    await mkdir(timings, { recursive: true })
    const add = async (requestId: string, command: string, observedAt: string, seconds: number,
        spans: { name: string; offsetMs: number; ms: number; detail?: Record<string, number> }[] | null, totalMs = seconds * 1000) => {
        const file = path.join(results, `${requestId}.json`)
        await writeFile(file, JSON.stringify({ requestId, command, observedAt, state: 'completed' }))
        const written = new Date(Date.parse(observedAt) + seconds * 1000)
        await utimes(file, written, written)
        if (spans) await writeFile(path.join(timings, `${requestId}.json`), JSON.stringify({ schemaVersion: 1, requestId, command, outcome: 'projected', totalMs, spans }))
    }
    return { results, add }
}

const edit = (handlerMs: number, applyMs: number, validations: number[]) => [
    { name: 'agent-dispatch:total', offsetMs: 1, ms: handlerMs + 20 },
    { name: 'agent-dispatch:handler', offsetMs: 10, ms: handlerMs },
    { name: 'agent-exec:authoring-apply', offsetMs: 20, ms: applyMs },
    ...validations.map((ms, index) => ({ name: 'agent-ledger:validation', offsetMs: 30 + applyMs + index * 10, ms: Math.min(ms, 9),
        detail: { records: 651 - index, compacted: index } })),
]

describe('measure-agent-command-latency --timings', () => {
    it('prints per-command span medians, detail medians and handler coverage for receipts in the window', async () => {
        const w = await workspace()
        await w.add('edit-1', 'scene.patch_many', '2026-11-22T10:00:00.000Z', 8, edit(1_000, 600, [5, 7]))
        await w.add('edit-2', 'scene.patch_many', '2026-11-22T10:01:00.000Z', 7, edit(2_000, 1_200, [3]))
        await w.add('edit-3', 'scene.patch_many', '2026-11-22T10:02:00.000Z', 9, edit(3_000, 300, [9, 9, 9]))
        await w.add('before-window', 'scene.patch_many', '2026-11-22T09:00:00.000Z', 1, edit(99_999, 99_999, [1]))
        await w.add('no-timing-file', 'generation.plan', '2026-11-22T10:03:00.000Z', 9, null)
        const { stdout } = await run(process.execPath, ['scripts/measure-agent-command-latency.mjs',
            '--since', '2026-11-22T09:30:00.000Z', '--results-dir', w.results, '--timings'])
        const report = JSON.parse(stdout)
        expect(report.commands['scene.patch_many']).toMatchObject({ count: 3, median: 8 })
        expect(Object.keys(report.timings)).toEqual(['scene.patch_many'])
        const edits = report.timings['scene.patch_many']
        expect(edits).toMatchObject({ requests: 3, medianHandlerMs: 2_000 })
        expect(edits.spans.map((span: { name: string }) => span.name)).toEqual([
            'agent-dispatch:total', 'agent-dispatch:handler', 'agent-exec:authoring-apply', 'agent-ledger:validation'])
        expect(edits.spans.find((span: { name: string }) => span.name === 'agent-exec:authoring-apply')).toMatchObject({ requests: 3, medianMs: 600, medianCount: 1 })
        // Per request the validations add up (12, 3, 27 ms); detail medians are taken over every instance.
        expect(edits.spans.find((span: { name: string }) => span.name === 'agent-ledger:validation'))
            .toMatchObject({ medianMs: 12, medianCount: 2, detail: { records: 650, compacted: 0 } })
        // Handler coverage for edit-2: apply 1,200 ms + one 3 ms validation inside a 2,000 ms handler.
        expect(edits.handlerCoveredByChildSpans).toBeCloseTo(0.6, 2)
    })

    it('fails clearly when --timings is requested and the folder is missing', async () => {
        const w = await workspace()
        await rm(path.join(path.dirname(w.results), 'timings'), { recursive: true })
        await expect(run(process.execPath, ['scripts/measure-agent-command-latency.mjs',
            '--since', '2026-11-22T09:30:00.000Z', '--results-dir', w.results, '--timings'])).rejects.toMatchObject({ code: 1 })
        const { stdout } = await run(process.execPath, ['scripts/measure-agent-command-latency.mjs',
            '--since', '2026-11-22T09:30:00.000Z', '--results-dir', w.results])
        expect(JSON.parse(stdout)).not.toHaveProperty('timings')
    })
})
