import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8')

describe('diagnostic drawer interaction contract', () => {
    it('keeps a native touch-safe launcher and explicit keyboard activation path', async () => {
        const drawer = await source('src/components/diagnostics/DiagnosticDrawer.tsx')
        const contract = await source('src/components/diagnostics/drawer-contract.ts')

        expect(drawer).toContain('<button')
        expect(drawer).toContain('min-h-11')
        expect(drawer).toContain('aria-haspopup="dialog"')
        expect(drawer).toContain('getDiagnosticDrawerTriggerProps')
        expect(contract).toContain("event.key === 'Enter'")
        expect(contract).toContain("event.key === ' '")
        expect(contract).toContain('onClick: open')
    })

    it('offers summary copy, redacted full-log copy, and JSON export without a modal toast path', async () => {
        const drawer = await source('src/components/diagnostics/DiagnosticDrawer.tsx')
        const bridge = await source('src/components/diagnostics/DiagnosticToastBridge.tsx')

        expect(drawer).toContain("copyDiagnosticEvent(selectedEvent, 'summary')")
        expect(drawer).toContain("copyDiagnosticEvent(selectedEvent, 'full')")
        expect(drawer).toContain('downloadDiagnosticsExport')
        expect(bridge).toContain('recommendedAction')
        expect(bridge).toContain('variant: latestEvent.severity')
    })

    it('shows migration status without exposing a legacy authority switch', async () => {
        const drawer = await source('src/components/diagnostics/DiagnosticDrawer.tsx')
        const panel = await source('src/components/diagnostics/CompositionAuthorityPanel.tsx')

        expect(drawer).toContain('<CompositionAuthorityPanel')
        expect(drawer).not.toContain('{hasInteractiveDiagnostic && (')
        for (const label of ['Composition Data', 'Composition → NovelAI', 'Repository revision / hash', 'Migration status']) {
            expect(panel).toContain(label)
        }
        expect(panel).toContain('original data remains archived')
        expect(panel).not.toContain('applyCompositionAuthorityFeatureFlag')
        expect(panel).not.toContain('Rollback to legacy')
        expect(panel).not.toContain('.setAuthority(')
        expect(panel).toContain('min-h-11')
    })
})
