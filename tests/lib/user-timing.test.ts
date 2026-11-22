import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSpansForTests, markSpans, measureSpan, measureSpanSync, spansSince } from '@/lib/user-timing'

describe('span collector', () => {
    let clock = 0
    beforeEach(() => {
        clearSpansForTests()
        clock = 1_000
        vi.spyOn(performance, 'now').mockImplementation(() => clock)
    })
    afterEach(() => { vi.restoreAllMocks(); clearSpansForTests() })

    it('records nested and overlapping spans with their own start and duration', async () => {
        const mark = markSpans()
        let releaseSibling!: () => void
        const sibling = measureSpan('test:sibling', () => new Promise<void>(resolve => { releaseSibling = resolve }))
        clock += 5
        await measureSpan('test:parent', async () => {
            clock += 10
            measureSpanSync('test:child', () => { clock += 20 })
            clock += 1
        })
        clock += 4
        releaseSibling()
        await sibling
        const spans = spansSince(mark)
        expect(spans.map(({ name, startMs, ms }) => ({ name, offset: startMs - mark, ms }))).toEqual([
            { name: 'test:child', offset: 15, ms: 20 },
            { name: 'test:parent', offset: 5, ms: 31 },
            { name: 'test:sibling', offset: 0, ms: 40 },
        ])
    })

    it('keeps only finite numbers under identifier keys in the detail', async () => {
        await measureSpan('test:detail', async detail => {
            Object.assign(detail, { records: 651, rawLength: 2.5, broken: Number.NaN, endless: Number.POSITIVE_INFINITY,
                'bad key': 1, text: 'prompt' as unknown as number })
        })
        measureSpanSync('test:empty', () => undefined)
        const [withDetail, empty] = spansSince(0)
        expect(withDetail.detail).toEqual({ records: 651, rawLength: 2.5 })
        expect(empty).not.toHaveProperty('detail')
    })

    it('keeps the buffer bounded and drops the oldest spans first', () => {
        for (let index = 0; index < 4_500; index++) { clock = index; measureSpanSync(`test:${index}`, () => undefined) }
        const spans = spansSince(0)
        expect(spans.length).toBeLessThanOrEqual(4_000)
        expect(spans.length).toBeGreaterThan(3_000)
        expect(spans.at(-1)?.name).toBe('test:4499')
        expect(spans.some(span => span.name === 'test:0')).toBe(false)
    })

    it('excludes spans that started before the mark', async () => {
        measureSpanSync('test:before', () => { clock += 3 })
        const mark = markSpans()
        measureSpanSync('test:after', () => { clock += 3 })
        expect(spansSince(mark).map(span => span.name)).toEqual(['test:after'])
    })

    it('records a span whose work throws and rethrows the same error', async () => {
        const failure = new Error('work failed')
        await expect(measureSpan('test:async-throw', async detail => { detail.attempts = 2; clock += 7; throw failure })).rejects.toBe(failure)
        expect(() => measureSpanSync('test:sync-throw', () => { throw failure })).toThrow(failure)
        expect(spansSince(0)).toEqual([
            { name: 'test:async-throw', startMs: 1_000, ms: 7, detail: { attempts: 2 } },
            { name: 'test:sync-throw', startMs: 1_007, ms: 0 },
        ])
    })

    it('still runs and records the work when User Timing is unavailable', async () => {
        vi.restoreAllMocks()
        vi.stubGlobal('performance', undefined)
        try {
            expect(await measureSpan('test:untimed', async () => 'done')).toBe('done')
            expect(spansSince(0).map(span => span.name)).toEqual(['test:untimed'])
        } finally { vi.unstubAllGlobals() }
    })
})
