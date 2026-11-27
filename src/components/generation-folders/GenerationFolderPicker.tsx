import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderCog, HardDrive, UploadCloud } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { generationFolderDisplayName } from '@/presentation/folders/default-names'

import { Button } from '@/components/ui/button'
import {
    type GenerationFolderSelection,
    type GenerationFolder,
} from '@/domain/generation-folders'
import { DEFAULT_R2_PROFILE_ID } from '@/domain/r2/types'
import { resolveGenerationFolderAuthority } from '@/lib/generation-folder-authority-runtime'
import { useDefaultR2Readiness } from '@/hooks/useDefaultR2Readiness'
import { useSettingsStore } from '@/stores/settings-store'
import { GenerationFolderManagerDialog } from './GenerationFolderManagerDialog'

function orderedFolders(folders: readonly GenerationFolder[]): Array<{ folder: GenerationFolder; depth: number }> {
    const result: Array<{ folder: GenerationFolder; depth: number }> = []
    const append = (parentId: string | null, depth: number) => {
        folders.filter(folder => folder.parentId === parentId).forEach(folder => {
            result.push({ folder, depth })
            append(folder.id, depth + 1)
        })
    }
    append(null, 0)
    return result
}

export function GenerationFolderPicker({
    value,
    disabled = false,
    allowManual = false,
    onChange,
}: {
    value: string | null | undefined
    disabled?: boolean
    allowManual?: boolean
    onChange(selection: GenerationFolderSelection | null): void
}) {
    const { t } = useTranslation()
    const folders = useSettingsStore(state => state.generationFolders)
    const folderDocument = useSettingsStore(state => state.generationFolderDocument)
    const savePath = useSettingsStore(state => state.savePath)
    const useAbsolutePath = useSettingsStore(state => state.useAbsolutePath)
    const [managerOpen, setManagerOpen] = useState(false)
    const rows = useMemo(() => orderedFolders(folders), [folders])
    const preliminary = resolveGenerationFolderAuthority(folderDocument, folders, value, {
        directory: savePath,
        useAbsolutePath,
        r2ProfileId: DEFAULT_R2_PROFILE_ID,
    })
    const requestedProfileId = preliminary?.r2.profileId ?? null
    const r2State = useDefaultR2Readiness(
        requestedProfileId,
        requestedProfileId !== null && preliminary?.r2.autoUpload === true,
    )
    const readinessMatches = r2State.profile?.id === requestedProfileId
    const resolved = resolveGenerationFolderAuthority(folderDocument, folders, value, {
        directory: savePath,
        useAbsolutePath,
        r2ProfileId: requestedProfileId,
        r2Bucket: readinessMatches ? r2State.profile?.bucket : null,
        r2Prefix: readinessMatches ? r2State.profile?.prefix : null,
    })
    const r2Ready = readinessMatches && r2State.status === 'ready'
    const readyNotification = useRef<string | null>(null)

    useEffect(() => {
        if (!resolved || !resolved.r2.autoUpload || !r2Ready) {
            readyNotification.current = null
            return
        }
        const key = `${resolved.id}\u0000${resolved.r2.profileId ?? ''}`
        if (readyNotification.current === key) return
        readyNotification.current = key
        onChange({ folder: resolved, r2Ready: true })
    }, [onChange, r2Ready, resolved])

    return (
        <div className="space-y-2">
            <div className="flex gap-2">
                <select
                    value={value ?? ''}
                    disabled={disabled}
                    onChange={event => {
                        const id = event.target.value
                        if (!id) return onChange(null)
                        const selectedPreliminary = resolveGenerationFolderAuthority(folderDocument, folders, id, {
                            directory: savePath,
                            useAbsolutePath,
                            r2ProfileId: DEFAULT_R2_PROFILE_ID,
                        })
                        const selectedProfileMatches = r2State.profile?.id === selectedPreliminary?.r2.profileId
                        const folder = resolveGenerationFolderAuthority(folderDocument, folders, id, {
                            directory: savePath,
                            useAbsolutePath,
                            r2ProfileId: selectedPreliminary?.r2.profileId,
                            r2Bucket: selectedProfileMatches ? r2State.profile?.bucket : null,
                            r2Prefix: selectedProfileMatches ? r2State.profile?.prefix : null,
                        })
                        if (folder) onChange({ folder, r2Ready: selectedProfileMatches && r2State.status === 'ready' })
                    }}
                    className="min-h-11 min-w-0 flex-1 border-x-0 border-y border-input bg-background px-3 text-sm"
                    aria-label={t('generationFolders.pickerLabel', '이미지 생성 폴더')}
                >
                    {allowManual && <option value="">{t('generationFolders.manualPath', '직접 입력 경로 사용')}</option>}
                    {rows.map(row => (
                        <option key={row.folder.id} value={row.folder.id}>
                            {'— '.repeat(row.depth)}{generationFolderDisplayName(row.folder, t)}
                        </option>
                    ))}
                </select>
                <Button type="button" variant="outline" className="shrink-0" aria-label={t('generationFolders.manage', '폴더 관리')} onClick={() => setManagerOpen(true)} disabled={disabled}>
                    <FolderCog className="mr-1.5 h-4 w-4" />
                    {t('generationFolders.manage', '폴더 관리')}
                </Button>
            </div>
            {resolved && (
                <div className="grid gap-1 text-xs leading-5 text-muted-foreground sm:grid-cols-2">
                    <span className="flex min-w-0 items-start gap-1.5"><HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="truncate" title={resolved.directory}>{resolved.directory}</span></span>
                    <span className={`flex min-w-0 items-start gap-1.5 ${resolved.r2.autoUpload && !r2Ready ? 'opacity-55' : ''}`}>
                        <UploadCloud className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {resolved.r2.autoUpload
                            ? r2Ready
                                ? <span className="truncate" title={`${resolved.r2.bucket}/${resolved.r2.prefix}`}>{resolved.r2.bucket}/{resolved.r2.prefix}</span>
                                : <span>{t('generationFolders.r2NeedsSetup', 'R2 설정 필요')}</span>
                            : <span>{t('generationFolders.noAutoUpload', '자동 업로드 안 함')}</span>}
                    </span>
                </div>
            )}
            <GenerationFolderManagerDialog
                open={managerOpen}
                onOpenChange={setManagerOpen}
                onSaved={folderId => {
                    const settings = useSettingsStore.getState()
                    const savedPreliminary = resolveGenerationFolderAuthority(settings.generationFolderDocument, settings.generationFolders, folderId, {
                        directory: settings.savePath,
                        useAbsolutePath: settings.useAbsolutePath,
                        r2ProfileId: DEFAULT_R2_PROFILE_ID,
                    })
                    const savedProfileMatches = r2State.profile?.id === savedPreliminary?.r2.profileId
                    const folder = resolveGenerationFolderAuthority(settings.generationFolderDocument, settings.generationFolders, folderId, {
                        directory: settings.savePath,
                        useAbsolutePath: settings.useAbsolutePath,
                        r2ProfileId: savedPreliminary?.r2.profileId,
                        r2Bucket: savedProfileMatches ? r2State.profile?.bucket : null,
                        r2Prefix: savedProfileMatches ? r2State.profile?.prefix : null,
                    })
                    onChange(folder === null
                        ? null
                        : { folder, r2Ready: savedProfileMatches && r2State.status === 'ready' })
                }}
            />
        </div>
    )
}
