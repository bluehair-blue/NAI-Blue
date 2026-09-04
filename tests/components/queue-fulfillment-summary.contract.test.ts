import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('Queue fulfillment summary contract', () => {
    it('loads the full generation run only on detail open or explicit refresh', async () => {
        const source = await readFile(resolve(process.cwd(), 'src/pages/QueueCenter.tsx'), 'utf8')
        const pollingStart = source.indexOf('const refresh = useCallback')
        const fulfillmentStart = source.indexOf('const loadFulfillment = useCallback')
        const pollingSource = source.slice(pollingStart, fulfillmentStart)

        expect(pollingStart).toBeGreaterThan(-1)
        expect(fulfillmentStart).toBeGreaterThan(pollingStart)
        expect(pollingSource).not.toContain('getRuntimeGenerationRun')
        expect(source.slice(fulfillmentStart)).toContain('getRuntimeGenerationRun(selectedBatchId)')
        expect(source).toContain('data-testid="queue-fulfillment-summary"')
        expect(source).toContain('onToggle={event =>')
        expect(source).toContain("t('queue.fulfillment.refresh', 'Refresh stages')")
        expect(source).toContain('fulfillment.issues.length > 0')
        expect(source).toContain("'retry-scene-link'")
        expect(source).toContain('getRuntimeQueueRecoveryCommandAdapter')
        expect(source).toContain("issue.action.kind === 'abandon-reservation'")
        expect(source).toContain("issue.action.kind === 'discard-result-and-abandon-reservation'")
        expect(source).toContain('await Promise.all([refresh(), loadFulfillment()])')
        expect(source).toContain('disabled={busy}')
        expect(source).toContain('recoveryGate.current.run(key')
    })

    it('keeps a failed destructive confirmation open for a retry', async () => {
        const source = await readFile(resolve(process.cwd(), 'src/components/ui/confirm-dialog.tsx'), 'utf8')
        const handler = source.slice(source.indexOf('const handleConfirm'), source.indexOf('return ('))

        expect(handler).toContain('await onConfirm()')
        expect(handler).toContain('onOpenChange(false)')
        expect(handler).toContain('catch')
        expect(handler.indexOf('onOpenChange(false)')).toBeLessThan(handler.indexOf('catch'))
        expect(handler.slice(handler.indexOf('catch'))).not.toContain('onOpenChange(false)')
    })
})
