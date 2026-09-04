import { describe, expect, it, vi } from 'vitest'

import { createArtifactRecord, type ArtifactRecord } from '@/domain/organizer/types'
import type { GenerationJob, QueueArtifactReference } from '@/domain/queue/types'
import type { OutputWriteResult } from '@/services/output/output-writer'
import {
    registerQueueArtifact,
    rollbackQueueArtifactRegistration,
    type QueueArtifactRepository,
} from '@/services/queue/queue-artifact-lineage'

const CHECKSUM = `sha256:${'a'.repeat(64)}`
const COMMIT_SET_HASH = `sha256:${'c'.repeat(64)}` as const

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
    return {
        id: 'job:queue:1',
        batchId: 'batch:1',
        workflow: 'scene',
        sceneId: 'scene:1',
        snapshot: {},
        ...overrides,
    } as GenerationJob
}

function reference(): QueueArtifactReference {
    return {
        kind: 'output-writer',
        artifactId: 'artifact:job:queue:1',
        // This intentionally differs from the final image checksum because
        // metadata embedding may change the committed image bytes.
        digest: `sha256:${'b'.repeat(64)}`,
        mimeType: 'image/png',
    }
}

function output(portable = true, outputCommitSetHash?: `sha256:${string}` | null): OutputWriteResult {
    return {
        transactionId: 'transaction-1',
        fileName: 'queue-result.png',
        path: 'C:/Pictures/NAI_Blue_Output/queue-result.png',
        file: { path: 'NAI_Blue_Output/queue-result.png', displayPath: 'C:/Pictures/NAI_Blue_Output/queue-result.png' },
        directory: {
            path: 'NAI_Blue_Output',
            displayPath: 'C:/Pictures/NAI_Blue_Output',
            capabilityFallbackUsed: false,
        },
        capabilityFallbackUsed: false,
        ...(outputCommitSetHash === undefined ? {} : { outputCommitSetHash }),
        finalImage: {
            contentChecksum: CHECKSUM,
            byteSize: 321,
            ...(portable ? {
                portableDirectory: { kind: 'standard' as const, root: 'pictures' as const, segments: ['NAI_Blue_Output'] },
            } : {}),
        },
    }
}

function currentJob(commitSetHash = COMMIT_SET_HASH): GenerationJob {
    return job({
        snapshot: {
            outputReservation: {
                reservationSchemaVersion: 1,
                commitSetHash,
            },
        },
    } as Partial<GenerationJob>)
}

function repository() {
    const records = new Map<string, ArtifactRecord>()
    const removeOriginalIfUnmodified = vi.fn(async () => true)
    const value: QueueArtifactRepository = {
        get: async artifactId => records.get(artifactId) ?? null,
        putOriginal: async input => {
            const record = createArtifactRecord(input)
            records.set(record.artifactId, record)
            return record
        },
        removeOriginalIfUnmodified,
    }
    return { value, records, removeOriginalIfUnmodified }
}

describe('queue artifact lineage', () => {
    it('records final OutputWriter facts and preserves Job and Scene identities', async () => {
        const repo = repository()
        const registration = await registerQueueArtifact(job(), reference(), output(), repo.value)

        expect(registration).toMatchObject({ created: true })
        expect(registration?.record).toMatchObject({
            artifactId: 'artifact:job:queue:1',
            sourceJobId: 'job:queue:1',
            sourceSceneId: 'scene:1',
            contentChecksum: CHECKSUM,
            original: {
                file: { fileName: 'queue-result.png' },
                size: 321,
            },
        })
    })

    it('is idempotent for recovery and leaves raw-path-only output outside artifact authority', async () => {
        const repo = repository()
        const first = await registerQueueArtifact(job(), reference(), output(), repo.value)
        const second = await registerQueueArtifact(job(), reference(), output(), repo.value)

        expect(first?.created).toBe(true)
        expect(second?.created).toBe(false)
        await expect(registerQueueArtifact(job(), reference(), output(false), repo.value)).resolves.toBeNull()
    })

    it('rolls back only a record created by the current output workflow', async () => {
        const repo = repository()
        const registration = await registerQueueArtifact(job(), reference(), output(), repo.value)

        await expect(rollbackQueueArtifactRegistration(registration, repo.value)).resolves.toBe(true)
        expect(repo.removeOriginalIfUnmodified).toHaveBeenCalledWith(expect.objectContaining({
            artifactId: 'artifact:job:queue:1',
            contentChecksum: CHECKSUM,
            size: 321,
        }))
    })

    it('requires current Queue, OutputWriter, and Artifact commit-set lineage to match', async () => {
        const repo = repository()
        const first = await registerQueueArtifact(
            currentJob(), reference(), output(true, COMMIT_SET_HASH), repo.value,
        )
        const replay = await registerQueueArtifact(
            currentJob(), reference(), output(true, COMMIT_SET_HASH), repo.value,
        )

        expect(first?.record.outputCommitSetHash).toBe(COMMIT_SET_HASH)
        expect(replay).toEqual({ record: first?.record, created: false })
        await expect(registerQueueArtifact(
            currentJob(`sha256:${'d'.repeat(64)}`),
            reference(),
            output(true, `sha256:${'d'.repeat(64)}`),
            repo.value,
        )).rejects.toThrow('already bound to different output facts')
        expect(repo.records.get(reference().artifactId)?.outputCommitSetHash).toBe(COMMIT_SET_HASH)
        await expect(registerQueueArtifact(
            currentJob(), reference(), output(true, null), repo.value,
        )).rejects.toThrow('commit-set lineage differ')
        await expect(registerQueueArtifact(
            currentJob(), reference(), output(false, COMMIT_SET_HASH), repo.value,
        )).rejects.toThrow('missing portable Artifact lineage')
    })
})
