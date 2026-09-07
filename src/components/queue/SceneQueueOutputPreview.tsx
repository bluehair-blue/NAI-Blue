import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { SceneQueueOutputReview } from '@/services/queue/scene-queue-adapter'

const PAGE_SIZE = 25

/** Shows allocator/R2-plan facts with bounded DOM size; copied plans explicitly retain their unverified state. */
export function SceneQueueOutputPreview({ outputs }: { outputs: readonly SceneQueueOutputReview[] }) {
    const { t } = useTranslation()
    const [page, setPage] = useState(0)
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
    const pageCount = Math.max(1, Math.ceil(outputs.length / PAGE_SIZE))
    const copyPlan = async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify({ status: 'planned', publicAccessVerified: false, outputs }, null, 2))
            setCopyState('copied')
        } catch {
            setCopyState('failed')
        }
    }
    return (
        <details className="border-y border-border py-3" data-testid="scene-output-preview">
            <summary className="min-h-11 cursor-pointer text-sm font-semibold">
                {t('folderWorkbench.outputPreview', '파일명·프롬프트·경로 전체 확인 ({{count}}장)', { count: outputs.length })}
            </summary>
            <p className="mb-3 text-sm text-muted-foreground">
                {t('folderWorkbench.plannedUrlHelp', '이 주소는 실행 계획입니다. 업로드와 공개 접근 확인은 아직 진행되지 않았습니다.')}
            </p>
            <Button type="button" variant="outline" className="mb-3 min-h-11" onClick={() => void copyPlan()}>
                {copyState === 'copied' ? t('folderWorkbench.planCopied', '계획 복사됨') : t('folderWorkbench.copyPlan', '전체 실행 계획 JSON 복사')}
            </Button>
            {copyState === 'failed' && <p role="alert" className="text-sm text-destructive">{t('folderWorkbench.copyFailed', '클립보드에 복사하지 못했습니다. 다시 시도해 주세요.')}</p>}
            <ol start={page * PAGE_SIZE + 1} className="list-inside list-decimal divide-y divide-border text-sm">
                {outputs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((output, index) => (
                    <li key={`${page}:${index}`} className="py-3">
                        <span className="break-all font-semibold">{output.fileName}</span>
                        <dl className="mt-2 grid gap-2">
                            <div><dt className="text-muted-foreground">{t('folderWorkbench.localPath', '로컬 위치')}</dt><dd className="break-all">{output.localPath ?? t('folderWorkbench.pathUnavailable', '이 환경에서는 실제 경로를 표시할 수 없습니다.')}</dd></div>
                            {output.r2Key !== null && <div><dt className="text-muted-foreground">{t('folderWorkbench.r2Key', 'R2 객체 키')}</dt><dd className="break-all">{output.r2Bucket}/{output.r2Key}</dd></div>}
                            {output.publicUrl !== null && <div><dt className="text-muted-foreground">{t('folderWorkbench.plannedUrl', '예정 공개 URL')}</dt><dd className="select-all break-all">{output.publicUrl}</dd></div>}
                        </dl>
                        <details className="mt-2"><summary className="min-h-11 cursor-pointer">{t('folderWorkbench.finalPrompt', '최종 프롬프트')} · {output.sceneName}</summary><p className="whitespace-pre-wrap break-words py-2 text-muted-foreground">{output.prompt}</p></details>
                    </li>
                ))}
            </ol>
            {pageCount > 1 && <div className="flex items-center justify-between gap-2 pt-2">
                <Button type="button" variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t('common.previous', '이전')}</Button>
                <span role="status">{page + 1} / {pageCount}</span>
                <Button type="button" variant="outline" disabled={page + 1 === pageCount} onClick={() => setPage(value => value + 1)}>{t('common.next', '다음')}</Button>
            </div>}
        </details>
    )
}
