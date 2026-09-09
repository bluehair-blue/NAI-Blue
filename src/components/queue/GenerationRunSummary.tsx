import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { GenerationFulfillmentProjection } from '@/application/generation/generation-fulfillment'
import { projectGenerationRunStatus, summarizeGenerationRun } from '@/application/generation/generation-run-monitor'

/** A human-readable view of the same bounded facts returned by generation.get_run. */
export function GenerationRunSummary({ run }: { readonly run: GenerationFulfillmentProjection }) {
    const { t } = useTranslation()
    const monitor = summarizeGenerationRun(run)
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
    const messages = {
        wait: t('queue.monitor.wait', '앱이 생성과 저장을 진행합니다. 결과는 자동으로 갱신됩니다.'),
        'resume-in-app': t('queue.monitor.paused', '일시정지 중입니다. 계속하려면 위의 재개 버튼을 누르세요.'),
        'review-results': t('queue.monitor.complete', '요청한 생성·저장·업로드가 끝났습니다. 폴더에서 결과 이미지를 확인하세요.'),
        'review-recovery': t('queue.monitor.recovery', '확인이 필요한 항목이 있습니다. 아래 상세 결과에서 가능한 복구 작업을 확인하세요.'),
        'review-uncertain-result': t('queue.monitor.uncertain', '결과가 불확실한 항목이 있습니다. 다시 생성하기 전에 아래 상세 결과를 확인하세요.'),
        'inspect-status': t('queue.monitor.inspect', '완료하지 못했거나 확인이 필요한 항목이 있습니다. 아래 상세 결과와 작업 목록을 확인하세요.'),
    }
    const counts = [
        [t('queue.monitor.generated', '생성 확인'), monitor.counts.generated, monitor.counts.total],
        [t('queue.monitor.stored', '저장 확인'), monitor.counts.stored, monitor.counts.total],
        [t('queue.monitor.uploaded', '업로드 확인'), monitor.counts.uploaded, monitor.counts.uploadRequested],
    ] as const
    return <section className="shrink-0 border-b border-border px-3 py-3 sm:px-5" data-testid="generation-run-monitor"
        aria-label={t('queue.monitor.title', '생산 결과')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium" role="status">{messages[monitor.nextAction]}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('queue.monitor.foreground', '생성 중에는 NAI Blue를 실행해 두세요.')}</p>
            </div>
            <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={async () => {
                try {
                    await navigator.clipboard.writeText(JSON.stringify(projectGenerationRunStatus(run), null, 2))
                    setCopyState('copied')
                } catch { setCopyState('failed') }
            }}>{copyState === 'copied' ? t('queue.monitor.copied', '상태를 복사했어요')
                : copyState === 'failed' ? t('queue.monitor.copyFailed', '복사 실패 · 다시 시도') : t('queue.monitor.copy', '작업 상태 복사')}</Button>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-3 text-xs">
            {counts.map(([label, count, total]) => <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-sm font-semibold tabular-nums">{total === 0
                    ? t('queue.monitor.notRequested', '요청 없음') : `${count} / ${total}`}</dd>
            </div>)}
        </dl>
    </section>
}
