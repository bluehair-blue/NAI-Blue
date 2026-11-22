import type { AgentCommandName } from '@/application/agent/agent-command-contract'
import type { JsonObject } from '@/domain/composition/types'
import { agentHint } from './agent-workflow-guide'
import { SNAPSHOT_LISTS } from './mcp-tool-catalog'

/**
 * Summaries are a view for the model only. The validated receipt is unchanged and stays readable in full
 * through detail:"full" and nai-blue://requests/{requestId}.
 */
type Row = Record<string, unknown>
const row = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row).filter((item): item is Row => item !== undefined) : []
const pick = (source: Row, keys: readonly string[]): Row =>
    Object.fromEntries(keys.filter(key => source[key] !== undefined && source[key] !== null).map(key => [key, source[key]]))
const filled = (key: string, value: unknown): Row => Array.isArray(value) && value.length > 0 ? { [key]: value } : {}

export interface PlannedJob { sceneId?: unknown; seed?: unknown; fileName?: unknown }

/** Queue job IDs end in the plan ordinal, which is the only link from a run row back to its Scene, seed and file name. */
export function plannedJobs(plan: JsonObject): Map<string, PlannedJob> {
    return new Map(rows(row(plan.review)?.jobs).map(job => [String(job.ordinal),
        { ...pick(job, ['sceneId', 'seed']), ...pick(row(job.destination) ?? {}, ['fileName']) }]))
}

function summarizeSnapshot(result: Row, include: readonly string[]): Row {
    const lists = Object.fromEntries(include.map(name => [name, name === 'drafts'
        ? rows(result.workflowDrafts).map(draft => pick(draft, ['draftId', 'kind', 'status', 'ready', 'issueCodes', 'imageCount', 'model', 'revision', 'nextAction']))
        : result[SNAPSHOT_LISTS[name as keyof typeof SNAPSHOT_LISTS]]]))
    return { ...pick(result, ['editingApproval', 'generationApproval', 'queueActivity', 'folderRevision']),
        totals: { presets: result.totalPresets, scenes: result.totalScenes, folders: result.totalFolders, drafts: result.totalDrafts },
        ...lists, ...(include.length > 0 ? pick(result, ['offset', 'nextOffset', 'truncated']) : {}) }
}

function summarizeScenes(result: Row): Row {
    return { results: rows(result.results).map(scene => ({
        ...pick(scene, ['presetId', 'sceneId', 'found', 'name', 'revision', 'promptTextMode', 'width', 'height',
            'productionCount', 'filenameTemplate', 'generationFolderId', 'imageSource', 'totalArtifactCount']),
        ...pick(row(scene.generation) ?? {}, ['model', 'ucPreset', 'qualityToggle']), ...filled('artifactIds', scene.artifactIds),
    })), ...pick(result, ['nextIndex']), ...(result.truncated === true ? { truncated: true } : {}) }
}

export function summarizePlan(result: Row): Row {
    if (result.status !== 'ready') return result
    const review = row(result.review) ?? {}
    return { ...pick(result, ['status', 'planId', 'planHash', 'jobCount', 'estimatedAnlas']),
        ...filled('requiredApprovals', result.requiredApprovals), ...filled('compatibilityStatuses', review.compatibilityStatuses),
        ...filled('warnings', review.warnings), sources: rows(review.sources).map(source => pick(source, ['presetId', 'sceneId', 'count'])) }
}

export function summarizeRun(result: Row, planned?: Map<string, PlannedJob>): Row {
    if (result.found !== true) return result
    const monitor = row(result.monitor) ?? {}
    const counts = Object.fromEntries(Object.entries(row(monitor.counts) ?? {}).filter(([key, value]) => key === 'total' || value !== 0))
    const artifacts: Row[] = [], unfinished: Row[] = []
    for (const job of rows(result.jobs)) {
        if (job.storageState === 'succeeded' && typeof job.artifactId === 'string') {
            // The run's own row names the committed file, so a later generation.get_run needs no plan in hand.
            artifacts.push({ artifactId: job.artifactId, ...planned?.get(/-(\d+)$/.exec(String(job.jobId))?.[1] ?? ''), ...pick(job, ['fileName']) })
        } else unfinished.push(pick(job, ['jobId', 'queueState', 'providerState', 'storageState']))
    }
    return { ...pick(result, ['runId', 'state']), complete: monitor.complete === true, counts,
        ...pick(monitor, ['nextAction', 'attention']), ...filled('recoveryActions', monitor.recoveryActions),
        artifacts, ...filled('unfinished', unfinished), ...(result.truncated === true ? { truncated: true } : {}) }
}

export function summarizeResult(command: AgentCommandName, result: JsonObject, include: readonly string[] = []): Row {
    switch (command) {
        case 'workspace.get_snapshot': return summarizeSnapshot(result, include)
        case 'scene.resolve_many': return summarizeScenes(result)
        case 'generation.plan': case 'production.plan_next': return summarizePlan(result)
        case 'generation.get_run': return summarizeRun(result)
        case 'generation.enqueue': return typeof result.runId === 'string' && Array.isArray(result.jobIds)
            ? { ...pick(result, ['status', 'runId']), jobCount: result.jobIds.length } : result
        // Any other status may carry diagnostics, which a summary must not drop.
        case 'scene.patch_many': return result.status === 'authoring-committed' ? pick(result, ['status', 'resourceId', 'revision']) : result
        default: return result
    }
}

export function completedResult(observed: JsonObject): JsonObject | undefined {
    const receipt = observed.status === 'application-receipt' ? row(observed.receipt) : undefined
    return receipt?.state === 'completed' ? row(receipt.result) as JsonObject | undefined : undefined
}

/** Receipt hashes, client identity and schema versions are omitted; anything unfinished carries a hint instead. */
export function compactObservation(observed: JsonObject, summary?: Row): Row {
    const requestId = typeof observed.requestId === 'string' ? observed.requestId : undefined
    const receipt = observed.status === 'application-receipt' ? row(observed.receipt) : undefined
    if (!receipt) {
        const hint = agentHint(observed, requestId)
        return { ...pick(observed, ['status', 'code', 'requestId', 'accepted', 'submissionAttempted']), ...(hint ? { hint } : {}) }
    }
    const hint = receipt.state === 'completed' ? undefined : agentHint({ code: row(receipt.result)?.code, state: receipt.state }, requestId)
    return { state: receipt.state, requestId, result: summary ?? receipt.result, ...(hint ? { hint } : {}) }
}
