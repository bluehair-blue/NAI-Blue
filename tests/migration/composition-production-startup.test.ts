import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { prepareBackupRestore } from '@/lib/auto-backup'
import {
    getLastCompositionStartupObservation,
    inspectCompositionAuthority,
    runStartupCompositionMigration,
} from '@/lib/composition-migration-startup'
import {
    COMPOSITION_REPOSITORY_STORAGE_KEY,
    CompositionRepository,
    type CompositionAuthority,
    type CompositionRepositoryStorage,
} from '@/domain/composition/repository'
import { getRuntimeCompositionDocument } from '@/lib/composition-authority'
import type { CompositionMigrationSourceSnapshot } from '@/lib/composition-migration-runtime'
import { loadFixtureJson } from '../helpers'

interface StartupScenario {
    id: string
    description: string
    expectedRuntimeAuthority: CompositionAuthority
    expectedPersistedAuthority: CompositionAuthority | 'unavailable'
}

interface ProductionStartupFixture {
    case: string
    description: string
    scenarios: StartupScenario[]
}

class MemoryStorage implements CompositionRepositoryStorage {
    readonly values = new Map<string, string>()

    getItem(key: string): string | null {
        return this.values.get(key) ?? null
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value)
    }

    compareAndSet(key: string, expected: string | null, next: string): boolean {
        if (this.getItem(key) !== expected) return false
        this.setItem(key, next)
        return true
    }
}

class VerificationFallbackStorage extends MemoryStorage {
    private v2Reads = 0

    override getItem(key: string): string | null {
        const raw = super.getItem(key)
        if (key === COMPOSITION_REPOSITORY_STORAGE_KEY && raw?.includes('"authority":"v2"')) {
            this.v2Reads += 1
            if (this.v2Reads === 3) throw new Error('injected authoritative document re-read failure')
        }
        return raw
    }
}

const START = '2026-07-13T00:00:00.000Z'
const LATER = '2026-07-13T00:06:00.000Z'
const EMPTY_SOURCE: CompositionMigrationSourceSnapshot = {
    serializedStores: {},
    wildcardContent: {},
}
const LEGACY_SOURCE: CompositionMigrationSourceSnapshot = {
    serializedStores: {
        'nai-blue-generation': JSON.stringify({
            state: { basePrompt: 'synthetic local prompt', seed: 17, seedLocked: true },
            version: 8,
        }),
        'nai-blue-scenes': JSON.stringify({
            state: { activePresetId: 'preset:synthetic', presets: [] },
            version: 1,
        }),
    },
    wildcardContent: {},
}

let featureFlags: Map<string, string>

beforeEach(() => {
    featureFlags = new Map()
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => featureFlags.get(key) ?? null,
        setItem: (key: string, value: string) => { featureFlags.set(key, value) },
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

async function fixture(): Promise<ProductionStartupFixture> {
    return loadFixtureJson<ProductionStartupFixture>('legacy/production-authority-startup.json')
}

async function expected(id: string): Promise<StartupScenario> {
    const scenario = (await fixture()).scenarios.find(candidate => candidate.id === id)
    if (scenario === undefined) throw new Error(`Missing production startup fixture scenario: ${id}`)
    return scenario
}

async function expectAuthority(
    scenarioId: string,
    storage: CompositionRepositoryStorage,
): Promise<void> {
    const scenario = await expected(scenarioId)
    const inspection = await inspectCompositionAuthority({ now: LATER, storage })
    expect(inspection.runtimeAuthority, scenarioId).toBe(scenario.expectedRuntimeAuthority)
    expect(inspection.persistedAuthority, scenarioId).toBe(scenario.expectedPersistedAuthority)
}

describe('Phase 06 production-like authority startup matrix', () => {
    it('names every required fresh, upgrade, recovery, and rollback fixture', async () => {
        const loaded = await fixture()

        expect(loaded.case).toBe('unified-composition-startup')
        expect(loaded.description.trim()).not.toBe('')
        expect(loaded.scenarios.map(scenario => scenario.id)).toEqual([
            'fresh-install',
            'canonical-v2-only',
            'upgrade-current-legacy-stores',
            'both-present',
            'old-backup-retired-remote-keys',
            'interrupted-migration',
            'corrupted-repository',
            'legacy-flag-ignored',
        ])
        expect(loaded.scenarios.every(scenario => scenario.description.trim().length > 0)).toBe(true)
    })

    it('activates the verified v2 production default for a fresh install without an override', async () => {
        const storage = new MemoryStorage()

        const result = await runStartupCompositionMigration({
            now: START,
            clock: () => START,
            storage,
            source: EMPTY_SOURCE,
        })

        expect(result.status).toBe('committed')
        await expectAuthority('fresh-install', storage)
        expect(featureFlags.get('nai-blue-composition-authority')).toBeUndefined()

        const restarted = await runStartupCompositionMigration({
            now: LATER,
            clock: () => LATER,
            storage,
            source: EMPTY_SOURCE,
        })

        expect(restarted.status).toBe('already-current')
        await expectAuthority('fresh-install', storage)
    })

    it('ignores an obsolete persisted legacy preference', async () => {
        const storage = new MemoryStorage()
        featureFlags.set('nai-blue-composition-authority', 'legacy')

        const result = await runStartupCompositionMigration({
            now: START,
            clock: () => START,
            storage,
            source: EMPTY_SOURCE,
        })

        expect(result.status).toBe('committed')
        await expectAuthority('fresh-install', storage)
        expect(featureFlags.get('nai-blue-composition-authority')).toBe('legacy')
    })

    it('accepts a repository-verified canonical v2-only restart', async () => {
        const storage = new MemoryStorage()
        await runStartupCompositionMigration({
            now: START,
            clock: () => START,
            storage,
            source: EMPTY_SOURCE,
        })
        const restarted = await runStartupCompositionMigration({
            now: LATER,
            clock: () => LATER,
            storage,
            source: EMPTY_SOURCE,
        })

        expect(restarted.status).toBe('already-current')
        await expectAuthority('canonical-v2-only', storage)
    })

    it('upgrades current legacy stores under the verified v2 default without an override', async () => {
        const storage = new MemoryStorage()

        const upgraded = await runStartupCompositionMigration({
            now: START,
            storage,
            source: LEGACY_SOURCE,
            clock: () => START,
        })

        expect(upgraded.status).toBe('committed')
        await expectAuthority('upgrade-current-legacy-stores', storage)
        expect(featureFlags.get('nai-blue-composition-authority')).toBeUndefined()

        const restarted = await runStartupCompositionMigration({
            now: LATER,
            storage,
            source: LEGACY_SOURCE,
            clock: () => LATER,
        })
        expect(restarted.status).toBe('already-current')
        await expectAuthority('upgrade-current-legacy-stores', storage)
    })

    it('keeps source stores after converting them into the canonical Composition document', async () => {
        const storage = new MemoryStorage()
        await runStartupCompositionMigration({
            now: START,
            clock: () => START,
            storage,
            source: LEGACY_SOURCE,
        })
        const sourceBefore = structuredClone(LEGACY_SOURCE)
        const restarted = await runStartupCompositionMigration({
            now: LATER,
            clock: () => LATER,
            storage,
            source: LEGACY_SOURCE,
        })

        expect(restarted.status).toBe('already-current')
        expect(LEGACY_SOURCE).toEqual(sourceBefore)
        await expectAuthority('both-present', storage)
    })

    it('sanitizes retired remote keys from an old backup before verified startup', async () => {
        const backup = await loadFixtureJson<Record<string, unknown>>(
            'legacy/old-backup-with-obsolete-remote-state.json',
        )
        const prepared = prepareBackupRestore(backup)
        const storage = new MemoryStorage()
        const source: CompositionMigrationSourceSnapshot = {
            serializedStores: Object.fromEntries(Object.entries(prepared.restorePayload)
                .map(([key, value]) => [key, JSON.stringify(value)])),
            wildcardContent: {},
        }

        expect(prepared.report.ignoredKeys.map(item => item.key)).toEqual(expect.arrayContaining([
            'nai-blue-marketplace-cache',
            'supabase.auth.session',
            'sb-obsolete-project-auth-token',
        ]))
        const migrated = await runStartupCompositionMigration({
            now: START,
            storage,
            source,
            clock: () => START,
        })

        expect(migrated.status).toBe('committed')
        await expectAuthority('old-backup-retired-remote-keys', storage)
        expect(source.serializedStores).not.toHaveProperty('nai-blue-marketplace-cache')
        expect(source.serializedStores).not.toHaveProperty('supabase.auth.session')

        const restarted = await runStartupCompositionMigration({
            now: LATER,
            storage,
            source,
            clock: () => LATER,
        })
        expect(restarted.status).toBe('already-current')
        await expectAuthority('old-backup-retired-remote-keys', storage)
    })

    it('cleans an expired interrupted migration before v2 repository verification', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        await runStartupCompositionMigration({
            now: START,
            clock: () => START,
            storage,
            source: LEGACY_SOURCE,
        })
        const committed = await repository.read(START)
        expect(committed.committedDocument).toBeDefined()
        const lock = await repository.acquireMigrationLock({
            id: 'lock:interrupted-fixture',
            owner: 'interrupted-fixture',
            now: START,
        })
        await repository.writeStagedDocument(
            lock.id,
            'migration:interrupted-fixture',
            committed.committedDocument!,
            START,
        )

        await runStartupCompositionMigration({
            now: LATER,
            storage,
            source: LEGACY_SOURCE,
            clock: () => LATER,
        })

        const recovered = await repository.read(LATER)
        expect(recovered.migrationLock).toBeUndefined()
        expect(recovered.staged).toBeUndefined()
        await expectAuthority('interrupted-migration', storage)
    })

    it('retains a corrupted repository and fails closed with inspectable status', async () => {
        const storage = new MemoryStorage()
        storage.setItem(COMPOSITION_REPOSITORY_STORAGE_KEY, '{corrupted-json')

        await expect(runStartupCompositionMigration({
            now: START,
            clock: () => START,
            storage,
            source: LEGACY_SOURCE,
        })).rejects.toThrow('Composition repository JSON is invalid')

        expect(storage.getItem(COMPOSITION_REPOSITORY_STORAGE_KEY)).toBe('{corrupted-json')
        const inspection = await inspectCompositionAuthority({ now: LATER, storage })
        expect(inspection.migrationStatus).toBe('repository-invalid')
        expect(inspection.repositoryErrorCode).toBe('E_REPOSITORY_JSON_INVALID')
        await expectAuthority('corrupted-repository', storage)
    })

    it('ignores a legacy rollback request and retains the canonical document', async () => {
        const storage = new MemoryStorage()
        const repository = new CompositionRepository(storage)
        await runStartupCompositionMigration({
            now: START,
            storage,
            source: LEGACY_SOURCE,
            clock: () => START,
        })
        const beforeRetiredRequest = await repository.read(START)
        featureFlags.set('nai-blue-composition-authority', 'legacy')

        await runStartupCompositionMigration({
            now: LATER,
            storage,
            source: LEGACY_SOURCE,
            clock: () => LATER,
        })

        const afterRetiredRequest = await repository.read(LATER)
        expect(afterRetiredRequest.authority).toBe('v2')
        expect(afterRetiredRequest.committedHash).toBe(beforeRetiredRequest.committedHash)
        expect(afterRetiredRequest.committedDocument).toEqual(beforeRetiredRequest.committedDocument)
        expect(getRuntimeCompositionDocument()).not.toBeNull()
        await expectAuthority('legacy-flag-ignored', storage)
    })

    it('keeps the single runtime path when repository readback verification fails', async () => {
        const storage = new VerificationFallbackStorage()

        const result = await runStartupCompositionMigration({
            now: START,
            clock: () => START,
            storage,
            source: LEGACY_SOURCE,
        })

        expect(result.status).toBe('committed')
        expect(result.authority).toBe('v2')
        expect(getRuntimeCompositionDocument()).toBeNull()
        expect(getLastCompositionStartupObservation()).toMatchObject({
            persistedAuthority: 'v2',
            runtimeAuthority: 'v2',
            migrationIssue: 'repository-verification-failed',
        })
        expect((await inspectCompositionAuthority({ now: LATER, storage })).migrationIssue)
            .toBe('repository-verification-failed')
    })
})
