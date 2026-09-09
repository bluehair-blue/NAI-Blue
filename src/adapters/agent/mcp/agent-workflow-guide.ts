import type { AgentCommandName } from '@/application/agent/agent-command-contract'

/** Static adapter guidance is fetched on demand; the live registry remains execution authority. */
export const AGENT_WORKFLOW_GUIDE_URI = 'nai-blue://guides/agent-workflow/v1'
export const AGENT_MCP_INSTRUCTIONS = `NAI Blue requires the foreground app. Before authoring or production, read ${AGENT_WORKFLOW_GUIDE_URI} on demand. Discover current tools/capabilities; never assume a guide grants availability. Reuse requestId only for the identical request after timeout/restart; use a new ID for each fresh status poll. Command receipts do not prove run completion. Approval stays in NAI Blue; unknown outcomes must be inspected, never blindly retried. Transport cancellation only stops waiting.`

/** Command-specific hints complement shared input schemas without repeating the workflow manual. */
export const AGENT_TOOL_DESCRIPTIONS: Record<AgentCommandName, string> = {
    'system.describe_capabilities': 'Read current command availability, schema versions and approval requirements.',
    'workspace.get_snapshot': 'Read paginated workspace IDs and revisions before editing or planning.',
    'generation.plan': 'Preview a workflow-draft or Scene plan, at most 100 images total; does not enqueue.',
    'generation.enqueue': 'Submit the exact reviewed planId and planHash to the durable Queue; receipt is not run completion.',
    'generation.get_run': 'Read current run counts, completion and recovery hints. Use a new requestId for each fresh poll.',
    'generation.cancel': 'Request durable run cancellation; inspect the run afterward for actual Queue outcome.',
    'generation.retry_storage': 'Recover retained output for one job without regenerating; verify the run afterward.',
    'scene.retry_link': 'Retry Scene linking only when advertised available; capability discovery remains authoritative.',
    'output.abandon_reservation': 'Abandon an output reservation only when advertised available.',
    'scene.resolve_many': 'Resolve existing preset/Scene targets and revisions for an explicit edit or production plan.',
    'scene.patch_many': 'Patch existing Scenes at the expected preset revision; no generation is started.',
    'folder.plan_changes': 'Preview folder changes using known parent IDs and safe child path segments.',
    'folder.apply_changes': 'Apply the exact previewed folder changes with expectedRevision and expectedPlanHash.',
    'r2.get_readiness': 'Inspect R2 readiness; configured preferences are not proof of upload completion.',
    'production.create': 'Save a bounded production request of up to 2400 images from existing Scenes or a preset; does not enqueue.',
    'production.list': 'List saved production requests for this authenticated workspace.',
    'production.get': 'Read latest production revision, budget use, children and next action. Use a fresh requestId per poll.',
    'production.plan_next': 'Preview the next child of at most 100 images at expectedRevision; enqueue separately after review and approval.',
}

export const AGENT_WORKFLOW_GUIDE = `# NAI Blue agent workflow v1

Scope and discovery
- This is a static usage guide, not current application state or permission. Keep NAI Blue running in the foreground. No execution while the app is closed is promised.
- List tools and read nai-blue://capabilities for fresh availability and unavailable reasons. Only use tools currently advertised with matching input schemas. An unavailable command must not be replaced by a guessed command.
- MCP hosts decide whether initialize instructions or resources reach a model. This resource is available through resources/list and resources/read; connection alone does not prove the agent has read it.

Request identity and observation
- Every tool takes { requestId, input }. Create a unique requestId for each distinct logical command. After timeout or restart, inspect nai-blue://requests/{requestId}; replay only the identical command and input under the same ID. Never reuse an ID with changed input.
- Saved request resources are historical receipts for the configured client. Reusing a completed read request replays its old observation: each fresh generation.get_run or workspace read needs a new requestId.
- submitted-to-inbox and submission-unconfirmed are not application acceptance. observation-cancelled only means waiting stopped. A completed command receipt proves command completion, not generation, storage, upload or workflow completion.
- If acceptance or a Provider result is unknown (including COMMAND_OUTCOME_UNKNOWN), inspect/reconcile existing evidence. Do not create a new generation request to force a retry. Transport cancellation does not cancel Queue work.

Discover, author, preview
1. Read workspace.get_snapshot (offset/limit pagination) for existing IDs and revisions. Resolve selected preset/Scene pairs through scene.resolve_many. Never invent IDs or expected revisions.
2. If edits are requested, use scene.patch_many for existing Scenes. Folder changes use folder.plan_changes then folder.apply_changes with the exact previewed changes, expectedRevision and expectedPlanHash. Use parent folder IDs and safe child path segments; absolute storage paths are unsupported. Re-read after changes or revision conflicts.
3. Check r2.get_readiness when upload is requested. Folder R2 preferences and autoUpload express intent only; they do not prove credentials, destination readiness or completed delivery.
4. Use generation.plan with an existing workflow-draft and count, or Scene targets containing presetId, sceneId, expectedRevision and count. Supply seedPolicy and budget explicitly. The current generation plan limit is 100 images total across all targets; budget.maxImages is at most 100. For a larger saved Scene production request use the bounded workflow below.

Saved production requests (only when advertised available)
- production.create saves title, source, seedPolicy and total budget. Scene source uses up to 100 unique presetId/sceneId targets with expectedRevision and count; preset source uses presetId and expectedRevision and captures all saved Scenes and counts. The production total and budget.maxImages are at most 2400. This captures exact targets, counts, seeds and source hashes; it does not enqueue or authorize all children.
- Use production.list to find saved requests, then production.get with a fresh requestId for the latest revision, totalImages, childCount, admittedImages, estimatedAnlasReserved, maxAnlas, children and nextAction. Observe wait/check-results; only complete means the production is fulfilled.
- For review-next-batch, call production.plan_next with productionId and the latest expectedRevision. Review its child plan (at most 100 images) and submit the returned planId/planHash through generation.enqueue with existing approval. Read production.get again after planning/enqueue and use generation.get_run to inspect the child.
- Plan the next child only after the previous child's full fulfillment. There is no automatic next-child dispatch. Source authoring changes stop progression; result-only Scene revisions can replan only when the captured semantic source hash still matches. Unknown Provider outcomes require reconciliation, never replacement generation. Total budget reservation and existing per-child approval both remain enforced.

Approve, enqueue, observe
5. Review the plan result and submit its exact planId and planHash with generation.enqueue. Existing application policy and durable approval own permission. If the receipt needs input or approval, surface that state and wait for the user in NAI Blue; do not manufacture approval or treat a successful transport response as approval.
6. Read the resulting run with generation.get_run using a fresh requestId each time. Report monitor.counts.generated, stored, uploadRequested, uploaded and fulfilled separately. Claim run completion only when monitor.complete is true; neither receipt.state=completed nor Queue success alone suffices.
7. Follow monitor.nextAction, attention and recoveryActions. Poll with reasonable backoff while waiting; compare monitor.stateHash to avoid repeating unchanged reports. A paused run may require resume-in-app. Stop automatic action for review-uncertain-result or human recovery. Failed, cancelled or skipped work is not successful fulfillment.
8. When available and appropriate, generation.retry_storage targets { runId, jobId } and only recovers retained output; it must not regenerate a Provider result. generation.cancel requests cancellation and still needs a subsequent run read. Other repairs are available only if tools/list advertises them; use NAI Blue for unsupported actions.

Keep credentials, binary image data and absolute private paths out of tool inputs. This guide adds no installation, client registration, background execution or approval authority.
`
