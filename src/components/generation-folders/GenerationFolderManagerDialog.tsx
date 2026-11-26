import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, FolderPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DEFAULT_GENERATION_FOLDER_ID } from '@/domain/generation-folders'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { buildGenerationFolderRows, GenerationFolderForm } from './GenerationFolderForm'

export function GenerationFolderManagerDialog({
    open,
    onOpenChange,
    onSaved,
    initialFolderId,
}: {
    open: boolean
    onOpenChange(open: boolean): void
    onSaved?(folderId: string): void
    initialFolderId?: string
}) {
    const { t } = useTranslation()
    const folders = useSettingsStore(state => state.generationFolders)
    const activeId = useSettingsStore(state => state.activeGenerationFolderId)
    const addFolder = useSettingsStore(state => state.addGenerationFolder)
    const deleteFolders = useSettingsStore(state => state.deleteGenerationFolders)
    const setActive = useSettingsStore(state => state.setActiveGenerationFolder)
    const rows = useMemo(() => buildGenerationFolderRows(folders), [folders])
    const [selectedId, setSelectedId] = useState(activeId)
    const selected = folders.find(folder => folder.id === selectedId) ?? folders[0]
    const [newName, setNewName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [deleteOpen, setDeleteOpen] = useState(false)

    useEffect(() => {
        if (!open) return
        setSelectedId(initialFolderId ?? activeId)
        setError(null)
    }, [activeId, initialFolderId, open])

    if (!selected) return null

    const createFolder = async (asRoot: boolean) => {
        try {
            const id = await addFolder({
                name: newName,
                parentId: asRoot ? null : selected.id,
                rootDirectory: asRoot ? newName : null,
            })
            setNewName('')
            setSelectedId(id)
            setActive(id)
            setError(null)
        } catch {
            setError(t('generationFolders.manager.createError', '폴더 이름을 확인해 주세요.'))
        }
    }

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent closeLabel={t('common.close', '닫기')} className="grid max-h-[calc(100dvh-2rem)] max-w-4xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0">
                    <DialogHeader className="border-b border-border/60 px-5 py-4 pr-14">
                        <DialogTitle>{t('generationFolders.manager.title', '이미지 저장 폴더')}</DialogTitle>
                        <DialogDescription>{t('generationFolders.manager.simpleDescription', '왼쪽에서 폴더를 고르고, 오른쪽의 3단계만 따라가면 됩니다.')}</DialogDescription>
                    </DialogHeader>

                    <div className="grid min-h-0 overflow-y-auto md:grid-cols-[minmax(14rem,0.72fr)_minmax(0,1.28fr)] md:overflow-hidden">
                        <aside className="border-b border-border/60 p-4 md:overflow-y-auto md:border-b-0 md:border-r">
                            <p className="mb-2 text-xs font-semibold text-muted-foreground">{t('generationFolders.manager.folderList', '내 폴더')}</p>
                            <div className="space-y-1">
                                {rows.map(row => (
                                    <button
                                        key={row.folder.id}
                                        type="button"
                                        className={cn(
                                            'flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-left text-sm',
                                            row.folder.id === selected.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/55',
                                        )}
                                        style={{ paddingLeft: `${0.5 + row.depth * 1.15}rem` }}
                                        onClick={() => setSelectedId(row.folder.id)}
                                    >
                                        <FolderOpen className="h-4 w-4 shrink-0" />
                                        <span className="truncate">{row.folder.id === DEFAULT_GENERATION_FOLDER_ID && row.folder.name === '기본 출력'
                                            ? t('generationFolders.defaultName', '기본 출력')
                                            : row.folder.name}</span>
                                    </button>
                                ))}
                            </div>

                            <div className="mt-4 rounded-panel border border-border/60 p-3">
                                <p className="text-xs font-semibold">{t('generationFolders.manager.addTitle', '새 폴더 만들기')}</p>
                                <Input className="mt-2" value={newName} onChange={event => setNewName(event.target.value)} placeholder={t('generationFolders.manager.newName', '예: 01 오프닝')} maxLength={96} />
                                <Button type="button" size="sm" className="mt-2 w-full" disabled={!newName.trim()} onClick={() => void createFolder(false)}>
                                    <FolderPlus className="mr-1.5 h-4 w-4" />{t('generationFolders.manager.createInside', '선택한 폴더 안에 만들기')}
                                </Button>
                                <Button type="button" variant="ghost" size="sm" className="mt-1 w-full" disabled={!newName.trim()} onClick={() => void createFolder(true)}>
                                    {t('generationFolders.manager.createSeparate', '별도 최상위 폴더로 만들기')}
                                </Button>
                                {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
                            </div>
                        </aside>

                        <GenerationFolderForm
                            folder={selected}
                            open={open}
                            mode="stepped"
                            onSaved={folderId => {
                                onSaved?.(folderId)
                                onOpenChange(false)
                            }}
                            onRequestDelete={() => setDeleteOpen(true)}
                        />
                    </div>
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title={t('generationFolders.manager.deleteTitle', '이 생성 폴더를 삭제할까요?')}
                description={t('generationFolders.manager.deleteDescription', '안쪽 폴더의 설정도 함께 삭제해요. 컴퓨터와 인터넷에 저장한 이미지 파일은 지우지 않아요.')}
                confirmText={t('generationFolders.manager.delete', '폴더 정의 삭제')}
                variant="destructive"
                onConfirm={async () => {
                    try {
                        await deleteFolders([selected.id])
                        setSelectedId(DEFAULT_GENERATION_FOLDER_ID)
                        setError(null)
                    } catch {
                        setError(t('generationFolders.manager.saveError', '입력값을 확인해 주세요. 폴더 설정은 아직 저장되지 않았습니다.'))
                        throw new Error('Generation folder deletion rejected')
                    }
                }}
            />
        </>
    )
}
