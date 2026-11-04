import { describe, expect, it } from 'vitest'
import { assertAgentPublicValue } from '@/application/agent/agent-command-contract'

// Human-approved reference grammar exception; real binary and longer image headers remain blocked.
// Original public request identity; no prompt, pixels, credentials or app state.
const observedHash = '8b8311c4580cd5c1b7e3d8aff77154ff0a637b7a99322271938524f89661a594'
const batch = (hash: string) => `scene-batch-agent-${hash}`
const job = (hash: string) => `scene-job-agent-${hash}-0`

describe('generated Queue references at the public boundary', () => {
    it('preserves the AL run, ordered job and artifact references in inputs and commit results', () => {
        const runId = batch(observedHash)
        const jobIds = [job(observedHash), `scene-job-agent-${observedHash}-1`]
        const input = { runId, jobId: jobIds[0] }
        const result = { status: 'ready', batchId: runId, runId, jobIds,
            jobs: [{ jobId: jobIds[0], artifactId: `artifact:${jobIds[0]}`,
                attempts: [{ attemptId: `${jobIds[0]}:1` }] }] }
        const before = JSON.stringify({ input, result })
        expect(() => assertAgentPublicValue(input)).not.toThrow()
        expect(() => assertAgentPublicValue(result)).not.toThrow()
        expect(JSON.stringify({ input, result })).toBe(before)
    })

    it.each([0, 1, 15, 30])('handles other generated hashes with FF0A at byte %s without value exceptions', offset => {
        const original = '23'.repeat(32)
        const hash = original.slice(0, offset * 2) + 'ff0a' + original.slice(offset * 2 + 4)
        for (const workflow of ['main', 'scene']) {
            const runId = `${workflow}-batch-agent-${hash}`
            const jobId = `${workflow}-job-agent-${hash}-99`
            expect(() => assertAgentPublicValue({ runId, batchId: runId, jobId, jobIds: [jobId],
                sourceJobId: jobId, previouslyStoppedJobIds: [jobId], attemptId: `${jobId}:2`,
                artifactId: `artifact:${jobId}`, artifactIds: [`artifact:${jobId}`] })).not.toThrow()
        }
    })

    it.each([
        { runId: job(observedHash) },
        { jobId: batch(observedHash) },
        { artifactId: job(observedHash) },
        { runId: `queue-batch-agent-${observedHash}` },
        { runId: `scene-batch-agent-${observedHash.slice(0, -1)}` },
        { runId: `scene-batch-agent-${observedHash}0` },
        { jobId: `scene-job-agent-${observedHash}-01` },
        { jobId: `scene-job-agent-${observedHash}-9007199254740992` },
        { attemptId: `${job(observedHash)}:0` },
        { runId: ` ${batch(observedHash)} ` },
        { runId: batch(observedHash).replace('agent-', 'agent%2D') },
        { untyped: batch(observedHash) },
        { prompt: batch(observedHash) },
    ])('rejects malformed, wrong-role or untyped reference material %#', value => {
        expect(() => assertAgentPublicValue(value)).toThrow()
    })

    it.each([
        { runId: batch(`89504e470d0a1a0a${'ab'.repeat(24)}`) },
        { runId: batch(`ffd8ff${'ab'.repeat(29)}`) },
        { artifactId: `artifact:${job(`89504e470d0a1a0a${'ab'.repeat(24)}`)}` },
        { contentChecksum: `sha256:ff0a${'ab'.repeat(30)}` },
        { contentChecksum: `sha256:00ff0a${'ab'.repeat(29)}` },
        { runId: '89504e470d0a1a0a' },
        { runId: `scene-batch-agent-${'89'.repeat(32)}:iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB` },
        { artifactId: 'artifact:iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
        { artifactId: 'artifact:89504e470d0a1a0a' },
        { runId: `Bearer ${batch(observedHash)}` },
        { runId: `C:/private/${batch(observedHash)}` },
        { runId: `${batch(observedHash)}/../private` },
        { runId: `data:image/jxl;hex,${observedHash}` },
        { runId: String.fromCharCode(255, 10, 1, 2) },
        { runId: [255, 10] },
        { imageBytes: [255, 10] },
        { apiToken: batch(observedHash) },
    ])('retains encoded material, credential, path and forbidden-key rejection %#', value => {
        expect(() => assertAgentPublicValue(value)).toThrow()
    })
})
