import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/globals.css'
import './i18n'
import { BACKUP_STORE_KEYS, migrateFromLocalStorage, initializeIndexedDB, resetIndexedDBConnectionForRetry, indexedDBStorage } from './lib/indexed-db'
import { createCurrentBackupEnvelopeV3, createFullAutoBackup } from './lib/auto-backup'
import { setRuntimeCompositionAuthority } from './lib/composition-authority'
import { runStartupGate } from './lib/startup-mode'
import { scheduleAfterVisiblePaint } from './lib/after-visible-paint'
import { reportDiagnostic, reportPersistenceFault } from './services/diagnostics/error-registry'
import type { DiagnosticEvent } from './domain/diagnostics/types'
import type { SceneRepositoryPort } from './application/scene/scene-repository'
import type { SceneMigrationStartupResult } from './lib/scene-migration-startup'
import type { IndexedDbSceneMigrationPersistence } from './adapters/scene/indexeddb-scene-migration'

// 자동 백업 상수
const AUTO_BACKUP_KEY = 'nai-blue-auto-backup'
const AUTO_BACKUP_INTERVAL = 24 * 60 * 60 * 1000 // 24시간
const MAX_AUTO_BACKUPS = 3
let appRoot: ReactDOM.Root | null = null
let startupInProgress = false
let sceneAuthorityV2Active = false

function getAppRoot(): ReactDOM.Root {
    appRoot ??= ReactDOM.createRoot(document.getElementById('root')!)
    return appRoot
}

async function rehydrateCompositionConnectedStores(): Promise<void> {
    const [
        { useGenerationStore },
        { useSceneStore },
        { useCharacterPromptStore },
        { useFragmentStore },
        { usePresetStore, startPresetSync },
        { useAssetModuleStore },
        { useCharacterStore },
        { useSettingsStore, initializeGenerationFolderAuthority },
    ] = await Promise.all([
        import('./stores/generation-store'),
        import('./stores/scene-store'),
        import('./stores/character-prompt-store'),
        import('./stores/fragment-store'),
        import('./stores/preset-store'),
        import('./stores/asset-module-store'),
        import('./stores/character-store'),
        import('./stores/settings-store'),
    ])
    await Promise.all([
        useGenerationStore.persist.rehydrate(),
        useSceneStore.persist.rehydrate(),
        useCharacterPromptStore.persist.rehydrate(),
        useFragmentStore.persist.rehydrate(),
        usePresetStore.persist.rehydrate(),
        useAssetModuleStore.persist.rehydrate(),
        useCharacterStore.persist.rehydrate(),
        useSettingsStore.persist.rehydrate(),
    ])
    // Folder V2 projection must be ready before any rendered command can read
    // output paths or attempt a CAS mutation.
    await initializeGenerationFolderAuthority()
    // Preset draft tracking starts only after both stores are hydrated. It marks
    // unsaved edits without writing them into the selected preset.
    startPresetSync()
}

const setSplashStage = (message: string) => {
    const subtitle = document.querySelector<HTMLElement>('#splash-screen .splash-subtitle')
    if (subtitle) {
        subtitle.textContent = message
    }
}

// Hide splash screen when React is ready
const hideSplash = () => {
    const splash = document.getElementById('splash-screen')
    if (splash) {
        splash.classList.add('fade-out')
        setTimeout(() => splash.remove(), 500)
    }
}

// Show error message on splash screen
const showSplashError = (message: string) => {
    const splash = document.getElementById('splash-screen')
    if (splash) {
        const errorDiv = document.createElement('div')
        errorDiv.style.cssText = 'color: oklch(var(--destructive)); margin-top: 20px; padding: 10px; max-width: 400px; text-align: center;'
        errorDiv.textContent = message
        splash.appendChild(errorDiv)
    }
}

// 자동 백업 실행 (localStorage에 저장 - IndexedDB와 분리)
async function performAutoBackup() {
    try {
        const lastBackupStr = localStorage.getItem('nai-blue-last-auto-backup')
        const lastBackup = lastBackupStr ? parseInt(lastBackupStr, 10) : 0
        const now = Date.now()
        
        // 24시간이 지나지 않았으면 스킵
        if (now - lastBackup < AUTO_BACKUP_INTERVAL) {
            console.log('[AutoBackup] Skipping - last backup was less than 24h ago')
            return
        }
        
        console.log('[AutoBackup] Starting automatic backup...')
        const backup = await createCurrentBackupEnvelopeV3({ purpose: 'local-auto' })
        
        // 기존 자동 백업들 로드
        const existingBackupsStr = localStorage.getItem(AUTO_BACKUP_KEY)
        let backups: { timestamp: number, data: unknown }[] = []
        
        if (existingBackupsStr) {
            try {
                backups = JSON.parse(existingBackupsStr)
            } catch {
                backups = []
            }
        }
        
        // 새 백업 추가
        backups.unshift({ timestamp: now, data: backup })
        
        // 최대 3개만 유지
        if (backups.length > MAX_AUTO_BACKUPS) {
            backups = backups.slice(0, MAX_AUTO_BACKUPS)
        }
        
        // 저장 (localStorage 용량 제한 체크)
        const backupStr = JSON.stringify(backups)
        if (backupStr.length > 4 * 1024 * 1024) { // 4MB 제한
            console.warn('[AutoBackup] Backup too large, keeping only latest')
            backups = backups.slice(0, 1)
        }
        
        localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(backups))
        localStorage.setItem('nai-blue-last-auto-backup', now.toString())
        
        console.log(`[AutoBackup] Complete - ${backups.length} backups stored`)
    } catch (err) {
        reportDiagnostic(err, { operation: 'startup.auto-backup', stage: 'backup', category: 'persistence' })
    }
}

// 데이터 무결성 체크 및 자동 복구
async function checkDataIntegrity(): Promise<boolean> {
    try {
        // 중요 스토어들의 데이터 확인
        const criticalStores = ['nai-blue-character-prompts', 'nai-blue-scenes', 'nai-blue-presets']
        let hasDataLoss = false
        
        for (const storeKey of criticalStores) {
            const data = await indexedDBStorage.getItem(storeKey)
            
            if (!data) {
                console.warn(`[Integrity] ${storeKey}: No data found`)
                continue
            }
            
            try {
                const parsed = JSON.parse(data)
                const state = parsed.state
                
                // character-prompts 체크
                if (storeKey === 'nai-blue-character-prompts') {
                    const presetCount = state?.presets?.length || 0
                    const charCount = state?.characters?.length || 0
                    
                    // 이전 기록과 비교
                    const prevStats = localStorage.getItem('nai-blue-integrity-character-prompts')
                    if (prevStats) {
                        const prev = JSON.parse(prevStats)
                        // 프리셋이 갑자기 절반 이하로 줄었으면 경고
                        if (prev.presets > 10 && presetCount < prev.presets * 0.5) {
                            console.error(`[Integrity] CHARACTER PROMPTS DATA LOSS DETECTED! Previous: ${prev.presets}, Current: ${presetCount}`)
                            hasDataLoss = true
                        }
                    }
                    
                    // 현재 통계 저장
                    localStorage.setItem('nai-blue-integrity-character-prompts', JSON.stringify({ presets: presetCount, characters: charCount }))
                }
                
                // scenes 체크
                if (storeKey === 'nai-blue-scenes') {
                    const presetCount = state?.presets?.length || 0
                    const totalScenes = state?.presets?.reduce((sum: number, p: { scenes?: unknown[] }) => sum + (p.scenes?.length || 0), 0) || 0
                    
                    const prevStats = localStorage.getItem('nai-blue-integrity-scenes')
                    if (prevStats) {
                        const prev = JSON.parse(prevStats)
                        if (prev.scenes > 10 && totalScenes < prev.scenes * 0.5) {
                            console.error(`[Integrity] SCENE DATA LOSS DETECTED! Previous: ${prev.scenes}, Current: ${totalScenes}`)
                            hasDataLoss = true
                        }
                    }
                    
                    localStorage.setItem('nai-blue-integrity-scenes', JSON.stringify({ presets: presetCount, scenes: totalScenes }))
                }
            } catch (parseErr) {
                console.error(`[Integrity] ${storeKey}: Parse error`, parseErr)
            }
        }
        
        // 데이터 손실 감지 시 자동 백업에서 복구 제안
        if (hasDataLoss) {
            console.error('[Integrity] DATA LOSS DETECTED! Check auto-backups in localStorage')
            
            // 자동 백업 존재 여부 확인
            const autoBackups = localStorage.getItem(AUTO_BACKUP_KEY)
            if (autoBackups) {
                try {
                    const backups = JSON.parse(autoBackups)
                    if (backups.length > 0) {
                        const latestBackup = new Date(backups[0].timestamp).toLocaleString()
                        console.log(`[Integrity] Auto-backup available from: ${latestBackup}`)
                        // 사용자에게 복구 옵션 제공은 Settings 페이지에서 수동으로
                    }
                } catch {
                    // 무시
                }
            }
        }
        
        return !hasDataLoss
    } catch (err) {
        reportDiagnostic(err, { operation: 'startup.integrity-check', stage: 'verify', category: 'persistence' })
        return true // 에러 시에는 그냥 진행
    }
}

async function renderApp(): Promise<void> {
    const [{ default: App }, { initializeCoreRuntime }] = await Promise.all([
        import('./App.tsx'),
        import('./composition-root/core-runtime'),
    ])
    // Runtime ports are wired after credential hydration and before any command
    // can render, connecting stores to services without reversing layer imports.
    initializeCoreRuntime()
    getAppRoot().render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    )
}

async function renderRescueMode(diagnostic: DiagnosticEvent): Promise<void> {
    const { RescueScreen } = await import('./components/startup/RescueScreen')
    getAppRoot().render(
        <React.StrictMode>
            <RescueScreen
                key={diagnostic.eventId}
                diagnostic={diagnostic}
                onRetry={async () => {
                    resetIndexedDBConnectionForRetry()
                    await startApp()
                }}
            />
        </React.StrictMode>,
    )
}

async function reconcileSceneArtifactsAfterStartup(): Promise<void> {
    if (!sceneAuthorityV2Active) return
    try {
        const [
            { reconcileSceneArtifactLinks },
            { getRuntimeSceneRepository },
            { getRuntimeArtifactRepository },
            { applySceneDocumentProjection },
            { sceneImagePresentationKey, useSceneStore },
            { createRuntimeOutputPlatformAdapter },
            { childOutputRef },
        ] = await Promise.all([
            import('./application/scene/link-scene-artifact'),
            import('./lib/scene-migration-startup'),
            import('./services/organizer/runtime'),
            import('./lib/scene-authority-runtime'),
            import('./stores/scene-store'),
            import('./services/output/tauri-output-adapter'),
            import('./services/output/platform-adapter'),
        ])
        const artifacts = getRuntimeArtifactRepository()
        const reconciled = await reconcileSceneArtifactLinks(
            getRuntimeSceneRepository(),
            artifacts,
            {
                shouldLink: input => useSceneStore.getState().legacyImagePresentation[
                    sceneImagePresentationKey(input.presetId, input.sceneId, input.artifactId)
                ]?.deleted !== true,
            },
        )
        const outputPlatform = createRuntimeOutputPlatformAdapter()
        for (const result of reconciled) {
            if (!('document' in result)) continue
            applySceneDocumentProjection(result.document)
            for (const scene of result.document.scenes) {
                for (const reference of scene.artifactRefs) {
                    const state = useSceneStore.getState()
                    const presentation = state.legacyImagePresentation[
                        sceneImagePresentationKey(result.document.presetId, scene.id, reference.artifactId)
                    ]
                    const projected = state.presets.find(preset => preset.id === result.document.presetId)
                        ?.scenes.find(candidate => candidate.id === scene.id)
                        ?.images.some(image => image.id === reference.artifactId)
                    if (presentation?.deleted || projected) continue
                    try {
                        const record = await artifacts.get(reference.artifactId)
                        if (record === null) continue
                        const directory = await outputPlatform.resolveDirectory({
                            portableDirectory: record.original.file.directory,
                            workflowDefaultDirectory: 'NAI_Blue_Output',
                        })
                        const original = childOutputRef(directory, record.original.file.fileName)
                        if (!await outputPlatform.exists(original)) continue
                        useSceneStore.getState().addImageToScene(
                            result.document.presetId,
                            scene.id,
                            original.displayPath,
                            reference.artifactId,
                            reference.favorite,
                        )
                    } catch {
                        // Missing portable grants remain recoverable on a later startup.
                    }
                }
            }
        }
        const pending = reconciled.filter(result => result.status === 'PENDING_CONFLICT')
        if (pending.length > 0) {
            console.warn(`[Startup] ${pending.length} Scene artifact links remain pending`)
        }
    } catch (err) {
        reportDiagnostic(err, {
            operation: 'startup.scene-artifact-reconcile',
            stage: 'link',
            category: 'persistence',
            severity: 'error',
            recoverable: true,
        })
    }
}

async function runPostRenderStartupTasks(): Promise<void> {
    const [
        { startAssetProfileDiskSync },
        { useCharacterStore },
        { startStoreSnapshotScheduler },
        { initializeQueueAfterRestart },
        { startAgentWorkspaceBridge },
        { startRuntimeAgentCommands },
    ] = await Promise.all([
        import('./stores/asset-module-store'),
        import('./stores/character-store'),
        import('./lib/store-snapshots'),
        import('./services/queue/queue-startup'),
        import('./services/agent/agent-workspace-runtime'),
        import('./composition-root/runtime-agent-commands'),
    ])
    const queueRecovery = initializeQueueAfterRestart()
    // The native command owner waits for this same recovery authority. A resolved
    // partial recovery or rejected recovery keeps every inbox handler unavailable.
    void startRuntimeAgentCommands(queueRecovery).catch(err => {
        reportDiagnostic(err, { operation: 'startup.agent-commands', stage: 'initialize', category: 'persistence' })
    })
    void queueRecovery.then(async recovery => {
        const results = [...recovery.linkedOutputs, ...recovery.orphanOutputs]
        const failures = results.filter(result => result.action === 'failed')
        if (results.length > 0) {
            console.log(`[Startup] Recovered ${results.length - failures.length}/${results.length} output transactions`)
        }
        for (const failure of failures) {
            console.warn(`[Startup] Output recovery is still pending for ${failure.transactionId}:`, failure.error)
        }
        // Queue recovery may materialize ArtifactRecords after the independent
        // pass below, so replay once more after it succeeds.
        await reconcileSceneArtifactsAfterStartup()
    }).catch(err => {
        reportDiagnostic(err, { operation: 'startup.output-recovery', stage: 'scan', category: 'local_io' })
    })
    // Direct Scene link recovery must not depend on Queue startup health.
    void reconcileSceneArtifactsAfterStartup()
    // Agent Workspace depends on the desktop Asset Profile disk projection. Starting
    // it after the initial profile load prevents a stale startup snapshot while both
    // watchers continue to refresh their independent compatibility/read boundaries.
    void startAssetProfileDiskSync()
        .then(() => {
            void startAgentWorkspaceBridge().catch(err => {
                reportDiagnostic(err, { operation: 'startup.agent-workspace', stage: 'sync', category: 'sync' })
            })
        })
        .catch(err => {
            reportDiagnostic(err, { operation: 'startup.asset-profile-sync', stage: 'sync', category: 'sync' })
        })

    startStoreSnapshotScheduler()

    void checkDataIntegrity().then(isHealthy => {
        if (!isHealthy) {
            console.warn('[Startup] Data integrity check reported possible data loss')
        }
    }).catch(err => {
        reportDiagnostic(err, { operation: 'startup.integrity-check', stage: 'verify', category: 'persistence' })
    })

    void performAutoBackup().catch(err => {
        reportDiagnostic(err, { operation: 'startup.auto-backup', stage: 'backup', category: 'persistence' })
    })

    // Disk auto-backup supplements B's existing localStorage startup backup.
    // It restores through importAllData, so the full IndexedDB export schema remains authoritative.
    void createFullAutoBackup({ minIntervalMs: AUTO_BACKUP_INTERVAL }).then(result => {
        if (result.status === 'created') {
            console.log(`[Startup] Disk auto-backup written: ${result.entry.fileName}`)
        }
    }).catch(err => {
        reportDiagnostic(err, { operation: 'startup.disk-auto-backup', stage: 'backup', category: 'persistence' })
    })

    // FragmentStore owns embedded-content migration and verified repository
    // writes. Startup must not strip/delete legacy wildcard content first.

    window.setTimeout(async () => {
        try {
            await useCharacterStore.getState().ensureImagesLoaded()
            console.log('[Startup] Reference images loaded from files')
        } catch (err) {
            reportDiagnostic(err, { operation: 'startup.reference-images', stage: 'load', category: 'local_io' })
        }
    }, 100)
}

function schedulePostRenderStartupTasks() {
    window.setTimeout(() => {
        void runPostRenderStartupTasks().catch(err => {
            reportDiagnostic(err, { operation: 'startup.post-render', stage: 'initialize' })
        })
    }, 0)
}

async function runStartupMigrations(): Promise<void> {
    sceneAuthorityV2Active = false
    let sceneMigration: SceneMigrationStartupResult | null = null
    let sceneRepository: SceneRepositoryPort | null = null
    let sceneMigrationPersistence: IndexedDbSceneMigrationPersistence | null = null
    // CRITICAL: Migration must complete BEFORE React renders
    // Otherwise Zustand stores will hydrate from empty IndexedDB
    // Import any current NAI Blue localStorage entries into IndexedDB.
    // Missing entries here will cause data loss on app restart/update!
    try {
        setSplashStage('Migrating local data')
        await migrateFromLocalStorage([...BACKUP_STORE_KEYS])
        console.log('[Startup] LocalStorage migration complete')
    } catch (err) {
        reportDiagnostic(err, { operation: 'startup.local-storage-migration', stage: 'migrate', category: 'persistence', severity: 'error', recoverable: true })
    }

    // Secret-free refs hydrate from strict app storage; the OS credential vault
    // supplies runtime-only tokens without a separate passphrase session.
    try {
        setSplashStage('Loading secure API credentials')
        const { initializeAuthCredentialState } = await import('./stores/auth-store')
        await initializeAuthCredentialState()
    } catch (err) {
        reportDiagnostic(err, { operation: 'startup.local-auth', stage: 'hydrate', category: 'auth', severity: 'error', recoverable: true })
    }

    try {
        setSplashStage('Migrating Composition data')
        const {
            getLastCompositionStartupObservation,
            runStartupCompositionMigration,
        } = await import('./lib/composition-migration-startup')
        const migration = await runStartupCompositionMigration()
        const authorityObservation = getLastCompositionStartupObservation()
        if (migration.status === 'failed') {
            reportDiagnostic(new Error(migration.error || 'Composition migration retained legacy authority'), {
                operation: 'startup.composition-migration',
                stage: 'migrate',
                category: 'persistence',
                severity: 'error',
                recoverable: true,
            })
        } else if (authorityObservation?.fallbackReason !== null
            && authorityObservation?.fallbackReason !== undefined) {
            reportDiagnostic(new Error(`Composition authority fallback: ${authorityObservation.fallbackReason}`), {
                operation: 'startup.composition-authority',
                stage: 'verify',
                category: 'persistence',
                code: 'E_COMPOSITION_AUTHORITY_FALLBACK',
                severity: 'error',
                recoverable: true,
            })
        } else {
            console.log(
                `[Startup] Composition migration ${migration.status}; authority=${migration.authority}`,
            )
        }
    } catch (err) {
        // The migration transaction is fail-closed and never deletes old
        // stores. Startup can safely continue on the legacy authority.
        reportDiagnostic(err, { operation: 'startup.composition-migration', stage: 'migrate', category: 'persistence', severity: 'error', recoverable: true })
    }

    try {
        setSplashStage('Migrating Scene authority')
        const [
            { IndexedDbSceneMigrationPersistence },
            { getRuntimeSceneRepository, runSceneMigrationStartup },
        ] = await Promise.all([
            import('./adapters/scene/indexeddb-scene-migration'),
            import('./lib/scene-migration-startup'),
        ])
        sceneRepository = getRuntimeSceneRepository()
        sceneMigrationPersistence = new IndexedDbSceneMigrationPersistence()
        sceneMigration = await runSceneMigrationStartup({
            repository: sceneRepository,
            legacyPreimage: sceneMigrationPersistence,
            marker: sceneMigrationPersistence,
        })
        if (sceneMigration.status === 'V1_FALLBACK') {
            reportDiagnostic(new Error(`Scene authority retained V1: ${sceneMigration.reason}`), {
                operation: 'startup.scene-authority',
                stage: 'migrate',
                category: 'persistence',
                code: 'E_SCENE_AUTHORITY_FALLBACK',
                severity: 'error',
                recoverable: true,
            })
        } else {
            console.log(`[Startup] Scene authority V2 active (${sceneMigration.documents.length} documents)`)
        }
    } catch (err) {
        reportDiagnostic(err, {
            operation: 'startup.scene-authority',
            stage: 'migrate',
            category: 'persistence',
            severity: 'error',
            recoverable: true,
        })
    }

    try {
        setSplashStage('Migrating folder authority')
        const { runGenerationFolderMigrationStartup } = await import('./lib/generation-folder-migration-startup')
        const folderMigration = await runGenerationFolderMigrationStartup()
        if (folderMigration.status === 'V1_FALLBACK') {
            reportDiagnostic(new Error(`Generation folder authority retained V1: ${folderMigration.reason}`), {
                operation: 'startup.generation-folder-authority',
                stage: 'migrate',
                category: 'persistence',
                code: 'E_GENERATION_FOLDER_AUTHORITY_FALLBACK',
                severity: 'error',
                recoverable: true,
            })
        } else {
            console.log(`[Startup] Generation folder authority V2 active at revision ${folderMigration.document.revision}`)
        }
    } catch (err) {
        reportDiagnostic(err, {
            operation: 'startup.generation-folder-authority',
            stage: 'migrate',
            category: 'persistence',
            severity: 'error',
            recoverable: true,
        })
    }

    let storesHydrated = false
    try {
        setSplashStage('Hydrating migrated stores')
        await rehydrateCompositionConnectedStores()
        storesHydrated = true
    } catch (err) {
        reportDiagnostic(err, { operation: 'startup.store-hydration', stage: 'hydrate', category: 'persistence', severity: 'error', recoverable: true })
        try {
            const { applyCompositionAuthorityFeatureFlag } = await import('./lib/composition-migration-startup')
            await applyCompositionAuthorityFeatureFlag('legacy')
        } catch (authorityError) {
            setRuntimeCompositionAuthority('legacy')
            reportDiagnostic(authorityError, { operation: 'startup.store-hydration', stage: 'rollback-authority', category: 'persistence', severity: 'error', recoverable: true })
        }
    }

    if (storesHydrated && sceneRepository !== null) {
        try {
            const {
                activateSceneAuthorityRuntime,
                applyLegacySceneProjection,
            } = await import('./lib/scene-authority-runtime')
            if (sceneMigration?.status === 'V2_ACTIVE') {
                const [
                    { getRuntimeArtifactRepository },
                    { createRuntimeOutputPlatformAdapter },
                    { childOutputRef },
                    { hydrateDurableSceneOutputDirectories },
                ] = await Promise.all([
                    import('./services/organizer/runtime'),
                    import('./services/output/tauri-output-adapter'),
                    import('./services/output/platform-adapter'),
                    import('./lib/scene-output-portable-locator'),
                ])
                const artifacts = getRuntimeArtifactRepository()
                const outputPlatform = createRuntimeOutputPlatformAdapter()
                // Artifact bookmarks are creation-time bindings. Hydrate their local
                // opaque tokens independently of mutable Settings/Folder authority.
                await hydrateDurableSceneOutputDirectories()
                await activateSceneAuthorityRuntime(sceneRepository, {
                    documents: sceneMigration.documents,
                    artifactPresentation: {
                        get: artifactId => artifacts.get(artifactId),
                        resolveOriginalPath: async record => {
                            const directory = await outputPlatform.resolveDirectory({
                                portableDirectory: record.original.file.directory,
                                workflowDefaultDirectory: 'NAI_Blue_Output',
                            })
                            const original = childOutputRef(directory, record.original.file.fileName)
                            return await outputPlatform.exists(original) ? original.displayPath : null
                        },
                    },
                })
                sceneAuthorityV2Active = true
            } else {
                const legacy = await sceneMigrationPersistence?.readPreservedProjection()
                    ?? await sceneRepository.readLegacyProjection()
                if (legacy !== null) applyLegacySceneProjection(legacy)
            }
        } catch (err) {
            sceneAuthorityV2Active = false
            try {
                const legacy = await sceneMigrationPersistence?.readPreservedProjection()
                    ?? await sceneRepository.readLegacyProjection()
                if (legacy !== null) {
                    if (sceneMigrationPersistence !== null) {
                        const { rollbackSceneAuthority } = await import('./lib/scene-migration-startup')
                        await rollbackSceneAuthority(sceneMigrationPersistence)
                    }
                    const { applyLegacySceneProjection } = await import('./lib/scene-authority-runtime')
                    applyLegacySceneProjection(legacy)
                }
            } catch (rollbackError) {
                reportDiagnostic(rollbackError, {
                    operation: 'startup.scene-authority',
                    stage: 'rollback-authority',
                    category: 'persistence',
                    severity: 'error',
                    recoverable: true,
                })
            }
            reportDiagnostic(err, {
                operation: 'startup.scene-authority',
                stage: 'activate',
                category: 'persistence',
                severity: 'error',
                recoverable: true,
            })
        }
    }
}

async function runStartupAttempt(): Promise<void> {
    // No workflow may use v2 authority until repository migration verifies.
    setRuntimeCompositionAuthority('legacy')
    console.log('[Startup] Starting app initialization...')
    setSplashStage('Starting database')

    const startup = await runStartupGate({
        initializeDatabase: initializeIndexedDB,
        runMigrations: runStartupMigrations,
    })
    if (startup.mode === 'rescue') {
        const event = reportPersistenceFault(startup.databaseFault, {
            operation: 'startup.indexeddb',
            stage: 'initialize',
            fatal: true,
        })
        setSplashStage('Recovery mode')
        await renderRescueMode(event)
        scheduleAfterVisiblePaint(hideSplash)
        return
    }
    if (startup.migrationError !== undefined) {
        setRuntimeCompositionAuthority('legacy')
        reportDiagnostic(startup.migrationError, {
            operation: 'startup.migration',
            stage: 'migrate',
            category: 'persistence',
            severity: 'error',
            recoverable: true,
        })
    }

    console.log('[Startup] Initialization complete, rendering React app...')
    setSplashStage('Rendering app')

    // NOW render React app
    await renderApp()

    // The scheduler waits for paint when possible and falls back when a hidden
    // window suspends animation frames, so the splash never traps input.
    scheduleAfterVisiblePaint(() => {
        setSplashStage('Ready')
        hideSplash()
        schedulePostRenderStartupTasks()
    })
}

// Start app only after the database gate and migrations complete.
async function startApp(): Promise<void> {
    if (startupInProgress) return
    startupInProgress = true
    try {
        await runStartupAttempt()
    } finally {
        startupInProgress = false
    }
}

// Start the app - DO NOT add any code after this that runs in parallel!
startApp().catch(err => {
    const event = reportDiagnostic(err, {
        operation: 'startup',
        stage: 'fatal',
        category: 'persistence',
        fatal: true,
    })
    showSplashError(event.userSummary)
})
