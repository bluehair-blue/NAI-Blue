import { useState, useEffect, useRef, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { Tip } from '@/components/ui/tooltip'
import {
    Key,
    Settings2,
    Save,
    Check,
    X,
    Sun,
    Moon,
    Monitor,
    Languages,
    Loader2,
    FolderOpen,
    Palette,
    Type,
    Zap,
    RotateCcw,
    Info,
    RefreshCw,
    Download,
    Timer,
    Sparkles,
    Keyboard,
    Upload,
    Database,
    AlertTriangle,
    HardDrive,
} from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { useThemeStore } from '@/stores/theme-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useShortcutStore, SHORTCUT_ACTIONS, formatKeyBinding, type ShortcutAction, type KeyBinding } from '@/stores/shortcut-store'
import { toast } from '@/components/ui/use-toast'
import GeminiIcon from '@/assets/gemini-color.svg'
import { openNativeFileDialog, saveNativeFileDialog } from '@/platform/native-file-dialog'
import { checkForNativeUpdate } from '@/platform/native-update'
import { relaunchApplication } from '@/lib/app-relaunch'
import { getNativeAppVersion } from '@/platform/native-app'
import { useUpdateStore, setCurrentUpdateObject, installPendingUpdate } from '@/stores/update-store'
import { importAllData, getStoreSizes } from '@/lib/indexed-db'
import { readNativeTextFile, writeNativeTextFile } from '@/platform/native-file-system'
import { RestoreDialog } from '@/components/backup/RestoreDialog'
import { StoreSnapshotRestoreDialog } from '@/components/backup/StoreSnapshotRestoreDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ApiTokenSettingsCard } from '@/components/credentials/ApiTokenSettingsCard'
import {
    ASSET_PROFILE_FILE_RESTORE_KEY,
    createCurrentBackupEnvelopeV3,
    createFullAutoBackup,
    DISK_AUTO_BACKUP_LAST_KEY,
    prepareBackupRestore,
    type PreparedBackupRestore,
} from '@/lib/auto-backup'
import { isMobileRuntime } from '@/platform/runtime'
import {
    loadRawAssetProfileFile,
    restoreRawAssetProfileFile,
    restoreRawAssetProfileFilePreimage,
} from '@/services/asset-profile-file'

const LANGUAGES = [
    { code: 'ko', name: '한국어' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
]

export type SettingsSection = 'general' | 'appearance' | 'api' | 'storage' | 'shortcuts' | 'backup'

interface SettingsProps {
    /** Renders one real settings form without the expert settings navigation. */
    guidedSection?: Exclude<SettingsSection, 'general'>
}

const SECTIONS = [
    { id: 'general' as const, icon: Settings2, labelKey: 'settingsPage.sections.general' },
    { id: 'appearance' as const, icon: Palette, labelKey: 'settingsPage.sections.appearance' },
    { id: 'api' as const, icon: Key, labelKey: 'settingsPage.sections.api' },
    { id: 'storage' as const, icon: FolderOpen, labelKey: 'settingsPage.sections.storage' },
    { id: 'shortcuts' as const, icon: Keyboard, labelKey: 'settingsPage.sections.shortcuts' },
    { id: 'backup' as const, icon: Database, labelKey: 'settingsPage.backup.title' },
]

export default function Settings({ guidedSection }: SettingsProps = {}) {
    const { t, i18n } = useTranslation()
    const [searchParams, setSearchParams] = useSearchParams()
    const { theme, setTheme } = useThemeStore()
    const {
        savePath,
        autoSave,
        setSavePath,
        setAutoSave,
        promptFontSize,
        setPromptFontSize,
        useStreaming,
        setUseStreaming,
        generationDelay,
        setGenerationDelay,
        geminiApiKey,
        setGeminiApiKey,
        useAbsolutePath,
        sceneSavePath,
        useAbsoluteScenePath,
        sceneSubfoldersEnabled,
        setSceneSavePath,
        setSceneSubfoldersEnabled,
        styleLabSavePath,
        useAbsoluteStyleLabPath,
        setStyleLabSavePath,
        toolsSavePath,
        useAbsoluteToolsPath,
        setToolsSavePath,
        libraryPath,
        useAbsoluteLibraryPath,
        setLibraryPath,
        imageFormat,
        setImageFormat,
        metadataMode,
        setMetadataMode,
    } = useSettingsStore()
    const { bindings, enabled: shortcutsEnabled, setBinding, resetBinding, resetAllBindings, setEnabled: setShortcutsEnabled } = useShortcutStore()
    const [localGeminiKey, setLocalGeminiKey] = useState(geminiApiKey)

    const [activeSection, setActiveSection] = useState<SettingsSection>(() => {
        if (guidedSection) return guidedSection
        const requested = searchParams.get('section')
        return SECTIONS.some(section => section.id === requested)
            ? requested as SettingsSection
            : 'general'
    })
    const [localSavePath, setLocalSavePath] = useState(savePath)
    const [isAbsolutePath, setIsAbsolutePath] = useState(useAbsolutePath)
    const [localSceneSavePath, setLocalSceneSavePath] = useState(sceneSavePath)
    const [isAbsoluteScenePath, setIsAbsoluteScenePath] = useState(useAbsoluteScenePath)
    const [localStyleLabSavePath, setLocalStyleLabSavePath] = useState(styleLabSavePath)
    const [isAbsoluteStyleLabPath, setIsAbsoluteStyleLabPath] = useState(useAbsoluteStyleLabPath)
    const [localToolsSavePath, setLocalToolsSavePath] = useState(toolsSavePath)
    const [isAbsoluteToolsPath, setIsAbsoluteToolsPath] = useState(useAbsoluteToolsPath)
    const [localLibraryPath, setLocalLibraryPath] = useState(libraryPath)
    const [isAbsoluteLibraryPath, setIsAbsoluteLibraryPath] = useState(useAbsoluteLibraryPath)
    const [appVersion, setAppVersion] = useState('')
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
    const { pendingUpdate, isDownloading, setPendingUpdate, setIsDownloading, setDownloadProgress } = useUpdateStore()

    // Deep links from the Data Hub land on the actionable settings section;
    // mirroring selection into the URL also keeps browser back/forward useful.
    const selectSection = (section: SettingsSection) => {
        setActiveSection(section)
        const next = new URLSearchParams(searchParams)
        if (section === 'general') next.delete('section')
        else next.set('section', section)
        setSearchParams(next, { replace: true })
    }

    useEffect(() => {
        if (guidedSection) {
            if (activeSection !== guidedSection) setActiveSection(guidedSection)
            return
        }
        const requested = searchParams.get('section')
        if (SECTIONS.some(section => section.id === requested) && requested !== activeSection) {
            setActiveSection(requested as SettingsSection)
        }
    }, [activeSection, guidedSection, searchParams])

    // 키바인드 편집 상태
    const [editingAction, setEditingAction] = useState<ShortcutAction | null>(null)
    const [recordedBinding, setRecordedBinding] = useState<KeyBinding | null>(null)
    
    // 백업 관련 상태
    const [isExporting, setIsExporting] = useState(false)
    const [isImporting, setIsImporting] = useState(false)
    const backupFileInputRef = useRef<HTMLInputElement>(null)
    const [isCreatingAutoBackup, setIsCreatingAutoBackup] = useState(false)
    const [pendingBackupRestore, setPendingBackupRestore] = useState<PreparedBackupRestore | null>(null)
    const [restoreDialogOpen, setRestoreDialogOpen] = useState(false)
    const [storeSnapshotRestoreDialogOpen, setStoreSnapshotRestoreDialogOpen] = useState(false)
    const [storeSizes, setStoreSizes] = useState<{ [key: string]: number }>({})
    const [lastBackupTime, setLastBackupTime] = useState<string | null>(null)
    const [lastAutoBackupTime, setLastAutoBackupTime] = useState<string | null>(null)

    useEffect(() => {
        getNativeAppVersion().then(setAppVersion).catch(() => setAppVersion('dev'))
        // 마지막 백업 시간 로드
        const lastBackup = localStorage.getItem('nai-blue-last-backup-time')
        if (lastBackup) setLastBackupTime(lastBackup)
        const lastAutoBackup = localStorage.getItem(DISK_AUTO_BACKUP_LAST_KEY)
        if (lastAutoBackup) {
            const parsed = Number(lastAutoBackup)
            if (Number.isFinite(parsed)) setLastAutoBackupTime(new Date(parsed).toISOString())
        }
    }, [])
    
    // 데이터 크기 로드 (backup 섹션 진입 시)
    useEffect(() => {
        if (activeSection === 'backup') {
            getStoreSizes().then(setStoreSizes).catch(console.error)
        }
    }, [activeSection])

    const isAbsoluteFolderPath = (value: string) =>
        /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')

    const handleSavePath = async () => {
        try {
            await setSavePath(localSavePath, isAbsolutePath)
            toast({ title: t('settingsPage.saved'), variant: 'success' })
        } catch {
            toast({ title: t('common.error', '저장하지 못했습니다.'), variant: 'destructive' })
        }
    }

    // Browse for folder using native dialog
    const handleBrowseFolder = async () => {
        try {
            const selected = await openNativeFileDialog({
                directory: true,
                multiple: false,
                title: t('settingsPage.save.selectFolder', 'Select Save Folder'),
            })
            if (selected && typeof selected === 'string') {
                setLocalSavePath(selected)
                setIsAbsolutePath(true)
            }
        } catch (e) {
            console.error('Folder selection failed:', e)
        }
    }

    // Reset to default Pictures subfolder
    const handleResetToDefault = async () => {
        setLocalSavePath('NAI_Blue_Output')
        setIsAbsolutePath(false)
        try {
            await setSavePath('NAI_Blue_Output', false)
            toast({ title: t('settingsPage.saved'), variant: 'success' })
        } catch {
            toast({ title: t('common.error', '저장하지 못했습니다.'), variant: 'destructive' })
        }
    }

    const handleSaveScenePath = () => {
        setSceneSavePath(localSceneSavePath, isAbsoluteScenePath)
        toast({ title: t('settingsPage.saved'), variant: 'success' })
    }

    const handleBrowseSceneFolder = async () => {
        try {
            const selected = await openNativeFileDialog({
                directory: true,
                multiple: false,
                title: t('settingsPage.save.outputFolders.scene.selectFolder', 'Select Scene Folder'),
            })
            if (selected && typeof selected === 'string') {
                setLocalSceneSavePath(selected)
                setIsAbsoluteScenePath(true)
            }
        } catch (e) {
            console.error('Folder selection failed:', e)
        }
    }

    const handleResetSceneToDefault = async () => {
        setLocalSceneSavePath('NAI_Blue_Scene')
        setIsAbsoluteScenePath(false)
        setSceneSavePath('NAI_Blue_Scene', false)
        toast({ title: t('settingsPage.saved'), variant: 'success' })
    }

    const handleSaveStyleLabPath = () => {
        setStyleLabSavePath(localStyleLabSavePath, isAbsoluteStyleLabPath)
        toast({ title: t('settingsPage.saved'), variant: 'success' })
    }

    const handleBrowseStyleLabFolder = async () => {
        try {
            const selected = await openNativeFileDialog({
                directory: true,
                multiple: false,
                title: t('settingsPage.save.outputFolders.styleLab.selectFolder', 'Select Style Lab Folder'),
            })
            if (selected && typeof selected === 'string') {
                setLocalStyleLabSavePath(selected)
                setIsAbsoluteStyleLabPath(true)
            }
        } catch (e) {
            console.error('Folder selection failed:', e)
        }
    }

    const handleResetStyleLabToDefault = async () => {
        setLocalStyleLabSavePath('nai-blue-style')
        setIsAbsoluteStyleLabPath(false)
        setStyleLabSavePath('nai-blue-style', false)
        toast({ title: t('settingsPage.saved'), variant: 'success' })
    }

    const handleSaveToolsPath = () => {
        setToolsSavePath(localToolsSavePath, isAbsoluteToolsPath)
        toast({ title: t('settingsPage.saved'), variant: 'success' })
    }

    const handleBrowseToolsFolder = async () => {
        try {
            const selected = await openNativeFileDialog({
                directory: true,
                multiple: false,
                title: t('settingsPage.save.outputFolders.tools.selectFolder', 'Select Tools Folder'),
            })
            if (selected && typeof selected === 'string') {
                setLocalToolsSavePath(selected)
                setIsAbsoluteToolsPath(true)
            }
        } catch (e) {
            console.error('Folder selection failed:', e)
        }
    }

    const handleResetToolsToDefault = async () => {
        setLocalToolsSavePath('nai-blue-tools')
        setIsAbsoluteToolsPath(false)
        setToolsSavePath('nai-blue-tools', false)
        toast({ title: t('settingsPage.saved'), variant: 'success' })
    }

    // Library path handlers
    const handleSaveLibraryPath = () => {
        setLibraryPath(localLibraryPath, isAbsoluteLibraryPath)
        toast({ title: t('settingsPage.saved'), variant: 'success' })
    }

    const handleBrowseLibraryFolder = async () => {
        try {
            const selected = await openNativeFileDialog({
                directory: true,
                multiple: false,
                title: t('settingsPage.library.selectFolder', 'Select Library Folder'),
            })
            if (selected && typeof selected === 'string') {
                setLocalLibraryPath(selected)
                setIsAbsoluteLibraryPath(true)
            }
        } catch (e) {
            console.error('Folder selection failed:', e)
        }
    }

    const handleResetLibraryToDefault = async () => {
        setLocalLibraryPath('NAI_Blue_Library')
        setIsAbsoluteLibraryPath(false)
        setLibraryPath('NAI_Blue_Library', false)
        toast({ title: t('settingsPage.saved'), variant: 'success' })
    }
    
    // 백업 내보내기
    const handleExportBackup = async () => {
        setIsExporting(true)
        try {
            const backup = await createCurrentBackupEnvelopeV3({ purpose: 'manual-full' })
            const storeCount = backup.storeManifest.storeCount
            
            // 파일 저장 다이얼로그
            const filePath = await saveNativeFileDialog({
                title: t('settingsPage.backup.export'),
                defaultPath: `nai-blue-backup-${new Date().toISOString().split('T')[0]}.json`,
                filters: [{ name: 'JSON', extensions: ['json'] }]
            })
            
            if (filePath) {
                await writeNativeTextFile(filePath, JSON.stringify(backup, null, 2))
                
                // 마지막 백업 시간 저장
                const now = new Date().toISOString()
                localStorage.setItem('nai-blue-last-backup-time', now)
                setLastBackupTime(now)
                
                toast({
                    title: t('settingsPage.backup.exported'),
                    description: t('settingsPage.backup.exportedDesc', { count: storeCount }),
                    variant: 'success',
                })
            }
        } catch (err) {
            console.error('Backup export failed:', err)
            toast({
                title: t('settingsPage.backup.exportFailed'),
                description: String(err),
                variant: 'destructive',
            })
        } finally {
            setIsExporting(false)
        }
    }
    
    // Both desktop and mobile readers feed this single verifier so every
    // restore path gets the same schema checks and in-app confirmation.
    const prepareImportedBackup = (content: string) => {
        const backup = JSON.parse(content) as unknown
        const prepared = prepareBackupRestore(backup)

        if (!prepared.report.canRestore) {
            toast({
                title: t('settingsPage.backup.importFailed'),
                description: prepared.report.errors
                    .map(issue => `${issue.code}: ${issue.message}`)
                    .join('\n') || t('settingsPage.backup.invalidFile'),
                variant: 'destructive',
            })
            return
        }

        setPendingBackupRestore(prepared)
    }

    // Desktop uses the native Tauri path. Android delegates the selected
    // document to WebView's File API because content-URI reads can stall in
    // the filesystem plugin on vendor DocumentsUI implementations.
    const handleImportBackup = async () => {
        if (isMobileRuntime) {
            backupFileInputRef.current?.click()
            return
        }

        setIsImporting(true)
        try {
            // 파일 선택 다이얼로그
            const filePath = await openNativeFileDialog({
                title: t('settingsPage.backup.import'),
                filters: [{ name: 'JSON', extensions: ['json'] }],
                multiple: false,
            })
            
            if (!filePath || typeof filePath !== 'string') return
            
            const content = await readNativeTextFile(filePath)
            prepareImportedBackup(content)
        } catch (err) {
            console.error('Backup import failed:', err)
            toast({
                title: t('settingsPage.backup.importFailed'),
                description: String(err),
                variant: 'destructive',
            })
        } finally {
            setIsImporting(false)
        }
    }

    const handleMobileBackupFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget
        const file = input.files?.[0]
        input.value = ''
        if (!file) return

        setIsImporting(true)
        try {
            prepareImportedBackup(await file.text())
        } catch (err) {
            console.error('Mobile backup import failed:', err)
            toast({
                title: t('settingsPage.backup.importFailed'),
                description: String(err),
                variant: 'destructive',
            })
        } finally {
            setIsImporting(false)
        }
    }

    const describePreparedRestore = (prepared: PreparedBackupRestore) => [
        t('settingsPage.backup.confirmRestoreDesc'),
        '',
        `Dry run: ${prepared.report.restoreKeys.length} store(s) ready, ${prepared.report.ignoredKeys.length} ignored`,
        ...prepared.report.ignoredKeys.slice(0, 5).map(item => `- ${item.key} (${item.reason})`),
        prepared.report.ignoredKeys.length > 5
            ? `- +${prepared.report.ignoredKeys.length - 5} more`
            : '',
        prepared.report.credentialReentryRequired
            ? t('settingsPage.backup.credentialReentryRequired')
            : '',
        t('settingsPage.backup.restoreWarning'),
    ].filter(Boolean).join('\n')

    /**
     * Applies only the detached payload produced by prepareBackupRestore,
     * then relaunches so hydrated stores cannot overwrite verified data.
     */
    const applyPreparedBackupRestore = async () => {
        const prepared = pendingBackupRestore
        if (!prepared) return

        setIsImporting(true)
        try {
            const assetPreimage = prepared.assetProfileJson === undefined
                ? undefined
                : await loadRawAssetProfileFile()
            const result = await importAllData(prepared.restorePayload, true, {
                ...(prepared.assetProfileJson === undefined
                    ? {}
                    : {
                        finalizeKey: ASSET_PROFILE_FILE_RESTORE_KEY,
                        finalizeRestore: () => restoreRawAssetProfileFile(prepared.assetProfileJson!),
                        rollbackFinalize: () => restoreRawAssetProfileFilePreimage(assetPreimage!),
                    }),
            })
            if (result.failed.length > 0) {
                throw new Error(`Restore verification failed for: ${result.failed.join(', ')}`)
            }

            toast({
                title: t('settingsPage.backup.imported'),
                description: t('settingsPage.backup.importedDesc', { success: result.success.length }),
                variant: 'success',
            })

            setPendingBackupRestore(null)

            // 앱 재시작
            setTimeout(() => {
                void relaunchApplication()
            }, 1500)
            
        } catch (err) {
            console.error('Backup import failed:', err)
            toast({
                title: t('settingsPage.backup.importFailed'),
                description: String(err),
                variant: 'destructive',
            })
        } finally {
            setIsImporting(false)
        }
    }

    const handleCreateAutoBackupNow = async () => {
        setIsCreatingAutoBackup(true)
        try {
            const result = await createFullAutoBackup({ force: true })
            if (result.status === 'created') {
                const exportedAt = result.entry.exportedAt ?? new Date().toISOString()
                setLastAutoBackupTime(exportedAt)
                toast({
                    title: t('settingsPage.backup.snapshotCreated'),
                    description: t('settingsPage.backup.snapshotCreatedDesc', { count: result.storeCount }),
                    variant: 'success',
                })
                return
            }

            toast({
                title: t('settingsPage.backup.snapshotSkipped'),
                description: t(`settingsPage.backup.snapshotSkipped.${result.reason}`, { defaultValue: result.reason }),
            })
        } catch (err) {
            console.error('Disk auto-backup failed:', err)
            toast({
                title: t('settingsPage.backup.exportFailed'),
                description: String(err),
                variant: 'destructive',
            })
        } finally {
            setIsCreatingAutoBackup(false)
        }
    }
    
    // 데이터 크기 포맷팅
    const formatSize = (bytes: number) => {
        if (bytes < 0) return 'Error'
        if (bytes === 0) return '0 B'
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    }
    
    const totalSize = Object.values(storeSizes).reduce((sum, size) => sum + (size > 0 ? size : 0), 0)

    return (
        <div className={cn(
            'flex min-h-0 flex-col overflow-hidden bg-canvas lg:flex-row',
            guidedSection ? 'min-h-full' : 'h-full',
        )}>
            {/* Phones use one compact selector so settings content begins inside the first viewport. */}
            {!guidedSection && <header className="shrink-0 bg-card px-3 py-2 lg:hidden">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <h1 className="shrink-0 text-lg font-semibold sm:mr-auto">{t('settingsPage.title')}</h1>
                    <div className="flex min-w-0 items-center gap-2">
                        <Select value={activeSection} onValueChange={(value) => selectSection(value as SettingsSection)}>
                            <SelectTrigger className="min-w-0 flex-1 sm:w-64 sm:flex-none" aria-label={t('settingsPage.title')}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SECTIONS.map((section) => (
                                    <SelectItem key={section.id} value={section.id}>
                                        {t(section.labelKey)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </header>}

            {!guidedSection && <aside className="hidden w-56 shrink-0 flex-col bg-card p-3 lg:flex">
                <h2 className="mb-3 px-2 text-lg font-semibold">{t('settingsPage.title')}</h2>
                <nav className="space-y-1" aria-label={t('settingsPage.title')}>
                    {SECTIONS.map((section) => (
                        <button
                            key={section.id}
                            type="button"
                            onClick={() => selectSection(section.id)}
                            aria-current={activeSection === section.id ? 'page' : undefined}
                            className={cn(
                                'flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                activeSection === section.id
                                    ? 'bg-primary/10 text-primary'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                            )}
                        >
                            <section.icon className="h-4 w-4" />
                            {t(section.labelKey)}
                        </button>
                    ))}
                </nav>
            </aside>}

            {/* The content pane owns scrolling; the shell and mobile selector remain stable. */}
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-4 lg:p-6">
                <div className="mx-auto max-w-4xl space-y-6">
                    {/* General Section */}
                    {activeSection === 'general' && (
                        <section className="space-y-4">
                            <div>
                                <h3 className="text-lg font-semibold">{t('settingsPage.sections.general')}</h3>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('settingsPage.language.description')}
                                </p>
                            </div>
                            <div className="space-y-5 rounded-panel bg-card p-5">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="space-y-0.5">
                                        <label className="text-sm font-medium flex items-center gap-2">
                                            <Languages className="h-4 w-4 text-muted-foreground" />
                                            {t('settingsPage.language.select')}
                                        </label>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.language.description')}
                                        </p>
                                    </div>
                                    <Select value={i18n.language} onValueChange={(v) => i18n.changeLanguage(v)}>
                                        <SelectTrigger className="w-full sm:w-40">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {LANGUAGES.map((lang) => (
                                                <SelectItem key={lang.code} value={lang.code}>
                                                    {lang.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                {/* Streaming Toggle */}
                                <div className="flex items-center justify-between pt-4">
                                    <div className="space-y-0.5">
                                        <label className="text-sm font-medium flex items-center gap-2">
                                            <Zap className="h-4 w-4 text-warning" />
                                            {t('settingsPage.streaming.title', 'Streaming Generation')}
                                        </label>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.streaming.description', 'Show real-time progress during image generation')}
                                        </p>
                                    </div>
                                    <Switch
                                        checked={useStreaming}
                                        onChange={(e) => setUseStreaming(e.target.checked)}
                                    />
                                </div>

                                {/* Generation Delay */}
                                <div className="space-y-3 pt-4">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium flex items-center gap-2">
                                            <Timer className="h-4 w-4 text-info" />
                                            {t('settingsPage.generationDelay.title', 'Generation Delay')}
                                        </label>
                                        <span className="text-sm text-muted-foreground">{generationDelay}ms</span>
                                    </div>
                                    <Slider
                                        value={[generationDelay]}
                                        onValueChange={([v]) => setGenerationDelay(v)}
                                        min={0}
                                        max={5000}
                                        step={100}
                                        className="w-full"
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        {t('settingsPage.generationDelay.description', 'Delay between batch image generations to avoid API rate limits.')}
                                    </p>
                                </div>

                                {/* Version Info */}
                                <div className="space-y-4 pt-4">
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="space-y-0.5">
                                            <label className="text-sm font-medium flex items-center gap-2">
                                                <Info className="h-4 w-4 text-info" />
                                                {t('settingsPage.version.title', 'Version')}
                                            </label>
                                            <p className="text-xs text-muted-foreground">
                                                NAI Blue v{appVersion}
                                            </p>
                                        </div>
                                        {!isMobileRuntime && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={async () => {
                                                setIsCheckingUpdate(true)
                                                try {
                                                    const update = await checkForNativeUpdate()
                                                    if (update) {
                                                        // Store the update object
                                                        setCurrentUpdateObject(update)

                                                        // Check if already downloaded
                                                        if (pendingUpdate && pendingUpdate.version === update.version) {
                                                            toast({
                                                                title: t('update.readyToInstall', '업데이트 설치 준비됨'),
                                                                description: t('update.version', { version: update.version }),
                                                            })
                                                        } else {
                                                            toast({
                                                                title: t('update.available', '업데이트 사용 가능'),
                                                                description: t('update.version', { version: update.version }),
                                                                action: (
                                                                    <Button
                                                                        size="sm"
                                                                        onClick={async () => {
                                                                            setIsDownloading(true)
                                                                            toast({ title: t('update.downloading', '다운로드 중...'), description: t('update.pleaseWait', '잠시만 기다려주세요') })
                                                                            try {
                                                                                let totalBytes = 0
                                                                                let downloadedBytes = 0
                                                                                await update.download((event) => {
                                                                                    if (event.event === 'Started' && event.data.contentLength) {
                                                                                        totalBytes = event.data.contentLength
                                                                                    } else if (event.event === 'Progress') {
                                                                                        downloadedBytes += event.data.chunkLength
                                                                                        if (totalBytes > 0) {
                                                                                            setDownloadProgress(Math.round((downloadedBytes / totalBytes) * 100))
                                                                                        }
                                                                                    }
                                                                                })
                                                                                setPendingUpdate({ version: update.version, downloadedAt: Date.now() })
                                                                                toast({
                                                                                    title: t('update.downloadComplete', '다운로드 완료'),
                                                                                    description: t('update.readyToInstallDesc', '작업을 저장한 후 설치하세요.'),
                                                                                    action: (
                                                                                        <Button
                                                                                            size="sm"
                                                                                            onClick={async () => {
                                                                                                await update.install()
                                                                                                await relaunchApplication()
                                                                                            }}
                                                                                        >
                                                                                            <Sparkles className="h-4 w-4 mr-1" />
                                                                                            {t('update.installNow', '지금 설치')}
                                                                                        </Button>
                                                                                    ),
                                                                                })
                                                                            } catch (e) {
                                                                                toast({ title: t('update.failed', '다운로드 실패'), variant: 'destructive' })
                                                                            } finally {
                                                                                setIsDownloading(false)
                                                                            }
                                                                        }}
                                                                        disabled={isDownloading}
                                                                    >
                                                                        {isDownloading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                                                    </Button>
                                                                ),
                                                            })
                                                        }
                                                    } else {
                                                        toast({ title: t('update.upToDate', '최신 버전입니다'), variant: 'success' })
                                                    }
                                                } catch (e) {
                                                    toast({ title: t('update.checkFailed', '업데이트 확인 실패'), variant: 'destructive' })
                                                } finally {
                                                    setIsCheckingUpdate(false)
                                                }
                                                }}
                                                disabled={isCheckingUpdate}
                                            >
                                                {isCheckingUpdate ? (
                                                    <RefreshCw className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <>
                                                        <RefreshCw className="h-4 w-4 mr-2" />
                                                        {t('settingsPage.version.checkUpdate', 'Check for Updates')}
                                                    </>
                                                )}
                                            </Button>
                                        )}
                                    </div>

                                    {/* Pending Update Install Section - only show if pending version is newer */}
                                    {!isMobileRuntime && pendingUpdate && appVersion && (() => {
                                        // Compare versions
                                        const current = appVersion.replace(/^v/, '').split('.').map(Number)
                                        const pending = pendingUpdate.version.replace(/^v/, '').split('.').map(Number)
                                        let isNewer = false
                                        for (let i = 0; i < Math.max(current.length, pending.length); i++) {
                                            const c = current[i] || 0
                                            const p = pending[i] || 0
                                            if (p > c) { isNewer = true; break }
                                            if (p < c) break
                                        }
                                        if (!isNewer) return null
                                        return (
                                            <div className="flex flex-col gap-3 rounded-control bg-success/10 p-3 sm:flex-row sm:items-center sm:justify-between">
                                                <div className="flex items-center gap-2">
                                                    <Sparkles className="h-4 w-4 text-success" />
                                                    <div>
                                                        <p className="text-sm font-medium text-success">
                                                            {t('update.readyToInstall', '업데이트 설치 준비됨')}
                                                        </p>
                                                        <p className="text-xs text-muted-foreground">
                                                            v{pendingUpdate.version}
                                                        </p>
                                                    </div>
                                                </div>
                                                <Button
                                                    size="sm"
                                                    onClick={async () => {
                                                        try {
                                                            toast({ title: t('update.installing', '설치 중...'), description: t('update.pleaseWait', '잠시만 기다려주세요') })
                                                            await installPendingUpdate()
                                                        } catch (e) {
                                                            console.error('Install failed:', e)
                                                            toast({ title: t('update.failed', '설치 실패'), description: String(e), variant: 'destructive' })
                                                        }
                                                    }}
                                                >
                                                    <Sparkles className="h-4 w-4 mr-1" />
                                                    {t('update.installNow', '지금 설치')}
                                                </Button>
                                            </div>
                                        )
                                    })()}
                                </div>
                            </div>
                        </section>
                    )}

                    {/* Appearance Section */}
                    {activeSection === 'appearance' && (
                        <section className="space-y-4">
                            <div>
                                <h3 className="text-lg font-semibold">{t('settingsPage.sections.appearance')}</h3>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('settingsPage.theme.description')}
                                </p>
                            </div>
                            <div className="space-y-5 rounded-panel bg-card p-5">
                                <div className="space-y-3">
                                    <label className="text-sm font-medium">{t('settingsPage.theme.mode')}</label>
                                    <div className="grid grid-cols-3 gap-3">
                                        {[
                                            { value: 'light' as const, icon: Sun, labelKey: 'settingsPage.theme.light' },
                                            { value: 'dark' as const, icon: Moon, labelKey: 'settingsPage.theme.dark' },
                                            { value: 'system' as const, icon: Monitor, labelKey: 'settingsPage.theme.system' },
                                        ].map((option) => (
                                            <button
                                                key={option.value}
                                                type="button"
                                                onClick={() => setTheme(option.value)}
                                                aria-pressed={theme === option.value}
                                                className={cn(
                                                    'flex min-h-11 flex-col items-center gap-2 rounded-control p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                                    theme === option.value
                                                        ? 'bg-accent text-accent-foreground'
                                                        : 'bg-muted/30 hover:bg-muted/60'
                                                )}
                                            >
                                                {/** Theme selection remains a real button so keyboard and assistive-tech state match the visual state. */}
                                                <option.icon className={cn(
                                                    'h-6 w-6',
                                                    theme === option.value ? 'text-primary' : 'text-muted-foreground'
                                                )} />
                                                <span className={cn(
                                                    'text-sm font-medium',
                                                    theme === option.value ? 'text-primary' : 'text-muted-foreground'
                                                )}>
                                                    {t(option.labelKey)}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium flex items-center gap-2">
                                            <Type className="h-4 w-4" />
                                            {t('settingsPage.theme.fontSize', 'Prompt Font Size')}
                                        </label>
                                        <span className="text-sm text-muted-foreground">{promptFontSize}px</span>
                                    </div>
                                    <Slider
                                        value={[promptFontSize]}
                                        onValueChange={([v]) => setPromptFontSize(v)}
                                        min={12}
                                        max={24}
                                        step={1}
                                        className="w-full"
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        {t('settingsPage.theme.fontSizeHelp', 'Adjust the font size of the prompt input areas.')}
                                    </p>
                                </div>
                            </div>
                        </section>
                    )}

                    {/* API Section */}
                    {activeSection === 'api' && (
                        <section className="space-y-4">
                            <div>
                                <h3 className="text-lg font-semibold">{t('settingsPage.sections.api')}</h3>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('settingsPage.api.description')}
                                </p>
                            </div>

                            <ApiTokenSettingsCard />

                            <div className="space-y-5 rounded-panel bg-card p-5">
                                <div className="space-y-2 pt-4">
                                    <label className="text-sm font-medium flex items-center gap-2">
                                        <img src={GeminiIcon} alt="Gemini" className="h-4 w-4" />
                                        {t('settingsPage.api.geminiKey', 'Gemini API Key')}
                                    </label>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            type="password"
                                            placeholder={t('settingsPage.api.geminiKeyPlaceholder', 'AIza...')}
                                            value={localGeminiKey}
                                            onChange={(e) => setLocalGeminiKey(e.target.value)}
                                            className="flex-1"
                                        />
                                        <Button
                                            onClick={() => {
                                                setGeminiApiKey(localGeminiKey)
                                                toast({ title: t('settingsPage.saved'), variant: 'success' })
                                            }}
                                        >
                                            {t('settingsPage.saveBtn')}
                                        </Button>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {t('settingsPage.api.geminiKeyHelp', 'Get your API key from Google AI Studio')}
                                    </p>
                                </div>
                            </div>
                        </section>
                    )}

                    {/* Storage Section */}
                    {activeSection === 'storage' && (
                        <section className="space-y-4">
                            <div>
                                <h3 className="text-lg font-semibold">{t('settingsPage.sections.storage')}</h3>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('settingsPage.save.description')}
                                </p>
                            </div>
                            <div className="space-y-5 rounded-panel bg-card p-5">
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium">{t('settingsPage.save.outputFolders.main.label', 'Main Output Folder')}</label>
                                        {isAbsolutePath && (
                                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                                                {t('settingsPage.save.customPath', 'Custom Path')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={localSavePath}
                                            onChange={(e) => {
                                                setLocalSavePath(e.target.value)
                                                setIsAbsolutePath(isAbsoluteFolderPath(e.target.value))
                                            }}
                                            placeholder="NAI_Blue_Output"
                                            className="flex-1"
                                        />
                                        <Button variant="outline" onClick={handleBrowseFolder}>
                                            <FolderOpen className="h-4 w-4 mr-2" />
                                            {t('settingsPage.save.browse', 'Browse')}
                                        </Button>
                                        <Button
                                            onClick={handleSavePath}
                                            variant={(localSavePath !== savePath || isAbsolutePath !== useAbsolutePath) ? "default" : "outline"}
                                            className={(localSavePath !== savePath || isAbsolutePath !== useAbsolutePath)
                                                ? "bg-primary text-primary-foreground"
                                                : ""}
                                        >
                                            <Save className="h-4 w-4 mr-2" />
                                            {t('settingsPage.saveBtn')}
                                        </Button>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs text-muted-foreground">
                                            {isAbsolutePath
                                                ? t('settingsPage.save.absolutePathHelp', 'Images will be saved to this exact folder.')
                                                : t('settingsPage.save.outputFolders.main.help', 'Default: Pictures/NAI_Blue_Output')}
                                        </p>
                                        {isAbsolutePath && (
                                            <Button variant="ghost" size="sm" onClick={handleResetToDefault} className="h-11 shrink-0 text-xs">
                                                <RotateCcw className="h-3 w-3 mr-1" />
                                                {t('settingsPage.save.resetDefault', 'Reset to Default')}
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-3 pt-4">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium">{t('settingsPage.save.outputFolders.scene.label', 'Scene Folder')}</label>
                                        {isAbsoluteScenePath && (
                                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                                                {t('settingsPage.save.customPath', 'Custom Path')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={localSceneSavePath}
                                            onChange={(e) => {
                                                setLocalSceneSavePath(e.target.value)
                                                setIsAbsoluteScenePath(isAbsoluteFolderPath(e.target.value))
                                            }}
                                            placeholder="NAI_Blue_Scene"
                                            className="flex-1"
                                        />
                                        <Button variant="outline" onClick={handleBrowseSceneFolder}>
                                            <FolderOpen className="h-4 w-4 mr-2" />
                                            {t('settingsPage.save.browse', 'Browse')}
                                        </Button>
                                        <Button
                                            onClick={handleSaveScenePath}
                                            variant={(localSceneSavePath !== sceneSavePath || isAbsoluteScenePath !== useAbsoluteScenePath) ? "default" : "outline"}
                                        >
                                            <Save className="h-4 w-4 mr-2" />
                                            {t('settingsPage.saveBtn')}
                                        </Button>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs text-muted-foreground">
                                            {isAbsoluteScenePath
                                                ? t('settingsPage.save.absolutePathHelp', 'Images will be saved to this exact folder.')
                                                : t('settingsPage.save.outputFolders.scene.help', 'Default: Pictures/NAI_Blue_Scene')}
                                        </p>
                                        {isAbsoluteScenePath && (
                                            <Button variant="ghost" size="sm" onClick={handleResetSceneToDefault} className="h-11 shrink-0 text-xs">
                                                <RotateCcw className="h-3 w-3 mr-1" />
                                                {t('settingsPage.save.resetDefault', 'Reset to Default')}
                                            </Button>
                                        )}
                                    </div>
                                    <div className="flex items-center justify-between gap-4 rounded-control border border-border/60 p-3">
                                        <div className="space-y-0.5">
                                            <label htmlFor="scene-subfolders" className="text-sm font-medium">
                                                {t('settingsPage.save.outputFolders.scene.subfolders', 'Create a folder for each Scene')}
                                            </label>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settingsPage.save.outputFolders.scene.subfoldersHelp', 'Turn this off to save every Scene result directly in its parent folder.')}
                                            </p>
                                        </div>
                                        <Switch
                                            id="scene-subfolders"
                                            checked={sceneSubfoldersEnabled}
                                            onChange={(event) => setSceneSubfoldersEnabled(event.target.checked)}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-3 pt-4">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium">{t('settingsPage.save.outputFolders.styleLab.label', 'Style Lab Folder')}</label>
                                        {isAbsoluteStyleLabPath && (
                                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                                                {t('settingsPage.save.customPath', 'Custom Path')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={localStyleLabSavePath}
                                            onChange={(e) => {
                                                setLocalStyleLabSavePath(e.target.value)
                                                setIsAbsoluteStyleLabPath(isAbsoluteFolderPath(e.target.value))
                                            }}
                                            placeholder="nai-blue-style"
                                            className="flex-1"
                                        />
                                        <Button variant="outline" onClick={handleBrowseStyleLabFolder}>
                                            <FolderOpen className="h-4 w-4 mr-2" />
                                            {t('settingsPage.save.browse', 'Browse')}
                                        </Button>
                                        <Button
                                            onClick={handleSaveStyleLabPath}
                                            variant={(localStyleLabSavePath !== styleLabSavePath || isAbsoluteStyleLabPath !== useAbsoluteStyleLabPath) ? "default" : "outline"}
                                        >
                                            <Save className="h-4 w-4 mr-2" />
                                            {t('settingsPage.saveBtn')}
                                        </Button>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs text-muted-foreground">
                                            {isAbsoluteStyleLabPath
                                                ? t('settingsPage.save.absolutePathHelp', 'Images will be saved to this exact folder.')
                                                : t('settingsPage.save.outputFolders.styleLab.help', 'Default: Pictures/nai-blue-style')}
                                        </p>
                                        {isAbsoluteStyleLabPath && (
                                            <Button variant="ghost" size="sm" onClick={handleResetStyleLabToDefault} className="h-11 shrink-0 text-xs">
                                                <RotateCcw className="h-3 w-3 mr-1" />
                                                {t('settingsPage.save.resetDefault', 'Reset to Default')}
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-3 pt-4">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium">{t('settingsPage.save.outputFolders.tools.label', 'Tools Folder')}</label>
                                        {isAbsoluteToolsPath && (
                                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                                                {t('settingsPage.save.customPath', 'Custom Path')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={localToolsSavePath}
                                            onChange={(e) => {
                                                setLocalToolsSavePath(e.target.value)
                                                setIsAbsoluteToolsPath(isAbsoluteFolderPath(e.target.value))
                                            }}
                                            placeholder="nai-blue-tools"
                                            className="flex-1"
                                        />
                                        <Button variant="outline" onClick={handleBrowseToolsFolder}>
                                            <FolderOpen className="h-4 w-4 mr-2" />
                                            {t('settingsPage.save.browse', 'Browse')}
                                        </Button>
                                        <Button
                                            onClick={handleSaveToolsPath}
                                            variant={(localToolsSavePath !== toolsSavePath || isAbsoluteToolsPath !== useAbsoluteToolsPath) ? "default" : "outline"}
                                        >
                                            <Save className="h-4 w-4 mr-2" />
                                            {t('settingsPage.saveBtn')}
                                        </Button>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs text-muted-foreground">
                                            {isAbsoluteToolsPath
                                                ? t('settingsPage.save.absolutePathHelp', 'Images will be saved to this exact folder.')
                                                : t('settingsPage.save.outputFolders.tools.help', 'Default: Pictures/nai-blue-tools')}
                                        </p>
                                        {isAbsoluteToolsPath && (
                                            <Button variant="ghost" size="sm" onClick={handleResetToolsToDefault} className="h-11 shrink-0 text-xs">
                                                <RotateCcw className="h-3 w-3 mr-1" />
                                                {t('settingsPage.save.resetDefault', 'Reset to Default')}
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center justify-between pt-4">
                                    <div className="space-y-0.5">
                                        <label className="text-sm font-medium">{t('settingsPage.save.autoSave')}</label>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.save.autoSaveHelp')}
                                        </p>
                                    </div>
                                    <Switch
                                        checked={autoSave}
                                        onChange={(e) => setAutoSave(e.target.checked)}
                                    />
                                </div>
                            </div>

                            {/* Library Path Setting */}
                            <div className="space-y-5 rounded-panel bg-card p-5">
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium">{t('settingsPage.library.folder', 'Library Folder')}</label>
                                        {isAbsoluteLibraryPath && (
                                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                                                {t('settingsPage.save.customPath', 'Custom Path')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={localLibraryPath}
                                            onChange={(e) => {
                                                setLocalLibraryPath(e.target.value)
                                                setIsAbsoluteLibraryPath(isAbsoluteFolderPath(e.target.value))
                                            }}
                                            placeholder="NAI_Blue_Library"
                                            className="flex-1"
                                        />
                                        <Button variant="outline" onClick={handleBrowseLibraryFolder}>
                                            <FolderOpen className="h-4 w-4 mr-2" />
                                            {t('settingsPage.save.browse', 'Browse')}
                                        </Button>
                                        <Button
                                            onClick={handleSaveLibraryPath}
                                            variant={(localLibraryPath !== libraryPath || isAbsoluteLibraryPath !== useAbsoluteLibraryPath) ? "default" : "outline"}
                                            className={(localLibraryPath !== libraryPath || isAbsoluteLibraryPath !== useAbsoluteLibraryPath)
                                                ? "bg-primary text-primary-foreground"
                                                : ""}
                                        >
                                            <Save className="h-4 w-4 mr-2" />
                                            {t('settingsPage.saveBtn')}
                                        </Button>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs text-muted-foreground">
                                            {isAbsoluteLibraryPath
                                                ? t('settingsPage.library.absolutePathHelp', 'Library files will be saved to this exact folder.')
                                                : t('settingsPage.library.folderHelp', 'Default: Pictures/NAI_Blue_Library')}
                                        </p>
                                        {isAbsoluteLibraryPath && (
                                            <Button variant="ghost" size="sm" onClick={handleResetLibraryToDefault} className="h-11 shrink-0 text-xs">
                                                <RotateCcw className="h-3 w-3 mr-1" />
                                                {t('settingsPage.save.resetDefault', 'Reset to Default')}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Image Format Setting */}
                            <div className="space-y-4 rounded-panel bg-card p-5">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="space-y-0.5">
                                        <label className="text-sm font-medium">{t('settingsPage.save.imageFormat.title', 'Image Format')}</label>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.save.imageFormat.description', 'Choose the format for generated images.')}
                                        </p>
                                    </div>
                                    <Select value={imageFormat} onValueChange={(value: 'png' | 'webp') => setImageFormat(value)}>
                                        <SelectTrigger className="w-32">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="png">PNG</SelectItem>
                                            <SelectItem value="webp">WebP</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {t('settingsPage.save.imageFormat.help', 'WebP offers smaller file sizes with similar quality. PNG provides lossless quality.')}
                                </p>
                            </div>

                            {/* This global policy feeds Main, Scene, and Style Lab output writers. */}
                            <div className="space-y-4 rounded-panel bg-card p-5">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="space-y-0.5">
                                        <label className="text-sm font-medium">{t('settingsPage.save.metadataMode.title')}</label>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.save.metadataMode.description')}
                                        </p>
                                    </div>
                                    <Select value={metadataMode} onValueChange={(value: typeof metadataMode) => setMetadataMode(value)}>
                                        <SelectTrigger className="w-full sm:w-64">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="embedded">{t('settingsPage.save.metadataMode.embedded')}</SelectItem>
                                            <SelectItem value="sidecar-only">{t('settingsPage.save.metadataMode.sidecarOnly')}</SelectItem>
                                            <SelectItem value="strip-and-sidecar">{t('settingsPage.save.metadataMode.stripAndSidecar')}</SelectItem>
                                            <SelectItem value="strip-only">{t('settingsPage.save.metadataMode.stripOnly')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {t('settingsPage.save.metadataMode.help')}
                                </p>
                            </div>
                        </section>
                    )}

                    {/* Shortcuts Section */}
                    {activeSection === 'shortcuts' && (
                        <section className="space-y-4">
                            <div>
                                <h2 className="text-lg font-semibold">{t('settingsPage.shortcuts.title', '단축키')}</h2>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('settingsPage.shortcuts.description', '전역 단축키를 설정합니다.')}
                                </p>
                            </div>

                            {/* Enable/Disable Shortcuts */}
                            <div className="rounded-panel bg-card p-5">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <label className="text-sm font-medium">{t('settingsPage.shortcuts.enable', '단축키 활성화')}</label>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            {t('settingsPage.shortcuts.enableHelp', '전역 단축키를 활성화하거나 비활성화합니다.')}
                                        </p>
                                    </div>
                                    <Switch
                                        checked={shortcutsEnabled}
                                        onChange={(e) => setShortcutsEnabled(e.target.checked)}
                                    />
                                </div>
                            </div>

                            {/* Shortcut Bindings */}
                            <div className="space-y-4 rounded-panel bg-card p-5">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-sm font-medium">{t('settingsPage.shortcuts.bindings', '키 바인딩')}</h3>
                                    <Button variant="ghost" size="sm" className="h-11" onClick={resetAllBindings}>
                                        <RotateCcw className="h-3 w-3 mr-1" />
                                        {t('settingsPage.shortcuts.resetAll', '전체 초기화')}
                                    </Button>
                                </div>

                                {/* Navigation */}
                                <div className="space-y-2">
                                    <h4 className="text-xs text-muted-foreground uppercase tracking-wider">
                                        {t('settingsPage.shortcuts.navigation', '네비게이션')}
                                    </h4>
                                    {SHORTCUT_ACTIONS.filter(a => a.category === 'navigation').map(({ action }) => (
                                        <ShortcutRow
                                            key={action}
                                            action={action}
                                            binding={bindings[action]}
                                            allBindings={bindings}
                                            isEditing={editingAction === action}
                                            recordedBinding={editingAction === action ? recordedBinding : null}
                                            onStartEdit={() => {
                                                setEditingAction(action)
                                                setRecordedBinding(null)
                                            }}
                                            onSave={(binding) => {
                                                setBinding(action, binding)
                                                setEditingAction(null)
                                                setRecordedBinding(null)
                                            }}
                                            onCancel={() => {
                                                setEditingAction(null)
                                                setRecordedBinding(null)
                                            }}
                                            onReset={() => resetBinding(action)}
                                            onKeyRecord={setRecordedBinding}
                                            t={t}
                                        />
                                    ))}
                                </div>

                                {/* Dialogs */}
                                <div className="space-y-2">
                                    <h4 className="text-xs text-muted-foreground uppercase tracking-wider">
                                        {t('settingsPage.shortcuts.dialogs', '다이얼로그')}
                                    </h4>
                                    {SHORTCUT_ACTIONS.filter(a => a.category === 'dialog').map(({ action }) => (
                                        <ShortcutRow
                                            key={action}
                                            action={action}
                                            binding={bindings[action]}
                                            allBindings={bindings}
                                            isEditing={editingAction === action}
                                            recordedBinding={editingAction === action ? recordedBinding : null}
                                            onStartEdit={() => {
                                                setEditingAction(action)
                                                setRecordedBinding(null)
                                            }}
                                            onSave={(binding) => {
                                                setBinding(action, binding)
                                                setEditingAction(null)
                                                setRecordedBinding(null)
                                            }}
                                            onCancel={() => {
                                                setEditingAction(null)
                                                setRecordedBinding(null)
                                            }}
                                            onReset={() => resetBinding(action)}
                                            onKeyRecord={setRecordedBinding}
                                            t={t}
                                        />
                                    ))}
                                </div>

                                {/* Actions */}
                                <div className="space-y-2">
                                    <h4 className="text-xs text-muted-foreground uppercase tracking-wider">
                                        {t('settingsPage.shortcuts.actions', '액션')}
                                    </h4>
                                    {SHORTCUT_ACTIONS.filter(a => a.category === 'action').map(({ action }) => (
                                        <ShortcutRow
                                            key={action}
                                            action={action}
                                            binding={bindings[action]}
                                            allBindings={bindings}
                                            isEditing={editingAction === action}
                                            recordedBinding={editingAction === action ? recordedBinding : null}
                                            onStartEdit={() => {
                                                setEditingAction(action)
                                                setRecordedBinding(null)
                                            }}
                                            onSave={(binding) => {
                                                setBinding(action, binding)
                                                setEditingAction(null)
                                                setRecordedBinding(null)
                                            }}
                                            onCancel={() => {
                                                setEditingAction(null)
                                                setRecordedBinding(null)
                                            }}
                                            onReset={() => resetBinding(action)}
                                            onKeyRecord={setRecordedBinding}
                                            t={t}
                                        />
                                    ))}
                                </div>
                            </div>
                        </section>
                    )}
                    
                    {/* Backup Section */}
                    {activeSection === 'backup' && (
                        <section className="space-y-4">
                            <div>
                                <h3 className="text-lg font-semibold">{t('settingsPage.backup.title')}</h3>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {t('settingsPage.backup.description')}
                                </p>
                            </div>
                            
                            {/* Export/Import */}
                            <div className="space-y-5 rounded-panel bg-card p-5">
                                <div className="space-y-4">
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="space-y-1">
                                            <label className="text-sm font-medium flex items-center gap-2">
                                                <Download className="h-4 w-4 text-info" />
                                                {t('settingsPage.backup.export')}
                                            </label>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settingsPage.backup.exportDesc')}
                                            </p>
                                        </div>
                                        <Button onClick={handleExportBackup} disabled={isExporting}>
                                            {isExporting ? (
                                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                            ) : (
                                                <Download className="h-4 w-4 mr-2" />
                                            )}
                                            {isExporting ? t('settingsPage.backup.exporting') : t('settingsPage.backup.export')}
                                        </Button>
                                    </div>
                                </div>
                                
                                <div className="pt-6">
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="space-y-1">
                                            <label className="text-sm font-medium flex items-center gap-2">
                                                <Upload className="h-4 w-4 text-success" />
                                                {t('settingsPage.backup.import')}
                                            </label>
                                            <p className="text-xs text-muted-foreground">
                                                {t('settingsPage.backup.importDesc')}
                                            </p>
                                        </div>
                                        <input
                                            ref={backupFileInputRef}
                                            type="file"
                                            accept=".json,application/json"
                                            className="hidden"
                                            onChange={handleMobileBackupFile}
                                        />
                                        <Button variant="outline" onClick={handleImportBackup} disabled={isImporting}>
                                            {isImporting ? (
                                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                            ) : (
                                                <Upload className="h-4 w-4 mr-2" />
                                            )}
                                            {isImporting ? t('settingsPage.backup.importing') : t('settingsPage.backup.import')}
                                        </Button>
                                    </div>
                                </div>
                                
                                {/* Last Backup Time */}
                                {lastBackupTime && (
                                    <div className="pt-4">
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.backup.lastBackup')}: {new Date(lastBackupTime).toLocaleString()}
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Disk Auto-backup */}
                            <div className="space-y-4 rounded-panel bg-card p-5">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="space-y-1">
                                        <label className="text-sm font-medium flex items-center gap-2">
                                            <Database className="h-4 w-4 text-info" />
                                            {t('settingsPage.backup.autoSnapshotTitle')}
                                        </label>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.backup.autoSnapshotDesc')}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.backup.snapshotLocation')}
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <Button
                                            variant="outline"
                                            onClick={handleCreateAutoBackupNow}
                                            disabled={isCreatingAutoBackup}
                                        >
                                            {isCreatingAutoBackup ? (
                                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                            ) : (
                                                <Download className="h-4 w-4 mr-2" />
                                            )}
                                            {isCreatingAutoBackup
                                                ? t('settingsPage.backup.creatingSnapshot')
                                                : t('settingsPage.backup.createSnapshot')}
                                        </Button>
                                        <Button variant="outline" onClick={() => setRestoreDialogOpen(true)}>
                                            <RotateCcw className="h-4 w-4 mr-2" />
                                            {t('settingsPage.backup.restoreSnapshots')}
                                        </Button>
                                    </div>
                                </div>
                                {lastAutoBackupTime && (
                                    <p className="pt-3 text-xs text-muted-foreground">
                                        {t('settingsPage.backup.lastAutoSnapshot')}: {new Date(lastAutoBackupTime).toLocaleString()}
                                    </p>
                                )}
                            </div>

                            {/* Store Snapshots */}
                            <div className="space-y-4 rounded-panel bg-card p-5">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="space-y-1">
                                        <label className="text-sm font-medium flex items-center gap-2">
                                            <Database className="h-4 w-4 text-info" />
                                            {t('settingsPage.backup.storeSnapshotTitle')}
                                        </label>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.backup.storeSnapshotDesc')}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {t('settingsPage.backup.storeSnapshotLocation')}
                                        </p>
                                    </div>
                                    <Button variant="outline" onClick={() => setStoreSnapshotRestoreDialogOpen(true)}>
                                        <RotateCcw className="h-4 w-4 mr-2" />
                                        {t('settingsPage.backup.restoreStoreSnapshots')}
                                    </Button>
                                </div>
                            </div>
                            
                            {/* Data Sizes */}
                            <div className="space-y-4 rounded-panel bg-card p-5">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-sm font-medium flex items-center gap-2">
                                        <HardDrive className="h-4 w-4 text-muted-foreground" />
                                        {t('settingsPage.backup.sizes')}
                                    </h4>
                                    <Button 
                                        variant="ghost" 
                                        size="sm" 
                                        onClick={() => getStoreSizes().then(setStoreSizes)}
                                    >
                                        <RefreshCw className="h-3 w-3 mr-1" />
                                        {t('common.change', 'Refresh')}
                                    </Button>
                                </div>
                                
                                <div className="space-y-2 text-sm">
                                    {Object.entries(storeSizes).filter(([, size]) => size > 0).map(([key, size]) => (
                                        <div key={key} className="flex items-center justify-between py-1">
                                            <span className="text-muted-foreground">
                                                {key.replace(/^nai-blue-/, '')}
                                            </span>
                                            <span className={cn(
                                                "font-mono",
                                                size > 1024 * 1024 && "text-warning",
                                                size > 5 * 1024 * 1024 && "text-destructive"
                                            )}>
                                                {formatSize(size)}
                                            </span>
                                        </div>
                                    ))}
                                    <div className="flex items-center justify-between pt-2 font-medium">
                                        <span>{t('settingsPage.backup.totalSize')}</span>
                                        <span className="font-mono">{formatSize(totalSize)}</span>
                                    </div>
                                </div>
                            </div>
                            
                            {/* Warning */}
                            <div className="rounded-panel bg-warning/10 p-4">
                                <div className="flex gap-3">
                                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                                    <div className="text-sm text-warning">
                                        <p className="font-medium">{t('settingsPage.backup.restoreWarning')}</p>
                                        <p className="text-xs mt-1 opacity-80">
                                            {t('settingsPage.backup.confirmRestoreDesc')}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <RestoreDialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen} />
                            <StoreSnapshotRestoreDialog
                                open={storeSnapshotRestoreDialogOpen}
                                onOpenChange={setStoreSnapshotRestoreDialogOpen}
                            />
                            <ConfirmDialog
                                open={pendingBackupRestore !== null}
                                onOpenChange={(nextOpen) => {
                                    if (!nextOpen && !isImporting) setPendingBackupRestore(null)
                                }}
                                title={t('settingsPage.backup.confirmRestore')}
                                description={pendingBackupRestore
                                    ? describePreparedRestore(pendingBackupRestore)
                                    : undefined}
                                confirmText={t('settingsPage.backup.confirmRestore')}
                                cancelText={t('common.cancel')}
                                variant="destructive"
                                busy={isImporting}
                                onConfirm={applyPreparedBackupRestore}
                            />
                        </section>
                    )}
                </div>
            </div>
        </div>
    )
}

// 단축키 행 컴포넌트
interface ShortcutRowProps {
    action: ShortcutAction
    binding: KeyBinding
    allBindings: Record<ShortcutAction, KeyBinding>
    isEditing: boolean
    recordedBinding: KeyBinding | null
    onStartEdit: () => void
    onSave: (binding: KeyBinding) => void
    onCancel: () => void
    onReset: () => void
    onKeyRecord: (binding: KeyBinding) => void
    t: ReturnType<typeof useTranslation>['t']
}

function ShortcutRow({ action, binding, allBindings, isEditing, recordedBinding, onStartEdit, onSave, onCancel, onReset, onKeyRecord, t }: ShortcutRowProps) {
    const [conflictAction, setConflictAction] = useState<ShortcutAction | null>(null)

    // 충돌 체크 함수
    const checkConflict = (newBinding: KeyBinding): ShortcutAction | null => {
        for (const [otherAction, otherBinding] of Object.entries(allBindings)) {
            if (otherAction === action) continue // 자기 자신은 제외

            // 키 조합이 정확히 같은지 확인
            if (
                otherBinding.key === newBinding.key &&
                !!otherBinding.ctrl === !!newBinding.ctrl &&
                !!otherBinding.shift === !!newBinding.shift &&
                !!otherBinding.alt === !!newBinding.alt
            ) {
                return otherAction as ShortcutAction
            }
        }
        return null
    }

    const handleSave = () => {
        if (!recordedBinding) return

        const conflict = checkConflict(recordedBinding)
        if (conflict) {
            setConflictAction(conflict)
            return
        }

        onSave(recordedBinding)
        setConflictAction(null)
    }

    const handleForceOverride = () => {
        if (!recordedBinding) return
        onSave(recordedBinding)
        setConflictAction(null)
    }
    useEffect(() => {
        if (!isEditing) return

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault()
            e.stopPropagation()

            // Escape로 취소
            if (e.key === 'Escape') {
                onCancel()
                return
            }

            // 단독 modifier 키는 무시
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
                return
            }

            const newBinding: KeyBinding = {
                key: e.key,
                ctrl: e.ctrlKey || e.metaKey,
                shift: e.shiftKey,
                alt: e.altKey,
                label: '',
                description: binding.description,
            }
            newBinding.label = formatKeyBinding(newBinding)
            onKeyRecord(newBinding)
        }

        window.addEventListener('keydown', handleKeyDown, true)
        return () => window.removeEventListener('keydown', handleKeyDown, true)
    }, [isEditing, binding.description, onCancel, onKeyRecord])

    const displayBinding = recordedBinding || binding

    return (
        <div className="space-y-2">
            <div className="flex flex-col gap-2 rounded-control px-3 py-2 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm">{t(binding.description, binding.description)}</span>
                <div className="flex items-center gap-2">
                    {isEditing ? (
                        <>
                            <div className={cn(
                                "px-3 py-1.5 rounded-md text-sm font-mono min-w-[100px] text-center",
                                recordedBinding ? "bg-primary text-primary-foreground" : "bg-muted animate-pulse"
                            )}>
                                {recordedBinding ? recordedBinding.label : t('settingsPage.shortcuts.pressKey', '키 입력...')}
                            </div>
                            <Button size="sm" variant="ghost" className="h-11 w-11 px-0" onClick={onCancel} aria-label={t('common.cancel', '취소')}>
                                <X className="h-4 w-4" />
                            </Button>
                            {recordedBinding && (
                                <Button size="sm" variant="default" className="h-11 w-11 px-0" onClick={handleSave} aria-label={t('settingsPage.saveBtn')}>
                                    <Check className="h-4 w-4" />
                                </Button>
                            )}
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={onStartEdit}
                                className="min-h-11 min-w-[100px] rounded-control bg-muted px-3 text-center font-mono text-sm hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {displayBinding.label}
                            </button>
                            <Tip content={t('settingsPage.shortcuts.reset', '초기화')}>
                                <Button size="sm" variant="ghost" className="h-11 w-11 px-0" onClick={onReset} aria-label={t('settingsPage.shortcuts.reset', '초기화')}>
                                    <RotateCcw className="h-3 w-3" />
                                </Button>
                            </Tip>
                        </>
                    )}
                </div>
            </div>

            {/* 충돌 경고 */}
            {conflictAction && recordedBinding && (
                <div className="flex flex-col gap-3 rounded-control bg-destructive/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 text-sm text-destructive">
                        <Info className="h-4 w-4" />
                        <span>
                            {t('settingsPage.shortcuts.conflict', '이미 사용 중:')} {t(allBindings[conflictAction].description, allBindings[conflictAction].description)}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConflictAction(null)}
                            className="h-11 text-destructive hover:text-destructive"
                        >
                            {t('common.cancel', '취소')}
                        </Button>
                        <Button
                            size="sm"
                            variant="destructive"
                            className="h-11"
                            onClick={handleForceOverride}
                        >
                            {t('settingsPage.shortcuts.override', '덮어쓰기')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
