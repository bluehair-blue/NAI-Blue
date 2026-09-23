import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
    inspectCompositionAuthority,
    type CompositionAuthorityInspection,
} from '@/lib/composition-migration-startup'
import { reportDiagnostic } from '@/services/diagnostics/error-registry'

function display(value: string | number | null): string {
    return value === null ? '—' : String(value)
}

export function CompositionAuthorityPanel() {
    const [inspection, setInspection] = useState<CompositionAuthorityInspection | null>(null)
    const [loading, setLoading] = useState(true)
    const [operationMessage, setOperationMessage] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        setLoading(true)
        try {
            setInspection(await inspectCompositionAuthority())
            setOperationMessage(null)
        } catch (error) {
            const event = reportDiagnostic(error, {
                operation: 'composition.status-inspection',
                stage: 'inspect',
                category: 'persistence',
                severity: 'error',
                recoverable: true,
            })
            setOperationMessage(`Composition status unavailable (${event.code}).`)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    return (
        <section aria-labelledby="composition-authority-title" className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 id="composition-authority-title" className="font-semibold">Composition Data</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Compatible saved formats are converted into one Composition path for NovelAI generation; original data remains archived.
                    </p>
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => { void refresh() }}
                    disabled={loading}
                >
                    <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    Refresh
                </Button>
            </div>

            <dl className="grid gap-x-4 gap-y-2 rounded-control bg-muted p-3 text-xs sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
                <dt className="font-medium">Generation path</dt>
                <dd className="break-all font-mono">Composition → NovelAI</dd>
                <dt className="font-medium">Repository revision / hash</dt>
                <dd className="break-all font-mono">
                    {display(inspection?.repositoryRevision ?? null)} / {display(inspection?.repositoryHash ?? null)}
                </dd>
                <dt className="font-medium">Migration status</dt>
                <dd className="break-all font-mono">{loading ? 'Loading…' : display(inspection?.migrationStatus ?? null)}</dd>
                <dt className="font-medium">Last startup conversion</dt>
                <dd className="break-all font-mono">{display(inspection?.lastStartup?.resultStatus ?? null)}</dd>
            </dl>

            {inspection?.migrationIssue && (
                <div role="alert" className="flex gap-2 rounded-control border border-destructive p-3 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="break-all">Composition conversion issue: {inspection.migrationIssue}</span>
                </div>
            )}
            {operationMessage && <p role="status" className="text-xs text-muted-foreground">{operationMessage}</p>}
        </section>
    )
}
