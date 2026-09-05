import { describe, expect, it, vi } from 'vitest'
import { readQueueIntentAssessmentRun } from '@/adapters/assessment/queue-intent-assessment-reader'
import { IndexedDbIntentAssessmentRepository, type IntentAssessmentPersistence } from '@/adapters/assessment/indexeddb-intent-assessment-repository'
import { createAssessmentRequirement, type IntentAssessmentRunBinding, type HumanIntentAssessmentEventV1 } from '@/domain/assessment/intent-assessment'
import { createArtifactRecord, type ArtifactRecord } from '@/domain/organizer/types'
import type { GenerationJob } from '@/domain/queue/types'

const NOW = '2026-09-05T00:00:00.000Z'
const DIGEST = `sha256:${'a'.repeat(64)}` as const
const binding: IntentAssessmentRunBinding = {
    runId: 'original-run', planHash: `sha256:${'b'.repeat(64)}`,
    requirement: createAssessmentRequirement({
        rubricId: 'human-review', version: 1,
        hardConstraints: [{ criterionId: 'identity', label: 'Correct character' }],
        softCriteria: [], acceptanceThreshold: 80,
    }, 2),
}

function job(id: string, overrides: Partial<GenerationJob> = {}): GenerationJob {
    return {
        id, batchId: binding.runId, workflow: 'main', sceneId: null, state: 'succeeded',
        createdAt: NOW, updatedAt: NOW, priority: 0, ordinal: 0, snapshotSchemaVersion: 1,
        snapshot: {
            schemaVersion: 1, intentAssessment: binding,
            prompt: { positive: 'portrait', negative: '' }, parameters: {}, outputPolicy: {}, resources: [], resumability: 'resumable',
        },
        snapshotHash: DIGEST, compositionPlanHash: null, attemptCount: 1, maxAttempts: 1,
        idempotencyKey: id, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, heartbeatAt: null,
        progress: { stage: 'succeeded', current: 1, total: 1 }, lastDiagnosticEventId: null,
        outputTransactionId: null, artifactReference: { kind: 'output-writer', artifactId: `artifact-${id}`, digest: DIGEST },
        blockReason: null, readyAt: NOW, cancelRequestedAt: null, cancelReason: null,
        retryOfJobId: null, rootJobId: id, version: 1, ...overrides,
    }
}

function artifact(sourceJob: GenerationJob, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
    return { ...createArtifactRecord({
        artifactId: sourceJob.artifactReference?.artifactId ?? `artifact-${sourceJob.id}`,
        sourceJobId: sourceJob.id, file: { directory: { kind: 'standard', root: 'pictures', segments: ['outputs'] }, fileName: `${sourceJob.id}.png` },
        format: 'png', contentChecksum: DIGEST, size: 64, createdAt: NOW,
    }), ...overrides }
}

function accepted(artifactId: string): HumanIntentAssessmentEventV1 {
    return {
        schemaVersion: 1, type: 'artifact-assessment', assessmentId: `review-${artifactId}`,
        runId: binding.runId, planHash: binding.planHash, artifactId,
        rubricId: binding.requirement.rubric.rubricId, rubricVersion: 1, rubricHash: binding.requirement.rubricHash,
        evaluator: { kind: 'human', actorId: 'local-user' }, hardConstraintResults: [{ criterionId: 'identity', result: 'pass' }],
        softScore: null, decision: 'accepted', supersedesAssessmentId: null, createdAt: NOW,
    }
}

/** JSON persistence survives new repository objects, while Queue pages and Artifact rows stay independent authorities. */
function authorities(jobs: readonly GenerationJob[], records = jobs.map(source => artifact(source))) {
    const values = new Map<string, string>()
    const persistence: IntentAssessmentPersistence = {
        getItem: async key => values.get(key) ?? null,
        compareAndSet: async (key, expected, next) => {
            if ((values.get(key) ?? null) !== expected) return false
            values.set(key, next)
            return true
        },
    }
    const queue = { listJobs: vi.fn(async (query: { batchId?: string; cursor?: string | null } = {}) => {
        const filtered = query.batchId === undefined ? jobs : jobs.filter(item => item.batchId === query.batchId)
        const offset = Number(query.cursor ?? 0)
        return { items: filtered.slice(offset, offset + 2), nextCursor: offset + 2 < filtered.length ? String(offset + 2) : null }
    }) }
    const artifacts = { get: vi.fn(async (id: string) => records.find(record => record.artifactId === id) ?? null) }
    return { queue, artifacts, assessments: new IndexedDbIntentAssessmentRepository(persistence), persistence }
}

describe('Queue intent assessment reader', () => {
    it('preserves legacy no-rubric runs without querying artifacts or assessment storage', async () => {
        const root = job('root-1')
        const legacy = { ...root, snapshot: { ...root.snapshot, intentAssessment: undefined } }
        const ports = authorities([legacy])
        const read = vi.spyOn(ports.assessments, 'read')
        expect(await readQueueIntentAssessmentRun(binding.runId, ports)).toBeNull()
        expect(ports.artifacts.get).not.toHaveBeenCalled()
        expect(read).not.toHaveBeenCalled()
    })

    it('projects partial review then restores distinct acceptance after a repository reopen', async () => {
        const roots = [job('root-1'), job('root-2')]
        const ports = authorities(roots)
        const before = await readQueueIntentAssessmentRun(binding.runId, ports)
        expect(before?.projection.state).toBe('not-evaluated')
        await ports.assessments.append(binding, accepted('artifact-root-1'))
        expect((await readQueueIntentAssessmentRun(binding.runId, ports))?.projection).toMatchObject({
            state: 'needs-review', acceptedArtifactIds: ['artifact-root-1'], requiredAcceptedCount: 2,
        })
        await ports.assessments.append(binding, accepted('artifact-root-2'))
        const reopened = { ...ports, assessments: new IndexedDbIntentAssessmentRepository(ports.persistence) }
        const restored = await readQueueIntentAssessmentRun(binding.runId, reopened)
        expect(restored?.binding).toEqual(binding)
        expect(restored?.projection).toMatchObject({ state: 'accepted', acceptedArtifactIds: ['artifact-root-1', 'artifact-root-2'] })
        expect(restored?.projection).toEqual((await readQueueIntentAssessmentRun(binding.runId, ports))?.projection)
    })

    it('joins valid retries across batches under the original run and deduplicates repeated references', async () => {
        const root1 = job('root-1', { artifactReference: null, state: 'failed' })
        const root2 = job('root-2')
        const retry = job('retry-1', { batchId: 'retry-batch', retryOfJobId: root1.id, rootJobId: root1.id })
        const duplicate = job('retry-2', { batchId: 'retry-batch-2', retryOfJobId: retry.id, rootJobId: root1.id, artifactReference: retry.artifactReference })
        const ports = authorities([root1, root2, retry, duplicate], [artifact(root2), artifact(retry)])
        await ports.assessments.append(binding, accepted('artifact-retry-1'))
        await ports.assessments.append(binding, accepted('artifact-root-2'))
        const original = await readQueueIntentAssessmentRun(binding.runId, ports)
        const retryView = await readQueueIntentAssessmentRun('retry-batch', ports)
        expect(original?.candidateArtifactIds).toEqual(['artifact-retry-1', 'artifact-root-2'])
        expect(original?.projection.state).toBe('accepted')
        expect(retryView?.binding.runId).toBe(binding.runId)
        expect(retryView?.projection).toEqual(original?.projection)
    })

    it('excludes foreign source jobs and checksum mismatches even when the Queue references their IDs', async () => {
        const roots = [job('root-1'), job('root-2')]
        const wrongSource = artifact(roots[0], { sourceJobId: 'foreign-job' })
        const second = artifact(roots[1])
        const wrongChecksum = { ...second, original: { ...second.original, contentChecksum: `sha256:${'c'.repeat(64)}` } }
        const ports = authorities(roots, [wrongSource, wrongChecksum])
        expect((await readQueueIntentAssessmentRun(binding.runId, ports))?.candidateArtifactIds).toEqual([])
    })

    it('excludes forged, cyclic, missing-parent and changed-plan retry lineage', async () => {
        const roots = [job('root-1', { artifactReference: null }), job('root-2', { artifactReference: null })]
        const forged = job('forged', { batchId: 'elsewhere', retryOfJobId: 'root-1', rootJobId: 'root-2' })
        const missing = job('missing', { batchId: 'elsewhere', retryOfJobId: 'absent', rootJobId: 'root-1' })
        const cycleA = job('cycle-a', { batchId: 'elsewhere', retryOfJobId: 'cycle-b', rootJobId: 'root-1' })
        const cycleB = job('cycle-b', { batchId: 'elsewhere', retryOfJobId: 'cycle-a', rootJobId: 'root-1' })
        const foreignRoot = job('foreign-root', { batchId: 'foreign-run' })
        const changed = job('changed', { batchId: 'elsewhere', retryOfJobId: 'root-1', rootJobId: 'root-1',
            snapshot: { ...roots[0].snapshot, intentAssessment: { ...binding, planHash: `sha256:${'d'.repeat(64)}` } } })
        const ports = authorities([...roots, forged, missing, cycleA, cycleB, foreignRoot, changed])
        expect((await readQueueIntentAssessmentRun(binding.runId, ports))?.candidateArtifactIds).toEqual([])
    })

    it('rejects differing persisted provenance and conflicting original Queue plan snapshots', async () => {
        const roots = [job('root-1'), job('root-2')]
        const ports = authorities(roots)
        const otherBinding = { ...binding, planHash: `sha256:${'e'.repeat(64)}` as const }
        await ports.assessments.append(otherBinding, { ...accepted('artifact-root-1'), planHash: otherBinding.planHash })
        await expect(readQueueIntentAssessmentRun(binding.runId, ports)).rejects.toThrow('Stored assessment provenance')
        const conflicting = { ...roots[1], snapshot: { ...roots[1].snapshot, intentAssessment: otherBinding } }
        await expect(readQueueIntentAssessmentRun(binding.runId, authorities([roots[0], conflicting]))).rejects.toThrow('conflicting assessment plans')
    })
})
